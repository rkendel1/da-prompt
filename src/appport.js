// AppPort-native generated applications: the generation contract and its conformance gate.
//
// Every NEW application the factory builds exposes an explicit AppPort capability boundary (the published @appport/*
// packages) over its own state and rules, so agents can discover and operate it without reverse-engineering its HTTP API.
// This module states that contract once (pinned packages, the rules agents are given) and checks it on the generated app:
// behaviourally, by starting the app and speaking the AppPort wire protocol to it. The factory itself stays dependency-free:
// the gate never imports an @appport package, it only reads the app's files and talks HTTP.
//
// Existing projects are out of scope (their architecture is the user's). A run may opt out only with an explicit, recorded
// reason (settings.appportException); there is no other bypass.

import crypto from 'node:crypto';
import fs from 'node:fs';

const PINNED = JSON.parse(fs.readFileSync(new URL('../templates/appport-packages.json', import.meta.url), 'utf8'));
/** The published AppPort packages generated apps depend on: exact, mutually compatible versions (one release line). */
export const APPPORT_PACKAGES = { dependencies: PINNED.dependencies, devDependencies: PINNED.devDependencies };
/** Packages the gate requires at runtime; the rest of APPPORT_PACKAGES.dependencies is recommended. */
export const REQUIRED_RUNTIME = ['@appport/core', '@appport/server'];
/** The install command the factory's agents use for a generated app (no lifecycle scripts, cache first). */
export const INSTALL_COMMAND = PINNED.install;
/** The variable a generated app reads for the token that grants full capability access (the gate sets it). */
export const TOKEN_ENV = 'APP_API_TOKEN';
export const MAX_EXCEPTION_REASON = 300;

const pins = (o) => Object.entries(o).map(([k, v]) => `${k}@${v}`).join(' ');

/** The rules every agent building a new app is given (src/agents.js). Kept short: the packages' READMEs are the reference. */
export const APPPORT_RULES = `AppPort-native application (required for every new app):
- Depend on the published AppPort packages at exactly these versions: ${pins(APPPORT_PACKAGES.dependencies)}; for tests also ${pins(APPPORT_PACKAGES.devDependencies)} (devDependencies). Install with: ${INSTALL_COMMAND}. Never copy AppPort source, never use file:/link:/git dependencies.
- After installing, read node_modules/@appport/core/README.md and node_modules/@appport/server/README.md. The APIs to use: defineCapability and createApplication (@appport/core), s (@appport/schema), permissionAuthorizer (@appport/authorization), AppPortError (@appport/protocol), createServer and createHttpBinding (@appport/server), handleNodeRequest (@appport/server/node).
- Put the boundary in src/appport.js: one capability per semantic operation the app really implements, each calling the SAME store/service functions the HTTP API uses (no second copy of data, no direct database access, no extra cache or server-memory state). Give each capability a description, input/output schemas, effect: 'observation' (read) or 'consequential' (write), and authorization: ['<permission>'] (writes always need one). Expose only what callers should use: register only those capabilities and pass the same names as allowedCapabilities to createHttpBinding. Map the app's own validation and not-found errors to AppPortError('INVALID_INPUT' | 'NOT_FOUND', message).
- Mount it in the existing HTTP server (no second server): if (binding.handles(path)) return handleNodeRequest(binding, req, res). Advertise it: createApplication({ ..., transports: [{ kind: 'http', endpoint: '/appport' }] }) so /.well-known/appport works.
- Authentication is the app's: createServer({ authenticate }) maps "Authorization: Bearer <token>" to { principal, session: { id, principal, applicationId, createdAt, permissions } }. Read the full-access token from process.env.${TOKEN_ENV} (optionally a read-only token from APP_READ_TOKEN); no token configured means every protected capability is refused. Never put a token in source, in browser code or in a capability description.
- Do not mark a write idempotent or retry it unless the operation really is idempotent.
- Test it in test/appport.test.js with @appport/client + @appport/transport-http (AppPort.discover({ origin, headers, transports: { http: (o) => createHttpTransport(o) } })): discovery, every capability, results checked against the store/HTTP API, anonymous callers refused (UNAUTHORIZED), operations you did not expose absent. Document the capabilities in the README (an "AppPort" section).`;

