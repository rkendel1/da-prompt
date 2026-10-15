// Selectable product stacks (src/stack.js, templates/stack.json). A run's stack is validated up front (unknown and
// unsupported components fail with the verified blocker and the next step), resolved into exactly the generated app's
// dependencies, given to the agents, and checked by the stack gate: selected integrations present and working, unselected
// packages absent. The three supported profiles are generated through the normal factory workflow and verified independently
// of the generated app: FeltDB state from a fresh process, Distribution Protocol releases with the package itself.
//
// Generated apps install their pinned packages from the npm registry (one shared cache, see test/setup-env.cjs). No model is
// called.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { tmpDir } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { RunStore } from '../src/store.js';
import { Factory } from '../src/factory.js';
import { PreviewManager, launchApp, stopProcess } from '../src/deploy.js';
import { Workspace } from '../src/sandbox.js';
import { resolveStack, stackDependencies, stackRules, describeStack, checkStackConformance, STACK_IDS, StackError } from '../src/stack.js';
import { agentSystem } from '../src/agents.js';
import { startBackend, cli } from './cli-helpers.js';

const previews = new PreviewManager({ max: 4 });
const started = [];
const backends = [];
after(async () => {
  previews.stopAll();
  for (const c of started) stopProcess(c);
  await Promise.all(backends.map((b) => b.close()));
});

const setup = () => {
  const cfg = loadConfig({ dataDir: tmpDir() });
  const store = new RunStore(cfg.dataDir);
  return { cfg, store, factory: new Factory({ cfg, store, previews }) };
};
const NO_TELEMETRY = { FELTDB_TELEMETRY: '0' };

async function startApp(root, deploy, env) {
  const r = await launchApp(root, deploy, { env: { ...NO_TELEMETRY, ...env } });
  if (r.ok) started.push(r.child);
  return { ...r, base: `http://127.0.0.1:${r.port}`, stop: () => r.ok && stopProcess(r.child) };
}
const waitExit = (child) => new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));

