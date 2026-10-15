// Prove, independently of the factory's own gates, that a generated AppPort + FeltDB + Distribution Protocol app implements each
// component correctly, and that feltdb.flow is the authority for what its store holds.
//
//   npm run prove:stack -- [--out docs/stack-proof.md] [--appport-cli <path to the published appport CLI>]
//
// It generates the app through the normal factory workflow (offline agents, no model; npm installs the pinned packages from the
// registry), then runs the app and checks each component from outside. Every check records what was done and what was observed;
// the report is written as Markdown and the process exits non-zero if any check fails. The official AppPort conformance run
// needs the `appport` CLI (npm package appport, not a dependency of this repository); without --appport-cli it is reported as
// not run. Telemetry of @feltdb/core is turned off for everything this script runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: { out: { type: 'string' }, 'appport-cli': { type: 'string' } } });
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = opts.out ? path.resolve(opts.out) : null;
const APPPORT_CLI = opts['appport-cli'] ? path.resolve(opts['appport-cli']) : null;
process.env.FELTDB_TELEMETRY = '0';
const { loadConfig } = await import(`${REPO}/src/config.js`);
const { RunStore } = await import(`${REPO}/src/store.js`);
const { Factory } = await import(`${REPO}/src/factory.js`);
const { PreviewManager, launchApp, stopProcess } = await import(`${REPO}/src/deploy.js`);

const results = [];
const section = (name) => results.push({ section: name });
const check = (id, ok, evidence) => {
  results.push({ id, ok: ok === null ? null : Boolean(ok), evidence });
  console.log(`${ok === null ? '-' : ok ? '✓' : '✗'} ${id}: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`.slice(0, 400));
};
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ── 1. Generate the app through the normal factory workflow ─────────────────────────────────────
section('1. Generation through the factory (normal workflow, offline agents, no model)');
const previews = new PreviewManager({ max: 2 });
const cfg = loadConfig({ dataDir: tmp('prove-data-') });
const store = new RunStore(cfg.dataDir);
const factory = new Factory({ cfg, store, previews });
const IDEA = 'A release service for our CLI tool that keeps every release';
const created = await factory.createRun({ idea: IDEA, provider: 'offline', settings: { stack: ['appport', 'feltdb', 'distribution'] } });
const t0 = Date.now();
const run = await factory.start(created.id);
const root = store.workspaceDir(run.id);
check('run-completed', run.status === 'completed', `run ${run.id}: status ${run.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s, stack ${JSON.stringify(run.settings.stack)}`);
for (const c of run.checklist) check(`checklist:${c.id}`, c.ok, c.detail);
for (const c of run.stackCheck.checks) check(`stack-gate:${c.id}`, c.ok, c.detail);
for (const c of run.appport.checks) check(`appport-gate:${c.id}`, c.ok, c.detail);
previews.stopAll();

// ── 2. Dependency closure ──────────────────────────────────────────────────────────────────────
section('2. Dependency closure: exactly the selected components');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stackJson = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'stack.json'), 'utf8'));
const expected = {};
for (const id of ['appport', 'feltdb', 'distribution']) Object.assign(expected, stackJson.components[id].dependencies, stackJson.components[id].devDependencies);
const declared = { ...pkg.dependencies, ...pkg.devDependencies };
check('declared-equals-stack', JSON.stringify(Object.entries(declared).sort()) === JSON.stringify(Object.entries(expected).sort()), declared);
const top = fs.readdirSync(path.join(root, 'node_modules')).flatMap((d) => (d.startsWith('@') ? fs.readdirSync(path.join(root, 'node_modules', d)).map((x) => `${d}/${x}`) : d.startsWith('.') ? [] : [d]));
const installedVersions = Object.fromEntries(top.map((n) => [n, JSON.parse(fs.readFileSync(path.join(root, 'node_modules', n, 'package.json'), 'utf8')).version]));
check('installed-equals-stack', JSON.stringify(Object.entries(installedVersions).sort()) === JSON.stringify(Object.entries(expected).sort()), installedVersions);
const unsupported = ['@authboundry/core', '@authboundry/bridge', '@appport/services', '@appport/appboundry'];
check('unsupported-absent', unsupported.every((n) => !declared[n] && !fs.existsSync(path.join(root, 'node_modules', n))), `absent: ${unsupported.join(', ')} (selecting them is refused: ${['authboundry', 'services', 'appboundry'].map((id) => stackJson.components[id].status).join(', ')})`);
const ls = spawnSync('npm', ['ls', '--all', '--json'], { cwd: root, encoding: 'utf8' });
check('npm-ls-clean', ls.status === 0, `npm ls --all exit ${ls.status}${ls.status ? `: ${ls.stderr.slice(0, 200)}` : ''}`);

