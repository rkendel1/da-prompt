// Browser tests for the operating surface: setup & health, settings, PAX, evidence, history, review/publish,
// run lifecycle and backend-unavailable behaviour. Needs Playwright (skipped, loudly, when it is missing).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from '../src/server.js';
import { OfflineProvider } from '../src/providers/offline.js';
import { startMockLLM } from './mock-llm.js';
import { tmpDir } from './helpers.js';
import { makeRepo, makeRoot, makeRemote, startMockApi, git } from './project-helpers.js';
import { fakePax } from './pax-helpers.js';
import http from 'node:http';

for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'TOGETHER_API_KEY', 'GITHUB_TOKEN', 'FACTORY_PASSWORD', 'FACTORY_PROVIDER', 'FACTORY_MODEL', 'FACTORY_PAX_PATH', 'FACTORY_PROJECT_ROOTS', 'FACTORY_PROJECT_ROOTS_READONLY', 'FACTORY_MAX_PARALLEL']) delete process.env[k];
Object.assign(process.env, { LMSTUDIO_BASE_URL: 'http://127.0.0.1:9/v1', LLAMACPP_BASE_URL: 'http://127.0.0.1:9/v1', VLLM_BASE_URL: 'http://127.0.0.1:9/v1', FACTORY_MAX_ATTEMPTS: '4' });

