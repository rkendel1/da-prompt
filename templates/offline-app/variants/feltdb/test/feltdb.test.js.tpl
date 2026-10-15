// Durability: what the application writes is in FeltDB, read back independently of the application (a fresh FeltDB handle on
// the same folder) and by a restarted application; and the application is the only writer of its data folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFeltDB } from '@feltdb/core';
import { createApp } from '../src/app.js';
import { ItemStore, StoreLockedError } from '../src/store.js';
import { tempDir } from './helpers.js';

async function serve(store) {
  const server = createApp({ store });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.status === 204 ? null : res.json();
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test('writes survive a restart and are read back from FeltDB independently of the application', async () => {
  const dir = tempDir();
  const store = new ItemStore({ path: dir });
  const app = await serve(store);
  const { item } = await app.call('POST', '/api/items', { title: 'Durable thing', notes: 'kept' });
  await app.call('PATCH', `/api/items/${item.id}`, { done: true });
  const gone = (await app.call('POST', '/api/items', { title: 'Deleted later' })).item;
  await app.call('DELETE', `/api/items/${gone.id}`);
  await app.close();
  await store.close();

  // A fresh FeltDB handle, not the application's store, sees exactly the application's state.
  const db = createFeltDB({ namespace: 'app.{{SLUG_ID}}', mode: 'local', path: dir });
  const records = await db.collection('items').all();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, item.id);
  assert.equal(records[0].title, 'Durable thing');
  assert.equal(records[0].done, true);
  assert.equal((await db.collection('app_meta').get('schema')).version, 1);
  await db.close();

  // A restarted application serves the same state.
  const again = new ItemStore({ path: dir });
  const app2 = await serve(again);
  const listed = (await app2.call('GET', '/api/items')).items;
  assert.deepEqual(listed.map((i) => [i.id, i.title, i.done]), [[item.id, 'Durable thing', true]]);
  assert.ok(!('__version' in listed[0]), 'FeltDB bookkeeping is not part of the API');
  await app2.close();
  await again.close();
});

test('the application is the only writer of its data folder', async () => {
  const dir = tempDir();
  const first = new ItemStore({ path: dir });
  assert.throws(() => new ItemStore({ path: dir }), StoreLockedError, 'a second instance is refused while the first runs');
  await first.close();
  const second = new ItemStore({ path: dir });
  await second.create({ title: 'after the first closed' });
  await second.close();
  // A lock left by a process that no longer exists is replaced.
  fs.writeFileSync(path.join(dir, '.writer.lock'), '999999999');
  const third = new ItemStore({ path: dir });
  assert.equal((await third.list()).length, 1);
  await third.close();
});
