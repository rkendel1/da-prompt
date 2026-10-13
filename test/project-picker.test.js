// The server-side folder picker: browse sub-folders, and authorize a chosen folder only when asked to.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { OfflineProvider } from '../src/providers/offline.js';
import { tmpDir } from './helpers.js';
import { makeRepo } from './project-helpers.js';

let app;
let base;
let workspace;

before(async () => {
  // Not the OS temp dir: settings refuse system locations (/var, /private, ...) as project folders.
  workspace = fs.mkdtempSync(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), '.picker-test-'));
  fs.mkdirSync(path.join(workspace, 'plain'));
  fs.mkdirSync(path.join(workspace, '.hidden'));
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'not a folder');
  fs.cpSync(makeRepo(), path.join(workspace, 'widgets'), { recursive: true });
  app = await createServer({ dataDir: tmpDir(), defaultProvider: 'offline', providerFactory: () => new OfflineProvider({ faults: false, delayMs: 0 }) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await app?.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const call = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};

test('with no project folders configured, a local browser can still browse (config says so)', async () => {
  const { data } = await call('GET', '/api/config');
  assert.equal(data.projects.local, false);
  assert.equal(data.projects.canBrowse, true);
});

test('browse lists folders only, hides dot-folders by default, and flags git repositories', async () => {
  const { status, data } = await call('GET', `/api/projects/browse?path=${encodeURIComponent(workspace)}`);
  assert.equal(status, 200);
  assert.equal(data.path, workspace);
  assert.deepEqual(data.entries.map((e) => e.name), ['plain', 'widgets']);
  assert.equal(data.entries.find((e) => e.name === 'widgets').isGit, true);
  assert.equal(data.authorized, false);
  assert.equal(data.parent, path.dirname(workspace));
  const withHidden = await call('GET', `/api/projects/browse?path=${encodeURIComponent(workspace)}&hidden=1`);
  assert.ok(withHidden.data.entries.some((e) => e.name === '.hidden'));
  assert.equal((await call('GET', `/api/projects/browse?path=${encodeURIComponent(path.join(workspace, 'file.txt'))}`)).status, 404);
  assert.equal((await call('GET', `/api/projects/browse?path=${encodeURIComponent(path.join(workspace, 'nope'))}`)).status, 404);
});

test('picking an unauthorized folder needs explicit authorization, then becomes a normal directory id', async () => {
  const target = path.join(workspace, 'widgets');
  const first = await call('POST', '/api/projects/pick', { path: target });
  assert.equal(first.status, 409);
  assert.equal(first.data.needsAuthorization, true);
  assert.equal((await call('GET', '/api/projects/directories')).data.directories.length, 0);

  const ok = await call('POST', '/api/projects/pick', { path: target, authorize: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(ok.data.id, /^[0-9a-f]{10}:widgets$/);
  assert.equal(ok.data.readOnly, false);

  // The parent is now an authorized root: siblings are listed and pickable without another prompt.
  const dirs = (await call('GET', '/api/projects/directories')).data.directories.map((d) => d.name);
  assert.ok(dirs.includes('widgets') && dirs.includes('plain'));
  assert.equal((await call('POST', '/api/projects/pick', { path: path.join(workspace, 'plain') })).status, 200);
  assert.equal((await call('GET', `/api/projects/browse?path=${encodeURIComponent(workspace)}`)).data.authorized, true);
  assert.equal((await call('GET', '/api/config')).data.projects.local, true);
  // The id works as a source.
  assert.equal((await call('POST', '/api/projects/inspect', { source: { mode: 'local', directoryId: ok.data.id } })).status, 200);
});

test('protected locations cannot be picked', async () => {
  for (const bad of ['/', app.cfg.dataDir, path.join(app.cfg.dataDir, 'runs')]) {
    const r = await call('POST', '/api/projects/pick', { path: bad, authorize: true });
    assert.ok([400, 404].includes(r.status), `${bad} → ${r.status}`);
  }
});

test('a proxied (non-local) request cannot browse or pick', async () => {
  for (const [m, u, b] of [['GET', '/api/projects/browse', undefined], ['POST', '/api/projects/pick', { path: workspace, authorize: true }]]) {
    const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: b ? JSON.stringify(b) : undefined });
    assert.equal(r.status, 403, u);
  }
  assert.equal((await (await fetch(`${base}/api/config`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).json()).projects.canBrowse, false);
});

test('a folder in a system location is refused with the reason', async () => {
  const r = await call('POST', '/api/projects/pick', { path: os.tmpdir(), authorize: true });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /system location|too broad/);
});
