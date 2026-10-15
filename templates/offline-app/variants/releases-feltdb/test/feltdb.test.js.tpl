// Durability: published releases are in FeltDB, read back independently of the application (a fresh FeltDB handle) and by a
// restarted application, still verifiable and still immutable; the application is the only writer of its data folder; and
// feltdb.flow is the authority for what the store holds (deployed as the active model, checked on every write, changed only
// additively).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFeltDB, parseFlowSpec, compileApplicationContract } from '@feltdb/core';
import { verifyRelease, verifyArtifactBytes } from '@distribution-protocol/protocol';
import { createApp } from '../src/app.js';
import { ReleaseStore, StoreLockedError, ConflictError } from '../src/store.js';
import { createSigner, publisherFromEnv } from '../src/signing.js';
import { loadFlow, recordCheck, FlowError, FLOW_FILE } from '../src/flow.js';
import { newPublisherPem } from './keys.js';
import { tempDir } from './helpers.js';

const pem = newPublisherPem();
const signer = () => createSigner(publisherFromEnv({ PUBLISHER_PRIVATE_KEY: pem }));

test('published releases survive a restart, read back from FeltDB independently, still verifiable and immutable', async () => {
  const dir = tempDir();
  const store = new ReleaseStore({ path: dir, signer: signer() });
  const server = createApp({ store });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const published = await store.publish({ name: 'Tool', version: '1.0.0', artifactId: 'tool', content: Buffer.from('tool v1').toString('base64') });
  const served = Buffer.from(await (await fetch(`http://127.0.0.1:${server.address().port}/api/releases/Tool/1.0.0/artifact`)).arrayBuffer());
  assert.equal(served.toString(), 'tool v1');
  await new Promise((r) => server.close(r));
  await store.close();

  // A fresh FeltDB handle, not the application's store, holds the signed release and its bytes.
  const db = createFeltDB({ namespace: 'app.{{SLUG_ID}}', mode: 'local', path: dir });
  const [record] = await db.collection('Release').all();
  assert.equal(record.id, 'Tool@1.0.0');
  assert.deepEqual(record.release, published.release);
  assert.equal(verifyRelease(record.release).valid, true);
  assert.equal(verifyArtifactBytes(Buffer.from(record.content, 'base64'), record.release.manifest.artifacts[0]), true);
  // The store's active model is exactly feltdb.flow, and the stored record is what it declares.
  const active = await db.application.get();
  const contract = await compileApplicationContract(loadFlow(), 'local', loadFlow().app);
  assert.equal(active.contract_hash, contract.hashes.application);
  const { id, __version, ...fields } = record;
  void id, void __version;
  assert.equal(recordCheck(loadFlow())('Release', fields), fields);
  await db.close();

  // A restarted application serves it, verifies it, and still refuses to publish the same version.
  const again = new ReleaseStore({ path: dir, signer: signer() });
  assert.deepEqual(await again.get('Tool', '1.0.0'), published);
  assert.deepEqual(await again.verify(published.release, Buffer.from('tool v1').toString('base64')), { valid: true, reason: null });
  await assert.rejects(again.publish({ name: 'Tool', version: '1.0.0', content: Buffer.from('other').toString('base64') }), ConflictError);
  await again.close();
});

test('the application is the only writer of its data folder', async () => {
  const dir = tempDir();
  const first = new ReleaseStore({ path: dir, signer: signer() });
  assert.throws(() => new ReleaseStore({ path: dir, signer: signer() }), StoreLockedError);
  await first.close();
  fs.writeFileSync(path.join(dir, '.writer.lock'), '999999999');
  const second = new ReleaseStore({ path: dir, signer: signer() });
  assert.deepEqual(await second.list(), []);
  await second.close();
});

test('feltdb.flow is valid by the FeltDB CLI and declares every field the store writes', () => {
  const out = execFileSync(path.join('node_modules', '.bin', 'feltdb'), ['validate', FLOW_FILE], { encoding: 'utf8', env: { ...process.env, FELTDB_TELEMETRY: '0' } });
  assert.match(out, /✓ .*1 collections/);
  const check = recordCheck(loadFlow());
  const record = { name: 'Tool', version: '1.0.0', artifactId: 'tool', mediaType: 'application/octet-stream', size: 3, publishedAt: new Date().toISOString(), release: {}, content: 'AAAA' };
  assert.equal(check('Release', record), record);
  assert.throws(() => check('Bogus', record), /collection Bogus is not declared/);
  assert.throws(() => check('Release', { ...record, owner: 'me' }), /Release\.owner is not declared/);
  assert.throws(() => check('Release', { ...record, size: '3' }), /Release\.size must be integer/);
  const { release, ...unsigned } = record;
  void release;
  assert.throws(() => check('Release', unsigned), /Release\.release is required/);
});

test('an invalid feltdb.flow is refused', () => {
  const bad = path.join(tempDir(), 'bad.flow');
  fs.writeFileSync(bad, 'flow_version 1\napp Releases {\n  collection Release {\n    size: int\n  }\n}\n');
  assert.throws(() => loadFlow(bad), FlowError);
});

test('the data model only changes additively: a destructive change is refused and the store stays closed', async () => {
  const dir = tempDir();
  const source = fs.readFileSync(FLOW_FILE, 'utf8');
  const first = new ReleaseStore({ path: dir, signer: signer() });
  await first.publish({ name: 'Tool', version: '1.0.0', content: Buffer.from('tool v1').toString('base64') });
  await first.close();
  // Removing the artifact bytes from the model would lose data: refused, and the store does not open.
  const destructive = new ReleaseStore({ path: dir, signer: signer(), flow: parseFlowSpec(source.replace(/^\s*content: text\n/m, '')) });
  await assert.rejects(destructive.ready, /could not be deployed: .*Destructive/);
  await assert.rejects(destructive.list(), FlowError);
  // An optional field is accepted as the next version of the model, and the release is still there.
  const additive = new ReleaseStore({ path: dir, signer: signer(), flow: parseFlowSpec(source.replace(/^(\s*)content: text\n/m, '$1content: text\n$1notes: text?\n')) });
  assert.equal((await additive.list()).length, 1);
  await additive.close();
});
