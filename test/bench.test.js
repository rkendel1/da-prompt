// The benchmark harness, exercised with the deterministic reference "model" only: no Ollama, no credentials, no network.
// These tests prove report generation, failure handling and comparison. They say nothing about any real model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers.js';
import { loadTasks, materialize, accept, runBenchmark, buildReport, compareReports, BENCH_SCHEMA } from '../src/bench.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bench = (...args) => spawnSync(process.execPath, ['scripts/bench.mjs', ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpDir() } });
const tasks = loadTasks();

test('four fixed task definitions with explicit acceptance criteria, each of which fails on the untouched repository', async () => {
  assert.deepEqual(tasks.map((t) => t.kind), ['repository investigation + implementation', 'multi-file implementation', 'single-file edit', 'test-driven bug fix']);
  for (const t of tasks) {
    assert.ok(t.idea && t.acceptance.length > 0 && Object.keys(t.reference).length > 0, t.id);
    const dir = materialize(t, tmpDir());
    const before = await accept(t, dir);
    assert.equal(before.ok, false, `${t.id}: the acceptance checks must fail before any change (otherwise they prove nothing)`);
    assert.ok(!fs.existsSync(path.join(dir, 'accept.mjs')), 'acceptance files do not stay in the project');
    // …and pass once the reference solution is applied, in the same directory.
    for (const [p, c] of Object.entries(t.reference)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); }
    const after = await accept(t, dir);
    assert.equal(after.ok, true, `${t.id}: ${JSON.stringify(after.results.filter((r) => !r.ok))}`);
  }
});

test('a mock run goes through the real factory for every task and records a complete, labelled report', async () => {
  const report = await runBenchmark({ tasks, mode: 'mock', settings: { maxParallel: 1 } });
  assert.equal(report.schema, BENCH_SCHEMA);
  assert.equal(report.mode, 'mock');
  assert.match(report.notice, /^MOCK RUN: .*do not describe any model/);
  assert.equal(report.summary.attempted, 4);
  assert.equal(report.summary.passed, 4, JSON.stringify(report.results.map((r) => [r.taskId, r.status, r.error])));
  assert.equal(report.summary.passRate, 1);
  assert.equal(report.config.settings.maxParallel, 1, 'the serial setting is the effective one');
  assert.deepEqual([report.config.provider, report.config.model, report.config.engine], ['mock', 'reference-solution', 'builtin']);
  assert.ok(report.repository.revision === null || /^[0-9a-f]{40}$/.test(report.repository.revision));
  for (const r of report.results) {
    assert.equal(r.status, 'passed');
    assert.equal(r.runStatus, 'completed');
    assert.ok(r.wallMs > 0 && r.calls.count > 0 && r.turns > 0 && r.toolCalls > 0);
    assert.ok('plan' in r.phasesMs && 'execution' in r.phasesMs);
    assert.deepEqual(r.retries, { transport: 0, taskAttempts: 0 });
    assert.equal(r.tokens.basis, 'synthetic (characters / 4), not a model count');
    assert.equal(r.verification.checklistPassed, r.verification.checklistTotal);
    assert.equal(r.acceptance.ok, true);
    assert.equal(r.delivery.produced, true);
    assert.equal(r.expectedFilesChanged, true);
    assert.deepEqual(r.calls.byPurpose.plan.count, 1);
  }
  assert.equal(JSON.parse(JSON.stringify(report)).configId, report.configId, 'the report is plain JSON');
});

test('failed, incomplete and errored attempts stay in the report and in the denominator', async () => {
  const broken = { ...tasks.find((t) => t.id === 'single-file-edit'), id: 'broken-reference', reference: { 'src/greet.js': 'export const greet = (name) => `Hi ${name}`;\n' } };
  const failed = await runBenchmark({ tasks: [broken], mode: 'mock' });
  assert.equal(failed.results[0].status, 'failed');
  assert.equal(failed.results[0].acceptance.ok, false, 'the independent check caught what the factory did not: the task asked for something else');
  assert.equal(failed.summary.passRate, 0);

  const slow = await runBenchmark({ tasks: [tasks[2]], mode: 'mock', runTimeoutMs: 5 });
  assert.equal(slow.results[0].status, 'incomplete');
  assert.match(slow.results[0].error, /harness time limit/);
  assert.notEqual(slow.results[0].runStatus, 'completed');
  assert.equal(slow.results[0].acceptance.skipped, 'the run did not finish');

  const err = await runBenchmark({ tasks: [tasks[2]], mode: 'mock', cfg: { projectRoots: [] } });
  assert.equal(err.results[0].status, 'error');
  assert.ok(err.results[0].error.length > 0);
  assert.equal(err.summary.error, 1);

  const mixed = buildReport({ config: { mode: 'live', provider: 'p', model: 'm', engine: 'builtin' }, results: [...failed.results, ...slow.results, ...err.results, { taskId: 'x', status: 'passed', wallMs: 10 }] });
  assert.deepEqual([mixed.summary.attempted, mixed.summary.passed, mixed.summary.failed, mixed.summary.incomplete, mixed.summary.error], [4, 1, 1, 1, 1]);
  assert.equal(mixed.summary.passRate, 0.25, 'one pass out of four attempts, not one out of one success');
});

