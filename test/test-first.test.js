// Test-first QA: acceptance tests are defined and baselined before implementation, QA-owned tests are protected, independent QA
// verifies the finished code, and success is reported only when every required gate completed. Everything runs offline against
// scripted agents; verification, baselines, seals and evidence are the real factory's (real shell commands in real workspaces).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { enforceTestFirst, checkTestFirst, classifyBaseline, recordEvidence, reusableEvidence, qaChecklistItem, workspaceState, KIND_TEST_DEFINITION, KIND_INDEPENDENT_QA } from '../src/testfirst.js';
import { Workspace } from '../src/sandbox.js';
import { makeRepo, makeRoot, dirId, setup, Scripted, task, plan, toolUse, done, NODE_FILES } from './project-helpers.js';
import { tmpDir } from './helpers.js';

const IMPL = 'export function greet(name) {\n  const n = String(name ?? \'\').trim();\n  if (!n) throw new Error(\'name is required\');\n  return `Hello, ${n}!`;\n}\n';
const IMPL_NO_TRIM = 'export function greet(name) {\n  if (!String(name ?? \'\').trim()) throw new Error(\'name is required\');\n  return `Hello, ${name}!`;\n}\n';
const TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greet.mjs';\ntest('greets and trims', () => assert.equal(greet(' Ada '), 'Hello, Ada!'));\ntest('rejects an empty name', () => assert.throws(() => greet('  '), /name/i));\n";
const TEST_PATH = 'test/greet.test.mjs';
const w = (p, content) => toolUse('write_file', { path: p, content });
const sh = (command) => toolUse('run_command', { command });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The model's plan: no QA at all, as a weak planner might write it. The factory has to make it test-first. */
const modelPlan = (extra = {}, implExtra = {}) => plan(
  [task('prd', { role: 'product', title: 'Requirements', outputs: [] }), task('impl', { dependsOn: ['prd'], title: 'Implement greet', verify: ['node --check src/greet.mjs'], acceptance: ['greet(" Ada ") returns "Hello, Ada!"', 'greet("  ") throws an error mentioning name'], ...implExtra })],
  { finalVerify: ['node --test'], ...extra },
);

/**
 * A scripted team. Each handler is (ctx) => tool calls for the first turn of an attempt (the agent then completes), or an object
 * { calls, finish } to control the completion call. `log` records what ran in what order, and what existed when it started.
 */
const fresh = (store, id) => { try { return JSON.parse(fs.readFileSync(path.join(store.runDir(id), 'run.json'), 'utf8')).testContract; } catch { return null; } };
function team(handlers = {}, { plan: planFn = () => modelPlan(), delay = 0, usage } = {}) {
  const log = { starts: [], briefs: {} };
  const defaults = {
    prd: () => [w('PRD.md', '# PRD\nGreeting.\n'), w('README.md', `# Greeting\n${'A greeting function with tests. '.repeat(10)}\n`), w('DEPLOY.md', '# Deploy\nRun node --test.\n'), w('public/index.html', '<!doctype html><title>Greeting</title><p>hi</p>\n')],
    'qa-define': () => ({ calls: [w(TEST_PATH, TEST), sh('node --test || true')], finish: { summary: 'wrote acceptance tests', files: [TEST_PATH], testFiles: [TEST_PATH] } }),
    impl: () => [w('src/greet.mjs', IMPL), sh('node --test')],
    'qa-verify': () => [sh('node --test')],
  };
  class Team extends Scripted {
    async chat(req) {
      if (delay && req.meta?.kind === 'task') await sleep(delay);
      const res = await super.chat(req);
      if (usage) res.usage = usage;
      return res;
    }
  }
  const current = {};
  const provider = new Team({
    plan: (meta, req) => planFn(meta, req),
    task: ({ task: t, attempt, turn, messages }) => {
      if (turn === 0) {
        log.briefs[t.id] = [...(log.briefs[t.id] || []), messages[0].content];
        log.starts.push({ id: t.id, attempt, at: Date.now(), sealedThen: Object.keys(currentRun?.testContract?.sealed || {}) });
        const h = handlers[t.id] || defaults[t.id] || (() => []);
        const out = h({ task: t, attempt });
        current[t.id] = Array.isArray(out) ? { calls: out } : out;
        return current[t.id].calls || [];
      }
      const finish = current[t.id]?.finish || { summary: `${t.id} done`, files: [] };
      return [toolUse('complete_task', { commands: [], nextSteps: [], ...finish })];
    },
  });
  let currentRun = null;
  provider.bind = (run, store) => { currentRun = { get testContract() { return fresh(store, run.id); } }; };
  provider.log = log;
  return provider;
}