/** Run a script inside the generated app (its own node_modules: the published packages), printing one JSON document. */
function inApp(root, body) {
  const file = path.join(root, '.home', `check-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  const r = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...NO_TELEMETRY } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const CLIENT = `import { AppPort } from '@appport/client';
import { createHttpTransport } from '@appport/transport-http';
const connect = (origin, token) => AppPort.discover({ origin, ...(token ? { headers: { authorization: 'Bearer ' + token } } : {}), transports: { http: (o) => createHttpTransport(o) } });
const code = (p) => p.then(() => 'OK', (e) => e.code);
`;
const pkgOf = (root) => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const installed = (root, name) => fs.existsSync(path.join(root, 'node_modules', name, 'package.json'));

// ── selection: validation, resolution, rules ─────────────────────────────────────────────────

test('the default stack is AppPort; selections are validated with actionable errors', () => {
  assert.deepEqual(resolveStack(), ['appport']);
  assert.deepEqual(resolveStack(['feltdb']), ['appport', 'feltdb'], 'AppPort is implied');
  assert.deepEqual(resolveStack('distribution, feltdb'), ['appport', 'feltdb', 'distribution'], 'canonical order, de-duplicated');
  assert.deepEqual(resolveStack(['feltdb'], { exception: 'batch tool' }), ['feltdb'], 'only an explicit AppPort exception leaves AppPort out');
  assert.throws(() => resolveStack(['appport'], { exception: 'x' }), /has an AppPort exception, so the stack cannot include appport/);
  assert.throws(() => resolveStack(['postgres']), (e) => e instanceof StackError && /Unknown stack component: postgres\. Known: appport, feltdb, distribution, react, vite, typescript, authboundry, services, appboundry/.test(e.message));
  assert.throws(() => resolveStack('authboundry'), /AuthBoundry \(authboundry\) is not supported yet\. Blocker: .*authboundry serve.*never opened its listening port.*Next step: .*sign-in → \/auth\/session → \/auth\/authorize/);
  assert.throws(() => resolveStack('services'), /AppPort Services \(services\) is not supported yet\. Blocker: .*ServiceAuthorizer.*second authorization authority.*Next step: Support AuthBoundry first/);
  assert.throws(() => resolveStack('appboundry'), /AppBoundry \(appboundry\) is not supported yet\. Blocker: Not a broken package: .*contract-driven.*Next step: A separate integration design/);
  assert.throws(() => resolveStack({ feltdb: true }), /must be a list/);
});

test('a stack resolves to exactly its packages, and agents are told what to use and what not to add', () => {
  const only = stackDependencies(resolveStack());
  assert.deepEqual(Object.keys(only.dependencies), ['@appport/authorization', '@appport/core', '@appport/protocol', '@appport/schema', '@appport/server']);
  const felt = stackDependencies(resolveStack('feltdb'));
  assert.equal(felt.dependencies['@feltdb/core'], '0.11.9');
  assert.ok(!('@distribution-protocol/protocol' in felt.dependencies));
  assert.equal(stackDependencies(resolveStack('distribution')).dependencies['@distribution-protocol/protocol'], '1.0.0');
  const rules = stackRules(resolveStack('feltdb'));
  assert.match(rules, /Selected stack: AppPort \+ FeltDB/);
  assert.match(rules, /createFeltDB\(\{ namespace: '<app>', mode: 'local', path \}\)/);
  assert.match(rules, /sole writer/);
  assert.match(rules, /Do not add packages of unselected components: .*@distribution-protocol\/protocol.*@authboundry\/core.*@appport\/services.*@appport\/appboundry/);
  assert.doesNotMatch(stackRules(resolveStack()), /createFeltDB/, 'unselected rules are not given');
  const view = describeStack();
  assert.deepEqual(view.components.map((c) => [c.id, c.status]), [['appport', 'supported'], ['feltdb', 'supported'], ['distribution', 'supported'], ['react', 'supported'], ['vite', 'supported'], ['typescript', 'supported'], ['authboundry', 'unsupported'], ['services', 'unsupported'], ['appboundry', 'unsupported']]);
  assert.ok(view.components.filter((c) => c.status === 'unsupported').every((c) => c.blocker && c.next));
  assert.equal(STACK_IDS.length, 9);
});

test('runs record their stack: the default, an explicit selection that survives a rerun, and refusals before anything runs', async () => {
  const { factory } = setup();
  const plain = await factory.createRun({ idea: 'A habit tracker', provider: 'offline' });
  assert.deepEqual(plain.settings.stack, ['appport']);
  const felt = await factory.createRun({ idea: 'A habit tracker', provider: 'offline', settings: { stack: ['feltdb'], deploy: false } });
  assert.deepEqual(felt.settings.stack, ['appport', 'feltdb']);
  const again = await factory.rerun(felt.id);
  assert.deepEqual(again.settings.stack, ['appport', 'feltdb'], 'a rerun keeps the selection');
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', settings: { stack: ['services'] } }), /not supported yet\. Blocker:/);
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', settings: { stack: ['nope'] } }), /Unknown stack component/);
  const system = agentSystem({ ...felt, plan: { product: { name: 'x', summary: '' } } }, { id: 'core', role: 'engineer' }, '');
  assert.match(system, /Selected stack: AppPort \+ FeltDB/);
  assert.match(system, /AppPort-native application/);
});

test('the API and the CLI expose the stack, and refuse unsupported selections with the blocker', async () => {
  const be = await startBackend({ dataDir: tmpDir() });
  backends.push(be);
  const view = await (await fetch(`${be.url}/api/stack`)).json();
  assert.deepEqual(view.default, ['appport']);
  const bad = await fetch(`${be.url}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idea: 'x', provider: 'offline', settings: { stack: ['authboundry'] } }) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /AuthBoundry \(authboundry\) is not supported yet\. Blocker:/);
  const listed = await cli(['stack', '--json'], { backend: be });
  assert.equal(listed.code, 0, listed.err);
  assert.deepEqual(listed.json.components.map((c) => c.id), STACK_IDS);
  const text = await cli(['stack'], { backend: be });
  assert.match(text.out, /feltdb .*supported .*@feltdb\/core@0\.11\.9/);
  assert.match(text.out, /AppPort Services \(services\): @appport\/services 0\.4\.11 executes effects only after/);
  const r = await cli(['run', 'A habit tracker', '--new', '--stack', 'feltdb', '--detach', '--json'], { backend: be });
  assert.equal(r.code, 0, r.err + r.out);
  const stored = await (await fetch(`${be.url}/api/runs/${r.json.id}`)).json();
  assert.deepEqual((stored.run || stored).settings.stack, ['appport', 'feltdb']);
  const refused = await cli(['run', 'A habit tracker', '--new', '--stack', 'services', '--json'], { backend: be });
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /not supported yet\. Blocker: .*ServiceAuthorizer/);
});

