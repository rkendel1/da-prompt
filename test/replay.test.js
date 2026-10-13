// Deterministic agent-loop replay: scripted model replies, real factory. What these prove: for the supplied sequence of replies the
// factory executes tools only inside the sandbox, lets verification (not the model's claims) decide, keeps retries bounded, and
// reports failed, cancelled and undelivered runs as such. What they do NOT prove: that any model would write these replies, or
// anything about model quality or speed. No Ollama, no credentials, no network (blockNetwork() fails any off-machine connection).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blockNetwork, blocked } from './offline-guard.js';
import { runReplay, runInvariants } from './replay-helpers.js';
import { FIXTURES, w, cmd, finish, FAREWELL, PLAN_ONE } from './replay/fixtures.js';
import { git } from './project-helpers.js';

const restoreNet = blockNetwork();
after(() => {
  restoreNet();
  assert.deepEqual(blocked, [], 'no replay attempted to leave this machine');
});
const agentTurns = (r) => r.records.filter((x) => x.type === 'call' && x.purpose === 'agent_turn');
const kinds = (r) => r.provider.requests.map((q) => q.kind);

test('1. a valid tool call, real execution and passing verification complete the run — and the record shows each step', async () => {
  const r = await runReplay(FIXTURES.success);
  runInvariants(r.run, r.store);
  assert.equal(r.run.status, 'completed', JSON.stringify(r.run.checklist));
  const t = r.run.plan.tasks[0];
  assert.deepEqual([t.status, t.attempts.length, t.attempts[0].ok], ['completed', 1, true]);
  // Tool execution: what ran, in order, with real results.
  assert.deepEqual(r.tools.map((e) => [e.tool, e.ok]), [['write_file', true], ['write_file', true], ['run_command', true]]);
  assert.equal(r.tools[2].exitCode, 0);
  // Verification is the factory's own run of the plan's commands, not the model's word.
  assert.equal(t.attempts[0].verification[0].command, 'npm test');
  assert.equal(t.attempts[0].verification[0].ok, true);
  assert.equal(r.evidence.factory.verdict, 'verified');
  assert.equal(r.evidence.factory.final[0].state, 'passed');
  assert.deepEqual(r.evidence.agent.claims.map((c) => c.summary), ['added farewell with a test']);
  assert.match(r.evidence.agent.note, /not evidence/);
  assert.deepEqual(r.run.changes.files.map((f) => f.path).sort(), ['src/farewell.js', 'test/farewell.test.js']);
  assert.equal(r.run.delivery.integrity.ok, true);
  assert.deepEqual([r.diag.calls.byPurpose.plan.count, r.diag.calls.byPurpose.agent_turn.count, r.diag.calls.byPurpose.summary.count], [1, 4, 1]);
  assert.equal(git(r.source, 'status', '--porcelain'), '', 'the source project was not touched');
});

test('2. calls the sandbox must refuse are refused and recorded, nothing outside the workspace changes, and the run can still finish honestly', async () => {
  const abs = path.join(os.tmpdir(), `da-prompt-replay-escape-${process.pid}-${Date.now()}`);
  const fixture = { ...FIXTURES.sandboxRejections, attempts: [FIXTURES.sandboxRejections.attempts[0].map((s) => (Array.isArray(s) && s[0].input?.path === 'ESCAPE_ABSOLUTE' ? [w(abs, 'outside')] : s))] };
  const r = await runReplay(fixture);
  runInvariants(r.run, r.store);
  const rejected = r.tools.slice(0, 7);
  assert.ok(rejected.every((e) => e.ok === false), JSON.stringify(rejected.map((e) => [e.tool, e.ok])));
  assert.match(rejected[0].output, /escapes workspace/);
  assert.match(rejected[1].output, /absolute paths are not allowed/);
  assert.match(rejected[2].output, /writing inside \.git is not allowed/);
  assert.equal(rejected[3].exitCode, 126, 'a policy-blocked command exits 126 without running');
  assert.match(rejected[3].output, /blocked: installing dependencies/);
  assert.match(rejected[4].output, /unknown tool/);
  assert.match(rejected[5].output, /path is required/);
  assert.match(rejected[6].output, /escapes workspace/);
  // The boundary held.
  assert.equal(fs.existsSync(abs), false);
  assert.equal(fs.existsSync(path.join(r.store.runDir(r.id), 'escape.txt')), false);
  assert.equal(fs.existsSync(path.join(r.store.workspaceDir(r.id), 'node_modules')), false);
  assert.equal(git(r.source, 'status', '--porcelain'), '');
  // …and the legitimate work after the refusals still counts, verified as usual.
  assert.deepEqual(r.tools.slice(7).map((e) => [e.tool, e.ok]), [['write_file', true]]);
  assert.equal(r.run.status, 'completed', JSON.stringify(r.run.checklist));
  assert.equal(r.diag.tools.failed, 7);
});

