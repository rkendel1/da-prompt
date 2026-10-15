// The application specification (src/appspec.js), the technology catalog (templates/catalog.json), compatibility validation,
// the selector's option model, and the new and existing lifecycles through the real factory with the offline agents.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { blockNetwork } from './offline-guard.js';
import { makeRepo, makeRoot, dirId, setup, NODE_FILES, PY_FILES } from './project-helpers.js';
import { startBackend, cli } from './cli-helpers.js';
import { tmpDir } from './helpers.js';
import { EXIT } from '../src/cli/core.js';
import { STACK_COMPONENTS } from '../src/stack.js';
import { inspectProject } from '../src/project.js';
import { Workspace } from '../src/sandbox.js';
import {
  SPEC_VERSION, FIELDS, SpecError, normalizeSpec, validateSpec, optionStates, toggle, specSummary, stackOf, specFromStack, describeCatalog, catalogEntry,
  observeApplication, planReconciliation, planContext, specEvidence, verifyCommands, capabilityGraph, compareCapabilities, profileSpec,
} from '../src/appspec.js';

blockNetwork();
const CATALOG = JSON.parse(fs.readFileSync(new URL('../templates/catalog.json', import.meta.url), 'utf8'));
const spec = (s, o) => normalizeSpec(s, o);
const codes = (v) => v.diagnostics.filter((d) => d.level === 'error').map((d) => `${d.code}:${d.selections[0] ?? ''}`);
const REACT = { architecture: 'fullstack-web', frontend: 'react', tooling: 'vite', languages: ['javascript', 'typescript'], runtimes: ['node', 'browser'], backend: 'node-http', data: ['data-none'], capabilities: ['appport'], production: ['automated-tests'] };

// ── specification ───────────────────────────────────────────────────────────────────────────────

test('specification: versioned, normalized, serializable and stable through a JSON round trip; new and existing share one shape', () => {
  const s = spec({ profile: 'production-web' }, { idea: 'A reading list' });
  assert.equal(s.version, SPEC_VERSION);
  assert.equal(s.identity.intent, 'A reading list');
  const again = spec(JSON.parse(JSON.stringify(s)), { idea: 'A reading list' });
  assert.deepEqual(again, s, 'normalizing a serialized spec changes nothing');
  const existing = spec({}, { lifecycle: 'existing' });
  assert.deepEqual(Object.keys(existing).sort(), Object.keys(s).sort(), 'one schema for both lifecycles');
  assert.equal(existing.architecture, null, 'an existing app keeps what it has where nothing is asked');
  // Nothing asked for a new app: the factory's default application, explicitly.
  assert.equal(spec({}).profile, 'quick-prototype');
});

test('specification: structural errors are refused with actionable messages', () => {
  assert.throws(() => spec({ version: 2 }), (e) => e instanceof SpecError && /version 2 is not supported/.test(e.message));
  assert.throws(() => spec({ languages: 5 }), /languages must be a list/);
  assert.throws(() => spec({ frontend: ['react'] }), /frontend must be one catalog id/);
  assert.throws(() => spec({ profile: 'nope' }), /unknown profile "nope"/);
  assert.throws(() => spec({ profile: 'existing-enhancement' }), /is for existing projects/);
  assert.throws(() => spec({ lifecycle: 'new' }, { lifecycle: 'existing' }), /this run is for an existing project/);
  assert.throws(() => spec({ appport: { mode: 'maybe' } }), /appport.mode/);
  assert.throws(() => spec({ capabilityModel: [{}] }), /needs a name/);
  const v = validateSpec(spec({ ...REACT, frontend: 'reakt', data: ['react'] }));
  assert.deepEqual(codes(v).sort(), ['unknown:reakt', 'wrong-category:react'].sort());
  assert.match(v.diagnostics.find((d) => d.code === 'unknown').resolution, /Use one of: .*react/);
});