/** Create and run a greenfield run with a scripted team. The run object is re-read live by the team for logging. */
async function runGreenfield(prov, settings = {}) {
  const { factory, store } = setup({ provider: prov });
  const created = await factory.createRun({ idea: 'A greeting function', provider: 'offline', settings: { deploy: false, testFirst: true, maxAttempts: 3, appportException: 'a function library, not an app', ...settings } });
  prov.bind(await store.load(created.id), store);
  const run = await factory.start(created.id);
  return { run, store, factory, ws: store.workspaceDir(run.id), events: () => store.events(run.id) };
}

const why = (run) => run.error || JSON.stringify((run.checklist || []).filter((c) => !c.ok).map((c) => [c.id, c.detail]));
const byId = (run, id) => run.plan.tasks.find((t) => t.id === id);
const order = (prov) => prov.log.starts.map((s) => s.id);

// ── 1. The plan carries the contract ─────────────────────────────────────────────────────────────────────────────

test('a plan with no QA is made test-first through real dependencies; planner QA tasks are reused instead of duplicated', () => {
  const { plan: p, repairs } = enforceTestFirst(modelPlan());
  const ids = p.tasks.map((t) => t.id);
  assert.deepEqual(ids, ['prd', 'impl', 'qa-define', 'qa-verify']);
  assert.equal(p.tasks.find((t) => t.id === 'qa-define').kind, KIND_TEST_DEFINITION);
  assert.deepEqual(p.tasks.find((t) => t.id === 'qa-define').dependsOn, ['prd'], 'criteria (from the PRD task) exist before QA starts');
  assert.ok(p.tasks.find((t) => t.id === 'impl').dependsOn.includes('qa-define'));
  assert.deepEqual(p.tasks.find((t) => t.id === 'qa-verify').dependsOn, ['impl']);
  assert.deepEqual(p.tasks.find((t) => t.id === 'qa-define').baseline, ['node --test']);
  assert.equal(repairs.length, 3);
  assert.deepEqual(checkTestFirst(p), []);

  // A planner that already wrote both QA tasks gets no extra task, only the missing edge.
  const own = plan([
    task('prd', { role: 'product' }),
    task('write-tests', { role: 'qa', dependsOn: ['prd'], verify: ['true'] }),
    task('impl', { dependsOn: ['prd'] }),
    task('final-qa', { role: 'qa', dependsOn: ['impl'], verify: ['node --test'] }),
  ], { finalVerify: ['node --test'] });
  const r = enforceTestFirst(own);
  assert.deepEqual(r.plan.tasks.map((t) => t.id), ['prd', 'write-tests', 'impl', 'final-qa']);
  assert.deepEqual(r.plan.tasks.find((t) => t.id === 'impl').dependsOn, ['prd', 'write-tests']);
  assert.equal(r.plan.tasks.find((t) => t.id === 'write-tests').kind, KIND_TEST_DEFINITION);
  assert.equal(r.plan.tasks.find((t) => t.id === 'final-qa').kind, KIND_INDEPENDENT_QA);
  assert.deepEqual(r.plan.tasks.find((t) => t.id === 'write-tests').verify, [], 'failing before implementation is expected, so "must exit 0" is not asked of it');
  assert.deepEqual(checkTestFirst(r.plan), []);

  // The contract's validator names what is missing.
  assert.ok(checkTestFirst(modelPlan()).includes('no QA test-definition task'));
  assert.ok(checkTestFirst({ ...p, product: { ...p.product, successCriteria: [] } }).includes('acceptance criteria are missing'));
  const broken = structuredClone(p);
  broken.tasks.find((t) => t.id === 'impl').dependsOn = ['prd'];
  assert.match(checkTestFirst(broken).join(), /implementation "impl" does not wait for a test definition/);
  // No implementation, nothing to define tests for.
  assert.deepEqual(enforceTestFirst(plan([task('prd', { role: 'product' })])).repairs, []);
});