test('refusing to guess: live mode needs an explicit provider and model, and mock mode cannot pretend to be another engine', async () => {
  await assert.rejects(runBenchmark({ tasks, mode: 'live' }), /explicit provider and model/);
  await assert.rejects(runBenchmark({ tasks, mode: 'mock', engine: 'fx' }), /built-in engine only/);
  await assert.rejects(runBenchmark({ tasks, mode: 'fast' }), /mock.*live/);
});

test('reports compare by configuration, and never treat mock and live as comparable', () => {
  const mk = (mode, settings, results) => buildReport({ config: { mode, provider: 'p', model: 'm', engine: 'builtin', settings }, results });
  const row = (id, status, wallMs, calls) => ({ taskId: id, status, wallMs, calls: { count: calls }, toolCalls: 3, retries: { transport: 0, taskAttempts: 0 } });
  const a = mk('live', { maxParallel: 3 }, [row('t1', 'passed', 100, 5), row('t2', 'failed', 300, 9)]);
  const b = mk('live', { maxParallel: 1 }, [row('t1', 'passed', 80, 5), row('t2', 'passed', 250, 7)]);
  const c = compareReports(a, b);
  assert.equal(c.sameConfig, false);
  assert.deepEqual(c.configDiff, [{ key: 'settings.maxParallel', a: 3, b: 1 }]);
  assert.deepEqual(c.tasks.map((t) => [t.id, t.a.passed, t.b.passed]), [['t1', 1, 1], ['t2', 0, 1]]);
  assert.deepEqual(c.notes.filter((n) => /Modes differ|mock/.test(n)), []);
  assert.equal(compareReports(a, a).sameConfig, true);
  const mixedModes = compareReports(a, mk('mock', { maxParallel: 3 }, [row('t1', 'passed', 1, 1)]));
  assert.ok(mixedModes.notes.some((n) => /not comparable/.test(n)));
  assert.ok(mixedModes.notes.some((n) => /mock report contains no model measurements/.test(n)));
  assert.equal(buildReport({ config: { mode: 'mock' }, results: [] }).summary.passRate, null, 'no attempts, no rate');
});

test('the script: modes are explicit, a live run is never implied, the dry run executes nothing, and compare works on saved files', () => {
  assert.equal(bench('run').status, 2);
  assert.match(bench('run').stderr, /Choose a mode/);
  const live = bench('run', '--live');
  assert.equal(live.status, 2);
  assert.match(live.stderr, /explicit --provider and --model/);
  const dry = bench('run', '--mock', '--dry-run', '--tasks', 'tdd-bugfix', '--parallel', '1');
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout), { mode: 'mock', provider: 'mock', model: 'reference-solution', engine: 'builtin', tasks: ['tdd-bugfix'], repeat: 1, settings: { maxParallel: 1 }, providerOptions: {} });
  // A live run whose provider is not configured stops at the offline preflight: nothing is run, no request is made.
  const nokey = bench('run', '--live', '--provider', 'anthropic', '--model', 'x');
  assert.equal(nokey.status, 1);
  assert.match(nokey.stderr, /needs an API key/);
  assert.match(nokey.stderr, /nothing was run/);
  assert.match(bench('list').stdout, /single-file-edit[\s\S]*tdd-bugfix/);
  assert.equal(bench('run', '--mock', '--tasks', 'nope').status, 2);

  const out = path.join(tmpDir(), 'report.json');
  const ran = bench('run', '--mock', '--tasks', 'single-file-edit', '--out', out);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /MOCK RUN/);
  const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(saved.summary.passed, 1);
  const cmp = bench('compare', out, out);
  assert.equal(cmp.status, 0, cmp.stderr);
  assert.match(cmp.stdout, /same configuration/);
});
