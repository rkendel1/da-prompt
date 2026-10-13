// Browser tests for the Projects area: the persistent registry as a user meets it (register once, come back, open a
// terminal, start a task, repair, rename, archive, remove). Real Chromium, real backend, real temp git repositories.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cleanMachineEnv } from './cli-helpers.js';
import { startRegistryBackend, initRepo, writer } from './registry-helpers.js';
import { waitFor } from './helpers.js';

cleanMachineEnv();

async function loadPlaywright() {
  for (const t of [() => import('playwright'), () => import(pathToFileURL(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright', 'index.mjs')).href)]) {
    try { return await t(); } catch { /* next */ }
  }
  return null;
}
let browser;
let skip = '';
const backends = [];
const pages = [];
before(async () => {
  const pw = await loadPlaywright();
  if (!pw) return void (skip = 'Playwright is not installed');
  try { browser = await pw.chromium.launch(); } catch (e) { skip = `no browser available: ${e.message.split('\n')[0]}`; }
});
after(async () => {
  for (const p of pages) await p.close().catch(() => {});
  await browser?.close();
  for (const b of backends) await b.close().catch(() => {});
});
const T = (name, fn) => test(name, async (t) => (skip ? t.skip(skip) : fn(t)));
const boot = async (opts) => {
  const be = await startRegistryBackend({ extra: { providerFactory: () => writer() }, ...opts });
  backends.push(be);
  return be;
};
async function open(be, hash = '#/projects') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  pages.push(page);
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${be.url}/${hash}`);
  return page;
}
const repo = (d, o) => initRepo(d, o);

T('Projects is in the navigation; registering a folder once through the UI shows its identity, git state and primary actions', async () => {
  const be = await boot({ roots: { shop: (d) => repo(d, { remote: 'https://github.com/acme/storefront.git' }) } });
  const page = await open(be, '#/');
  await page.click('a[href="#/projects"]');
  await page.waitForSelector('.empty-term');
  assert.match(await page.textContent('.empty-term'), /No projects yet/);
  await page.click('#proj-register');
  await page.waitForSelector('#reg-form');
  assert.match(await page.textContent('#reg-dir'), /shop — git · main/);
  await page.fill('#reg-form [name=name]', 'Storefront');
  await page.click('#reg-form button[type=submit]');
  await page.waitForSelector('#proj-name');
  assert.equal(await page.textContent('#proj-name'), 'Storefront');
  assert.match(page.url(), /#\/projects\/prj_[\w-]{16}$/);
  assert.equal(await page.getAttribute('[data-status]', 'data-status'), 'available');
  assert.match(await page.textContent('#proj-git'), /Branch\s*main/);
  assert.match(await page.textContent('#proj-git'), /github\.com\/acme\/storefront/);
  assert.match(await page.textContent('#proj-git'), /Working tree\s*clean/);
  assert.match(await page.textContent('#proj-location'), /\/shop$/, 'administrators see where it lives');
  assert.equal(await page.isVisible('#open-terminal'), true);
  assert.equal(await page.isVisible('#start-task'), true);
  assert.deepEqual(page.errors, []);
});

T('the registry is still there after a refresh, closing the browser and restarting the backend; search and status filters work', async () => {
  const be = await boot({ roots: { alpha: (d) => repo(d), beta: (d) => repo(d, { message: 'beta start' }) } });
  const a = await be.register('alpha', { name: 'Alpha service' });
  await be.register('beta', { name: 'Beta tool' });
  let page = await open(be);
  await page.waitForSelector('.proj-row');
  assert.equal((await page.$$('.proj-row')).length, 2);
  await page.reload();
  await page.waitForSelector('.proj-row');
  assert.equal((await page.$$('.proj-row')).length, 2, 'refresh');
  await page.close();
  await be.restart();
  page = await open(be);
  await page.waitForSelector('.proj-row');
  assert.match(await page.textContent('.proj-rows'), /Alpha service/);
  assert.equal(await page.getAttribute(`.proj-row[data-id="${a.id}"]`, 'data-id'), a.id, 'same id after a restart');
  await page.fill('#proj-q', 'beta');
  assert.equal((await page.$$('.proj-row')).length, 1);
  await page.fill('#proj-q', 'nothing-like-this');
  assert.match(await page.textContent('#proj-list'), /No project matches/);
  await page.fill('#proj-q', '');
  // Status filter reflects real validation: move one folder away.
  fs.renameSync(be.roots.dirs.beta, path.join(be.roots.root, 'beta-gone'));
  await page.click('a[href="#/"]');
  await page.goto(`${be.url}/#/projects`);
  await page.reload();
  await page.waitForSelector('.proj-row');
  await page.selectOption('#proj-status', 'missing');
  assert.equal((await page.$$('.proj-row')).length, 1);
  assert.match(await page.textContent('.proj-row'), /Beta tool[\s\S]*Missing[\s\S]*no longer exists/);
});

T('rename keeps the id; archive blocks new work but keeps history; restore; remove needs the typed name and deletes no files', async () => {
  const be = await boot({ roots: { app: (d) => repo(d) } });
  const p = await be.register('app');
  const page = await open(be, `#/projects/${p.id}`);
  await page.waitForSelector('#proj-name');
  await page.click('#proj-rename');
  await page.fill('#rename-input', 'Renamed app');
  await page.click('#rename-form button[type=submit]');
  await waitFor(async () => (await page.textContent('#proj-name')) === 'Renamed app', { timeoutMs: 10000, intervalMs: 100 });
  assert.ok(page.url().endsWith(p.id), 'the URL (the id) did not change');
  await page.click('#proj-archive');
  await page.waitForSelector('#proj-restore');
  assert.equal(await page.getAttribute('#start-task', 'aria-disabled'), 'true');
  assert.equal(await page.getAttribute('#open-terminal', 'aria-disabled'), 'true');
  await page.click('#proj-restore');
  await page.waitForSelector('#proj-archive');
  assert.equal(await page.getAttribute('#start-task', 'aria-disabled'), null);
  // Removal.
  assert.equal(await page.isDisabled('#proj-remove button'), true);
  await page.fill('#proj-remove [name=confirm]', 'wrong');
  assert.equal(await page.isDisabled('#proj-remove button'), true);
  await page.fill('#proj-remove [name=confirm]', 'Renamed app');
  await page.click('#proj-remove button');
  await page.waitForSelector('.empty-term');
  assert.ok(fs.existsSync(path.join(be.roots.dirs.app, '.git')), 'the repository was not touched');
  assert.equal((await be.call('GET', '/api/projects')).body.projects.length, 0);
});

T('a moved folder is shown as missing with the reason, and repairing it keeps the project (and its history) intact', async () => {
  const be = await boot({ roots: { app: (d) => repo(d, { remote: 'https://github.com/acme/app.git' }) } });
  const p = await be.register('app', { name: 'Keep me' });
  fs.renameSync(be.roots.dirs.app, path.join(be.roots.root, 'app-new-home'));
  const page = await open(be, `#/projects/${p.id}`);
  await page.waitForSelector('#proj-problems');
  assert.match(await page.textContent('#proj-problems'), /Missing[\s\S]*history are kept/);
  assert.equal(await page.getAttribute('#start-task', 'aria-disabled'), 'true', 'work is blocked until it is fixed');
  const opt = await page.$$eval('#repair-form option', (o) => o.map((x) => [x.value, x.textContent]));
  await page.selectOption('#repair-form [name=directoryId]', opt.find(([, t]) => /app-new-home/.test(t))[0]);
  await page.click('#repair-form button[type=submit]');
  await waitFor(async () => (await page.getAttribute('[data-status]', 'data-status').catch(() => '')) === 'available', { timeoutMs: 15000, intervalMs: 100 });
  assert.equal(await page.textContent('#proj-name'), 'Keep me');
  assert.ok(page.url().endsWith(p.id));
  assert.match(await page.textContent('#proj-location'), /app-new-home$/);
  // A different repository needs an explicit second step.
  const other = initRepo(path.join(be.roots.root, 'stranger'), { remote: 'https://github.com/x/y.git', message: 'stranger', files: { 's.txt': 's' } });
  void other;
  await page.goto(`${be.url}/#/projects/${p.id}`);
  fs.renameSync(path.join(be.roots.root, 'app-new-home'), path.join(be.roots.root, 'gone-again'));
  await page.reload();
  await page.waitForSelector('#repair-form');
  const opts2 = await page.$$eval('#repair-form option', (o) => o.map((x) => [x.value, x.textContent]));
  await page.selectOption('#repair-form [name=directoryId]', opts2.find(([, t]) => /stranger/.test(t))[0]);
  await page.click('#repair-form button[type=submit]');
  await page.waitForSelector('#repair-msg [data-accept]');
  assert.match(await page.textContent('#repair-msg'), /does not look like|different repository/);
  assert.equal((await be.call('GET', `/api/projects/${p.id}`)).body.project.status, 'missing', 'nothing was changed by the refused repair');
});

T('duplicate registration explains the conflict and offers the explicit resolutions', async () => {
  const be = await boot({ roots: { one: (d) => repo(d, { remote: 'https://github.com/acme/same.git' }) } });
  const a = await be.register('one', { name: 'First' });
  const two = path.join(be.roots.root, 'two');
  const { git } = await import('./registry-helpers.js');
  git(be.roots.root, 'clone', '-q', be.roots.dirs.one, two);
  git(two, 'remote', 'set-url', 'origin', 'https://github.com/acme/same.git');
  const page = await open(be);
  await page.click('#proj-register');
  await page.waitForSelector('#reg-form');
  const opts = await page.$$eval('#reg-dir option', (o) => o.map((x) => [x.value, x.textContent]));
  await page.selectOption('#reg-dir', opts.find(([, t]) => /^one/.test(t))[0]);
  await page.click('#reg-form button[type=submit]');
  await page.waitForSelector('#reg-msg:not([hidden])');
  assert.match(await page.textContent('#reg-msg'), /already registered as "First"/);
  assert.ok(await page.$(`#reg-msg a[href="#/projects/${a.id}"]`), 'links to the existing project');
  await page.selectOption('#reg-dir', opts.find(([, t]) => /^two/.test(t))[0]);
  await page.click('#reg-form button[type=submit]');
  await page.waitForSelector('#reg-msg [data-ack]');
  assert.match(await page.textContent('#reg-msg'), /another checkout/);
  await page.click('#reg-msg [data-ack]');
  await page.waitForSelector('#proj-name');
  assert.equal(await page.textContent('#proj-name'), 'two');
  assert.equal((await be.call('GET', '/api/projects')).body.projects.length, 2);
});

T('Open terminal from a project starts in its directory (the session records the id); Start a task opens New Run on that project and the run joins its history', async () => {
  const be = await boot({ roots: { work: (d) => repo(d) } });
  const p = await be.register('work', { name: 'Daily driver' });
  const page = await open(be, `#/projects/${p.id}`);
  await page.waitForSelector('#open-terminal');
  await page.click('#open-terminal');
  await page.waitForSelector('.xterm-screen');
  await waitFor(async () => (await page.evaluate(() => document.querySelector('#term-meta [data-state]')?.dataset.state)) === 'live', { timeoutMs: 20000, intervalMs: 50 });
  assert.equal(await page.textContent('#term-cwd'), fs.realpathSync(be.roots.dirs.work));
  assert.equal(await page.textContent('.tproj a'), 'Daily driver');
  const s = (await be.call('GET', '/api/terminal')).body.sessions[0];
  assert.equal(s.project.projectId, p.id);
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await page.evaluate(() => { const t = window.__daTerminal().active.term; const b = t.buffer.active; let o = ''; for (let i = 0; i < b.length; i++) o += `${b.getLine(i).translateToString(true)}\n`; return o; })).includes(`\n${fs.realpathSync(be.roots.dirs.work)}\n`), { timeoutMs: 15000, intervalMs: 100 });
  await be.call('DELETE', `/api/terminal/sessions/${s.id}`);
  // Start a task.
  await page.goto(`${be.url}/#/projects/${p.id}`);
  await page.waitForSelector('#start-task');
  await page.click('#start-task');
  await page.waitForSelector('#project-id');
  assert.equal(await page.inputValue('#project-id'), p.id, 'the project is preselected');
  assert.equal(await page.isChecked('[name=sourceMode][value=registered]'), true);
  await waitFor(async () => /Reads:[\s\S]*work/.test(await page.textContent('#src-summary')), { timeoutMs: 15000, intervalMs: 100 });
  await page.fill('[name=idea]', 'Add a farewell helper');
  await page.selectOption('#reg-working-mode', 'clone');
  await page.evaluate(() => { const sel = document.querySelector('#provider'); void sel; });
  await page.click('#new-form button[type=submit]');
  await page.waitForURL(/#\/runs\//, { timeout: 30000 });
  assert.match(await page.textContent('.eyebrow'), /project\s+Daily driver/);
  assert.ok(await page.$(`.eyebrow a[href="#/projects/${p.id}"]`));
  await waitFor(async () => (await be.call('GET', `/api/projects/${p.id}/runs`)).body.runs.length === 1, { timeoutMs: 15000 });
  await page.goto(`${be.url}/#/projects/${p.id}`);
  await page.waitForSelector('#proj-runs');
  assert.match(await page.textContent('#proj-runs'), /Add a farewell helper/);
  await waitFor(async () => (await be.call('GET', '/api/runs')).body.runs[0].status !== 'running' && !(await be.call('GET', '/api/runs')).body.runs[0].executing, { timeoutMs: 120000 });
});