async function loadPlaywright() {
  for (const t of [() => import('playwright'), () => import(pathToFileURL(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright', 'index.mjs')).href)]) {
    try { return await t(); } catch { /* next */ }
  }
  return null;
}

let browser;
let skip = '';
let llm;
let api;
let remote;
let roots;
let pax;
let main; // a fully configured server
let fresh; // a server with nothing configured
let delayMs = 0;
const servers = [];
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

async function boot(extra) {
  const a = await createServer({ dataDir: tmpDir(), ...extra });
  await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  servers.push(a);
  return { app: a, url: `http://127.0.0.1:${a.server.address().port}/` };
}

before(async () => {
  const pw = await loadPlaywright();
  if (!pw) return void (skip = 'Playwright is not installed');
  try { browser = await pw.chromium.launch(); } catch (e) { return void (skip = `no browser available: ${e.message.split('\n')[0]}`); }
  llm = await startMockLLM({ flavor: 'ollama', models: ['qwen2.5-coder:7b', 'llama3.1:8b'] });
  api = await startMockApi();
  // The mock API also answers GET /user for the GitHub health check.
  const orig = api.calls;
  void orig;
  remote = makeRemote();
  roots = makeRoot({ widgets: (d) => fs.cpSync(makeRepo(), d, { recursive: true }) });
  pax = fakePax({ drift: 0, test: 'passed' });
  // fresh: nothing configured, Ollama down
  // The provider registry reads its environment lazily, so each server gets its own.
  fresh = await boot({ env: { ...process.env, OLLAMA_HOST: 'http://127.0.0.1:9' }, providerFactory: () => new OfflineProvider({ faults: false, delayMs: 0 }) });
  main = await boot({ env: { ...process.env, OLLAMA_HOST: llm.url }, ...roots.cfg, paxPath: pax.file, gitConfig: remote.insteadOf, githubApiUrl: api.url, providerFactory: () => new OfflineProvider({ faults: false, get delayMs() { return delayMs; } }) });
});
after(async () => {
  await browser?.close();
  for (const s of servers) await s.close();
  await api?.close();
  await llm?.close();
});

async function open(srv, { headers, hash = '' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  if (headers) await page.setExtraHTTPHeaders(headers);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (process.env.UI_DEBUG) { page.on('requestfailed', (r) => console.log('REQFAIL', r.url(), r.failure()?.errorText)); page.on('response', (r) => r.url().includes('/api/runs') && r.request().method() === 'POST' && console.log('POST', r.status())); page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text())); }
  await page.goto(srv.url + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main > *', { timeout: 20_000 });
  return { page, errors };
}
const textOf = async (page, sel) => (await page.textContent(sel)).replace(/\s+/g, ' ').trim();

async function startLocalRun(page, { pax: usePax = false, idea = 'Add a note to the docs' } = {}) {
  // The page must already be on the New Run screen: re-navigating to the same route would re-render it mid-interaction.
  await page.waitForSelector('#new-form');
  await page.check('input[value=local]');
  await page.waitForFunction(() => document.querySelector('#directory-id option[value]'));
  const label = (await page.$$eval('#directory-id option', (os) => os.map((o) => o.textContent))).find((o) => o.startsWith('widgets'));
  await page.selectOption('#directory-id', { label });
  await page.waitForFunction(() => /branch main/.test(document.querySelector('#src-summary').textContent));
  if (usePax) {
    await page.waitForFunction(() => !document.querySelector('#pax-check').disabled);
    await page.check('#pax-check');
  }
  await page.fill('textarea[name=idea]', idea);
  await page.click('button[type=submit]');
  try {
    await Promise.race([page.waitForFunction(() => /#\/runs\//.test(location.hash), null, { timeout: 20_000 }), page.waitForSelector('#form-error:not([hidden])', { timeout: 20_000 }).then(async () => { throw new Error(`run was not started: ${await page.textContent('#form-error')}`); })]);
  } catch (e) {
    const state = await page.evaluate(() => ({ hash: location.hash, submitDisabled: document.querySelector('button[type=submit]')?.disabled, err: document.querySelector('#form-error')?.textContent, model: document.querySelector('#model-picker')?.textContent?.slice(0, 200), summary: document.querySelector('#src-summary')?.textContent?.slice(0, 120) })).catch((x) => String(x));
    throw new Error(`${e.message} | page state: ${JSON.stringify(state)}`);
  }
  return page.url().split('/runs/')[1];
}
const waitStatus = (page, re, timeout = 60_000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.run-head .pill')?.textContent || ''), re.source, { timeout });

test('first run: setup & health shows real findings with next steps; New Run points to setup', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await open(fresh, { hash: '#/' });
  await page.waitForSelector('#setup-banner:not([hidden])');
  assert.match(await textOf(page, '#setup-banner'), /Finish setup before your first run/);
  await page.click('#setup-banner a');
  await page.waitForSelector('[data-check=providers]');
  assert.match(await textOf(page, '.callout'), /Setup is not finished/);
  assert.equal(await page.$eval('#health-dot', (d) => d.className), 'hdot fail');
  const providers = await textOf(page, '[data-check=providers]');
  assert.match(providers, /No real model provider is usable/);
  assert.match(providers, /Ollama.*not ?running|Ollama.*unreachable/i);
  assert.match(providers, /Start it on the machine that runs da-prompt/);
  assert.match(providers, /Add an API key for Anthropic/);
  assert.equal(await page.getAttribute('[data-check=providers] a[href="#/providers"]', 'href'), '#/providers');
  assert.match(await textOf(page, '[data-check=pax]'), /"pax" was not found on the PATH of the da-prompt server process/);
  assert.match(await textOf(page, '[data-check=pax]'), /host-level/);
  assert.match(await textOf(page, '[data-check=pax]'), /A browser cannot install a program on a host/);
  assert.match(await textOf(page, '[data-check=github]'), /No GitHub token is configured/);
  assert.match(await textOf(page, '[data-check=git]'), /git version/);
  assert.match(await textOf(page, '[data-check=roots]'), /No project folders are authorized/);
  // what was actually observed is one click away, and statuses are not colour-only
  await page.click('[data-check=data] summary');
  assert.match(await textOf(page, '[data-check=data] details'), /Folder/);
  assert.ok(await page.$$eval('.hs', (els) => els.every((e) => e.getAttribute('aria-label'))));
  assert.equal(await page.$('#health button, .actions #recheck') !== null, true);
  await page.click('#recheck');
  await page.waitForSelector('[data-check=providers]');
  assert.deepEqual(errors, []);
  await page.close();
});

test('settings: saved values persist across reloads, show their source, validate, mask secrets and flag restarts', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await open(main, { hash: '#/settings?group=execution' });
  await page.waitForSelector('#sform');
  // environment-sourced value is labelled with its variable
  assert.match(await textOf(page, '.setting[data-key=maxAttempts]'), /environment variable · FACTORY_MAX_ATTEMPTS/);
  assert.equal(await page.inputValue('#set-maxAttempts'), '4');
  assert.match(await textOf(page, '.setting[data-key=maxParallel]'), /built-in default/);
  // a valid change is saved on the server and survives a reload
  await page.fill('#set-maxParallel', '5');
  await page.click('#sform button[type=submit]');
  await page.waitForFunction(() => /Saved/.test(document.querySelector('#save-state')?.textContent || ''));
  await page.reload();
  await page.waitForSelector('#sform');
  assert.equal(await page.inputValue('#set-maxParallel'), '5');
  assert.match(await textOf(page, '.setting[data-key=maxParallel]'), /saved in the UI/);
  assert.match(await textOf(page, '.setting[data-key=maxParallel]'), /applies immediately/);
  assert.equal(main.app.cfg.defaults.maxParallel, 5, 'the backend applied it live');
  // saved beats environment, and says so
  await page.fill('#set-maxAttempts', '2');
  await page.click('#sform button[type=submit]');
  await page.waitForFunction(() => /environment also sets this/i.test(document.querySelector('.setting[data-key=maxAttempts]')?.textContent || ''));
  assert.match(await textOf(page, '.setting[data-key=maxAttempts]'), /The environment also sets this \(FACTORY_MAX_ATTEMPTS\); the saved value wins/);
  // invalid input is rejected before saving, next to the field
  await page.fill('#set-maxAttempts', '99');
  await page.click('#sform button[type=submit]');
  await page.waitForSelector('.setting[data-key=maxAttempts] .field-error:not([hidden])');
  assert.match(await textOf(page, '.setting[data-key=maxAttempts] .field-error'), /whole number from 1 to 5/);
  assert.match(await textOf(page, '#save-state'), /Not saved/);
  assert.equal(main.app.cfg.defaults.maxAttempts, 2);
  // reset falls back to the environment
  await page.reload();
  await page.waitForSelector('#sform');
  await page.click('.setting[data-key=maxAttempts] [data-reset]');
  await page.waitForFunction(() => /environment variable · FACTORY_MAX_ATTEMPTS/.test(document.querySelector('.setting[data-key=maxAttempts]')?.textContent || ''));
  assert.equal(main.app.cfg.defaults.maxAttempts, 4);

  // secrets are write-only
  await page.goto(main.url + '#/settings?group=github', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#set-githubToken');
  assert.match(await textOf(page, '.setting[data-key=githubToken]'), /not set/);
  await page.fill('#set-githubToken', TOKEN);
  await page.click('#sform button[type=submit]');
  await page.waitForFunction(() => /configured · saved in the UI/.test(document.querySelector('.setting[data-key=githubToken]')?.textContent || ''));
  assert.equal(await page.inputValue('#set-githubToken'), '');
  assert.ok(!(await page.content()).includes(TOKEN), 'the token is not in the page');
  assert.equal(main.app.cfg.githubToken, TOKEN);
  assert.equal((fs.statSync(path.join(main.app.cfg.dataDir, 'settings.json')).mode & 0o777).toString(8), '600');

  // restart-only settings are saved but flagged, and the UI says it cannot restart the server
  await page.goto(main.url + '#/settings?group=server', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#set-port');
  assert.match(await textOf(page, '.setting[data-key=port]'), /needs a restart/);
  await page.fill('#set-port', '4555');
  await page.click('#sform button[type=submit]');
  await page.waitForFunction(() => /Restart pending for: port/.test(document.querySelector('#save-state')?.textContent || ''));
  assert.match(await textOf(page, '#save-state'), /browser cannot restart the server/);
  assert.match(await textOf(page, '.setting[data-key=port]'), /restart pending/);
  await page.click('.setting[data-key=port] [data-reset]');
  await page.waitForFunction(() => !/restart pending/.test(document.querySelector('.setting[data-key=port]')?.textContent || ''));

  // every control has an accessible name
  assert.deepEqual(await page.$$eval('#sform input:not([type=hidden]), #sform select, #sform textarea', (els) => els.filter((e) => !e.labels?.length && !e.closest('fieldset')?.querySelector('legend') && !e.getAttribute('aria-label')).map((e) => e.name)), []);
  assert.deepEqual(errors, []);
  await page.close();
});

test('settings: models come from what the provider really offers; host-authority settings are locked for a relayed session', async (t) => {
  if (skip) return t.skip(skip);
  const { page } = await open(main, { hash: '#/settings?group=models' });
  await page.waitForSelector('#set-defaultProvider');
  const providerOptions = await page.$$eval('#set-defaultProvider option', (o) => o.map((x) => x.textContent));
  assert.ok(providerOptions.some((o) => /^Ollama$/.test(o)), providerOptions.join('|'));
  assert.ok(providerOptions.some((o) => /Anthropic.*no key/i.test(o)), 'unready providers are labelled, not hidden');
  await page.selectOption('#set-defaultProvider', 'ollama');
  const models = await page.$$eval('#set-defaultModel option', (o) => o.map((x) => x.value));
  assert.deepEqual(models.filter(Boolean).sort(), ['llama3.1:8b', 'qwen2.5-coder:7b'], 'the model list is the provider\'s own');
  await page.selectOption('#set-defaultModel', 'llama3.1:8b');
  await page.click('#sform button[type=submit]');
  await page.waitForFunction(() => /Saved/.test(document.querySelector('#save-state')?.textContent || ''));
  assert.equal(main.app.cfg.defaultProvider, 'ollama');
  assert.equal(main.app.cfg.defaultModel, 'llama3.1:8b');
  await page.click('.setting[data-key=defaultModel] [data-reset]');
  await page.waitForSelector('.setting[data-key=defaultModel]');
  await page.click('.setting[data-key=defaultProvider] [data-reset]');
  await page.waitForFunction(() => !document.querySelector('.setting[data-key=defaultProvider] [data-reset]'));
  await page.close();

  const relayed = await open(main, { headers: { 'x-forwarded-for': '198.51.100.7' }, hash: '#/settings?group=folders' });
  await relayed.page.waitForSelector('#sform');
  assert.match(await textOf(relayed.page, '#sform'), /Some settings here grant access to the host\. They are locked in this session/);
  assert.match(await textOf(relayed.page, '.setting[data-key=projectRoots]'), /grants access to the host and is hidden from this session/);
  await relayed.page.goto(main.url + '#/settings?group=github', { waitUntil: 'domcontentloaded' });
  await relayed.page.waitForSelector('#set-githubToken');
  assert.equal(await relayed.page.isDisabled('#set-githubToken'), true);
  assert.match(await textOf(relayed.page, '.setting[data-key=githubToken]'), /needs an authenticated session/);
  await relayed.page.close();
});

test('PAX page: path, version, capabilities from the binary itself, a probe of another executable, and what the evidence means', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await open(main, { hash: '#/pax' });
  await page.waitForSelector('.pax .pill');
  const card = await textOf(page, '.pax');
  assert.match(card, /Available/);
  assert.ok(card.includes(pax.file));
  assert.match(card, /Found by\s*configured path/);
  assert.match(card, /Version\s*0\.5\.0/);
  assert.match(card, /info doctor deps scripts workspaces lock graph reality drift observe/);
  assert.equal(await page.$$eval('.pax thead ~ tbody tr', (r) => r.length), 7);
  assert.match(card, /Test execution result.*runs native tests/);
  assert.match(card, /PAX presence or invocation never makes a run "verified"/);
  assert.match(card, /not in your browser's or terminal's PATH/);
  // probing another executable: incompatible and old versions are named
  const wrong = fakePax({ help: 'posix', name: 'pax-wrong' });
  await page.fill('#probe-path', wrong.file);
  await page.click('#probe button');
  await page.waitForFunction(() => /Not PAX \/ incompatible/.test(document.querySelector('.pax h1')?.textContent || ''));
  assert.match(await textOf(page, '.pax'), /does not identify itself as PAX/);
  const old = fakePax({ version: '0.2.0', name: 'pax-old' });
  await page.fill('#probe-path', old.file);
  await page.click('#probe button');
  await page.waitForFunction(() => /needs PAX 0\.3\.0 or newer \(installed 0\.2\.0\)/.test(document.querySelector('.pax')?.textContent || ''));
  await page.fill('#probe-path', '/no/such/pax');
  await page.click('#probe button');
  await page.waitForFunction(() => /Not found/.test(document.querySelector('.pax h1')?.textContent || ''));
  assert.match(await textOf(page, '.pax .fix'), /A browser cannot install a program on the machine that runs the server/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a run with PAX: live progress, evidence kept apart from verification, artifacts, history and filters', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await open(main, { hash: '#/' });
  const id = await startLocalRun(page, { pax: true });
  assert.match(await textOf(page, '#scope-list, .run-head'), /./);
  await waitStatus(page, /completed/);
  assert.deepEqual(await page.$$eval('.stages .stage', (s) => s.map((x) => x.querySelector('.st').textContent)), ['done', 'done', 'done']);

  await page.click('[data-tab=evidence]');
  await page.waitForSelector('#ev-pax');
  const factory = await textOf(page, '[aria-labelledby=ev-factory]');
  assert.match(factory, /Factory verification verified/);
  assert.match(factory, /Baseline \(before any change\).*npm test.*passed/);
  const paxText = await textOf(page, '[aria-labelledby=ev-pax]');
  assert.match(paxText, /PAX observation not verification/);
  assert.match(paxText, /PAX 0\.5\.0 · configured path/);
  assert.match(paxText, /Project info observed/);
  assert.match(paxText, /Drift between layers no drift/);
  assert.match(paxText, /not the factory's verification/);
  assert.match(await textOf(page, '[aria-labelledby=ev-agent]'), /not evidence/);
  assert.ok((await page.$$('[aria-labelledby=ev-pax] a[href*="download/pax/"]')).length >= 4, 'evidence artifacts are linked');
  const href = await page.getAttribute('[aria-labelledby=ev-pax] a[href*="info.stdout.json"]', 'href');
  const body = await (await fetch(main.url + href)).json();
  assert.equal(body.command, 'info');
  assert.ok(!(await page.content()).includes(main.app.store.workspaceDir(id)), 'no host path in the page');
  // collect more evidence from the browser; the test step needs an explicit confirmation
  await page.waitForSelector('#pax-run fieldset:not([disabled])', { timeout: 60_000 }); // the form is disabled while the backend still counts the run as executing (a race under load)
  await page.check('#pax-run input[value=test]');
  page.once('dialog', (d) => { assert.match(d.message(), /native tests through PAX/); d.accept(); });
  await page.click('#pax-run button');
  await page.waitForFunction(() => /Test execution result passed/.test(document.querySelector('[aria-labelledby=ev-pax]')?.textContent.replace(/\s+/g, ' ') || ''), null, { timeout: 20_000 });

  // history
  await page.goto(main.url + '#/history', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.runs-table');
  assert.ok((await textOf(page, '.runs-table')).includes(id));
  assert.match(await textOf(page, '.runs-table'), /local · widgets/);
  assert.match(await textOf(page, '.runs-table'), /verified/);
  assert.match(await textOf(page, '.runs-table'), /PAX: collected/);
  await page.fill('#h-q', 'no-such-task');
  assert.match(await textOf(page, '#h-list'), /No runs match/);
  await page.fill('#h-q', id.slice(-6));
  assert.equal(await page.$$eval('.runs-table tbody tr', (r) => r.length), 1);
  await page.fill('#h-q', '');
  await page.selectOption('#h-source', 'github');
  assert.match(await textOf(page, '#h-list'), /No runs match/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('review gates apply and publish; publishing is explicit, confirmed, and shows the resulting pull request', async (t) => {
  if (skip) return t.skip(skip);
  // This test needs a GitHub token on the server; it saves its own (through the same API the Settings page uses).
  const saved = await fetch(`${main.url}api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { githubToken: TOKEN } }) });
  assert.equal(saved.status, 200);
  const { page, errors } = await open(main, { hash: '#/' });
  await page.waitForSelector('#new-form');
  await page.check('input[value=github]');
  await page.fill('#repo-url', 'acme/widgets');
  await page.click('#check-repo');
  await page.waitForFunction(() => /acme\/widgets @ main/.test(document.querySelector('#src-summary').textContent));
  assert.match(await textOf(page, '#scope-list'), /Publishing is off/);
  await page.fill('textarea[name=idea]', 'Add a changelog');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => /#\/runs\//.test(location.hash), null, { timeout: 30_000 });
  await waitStatus(page, /completed/);
  await page.click('[data-tab=delivery]');
  await page.waitForSelector('#pub-card');
  assert.match(await textOf(page, '#pub-card'), /Not published\. Pushing and opening a pull request are explicit actions/);
  assert.equal(await page.isDisabled('[data-pub=pr]'), true);
  assert.match(await textOf(page, '#pub-card'), /Approve the changes in the Review card to enable publishing/);
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 0);
  // reject -> still locked
  await page.fill('#review-note', 'not yet');
  await page.click('[data-review=reject]');
  await page.waitForSelector('#review-card .pill.failed');
  assert.equal(await page.isDisabled('[data-pub=pr]'), true);
  assert.match(await textOf(page, '#review-card'), /“not yet”/);
  await page.click('[data-review=approve]');
  await page.waitForSelector('#review-card .pill.completed');
  assert.equal(await page.isDisabled('[data-pub=pr]'), false);
  // declining the confirmation publishes nothing
  page.once('dialog', (d) => d.dismiss());
  await page.click('[data-pub=pr]');
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 0);
  page.once('dialog', (d) => { assert.match(d.message(), /Push the branch da-prompt\/.* to acme\/widgets and open a pull request against main/); assert.match(d.message(), /never forced/); d.accept(); });
  await page.click('[data-pub=pr]');
  await page.waitForSelector('#pub-card a[href*="/pull/"]');
  assert.match(await textOf(page, '#pub-card'), /Publication: pr-created|pr-created/);
  assert.equal(await page.getAttribute('#pub-card a[href*="/pull/"]', 'href'), 'https://github.com/acme/widgets/pull/1');
  assert.match(await textOf(page, '#pub-card'), /Copy link/);
  assert.match(await textOf(page, '#pub-card'), /pushed da-prompt\//);
  assert.ok(!(await page.content()).includes(TOKEN));
  // history shows the PR
  await page.goto(main.url + '#/history', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.runs-table');
  assert.match(await textOf(page, '.runs-table'), /PR #1/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('lifecycle: refresh during a run keeps access and reconnects, cancel stops it with a clear explanation, resume finishes it', async (t) => {
  if (skip) return t.skip(skip);
  delayMs = 250;
  const { page, errors } = await open(main, { hash: '#/' });
  try {
    const id = await startLocalRun(page, { idea: 'Add a slow change' });
    await page.waitForSelector('#live-ind');
    assert.match(await textOf(page, '#live-ind'), /live/);
    assert.equal(await page.isVisible('[data-act=cancel]'), true);
    assert.equal(await page.$('[data-act=resume]'), null, 'no resume control while running');
    await page.waitForFunction(() => document.querySelector('.stages .stage.done'), null, { timeout: 30_000 });
    // refresh: the run, its history and the live stream come back
    await page.reload();
    await page.waitForSelector('.run-head h1');
    assert.ok(page.url().endsWith(id));
    await page.waitForSelector('#live-ind');
    await page.click('[data-tab=activity]');
    await page.waitForFunction(() => document.querySelectorAll('#feed li').length > 3);
    // cancel
    await page.click('[data-act=cancel]');
    await waitStatus(page, /cancelled/, 30_000);
    const stopped = await textOf(page, '.failure');
    assert.match(stopped, /Run cancelled/);
    assert.match(stopped, /What failed/);
    assert.match(stopped, /What the factory observed/);
    assert.match(stopped, /Your directory was not modified/);
    assert.match(stopped, /Resume continues from where it stopped/);
    assert.equal(await page.isVisible('[data-act=resume]'), true);
    assert.equal(await page.$('[data-act=cancel]'), null, 'no cancel control once stopped');
    // resume
    delayMs = 0;
    await page.click('[data-act=resume]');
    await waitStatus(page, /completed/);
    assert.equal(await page.$('.failure'), null);
    assert.match(await textOf(page, '.nexts'), /Review the changes/);
    assert.equal(await page.$('[data-act=resume]'), null);
  } finally {
    delayMs = 0;
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('the UI is honest when the backend disappears and comes back', async (t) => {
  if (skip) return t.skip(skip);
  const { page } = await open(main, { hash: '#/history' });
  await page.waitForSelector('.runs-table, .empty-state');
  assert.equal(await page.isHidden('#backend-banner'), true);
  await page.route(/\/api\//, (r) => r.abort());
  await page.waitForSelector('#backend-banner:not([hidden])', { timeout: 15_000 });
  assert.match(await textOf(page, '#backend-banner'), /backend is not responding/);
  // actions fail with an explanation instead of a silent no-op
  await page.goto(main.url + '#/setup', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#recheck');
  await page.click('#recheck');
  await page.waitForSelector('[data-retry]');
  assert.match(await textOf(page, '#health'), /The factory backend did not answer.*Nothing was changed/);
  await page.unroute(/\/api\//);
  await page.click('[data-retry]');
  await page.waitForSelector('[data-check=backend]');
  await page.waitForSelector('#backend-banner', { state: 'hidden', timeout: 15_000 });
  await page.close();

  // a page opened while the backend is already down says so and keeps retrying
  const down = await browser.newPage();
  await down.route(/\/api\//, (r) => r.abort());
  await down.goto(main.url, { waitUntil: 'domcontentloaded' });
  await down.waitForSelector('#main .escalation');
  assert.match(await textOf(down, '#main'), /backend is not reachable[\s\S]*Retrying/);
  await down.unroute(/\/api\//);
  await down.waitForSelector('#new-form', { timeout: 15_000 });
  await down.close();
});

test('keyboard and labels: every operations page can be driven from the keyboard', async (t) => {
  if (skip) return t.skip(skip);
  const { page } = await open(main, { hash: '#/settings?group=execution' });
  await page.waitForSelector('#sform');
  await page.focus('#set-maxParallel');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('6');
  await page.keyboard.press('Enter'); // submits the form from the keyboard
  await page.waitForFunction(() => /Saved/.test(document.querySelector('#save-state')?.textContent || ''));
  assert.equal(main.app.cfg.defaults.maxParallel, 6);
  await page.click('.setting[data-key=maxParallel] [data-reset]');
  for (const hash of ['#/setup', '#/pax', '#/history', '#/settings']) {
    await page.goto(main.url + hash, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#main h1');
    const unnamed = await page.$$eval('#main button, #main a, #main input, #main select, #main textarea', (els) => els.filter((e) => !e.getAttribute('aria-label') && !(e.textContent || '').trim() && !e.labels?.length && e.type !== 'hidden' && !e.closest('label')).map((e) => e.outerHTML.slice(0, 80)));
    assert.deepEqual(unnamed, [], hash);
  }
  await page.close();
});
