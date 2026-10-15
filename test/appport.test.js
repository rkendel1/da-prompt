// The AppPort-native generation contract (src/appport.js): every new app the factory builds exposes a discoverable,
// authorized capability boundary over its own state, using the published @appport/* packages. These tests generate real
// apps through the normal factory workflow (plan, agents, install, verify, preview), then drive them the way an agent would,
// through the published client installed in the generated app, and check every answer against the app's own state through
// its HTTP API. The gate's negative cases start from a real generated app and break exactly one rule each.
//
// Generated apps install the pinned packages from the npm registry (cached in FACTORY_NPM_CACHE by test/setup-env.cjs, so a
// machine downloads them at most once). No model is called.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { RunStore } from '../src/store.js';
import { Factory } from '../src/factory.js';
import { PreviewManager, launchApp, stopProcess } from '../src/deploy.js';
import { Workspace } from '../src/sandbox.js';
import { APPPORT_PACKAGES, APPPORT_RULES, checkAppPortConformance, sampleFor, cleanException } from '../src/appport.js';
import { agentSystem } from '../src/agents.js';
import { appKind } from '../src/providers/offline.js';

const previews = new PreviewManager({ max: 4 });
const started = [];
after(() => {
  previews.stopAll();
  for (const c of started) stopProcess(c);
});

const setup = () => {
  const cfg = loadConfig({ dataDir: tmpDir() });
  const store = new RunStore(cfg.dataDir);
  return { cfg, store, factory: new Factory({ cfg, store, previews }) };
};

/** Start a generated app the documented way (npm start's command, PORT, tokens from the environment). */
async function startApp(root, deploy, env) {
  const r = await launchApp(root, deploy, { env });
  assert.ok(r.ok, r.error);
  started.push(r.child);
  return { base: `http://127.0.0.1:${r.port}`, stop: () => stopProcess(r.child) };
}

/**
 * Run an agent-side script with the generated app's own node_modules (the published @appport/client and transport). The
 * script gets `origin` and `token` and prints one JSON document.
 */
