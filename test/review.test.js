import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildEvidence } from '../src/evidence.js';
import { makeRepo, makeRoot, dirId, git, writeFiles, setup, Scripted, task, plan, toolUse, done, NODE_FILES } from './project-helpers.js';

const writer = (files = { 'src/new.js': 'export const x = 1;\n' }) => new Scripted({
  plan: () => plan([task('t')], { finalVerify: ['npm test'] }),
  task: ({ turn }) => (turn === 0 ? Object.entries(files).map(([p, c]) => toolUse('write_file', { path: p, content: c })) : [done('ok')]),
});
async function delivered(provider = writer()) {
  const { dirs, cfg: rootCfg } = makeRoot({ widgets: (d) => fs.cpSync(makeRepo(), d, { recursive: true }) });
  const env = setup({ provider, cfg: rootCfg });
  const run = await env.factory.start((await env.factory.createRun({ idea: 'add x', provider: 'offline', source: { mode: 'local', directoryId: dirId(env.cfg, 'widgets') } })).id);
  return { ...env, run, dir: dirs.widgets };
}

test('review: apply and publish are separate decisions that require an approval of the exact changes', async () => {
  const { factory, store, run, dir } = await delivered();
  assert.equal(run.review, undefined);
  await assert.rejects(factory.applyLocal(run.id), /review the changes and approve them before you apply them to your directory/);
  assert.equal(fs.existsSync(path.join(dir, 'src/new.js')), false);

  // Rejection blocks apply, and says why.
  const rejected = await factory.review(run.id, { decision: 'reject', note: 'needs tests' });
  assert.deepEqual([rejected.review.decision, rejected.review.note, rejected.review.files], ['rejected', 'needs tests', 1]);
  await assert.rejects(factory.applyLocal(run.id), /were rejected in review; approve them again/);

  // Approval is bound to the exact change set.
  const approved = await factory.review(run.id, { decision: 'approve' });
  assert.equal(approved.review.decision, 'approved');
  assert.match(approved.review.changesHash, /^[0-9a-f]{64}$/);
  fs.appendFileSync(path.join(store.workspaceDir(run.id), 'src/new.js'), '// changed after approval\n');
  await assert.rejects(factory.applyLocal(run.id), /different from the ones you approved/);
  assert.equal(fs.existsSync(path.join(dir, 'src/new.js')), false);
  await factory.review(run.id, { decision: 'approve' });
  const applied = await factory.applyLocal(run.id);
  assert.match(fs.readFileSync(path.join(dir, 'src/new.js'), 'utf8'), /changed after approval/);
  assert.equal(applied.delivery.local.applied.files.length, 1);

  // Clearing withdraws the decision.
  const cleared = await factory.review(run.id, { decision: 'clear' });
  assert.equal(cleared.review, undefined);
  await assert.rejects(factory.review(run.id, { decision: 'maybe' }), /decision must be/);
  const events = (await store.events(run.id)).filter((e) => e.type === 'review').map((e) => e.decision);
  assert.deepEqual(events, ['rejected', 'approved', 'approved', 'cleared']);
});

test('review is only possible for a delivered run that changed something and passed source protection', async () => {
  const noChange = await delivered(new Scripted({ plan: () => plan([task('t')], { finalVerify: [] }), task: ({ turn }) => (turn === 0 ? [toolUse('run_command', { command: 'true' })] : [done('nothing to do')]) }));
  await assert.rejects(noChange.factory.review(noChange.run.id, { decision: 'approve' }), /changed no files/);
  const fresh = setup({});
  const newRun = await fresh.factory.start((await fresh.factory.createRun({ idea: 'A tiny app', provider: 'offline', settings: { deploy: false } })).id);
  await assert.rejects(fresh.factory.review(newRun.id, { decision: 'approve' }), /only a delivered run against an existing project/);
  const running = await delivered();
  running.factory.active.set(running.run.id, { controller: new AbortController(), promise: Promise.resolve() });
  await assert.rejects(running.factory.review(running.run.id, { decision: 'approve' }), /still executing/);
  running.factory.active.delete(running.run.id);

  const sneaky = await delivered(new Scripted({ plan: () => plan([task('t')], { finalVerify: [] }), task: ({ turn }) => (turn === 0 ? [toolUse('run_command', { command: 'g=git; $g checkout -q -b elsewhere && echo x > x.txt && $g add -A && $g commit -q -m x' })] : [done('ok')]) }));
  assert.equal(sneaky.run.delivery.integrity.ok, false);
  await assert.rejects(sneaky.factory.review(sneaky.run.id, { decision: 'approve' }), /source protection failed/);
});

test('history data is grounded in the backend: model, times, verdict, review and publication appear in the run list', async () => {
  const { factory, store, run } = await delivered();
  await factory.review(run.id, { decision: 'approve' });
  const [row] = (await store.list()).filter((r) => r.id === run.id);
  assert.deepEqual([row.status, row.verdict, row.review, row.source.mode, row.model], ['completed', 'verified', 'approved', 'local', 'offline-template-agent']);
  assert.ok(row.startedAt && row.finishedAt);
  assert.equal(row.checklistOk, true);
  assert.equal(row.publication, undefined);
});

test('evidence view: missing evidence is listed, regressions are visible, and sources never mix', async () => {
  const { run } = await delivered();
  const ev = buildEvidence(run);
  assert.deepEqual(Object.keys(ev).sort(), ['agent', 'factory', 'missing', 'notes', 'pax', 'runId', 'status']);
  assert.equal(ev.factory.verdict, 'verified');
  assert.deepEqual(ev.factory.baseline.map((b) => [b.command, b.status]), [['npm test', 'passed']]);
  assert.equal(ev.factory.final[0].state, 'passed');
  assert.equal(ev.agent.claims[0].summary, 'ok');
  assert.match(ev.agent.note, /not evidence/);
  // The only gap: this scripted task declared no task-level check, and the view says so instead of implying coverage.
  assert.deepEqual(ev.missing, ['Tasks were reported complete but no task-level check results are on record.']);
  // A run whose project has no checks says so rather than showing an empty "all clear".
  const { dirs, cfg: rootCfg } = makeRoot({ notes: (d) => writeFiles(d, { 'a.txt': 'x' }) });
  const env = setup({ provider: new Scripted({ plan: () => plan([task('t')], { finalVerify: [] }), task: ({ turn }) => (turn === 0 ? [toolUse('write_file', { path: 'a.txt', content: 'y' })] : [done('ok')]) }), cfg: rootCfg });
  const bare = await env.factory.start((await env.factory.createRun({ idea: 'edit', provider: 'offline', source: { mode: 'local', directoryId: dirId(env.cfg, 'notes') } })).id);
  const e2 = buildEvidence(bare);
  assert.equal(e2.factory.verdict, 'unverified');
  assert.ok(e2.missing.some((m) => /No project check ran/.test(m)));
  assert.ok(e2.missing.some((m) => /no baseline/.test(m)));
  void dirs; void git; void NODE_FILES;
});
