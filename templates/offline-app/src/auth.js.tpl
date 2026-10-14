import { timingSafeEqual } from 'node:crypto';

// Who may call this application's capabilities, and with which permissions. The application owns this decision: AppPort only
// carries the resulting identity to its authorizer. Tokens come from the environment, never from source code or the browser.
//   APP_API_TOKEN   full access (every permission the application grants)
//   APP_READ_TOKEN  read-only access (optional)
// With no token configured nobody can authenticate, so every protected capability is refused (fail closed).

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Map of token -> role, from the environment (or from tests). */
export function tokensFromEnv(env = process.env) {
  const tokens = [];
  if (env.APP_API_TOKEN) tokens.push({ token: env.APP_API_TOKEN, role: 'full' });
  if (env.APP_READ_TOKEN) tokens.push({ token: env.APP_READ_TOKEN, role: 'read' });
  return tokens;
}

/**
 * An AppPort `authenticate` hook. `permissions` maps a role to the permissions it grants, e.g.
 * { full: ['items.read', 'items.write'], read: ['items.read'] }. Unknown or missing credentials resolve to an anonymous
 * identity, which AppPort refuses for every capability that requires authorization.
 */
export function createAuthenticator({ applicationId, tokens = tokensFromEnv(), permissions }) {
  return ({ headers = {} }) => {
    const header = headers.authorization || '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    const match = given && tokens.find((t) => same(t.token, given));
    if (!match) return {};
    const principal = { id: `token:${match.role}`, type: 'service' };
    return {
      principal,
      session: { id: `session:${match.role}`, principal, applicationId, createdAt: new Date().toISOString(), permissions: [...(permissions[match.role] || [])] },
    };
  };
}
