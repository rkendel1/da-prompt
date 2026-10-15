// Durability: what the application writes is in FeltDB, read back independently of the application (a fresh FeltDB handle on
// the same folder) and by a restarted application; the application is the only writer of its data folder; and feltdb.flow is
// the authority for what the store holds (deployed as the active model, checked on every write, changed only additively).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFeltDB, parseFlowSpec, compileApplicationContract } from '@feltdb/core';
import { createApp } from '../src/app.js';
import { ItemStore, StoreLockedError } from '../src/store.js';
import { loadFlow, recordCheck, FlowError, FLOW_FILE } from '../src/flow.js';
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
  const records = await db.collection('Item').all();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, item.id);
  assert.equal(records[0].title, 'Durable thing');
  assert.equal(records[0].done, true);
  // The store's active model is exactly feltdb.flow.
  const active = await db.application.get();
  const contract = await compileApplicationContract(loadFlow(), 'local', loadFlow().app);
  assert.equal(active.contract_hash, contract.hashes.application);
  assert.equal(active.version, 1);
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

test('feltdb.flow is valid by the FeltDB CLI and declares every collection and field the store writes', () => {
  const out = execFileSync(path.join('node_modules', '.bin', 'feltdb'), ['validate', FLOW_FILE], { encoding: 'utf8', env: { ...process.env, FELTDB_TELEMETRY: '0' } });
  assert.match(out, /✓ .*1 collections/);
  const check = recordCheck(loadFlow());
  const now = new Date().toISOString();
  const item = { id: 'x', title: 't', notes: '', done: false, createdAt: now, updatedAt: now };
  assert.equal(check('Item', item), item);
  assert.throws(() => check('Bogus', item), /collection Bogus is not declared/);
  assert.throws(() => check('Item', { ...item, owner: 'me' }), /Item\.owner is not declared/);
  assert.throws(() => check('Item', { ...item, done: 'yes' }), /Item\.done must be boolean/);
  const { title, ...untitled } = item;
  void title;
  assert.throws(() => check('Item', untitled), /Item\.title is required/);
});

test('an invalid feltdb.flow stops the store before it opens anything', () => {
  const dir = tempDir();
  const bad = path.join(dir, 'bad.flow');
  fs.writeFileSync(bad, 'flow_version 1\napp Tracker {\n  collection Item {\n    title: string\n  }\n}\n');
  assert.throws(() => loadFlow(bad), FlowError);
  fs.writeFileSync(bad, 'app Tracker {\n  table Item {}\n}\n');
  assert.throws(() => loadFlow(bad), /cannot be read/);
});

test('the data model only changes additively: a destructive change is refused and the store stays closed', async () => {
  const dir = tempDir();
  const source = fs.readFileSync(FLOW_FILE, 'utf8');
  const first = new ItemStore({ path: dir });
  await first.create({ title: 'kept' });
  await first.close();
  // Removing a field would lose data: FeltDB refuses the deployment, the store does not open and releases its lock.
  const destructive = new ItemStore({ path: dir, flow: parseFlowSpec(source.replace(/^\s*notes: text\n/m, '')) });
  await assert.rejects(destructive.ready, /could not be deployed: .*Destructive/);
  await assert.rejects(destructive.list(), FlowError);
  // Adding an optional field is accepted as the next version of the model.
  const additive = new ItemStore({ path: dir, flow: parseFlowSpec(source.replace(/^(\s*)done: boolean\n/m, '$1done: boolean\n$1tag: text?\n')) });
  assert.equal((await additive.list()).length, 1);
  await additive.close();
  const db = createFeltDB({ namespace: 'app.{{SLUG_ID}}', mode: 'local', path: dir });
  assert.equal((await db.application.get()).version, 2);
  await db.close();
});
