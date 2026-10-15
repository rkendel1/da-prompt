// Signing and verification of releases with the Distribution Protocol (@distribution-protocol/protocol). The publisher key
// comes from the environment only (PUBLISHER_PRIVATE_KEY: an Ed25519 PKCS#8 PEM) and never leaves this module: not in a
// response, a capability description, a log or the browser. Without it the app still reads and verifies; it cannot publish.
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { signRelease, verifyRelease, verifyArtifactBytes, digestOfBytes, exportPublicKey } from '@distribution-protocol/protocol';

export class SigningUnavailableError extends Error {
  constructor() {
    super('publishing is not configured: set PUBLISHER_PRIVATE_KEY (an Ed25519 PKCS#8 PEM)');
    this.name = 'SigningUnavailableError';
  }
}

/** The publisher this app signs as, from the environment (or tests). */
export function publisherFromEnv(env = process.env) {
  return {
    id: env.PUBLISHER_ID || 'publisher://{{SLUG}}',
    keyId: env.PUBLISHER_KEY_ID || 'key-1',
    privateKey: env.PUBLISHER_PRIVATE_KEY ? createPrivateKey(env.PUBLISHER_PRIVATE_KEY) : null,
  };
}

export function createSigner(publisher = publisherFromEnv()) {
  const trustedKey = publisher.privateKey ? exportPublicKey(createPublicKey(publisher.privateKey)) : null;
  return {
    canSign: Boolean(publisher.privateKey),
    /** The public key consumers pin to trust this publisher (safe to share). */
    publicKey: trustedKey,
    publisherId: publisher.id,

    /** Sign a release of `bytes` as product `name` at `version`. */
    sign({ name, version, artifactId, mediaType, bytes }) {
      if (!publisher.privateKey) throw new SigningUnavailableError();
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'product';
      const owner = publisher.id.replace(/^publisher:\/\//, '');
      return signRelease(
        {
          protocol: 'distribution/1',
          product: { id: `product://${owner}/${slug}`, name, version },
          publisher: { id: publisher.id },
          artifacts: [{ id: artifactId, mediaType, digest: digestOfBytes(bytes), size: bytes.length, target: { os: 'any', arch: 'any' } }],
          interfaces: [],
          permissions: [],
          requirements: [],
        },
        publisher.privateKey,
        { keyId: publisher.keyId },
      );
    },

    /**
     * Verify a release and, optionally, artifact bytes against it. A valid signature is not enough: the signer must be this
     * app's own publisher key (verifyRelease alone proves only that some key signed).
     */
    verify(release, bytes) {
      let result;
      try {
        result = verifyRelease(release);
      } catch (err) {
        return { valid: false, reason: `not a release: ${err.message}` };
      }
      if (!result.valid) return { valid: false, reason: result.reason || 'invalid signature' };
      if (!trustedKey) return { valid: false, reason: 'no trusted publisher key is configured' };
      if (release.signature?.publicKey !== trustedKey) return { valid: false, reason: 'signed by a key that is not this publisher\'s' };
      if (bytes !== undefined) {
        const artifact = release.manifest?.artifacts?.[0];
        if (!verifyArtifactBytes(bytes, artifact)) return { valid: false, reason: 'artifact bytes do not match the signed digest' };
      }
      return { valid: true, reason: null };
    },
  };
}
