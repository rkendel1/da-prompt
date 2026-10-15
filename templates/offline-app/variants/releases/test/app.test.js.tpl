import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { ReleaseStore } from '../src/store.js';
import { createSigner, publisherFromEnv } from '../src/signing.js';
import { newPublisherPem } from './keys.js';

const store = new ReleaseStore({ signer: createSigner(publisherFromEnv({ PUBLISHER_PRIVATE_KEY: newPublisherPem() })) });
const published = store.publish({ name: 'Widget', version: '1.0.0', artifactId: 'widget', content: Buffer.from('widget v1').toString('base64') });
let server;
let base;

before(async () => {
  server = createApp({ store });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const json = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('health reports the publisher and whether it can publish', async () => {
  const { status, body } = await json('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.publisher.canPublish, true);
  assert.match(body.publisher.publicKey, /^[A-Za-z0-9_-]+$/);
  assert.equal(body.releases.total, 1);
});

test('serves the web UI', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /id="releases"/);
});

test('lists releases, returns one with its signed envelope, and serves the artifact bytes', async () => {
  assert.equal((await json('GET', '/api/releases')).body.releases.length, 1);
  const one = await json('GET', '/api/releases/Widget/1.0.0');
  assert.deepEqual(one.body.release, published);
  const bytes = await (await fetch(`${base}/api/releases/Widget/1.0.0/artifact`)).text();
  assert.equal(bytes, 'widget v1');
  assert.equal((await json('GET', '/api/releases/Widget/9.9.9')).status, 404);
});

test('anyone can verify a release and bytes; publishing is not possible over plain HTTP', async () => {
  const ok = await json('POST', '/api/verify', { release: published.release, content: Buffer.from('widget v1').toString('base64') });
  assert.deepEqual(ok.body, { valid: true, reason: null });
  const wrong = await json('POST', '/api/verify', { release: published.release, content: Buffer.from('evil').toString('base64') });
  assert.equal(wrong.body.valid, false);
  assert.equal((await json('POST', '/api/releases', { name: 'x', version: '1.0.0', content: 'eA==' })).status, 405);
  assert.equal((await json('POST', '/api/verify', {})).status, 400);
});

test('static file serving cannot escape the public folder', async () => {
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
});
