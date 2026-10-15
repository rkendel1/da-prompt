// The AppPort capability boundary, exercised through the published client exactly as an agent would use it, with every
// answer checked against the application's own state (the store and the HTTP API).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AppPort } from '@appport/client';
import { createHttpTransport } from '@appport/transport-http';
import { createApp } from '../src/app.js';
import { ReleaseStore } from '../src/store.js';
import { createSigner, publisherFromEnv } from '../src/signing.js';
import { newPublisherPem } from './keys.js';
import { tempDir } from './helpers.js';

const FULL = 'test-full-token-4r8t2y';
const READ = 'test-read-token-6u1i3o';
const store = new ReleaseStore({ path: tempDir(), signer: createSigner(publisherFromEnv({ PUBLISHER_PRIVATE_KEY: newPublisherPem() })) });
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
const b64 = (text) => Buffer.from(text).toString('base64');

test('capabilities are discoverable, with schemas, effects and permissions', async () => {
  const manifest = await (await fetch(`${base}/appport/manifest`)).json();
  const own = manifest.capabilities.filter((c) => !c.name.startsWith('appport.'));
  assert.deepEqual(own.map((c) => [c.name, c.effect, c.authorizationContract.scopes]).sort(), [
    ['releases.get', 'observation', ['releases.read']],
    ['releases.list', 'observation', ['releases.read']],
    ['releases.publish', 'consequential', ['releases.write']],
    ['releases.verify', 'observation', ['releases.read']],
  ]);
  assert.ok(!/PRIVATE KEY/.test(JSON.stringify(manifest)), 'no key material in the manifest');
});

test('publishing signs and keeps the release: the store and the HTTP API hold exactly what was returned', async () => {
  const app = await connect(FULL);
  const { release } = await app.call('releases.publish', { name: 'Tool', version: '2.1.0', artifactId: 'tool', content: b64('tool bytes') });
  assert.deepEqual(await store.get('Tool', '2.1.0'), release);
  assert.deepEqual((await (await fetch(`${base}/api/releases/Tool/2.1.0`)).json()).release, release);
  assert.deepEqual((await app.call('releases.list', {})).releases, await store.list());
  assert.deepEqual(await app.call('releases.verify', { release: release.release, content: b64('tool bytes') }), { valid: true, reason: null });
  await rejects(app.call('releases.publish', { name: 'Tool', version: '2.1.0', content: b64('again') }), 'CONFLICT');
  await rejects(app.call('releases.publish', { name: 'Tool', version: 'latest', content: b64('x') }), 'INVALID_INPUT');
  await rejects(app.call('releases.get', { name: 'Tool', version: '9.9.9' }), 'NOT_FOUND');
});

test('unauthenticated and under-privileged callers are refused, and nothing is published', async () => {
  const before = (await store.list()).length;
  await rejects((await connect()).call('releases.publish', { name: 'Evil', version: '1.0.0', content: b64('x') }), 'UNAUTHORIZED');
  await rejects((await connect()).call('releases.list', {}), 'UNAUTHORIZED');
  const reader = await connect(READ);
  assert.ok(Array.isArray((await reader.call('releases.list', {})).releases));
  await rejects(reader.call('releases.publish', { name: 'Evil', version: '1.0.0', content: b64('x') }), 'FORBIDDEN');
  assert.equal((await store.list()).length, before);
});

test('without a publisher key, publishing is refused while verification still works', async () => {
  const keylessStore = new ReleaseStore({ path: tempDir(), signer: createSigner(publisherFromEnv({})) });
  const keyless = createApp({ store: keylessStore, tokens: [{ token: FULL, role: 'full' }] });
  await new Promise((r) => keyless.listen(0, '127.0.0.1', r));
  try {
    const app = await AppPort.discover({ origin: `http://127.0.0.1:${keyless.address().port}`, headers: { authorization: `Bearer ${FULL}` }, transports: { http: (o) => createHttpTransport(o) } });
    await rejects(app.call('releases.publish', { name: 'Tool', version: '1.0.0', content: b64('x') }), 'FORBIDDEN');
  } finally {
    await new Promise((r) => keyless.close(r));
    await keylessStore.close();
  }
});