// ── the three profiles, generated through the normal workflow ──────────────────────────────────

let appportOnly; // { run, root }
let feltdbApp; // { run, root }

test('AppPort only (default): no optional stack dependency is declared or installed', async () => {
  const { factory, store } = setup();
  const run = await factory.start((await factory.createRun({ idea: 'A habit tracker with daily check-ins', provider: 'offline', settings: { deploy: false } })).id);
  assert.equal(run.status, 'completed', JSON.stringify(run.checklist));
  const item = run.checklist.find((c) => c.id === 'stack');
  assert.equal(item.ok, true, item.detail);
  const root = store.workspaceDir(run.id);
  appportOnly = { run, root };
  const deps = Object.keys({ ...pkgOf(root).dependencies, ...pkgOf(root).devDependencies });
  assert.ok(deps.every((d) => d.startsWith('@appport/')), deps.join());
  for (const name of ['@feltdb/core', '@distribution-protocol/protocol', '@authboundry/core', '@appport/services', '@appport/appboundry']) assert.equal(installed(root, name), false, name);
});

test('AppPort + FeltDB: durable writes verified from a fresh process, read back by a restarted app; the app is the sole writer', async () => {
  const { factory, store } = setup();
  const run = await factory.start((await factory.createRun({ idea: 'A habit tracker with daily check-ins', provider: 'offline', settings: { stack: ['feltdb'], deploy: false } })).id);
  assert.equal(run.status, 'completed', JSON.stringify(run.checklist));
  assert.deepEqual(run.stackCheck.checks.map((c) => [c.id, c.ok]), [['stack-packages', true], ['stack-unselected-absent', true], ['feltdb-used', true], ['feltdb-durable-store', true], ['feltdb-sole-writer', true], ['feltdb-clean-shutdown', true], ['feltdb-flow', true], ['feltdb-flow-deployed', true]]);
  const root = store.workspaceDir(run.id);
  feltdbApp = { run, root };
  assert.match(fs.readFileSync(path.join(root, 'feltdb.flow'), 'utf8'), /app Tracker \{\s+collection Item \{/);
  assert.equal(pkgOf(root).dependencies['@feltdb/core'], '0.11.9');
  assert.equal(installed(root, '@distribution-protocol/protocol'), false);
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /Stack: AppPort \+ FeltDB[\s\S]*only writer[\s\S]*FELTDB_TELEMETRY=0/);

  const dataDir = tmpDir('feltdb-app-data-');
  const token = 'felt-token-h7k2m9';
  const app = await startApp(root, run.plan.deploy, { DATA_DIR: dataDir, APP_API_TOKEN: token });
  assert.ok(app.ok, app.error);
  // A second instance on the same data is refused while the first runs.
  const second = await startApp(root, run.plan.deploy, { DATA_DIR: dataDir, APP_API_TOKEN: token });
  assert.equal(second.ok, false, 'the app is the only writer of its DATA_DIR');
  const written = inApp(root, `${CLIENT}
const app = await connect(${JSON.stringify(app.base)}, ${JSON.stringify(token)});
const a = await app.call('items.create', { title: 'Persist me', notes: 'via AppPort' });
const b = await app.call('items.update', { id: a.item.id, done: true });
const c = await app.call('items.create', { title: 'And me' });
console.log(JSON.stringify({ a: b.item, c: c.item }));`);
  app.stop();
  await waitExit(app.child);

  // Independent of the app: a fresh process opens the app's FeltDB folder and reads the records.
  const namespace = fs.readFileSync(path.join(root, 'src', 'store.js'), 'utf8').match(/const NAMESPACE = '([^']+)'/)[1];
  const stored = inApp(root, `import fs from 'node:fs';
import { createFeltDB, parseFlowSpec, compileApplicationContract } from '@feltdb/core';
const spec = parseFlowSpec(fs.readFileSync('feltdb.flow', 'utf8'));
const db = createFeltDB({ namespace: ${JSON.stringify(namespace)}, mode: 'local', path: ${JSON.stringify(dataDir)} });
const items = await db.collection('Item').all();
const model = await db.application.get();
await db.close();
console.log(JSON.stringify({ items, model, flow: (await compileApplicationContract(spec, 'local', spec.app)).hashes.application }));`);
  const byId = Object.fromEntries(stored.items.map((i) => [i.id, i]));
  assert.equal(stored.items.length, 2);
  assert.equal(byId[written.a.id].title, 'Persist me');
  assert.equal(byId[written.a.id].done, true, 'the update is durable');
  assert.equal(byId[written.c.id].title, 'And me');
  // feltdb.flow is the store's active model, and every stored record has exactly the declared fields.
  assert.equal(stored.model.contract_hash, stored.flow);
  assert.equal(stored.model.version, 1);
  for (const i of stored.items) assert.deepEqual(Object.keys(i).filter((k) => k !== '__version').sort(), ['createdAt', 'done', 'id', 'notes', 'title', 'updatedAt']);
  assert.ok(fs.readdirSync(dataDir).some((f) => /^state\./.test(f)), 'FeltDB files are in DATA_DIR');
  assert.equal(fs.existsSync(path.join(dataDir, '.writer.lock')), false, 'the lock is released on shutdown');

  // A restarted app serves the same state through AppPort.
  const restarted = await startApp(root, run.plan.deploy, { DATA_DIR: dataDir, APP_API_TOKEN: token });
  assert.ok(restarted.ok, restarted.error);
  const listed = inApp(root, `${CLIENT}
const app = await connect(${JSON.stringify(restarted.base)}, ${JSON.stringify(token)});
console.log(JSON.stringify(await app.call('items.list', {})));`);
  assert.deepEqual(listed.items.map((i) => [i.id, i.done]).sort(), [[written.a.id, true], [written.c.id, false]].sort());
  restarted.stop();
});

