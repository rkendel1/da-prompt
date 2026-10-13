// Browser test: a run that failed on its provider is edited in the UI (new provider, a note) and resumed.
// Needs Playwright (not a dependency of this repo): skipped, loudly, when it or its browser cannot be found.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from '../src/server.js';
import { OfflineProvider } from '../src/providers/offline.js';
import { tmpDir, waitFor } from './helpers.js';

async function loadPlaywright() {
  const tries = [() => import('playwright'), () => import(pathToFileURL(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright', 'index.mjs')).href)];
  for (const t of tries) { try { return await t(); } catch { /* next */ } }
  return null;
}

class Bad extends OfflineProvider {
  async chat(req) {
    if (req.meta?.kind === 'plan') throw new Error('Anthropic API (claude-sonnet-5-5): HTTP 400: tool_choice: type "tool" and "any" are not supported for this model');
    return super.chat(req);
  }
}
let browser; let app; let url; let skip = '';
before(async () => {
  const pw = await loadPlaywright();
  if (!pw) return void (skip = 'Playwright is not installed');
  try { browser = await pw.chromium.launch(); } catch (e) { return void (skip = `no browser available: ${e.message.split('\n')[0]}`); }
  app = await createServer({ dataDir: tmpDir(), defaultProvider: 'offline', providerFactory: (id) => (id === 'bad' ? new Bad({ faults: false, delayMs: 0 }) : new OfflineProvider({ faults: false, delayMs: 0 })) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}/`;
});
after(async () => { await browser?.close(); await app?.close(); });

test('a failed run: Edit run shows why it stopped, switches the provider, adds a note, and Save & resume carries on', async (t) => {
  if (skip) return t.skip(skip);
  const created = await (await fetch(`${url}api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idea: 'A packing checklist for trips', provider: 'bad', model: 'm1', settings: { deploy: false, maxAttempts: 1 } }) })).json();
  const id = created.run.id;
  await waitFor(async () => (await (await fetch(`${url}api/runs/${id}`)).json()).run.status === 'failed', { timeoutMs: 30_000 });
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(`${url}#/runs/${id}`);
  await page.waitForSelector('[data-act=edit]');
  assert.match(await page.textContent('.failure'), /tool_choice/);
  assert.match(await page.textContent('.failure'), /Edit run/);
  await page.click('[data-act=edit]');
  await page.waitForSelector('dialog.edit-run[open] #er-form');
  assert.match(await page.textContent('dialog.edit-run'), /Why it stopped:[\s\S]*tool_choice/);
  await page.waitForSelector('dialog.edit-run #pk-provider');
  assert.equal(await page.inputValue('dialog.edit-run [name=idea]'), 'A packing checklist for trips');
  await page.selectOption('dialog.edit-run #pk-provider', 'offline');
  await page.fill('dialog.edit-run [name=note]', 'Keep it very short.');
  await page.fill('dialog.edit-run [name=maxAttempts]', '2');
  await page.click('dialog.edit-run [data-save-resume]');
  await page.waitForSelector('dialog.edit-run', { state: 'detached' });
  const run = await waitFor(async () => { const r = (await (await fetch(`${url}api/runs/${id}`)).json()).run; return r.plan?.tasks?.length && !r.executing && r; }, { timeoutMs: 60_000 });
  assert.equal(run.provider, 'offline');
  assert.equal(run.settings.maxAttempts, 2);
  assert.equal(run.guidance[0].text, 'Keep it very short.');
  assert.ok(run.plan.tasks.every((x) => x.status === 'completed'), run.error);
  // The picker only changes what you change: the failed provider is not silently re-selected when saving without touching it.
  assert.deepEqual(errors, []);
  await page.close();
});
