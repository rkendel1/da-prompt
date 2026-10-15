// Browser test: New run → "Who does what" gives a role and retries their own models; the run records them and its Models
// tab shows which model made each attempt. Needs Playwright (not a dependency of this repo): skipped, loudly, without it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from '../src/server.js';
import { OfflineProvider } from '../src/providers/offline.js';
import { startMockLLM } from './mock-llm.js';
import { blockNetwork } from './offline-guard.js';
import { tmpDir, waitFor } from './helpers.js';

async function loadPlaywright() {
  const tries = [() => import('playwright'), () => import(pathToFileURL(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright', 'index.mjs')).href)];
  for (const t of tries) { try { return await t(); } catch { /* next */ } }
  return null;
}

// The local server lists the models (so the picker offers them); the offline agents do the work under each model's name.
class Named extends OfflineProvider {
  constructor(id, model) {
    super({ faults: 'on', delayMs: 0 });
    Object.assign(this, { name: id, model });
  }
  describe() {
    return { name: this.name, label: this.name, model: this.model, plannerModel: this.model };
  }
}

blockNetwork();
let browser; let app; let url; let llm; let skip = '';
before(async () => {
  const pw = await loadPlaywright();
  if (!pw) return void (skip = 'Playwright is not installed');
  try { browser = await pw.chromium.launch(); } catch (e) { return void (skip = `no browser available: ${e.message.split('\n')[0]}`); }
  llm = await startMockLLM({ flavor: 'ollama', models: ['small-coder:7b', 'big-coder:32b'] });
  app = await createServer({ dataDir: tmpDir(), env: { ...process.env, OLLAMA_HOST: llm.url }, providerFactory: (id, _cfg, run) => new Named(id, run.model) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}/`;
});
after(async () => { await browser?.close(); await app?.close(); await llm?.close(); });

test('New run: a role model and a retry model are chosen in the UI, used by the run, and shown per attempt in the Models tab', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(`${url}#/new`);
  await page.waitForSelector('#pk-provider');
  await page.selectOption('#pk-provider', 'ollama');
  await page.waitForSelector('#pk-model');
  await page.selectOption('#pk-model', 'small-coder:7b');
  await page.click('#pk-routing > summary');
  await page.selectOption('select[data-role=design]', 'ollama::big-coder:32b');
  await page.selectOption('#pk-retry', 'ollama::big-coder:32b');
  assert.match(await page.textContent('#pk-routing > summary'), /2 model overrides/);
  assert.match(await page.textContent('[data-track=design]'), /no history as design/);
  await page.uncheck('input[name=deploy]').catch(() => {});
  await page.fill('textarea[name=idea]', 'A packing checklist for trips');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => /#\/runs\//.test(location.hash), null, { timeout: 20_000 });
  const id = page.url().split('/runs/')[1];

  const run = await waitFor(async () => { const r = (await (await fetch(`${url}api/runs/${id}`)).json()).run; return !r.executing && r.plan && ['completed', 'needs_attention'].includes(r.status) && r; }, { timeoutMs: 90_000 });
  assert.deepEqual({ provider: run.roleModels.design.provider, model: run.roleModels.design.model }, { provider: 'ollama', model: 'big-coder:32b' });
  assert.equal(run.retryModel.model, 'big-coder:32b');
  assert.equal(run.plan.tasks.find((x) => x.role === 'design').attempts[0].model.model, 'big-coder:32b');
  assert.equal(run.plan.tasks.find((x) => x.id === 'core').attempts[1].model.via, 'retry');

  await page.click('[data-tab=models]');
  await page.waitForSelector('.models-table');
  const table = await page.textContent('.models-table');
  assert.match(table, /big-coder:32b/);
  assert.match(table, /small-coder:7b/);
  assert.match(await page.textContent('.task-models'), /retry model/);
  assert.match(await page.textContent('#tab'), /Who was set to do what[\s\S]*design[\s\S]*big-coder:32b/);

  // The next New run shows each model's record in its role from this run.
  await page.goto(`${url}#/new`);
  await page.waitForSelector('#pk-routing');
  await page.evaluate(() => { document.querySelector('#pk-routing').open = true; });
  await page.waitForFunction(() => /1\/1 task verified/.test(document.querySelector('[data-track=design]')?.textContent || ''));
  assert.deepEqual(errors, []);
  await page.close();
});
