// Browser test for the existing-project screens. Needs Playwright (not a dependency of this repo):
// it is skipped, loudly, when Playwright or its browser cannot be found.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from '../src/server.js';
import { OfflineProvider } from '../src/providers/offline.js';
import { tmpDir } from './helpers.js';
import { makeRepo, makeRoot, makeRemote, startMockApi, writeFiles } from './project-helpers.js';

async function loadPlaywright() {
  const tries = [() => import('playwright')];
  tries.push(() => import(pathToFileURL(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright', 'index.mjs')).href));
  for (const t of tries) {
    try {
      return await t();
    } catch {
      /* try next */
    }
  }
  return null;
}

let pw;
let browser;
let app;
let api;
let url;
let roots;
let skip = '';

before(async () => {
  pw = await loadPlaywright();
  if (!pw) return void (skip = 'Playwright is not installed');
  try {
    browser = await pw.chromium.launch();
  } catch (e) {
    return void (skip = `no browser available: ${e.message.split('\n')[0]}`);
  }
  roots = makeRoot({ widgets: (d) => fs.cpSync(makeRepo(), d, { recursive: true }), notes: (d) => writeFiles(d, { 'a.txt': 'x' }) });
  fs.appendFileSync(path.join(roots.dirs.widgets, 'README.md'), 'wip\n');
  const remote = makeRemote();
  api = await startMockApi();
  app = await createServer({ dataDir: tmpDir(), defaultProvider: 'offline', ...roots.cfg, gitConfig: remote.insteadOf, githubToken: '', githubApiUrl: api.url, providerFactory: () => new OfflineProvider({ faults: false, delayMs: 0 }) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}/`;
});
after(async () => {
  await browser?.close();
  await app?.close();
  await api?.close();
});

async function open() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#new-form');
  return { page, errors };
}

test('New Run: project modes switch, summaries and validation work, and the new-project form is unchanged', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await open();
  // Default: new project, greenfield wording, source sections hidden.
  assert.equal(await page.isChecked('input[value=new]'), true);
  assert.match(await page.textContent('#idea-label'), /^Idea/);
  assert.equal(await page.isVisible('#src-local'), false);
  assert.equal(await page.isVisible('#src-github'), false);
  assert.equal(await page.isVisible('#examples'), true);

  // Local directory: authorized list with repository detection, branch and uncommitted-changes flag.
  await page.check('input[value=local]');
  await page.waitForFunction(() => /Reads:/.test(document.querySelector('#src-summary').textContent));
  assert.match(await page.textContent('#idea-label'), /What do you want to change\?/);
  assert.equal(await page.isVisible('#src-github'), false);
  assert.equal(await page.isVisible('#examples'), false);
  const options = await page.$$eval('#directory-id option', (os) => os.map((o) => o.textContent));
  assert.ok(options.some((o) => /^widgets — main · uncommitted changes/.test(o)), options.join('|'));
  assert.ok(options.some((o) => /^notes — not a git repository/.test(o)), options.join('|'));
  assert.ok(!(await page.content()).includes(roots.root), 'no server path in the page');
  await page.selectOption('#directory-id', { label: options.find((o) => o.startsWith('widgets')) });
  await page.waitForFunction(() => /branch main/.test(document.querySelector('#src-summary').textContent));
  const summary = (await page.textContent('#src-summary')).replace(/\s+/g, ' ');
  assert.match(summary, /Reads: widgets · branch main · 1 uncommitted change/);
  assert.match(summary, /Edits happen in: an isolated clone of the last commit/);
  assert.match(summary, /Publishing: off — local runs never push/);
  assert.match(summary, /Detected: node/);
  assert.match(await page.textContent('#working-mode'), /Clone[\s\S]*Snapshot/);
  assert.equal(await page.isChecked('[name=deploy]'), false, 'previews are opt-in for existing projects');

  // GitHub: repository check shows the ref, the working branch and whether publishing is possible.
  await page.check('input[value=github]');
  assert.equal(await page.isVisible('#src-local'), false);
  await page.click('#check-repo');
  await page.waitForFunction(() => /Enter a repository/.test(document.querySelector('#src-summary').textContent));
  await page.fill('#repo-url', 'acme/widgets');
  await page.click('#check-repo');
  await page.waitForFunction(() => /acme\/widgets @ main/.test(document.querySelector('#src-summary').textContent));
  assert.equal(await page.isDisabled('#publish'), true, 'no GITHUB_TOKEN on this server');
  assert.match((await page.textContent('#src-summary')).replace(/\s+/g, ' '), /an isolated clone on a new branch da-prompt\/<run id>; main is never modified/);
  assert.match(await page.textContent('#src-summary'), /GITHUB_TOKEN is not set/);
  await page.fill('#repo-url', 'acme/ghost');
  await page.click('#check-repo');
  await page.waitForFunction(() => /repository not found|authentication/.test(document.querySelector('#src-summary').textContent));
  assert.equal(await page.$eval('#src-summary', (el) => el.classList.contains('bad')), true);

  // Validation before anything starts.
  await page.fill('#repo-url', '');
  await page.fill('textarea[name=idea]', 'Do something');
  await page.click('button[type=submit]');
  assert.match(await page.textContent('#form-error'), /Enter the GitHub repository/);
  assert.equal(page.url().includes('#/runs/'), false);

  // Back to a new project: greenfield again.
  await page.check('input[value=new]');
  assert.match(await page.textContent('#idea-label'), /^Idea/);
  assert.equal(await page.isVisible('#examples'), true);
  assert.equal(await page.isChecked('[name=deploy]'), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('an existing-project run: stages, changed files with diff, delivery, apply', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await open();
  await page.check('input[value=local]');
  await page.waitForFunction(() => document.querySelector('#directory-id option'));
  const label = (await page.$$eval('#directory-id option', (os) => os.map((o) => o.textContent))).find((o) => o.startsWith('widgets'));
  await page.selectOption('#directory-id', { label });
  await page.waitForFunction(() => /branch main/.test(document.querySelector('#src-summary').textContent));
  await page.fill('textarea[name=idea]', 'Add password reset to this application');
  await page.click('button[type=submit]');
  await page.waitForURL(/#\/runs\//);
  await page.waitForFunction(() => /completed/.test(document.querySelector('.run-head .pill')?.textContent || ''), null, { timeout: 60_000 });

  // The seven layers are intact; the existing-project stages sit beside them.
  assert.equal(await page.$$eval('.rail .layer', (l) => l.length), 7);
  assert.deepEqual(await page.$$eval('.stages .stage', (s) => s.map((x) => `${x.querySelector('b').textContent}:${x.querySelector('.st').textContent}`)), ['Connect:done', 'Inspect:done', 'Baseline:done']);
  assert.match(await page.textContent('.eyebrow'), /local widgets/);

  // Overview: source, baseline and verification cards.
  const overview = await page.textContent('#tab');
  assert.match(overview, /Project source/);
  assert.match(overview, /Baseline/);
  assert.match(overview, /npm test/);

  // Files: the changed-file list and a diff.
  await page.click('[data-tab=files]');
  await page.waitForSelector('.diff .add');
  assert.match(await page.textContent('.tree'), /docs\/da-prompt-change-request\.md/);
  assert.match(await page.textContent('.diff'), /\+Add password reset to this application/);
  await page.click('[data-view=all]');
  await page.waitForSelector('.tree button');
  assert.match(await page.textContent('.tree'), /src\/greet\.js/);

  // Delivery: readiness, verification, patch download, source/working branch, apply.
  await page.click('[data-tab=delivery]');
  await page.waitForSelector('#local-card');
  const delivery = await page.textContent('#tab');
  assert.match(delivery, /ready for review/i);
  assert.match(delivery, /source protection verified/);
  assert.match(delivery, /working branch/);
  assert.match(delivery, /da-prompt\//);
  assert.match(delivery, /Pre-existing|Passing/);
  assert.ok(await page.$('a[href$="download/changes.patch"]'));
  assert.equal(await page.$('[data-pub]'), null, 'no GitHub controls on a local run');
  await page.click('[data-apply=working-tree]');
  await page.waitForFunction(() => /applied 1 file/.test(document.querySelector('#local-card')?.textContent || ''));
  assert.ok(fs.existsSync(path.join(roots.dirs.widgets, 'docs/da-prompt-change-request.md')));
  assert.deepEqual(errors, []);
  await page.close();
});

test('a new-project run still looks and works as before', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await open();
  await page.fill('textarea[name=idea]', 'A packing checklist for trips');
  await page.click('button[type=submit]');
  await page.waitForURL(/#\/runs\//);
  await page.waitForFunction(() => /completed/.test(document.querySelector('.run-head .pill')?.textContent || ''), null, { timeout: 90_000 });
  assert.equal(await page.$('.stages'), null);
  await page.click('[data-tab=files]');
  await page.waitForSelector('.tree button');
  assert.equal(await page.$('[data-view]'), null);
  assert.ok(await page.$('a[href$="download/project.tar.gz"]'));
  assert.deepEqual(errors, []);
  await page.close();
});
