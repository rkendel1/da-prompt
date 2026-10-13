import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir, waitFor } from './helpers.js';
import { createServer } from '../src/server.js';

let app;
let base;
before(async () => {
  app = await createServer({ dataDir: tmpDir(), defaultProvider: 'offline' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('serves the UI, config and prompt', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /da-prompt/);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.layers.length, 7);
  const prompt = await (await fetch(`${base}/api/prompt?idea=Hello`)).json();
  assert.match(prompt.rendered, /Turn Hello into/);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});

test('full run over HTTP: create, stream events, browse files, preview, download', async () => {
  const res = await post('/api/runs', { idea: 'A shared reading list for book clubs' });
  assert.equal(res.status, 201);
  const { run } = await res.json();

  const done = await waitFor(async () => {
    const r = (await (await fetch(`${base}/api/runs/${run.id}`)).json()).run;
    return ['completed', 'needs_attention', 'failed'].includes(r.status) && !r.executing ? r : null;
  });
  assert.equal(done.status, 'completed');
  assert.equal(done.previewLive, true);

  // SSE replays the record of work.
  const ctrl = new AbortController();
  const sse = await fetch(`${base}/api/runs/${run.id}/events`, { signal: ctrl.signal });
  const reader = sse.body.getReader();
  let text = '';
  while (!text.includes('"type":"deliver"')) text += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  assert.match(text, /"type":"plan"/);

  const { files } = await (await fetch(`${base}/api/runs/${run.id}/files`)).json();
  for (const f of ['README.md', 'src/app.js', 'test/app.test.js', 'CLAUDE.md', 'PLAN.md']) assert.ok(files.some((x) => x.path === f), f);
  const readme = await (await fetch(`${base}/api/runs/${run.id}/files?path=README.md`)).json();
  assert.match(readme.content, /## API/);
  assert.equal((await fetch(`${base}/api/runs/${run.id}/files?path=../../run.json`)).status, 404);

  // Preview proxy reaches the deployed app.
  assert.equal((await fetch(`${base}/preview/${run.id}`, { redirect: 'manual' })).status, 308);
  const health = await (await fetch(`${base}/preview/${run.id}/api/health`)).json();
  assert.equal(health.ok, true);

  const dl = await fetch(`${base}/api/runs/${run.id}/download/project.tar.gz`);
  assert.equal(dl.status, 200);
  assert.ok((await dl.arrayBuffer()).byteLength > 1000);
  assert.match(await (await fetch(`${base}/api/runs/${run.id}/report`)).text(), /Completion checklist/);

  const list = await (await fetch(`${base}/api/runs`)).json();
  assert.equal(list.runs[0].id, run.id);

  assert.equal((await fetch(`${base}/api/runs/${run.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/runs/${run.id}`)).status, 404);
});

test('validation and not-found errors', async () => {
  assert.equal((await post('/api/runs', {})).status, 400);
  assert.equal((await fetch(`${base}/api/runs/nope-123456`)).status, 404);
  assert.equal((await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 400);
});

test('FACTORY_PASSWORD enables basic auth', async () => {
  const locked = await createServer({ dataDir: tmpDir(), password: 'hunter2hunter2' });
  await new Promise((r) => locked.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${locked.server.address().port}`;
  assert.equal((await fetch(`${url}/api/runs`)).status, 401);
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  const ok = await fetch(`${url}/api/runs`, { headers: { authorization: `Basic ${Buffer.from('x:hunter2hunter2').toString('base64')}` } });
  assert.equal(ok.status, 200);
  await locked.close();
});

test('providers API: discovery, add, update without leaking keys, remove', async () => {
  const d = await (await fetch(`${base}/api/providers`)).json();
  assert.ok(d.providers.find((p) => p.id === 'offline').status === 'ready');
  assert.ok(d.providers.some((p) => p.id === 'ollama'));
  const bad = await post('/api/providers', { label: 'x', baseUrl: 'not a url at all' });
  assert.equal(bad.status, 400);
  const added = await post('/api/providers', { label: 'My Gateway', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-secret-abcdefghijklmnop' });
  assert.equal(added.status, 201);
  const { provider } = await added.json();
  assert.equal(provider.status, 'unreachable');
  assert.equal(provider.hasKey, true);
  assert.equal(provider.keyHint, undefined, 'not even a fragment of a saved key is returned');
  assert.ok(!JSON.stringify(provider).includes('mnop'));
  const patched = await fetch(`${base}/api/providers/my-gateway`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toolMode: 'json' }) });
  assert.equal((await patched.json()).provider.toolMode, 'json');
  const all = await (await fetch(`${base}/api/providers`)).text();
  assert.ok(!all.includes('sk-secret'));
  assert.equal((await fetch(`${base}/api/providers/my-gateway`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/providers/my-gateway`)).status, 404);
});