function agent(root, body, { origin, token, read }) {
  const file = path.join(root, '.home', `agent-${Date.now()}.mjs`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `import { AppPort } from '@appport/client';
import { createHttpTransport } from '@appport/transport-http';
const origin = ${JSON.stringify(origin)};
const connect = (token) => AppPort.discover({ origin, ...(token ? { headers: { authorization: 'Bearer ' + token } } : {}), transports: { http: (o) => createHttpTransport(o) } });
const code = (p) => p.then(() => 'OK', (e) => e.code);
const token = ${JSON.stringify(token)};
const readToken = ${JSON.stringify(read || null)};
${body}`);
  const r = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const json = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

let tracker; // { run, root }, shared by the gate's negative cases

test('a tracker (state-changing workflow) is generated AppPort-native and agents can operate it through its capabilities', async () => {
  const { factory, store } = setup();
  const run = await factory.start((await factory.createRun({ idea: 'A habit tracker with daily check-ins', provider: 'offline' })).id);
  assert.equal(appKind(run.inputs), 'tracker');
  assert.equal(run.status, 'completed', JSON.stringify(run.checklist));
  const item = run.checklist.find((c) => c.id === 'appport');
  assert.equal(item.ok, true, item.detail);
  assert.deepEqual(run.appport.capabilities.map((c) => [c.name, c.effect]).sort(), [['items.create', 'consequential'], ['items.get', 'observation'], ['items.list', 'observation'], ['items.update', 'consequential']]);
  const root = store.workspaceDir(run.id);
  tracker = { run, root };

  // The generated manifest lists the published packages at the pinned versions; they were installed by the normal workflow.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, APPPORT_PACKAGES.dependencies);
  assert.deepEqual(pkg.devDependencies, APPPORT_PACKAGES.devDependencies);
  for (const [name, version] of Object.entries(APPPORT_PACKAGES.dependencies)) assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version, version);
  // The deployed preview has no token configured: its capabilities fail closed, while the existing app works as before.
  const preview = `http://127.0.0.1:${previews.get(run.id).port}`;
  assert.equal((await json(`${preview}/api/health`)).body.ok, true);
  assert.equal(agent(root, `console.log(JSON.stringify(await code((await connect('guess')).call('items.list', {}))));`, { origin: preview }), 'UNAUTHORIZED');

  // Started the documented way, with tokens from the environment.
  const app = await startApp(root, run.plan.deploy, { APP_API_TOKEN: 'full-token-q8w2e5', APP_READ_TOKEN: 'read-token-z3x6c9' });
  try {
    const seeded = await json(`${app.base}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'made in the UI' }) });
    assert.equal(seeded.status, 201, 'the existing HTTP API still works');
    const out = agent(root, `
const app = await connect(token);
const manifest = await (await fetch(origin + '/appport/manifest')).json();
const created = await app.call('items.create', { title: 'Book the dentist', notes: 'via AppPort' });
const updated = await app.call('items.update', { id: created.item.id, done: true });
const listed = await app.call('items.list', {});
const anon = await connect();
const reader = await connect(readToken);
console.log(JSON.stringify({
  names: manifest.capabilities.map((c) => c.name).filter((n) => !n.startsWith('appport.')).sort(),
  created, updated, listed,
  anonRead: await code(anon.call('items.list', {})), anonWrite: await code(anon.call('items.create', { title: 'x' })),
  readerRead: await code(reader.call('items.list', {})), readerWrite: await code(reader.call('items.create', { title: 'x' })),
  remove: await code(app.call('items.remove', { id: created.item.id })),
  invalid: await code(app.call('items.create', { title: 'x'.repeat(201) })),
  missing: await code(app.call('items.get', { id: 'nope' })),
}));`, { origin: app.base, token: 'full-token-q8w2e5', read: 'read-token-z3x6c9' });

    assert.deepEqual(out.names, ['items.create', 'items.get', 'items.list', 'items.update']);
    // Authoritative state, read independently through the app's HTTP API.
    const rest = await json(`${app.base}/api/items/${out.created.item.id}`);
    assert.equal(rest.status, 200);
    assert.deepEqual(rest.body.item, out.updated.item, 'the write is in the app\'s store, exactly as the capability reported');
    assert.equal(rest.body.item.done, true);
    const all = (await json(`${app.base}/api/items`)).body.items;
    assert.deepEqual(out.listed.items, all, 'the read capability returns the store\'s items, including one created through the UI');
    assert.ok(all.some((i) => i.id === seeded.body.item.id));
    assert.deepEqual([out.anonRead, out.anonWrite, out.readerRead, out.readerWrite], ['UNAUTHORIZED', 'UNAUTHORIZED', 'OK', 'FORBIDDEN']);
    assert.ok(['UNKNOWN_CAPABILITY', 'FORBIDDEN'].includes(out.remove), `delete is not exposed (${out.remove})`);
    assert.deepEqual([out.invalid, out.missing], ['INVALID_INPUT', 'NOT_FOUND']);
    assert.equal(all.length, 2, 'refused and invalid calls changed nothing');
    // The existing HTTP API is unchanged: the item can still be deleted there.
    assert.equal((await json(`${app.base}/api/items/${out.created.item.id}`, { method: 'DELETE' })).status, 204);
  } finally {
    app.stop();
  }
});

test('a catalog (read-oriented) is generated AppPort-native: reads only, authorized, matching the app\'s own data', async () => {
  const { factory, store } = setup();
  const run = await factory.start((await factory.createRun({ idea: 'A glossary of cloud computing terms', provider: 'offline', settings: { deploy: false } })).id);
  assert.equal(appKind(run.inputs), 'catalog');
  assert.equal(run.status, 'completed', JSON.stringify(run.checklist));
  assert.equal(run.checklist.find((c) => c.id === 'appport').ok, true, 'the gate does not need a live preview');
  assert.deepEqual(run.appport.capabilities.map((c) => [c.name, c.effect]).sort(), [['entries.categories', 'observation'], ['entries.get', 'observation'], ['entries.search', 'observation']]);
  const root = store.workspaceDir(run.id);
  const app = await startApp(root, run.plan.deploy, { APP_API_TOKEN: 'catalog-token-m4n7b1' });
  try {
    const out = agent(root, `
const app = await connect(token);
const manifest = await (await fetch(origin + '/appport/manifest')).json();
console.log(JSON.stringify({
  effects: manifest.capabilities.filter((c) => !c.name.startsWith('appport.')).map((c) => c.effect),
  all: await app.call('entries.search', {}), guides: await app.call('entries.search', { category: 'guides' }),
  faq: await app.call('entries.get', { id: 'faq' }), categories: await app.call('entries.categories', {}),
  anon: await code((await connect()).call('entries.search', {})),
  write: await code(app.call('entries.create', { id: 'x', name: 'x', category: 'x', description: 'x' })),
}));`, { origin: app.base, token: 'catalog-token-m4n7b1' });
    assert.deepEqual([...new Set(out.effects)], ['observation'], 'a read-only app exposes no write');
    assert.deepEqual(out.all, (await json(`${app.base}/api/entries`)).body);
    assert.deepEqual(out.guides, (await json(`${app.base}/api/entries?category=guides`)).body);
    assert.deepEqual(out.faq.entry, (await json(`${app.base}/api/entries/faq`)).body.entry);
    assert.deepEqual(out.categories, (await json(`${app.base}/api/categories`)).body);
    assert.equal(out.anon, 'UNAUTHORIZED');
    assert.ok(['UNKNOWN_CAPABILITY', 'FORBIDDEN'].includes(out.write));
    assert.equal((await json(`${app.base}/api/entries/faq`, { method: 'DELETE' })).status, 405, 'the existing read-only API is unchanged');
  } finally {
    app.stop();
  }
});

// ── the gate's negative cases: a real generated app with one rule broken ──────────────────────────────────────────────────

/** A copy of the generated tracker with `edit(root)` applied, checked by the gate. */
async function gateOn(edit) {
  assert.ok(tracker, 'the tracker test ran first');
  const root = tmpDir('appport-gate-');
  fs.cpSync(tracker.root, root, { recursive: true, filter: (src) => !src.includes(`${path.sep}.home`) });
  edit(root);
  const ws = new Workspace(root);
  return checkAppPortConformance({
    ws,
    launch: async (env) => {
      const r = await launchApp(root, tracker.run.plan.deploy, { env, timeoutMs: 15_000 });
      if (r.ok) started.push(r.child);
      return { ok: r.ok, port: r.port, error: r.error, stop: () => r.ok && stopProcess(r.child) };
    },
  });
}
const failed = (g) => g.checks.filter((c) => !c.ok).map((c) => c.id);
const editFile = (root, rel, fn) => {
  const before = fs.readFileSync(path.join(root, rel), 'utf8');
  const after = fn(before);
  assert.notEqual(after, before, `the edit to ${rel} did not apply (the template changed?)`);
  fs.writeFileSync(path.join(root, rel), after);
};
const editPkg = (root, fn) => editFile(root, 'package.json', (s) => JSON.stringify(fn(JSON.parse(s)), null, 2));

test('the gate passes the generated app unchanged', async () => {
  const g = await gateOn(() => {});
  assert.equal(g.ok, true, JSON.stringify(g.checks));
});

test('the gate fails an app that omits its AppPort integration, or uses an incompatible or unpublished package', async () => {
  const omitted = await gateOn((root) => editPkg(root, (p) => ({ ...p, dependencies: {} })));
  assert.deepEqual(failed(omitted), ['packages']);
  assert.match(omitted.checks.find((c) => c.id === 'packages').detail, /@appport\/core is not a dependency/);
  const old = await gateOn((root) => editFile(root, 'node_modules/@appport/core/package.json', (s) => s.replace('"version": "1.1.0"', '"version": "0.9.0"')));
  assert.match(old.checks.find((c) => c.id === 'packages').detail, /@appport\/core@0\.9\.0 is not compatible with 1\.1\.0/);
  const local = await gateOn((root) => editPkg(root, (p) => ({ ...p, dependencies: { ...p.dependencies, '@appport/core': 'file:../appport/packages/core' } })));
  assert.match(local.checks.find((c) => c.id === 'packages').detail, /only published versions are allowed/);
  const notInstalled = await gateOn((root) => fs.rmSync(path.join(root, 'node_modules', '@appport', 'server'), { recursive: true }));
  assert.match(notInstalled.checks.find((c) => c.id === 'packages').detail, /@appport\/server is not installed/);
});

test('the gate fails a write exposed without an authorization boundary, and proves it by calling it anonymously', async () => {
  const g = await gateOn((root) => editFile(root, 'src/appport.js', (s) => s.replace("name: 'items.create', version: 1, effect: 'consequential', authorization: ['items.write'],", "name: 'items.create', version: 1, effect: 'consequential', authorizationContract: { required: false, public: true },")));
  assert.deepEqual(failed(g), ['writes-authorized']);
  assert.match(g.checks.find((c) => c.id === 'writes-authorized').detail, /items\.create/);
  // Authorization switched off (the published allow-all authorizer) while the manifest still claims permissions: the gate
  // calls every protected capability anonymously, so the leak is observed, not inferred.
  const leak = await gateOn((root) => editFile(root, 'src/appport.js', (s) => s.replace("import { permissionAuthorizer } from '@appport/authorization';", "import { allowAllAuthorizer as permissionAuthorizer } from '@appport/authorization';")));
  assert.deepEqual(failed(leak), ['anonymous-refused']);
  assert.match(leak.checks.find((c) => c.id === 'anonymous-refused').detail, /items\.list answered an anonymous caller/);
});

test('the gate fails an app whose capabilities cannot be discovered, or whose effects are not declared', async () => {
  const hidden = await gateOn((root) => editFile(root, 'src/appport.js', (s) => s.replace(", transports: [{ kind: 'http', endpoint: '/appport' }]", '')));
  assert.deepEqual(failed(hidden), ['discovery']);
  const undeclared = await gateOn((root) => editFile(root, 'src/appport.js', (s) => s.replace("name: 'items.get', version: 1, effect: 'observation',", "name: 'items.get', version: 1,")));
  assert.deepEqual(failed(undeclared), ['declared']);
  const unmounted = await gateOn((root) => editFile(root, 'src/app.js', (s) => s.replace('if (appport.handles(url.pathname)) return appport.handle(req, res);', '')));
  assert.deepEqual(failed(unmounted), ['discovery']);
});

test('the gate fails an app that ignores its own token or publishes it', async () => {
  const ignores = await gateOn((root) => editFile(root, 'src/auth.js', (s) => s.replace('if (env.APP_API_TOKEN)', 'if (false)')));
  assert.deepEqual(failed(ignores), ['invocation']);
  assert.match(ignores.checks.find((c) => c.id === 'invocation').detail, /UNAUTHORIZED \(does the app read APP_API_TOKEN\?\)/);
  const leaks = await gateOn((root) => editFile(root, 'src/appport.js', (s) => s.replace("description: 'List every item, oldest first. Returns the same items as GET /api/items.',", "description: `List every item (key ${process.env.APP_API_TOKEN}), oldest first.`,")));
  assert.deepEqual(failed(leaks), ['no-credentials']);
});

test('state authority: a capability that bypasses the store is caught by the app\'s own conformance tests; dropping them fails the gate', async () => {
  // A capability answering from its own copy of the data instead of the store: the generic gate cannot know the app's data,
  // so this is proved by the app's test/appport.test.js (run by finalVerify), which compares every result with the store.
  const root = tmpDir('appport-bypass-');
  fs.cpSync(tracker.root, root, { recursive: true, filter: (src) => !src.includes(`${path.sep}.home`) });
  editFile(root, 'src/appport.js', (s) => s.replace('handler: async () => ({ items: await store.list() }),', 'handler: async () => ({ items: shadow }),').replace('export function capabilities(store) {', 'const shadow = [];\nexport function capabilities(store) {'));
  const r = await new Workspace(root).runCommand('npm test', { timeoutMs: 120_000 });
  assert.notEqual(r.exitCode, 0, 'the app\'s own AppPort tests fail');
  assert.match(r.stdout, /not ok .*reads and writes go through the store/);
  // …and an app whose tests do not exercise the boundary at all fails the gate.
  const untested = await gateOn((root2) => fs.rmSync(path.join(root2, 'test', 'appport.test.js')));
  assert.deepEqual(failed(untested), ['tested']);
});

// ── the exception, and what agents are told ───────────────────────────────────────────────────────────────────────────────

test('an exception is explicit and narrow: it needs a reason, is recorded, and is not available to existing projects', async () => {
  assert.throws(() => cleanException('   '), /non-empty reason/);
  assert.throws(() => cleanException(true), /non-empty reason/);
  assert.equal(cleanException(''), '');
  assert.equal(cleanException('x'.repeat(400)).length, 300);
  const { factory, store } = setup();
  const run = await factory.start((await factory.createRun({ idea: 'A habit tracker', provider: 'offline', settings: { deploy: false, appportException: 'internal batch tool with no callers' } })).id);
  const item = run.checklist.find((c) => c.id === 'appport');
  assert.deepEqual([item.ok, item.state, item.detail], [true, 'na', 'explicit exception for this run: internal batch tool with no callers']);
  assert.ok((await store.events(run.id)).some((e) => e.type === 'log' && /AppPort contract not required for this run \(explicit exception\): internal batch tool/.test(e.text)));
  assert.equal(agentSystem(run, run.plan.tasks[1], '').includes('AppPort-native application'), false, 'agents are not asked for the boundary');
  // A normal run carries no exception field at all, and agents are given the contract with the pinned versions.
  const normal = await factory.createRun({ idea: 'A habit tracker', provider: 'offline' });
  assert.equal('appportException' in normal.settings, false);
  const system = agentSystem({ ...normal, plan: { product: { name: 'x', summary: '' } } }, { id: 't', role: 'engineer' }, '');
  assert.ok(system.includes(APPPORT_RULES));
  for (const [name, v] of Object.entries(APPPORT_PACKAGES.dependencies)) assert.ok(system.includes(`${name}@${v}`), name);
});

test('sample inputs satisfy the schemas the gate meets, so authorization (not validation) answers', () => {
  assert.deepEqual(sampleFor({ type: 'object', properties: { id: { type: 'string', minLength: 3 }, n: { type: 'integer', minimum: 2 }, tags: { type: 'array', items: { type: 'string' }, minItems: 1 }, opt: { type: 'string' } }, required: ['id', 'n', 'tags'] }), { id: 'aaa', n: 2, tags: ['a'] });
  assert.deepEqual(sampleFor({ type: 'object', properties: { kind: { enum: ['x', 'y'] }, v: { anyOf: [{ type: 'null' }, { type: 'boolean' }] } }, required: ['kind', 'v'] }), { kind: 'x', v: false });
});