test('3. a failed command followed by a valid recovery completes within one attempt, and both outcomes are on record', async () => {
  const r = await runReplay(FIXTURES.recovery);
  runInvariants(r.run, r.store);
  assert.deepEqual(r.tools.map((e) => [e.tool, e.ok, e.exitCode ?? null]), [['run_command', false, 3], ['write_file', true, null], ['run_command', true, 0]]);
  assert.equal(r.run.plan.tasks[0].attempts.length, 1);
  assert.equal(r.run.status, 'completed');
  assert.equal(r.diag.tools.failed, 1);
  assert.deepEqual(r.diag.repeatedToolFailures, [], 'one failure is not a loop');
});

test('4. the same failing action repeated forever stays bounded: turns, attempts and model calls are capped, and the loop is reported', async () => {
  const r = await runReplay(FIXTURES.repeatedFailure);
  runInvariants(r.run, r.store);
  const t = r.run.plan.tasks[0];
  assert.equal(t.status, 'escalated');
  assert.equal(t.attempts.length, 2, 'maxAttempts');
  assert.ok(t.attempts.every((a) => a.ok === false && /did not finish within 4 turns/.test(a.error)));
  assert.equal(agentTurns(r).length, 8, 'attempts × maxAgentTurns, not one more');
  assert.equal(kinds(r).filter((k) => k === 'plan').length, 1);
  assert.notEqual(r.run.status, 'completed');
  assert.equal(r.diag.repeatedToolFailures[0].count, 8);
  assert.equal(r.diag.repeatedToolFailures[0].tool, 'run_command');
  assert.match(t.attempts[1].feedback || '', /did not complete the task/, 'the second attempt was told why the first failed');
  assert.ok(r.run.plan.tasks[0].escalation.options.length > 0, 'escalation offers a way forward to a person');
});

test('5. a model that claims success while the checks fail does not get a completed run', async () => {
  const r = await runReplay(FIXTURES.falseClaim);
  runInvariants(r.run, r.store);
  const t = r.run.plan.tasks[0];
  assert.equal(t.attempts[0].result.summary, 'all tests pass, verified', 'the claim is recorded as a claim');
  assert.equal(t.attempts[0].ok, false);
  assert.equal(t.attempts[0].verification[0].ok, false);
  assert.notEqual(t.attempts[0].verification[0].exitCode, 0);
  assert.match(t.attempts[0].feedback, /npm test/);
  assert.equal(t.status, 'escalated');
  assert.equal(t.result, undefined, 'a task result exists only for verified work');
  assert.equal(r.run.status, 'needs_attention');
  assert.equal(r.evidence.agent.claims.length, 0, 'unverified claims are not offered as results');
  assert.equal(r.evidence.factory.verdict, 'failed');
  assert.ok(r.evidence.factory.final.some((f) => !f.ok), 'the factory\'s own final check failed too');
  assert.equal(r.run.checklist.find((c) => c.id === 'tests').ok, false);
  assert.equal(r.run.checklist.find((c) => c.id === 'tasks').ok, false);
});

test('6. cancelling before completion yields a cancelled run: kept evidence, no delivery, no verified-looking state', async () => {
  const r = await runReplay(FIXTURES.cancelled, { cancel: true });
  runInvariants(r.run, r.store);
  assert.equal(r.run.status, 'cancelled');
  assert.equal(r.run.delivery, undefined);
  assert.notEqual(r.run.plan.tasks[0].status, 'completed');
  assert.deepEqual(r.tools.map((e) => [e.tool, e.ok]), [['write_file', true]], 'what happened before the cancel is still on record');
  assert.ok(fs.existsSync(path.join(r.store.workspaceDir(r.id), 'src/farewell.js')), 'the workspace is kept');
  assert.ok(r.evidence.missing.includes('The run has not been delivered yet.'));
  assert.ok(r.records.some((c) => c.type === 'call' && c.purpose === 'agent_turn' && c.outcome === 'cancelled'));
  assert.equal(r.run.checklist.length, 0, 'no checklist is produced, so nothing can read as passed');
  assert.equal(git(r.source, 'status', '--porcelain'), '');
});

test('7a. checks that passed do not hide a delivery failure: a run that tampered with the source branch needs attention', async () => {
  const sneaky = {
    idea: 'Evade the command policy and move a branch',
    attempts: [[[w('src/farewell.js', FAREWELL)], [cmd('g=git; $g branch -f main HEAD~0 2>/dev/null; $g checkout -q -b elsewhere && echo x > x.txt && $g add -A && $g commit -q -m sneaky')], [finish('done', ['src/farewell.js'])]]],
  };
  const r = await runReplay(sneaky);
  runInvariants(r.run, r.store);
  assert.equal(r.run.finalVerification.every((f) => f.ok), true, 'the project checks themselves passed');
  assert.equal(r.run.delivery.integrity.ok, false);
  assert.match(r.run.delivery.integrity.problems.join(' '), /not the run branch|moved from the baseline/);
  assert.equal(r.run.delivery.readiness.ready, false);
  assert.equal(r.run.status, 'needs_attention', 'passing verification does not turn a failed delivery into success');
  assert.match(fs.readFileSync(path.join(r.store.deliveryDir(r.id), 'FACTORY_REPORT.md'), 'utf8'), /Source protection: VIOLATED/);
});

