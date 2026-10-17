import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { ItemStore } from '../src/store.js';

let server;
let base;

before(async () => {
  server = createApp({ store: new ItemStore() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const json = (method, path, body) =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('health endpoint reports ok', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.items, { total: 0, done: 0 });
});

test('serves the web UI', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<form id="new-item"/);
});

test('create, read, update, delete an item', async () => {
  const created = await json('POST', '/api/items', { title: '  First thing  ', notes: 'details' });
  assert.equal(created.status, 201);
  const { item } = await created.json();
  assert.equal(item.title, 'First thing');
  assert.equal(item.done, false);

  const list = await (await fetch(`${base}/api/items`)).json();
  assert.equal(list.items.length, 1);

  const patched = await json('PATCH', `/api/items/${item.id}`, { done: true });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).item.done, true);

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.deepEqual(health.items, { total: 1, done: 1 });

  assert.equal((await json('DELETE', `/api/items/${item.id}`)).status, 204);
  assert.equal((await fetch(`${base}/api/items/${item.id}`)).status, 404);
});

test('rejects invalid input with 400', async () => {
  assert.equal((await json('POST', '/api/items', { title: '' })).status, 400);
  assert.equal((await json('POST', '/api/items', { title: 'x'.repeat(201) })).status, 400);
  assert.equal((await json('POST', '/api/items', { title: 'ok', done: 'yes' })).status, 400);
  const bad = await fetch(`${base}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
});

test('unknown ids and routes return 404, wrong methods 405', async () => {
  assert.equal((await json('PATCH', '/api/items/missing', { done: true })).status, 404);
  assert.equal((await json('DELETE', '/api/items/missing')).status, 404);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await json('PUT', '/api/items', {})).status, 405);
});

test('static file serving cannot escape the public folder', async () => {
  const res = await fetch(`${base}/..%2fpackage.json`);
  assert.equal(res.status, 404);
});
