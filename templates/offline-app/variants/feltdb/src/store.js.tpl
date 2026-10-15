// The application's state and rules. Items live in FeltDB (@feltdb/core), the single durable source of truth for the HTTP
// API, the UI and the AppPort capabilities alike: there is no in-memory copy and no cache.
//
// This process is the only writer of its data folder. FeltDB 0.11.9 does not enforce a single-writer lock (a second process's
// write was observed to succeed), so the store takes an exclusive lock file itself and refuses to open when a live process
// already holds it.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFeltDB } from '@feltdb/core';

const MAX_TITLE = 200;
const MAX_NOTES = 2000;
const SCHEMA_VERSION = 1;
const NAMESPACE = 'app.{{SLUG_ID}}';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class StoreLockedError extends Error {
  constructor(dir, pid) {
    super(`${dir} is in use by another running instance (pid ${pid}); only one process may write the application's data`);
    this.name = 'StoreLockedError';
  }
}

function clean(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('body must be a JSON object');
  const out = {};
  if (!partial || 'title' in input) {
    if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('title is required');
    if (input.title.length > MAX_TITLE) throw new ValidationError(`title must be at most ${MAX_TITLE} characters`);
    out.title = input.title.trim();
  }
  if ('notes' in input) {
    if (typeof input.notes !== 'string') throw new ValidationError('notes must be a string');
    if (input.notes.length > MAX_NOTES) throw new ValidationError(`notes must be at most ${MAX_NOTES} characters`);
    out.notes = input.notes.trim();
  }
  if ('done' in input) {
    if (typeof input.done !== 'boolean') throw new ValidationError('done must be a boolean');
    out.done = input.done;
  }
  return out;
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

// FeltDB adds bookkeeping fields (__version); the application's items do not include them.
const plain = (record) => {
  if (!record) return null;
  const { id, title, notes, done, createdAt, updatedAt } = record;
  return { id, title, notes, done, createdAt, updatedAt };
};

/** Durable item store over FeltDB. `path` defaults to DATA_DIR (or ./data). Call close() to flush and release the lock. */
export class ItemStore {
  constructor({ path: dir = process.env.DATA_DIR || './data' } = {}) {
    this.dir = path.resolve(dir);
    this.release = lockDir(this.dir);
    try {
      this.db = createFeltDB({ namespace: NAMESPACE, mode: 'local', path: this.dir });
    } catch (err) {
      this.release();
      throw err;
    }
    this.items = this.db.collection('items');
    // Version the store on open; this is also the store's first durable write, so its files exist from startup.
    this.ready = this.db.collection('app_meta').put({ version: SCHEMA_VERSION }, 'schema');
  }

  async list() {
    await this.ready;
    return (await this.items.all()).map(plain).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id) {
    await this.ready;
    return plain(await this.items.get(id));
  }

  async create(input) {
    const data = clean(input);
    await this.ready;
    const now = new Date().toISOString();
    const item = { id: randomUUID(), title: data.title, notes: data.notes || '', done: data.done ?? false, createdAt: now, updatedAt: now };
    await this.items.insert(item, item.id);
    return plain(await this.items.get(item.id));
  }

  async update(id, input) {
    const data = clean(input, { partial: true });
    await this.ready;
    if (!(await this.items.exists(id))) return null;
    await this.items.update(id, { ...data, updatedAt: new Date().toISOString() });
    return plain(await this.items.get(id));
  }

  async remove(id) {
    await this.ready;
    if (!(await this.items.exists(id))) return false;
    await this.items.delete(id);
    return true;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.ready;
      await this.db.close();
    } finally {
      this.release();
    }
  }
{{STATS_METHOD}}}
