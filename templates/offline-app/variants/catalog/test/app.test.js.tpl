import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { EntryStore, SEED } from '../src/store.js';

let server;
let base;

before(async () => {
  server = createApp({ store: new EntryStore() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('health endpoint reports ok', async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.entries.total, SEED.length);
});

test('serves the web UI', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<form id="search"/);
});

test('search by text and by category, and list categories', async () => {
  const all = await get('/api/entries');
  assert.equal(all.body.total, SEED.length);
  const guides = await get('/api/entries?category=guides');
  assert.ok(guides.body.entries.length > 0 && guides.body.entries.every((e) => e.category === 'guides'));
  const text = await get('/api/entries?q=GLOSSARY');
  assert.deepEqual(text.body.entries.map((e) => e.id), ['glossary']);
  assert.deepEqual((await get('/api/categories')).body.categories, ['basics', 'guides', 'reference']);
  assert.equal((await get(`/api/entries?q=${'x'.repeat(101)}`)).status, 400);
});

test('get one entry; unknown ids and routes return 404', async () => {
  const { status, body } = await get('/api/entries/faq');
  assert.equal(status, 200);
  assert.equal(body.entry.id, 'faq');
  assert.equal((await get('/api/entries/missing')).status, 404);
  assert.equal((await get('/api/nope')).status, 404);
});

test('the catalog is read-only: writes are refused with 405', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await fetch(`${base}/api/entries/faq`, { method });
    assert.equal(res.status, 405, method);
  }
  assert.equal((await get('/api/entries')).body.total, SEED.length);
});

test('static file serving cannot escape the public folder', async () => {
  const res = await fetch(`${base}/..%2fpackage.json`);
  assert.equal(res.status, 404);
});
