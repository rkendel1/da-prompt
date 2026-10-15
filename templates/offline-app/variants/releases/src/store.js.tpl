// The application's state and rules: published releases (the signed manifest plus the artifact bytes), held in memory.
// Every release is signed when it is published; a release is immutable (publishing the same name and version again is a
// conflict). The HTTP API, the UI and the AppPort capabilities all go through this store.
import { createSigner } from './signing.js';

const MAX_ARTIFACT_BYTES = 256 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ARTIFACT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}
export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

const key = (name, version) => `${name}@${version}`;
const view = (r) => (r ? { name: r.name, version: r.version, artifactId: r.artifactId, mediaType: r.mediaType, size: r.size, publishedAt: r.publishedAt, release: r.release } : null);

export class ReleaseStore {
  constructor({ signer = createSigner() } = {}) {
    this.signer = signer;
    this.items = new Map();
  }

  /** Publish (sign and keep) a release. `content` is the artifact, base64-encoded. */
  publish(input) {
    if (!input || typeof input !== 'object') throw new ValidationError('body must be a JSON object');
    const { name, version, artifactId = 'artifact', mediaType = 'application/octet-stream', content } = input;
    if (typeof name !== 'string' || !NAME.test(name)) throw new ValidationError('name must be 1-80 letters, digits, spaces, dots, dashes or underscores');
    if (typeof version !== 'string' || !VERSION.test(version)) throw new ValidationError('version must be a semantic version, e.g. 1.2.0');
    if (typeof artifactId !== 'string' || !ARTIFACT_ID.test(artifactId)) throw new ValidationError('artifactId must be a lowercase slug');
    if (typeof content !== 'string' || !content) throw new ValidationError('content (base64) is required');
    const bytes = Buffer.from(content, 'base64');
    if (!bytes.length || bytes.toString('base64') !== content.replace(/\s/g, '')) throw new ValidationError('content must be valid base64');
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new ValidationError(`the artifact must be at most ${MAX_ARTIFACT_BYTES} bytes`);
    if (this.items.has(key(name, version))) throw new ConflictError(`${name} ${version} is already published; releases are immutable`);
    const release = this.signer.sign({ name, version, artifactId, mediaType, bytes });
    const record = { name, version, artifactId, mediaType, size: bytes.length, publishedAt: new Date().toISOString(), release, bytes };
    this.items.set(key(name, version), record);
    return view(record);
  }

  list() {
    return [...this.items.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)).map(view);
  }

  get(name, version) {
    return view(this.items.get(key(name, version)));
  }

  /** The artifact bytes of a release, or null. */
  artifact(name, version) {
    return this.items.get(key(name, version))?.bytes || null;
  }

  /** Verify a release (and optionally base64 artifact bytes) against this publisher. */
  verify(release, content) {
    return this.signer.verify(release, content === undefined ? undefined : Buffer.from(content, 'base64'));
  }

  close() {}
{{STATS_METHOD}}}
