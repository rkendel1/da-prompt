import { randomUUID } from 'node:crypto';

const MAX_TITLE = 200;
const MAX_NOTES = 2000;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
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

/** In-memory item store. Swap for a database by implementing the same five methods. */
export class ItemStore {
  constructor() {
    this.items = new Map();
  }

  list() {
    return [...this.items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id) {
    return this.items.get(id) || null;
  }

  create(input) {
    const data = clean(input);
    const now = new Date().toISOString();
    const item = { id: randomUUID(), title: data.title, notes: data.notes || '', done: data.done ?? false, createdAt: now, updatedAt: now };
    this.items.set(item.id, item);
    return item;
  }

  update(id, input) {
    const item = this.items.get(id);
    if (!item) return null;
    const data = clean(input, { partial: true });
    Object.assign(item, data, { updatedAt: new Date().toISOString() });
    return item;
  }

  remove(id) {
    return this.items.delete(id);
  }
{{STATS_METHOD}}}