/** The run's explicit exception to the AppPort contract (a non-empty reason), or null. Existing projects never have one. */
export function appportException(run) {
  const r = run?.settings?.appportException;
  return typeof r === 'string' && r.trim() ? r.trim() : null;
}

/** Normalize a requested exception: a reason string (trimmed, bounded), or '' for none. */
export function cleanException(value) {
  if (value == null || value === false || value === '') return '';
  if (typeof value !== 'string' || !value.trim()) throw new Error('appportException must be a non-empty reason (why this app should not expose an AppPort boundary)');
  return value.trim().slice(0, MAX_EXCEPTION_REASON);
}

// ── conformance gate ───────────────────────────────────────────────────────────────────────────

const LOCAL_SPEC = /^(file:|link:|workspace:|portal:|git(\+[a-z]+)?:|github:|https?:|[\w.-]+\/[\w.-]+(#.*)?$)/i;
const semver = (v) => String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) || null;
/** Same major version and not older than the pinned one: a newer patch or minor of the same line is compatible. */
const compatible = (installed, pinned) => {
  const a = semver(installed);
  const b = semver(pinned);
  if (!a || !b || a[0] !== b[0]) return false;
  return a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2]);
};

/** A small input that satisfies a JSON Schema (used to reach the authorization step: AppPort validates input first). */
export function sampleFor(schema = {}, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 6) return null;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  for (const k of ['anyOf', 'oneOf']) if (Array.isArray(schema[k]) && schema[k].length) return sampleFor(schema[k].find((x) => x.type !== 'null') || schema[k][0], depth + 1);
  if (Array.isArray(schema.allOf) && schema.allOf.length) return Object.assign({}, ...schema.allOf.map((x) => sampleFor(x, depth + 1)));
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object':
    case undefined: {
      if (type === undefined && !schema.properties) return null;
      const out = {};
      for (const k of schema.required || []) out[k] = sampleFor(schema.properties?.[k] || {}, depth + 1);
      return out;
    }
    case 'string': {
      if (schema.format === 'date-time') return new Date(0).toISOString();
      const n = Math.max(1, schema.minLength || 1);
      return 'a'.repeat(Math.min(n, schema.maxLength || n));
    }
    case 'integer':
    case 'number':
      return Math.max(0, Math.ceil(schema.minimum ?? (schema.exclusiveMinimum != null ? schema.exclusiveMinimum + 1 : 0)));
    case 'boolean':
      return false;
    case 'array':
      return Array.from({ length: schema.minItems || 0 }, () => sampleFor(schema.items || {}, depth + 1));
    case 'null':
      return null;
    default:
      return null;
  }
}

const versionEntry = (cap) => (cap.definitions || []).find((d) => d.version === cap.latestVersion) || cap.definitions?.[0] || cap;

/**
 * Check a generated application against the AppPort contract. `ws` is the run's Workspace (files are read through it);
 * `launch(env)` starts the app (see launchApp in src/deploy.js) and resolves { ok, port, stop(), error? }.
 * Resolves { ok, checks: [{ id, ok, detail }], capabilities: [{ name, effect, authorization }] }. Never throws.
 */
