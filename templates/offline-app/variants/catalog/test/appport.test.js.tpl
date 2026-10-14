// The AppPort capability boundary, exercised through the published client exactly as an agent would use it: discovery from
// the origin, invocation over HTTP, and every answer checked against the catalog's own state (the store and the HTTP API).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AppPort } from '@appport/client';
import { createHttpTransport } from '@appport/transport-http';
import { createApp } from '../src/app.js';
import { EntryStore } from '../src/store.js';

const TOKEN = 'test-reader-token-9w2h6c';
const store = new EntryStore();
let server;
let base;

before(async () => {
  server = createApp({ store, tokens: [{ token: TOKEN, role: 'read' }] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const connect = (token) => AppPort.discover({ origin: base, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), transports: { http: (o) => createHttpTransport(o) } });
const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code);
const rest = async (path) => (await fetch(base + path)).json();

test('capabilities are discoverable, and every one is a read: the catalog exposes no write', async () => {
  const manifest = await (await fetch(`${base}/appport/manifest`)).json();
  const own = manifest.capabilities.filter((c) => !c.name.startsWith('appport.'));
  assert.deepEqual(own.map((c) => [c.name, c.effect, c.authorizationContract.required, c.authorizationContract.scopes]).sort(), [
    ['entries.categories', 'observation', true, ['entries.read']],
    ['entries.get', 'observation', true, ['entries.read']],
    ['entries.search', 'observation', true, ['entries.read']],
  ]);
  for (const c of own) assert.ok(c.description && c.definitions[0].inputSchema && c.definitions[0].outputSchema, c.name);
  assert.ok(!JSON.stringify(manifest).includes(TOKEN), 'no credential in the manifest');
});

test('results are the store\'s and match the HTTP API', async () => {
  const app = await connect(TOKEN);
  const all = await app.call('entries.search', {});
  assert.deepEqual(all.entries, store.search({}));
  assert.deepEqual(all, await rest('/api/entries'));
  const guides = await app.call('entries.search', { category: 'guides' });
  assert.deepEqual(guides, await rest('/api/entries?category=guides'));
  const text = await app.call('entries.search', { query: 'glossary' });
  assert.deepEqual(text.entries, store.search({ query: 'glossary' }));
  assert.deepEqual((await app.call('entries.get', { id: 'faq' })).entry, store.get('faq'));
  assert.deepEqual(await app.call('entries.categories', {}), await rest('/api/categories'));
});

test('the store\'s rules apply: invalid input and unknown ids are refused', async () => {
  const app = await connect(TOKEN);
  await rejects(app.call('entries.search', { query: 'x'.repeat(101) }), 'INVALID_INPUT');
  await rejects(app.call('entries.get', { id: 'missing' }), 'NOT_FOUND');
});

test('unauthenticated callers are refused', async () => {
  const anon = await connect();
  await rejects(anon.call('entries.search', {}), 'UNAUTHORIZED');
  const wrong = await connect('not-a-real-token-3j7v');
  await rejects(wrong.call('entries.get', { id: 'faq' }), 'UNAUTHORIZED');
});

test('there is no write capability to call, and the data is unchanged', async () => {
  const app = await connect(TOKEN);
  const before = JSON.stringify(store.search({}));
  await assert.rejects(app.call('entries.create', { id: 'x', name: 'x', category: 'x', description: 'x' }), (e) => ['UNKNOWN_CAPABILITY', 'FORBIDDEN'].includes(e.code));
  assert.equal(JSON.stringify(store.search({})), before);
});

test('with no token configured nobody can call a capability (fail closed)', async () => {
  const closed = createApp({ store: new EntryStore(), tokens: [] });
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  try {
    const app = await AppPort.discover({ origin: `http://127.0.0.1:${closed.address().port}`, headers: { authorization: 'Bearer anything' }, transports: { http: (o) => createHttpTransport(o) } });
    await rejects(app.call('entries.search', {}), 'UNAUTHORIZED');
  } finally {
    await new Promise((r) => closed.close(r));
  }
});
