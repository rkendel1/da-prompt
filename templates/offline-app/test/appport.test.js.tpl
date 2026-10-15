// The AppPort capability boundary, exercised through the published client exactly as an agent would use it: discovery from
// the origin, invocation over HTTP, and every answer checked against the application's own state (the store and the HTTP API).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AppPort } from '@appport/client';
import { createHttpTransport } from '@appport/transport-http';
import { createApp } from '../src/app.js';
import { ItemStore } from '../src/store.js';
import { tempDir } from './helpers.js';

const FULL = 'test-full-token-7f3k9q';
const READ = 'test-read-token-2m8x4w';
const store = new ItemStore({ path: tempDir() });
let server;
let base;

before(async () => {
  server = createApp({ store, tokens: [{ token: FULL, role: 'full' }, { token: READ, role: 'read' }] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await store.close();
});

const connect = (token) => AppPort.discover({ origin: base, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), transports: { http: (o) => createHttpTransport(o) } });
const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code);
const restItems = async () => (await (await fetch(`${base}/api/items`)).json()).items;

test('capabilities are discoverable, with schemas, effects and permissions, and only the opted-in ones exist', async () => {
  const manifest = await (await fetch(`${base}/appport/manifest`)).json();
  const own = manifest.capabilities.filter((c) => !c.name.startsWith('appport.'));
  assert.deepEqual(own.map((c) => [c.name, c.effect, c.authorizationContract.required, c.authorizationContract.scopes]).sort(), [
    ['items.create', 'consequential', true, ['items.write']],
    ['items.get', 'observation', true, ['items.read']],
    ['items.list', 'observation', true, ['items.read']],
    ['items.update', 'consequential', true, ['items.write']],
  ]);
  for (const c of own) assert.ok(c.description && c.definitions[0].inputSchema && c.definitions[0].outputSchema, c.name);
  assert.ok(!JSON.stringify(manifest).includes(FULL) && !JSON.stringify(manifest).includes(READ), 'no credential in the manifest');
  const wellKnown = await (await fetch(`${base}/.well-known/appport`)).json();
  assert.deepEqual(wellKnown.transports, [{ kind: 'http', endpoint: '/appport' }]);
});

test('reads and writes go through the store: results match the HTTP API and the store itself', async () => {
  const app = await connect(FULL);
  const { item } = await app.call('items.create', { title: '  Ship it  ', notes: 'from an agent' });
  assert.equal(item.title, 'Ship it', 'the store\'s own validation (trim) applied');
  assert.deepEqual((await store.get(item.id)), item, 'the store holds exactly what the capability returned');
  assert.deepEqual((await restItems()).find((i) => i.id === item.id), item, 'and the HTTP API sees it');

  const updated = await app.call('items.update', { id: item.id, done: true });
  assert.equal(updated.item.done, true);
  assert.equal((await store.get(item.id)).done, true);

  // A change made through the HTTP API is what the capability reads.
  const viaRest = await (await fetch(`${base}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'from the UI' }) })).json();
  const listed = await app.call('items.list', {});
  assert.deepEqual(listed.items, (await store.list()));
  assert.ok(listed.items.some((i) => i.id === viaRest.item.id));
  assert.deepEqual((await app.call('items.get', { id: item.id })).item, (await store.get(item.id)));
});

test('the store\'s rules apply to capabilities: invalid input and unknown ids are refused, nothing changes', async () => {
  const app = await connect(FULL);
  const before = JSON.stringify((await store.list()));
  await rejects(app.call('items.create', { title: 'x'.repeat(201) }), 'INVALID_INPUT');
  await rejects(app.call('items.create', { title: '' }), 'INVALID_INPUT');
  await rejects(app.call('items.get', { id: 'missing' }), 'NOT_FOUND');
  await rejects(app.call('items.update', { id: 'missing', done: true }), 'NOT_FOUND');
  assert.equal(JSON.stringify((await store.list())), before);
});

test('unauthenticated and under-privileged callers are refused, and the state is unchanged', async () => {
  const before = JSON.stringify((await store.list()));
  const anon = await connect();
  await rejects(anon.call('items.list', {}), 'UNAUTHORIZED');
  await rejects(anon.call('items.create', { title: 'sneaky' }), 'UNAUTHORIZED');
  const wrong = await connect('not-a-real-token-5d1p');
  await rejects(wrong.call('items.create', { title: 'sneaky' }), 'UNAUTHORIZED');
  const reader = await connect(READ);
  assert.ok(Array.isArray((await reader.call('items.list', {})).items), 'a read token can read');
  await rejects(reader.call('items.create', { title: 'sneaky' }), 'FORBIDDEN');
  assert.equal(JSON.stringify((await store.list())), before);
});

test('operations that are not opted in are not exposed: deleting is not a capability', async () => {
  const app = await connect(FULL);
  const before = (await store.list()).length;
  await assert.rejects(app.call('items.remove', { id: (await store.list())[0].id }), (e) => ['UNKNOWN_CAPABILITY', 'FORBIDDEN'].includes(e.code));
  assert.equal((await store.list()).length, before);
});

test('with no token configured nobody can call a capability (fail closed)', async () => {
  const closedStore = new ItemStore({ path: tempDir() });
  const closed = createApp({ store: closedStore, tokens: [] });
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  try {
    const app = await AppPort.discover({ origin: `http://127.0.0.1:${closed.address().port}`, headers: { authorization: 'Bearer anything' }, transports: { http: (o) => createHttpTransport(o) } });
    await rejects(app.call('items.list', {}), 'UNAUTHORIZED');
  } finally {
    await new Promise((r) => closed.close(r));
    await closedStore.close();
  }
});