// Which source files use which package (static evidence; the behaviour is proved below).
const imports = {};
for (const dir of ['src', 'test']) for (const f of fs.readdirSync(path.join(root, dir))) {
  const text = fs.readFileSync(path.join(root, dir, f), 'utf8');
  const found = [...text.matchAll(/from '(@[a-z-]+\/[a-z-/]+)'/g)].map((m) => m[1]);
  if (found.length) imports[`${dir}/${f}`] = [...new Set(found)];
}
check('source-uses', imports['src/store.js']?.includes('@feltdb/core') && imports['src/signing.js']?.includes('@distribution-protocol/protocol') && imports['src/appport.js']?.includes('@appport/core'), imports);

// ── 3. The app's own test suite ────────────────────────────────────────────────────────────────
section('3. The generated app\'s own tests');
const tests = spawnSync('node', ['--test'], { cwd: root, encoding: 'utf8', env: { ...process.env, FELTDB_TELEMETRY: '0' } });
const tally = (k) => Number((tests.stdout.match(new RegExp(`# ${k} (\\d+)`)) || [])[1]);
check('app-tests', tests.status === 0, `node --test: ${tally('pass')} passed, ${tally('fail')} failed (files: ${fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).join(', ')})`);

// Helpers to run the app and act as an agent with the published client inside the generated app.
const started = [];
const start = async (env, dir = root) => {
  const r = await launchApp(dir, run.plan.deploy, { env: { FELTDB_TELEMETRY: '0', ...env }, timeoutMs: 20_000 });
  if (r.ok) started.push(r.child);
  return { ...r, base: `http://127.0.0.1:${r.port}`, stop: () => r.ok && stopProcess(r.child) };
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Stop the app and wait until the process holding the data lock (the app itself, not the sh wrapper) is gone. */
const stopAndWait = async (a, dir) => {
  const lock = path.join(dir, '.writer.lock');
  const pid = fs.existsSync(lock) ? Number(fs.readFileSync(lock, 'utf8')) : 0;
  a.stop();
  for (let i = 0; i < 100 && pid && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return pid;
};
const inApp = (body) => {
  const file = path.join(root, '.home', `prove-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  const r = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', env: { ...process.env, FELTDB_TELEMETRY: '0' } });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};
const CLIENT = `import { AppPort } from '@appport/client';
import { createHttpTransport } from '@appport/transport-http';
const connect = (origin, token) => AppPort.discover({ origin, ...(token ? { headers: { authorization: 'Bearer ' + token } } : {}), transports: { http: (o) => createHttpTransport(o) } });
const code = (p) => p.then(() => 'OK', (e) => e.code);
`;
const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
const FULL = 'prove-full-token-k3j9';
const READ = 'prove-read-token-x7q2';
const dataDir = tmp('prove-app-data-');
const env = { DATA_DIR: dataDir, APP_API_TOKEN: FULL, APP_READ_TOKEN: READ, PUBLISHER_PRIVATE_KEY: pem, PUBLISHER_ID: 'publisher://acme', PUBLISHER_KEY_ID: 'acme-1' };
const artifact = Buffer.from('mycli 2.0.0 linux binary (proof)');

// ── 4. AppPort ─────────────────────────────────────────────────────────────────────────────────
section('4. AppPort: discovery, invocation, authorization, exposure');
const app = await start(env);
check('app-starts', app.ok, app.ok ? `healthy at ${app.base}` : app.error);
const conf = !APPPORT_CLI ? null : spawnSync(APPPORT_CLI, ['conformance', '--url', app.base], { encoding: 'utf8', timeout: 60_000, input: '' });
const confText = `${conf?.stdout || ''}`.replace(/\u001b\[[0-9;]*m/g, '');
const levels = [...confText.matchAll(/Level (\d)\s+(\w+)\s*(PASS|FAIL)/g)].map((m) => `L${m[1]} ${m[2]} ${m[3]}`);
const summary = (confText.match(/Summary: .*/) || [''])[0];
if (!conf) check('official-conformance-protocol-discovery', null, 'not run: pass --appport-cli <path to the published appport CLI> to run `appport conformance --url`');
else check('official-conformance-protocol-discovery', /Level 1\s+Protocol\s*PASS/.test(confText) && /Level 2\s+Discovery\s*PASS/.test(confText), `appport conformance --url (published appport CLI): ${levels.join(' · ')} · ${summary}`);
const ap = inApp(`${CLIENT}
const origin = ${JSON.stringify(app.base)};
const wk = await (await fetch(origin + '/.well-known/appport')).json();
const manifest = await (await fetch(origin + '/appport/manifest')).json();
const full = await connect(origin, ${JSON.stringify(FULL)});
const reader = await connect(origin, ${JSON.stringify(READ)});
const anon = await connect(origin);
const published = await full.call('releases.publish', { name: 'mycli', version: '2.0.0', artifactId: 'mycli-linux', content: ${JSON.stringify(artifact.toString('base64'))} });
console.log(JSON.stringify({
  wellKnown: wk,
  caps: manifest.capabilities.filter((c) => !c.name.startsWith('appport.')).map((c) => ({ name: c.name, effect: c.effect, auth: c.authorizationContract })),
  manifestHasSecrets: /PRIVATE KEY|${FULL}|${READ}/.test(JSON.stringify(manifest)),
  published,
  list: await full.call('releases.list', {}),
  get: await full.call('releases.get', { name: 'mycli', version: '2.0.0' }),
  anonList: await code(anon.call('releases.list', {})),
  anonPublish: await code(anon.call('releases.publish', { name: 'x', version: '1.0.0', content: 'eA==' })),
  wrongToken: await code((await connect(origin, 'not-a-token')).call('releases.list', {})),
  readerList: await code(reader.call('releases.list', {})),
  readerPublish: await code(reader.call('releases.publish', { name: 'x', version: '1.0.0', content: 'eA==' })),
  unexposed: await code(full.call('releases.delete', { name: 'mycli', version: '2.0.0' })),
  invalid: await code(full.call('releases.publish', { name: 'mycli', version: 'latest', content: 'eA==' })),
  duplicate: await code(full.call('releases.publish', { name: 'mycli', version: '2.0.0', content: 'eA==' })),
  missing: await code(full.call('releases.get', { name: 'mycli', version: '9.9.9' })),
}));`);
check('discovery', ap.wellKnown.protocol === 'appport/1' && ap.wellKnown.transports.some((t) => t.kind === 'http'), ap.wellKnown);
check('capabilities-declared', JSON.stringify(ap.caps.map((c) => [c.name, c.effect, c.auth.required, c.auth.scopes]).sort()) === JSON.stringify([['releases.get', 'observation', true, ['releases.read']], ['releases.list', 'observation', true, ['releases.read']], ['releases.publish', 'consequential', true, ['releases.write']], ['releases.verify', 'observation', true, ['releases.read']]]), ap.caps.map((c) => `${c.name} (${c.effect}, ${c.auth.scopes})`).join(', '));
check('no-secrets-in-manifest', !ap.manifestHasSecrets, 'the manifest contains no token and no key material');
check('invocation', ap.published.release.name === 'mycli' && ap.list.releases.length === 1 && JSON.stringify(ap.get) === JSON.stringify(ap.published), 'releases.publish → releases.list/get return the same release');
check('authorization', ap.anonList === 'UNAUTHORIZED' && ap.anonPublish === 'UNAUTHORIZED' && ap.wrongToken === 'UNAUTHORIZED' && ap.readerList === 'OK' && ap.readerPublish === 'FORBIDDEN', { anonList: ap.anonList, anonPublish: ap.anonPublish, wrongToken: ap.wrongToken, readerList: ap.readerList, readerPublish: ap.readerPublish });
check('exposure-and-rules', ['UNKNOWN_CAPABILITY', 'FORBIDDEN'].includes(ap.unexposed) && ap.invalid === 'INVALID_INPUT' && ap.duplicate === 'CONFLICT' && ap.missing === 'NOT_FOUND', { unexposedDelete: ap.unexposed, invalidVersion: ap.invalid, duplicate: ap.duplicate, missing: ap.missing });
const restPublish = await fetch(`${app.base}/api/releases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('no-write-around-appport', restPublish.status === 405, `POST /api/releases → ${restPublish.status} (publishing exists only as the authorized capability)`);
const served = Buffer.from(await (await fetch(`${app.base}/api/releases/mycli/2.0.0/artifact`)).arrayBuffer());
const restView = (await (await fetch(`${app.base}/api/releases/mycli/2.0.0`)).json()).release;
const second = await start(env);
check('feltdb-sole-writer', !second.ok, second.ok ? 'a second instance started on the same DATA_DIR' : `a second instance on the same DATA_DIR was refused (${second.error}); lock file present: ${fs.existsSync(path.join(dataDir, '.writer.lock'))}`);
const appPid = await stopAndWait(app, dataDir);

// ── 5. FeltDB ──────────────────────────────────────────────────────────────────────────────────
section('5. FeltDB: durable, authoritative, read back independently');
check('clean-shutdown', appPid > 0 && !alive(appPid) && !fs.existsSync(path.join(dataDir, '.writer.lock')), `after SIGTERM the app process (pid ${appPid}, the lock holder) exited, closed FeltDB and released ${path.join(dataDir, '.writer.lock')}`);
const namespace = fs.readFileSync(path.join(root, 'src', 'store.js'), 'utf8').match(/const NAMESPACE = '([^']+)'/)[1];
const READ_STORE = `import fs from 'node:fs';
import { createFeltDB, parseFlowSpec, compileApplicationContract } from '@feltdb/core';
const spec = parseFlowSpec(fs.readFileSync('feltdb.flow', 'utf8'));
const flowHash = (await compileApplicationContract(spec, 'local', spec.app)).hashes.application;
const db = createFeltDB({ namespace: ${JSON.stringify(namespace)}, mode: 'local', path: ${JSON.stringify(dataDir)} });
const releases = await db.collection('Release').all();
const model = await db.application.get();
const runtime = db.runtime();
await db.close();
console.log(JSON.stringify({ releases, model: { version: model.version, hash: model.contract_hash, app: model.application_id }, flowHash, declared: spec.collections.map((c) => [c.name, c.fields.map((f) => f.name + ':' + f.type + (f.optional ? '?' : ''))]), runtime }));`;
const felt = inApp(READ_STORE);
check('feltdb-files', fs.readdirSync(dataDir).some((f) => /^state\./.test(f)), `files in DATA_DIR: ${fs.readdirSync(dataDir).join(', ')}`);
check('feltdb-runtime', felt.runtime.storage === 'file' && felt.runtime.durable === true, felt.runtime);
check('feltdb-holds-the-release', felt.releases.length === 1 && felt.releases[0].id === 'mycli@2.0.0' && JSON.stringify(felt.releases[0].release) === JSON.stringify(ap.published.release.release), `a fresh process, with the app stopped, reads ${felt.releases.length} release from FeltDB: ${felt.releases[0]?.id}`);
check('single-source-of-truth', JSON.stringify(restView) === JSON.stringify(ap.published.release) && Buffer.from(felt.releases[0].content, 'base64').equals(served), 'the AppPort result, the HTTP API view and the FeltDB record are the same release, and the served bytes are the stored bytes');
const restarted = await start(env);
const after = inApp(`${CLIENT}
const app = await connect(${JSON.stringify(restarted.base)}, ${JSON.stringify(FULL)});
console.log(JSON.stringify({ get: await app.call('releases.get', { name: 'mycli', version: '2.0.0' }), duplicate: await code(app.call('releases.publish', { name: 'mycli', version: '2.0.0', content: 'eA==' })), verify: await app.call('releases.verify', { release: (await app.call('releases.get', { name: 'mycli', version: '2.0.0' })).release.release, content: ${JSON.stringify(artifact.toString('base64'))} }) }));`);
check('survives-restart', JSON.stringify(after.get) === JSON.stringify(ap.published), 'a restarted app serves the identical release from FeltDB');
check('immutable-across-restart', after.duplicate === 'CONFLICT', `publishing mycli 2.0.0 again after the restart → ${after.duplicate}`);
check('still-verifies-after-restart', after.verify.valid === true, after.verify);
await stopAndWait(restarted, dataDir);

// ── 5b. feltdb.flow ────────────────────────────────────────────────────────────────────────────
section('5b. feltdb.flow is the authority for what the store holds');
const flowSource = fs.readFileSync(path.join(root, 'feltdb.flow'), 'utf8');
const validate = spawnSync(path.join(root, 'node_modules', '.bin', 'feltdb'), ['validate', 'feltdb.flow'], { cwd: root, encoding: 'utf8', env: { ...process.env, FELTDB_TELEMETRY: '0' } });
check('flow-file', validate.status === 0, `feltdb.flow at the project root declares ${JSON.stringify(felt.declared)}; \`feltdb validate feltdb.flow\` (the package's CLI) → exit ${validate.status}: ${(validate.stdout + validate.stderr).trim()}`);
check('flow-deployed-as-active-model', felt.model.hash === felt.flowHash && felt.model.version === 1, `a fresh process reads the store's active model: ${felt.model.app} v${felt.model.version}, contract ${felt.model.hash}; feltdb.flow compiles to ${felt.flowHash}`);
const declaredFields = felt.declared[0][1].map((f) => f.split(':')[0]).sort();
const storedFields = Object.keys(felt.releases[0]).filter((k) => k !== 'id' && k !== '__version').sort();
check('records-are-what-the-flow-declares', felt.declared.length === 1 && felt.declared[0][0] === 'Release' && JSON.stringify(storedFields) === JSON.stringify(declaredFields), `the stored release has exactly the declared fields: ${storedFields.join(', ')}`);
// FeltDB's local runtime does not check records against the deployed model; this is why the app checks every write itself.
const limit = inApp(`import fs from 'node:fs';
import { createFeltDB, parseFlowSpec } from '@feltdb/core';
const db = createFeltDB({ namespace: 'probe', mode: 'local', path: ${JSON.stringify(tmp('prove-limit-'))} });
await db.deployFlowSpec(parseFlowSpec(fs.readFileSync('feltdb.flow', 'utf8')));
let accepted = true;
try { await db.collection('Undeclared').insert({ anything: 1 }, 'x'); await db.collection('Release').insert({ size: 'not a number' }, 'y'); } catch { accepted = false; }
await db.close();
console.log(JSON.stringify({ accepted }));`);
check('feltdb-runtime-does-not-check-records', limit.accepted === true, `observed with @feltdb/core ${installedVersions['@feltdb/core']}: after deployFlowSpec, raw FeltDB still accepts an undeclared collection and an ill-typed record (${limit.accepted ? 'accepted' : 'refused'}); so the generated app checks every record against the flow (src/flow.js recordCheck) before it writes`);
// Variants of the generated app with a changed feltdb.flow (copies; the generated app itself is not touched).
const variant = (edit) => {
  const dir = tmp('prove-variant-');
  fs.cpSync(root, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.home`) });
  fs.writeFileSync(path.join(dir, 'feltdb.flow'), edit(flowSource));
  return dir;
};
/** Why an app variant refused to start: its own last stderr line (it exits before listening, so this returns quickly). */
const whyNot = (dir, e = env) => {
  const r = spawnSync(process.execPath, ['src/app.js'], { cwd: dir, encoding: 'utf8', timeout: 15_000, env: { ...process.env, FELTDB_TELEMETRY: '0', PORT: '0', ...e } });
  return `exit ${r.status}: ${r.stderr.trim().split('\n').filter((l) => /Error|cannot start/.test(l)).slice(-1)[0] || r.stderr.trim().split('\n').pop()}`;
};
const invalidDir = variant((f) => f.replace('size: integer', 'size: int'));
const invalidApp = await start(env, invalidDir);
check('invalid-flow-refused', !invalidApp.ok, invalidApp.ok ? 'the app started with an invalid feltdb.flow' : `with \`size: int\` (not a FlowSpec type) the app refuses to start (${whyNot(invalidDir)})`);
// A flow that no longer declares a field the store writes: the app starts on fresh data, but every such write is refused.
const freshData = tmp('prove-narrow-data-');
const narrowApp = await start({ ...env, DATA_DIR: freshData }, variant((f) => f.replace(/^\s*mediaType: text\n/m, '')));
const narrow = narrowApp.ok ? inApp(`${CLIENT}
const app = await connect(${JSON.stringify(narrowApp.base)}, ${JSON.stringify(FULL)});
let error = null;
try { await app.call('releases.publish', { name: 'x', version: '1.0.0', content: 'eA==' }); } catch (e) { error = { code: e.code, message: e.message }; }
console.log(JSON.stringify({ error, list: await app.call('releases.list', {}) }));`) : null;
if (narrowApp.ok) await stopAndWait(narrowApp, freshData);
check('writes-checked-against-flow', narrow && narrow.error && narrow.list.releases.length === 0, narrow ? `with mediaType removed from feltdb.flow, releases.publish is refused (${JSON.stringify(narrow.error)}) and nothing is stored` : `the variant did not start: ${narrowApp.error}`);
// On the proof's data (one release, model v1): a destructive change is refused, an additive one becomes model v2.
const destructiveDir = variant((f) => f.replace(/^\s*content: text\n/m, ''));
const destructiveApp = await start(env, destructiveDir);
const destructiveWhy = destructiveApp.ok ? '' : whyNot(destructiveDir);
const afterDestructive = inApp(READ_STORE);
check('destructive-change-refused', !destructiveApp.ok && afterDestructive.releases.length === 1 && afterDestructive.model.version === 1 && afterDestructive.model.hash === felt.model.hash, destructiveApp.ok ? 'the app started after removing a declared field' : `removing \`content\` from feltdb.flow: the app refuses to start (${destructiveWhy}); the store still holds 1 release under model v${afterDestructive.model.version}, unchanged`);
const additiveDir = variant((f) => f.replace(/^(\s*)content: text\n/m, '$1content: text\n$1notes: text?\n'));
const additiveApp = await start(env, additiveDir);
const additiveGet = additiveApp.ok ? inApp(`${CLIENT}
const app = await connect(${JSON.stringify(additiveApp.base)}, ${JSON.stringify(FULL)});
console.log(JSON.stringify(await app.call('releases.get', { name: 'mycli', version: '2.0.0' })));`) : null;
if (additiveApp.ok) await stopAndWait(additiveApp, dataDir);
const afterAdditive = inApp(READ_STORE);
check('additive-change-deployed', additiveApp.ok && afterAdditive.model.version === 2 && afterAdditive.model.hash !== felt.model.hash && JSON.stringify(additiveGet) === JSON.stringify(ap.published), additiveApp.ok ? `adding an optional \`notes: text?\`: the app starts, the store's active model becomes v${afterAdditive.model.version} (${afterAdditive.model.hash.slice(0, 19)}…), and the release is served unchanged` : additiveApp.error);

// ── 6. Distribution Protocol ───────────────────────────────────────────────────────────────────
section('6. Distribution Protocol: real signatures, verified with the package itself');
const dp = inApp(`import { verifyRelease, verifyArtifactBytes, exportPublicKey, signRelease, generatePublisherKeypair } from '@distribution-protocol/protocol';
import { createPrivateKey, createPublicKey } from 'node:crypto';
const stored = ${JSON.stringify(felt.releases[0])};
const release = stored.release;
const bytes = Buffer.from(${JSON.stringify(served.toString('base64'))}, 'base64');
const ours = exportPublicKey(createPublicKey(createPrivateKey(${JSON.stringify(pem)})));
const tampered = structuredClone(release); tampered.manifest.product.version = '9.9.9';
const foreign = signRelease(release.manifest, generatePublisherKeypair().privateKey, { keyId: 'attacker' });
console.log(JSON.stringify({
  manifest: { protocol: release.manifest.protocol, product: release.manifest.product, publisher: release.manifest.publisher, artifact: release.manifest.artifacts[0] },
  signature: { algorithm: release.signature.algorithm, keyId: release.signature.keyId },
  valid: verifyRelease(release), ours: release.signature.publicKey === ours,
  bytes: verifyArtifactBytes(bytes, release.manifest.artifacts[0]),
  tampered: verifyRelease(tampered), wrongBytes: verifyArtifactBytes(Buffer.from('evil'), release.manifest.artifacts[0]),
  foreign, foreignValid: verifyRelease(foreign).valid,
}));`);
check('signed-release', dp.valid.valid === true && dp.signature.algorithm === 'ed25519' && dp.manifest.protocol === 'distribution/1', `verifyRelease → ${JSON.stringify(dp.valid)}; ${dp.signature.algorithm}, keyId ${dp.signature.keyId}; product ${dp.manifest.product.id} ${dp.manifest.product.version}; publisher ${dp.manifest.publisher.id}`);
check('signed-by-our-publisher', dp.ours, 'the signature\'s public key is the one derived from PUBLISHER_PRIVATE_KEY');
check('artifact-bytes-match', dp.bytes === true, `the served bytes (${artifact.length} B) match the signed digest ${dp.manifest.artifact.digest}`);
check('tampered-rejected-by-package', dp.tampered.valid === false, dp.tampered);
check('wrong-bytes-rejected-by-package', dp.wrongBytes === false, 'verifyArtifactBytes(other bytes) → false');
const verifier = await start({ ...env, DATA_DIR: tmp('prove-verifier-') });
const post = async (body) => (await fetch(`${verifier.base}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const appOk = await post({ release: felt.releases[0].release, content: artifact.toString('base64') });
const appTampered = await post({ release: { ...felt.releases[0].release, manifest: { ...felt.releases[0].release.manifest, product: { ...felt.releases[0].release.manifest.product, version: '9.9.9' } } } });
const appWrong = await post({ release: felt.releases[0].release, content: Buffer.from('evil').toString('base64') });
const appForeign = await post({ release: dp.foreign });
check('app-verifies-genuine', appOk.valid === true, appOk);
check('app-rejects-tampered', appTampered.valid === false, appTampered);
check('app-rejects-wrong-bytes', appWrong.valid === false, appWrong);
check('app-rejects-foreign-key', dp.foreignValid === true && appForeign.valid === false, `a release signed by another key has a valid signature of its own (${dp.foreignValid}) and the app rejects it: ${JSON.stringify(appForeign)}`);
verifier.stop();

// ── 7. Components not in the app ───────────────────────────────────────────────────────────────
section('7. Components that are not (and cannot yet be) in the app');
const refused = {};
const { resolveStack } = await import(`${REPO}/src/stack.js`);
for (const id of ['authboundry', 'services', 'appboundry']) {
  try {
    resolveStack(['appport', 'feltdb', 'distribution', id]);
    refused[id] = 'ACCEPTED';
  } catch (e) {
    refused[id] = e.message;
  }
}
check('unsupported-refused', Object.values(refused).every((m) => /not supported yet\. Blocker:/.test(m)), refused);

for (const c of started) stopProcess(c);
const failed = results.filter((r) => r.id && r.ok === false);
const notRun = results.filter((r) => r.id && r.ok === null);
const total = results.filter((r) => r.id).length;
const md = [
  '# Proof: an AppPort + FeltDB + Distribution Protocol app generated by the factory',
  '',
  `Produced by \`npm run prove:stack\` on ${new Date().toISOString().slice(0, 10)} (Node ${process.version}). Generated workspace: \`${root}\` (run ${run.id}).`,
  '',
  `**${total} checks: ${total - failed.length - notRun.length} passed, ${failed.length} failed, ${notRun.length} not run.**`,
  '',
];
for (const r of results) {
  if (r.section) md.push('', `## ${r.section}`, '', '| Check | Result | Evidence |', '| --- | --- | --- |');
  else md.push(`| \`${r.id}\` | ${r.ok === null ? 'not run' : r.ok ? 'pass' : '**FAIL**'} | ${(typeof r.evidence === 'string' ? r.evidence : JSON.stringify(r.evidence)).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 900)} |`);
}
if (OUT) fs.writeFileSync(OUT, `${md.join('\n')}\n`);
console.log(`\n${total} checks: ${failed.length} failed, ${notRun.length} not run${OUT ? ` → ${OUT}` : ''}`);
process.exit(failed.length ? 1 : 0);
