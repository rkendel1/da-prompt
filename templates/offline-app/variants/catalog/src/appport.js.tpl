// The catalog's AppPort capability boundary: what an agent may discover and invoke, over the catalog's own EntryStore. The
// catalog is read-only, so every capability is an observation; there is no write capability because the application has no
// write operation. Exposure is opt-in: only the capabilities listed here are registered and served.
import { createApplication, defineCapability } from '@appport/core';
import { s } from '@appport/schema';
import { permissionAuthorizer } from '@appport/authorization';
import { AppPortError } from '@appport/protocol';
import { createServer, createHttpBinding } from '@appport/server';
import { handleNodeRequest } from '@appport/server/node';
import { ValidationError } from './store.js';
import { createAuthenticator, tokensFromEnv } from './auth.js';

export const APPLICATION = { id: 'app.{{SLUG_ID}}', name: {{APP_TITLE_JSON}}, version: '1.0.0' };

/** Permissions each authenticated role holds (see src/auth.js). Reading is the only thing the catalog allows. */
export const PERMISSIONS = { full: ['entries.read'], read: ['entries.read'] };

const entry = s.object({ id: s.string(), name: s.string(), category: s.string(), description: s.string() });

export function capabilities(store) {
  return [
    defineCapability({
      name: 'entries.search', version: 1, effect: 'observation', authorization: ['entries.read'],
      description: 'Find entries whose name or description contains `query`, optionally within one `category`. Both are optional; with neither, every entry is returned. Same results as GET /api/entries.',
      input: s.object({ query: s.optional(s.string({ maxLength: 100 })), category: s.optional(s.string()) }), output: s.object({ entries: s.array(entry), total: s.integer() }),
      handler: (input) => {
        try {
          const entries = store.search(input);
          return { entries, total: entries.length };
        } catch (err) {
          if (err instanceof ValidationError) throw new AppPortError('INVALID_INPUT', err.message);
          throw err;
        }
      },
    }),
    defineCapability({
      name: 'entries.get', version: 1, effect: 'observation', authorization: ['entries.read'],
      description: 'Get one entry by id. Fails with NOT_FOUND when there is no such entry.',
      input: s.object({ id: s.string({ minLength: 1 }) }), output: s.object({ entry }),
      handler: ({ id }) => {
        const found = store.get(id);
        if (!found) throw new AppPortError('NOT_FOUND', `entry ${id} not found`);
        return { entry: found };
      },
    }),
    defineCapability({
      name: 'entries.categories', version: 1, effect: 'observation', authorization: ['entries.read'],
      description: 'List the categories that entries belong to, for use as the `category` filter of entries.search.',
      input: s.object({}), output: s.object({ categories: s.array(s.string()) }),
      handler: () => ({ categories: store.categories() }),
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