// ── 2/3/12. Greenfield: tests first, in order, sealed, then independent QA ─────────────────────────────────────────

test('greenfield: criteria exist, QA defines and baselines the tests, then the engineer implements, then QA verifies independently', async () => {
  const prov = team();
  const { run, ws, events } = await runGreenfield(prov);
  assert.equal(run.status, 'completed', why(run));
  assert.deepEqual(order(prov), ['prd', 'qa-define', 'impl', 'qa-verify']);
  // 1. Acceptance criteria exist before implementation starts (product-level and per task) and are in the engineer's brief.
  assert.ok(run.plan.product.successCriteria.length > 0);
  assert.match(prov.log.briefs.impl[0], /greet\(" Ada "\) returns "Hello, Ada!"/);
  // 2. The tests existed, and were sealed, when the engineer started; the implementation did not.
  const implStart = prov.log.starts.find((s) => s.id === 'impl');
  assert.deepEqual(implStart.sealedThen, [TEST_PATH]);
  assert.match(prov.log.briefs.impl[0], /QA-owned tests \(sealed\)[\s\S]*test\/greet\.test\.mjs/);
  assert.equal(fs.readFileSync(path.join(ws, TEST_PATH), 'utf8'), TEST, 'the engineer did not change the QA-owned test');
  // 4. The baseline was recorded, classified and tied to a code state, before implementation.
  const [base] = run.testContract.baseline;
  assert.deepEqual([base.taskId, base.command, base.classification], ['qa-define', 'node --test', 'expected-failure']);
  assert.notEqual(base.exitCode, 0);
  assert.match(base.reason, /behaviour is missing/);
  assert.ok(base.codeState);
  assert.ok(byId(run, 'qa-define').attempts[0].finishedAt <= byId(run, 'impl').attempts[0].startedAt);
  // 5/6/7. Independent QA ran the pre-defined tests against the finished code; the factory's own run is the evidence.
  const qa = byId(run, 'qa-verify');
  assert.equal(qa.status, 'completed');
  const ran = qa.attempts.at(-1).verification.find((v) => v.command === 'node --test');
  assert.equal(ran.exitCode, 0);
  assert.ok(ran.codeState, 'the result says which code it applies to');
  assert.match(prov.log.briefs['qa-verify'][0], /Independent QA/);
  assert.ok(!prov.log.briefs['qa-verify'][0].includes('impl done'), 'QA is not handed the engineer\'s account of what was built');
  // Final verification and the checklist.
  assert.equal(run.checklist.find((c) => c.id === 'qa').ok, true, JSON.stringify(run.checklist.find((c) => c.id === 'qa')));
  assert.equal(run.finalVerification[0].exitCode, 0);
  const evidence = (await events()).find((e) => e.type === 'plan');
  assert.ok(evidence.repairs >= 3);
});

// ── 4/5. Gates: implementation never starts behind a failed gate ─────────────────────────────────────────────────

test('implementation is blocked while the test definition fails, and it never starts', async () => {
  const prov = team({ 'qa-define': () => ({ calls: [], finish: { summary: 'tests are fine, trust me', files: [] } }) });
  const { run } = await runGreenfield(prov, { maxAttempts: 2 });
  assert.equal(byId(run, 'qa-define').status, 'escalated');
  assert.match(byId(run, 'qa-define').attempts[0].verification[0].output, /no test files were named/);
  assert.equal(byId(run, 'impl').status, 'blocked');
  assert.equal(byId(run, 'qa-verify').status, 'blocked');
  assert.ok(!order(prov).includes('impl'), `impl must not run (ran: ${order(prov)})`);
  assert.equal(run.status, 'needs_attention');
  assert.equal(run.checklist.find((c) => c.id === 'qa').ok, false);
});

