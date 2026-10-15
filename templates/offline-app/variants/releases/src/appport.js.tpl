// The application's AppPort capability boundary: what an agent may discover and invoke, over the app's own ReleaseStore. Every
// capability calls the same store the HTTP API calls; signing and verification happen in src/signing.js with the Distribution
// Protocol. Exposure is opt-in: only the capabilities listed here are registered and served.
import { createApplication, defineCapability } from '@appport/core';
import { s } from '@appport/schema';
import { permissionAuthorizer } from '@appport/authorization';
import { AppPortError } from '@appport/protocol';
import { createServer, createHttpBinding } from '@appport/server';
import { handleNodeRequest } from '@appport/server/node';
import { ValidationError, ConflictError } from './store.js';
import { SigningUnavailableError } from './signing.js';
import { createAuthenticator, tokensFromEnv } from './auth.js';

export const APPLICATION = { id: 'app.{{SLUG_ID}}', name: {{APP_TITLE_JSON}}, version: '1.0.0' };

/** Permissions each authenticated role holds (see src/auth.js). */
export const PERMISSIONS = { full: ['releases.read', 'releases.write'], read: ['releases.read'] };

const envelope = s.object({ type: s.string(), manifest: s.record(s.unknown()), signature: s.record(s.unknown()) });
const release = s.object({ name: s.string(), version: s.string(), artifactId: s.string(), mediaType: s.string(), size: s.integer(), publishedAt: s.string(), release: envelope });

// Store errors become AppPort errors with the store's own message; anything else stays an internal error.
const guard = (fn) => async (input) => {
  try {
    return await fn(input);
  } catch (err) {
    if (err instanceof ValidationError) throw new AppPortError('INVALID_INPUT', err.message);
    if (err instanceof ConflictError) throw new AppPortError('CONFLICT', err.message);
    if (err instanceof SigningUnavailableError) throw new AppPortError('FORBIDDEN', err.message);
    throw err;
  }
};

export function capabilities(store) {
  return [
    defineCapability({
      name: 'releases.publish', version: 1, effect: 'consequential', authorization: ['releases.write'],
      description: 'Publish a release: the artifact (base64 `content`) is signed with this app\'s publisher key (Distribution Protocol) and kept. Releases are immutable: the same name and version again is CONFLICT. Not idempotent: if an answer is lost, check releases.get before retrying.',
      input: s.object({ name: s.string({ minLength: 1 }), version: s.string({ minLength: 1 }), artifactId: s.optional(s.string()), mediaType: s.optional(s.string()), content: s.string({ minLength: 1 }) }),
      output: s.object({ release }),
      handler: guard(async (input) => ({ release: await store.publish(input) })),
    }),
    defineCapability({
      name: 'releases.list', version: 1, effect: 'observation', authorization: ['releases.read'],
      description: 'List every published release with its signed envelope, oldest first. Same as GET /api/releases.',
      input: s.object({}), output: s.object({ releases: s.array(release) }),
      handler: async () => ({ releases: await store.list() }),
    }),
    defineCapability({
      name: 'releases.get', version: 1, effect: 'observation', authorization: ['releases.read'],
      description: 'Get one release by name and version. Fails with NOT_FOUND when there is no such release.',
      input: s.object({ name: s.string({ minLength: 1 }), version: s.string({ minLength: 1 }) }), output: s.object({ release }),
      handler: async ({ name, version }) => {
        const found = await store.get(name, version);
        if (!found) throw new AppPortError('NOT_FOUND', `release ${name} ${version} not found`);
        return { release: found };
      },
    }),
    defineCapability({
      name: 'releases.verify', version: 1, effect: 'observation', authorization: ['releases.read'],
      description: 'Verify a signed release envelope against this publisher, and optionally artifact bytes (base64 `content`) against its signed digest. Answers { valid, reason }; a tampered manifest, a foreign key or wrong bytes are invalid.',
      input: s.object({ release: envelope, content: s.optional(s.string()) }), output: s.object({ valid: s.boolean(), reason: s.nullable(s.string()) }),
      handler: async ({ release: r, content }) => store.verify(r, content),
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