export async function checkAppPortConformance({ ws, launch, timeoutMs = 5000 }) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
  const result = (capabilities = []) => ({ ok: checks.length > 0 && checks.every((c) => c.ok), checks, capabilities });

  // 1. Package configuration: the published packages, declared and installed at compatible versions.
  let pkg = null;
  try {
    pkg = JSON.parse(await ws.readFile('package.json'));
  } catch {
    add('packages', false, 'package.json is missing or not valid JSON');
    return result();
  }
  const declared = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
  const problems = [];
  for (const name of REQUIRED_RUNTIME) if (!pkg.dependencies?.[name]) problems.push(`${name} is not a dependency`);
  for (const [name, spec] of Object.entries(declared)) {
    if (!name.startsWith('@appport/')) continue;
    if (LOCAL_SPEC.test(String(spec))) problems.push(`${name} is "${spec}": only published versions are allowed`);
    const pinned = APPPORT_PACKAGES.dependencies[name] || APPPORT_PACKAGES.devDependencies[name];
    let installed = null;
    try {
      installed = JSON.parse(await ws.readFile(`node_modules/${name}/package.json`)).version;
    } catch {
      problems.push(`${name} is not installed (run: ${INSTALL_COMMAND})`);
      continue;
    }
    if (pinned && !compatible(installed, pinned)) problems.push(`${name}@${installed} is not compatible with ${pinned}`);
  }
  // Supplement (source inspection, not proof): the app's own tests exercise the boundary through the client, which is where an
  // app checks capability results against its authoritative state. finalVerify runs them.
  let tested = false;
  try {
    for (const f of await ws.listFiles('test')) if (/\.(m?js|ts)$/.test(f.path) && (await ws.readFile(f.path)).includes('@appport/client')) tested = true;
  } catch {
    /* no test folder */
  }
  add('tested', tested, tested ? 'the app\'s tests exercise the boundary through @appport/client' : 'no test under test/ uses @appport/client to exercise the AppPort boundary');
  add('packages', problems.length === 0, problems.length ? problems.join('; ') : `published @appport packages installed (${Object.keys(declared).filter((n) => n.startsWith('@appport/')).length})`);
  if (problems.length) return result();

  // 2. Start the app as it is deployed, with a one-off token the app must honour (TOKEN_ENV).
  const token = `gate-${crypto.randomBytes(18).toString('hex')}`;
  const app = await launch({ [TOKEN_ENV]: token });
  if (!app.ok) {
    add('starts', false, `the app did not start: ${app.error || 'unknown error'}`);
    return result();
  }
  const base = `http://127.0.0.1:${app.port}`;
  const get = async (p) => {
    const res = await fetch(base + p, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, text: await res.text() };
  };
  const call = async (cap, input, auth) => {
    const res = await fetch(`${base}${endpoint}`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify({ protocol: 'appport/1', type: 'request', requestId: `req_gate_${crypto.randomBytes(6).toString('hex')}`, capability: { name: cap.name, version: cap.latestVersion ?? versionEntry(cap).version ?? 1 }, input }),
    });
    try {
      return JSON.parse(await res.text());
    } catch {
      return { ok: false, error: { code: `HTTP_${res.status}`, message: 'not an AppPort response' } };
    }
  };
  let endpoint = '/appport';
  try {
    // 3. Discovery through the supported interface.
    const wk = await get('/.well-known/appport').catch((e) => ({ status: 0, text: e.message }));
    let doc = null;
    try {
      doc = JSON.parse(wk.text);
    } catch {
      /* reported below */
    }
    const http = doc?.transports?.find?.((t) => t.kind === 'http');
    add('discovery', wk.status === 200 && doc?.protocol === 'appport/1' && http, wk.status !== 200 ? `GET /.well-known/appport → ${wk.status || wk.text}` : !http ? 'the discovery document advertises no http transport (createApplication({ transports: [{ kind: "http", endpoint: "/appport" }] }))' : `appport/1 at ${http.endpoint}`);
    if (!http) return result();
    endpoint = http.endpoint?.startsWith('/') ? http.endpoint : '/appport';
    const mf = await get(doc.manifest || '/appport/manifest');
    let manifest = null;
    try {
      manifest = JSON.parse(mf.text);
    } catch {
      /* reported below */
    }
    const own = (manifest?.capabilities || []).filter((c) => !String(c.name).startsWith('appport.'));
    add('capabilities', own.length > 0, own.length ? `${own.length} capabilities: ${own.map((c) => c.name).join(', ')}` : 'the manifest declares no application capability');
    if (!own.length) return result();
    const caps = own.map((c) => {
      const v = versionEntry(c);
      return { cap: c, name: c.name, description: c.description || v.description, effect: c.effect || v.effect, contract: c.authorizationContract || v.authorizationContract, input: v.inputSchema || c.inputSchema };
    });

    // 4. Every capability says what it is and what it needs.
    const undeclared = caps.filter((c) => !c.description || !['observation', 'consequential'].includes(c.effect) || !c.input);
    add('declared', undeclared.length === 0, undeclared.length ? `missing description, input schema or explicit effect: ${undeclared.map((c) => c.name).join(', ')}` : 'every capability has a description, schemas and an explicit read/write effect');
    const openWrites = caps.filter((c) => c.effect === 'consequential' && !(c.contract?.required === true && c.contract.scopes?.length));
    add('writes-authorized', openWrites.length === 0, openWrites.length ? `write capabilities without a required permission: ${openWrites.map((c) => c.name).join(', ')}` : `${caps.filter((c) => c.effect === 'consequential').length} write capabilities, each requires a permission`);

    // 5. The authorization boundary holds: an anonymous caller is refused before anything runs.
    const protectedCaps = caps.filter((c) => c.contract?.required !== false);
    const leaks = [];
    for (const c of protectedCaps) {
      const r = await call(c.cap, sampleFor(c.input) ?? {});
      if (r.ok) leaks.push(`${c.name} answered an anonymous caller`);
      else if (!['UNAUTHORIZED', 'FORBIDDEN'].includes(r.error?.code)) leaks.push(`${c.name}: expected UNAUTHORIZED, got ${r.error?.code}${r.error?.code === 'INVALID_INPUT' ? ' (the gate could not build a valid sample input from the schema)' : ''}`);
    }
    add('anonymous-refused', leaks.length === 0, leaks.length ? leaks.join('; ') : `${protectedCaps.length} protected capabilities refuse anonymous callers`);

    // 6. Invocation works for an authorized caller (reads only: the gate never mutates the app's state).
    const reads = caps.filter((c) => c.effect === 'observation');
    const broken = [];
    for (const c of reads) {
      const r = await call(c.cap, sampleFor(c.input) ?? {}, token);
      if (!r.ok && !['NOT_FOUND', 'CONFLICT'].includes(r.error?.code)) broken.push(`${c.name}: ${r.error?.code}${r.error?.code === 'UNAUTHORIZED' ? ` (does the app read ${TOKEN_ENV}?)` : ''}`);
    }
    add('invocation', reads.length > 0 && broken.length === 0, !reads.length ? 'no read capability to invoke' : broken.length ? broken.join('; ') : `${reads.length} read capabilities answer an authorized caller`);

    // 7. Nothing is exposed by accident, and no credential is published.
    const unknown = await call({ name: 'gate.notexposed', latestVersion: 1 }, {}, token);
    add('unexposed-refused', !unknown.ok, unknown.ok ? 'an undeclared capability answered' : `undeclared capabilities are refused (${unknown.error?.code})`);
    const published = `${wk.text}${mf.text}`;
    add('no-credentials', !published.includes(token), published.includes(token) ? `the discovery document or manifest contains the ${TOKEN_ENV} value` : 'no credential in the discovery document or manifest');
    return result(caps.map((c) => ({ name: c.name, effect: c.effect, authorization: c.contract?.required === false ? 'public' : c.contract?.scopes || [] })));
  } catch (err) {
    add('reachable', false, `the AppPort boundary did not answer: ${err.message}`);
    return result();
  } finally {
    app.stop();
  }
}
