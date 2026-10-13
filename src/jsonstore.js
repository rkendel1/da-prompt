// A small durable JSON document: one file, atomic writes (temp file + rename, mode 0600), one in-process lock so
// read-modify-write cycles cannot interleave. The backend is the single writer for its data directory (the server
// record enforces one backend per data dir), so a process-local lock is the right granularity. A corrupt file is set
// aside, never silently overwritten.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class JsonStore {
  constructor(file, initial) {
    this.file = file;
    this.initial = initial;
    this.queue = Promise.resolve();
    this.cache = null;
  }

  async load() {
    if (this.cache) return this.cache;
    let data = this.initial();
    try {
      const parsed = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') data = { ...data, ...parsed };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        try { await fsp.rename(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
    }
    this.cache = data;
    return data;
  }

  /** Read without modifying. The returned object must not be mutated. */
  async read() {
    await this.queue;
    return this.load();
  }

  /** Run `fn(draft)` exclusively against a copy; persist the copy atomically if `fn` returns without throwing. */
  mutate(fn) {
    const run = this.queue.then(async () => {
      const data = await this.load();
      const draft = JSON.parse(JSON.stringify(data));
      const result = await fn(draft);
      await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(draft, null, 2), { mode: 0o600 });
      await fsp.rename(tmp, this.file);
      this.cache = draft;
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