test('AppPort + Distribution Protocol: real signing; tampered manifests, wrong artifacts and foreign keys are rejected', async () => {
  const { factory, store } = setup();
  const run = await factory.start((await factory.createRun({ idea: 'A release service for our CLI tool', provider: 'offline', settings: { stack: ['distribution'], deploy: false } })).id);
  assert.equal(run.status, 'completed', JSON.stringify(run.checklist));
  assert.ok(run.stackCheck.checks.every((c) => c.ok), JSON.stringify(run.stackCheck.checks));
  assert.ok(run.checklist.find((c) => c.id === 'appport').ok);
  const root = store.workspaceDir(run.id);
  assert.equal(pkgOf(root).dependencies['@distribution-protocol/protocol'], '1.0.0');
  assert.equal(installed(root, '@feltdb/core'), false);

  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const token = 'dist-token-p3l8w5';
  const app = await startApp(root, run.plan.deploy, { APP_API_TOKEN: token, PUBLISHER_PRIVATE_KEY: pem, PUBLISHER_ID: 'publisher://acme' });
  assert.ok(app.ok, app.error);
  const content = Buffer.from('cli binary v1.4.0').toString('base64');
  const out = inApp(root, `${CLIENT}
const app = await connect(${JSON.stringify(app.base)}, ${JSON.stringify(token)});
const { release } = await app.call('releases.publish', { name: 'mycli', version: '1.4.0', artifactId: 'mycli-any', content: ${JSON.stringify(content)} });
const tampered = structuredClone(release.release); tampered.manifest.product.version = '9.9.9';
console.log(JSON.stringify({
  release,
  verified: await app.call('releases.verify', { release: release.release, content: ${JSON.stringify(content)} }),
  tampered: await app.call('releases.verify', { release: tampered }),
  wrongBytes: await app.call('releases.verify', { release: release.release, content: Buffer.from('evil').toString('base64') }),
  anon: await code((await connect(${JSON.stringify(app.base)})).call('releases.publish', { name: 'x', version: '1.0.0', content: 'eA==' })),
  again: await code(app.call('releases.publish', { name: 'mycli', version: '1.4.0', content: ${JSON.stringify(content)} })),
}));`);
  assert.deepEqual(out.verified, { valid: true, reason: null });
  assert.equal(out.tampered.valid, false);
  assert.deepEqual(out.wrongBytes, { valid: false, reason: 'artifact bytes do not match the signed digest' });
  assert.deepEqual([out.anon, out.again], ['UNAUTHORIZED', 'CONFLICT']);
  // The bytes the app serves, verified independently with the package itself and pinned to our key.
  const served = Buffer.from(await (await fetch(`${app.base}/api/releases/mycli/1.4.0/artifact`)).arrayBuffer());
  const independent = inApp(root, `import { verifyRelease, verifyArtifactBytes, exportPublicKey, signRelease, generatePublisherKeypair } from '@distribution-protocol/protocol';
import { createPrivateKey, createPublicKey } from 'node:crypto';
const release = ${JSON.stringify(out.release.release)};
const ours = exportPublicKey(createPublicKey(createPrivateKey(${JSON.stringify(pem)})));
const bytes = Buffer.from(${JSON.stringify(served.toString('base64'))}, 'base64');
const foreign = signRelease(release.manifest, generatePublisherKeypair().privateKey, { keyId: 'other' });
console.log(JSON.stringify({ valid: verifyRelease(release).valid, ours: release.signature.publicKey === ours, bytes: verifyArtifactBytes(bytes, release.manifest.artifacts[0]), foreign }));`);
  assert.deepEqual([independent.valid, independent.ours, independent.bytes], [true, true, true]);
  assert.equal(served.toString(), 'cli binary v1.4.0');
  // A validly signed release by another key is not this publisher's.
  const foreign = await (await fetch(`${app.base}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ release: independent.foreign }) })).json();
  assert.deepEqual(foreign, { valid: false, reason: 'signed by a key that is not this publisher\'s' });
  assert.equal((await fetch(`${app.base}/api/releases`, { method: 'POST' })).status, 405, 'publishing is not possible over plain HTTP');
  app.stop();
});

test('AppPort + FeltDB + Distribution Protocol: signed releases are kept in FeltDB under feltdb.flow, verifiable from a fresh process and after a restart', async () => {
  const { factory, store } = setup();
  const run = await factory.start((await factory.createRun({ idea: 'A release service for our CLI tool that keeps every release', provider: 'offline', settings: { stack: ['feltdb', 'distribution'], deploy: false } })).id);
  assert.equal(run.status, 'completed', JSON.stringify(run.checklist));
  assert.deepEqual(run.settings.stack, ['appport', 'feltdb', 'distribution']);
  assert.deepEqual(run.stackCheck.checks.filter((c) => !c.ok), []);
  assert.deepEqual(run.stackCheck.checks.map((c) => c.id), ['stack-packages', 'stack-unselected-absent', 'feltdb-used', 'feltdb-durable-store', 'feltdb-sole-writer', 'feltdb-clean-shutdown', 'feltdb-flow', 'feltdb-flow-deployed', 'distribution-used']);
  assert.ok(run.checklist.find((c) => c.id === 'appport').ok);
  const root = store.workspaceDir(run.id);
  assert.deepEqual(Object.keys(pkgOf(root).dependencies).filter((d) => !d.startsWith('@appport/')).sort(), ['@distribution-protocol/protocol', '@feltdb/core']);
  assert.match(fs.readFileSync(path.join(root, 'feltdb.flow'), 'utf8'), /app Releases \{\s+collection Release \{/);

  const dataDir = tmpDir('full-stack-data-');
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const env = { DATA_DIR: dataDir, APP_API_TOKEN: 'full-token-q8v3z6', PUBLISHER_PRIVATE_KEY: pem, PUBLISHER_ID: 'publisher://acme' };
  const app = await startApp(root, run.plan.deploy, env);
  assert.ok(app.ok, app.error);
  const content = Buffer.from('cli binary v2.0.0').toString('base64');
  const published = inApp(root, `${CLIENT}
const app = await connect(${JSON.stringify(app.base)}, ${JSON.stringify(env.APP_API_TOKEN)});
console.log(JSON.stringify((await app.call('releases.publish', { name: 'mycli', version: '2.0.0', artifactId: 'mycli-any', content: ${JSON.stringify(content)} })).release));`);
  app.stop();
  await waitExit(app.child);

  // A fresh process: the release is in FeltDB as feltdb.flow declares it, and the package verifies the stored manifest and bytes.
  const stored = inApp(root, `import fs from 'node:fs';
import { createFeltDB, parseFlowSpec, compileApplicationContract } from '@feltdb/core';
import { verifyRelease, verifyArtifactBytes } from '@distribution-protocol/protocol';
const spec = parseFlowSpec(fs.readFileSync('feltdb.flow', 'utf8'));
const db = createFeltDB({ namespace: 'any', mode: 'local', path: ${JSON.stringify(dataDir)} });
const [r] = await db.collection('Release').all();
const model = await db.application.get();
await db.close();
console.log(JSON.stringify({ id: r.id, fields: Object.keys(r).filter((k) => k !== 'id' && k !== '__version').sort(), declared: spec.collections[0].fields.map((f) => f.name).sort(), release: r.release, valid: verifyRelease(r.release).valid, bytes: verifyArtifactBytes(Buffer.from(r.content, 'base64'), r.release.manifest.artifacts[0]), model: model.contract_hash, flow: (await compileApplicationContract(spec, 'local', spec.app)).hashes.application }));`);
  assert.equal(stored.id, 'mycli@2.0.0');
  assert.deepEqual(stored.fields, stored.declared);
  assert.deepEqual(stored.release, published.release);
  assert.deepEqual([stored.valid, stored.bytes], [true, true]);
  assert.equal(stored.model, stored.flow);

  // A restarted app serves and verifies the same release, and it is still immutable.
  const again = await startApp(root, run.plan.deploy, env);
  assert.ok(again.ok, again.error);
  const after = inApp(root, `${CLIENT}
const app = await connect(${JSON.stringify(again.base)}, ${JSON.stringify(env.APP_API_TOKEN)});
console.log(JSON.stringify({
  got: await app.call('releases.get', { name: 'mycli', version: '2.0.0' }),
  verified: await app.call('releases.verify', { release: ${JSON.stringify(published.release)}, content: ${JSON.stringify(content)} }),
  again: await code(app.call('releases.publish', { name: 'mycli', version: '2.0.0', content: ${JSON.stringify(content)} })),
}));`);
  assert.deepEqual(after.got.release, published);
  assert.deepEqual(after.verified, { valid: true, reason: null });
  assert.equal(after.again, 'CONFLICT');
  again.stop();
});

// ── the stack gate's negative cases ─────────────────────────────────────────────────────────────

async function gate(source, stack, edit) {
  const root = tmpDir('stack-gate-');
  fs.cpSync(source.root, root, { recursive: true, filter: (src) => !src.includes(`${path.sep}.home`) });
  edit(root);
  const home = path.join(root, '.home');
  fs.mkdirSync(home, { recursive: true });
  return checkStackConformance({
    ws: new Workspace(root),
    stack,
    tmpDir: home,
    launch: async (env, { timeoutMs = 15_000 } = {}) => {
      const r = await launchApp(root, source.run.plan.deploy, { env: { ...NO_TELEMETRY, ...env }, timeoutMs });
      if (r.ok) started.push(r.child);
      return { ok: r.ok, port: r.port, error: r.error, stop: () => r.ok && stopProcess(r.child) };
    },
  });
}
const failing = (g) => g.checks.filter((c) => !c.ok).map((c) => c.id);
const editJson = (root, rel, fn) => fs.writeFileSync(path.join(root, rel), JSON.stringify(fn(JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))), null, 2));

test('the stack gate fails when an unselected package is declared or installed, or a selected one is missing', async () => {
  assert.ok(appportOnly && feltdbApp, 'the profile tests ran first');
  const declared = await gate(appportOnly, ['appport'], (root) => editJson(root, 'package.json', (p) => ({ ...p, dependencies: { ...p.dependencies, '@feltdb/core': '0.11.9' } })));
  assert.deepEqual(failing(declared), ['stack-unselected-absent']);
  assert.match(declared.checks.find((c) => c.id === 'stack-unselected-absent').detail, /@feltdb\/core is declared but FeltDB is not selected/);
  const sneaked = await gate(appportOnly, ['appport'], (root) => fs.cpSync(path.join(feltdbApp.root, 'node_modules', '@feltdb'), path.join(root, 'node_modules', '@feltdb'), { recursive: true }));
  assert.match(sneaked.checks.find((c) => c.id === 'stack-unselected-absent').detail, /@feltdb\/core is installed but FeltDB is not selected/);
  const missing = await gate(feltdbApp, ['appport', 'feltdb'], (root) => editJson(root, 'package.json', (p) => {
    delete p.dependencies['@feltdb/core'];
    return p;
  }));
  assert.ok(failing(missing).includes('stack-packages'));
  assert.match(missing.checks.find((c) => c.id === 'stack-packages').detail, /@feltdb\/core \(FeltDB\) is not declared/);
  const old = await gate(feltdbApp, ['appport', 'feltdb'], (root) => editJson(root, 'node_modules/@feltdb/core/package.json', (p) => ({ ...p, version: '0.10.3' })));
  assert.match(old.checks.find((c) => c.id === 'stack-packages').detail, /@feltdb\/core@0\.10\.3 is not compatible with 0\.11\.9/);
});

test('the stack gate fails a FeltDB app that does not enforce a single writer, or keeps its state elsewhere', async () => {
  const unlocked = await gate(feltdbApp, ['appport', 'feltdb'], (root) => {
    const f = path.join(root, 'src', 'store.js');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('this.release = lockDir(this.dir);', 'this.release = () => {};'));
  });
  assert.deepEqual(failing(unlocked), ['feltdb-sole-writer']);
  const elsewhere = await gate(feltdbApp, ['appport', 'feltdb'], (root) => {
    const f = path.join(root, 'src', 'store.js');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("path: dir = process.env.DATA_DIR || './data',", "path: dir = './other-data',"));
  });
  assert.ok(failing(elsewhere).includes('feltdb-durable-store'), JSON.stringify(elsewhere.checks));
});

test('the stack gate fails a FeltDB app whose feltdb.flow is missing, invalid, or not the model it deployed', async () => {
  const missing = await gate(feltdbApp, ['appport', 'feltdb'], (root) => fs.rmSync(path.join(root, 'feltdb.flow')));
  assert.ok(failing(missing).includes('feltdb-flow'), JSON.stringify(missing.checks));
  assert.match(missing.checks.find((c) => c.id === 'feltdb-flow').detail, /feltdb\.flow is missing/);
  const invalid = await gate(feltdbApp, ['appport', 'feltdb'], (root) => {
    const f = path.join(root, 'feltdb.flow');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('done: boolean', 'done: bool'));
  });
  assert.ok(failing(invalid).includes('feltdb-flow'), JSON.stringify(invalid.checks));
  assert.match(invalid.checks.find((c) => c.id === 'feltdb-flow').detail, /Unsupported field type bool/);
  assert.ok(failing(invalid).includes('feltdb-durable-store'), 'an app with an invalid flow does not start');
  // An app that ships feltdb.flow but deploys another model (here: a hard-coded one with an extra field) fails.
  const other = await gate(feltdbApp, ['appport', 'feltdb'], (root) => {
    const f = path.join(root, 'src', 'store.js');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("flow = loadFlow() } = {}) {", "flow = loadFlow() } = {}) {\n    flow = { ...flow, collections: flow.collections.map((c) => ({ ...c, fields: [...c.fields, { name: 'extra', type: 'text', optional: true }] })) };"));
  });
  assert.deepEqual(failing(other), ['feltdb-flow-deployed']);
  assert.match(other.checks.find((c) => c.id === 'feltdb-flow-deployed').detail, /is not feltdb\.flow/);
});

test('generated app sizes stay what the stack says (footprint record for docs/stack-profiles.md)', () => {
  const size = (root) => Number(execFileSync('du', ['-sk', path.join(root, 'node_modules')]).toString().split('\t')[0]);
  const count = (root) => fs.readdirSync(path.join(root, 'node_modules')).flatMap((d) => (d.startsWith('@') ? fs.readdirSync(path.join(root, 'node_modules', d)).map((x) => `${d}/${x}`) : d.startsWith('.') ? [] : [d])).length;
  assert.equal(count(appportOnly.root), 7);
  assert.equal(count(feltdbApp.root), 8);
  assert.ok(size(feltdbApp.root) > size(appportOnly.root) * 3, 'FeltDB is the large one (it ships WASM)');
});