test('7b. missing evidence is not success: a project with no checks is "unverified" and the run is not completed', async () => {
  const noTests = { idea: 'Edit a note', planArgs: [[], []], attempts: [[[w('a.txt', 'changed\n')], [finish('edited a.txt', ['a.txt'])]]] };
  const r = await runReplay(noTests, { files: { 'a.txt': 'x\n' } });
  runInvariants(r.run, r.store);
  assert.equal(r.run.plan.tasks[0].status, 'completed', 'the task itself had nothing to check');
  assert.equal(r.evidence.factory.verdict, 'unverified');
  assert.ok(r.evidence.missing.some((m) => /No project check ran/.test(m)));
  assert.ok(r.evidence.missing.some((m) => /no baseline/.test(m)));
  assert.equal(r.run.checklist.find((c) => c.id === 'tests').state, 'skipped');
  assert.notEqual(r.run.status, 'completed', 'no unsupported success claim');
  assert.equal(r.run.status, 'needs_attention');
});

test('8a. empty and non-answers are nudged, then cut off by the turn bound and the attempt bound', async () => {
  const r = await runReplay(FIXTURES.emptyReplies);
  runInvariants(r.run, r.store);
  const t = r.run.plan.tasks[0];
  assert.equal(t.attempts.length, 2);
  assert.ok(t.attempts.every((a) => /did not finish within 3 turns/.test(a.error)));
  assert.equal(agentTurns(r).length, 6, '2 attempts × 3 turns');
  const nudged = r.provider.requests.filter((q) => q.kind === 'task').flatMap((q) => q.messages).filter((m) => m.role === 'user' && m.content === 'Continue the task using the tools, and call complete_task when it is done and verified.');
  assert.ok(nudged.length >= 2, 'the loop asks the model to continue instead of accepting silence');
  assert.equal(r.tools.length, 0);
  assert.notEqual(r.run.status, 'completed');
  assert.equal(r.run.plan.tasks[0].status, 'escalated');
});

test('8b. a planner that never produces a plan fails the run after exactly three calls, with nothing executed', async () => {
  const r = await runReplay({ idea: 'x', planResponses: [{ empty: true }, { text: 'Here is my plan: do it.' }, { empty: true }], attempts: [] });
  runInvariants(r.run, r.store);
  assert.equal(r.run.status, 'failed');
  assert.match(r.run.error, /planner could not produce a valid plan after 3 attempts/);
  assert.equal(kinds(r).filter((k) => k === 'plan').length, 3);
  assert.equal(kinds(r).filter((k) => k === 'task').length, 0);
  assert.equal(r.run.plan, null);
  assert.equal(r.run.delivery, undefined);
});

test('8c. an invalid plan is sent back with the reasons and a corrected plan is accepted', async () => {
  const r = await runReplay({ idea: 'x', planResponses: [{ plan: { tasks: [], finalVerify: ['npm test'] } }, { plan: PLAN_ONE() }], attempts: FIXTURES.success.attempts });
  runInvariants(r.run, r.store);
  const plans = r.provider.requests.filter((q) => q.kind === 'plan');
  assert.equal(plans.length, 2);
  const feedback = JSON.stringify(plans[1].messages.at(-1).content);
  assert.match(feedback, /The plan is invalid/);
  assert.equal(r.run.status, 'completed', r.run.error);
  assert.ok(r.events.some((e) => e.type === 'log' && e.level === 'warn' && /Plan attempt 1 rejected/.test(e.text)));
});

test('a provider call that throws fails the task visibly, is not retried by the factory, and cannot complete the run', async () => {
  const r = await runReplay({ idea: 'x', attempts: [[[w('src/farewell.js', FAREWELL)], { fail: 'Replay (scripted): rate limited: HTTP 429: slow down' }]] });
  runInvariants(r.run, r.store);
  const t = r.run.plan.tasks[0];
  assert.equal(t.status, 'escalated');
  assert.match(t.error, /rate limited/);
  assert.equal(agentTurns(r).length, 2);
  assert.equal(r.diag.calls.failuresByKind.rate_limited, 1);
  assert.notEqual(r.run.status, 'completed');
  assert.equal(r.run.checklist.find((c) => c.id === 'tasks').ok, false);
});

test('replays are repeatable: the same fixture gives the same outcome and the same sequence of recorded steps', async () => {
  const shape = (r) => ({ status: r.run.status, tools: r.tools.map((e) => [e.tool, e.ok, e.exitCode ?? null]), attempts: r.run.plan.tasks.map((t) => [t.status, t.attempts.length]), verdict: r.evidence.factory.verdict, calls: r.diag.calls.count });
  assert.deepEqual(shape(await runReplay(FIXTURES.recovery)), shape(await runReplay(FIXTURES.recovery)));
  assert.deepEqual(shape(await runReplay(FIXTURES.falseClaim)), shape(await runReplay(FIXTURES.falseClaim)));
});