test('baseline results are classified: missing behaviour, already passing, cannot execute, broken tests, pre-existing failure', async () => {
  const c = (exitCode, text, extra = {}, opts) => classifyBaseline({ exitCode, ...extra }, text, opts).classification;
  assert.equal(c(1, "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/work/src/greet.mjs' imported from /work/test/greet.test.mjs"), 'expected-failure');
  assert.equal(c(1, '✖ greets and trims\n  AssertionError: expected Hello, Ada! but got undefined'), 'expected-failure');
  assert.equal(c(0, 'ok'), 'already-passing');
  assert.equal(c(1, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'left-pad' imported from /work/test/a.test.mjs"), 'cannot-execute');
  assert.equal(c(1, "Error: Cannot find module 'vitest'"), 'cannot-execute');
  assert.equal(c(127, 'sh: 1: pytest: not found'), 'cannot-execute');
  assert.equal(c(1, '', { timedOut: true }), 'cannot-execute');
  assert.equal(c(1, 'ModuleNotFoundError: No module named requests'), 'cannot-execute');
  assert.equal(c(1, 'SyntaxError: Unexpected token }'), 'unexpected-failure');
  const prior = { status: 'failed', exitCode: 1, signature: ['✖ old failure'] };
  assert.equal(c(1, '✖ old failure\nℹ fail 1', {}, { projectBaseline: prior }), 'preexisting-failure');
  assert.equal(c(1, '✖ a brand new failure', {}, { projectBaseline: prior }), 'expected-failure');

  // End to end: tests that cannot run because a dependency is missing are not proof that behaviour is missing, and
  // nothing is installed to make them run.
  const needsPkg = "import { test } from 'node:test';\nimport x from 'nonexistent-pkg-xyz';\ntest('t', () => x());\n";
  const prov = team({ 'qa-define': () => ({ calls: [w(TEST_PATH, needsPkg)], finish: { summary: 'tests', files: [TEST_PATH], testFiles: [TEST_PATH] } }) });
  const { run, ws } = await runGreenfield(prov, { maxAttempts: 1 });
  const [base] = run.testContract.baseline;
  assert.equal(base.classification, 'cannot-execute');
  assert.match(base.reason, /not evidence that the behaviour is missing/);
  assert.equal(byId(run, 'qa-define').status, 'escalated');
  assert.equal(byId(run, 'impl').status, 'blocked');
  assert.equal(run.status, 'needs_attention');
  assert.equal(fs.existsSync(path.join(ws, 'node_modules')), false, 'no dependency was installed');
});

test('a project with no way to run tests gets no baseline, not a fabricated one; giving the tests a runner fixes it', async () => {
  assert.equal(classifyBaseline({ exitCode: 1 }, 'npm error Missing script: "test"').classification, 'cannot-execute');
  const noRunner = team({}, { plan: () => modelPlan({ finalVerify: ['npm test'] }) });
  const a = await runGreenfield(noRunner, { maxAttempts: 1 });
  assert.equal(a.run.testContract.baseline[0].classification, 'cannot-execute');
  assert.match(byId(a.run, 'qa-define').attempts[0].verification.at(-1).output, /no command that runs tests/);
  assert.equal(byId(a.run, 'impl').status, 'blocked');
  assert.equal(a.run.status, 'needs_attention');
  // The QA agent gives the tests a runner (an explicit step it takes in the workspace) and the baseline then means something.
  const pkg = JSON.stringify({ name: 'app', version: '0.0.0', private: true, type: 'module', scripts: { test: 'node --test' } });
  const withRunner = team({ 'qa-define': () => ({ calls: [w(TEST_PATH, TEST), w('package.json', pkg)], finish: { summary: 'tests and runner', files: [TEST_PATH], testFiles: [TEST_PATH] } }) }, { plan: () => modelPlan({ finalVerify: ['npm test'] }) });
  const b = await runGreenfield(withRunner);
  assert.equal(b.run.testContract.baseline[0].classification, 'expected-failure');
  assert.equal(b.run.status, 'completed', why(b.run));
});

// ── 6. QA ownership ──────────────────────────────────────────────────────────────────────────────────────────────

test('the engineer cannot alter QA-owned tests: writes are refused, shell edits are undone and fail the attempt, disputes are escalated', async () => {
  const prov = team({
    impl: ({ attempt }) => (attempt === 1
      ? [w(TEST_PATH, "import {test} from 'node:test'; test('weakened', () => {});\n"), sh(`printf 'tampered' > ${TEST_PATH}`), w('src/greet.mjs', IMPL)]
      : [w('src/greet.mjs', IMPL)]),
  });
  const { run, ws, events } = await runGreenfield(prov);
  assert.equal(fs.readFileSync(path.join(ws, TEST_PATH), 'utf8'), TEST, 'the test is exactly as QA defined it');
  const impl = byId(run, 'impl');
  assert.equal(impl.attempts.length, 2);
  const first = impl.attempts[0].verification;
  assert.deepEqual([first[0].command, first[0].ok, first[0].state], ['sealed tests unchanged', false, 'tampered']);
  assert.match(first[0].output, /restored/);
  assert.match(impl.attempts[0].feedback, /sealed tests unchanged/);
  const refused = (await events()).find((e) => e.type === 'tool' && e.tool === 'write_file' && e.ok === false);
  assert.match(refused.output, /QA-owned test/);
  assert.equal(run.status, 'completed', why(run));

  // A test the engineer thinks is wrong is a dispute for review: the task escalates, nothing is edited, the run is incomplete.
  const disputing = team({ impl: () => ({ calls: [w('src/greet.mjs', IMPL)], finish: { summary: 'tests look wrong', files: [], disputedTests: ['test/greet.test.mjs: "greets and trims" expects trimming the spec does not ask for'] } }) });
  const d = await runGreenfield(disputing);
  assert.equal(byId(d.run, 'impl').status, 'escalated');
  assert.equal(byId(d.run, 'impl').escalation.kind, 'test-dispute');
  assert.match(byId(d.run, 'impl').error, /disputes QA-owned test/);
  assert.equal(fs.readFileSync(path.join(d.ws, TEST_PATH), 'utf8'), TEST);
  assert.equal(byId(d.run, 'qa-verify').status, 'blocked');
  assert.equal(d.run.status, 'needs_attention');
});

// ── 7/8/9. Independent QA finds what the engineer missed, and sends it back ───────────────────────────────────

test('independent QA catches a defect the engineer\'s own checks missed and returns it through the repair workflow', async () => {
  // The engineer's first implementation (no trimming) passes its own syntax check; the repaired one has the trim.
  let impls = 0;
  const prov3 = team({ impl: () => { impls++; return [w('src/greet.mjs', impls >= 2 ? IMPL : IMPL_NO_TRIM)]; } });
  const { run, events } = await runGreenfield(prov3);
  assert.equal(run.status, 'completed', why(run));
  const impl = byId(run, 'impl');
  const qa = byId(run, 'qa-verify');
  assert.equal(impl.attempts.length, 2, 'the engineer ran again because QA sent the implementation back');
  assert.ok(impl.attempts[0].ok, 'its own checks (syntax) passed the first time');
  assert.match(prov3.log.briefs.impl[1], /Independent QA \(qa-verify, round 1 of 2\)/);
  assert.match(prov3.log.briefs.impl[1], /node --test/);
  assert.equal(qa.attempts.length, 2);
  assert.equal(qa.attempts[0].ok, false);
  assert.ok(qa.attempts[0].verification.some((v) => v.command === 'node --test' && v.exitCode !== 0), 'QA failure carries the real failing run');
  assert.equal(run.testContract.qaRounds['qa-verify'], 1);
  assert.ok((await events()).some((e) => e.type === 'qa.defects' && e.sentBackTo[0] === 'impl'));
  assert.deepEqual(order(prov3).filter((x) => x === 'impl' || x === 'qa-verify'), ['impl', 'qa-verify', 'impl', 'qa-verify']);
  assert.equal(run.checklist.find((c) => c.id === 'qa').ok, true);
});

test('success is never reported while independent QA is unresolved, skipped or incomplete', async () => {
  // A defect that never gets fixed: QA sends it back until the rounds run out, then the QA task escalates.
  const prov = team({ impl: () => [w('src/greet.mjs', IMPL_NO_TRIM)] });
  const { run, factory } = await runGreenfield(prov, { maxAttempts: 1 });
  assert.equal(byId(run, 'qa-verify').status, 'escalated');
  assert.equal(byId(run, 'impl').attempts.length, 3, 'one attempt per QA round, then QA gives up honestly');
  assert.equal(run.status, 'needs_attention');
  assert.equal(run.checklist.find((c) => c.id === 'qa').ok, false);
  assert.equal(run.checklist.find((c) => c.id === 'tests').ok, false);
  // Skipping the QA task unblocks the graph but does not satisfy the contract.
  await factory.skipTask(run.id, 'qa-verify');
  const after = await factory.active.get(run.id).promise;
  assert.equal(byId(after, 'qa-verify').status, 'skipped');
  assert.equal(after.status, 'needs_attention');
  assert.match(after.checklist.find((c) => c.id === 'qa').detail, /independent QA "qa-verify" is skipped/);

  // Unit: pending, running and blocked QA all fail the item.
  const { plan: p } = enforceTestFirst(modelPlan());
  const base = { plan: { ...p, tasks: p.tasks.map((t) => ({ ...t, status: 'completed', attempts: [] })) }, testContract: { sealed: {}, baseline: [{ taskId: 'qa-define', command: 'x', classification: 'expected-failure' }] } };
  const ws = new Workspace(tmpDir('da-prompt-qa-'));
  assert.equal(qaChecklistItem(base, ws).ok, true);
  for (const status of ['pending', 'running', 'blocked', 'escalated', 'skipped']) {
    const r = structuredClone(base);
    r.plan.tasks.find((t) => t.id === 'qa-verify').status = status;
    assert.equal(qaChecklistItem(r, ws).ok, false, status);
  }
  const noBaseline = structuredClone(base);
  noBaseline.testContract.baseline = [];
  assert.match(qaChecklistItem(noBaseline, ws).detail, /no baseline was recorded/);
});

// ── 10/14. Evidence belongs to a code state ──────────────────────────────────────────────────────────────────────

test('evidence is reused only for the same code state and only from independent QA; a different state is verified again', async () => {
  const run = {};
  recordEvidence(run, { taskId: 'qa-verify', taskKind: KIND_INDEPENDENT_QA, command: 'npm test', exitCode: 0, codeState: 'aaaa', output: 'ok' });
  recordEvidence(run, { taskId: 'impl', taskKind: null, command: 'npm test', exitCode: 0, codeState: 'bbbb', output: 'ok' });
  assert.equal(reusableEvidence(run, 'npm test', 'aaaa').taskId, 'qa-verify');
  assert.equal(reusableEvidence(run, 'npm test', 'cccc'), null, 'different code');
  assert.equal(reusableEvidence(run, 'npm run lint', 'aaaa'), null, 'different verification contract');
  assert.equal(reusableEvidence(run, 'npm test', 'bbbb'), null, 'an engineer\'s own run never stands in for independent QA');
  assert.equal(reusableEvidence(run, 'npm test', null), null);

  const root = tmpDir('da-prompt-state-');
  fs.writeFileSync(path.join(root, 'a.js'), '1');
  const s1 = workspaceState(root).hash;
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules/x.js'), 'x');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'notes');
  assert.equal(workspaceState(root).hash, s1, 'dependencies and the factory\'s notes are not code under test');
  fs.writeFileSync(path.join(root, 'a.js'), '2');
  assert.notEqual(workspaceState(root).hash, s1);

  // End to end: code changed after QA verified it → the final verification runs again; unchanged → reused, once.
  const counter = path.join(tmpDir('da-prompt-count-'), 'runs');
  const cmd = `echo x >> ${counter}; node --test`;
  const count = () => fs.readFileSync(counter, 'utf8').trim().split('\n').length;
  const unchanged = team({}, { plan: () => modelPlan({ finalVerify: [cmd] }) });
  const a = await runGreenfield(unchanged);
  assert.equal(a.run.status, 'completed', why(a.run));
  assert.deepEqual([a.run.finalVerification[0].reused?.taskId, a.run.finalVerification[0].exitCode], ['qa-verify', 0]);
  assert.equal(count(), 2, 'baseline once, independent QA once; the final gate reused QA\'s result instead of a third run');

  // A later task changes the code after independent QA verified it: QA's result no longer applies to what is delivered.
  fs.rmSync(counter);
  const later = () => plan([
    task('prd', { role: 'product' }),
    task('impl', { dependsOn: ['prd'], verify: ['node --check src/greet.mjs'], acceptance: ['greets'] }),
    task('verify', { role: 'qa', dependsOn: ['impl'], verify: [cmd] }),
    task('docs', { role: 'product', dependsOn: ['verify'] }),
  ], { finalVerify: [cmd] });
  const changed = team({ verify: () => [sh('node --test')], docs: () => [w('src/late.mjs', 'export const late = 1;\n')] }, { plan: later });
  const b = await runGreenfield(changed);
  assert.equal(b.run.status, 'completed', why(b.run));
  assert.equal(byId(b.run, 'verify').kind, KIND_INDEPENDENT_QA);
  assert.equal(b.run.finalVerification[0].reused, undefined, 'a result for other code is never reused');
  assert.equal(count(), 3, 'baseline, independent QA, and a fresh final run on the changed code');
});

// ── 11. Budget ───────────────────────────────────────────────────────────────────────────────────────────────────

test('budget exhaustion in the middle of the workflow is reported as incomplete, not as success', async () => {
  const prov = team({}, { usage: { input_tokens: 6000, output_tokens: 0 } });
  const { run } = await runGreenfield(prov, { tokenBudget: 10_000 });
  assert.equal(run.status, 'needs_attention');
  assert.match(run.error, /token budget exhausted/);
  assert.notEqual(byId(run, 'qa-verify').status, 'completed');
  assert.ok(!run.checklist?.length || run.checklist.every((c) => c.id !== 'qa' || !c.ok));
  assert.ok(!order(prov).includes('qa-verify'));
});

// ── 13. Concurrency inside the prerequisites ─────────────────────────────────────────────────────────────────────

test('independent tasks run concurrently, but never ahead of their prerequisites', async () => {
  const p = () => plan([
    task('prd', { role: 'product' }),
    task('research', { role: 'research' }),
    task('ui', { role: 'design', dependsOn: ['prd'] }),
    task('impl', { dependsOn: ['prd'], verify: ['node --check src/greet.mjs'], acceptance: ['greets'] }),
  ], { finalVerify: ['node --test'] });
  const prov = team({ research: () => [w('research.md', 'notes\n')], ui: () => [w('ui.html', '<p>hi</p>\n')] }, { plan: p, delay: 120 });
  const { run } = await runGreenfield(prov, { maxParallel: 4 });
  assert.equal(run.status, 'completed', why(run));
  const span = (id) => [Date.parse(byId(run, id).attempts[0].startedAt), Date.parse(byId(run, id).attempts[0].finishedAt)];
  const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];
  assert.ok(overlaps(span('prd'), span('research')), 'unrelated tasks overlap');
  assert.ok(overlaps(span('qa-define'), span('ui')), 'the UI task does not wait for QA, it is not implementation');
  assert.ok(span('impl')[0] >= span('qa-define')[1], 'implementation starts only after the test definition finished');
  assert.ok(span('qa-verify')[0] >= span('impl')[1]);
  assert.ok(span('qa-define')[0] >= span('prd')[1], 'QA waits for the requirements');
});

// ── 3/12. Existing project ───────────────────────────────────────────────────────────────────────────────────────

const EXISTING = {
  ...NODE_FILES,
  'src/greeting.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatGreeting } from './greeting.js';\ntest('greets a named person', () => assert.equal(formatGreeting('Randy'), 'Hello, Randy!'));\ntest('rejects an empty name', () => assert.throws(() => formatGreeting('  '), /name/i));\n",
};
delete EXISTING['test/greet.test.js'];
delete EXISTING['src/greet.js'];
const GREETING = "export function formatGreeting(name) {\n  const n = String(name ?? '').trim();\n  if (!n) throw new Error('name is required');\n  return `Hello, ${n}!`;\n}\n";

test('existing project: adequate existing tests are relied on, not duplicated; they are baselined, sealed and independently re-run', async () => {
  const { cfg: rootCfg } = makeRoot({ app: (d) => fs.cpSync(makeRepo(EXISTING), d, { recursive: true }) });
  const existingPlan = () => plan([task('impl', { files: ['src/greeting.js'], verify: ['node --check src/greeting.js'], acceptance: ['formatGreeting trims and greets', 'an empty name throws'] })], { finalVerify: ['npm test'] });
  let impls = 0;
  const prov = new Scripted({
    plan: existingPlan,
    task: ({ task: t, turn }) => {
      if (t.id === 'qa-define') return turn === 0 ? [sh('npm test || true')] : [toolUse('complete_task', { summary: 'the existing tests cover both criteria; none added', files: [], testFiles: ['src/greeting.test.js'], commands: [], nextSteps: [] })];
      if (t.id === 'impl') return turn === 0 ? (impls++, [toolUse('write_file', { path: 'src/greeting.js', content: GREETING })]) : [done('implemented')];
      return turn === 0 ? [sh('npm test')] : [done('verified independently')];
    },
  });
  const { cfg, store, factory } = setup({ provider: prov, cfg: rootCfg });
  const created = await factory.createRun({ idea: 'Implement formatGreeting', provider: 'offline', source: { mode: 'local', directoryId: dirId(cfg, 'app') }, settings: { testFirst: true } });
  const run = await factory.start(created.id);
  assert.equal(run.status, 'completed', why(run));
  assert.deepEqual(run.plan.tasks.map((t) => t.id).sort(), ['impl', 'qa-define', 'qa-verify']);
  assert.equal(run.project.baseline[0].status, 'failed', 'the project baseline (before any change) was captured');
  const [b] = run.testContract.baseline;
  assert.deepEqual([b.command, b.classification], ['npm test', 'expected-failure']);
  assert.deepEqual(Object.keys(run.testContract.sealed), ['src/greeting.test.js']);
  const ws = store.workspaceDir(run.id);
  assert.equal(fs.readFileSync(path.join(ws, 'src/greeting.test.js'), 'utf8'), EXISTING['src/greeting.test.js'], 'existing tests are unchanged');
  assert.deepEqual(run.changes.files.map((f) => f.path), ['src/greeting.js'], 'no duplicate or new test file was added');
  assert.equal(run.checklist.find((c) => c.id === 'qa').ok, true);
  assert.equal(run.checklist.find((c) => c.id === 'tests').ok, true);
  assert.equal(impls, 1);
});

test('testFirst can be turned off for a run, and then the plan is exactly the planner\'s', async () => {
  const prov = team({}, { plan: () => modelPlan() });
  const { run } = await runGreenfield(prov, { testFirst: false });
  assert.deepEqual(run.plan.tasks.map((t) => t.id), ['prd', 'impl']);
  assert.equal(run.testContract, undefined);
  assert.ok(!run.checklist.some((c) => c.id === 'qa'));
});
