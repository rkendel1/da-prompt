// The application's AppPort capability boundary: what an agent (or any AppPort client) may discover and invoke, over the
// application's own store and rules. Nothing here holds state or bypasses ItemStore: every capability calls the same store
// method the HTTP API calls, so the store stays the single source of truth and its validation applies unchanged.
//
// Exposure is opt-in: only the capabilities in CAPABILITIES are registered and served. ItemStore.remove() exists but is not
// exposed; add a capability here (with a permission) if callers should be able to delete.
import { createApplication, defineCapability } from '@appport/core';
import { s } from '@appport/schema';
import { permissionAuthorizer } from '@appport/authorization';
import { AppPortError } from '@appport/protocol';
import { createServer, createHttpBinding } from '@appport/server';
import { handleNodeRequest } from '@appport/server/node';
import { ValidationError } from './store.js';
import { createAuthenticator, tokensFromEnv } from './auth.js';

export const APPLICATION = { id: 'app.{{SLUG_ID}}', name: {{APP_TITLE_JSON}}, version: '1.0.0' };

/** Permissions each authenticated role holds (see src/auth.js). */
export const PERMISSIONS = { full: ['items.read', 'items.write'], read: ['items.read'] };

const item = s.object({ id: s.string(), title: s.string(), notes: s.string(), done: s.boolean(), createdAt: s.string(), updatedAt: s.string() });

// Store errors become AppPort errors with the store's own message; anything else stays an internal error. The store may be
// synchronous (in memory) or asynchronous (a durable store): every call is awaited.
const guard = (fn) => async (input) => {
  try {
    return await fn(input);
  } catch (err) {
    if (err instanceof ValidationError) throw new AppPortError('INVALID_INPUT', err.message);
    throw err;
  }
};
const found = (value, id) => {
  if (!value) throw new AppPortError('NOT_FOUND', `item ${id} not found`);
  return { item: value };
};

export function capabilities(store) {
  return [
    defineCapability({
      name: 'items.list', version: 1, effect: 'observation', authorization: ['items.read'],
      description: 'List every item, oldest first. Returns the same items as GET /api/items.',
      input: s.object({}), output: s.object({ items: s.array(item) }),
      handler: async () => ({ items: await store.list() }),
    }),
    defineCapability({
      name: 'items.get', version: 1, effect: 'observation', authorization: ['items.read'],
      description: 'Get one item by id. Fails with NOT_FOUND when there is no such item.',
      input: s.object({ id: s.string({ minLength: 1 }) }), output: s.object({ item }),
      handler: async ({ id }) => found(await store.get(id), id),
    }),
    defineCapability({
      name: 'items.create', version: 1, effect: 'consequential', authorization: ['items.write'],
      description: 'Create an item. Not idempotent: calling it twice creates two items, so do not retry an unanswered call blindly; list the items first.',
      input: s.object({ title: s.string({ minLength: 1 }), notes: s.optional(s.string()), done: s.optional(s.boolean()) }), output: s.object({ item }),
      handler: guard(async (input) => ({ item: await store.create(input) })),
    }),
    defineCapability({
      name: 'items.update', version: 1, effect: 'consequential', authorization: ['items.write'],
      description: 'Change the title, notes or done flag of an item. Fails with NOT_FOUND when there is no such item.',
      input: s.object({ id: s.string({ minLength: 1 }), title: s.optional(s.string()), notes: s.optional(s.string()), done: s.optional(s.boolean()) }), output: s.object({ item }),
      handler: guard(async ({ id, ...changes }) => found(await store.update(id, changes), id)),
    }),
  ];
}

/** The AppPort HTTP binding for this application, served under /appport and /.well-known/appport by src/app.js. */
export function createAppPort({ store, tokens = tokensFromEnv() }) {
  const caps = capabilities(store);
  const application = createApplication({ application: APPLICATION, capabilities: caps, authorizer: permissionAuthorizer(), transports: [{ kind: 'http', endpoint: '/appport' }] });
  const server = createServer({ application, authenticate: createAuthenticator({ applicationId: APPLICATION.id, tokens, permissions: PERMISSIONS }) });
  const binding = createHttpBinding({ server, allowedCapabilities: caps.map((c) => c.name) });
  return { handles: (path) => binding.handles(path), handle: (req, res) => handleNodeRequest(binding, req, res) };
}