test('specification: a profile is a preset over the spec; edits replace only what they name', () => {
  const s = spec({ profile: 'production-web', data: ['data-none'] });
  assert.equal(s.profile, 'production-web');
  assert.deepEqual(s.data, ['data-none']);
  assert.equal(s.frontend, 'react', 'the rest of the profile stays');
  assert.equal(validateSpec(s).ok, true);
  for (const p of CATALOG.profiles) assert.ok(profileSpec(p.id).lifecycle);
});

// ── catalog ────────────────────────────────────────────────────────────────────────────────────

test('catalog: stable ids, known categories, honest statuses, and no package pins outside stack.json', () => {
  const ids = CATALOG.entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/);
  // Identifiers other code, runs and specs depend on.
  for (const id of ['fullstack-web', 'api-service', 'frontend-vanilla', 'react', 'vite', 'nextjs', 'typescript', 'python', 'node', 'browser', 'node-http', 'fastapi', 'data-none', 'feltdb', 'postgresql', 'appport', 'distribution', 'automated-tests', 'docker']) assert.ok(ids.includes(id), id);
  const cats = new Set(CATALOG.categories.map((c) => c.id));
  assert.deepEqual([...cats], Object.keys(FIELDS));
  for (const e of CATALOG.entries) {
    assert.ok(cats.has(e.category), `${e.id} category`);
    assert.ok(['supported', 'constrained', 'planned'].includes(e.status), `${e.id} status`);
    assert.ok(e.name && e.description, `${e.id} needs a name and description`);
    assert.ok(!('dependencies' in e) && !('version' in e), `${e.id}: package pins live in stack.json`);
    if (e.stack) assert.ok(STACK_COMPONENTS[e.stack], `${e.id} names stack component ${e.stack}`);
    const eff = catalogEntry(e.id);
    if (eff.status === 'planned') assert.ok(eff.blocker && eff.next, `${e.id}: a catalog-only entry says why and what is next`);
    else {
      // Executable only with a generation path and something that verifies it (or nothing to claim, for "none" options).
      assert.ok(['template', 'agents'].includes(e.generation), `${e.id} generation`);
      if (e.status === 'constrained') assert.ok(e.constraint, `${e.id}: a constrained entry states its constraint`);
      for (const r of [...(e.requires || []), ...(e.conflicts || []), ...(e.requiresAny || []).flat()]) assert.ok(ids.includes(r), `${e.id} refers to ${r}`);
    }
    // An entry backed by an unsupported stack component can never claim support.
    if (e.stack && STACK_COMPONENTS[e.stack].status !== 'supported') assert.equal(eff.status, 'planned', e.id);
  }
  for (const p of CATALOG.profiles) for (const [f, v] of Object.entries(p.spec)) for (const id of Array.isArray(v) ? v : [v]) assert.ok(ids.includes(id), `profile ${p.id} ${f}: ${id}`);
  const view = describeCatalog();
  assert.equal(view.entries.length, ids.length);
  assert.equal(view.entries.find((e) => e.id === 'authboundry').status, 'planned');
  assert.match(view.entries.find((e) => e.id === 'authboundry').blocker, /authboundry serve/);
});

