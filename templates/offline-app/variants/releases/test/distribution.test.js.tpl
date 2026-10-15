// Signed distribution with @distribution-protocol/protocol: what the app publishes verifies independently of the app, and a
// tampered manifest, wrong artifact bytes or a release signed by another key are rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { verifyRelease, verifyArtifactBytes, exportPublicKey } from '@distribution-protocol/protocol';
import { ReleaseStore } from '../src/store.js';
import { createSigner, publisherFromEnv } from '../src/signing.js';
import { newPublisherPem } from './keys.js';

const pem = newPublisherPem();
const store = new ReleaseStore({ signer: createSigner(publisherFromEnv({ PUBLISHER_PRIVATE_KEY: pem, PUBLISHER_ID: 'publisher://acme' })) });
const bytes = Buffer.from('release payload v1');
const published = store.publish({ name: 'Widget', version: '1.0.0', artifactId: 'widget', content: bytes.toString('base64') });

test('a published release verifies with the package itself, signed by this publisher, over the exact bytes', () => {
  const result = verifyRelease(published.release);
  assert.equal(result.valid, true, result.reason);
  assert.equal(published.release.signature.publicKey, exportPublicKey(createPublicKey(createPrivateKey(pem))));
  assert.equal(published.release.manifest.publisher.id, 'publisher://acme');
  assert.equal(verifyArtifactBytes(bytes, published.release.manifest.artifacts[0]), true);
  assert.deepEqual(store.verify(published.release, bytes.toString('base64')), { valid: true, reason: null });
});

test('a tampered manifest is rejected', () => {
  const tampered = structuredClone(published.release);
  tampered.manifest.product.version = '9.9.9';
  assert.equal(verifyRelease(tampered).valid, false);
  assert.equal(store.verify(tampered).valid, false);
});

test('wrong artifact bytes are rejected', () => {
  const wrong = Buffer.from('release payload v2');
  assert.equal(verifyArtifactBytes(wrong, published.release.manifest.artifacts[0]), false);
  assert.deepEqual(store.verify(published.release, wrong.toString('base64')), { valid: false, reason: 'artifact bytes do not match the signed digest' });
});

test('a release signed by another key is rejected, even though its own signature is valid', () => {
  const other = new ReleaseStore({ signer: createSigner(publisherFromEnv({ PUBLISHER_PRIVATE_KEY: newPublisherPem(), PUBLISHER_ID: 'publisher://acme' })) });
  const foreign = other.publish({ name: 'Widget', version: '1.0.0', artifactId: 'widget', content: bytes.toString('base64') }).release;
  assert.equal(verifyRelease(foreign).valid, true, 'the foreign signature itself is valid');
  assert.deepEqual(store.verify(foreign, bytes.toString('base64')), { valid: false, reason: 'signed by a key that is not this publisher\'s' });
});

test('garbage is not a release', () => {
  assert.equal(store.verify({ type: 'nope', manifest: {}, signature: {} }).valid, false);
});
