import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/** File-backed persistence for runs: run.json (state), events.jsonl (record of work), workspace/, delivery/. */
export class RunStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'runs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(0);
    this.seq = new Map();
    this.writeChains = new Map();
  }

  newId() {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  }

  runDir(id) {
    if (!/^[0-9a-z-]+$/i.test(id)) throw new Error('invalid run id');
    return path.join(this.dir, id);
  }
  workspaceDir(id) {
    return path.join(this.runDir(id), 'workspace');
  }
  /** Factory notes (plan, lessons) for runs against existing projects: never written into the project. */
  notesDir(id) {
    return path.join(this.runDir(id), 'notes');
  }
  deliveryDir(id) {
    return path.join(this.runDir(id), 'delivery');
  }

  exists(id) {
    try {
      return fs.existsSync(path.join(this.runDir(id), 'run.json'));
    } catch {
      return false;
    }
  }

  async create(run) {
    await fsp.mkdir(this.workspaceDir(run.id), { recursive: true });
    await fsp.mkdir(this.deliveryDir(run.id), { recursive: true });
    await fsp.mkdir(this.notesDir(run.id), { recursive: true });
    await this.save(run);
    return run;
  }

  /** Atomic, serialized save so concurrent agents never interleave writes. */
  save(run) {
    run.updatedAt = new Date().toISOString();
    const file = path.join(this.runDir(run.id), 'run.json');
    const data = JSON.stringify(run, null, 2);
    const prev = this.writeChains.get(run.id) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const tmp = `${file}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, data);
        await fsp.rename(tmp, file);
      });
    this.writeChains.set(run.id, next);
    return next;
  }

  async load(id) {
    const raw = await fsp.readFile(path.join(this.runDir(id), 'run.json'), 'utf8');
    return JSON.parse(raw);
  }

  async list() {
    const ids = await fsp.readdir(this.dir).catch(() => []);
    const runs = [];
    for (const id of ids) {
      try {
        const r = await this.load(id);
        runs.push({
          id: r.id,
          title: r.title,
          idea: r.inputs.idea,
          status: r.status,
          provider: r.provider,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          source: r.source?.mode && r.source.mode !== 'new' ? { mode: r.source.mode, label: r.source.label } : undefined,
          tasks: r.plan?.tasks?.length || 0,
          completedTasks: r.plan?.tasks?.filter((t) => t.status === 'completed').length || 0,
        });
      } catch {
        /* skip unreadable */
      }
    }
    return runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async remove(id) {
    await fsp.rm(this.runDir(id), { recursive: true, force: true });
    this.seq.delete(id);
  }

  nextSeq(id) {
    if (!this.seq.has(id)) {
      let n = 0;
      try {
        const raw = fs.readFileSync(path.join(this.runDir(id), 'events.jsonl'), 'utf8');
        n = raw.split('\n').filter(Boolean).length;
      } catch {
        /* no events yet */
      }
      this.seq.set(id, n);
    }
    const n = this.seq.get(id) + 1;
    this.seq.set(id, n);
    return n;
  }

  /** Append an event to the run's record of work and publish it to live subscribers. */
  event(id, type, data = {}) {
    const evt = { seq: this.nextSeq(id), at: new Date().toISOString(), type, ...data };
    fs.appendFileSync(path.join(this.runDir(id), 'events.jsonl'), `${JSON.stringify(evt)}\n`);
    this.bus.emit(`run:${id}`, evt);
    return evt;
  }

  async events(id, { after = 0 } = {}) {
    try {
      const raw = await fsp.readFile(path.join(this.runDir(id), 'events.jsonl'), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => e.seq > after);
    } catch {
      return [];
    }
  }

  subscribe(id, fn) {
    this.bus.on(`run:${id}`, fn);
    return () => this.bus.off(`run:${id}`, fn);
  }
}
