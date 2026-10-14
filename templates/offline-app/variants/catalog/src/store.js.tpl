// The catalog's data and rules: a read-only collection of entries, validated once when it is loaded. This class is the single
// source of truth for the HTTP API, the UI and the AppPort capabilities alike.

const MAX_QUERY = 100;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const SEED = [
  { id: 'getting-started', name: 'Getting started', category: 'basics', description: 'What this catalog covers and how to search it.' },
  { id: 'core-concepts', name: 'Core concepts', category: 'basics', description: 'The handful of ideas everything else builds on.' },
  { id: 'first-steps', name: 'First steps guide', category: 'guides', description: 'A short walkthrough from zero to a first result.' },
  { id: 'troubleshooting', name: 'Troubleshooting', category: 'guides', description: 'Common problems and how to fix them.' },
  { id: 'glossary', name: 'Glossary', category: 'reference', description: 'Definitions of the terms used across the catalog.' },
  { id: 'faq', name: 'Frequently asked questions', category: 'reference', description: 'Short answers to the questions people ask most.' },
];

function checkEntry(e) {
  for (const k of ['id', 'name', 'category', 'description']) {
    if (typeof e?.[k] !== 'string' || !e[k].trim()) throw new ValidationError(`every entry needs a ${k}`);
  }
  return Object.freeze({ id: e.id, name: e.name, category: e.category, description: e.description });
}

export function cleanQuery(query = {}) {
  const q = typeof query.query === 'string' ? query.query.trim() : '';
  const category = typeof query.category === 'string' ? query.category.trim() : '';
  if (q.length > MAX_QUERY) throw new ValidationError(`query must be at most ${MAX_QUERY} characters`);
  return { q: q.toLowerCase(), category };
}

/** Read-only entry store. Swap the seed for a database by implementing the same methods. */
export class EntryStore {
  constructor({ entries = SEED } = {}) {
    this.items = new Map();
    for (const e of entries) {
      const entry = checkEntry(e);
      if (this.items.has(entry.id)) throw new ValidationError(`duplicate entry id ${entry.id}`);
      this.items.set(entry.id, entry);
    }
  }

  /** Entries matching a text query (name or description) and/or a category, sorted by name. */
  search(query = {}) {
    const { q, category } = cleanQuery(query);
    return [...this.items.values()]
      .filter((e) => (!category || e.category === category) && (!q || `${e.name} ${e.description}`.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id) {
    return this.items.get(id) || null;
  }

  categories() {
    return [...new Set([...this.items.values()].map((e) => e.category))].sort();
  }
{{STATS_METHOD}}}
