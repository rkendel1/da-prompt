// Durability: published releases are in FeltDB, read back independently of the application (a fresh FeltDB handle) and by a
// restarted application, still verifiable and still immutable; and the application is the only writer of its data folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFeltDB } from '@feltdb/core';
import { verifyRelease, verifyArtifactBytes } from '@distribution-protocol/protocol';
import { createApp } from '../src/app.js';
import { ReleaseStore, StoreLockedError, ConflictError } from '../src/store.js';
import { createSigner, publisherFromEnv } from '../src/signing.js';
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
  const [record] = await db.collection('releases').all();
  assert.equal(record.id, 'Tool@1.0.0');
  assert.deepEqual(record.release, published.release);
  assert.equal(verifyRelease(record.release).valid, true);
  assert.equal(verifyArtifactBytes(Buffer.from(record.content, 'base64'), record.release.manifest.artifacts[0]), true);
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