test('catalog: the selector is rendered from the registry, not from technology names in browser code', () => {
  const ui = ['public/appspec.js', 'public/app.js'].map((f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
  // AppPort is the named capability contract; every other option comes from GET api/catalog.
  const named = CATALOG.entries.map((e) => e.id).filter((id) => id !== 'appport' && new RegExp(`['"\`]${id}['"\`]`).test(ui));
  assert.deepEqual(named, []);
  assert.match(ui, /api\/catalog/);
  assert.match(ui, /api\/spec\/validate/);
});

// ── compatibility ──────────────────────────────────────────────────────────────────────────────

test('compatibility: React + Vite + TypeScript is valid and resolves to exactly its stack components', () => {
  const s = spec(REACT);
  assert.deepEqual(validateSpec(s), { ok: true, diagnostics: [] });
  assert.deepEqual(stackOf(s), ['react', 'vite', 'typescript', 'appport']);
  assert.deepEqual(verifyCommands(s), ['npm run build', 'npm run typecheck']);
  assert.equal(specSummary(s), 'Full-stack web | React | Vite | JavaScript | TypeScript | Node.js http (no framework) | AppPort');
});

test('compatibility: Next.js and a Python backend fail explicitly while their generators are not supported', () => {
  const next = validateSpec(spec({ ...REACT, tooling: 'nextjs' }));
  assert.equal(next.ok, false);
  assert.ok(codes(next).includes('unsupported:nextjs'));
  assert.match(next.diagnostics.find((d) => d.selections[0] === 'nextjs').message, /AppPort boundary in Next route handlers/);
  const py = validateSpec(spec({ profile: 'python-backend' }));
  assert.deepEqual(codes(py).filter((c) => c.startsWith('unsupported')).sort(), ['unsupported:fastapi', 'unsupported:postgresql', 'unsupported:python', 'unsupported:python-runtime']);
  assert.ok(py.diagnostics.every((d) => d.resolution), 'every diagnostic says what to do');
});

test('compatibility: invalid framework, tooling and runtime combinations are refused deterministically', () => {
  const cases = [
    [{ ...REACT, tooling: 'tooling-none' }, ['missing-prerequisite:react']],
    [{ ...REACT, frontend: 'frontend-vanilla', languages: ['javascript'] }, ['missing-prerequisite:vite', 'missing-prerequisite:frontend-vanilla']],
    [{ ...REACT, runtimes: ['browser'] }, ['missing-prerequisite:javascript']],
    [{ ...REACT, data: ['data-none', 'feltdb'] }, ['contradictory:data-none']],
    [{ ...REACT, production: ['migrations'] }, ['unsupported:migrations', 'missing-prerequisite:migrations']],
    [{ ...REACT, frontend: 'frontend-none', tooling: 'tooling-none', languages: ['javascript'] }, ['runtime-mismatch:browser', 'missing-prerequisite:fullstack-web']],
  ];
  for (const [s, want] of cases) {
    const a = validateSpec(spec(s));
    for (const w of want) assert.ok(codes(a).includes(w), `${JSON.stringify(s)} → ${codes(a)} (want ${w})`);
    assert.deepEqual(validateSpec(spec(s)), a, 'the same input gives the same diagnostics');
  }
});

test('compatibility: several language families need a multi-service architecture, which is not supported yet', () => {
  const mixed = validateSpec(spec({ ...REACT, languages: ['typescript', 'javascript', 'python'], runtimes: ['node', 'browser', 'python-runtime'] }));
  assert.ok(codes(mixed).includes('architecture:typescript'));
  assert.match(mixed.diagnostics.find((d) => d.code === 'architecture').resolution, /Monorepo \/ multi-service/);
  const mono = validateSpec(spec({ profile: 'multi-service' }));
  assert.ok(codes(mono).includes('unsupported:monorepo'));
  assert.ok(!codes(mono).includes('architecture:javascript'), 'multi-language itself is allowed by that architecture');
});

test('compatibility: missing generator and missing integration are refused before anything runs', () => {
  const offline = validateSpec(spec(REACT), { offline: true });
  assert.deepEqual(codes(offline).sort(), ['no-generator:react', 'no-generator:typescript', 'no-generator:vite']);
  assert.equal(validateSpec(spec({ profile: 'quick-prototype' }), { offline: true }).ok, true, 'the template app needs no model');
  const pyRepo = observeApplication({ dependencies: { npm: [], python: ['fastapi'] }, markers: ['requirements.txt'], sample: [] });
  const addAppPort = validateSpec(spec({ capabilities: ['appport'] }, { lifecycle: 'existing' }), { observed: pyRepo });
  assert.deepEqual(codes(addAppPort), ['integration-gap:appport']);
  assert.match(addAppPort.diagnostics[0].message, /only be integrated into an application on Node\.js.*detected: Python/);
  const reshape = validateSpec(spec({ architecture: 'api-service' }, { lifecycle: 'existing' }), { observed: pyRepo });
  assert.ok(codes(reshape).includes('integration-mode:api-service'));
  assert.ok(codes(validateSpec(spec({ frontend: 'vue' }, { lifecycle: 'existing' }), { observed: pyRepo })).includes('unsupported:vue'));
});

// ── selector model ─────────────────────────────────────────────────────────────────────────────

test('selector: every catalog option has one state with a reason when it cannot be chosen; exclusive options swap', () => {
  const s = spec({ profile: 'quick-prototype' });
  const states = optionStates(s);
  assert.deepEqual(states.map((x) => x.id), CATALOG.entries.map((e) => e.id));
  const by = Object.fromEntries(states.map((x) => [x.id, x]));
  assert.equal(by['frontend-vanilla'].state, 'selected');
  assert.equal(by.nextjs.state, 'unavailable');
  assert.match(by.nextjs.reason, /Next route handlers.*Next:/);
  assert.equal(by.react.state, 'available');
  assert.match(by.react.needs, /Add Vite/, 'what a choice still needs is shown with it');
  assert.equal(by.feltdb.state, 'available', 'choosing FeltDB replaces "No persistent storage"');
  assert.deepEqual(toggle(s, 'feltdb'), ['feltdb']);
  assert.deepEqual(toggle({ ...s, data: ['feltdb'] }, 'data-none'), ['data-none']);
  assert.equal(toggle(s, 'react'), 'react');
  // With the offline agents, model-built options are incompatible, and say why.
  const off = Object.fromEntries(optionStates(s, { offline: true }).map((x) => [x.id, x]));
  assert.equal(off.react.state, 'incompatible');
  assert.match(off.react.reason, /offline demo agents/);
  // AppPort, once exempted, can be selected again.
  const exempt = spec({ ...REACT, capabilities: [], appport: { mode: 'exempt', reason: 'batch' } });
  assert.equal(optionStates(exempt).find((x) => x.id === 'appport').state, 'available');
  // In an existing repository, what is there is marked detected.
  const obs = observeApplication({ dependencies: { npm: ['react', 'vite'] }, markers: ['package.json'], sample: [] });
  const ex = Object.fromEntries(optionStates(spec({}, { lifecycle: 'existing' }), { observed: obs }).map((x) => [x.id, x]));
  assert.equal(ex.react.state, 'detected');
  assert.equal(ex.react.detected, true);
});

// ── observation, plan and evidence ─────────────────────────────────────────────────────────────

test('observation: detected technologies carry their basis and are never confused with requested or verified ones', async () => {
  const dir = makeRepo({ ...NODE_FILES, 'package.json': JSON.stringify({ name: 'shelf', type: 'module', scripts: { test: 'node --test' }, dependencies: { react: '19.0.0', '@appport/core': '1.1.0' }, devDependencies: { vite: '8.0.0' } }), 'vite.config.js': 'export default {};\n', Dockerfile: 'FROM node:20\n' });
  const obs = observeApplication(await inspectProject(new Workspace(dir)));
  const ids = obs.technologies.map((t) => t.id);
  for (const id of ['react', 'vite', 'javascript', 'node', 'appport', 'docker']) assert.ok(ids.includes(id), id);
  assert.equal(obs.technologies.find((t) => t.id === 'react').basis, 'package.json dependency react');
  assert.equal(obs.technologies.find((t) => t.id === 'docker').basis, 'file Dockerfile');
  // AppPort packages are declared; that is not conformance.
  assert.deepEqual([obs.appport.declared, obs.appport.conformance], [true, 'not-verified']);
  // Python projects: names from requirements and pyproject.
  const py = observeApplication(await inspectProject(new Workspace(makeRepo({ ...PY_FILES, 'requirements.txt': 'fastapi==0.115\nuvicorn[standard]\n' }))));
  assert.ok(py.technologies.some((t) => t.id === 'fastapi' && /requirement fastapi/.test(t.basis)));
  assert.ok(py.technologies.some((t) => t.id === 'python-runtime'));
});

test('plan: an existing app keeps what it has, already-present requirements are recognized, and only the rest is added', () => {
  const obs = observeApplication({ dependencies: { npm: ['react', 'vite'] }, markers: ['package.json', 'Dockerfile'], sample: [] });
  const s = spec({ frontend: 'react', capabilities: ['appport'], production: ['docker', 'ci-cd'] }, { lifecycle: 'existing' });
  assert.equal(validateSpec(s, { observed: obs }).ok, true);
  const plan = planReconciliation(s, obs);
  const act = Object.fromEntries(plan.items.map((i) => [i.id, i.action]));
  assert.equal(act.react, 'satisfied', 'React is already there: not regenerated');
  assert.equal(act.docker, 'satisfied');
  assert.equal(act.vite, 'preserve');
  assert.equal(act.appport, 'add');
  assert.equal(act['ci-cd'], 'add');
  const ctx = planContext(s, plan);
  assert.match(ctx, /Already present, do NOT replace: React, Docker/);
  assert.match(ctx, /Add \(smallest change/);
  // Observe mode (the default for existing apps): AppPort is recorded, not added.
  const observe = planReconciliation(spec({}, { lifecycle: 'existing' }), obs);
  assert.deepEqual(observe.items.filter((i) => i.id === 'appport').map((i) => i.action), ['observe']);
});

test('evidence: a requirement is met by verification, not by selection or by its dependency being present', () => {
  const s = spec(REACT);
  const observedAfter = observeApplication({ dependencies: { npm: ['react', 'vite', 'typescript', '@appport/core'] }, markers: ['package.json'], sample: [] });
  const ok = { id: 'x', ok: true };
  const checklist = ['tests', 'deploy', 'stack', 'security'].map((id) => ({ ...ok, id }));
  // AppPort packages present, but the conformance gate failed: AppPort is not met.
  const ev = specEvidence(s, { checklist: [...checklist, { id: 'appport', ok: false, detail: 'anonymous-refused: list answered an anonymous caller' }], commands: [{ command: 'npm run build', ok: true, exitCode: 0 }, { command: 'npm run typecheck', ok: false, exitCode: 2 }], exists: (p) => p === 'public/index.html', observedAfter });
  const st = Object.fromEntries(ev.items.map((i) => [i.id, i.state]));
  assert.equal(st.appport, 'failed');
  assert.equal(st.react, 'verified');
  assert.equal(st.typescript, 'failed', 'a failing typecheck fails TypeScript');
  assert.equal(st['data-none'], 'nothing-to-verify');
  // Nothing run: nothing claimed.
  const none = Object.fromEntries(specEvidence(s, {}).items.map((i) => [i.id, i.state]));
  assert.equal(none.typescript, 'not-verified');
  assert.equal(none.react, 'failed', 'its build output is missing');
  assert.equal(none.appport, 'not-verified');
  // Requested but absent from the result fails, whatever the checks said.
  const missing = specEvidence(s, { checklist: [...checklist, { id: 'appport', ok: true }], commands: [{ command: 'npm run build', ok: true }, { command: 'npm run typecheck', ok: true }], exists: () => true, observedAfter: observeApplication({ dependencies: { npm: ['@appport/core'] }, markers: [], sample: [] }) });
  assert.equal(missing.items.find((i) => i.id === 'react').state, 'failed');
});

// ── modernization ──────────────────────────────────────────────────────────────────────────────

test('capability model: a COBOL capability and its Python replacement live in one graph with dependencies and affected capabilities', () => {
  const s = spec({
    profile: 'quick-prototype',
    capabilityModel: [
      { name: 'ledger.post', effect: 'consequential', implementation: { language: 'COBOL', location: 'LEDGER.CBL' } },
      { name: 'ledger.balance', effect: 'observation', implementation: { language: 'COBOL', location: 'BAL.CBL' }, dependsOn: ['ledger.post'] },
      { name: 'statement.render', effect: 'observation', implementation: { language: 'JavaScript' }, dependsOn: ['ledger.balance'] },
      { name: 'ledger.post.v2', effect: 'consequential', implementation: { language: 'Python', location: 'ledger/post.py' }, replaces: 'ledger.post' },
    ],
  });
  assert.equal(validateSpec(s).ok, true);
  const g = capabilityGraph(s.capabilityModel);
  assert.deepEqual(g.affected('ledger.post').sort(), ['ledger.balance', 'statement.render']);
  assert.deepEqual(g.replacements, [{ replacement: 'ledger.post.v2', replaces: 'ledger.post', from: 'COBOL', to: 'Python', affected: ['ledger.balance', 'statement.render'] }]);
  const bad = validateSpec(spec({ profile: 'quick-prototype', capabilityModel: [{ name: 'a', dependsOn: ['b'] }, { name: 'c', replaces: 'z' }] }));
  assert.deepEqual(codes(bad), ['capability-model:a', 'capability-model:c']);
  // Contract comparison of old and new boundaries (the AppPort gate's capability lists).
  const cmp = compareCapabilities([{ name: 'ledger.post', effect: 'consequential', authorization: ['ledger:write'] }, { name: 'ledger.balance', effect: 'observation', authorization: ['ledger:read'] }], [{ name: 'ledger.post', effect: 'consequential', authorization: [] }]);
  assert.deepEqual(cmp.missing, ['ledger.balance']);
  assert.equal(cmp.changed[0].name, 'ledger.post');
  assert.match(cmp.basis, /not behaviour/);
});

// ── AppPort ────────────────────────────────────────────────────────────────────────────────────

test('AppPort: on by default; leaving it out needs a reason; never silently added or dropped', () => {
  assert.deepEqual([spec({}).capabilities, spec({}).appport.mode], [['appport'], 'require']);
  const without = validateSpec(spec({ ...REACT, capabilities: [] }));
  assert.deepEqual(codes(without), ['appport-required:appport']);
  const exempt = spec({ ...REACT, capabilities: [], appport: { mode: 'exempt', reason: 'internal batch job' } });
  assert.equal(validateSpec(exempt).ok, true);
  assert.ok(!stackOf(exempt).includes('appport'));
  assert.deepEqual(codes(validateSpec(spec({ ...REACT, appport: { mode: 'exempt', reason: 'x' } }))), ['contradictory:appport']);
  assert.deepEqual(codes(validateSpec(spec({ appport: { mode: 'exempt', reason: 'x' } }, { lifecycle: 'existing' }))), ['appport-exception:appport']);
  // The earlier way of asking keeps its meaning.
  assert.deepEqual(stackOf(specFromStack(['appport', 'feltdb'])), ['feltdb', 'appport']);
  assert.equal(specFromStack([], { exception: 'batch' }).appport.mode, 'exempt');
});

test('new app (offline): the run records desired, plan and evidence; unselected integrations are absent; AppPort is verified by its gate', async () => {
  const { factory, store } = setup();
  const created = await factory.createRun({ idea: 'A packing checklist', provider: 'offline', spec: { profile: 'quick-prototype' }, settings: { deploy: false } });
  assert.equal(created.spec.desired.profile, 'quick-prototype');
  assert.deepEqual(created.settings.stack, ['appport']);
  assert.ok(created.spec.plan.items.every((i) => i.action === 'add'));
  assert.equal(created.spec.evidence, null, 'nothing is evidence before the run');
  const run = await factory.start(created.id);
  assert.equal(run.status, 'completed', JSON.stringify(run.checklist.filter((c) => !c.ok)));
  const item = run.checklist.find((c) => c.id === 'spec');
  assert.equal(item.ok, true, item.detail);
  const ev = Object.fromEntries(run.spec.evidence.items.map((i) => [i.id, i]));
  assert.equal(ev.appport.state, 'verified');
  assert.ok(ev.appport.checks.some((c) => c.check === 'checklist: appport' && c.state === 'passed'), 'AppPort is met by the conformance gate');
  assert.equal(ev['frontend-vanilla'].state, 'present');
  const pkg = JSON.parse(fs.readFileSync(path.join(store.workspaceDir(run.id), 'package.json'), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const absent of ['react', 'vite', 'typescript', '@feltdb/core', '@distribution-protocol/protocol']) assert.ok(!deps.includes(absent), absent);
  // Persisted and restored as stored; a rerun asks for the same application.
  const loaded = await store.load(run.id);
  assert.deepEqual(loaded.spec.desired, created.spec.desired);
  const again = await factory.rerun(run.id);
  assert.deepEqual(again.spec.desired, created.spec.desired);
});

test('new app: a combination the factory cannot build is refused at creation, with every diagnostic', async () => {
  const { factory } = setup();
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', spec: { profile: 'production-web' } }), (e) => e instanceof SpecError && e.diagnostics.length === 4 && /offline demo agents/.test(e.message));
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', spec: { profile: 'python-backend' } }), /Python is not supported yet/);
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', spec: {}, settings: { stack: ['feltdb'] } }), /either as spec or as settings.stack/);
});

const rootWith = (name, files) => makeRoot({ [name]: (d) => fs.cpSync(makeRepo(files), d, { recursive: true }) });

test('existing app: observed and planned before any change; requiring AppPort uses the same gate and is not claimed unverified', async () => {
  const { cfg: rootCfg } = rootWith('widgets', NODE_FILES);
  const { cfg, store, factory } = setup({ cfg: rootCfg });
  const created = await factory.createRun({ idea: 'Expose the greeting as a capability', provider: 'offline', source: { mode: 'local', directoryId: dirId(cfg, 'widgets') }, spec: { capabilities: ['appport'] } });
  assert.equal(created.spec.desired.lifecycle, 'existing');
  assert.equal(created.spec.plan, null, 'the plan waits for the repository to be observed');
  const run = await factory.start(created.id);
  assert.ok(run.spec.observed.technologies.some((t) => t.id === 'javascript'));
  assert.equal(run.spec.plan.items.find((i) => i.id === 'appport').action, 'add');
  const events = await store.events(run.id);
  const planAt = events.findIndex((e) => e.type === 'spec' && e.stage === 'plan');
  const firstTask = events.findIndex((e) => e.type === 'task');
  assert.ok(planAt > 0 && planAt < firstTask, 'the plan exists before any task runs');
  // The run did not authorize starting the app, so AppPort conformance is a reported gap, not a claim.
  const appport = run.checklist.find((c) => c.id === 'appport');
  assert.equal(appport.ok, false);
  assert.match(appport.detail, /not verified: .*did not authorize a local preview/);
  assert.equal(run.checklist.find((c) => c.id === 'spec').ok, false);
  assert.equal(run.spec.evidence.items.find((i) => i.id === 'appport').state, 'failed');
  assert.equal(run.status, 'needs_attention');
});

test('existing app: the default specification observes and preserves; a requested integration the repository cannot take stops the run before any change', async () => {
  const { cfg: rootCfg } = makeRoot({ widgets: (d) => fs.cpSync(makeRepo(NODE_FILES), d, { recursive: true }), calc: (d) => fs.cpSync(makeRepo(PY_FILES), d, { recursive: true }) });
  const { cfg, factory } = setup({ cfg: rootCfg });
  const plain = await factory.start((await factory.createRun({ idea: 'Add a farewell', provider: 'offline', source: { mode: 'local', directoryId: dirId(cfg, 'widgets') } })).id);
  assert.equal(plain.status, 'completed', JSON.stringify(plain.checklist.filter((c) => !c.ok)));
  assert.equal(plain.checklist.find((c) => c.id === 'spec').state, 'na');
  assert.ok(plain.spec.plan.items.every((i) => ['preserve', 'observe'].includes(i.action)));
  assert.equal(plain.checklist.some((c) => c.id === 'appport'), false, 'not adopted unless asked');

  const gap = await factory.start((await factory.createRun({ idea: 'Add AppPort', provider: 'offline', source: { mode: 'local', directoryId: dirId(cfg, 'calc') }, spec: { capabilities: ['appport'] } })).id);
  assert.equal(gap.status, 'failed');
  assert.match(gap.error, /AppPort can only be integrated into an application on Node\.js/);
  assert.equal(gap.plan, null, 'nothing was planned');
  assert.equal(gap.spec.plan, null);
});

// ── API and CLI ────────────────────────────────────────────────────────────────────────────────

test('API and CLI: the catalog, validation with detection of a local project, and runs from a spec file or profile', async () => {
  const { cfg: rootCfg } = rootWith('shelf', { ...NODE_FILES, 'package.json': JSON.stringify({ name: 'shelf', dependencies: { react: '19.0.0' } }) });
  const be = await startBackend({ defaultProvider: 'offline', ...rootCfg });
  try {
    const post = (p, b) => fetch(`${be.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
    const cat = await (await fetch(`${be.url}/api/catalog`)).json();
    assert.equal(cat.specVersion, SPEC_VERSION);
    const v = await post('/api/spec/validate', { spec: { frontend: 'react' }, source: { mode: 'local', directoryId: dirId(be.cfg, 'shelf') } });
    assert.equal(v.ok, true);
    assert.match(v.observation, /inspected now/);
    assert.equal(v.plan.items.find((i) => i.id === 'react').action, 'satisfied');
    assert.equal(v.options.find((o) => o.id === 'react').state, 'selected');
    assert.equal((await post('/api/spec/validate', { spec: { version: 9 } })).diagnostics[0].code, 'shape');

    const list = await cli(['catalog', '--json'], { backend: be });
    assert.equal(list.code, EXIT.OK);
    assert.equal(list.json.entries.length, CATALOG.entries.length);
    const human = await cli(['catalog', '--category', 'frontend'], { backend: be });
    assert.match(human.out, /react .*constrained/);
    assert.match(human.out, /not yet supported: vue, svelte, angular/);
    assert.equal((await cli(['spec', 'check', '--profile', 'production-web'], { backend: be })).code, EXIT.OK);
    const bad = await cli(['spec', 'check', '--profile', 'python-backend'], { backend: be });
    assert.equal(bad.code, EXIT.USAGE);
    assert.match(bad.out, /Python is not supported yet/);

    const file = path.join(tmpDir(), 'app.json');
    fs.writeFileSync(file, JSON.stringify({ data: ['feltdb'] }));
    const run = await cli(['run', 'A habit tracker', '--new', '--profile', 'quick-prototype', '--spec', file, '--detach', '--json'], { backend: be });
    assert.equal(run.code, EXIT.OK, run.err);
    const stored = (await (await fetch(`${be.url}/api/runs/${run.json.id}`)).json()).run;
    assert.deepEqual(stored.spec.desired.data, ['feltdb']);
    assert.deepEqual(stored.settings.stack, ['appport', 'feltdb']);
    await fetch(`${be.url}/api/runs/${run.json.id}/cancel`, { method: 'POST' });
    const both = await cli(['run', 'x', '--new', '--profile', 'quick-prototype', '--stack', 'feltdb'], { backend: be });
    assert.equal(both.code, EXIT.USAGE);
  } finally {
    await be.close();
  }
});
