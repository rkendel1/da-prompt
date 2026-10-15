// The application's state and rules: published releases (the signed manifest plus the artifact bytes), stored durably in
// FeltDB (@feltdb/core), the single source of truth for the HTTP API, the UI and the AppPort capabilities. Releases are signed
// when published (src/signing.js, Distribution Protocol) and immutable: the same name and version again is a conflict,
// enforced atomically by FeltDB (putIfAbsent). What a record may hold is declared in feltdb.flow; the store deploys that model
// on open and checks every record against it before writing (src/flow.js).
//
// This process is the only writer of its data folder. FeltDB 0.11.9 does not enforce a single-writer lock, so the store takes
// an exclusive lock file itself and refuses to open when a live process already holds it.
import fs from 'node:fs';
import path from 'node:path';
import { createFeltDB } from '@feltdb/core';
import { loadFlow, deployFlow, recordCheck } from './flow.js';
import { createSigner } from './signing.js';

const MAX_ARTIFACT_BYTES = 256 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ARTIFACT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NAMESPACE = 'app.{{SLUG_ID}}';
const RELEASES = 'Release'; // the collection declared in feltdb.flow

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
export class StoreLockedError extends Error {
  constructor(dir, pid) {
    super(`${dir} is in use by another running instance (pid ${pid}); only one process may write the application's data`);
    this.name = 'StoreLockedError';
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** Take <dir>/.writer.lock for this process, replacing a lock whose process is gone. Returns a release function. */
function lockDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.writer.lock');
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(file, 'utf8')) || 0;
      if (pid && alive(pid)) throw new StoreLockedError(dir, pid);
      fs.rmSync(file, { force: true }); // stale: its process is gone
    }
  }
  throw new StoreLockedError(dir, 'unknown');
}

const key = (name, version) => `${name}@${version}`;
const view = (r) => (r ? { name: r.name, version: r.version, artifactId: r.artifactId, mediaType: r.mediaType, size: r.size, publishedAt: r.publishedAt, release: r.release } : null);

export class ReleaseStore {
  constructor({ signer = createSigner(), path: dir = process.env.DATA_DIR || './data', flow = loadFlow() } = {}) {
    this.flow = flow; // an invalid feltdb.flow throws before anything is opened
    this.check = recordCheck(flow);
    this.signer = signer;
    this.dir = path.resolve(dir);
    this.release = lockDir(this.dir);
    try {
      this.db = createFeltDB({ namespace: NAMESPACE, mode: 'local', path: this.dir });
    } catch (err) {
      this.release();
      throw err;
    }
    this.items = this.db.collection(RELEASES);
    // Deploy feltdb.flow as the store's active model (also the store's first durable write, so its files exist from startup).
    // When it cannot be deployed the store closes and every call fails with that reason; the app refuses to start.
    this.ready = deployFlow(this.db, flow).catch(async (err) => {
      this.closed = true;
      await this.db.close().catch(() => {});
      this.release();
      throw err;
    });
  }

  /** Publish (sign and keep) a release. `content` is the artifact, base64-encoded. */
  async publish(input) {
    if (!input || typeof input !== 'object') throw new ValidationError('body must be a JSON object');
    const { name, version, artifactId = 'artifact', mediaType = 'application/octet-stream', content } = input;
    if (typeof name !== 'string' || !NAME.test(name)) throw new ValidationError('name must be 1-80 letters, digits, spaces, dots, dashes or underscores');
    if (typeof version !== 'string' || !VERSION.test(version)) throw new ValidationError('version must be a semantic version, e.g. 1.2.0');
    if (typeof artifactId !== 'string' || !ARTIFACT_ID.test(artifactId)) throw new ValidationError('artifactId must be a lowercase slug');
    if (typeof content !== 'string' || !content) throw new ValidationError('content (base64) is required');
    const bytes = Buffer.from(content, 'base64');
    if (!bytes.length || bytes.toString('base64') !== content.replace(/\s/g, '')) throw new ValidationError('content must be valid base64');
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new ValidationError(`the artifact must be at most ${MAX_ARTIFACT_BYTES} bytes`);
    await this.ready;
    if (await this.items.exists(key(name, version))) throw new ConflictError(`${name} ${version} is already published; releases are immutable`);
    const release = this.signer.sign({ name, version, artifactId, mediaType, bytes });
    const record = this.check(RELEASES, { name, version, artifactId, mediaType, size: bytes.length, publishedAt: new Date().toISOString(), release, content: bytes.toString('base64') });
    const { inserted } = await this.items.putIfAbsent(key(name, version), record);
    if (!inserted) throw new ConflictError(`${name} ${version} is already published; releases are immutable`);
    return view(record);
  }

  async list() {
    await this.ready;
    return (await this.items.all()).sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)).map(view);
  }

  async get(name, version) {
    await this.ready;
    return view(await this.items.get(key(name, version)));
  }

  /** The artifact bytes of a release, or null. */
  async artifact(name, version) {
    await this.ready;
    const r = await this.items.get(key(name, version));
    return r ? Buffer.from(r.content, 'base64') : null;
  }

  /** Verify a release (and optionally base64 artifact bytes) against this publisher. */
  verify(release, content) {
    return this.signer.verify(release, content === undefined ? undefined : Buffer.from(content, 'base64'));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.ready;
    } catch {
      return; // a failed open already closed the store and released its lock
    }
    try {
      await this.db.close();
    } finally {
      this.release();
    }
  }
{{STATS_METHOD}}}
