// Benchmark harness: fixed tasks, run through the real factory (Factory.createRun/start against a local git project), with an
// independent acceptance check and a machine-readable report that keeps every attempt, failed or not.
//
// It is not a second execution framework: each attempt is an ordinary existing-project run, so the sandbox, the baseline,
// per-task and final verification, the checklist and delivery are the factory's own. The harness only adds (a) deterministic
// task fixtures, (b) acceptance commands the model never sees, run in the run's workspace afterwards, and (c) bookkeeping.
//
// Modes: "mock" drives each task with a deterministic reference solution (no model, no network): it exercises the harness
// and the plumbing, and its timings and token counts say NOTHING about any model. "live" uses a real provider and is only
// entered when the caller asks for it explicitly (scripts/bench.mjs --live).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { RunStore } from './store.js';
import { Factory } from './factory.js';
import { Workspace } from './sandbox.js';
import { authorizedRoots } from './project.js';
import { OfflineProvider } from './providers/offline.js';
import { readRecords, summarizeRun, requestSize } from './diagnostics.js';
import { redact } from './security.js';

export const BENCH_SCHEMA = 'da-prompt.bench/1';
export const TASK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'tasks');
export const STATUSES = ['passed', 'failed', 'incomplete', 'error'];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@da-prompt.local', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@da-prompt.local' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

export function loadTasks(dir = TASK_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/** A committed git repository holding the task's seed files. */
export function materialize(task, parent) {
  const dir = path.join(parent, task.id);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFiles(dir, { '.gitignore': 'node_modules/\n', ...task.seed });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

/**
 * The deterministic stand-in for a model in mock mode: it lists the repository, reads the files the task points at, writes the
 * reference solution, runs the project's tests and reports. It is scripted from the task fixture, so it proves the harness and
 * the factory plumbing, not the ability of any model.
 */
export class ReferenceProvider extends OfflineProvider {
  constructor(task) {
    super({ faults: false, delayMs: 0 });
    this.task = task;
    this.name = 'mock';
    this.model = 'reference-solution';
    this.maxTokens = 0;
  }

  describe() {
    return { name: 'mock', label: 'Reference solution (mock)', model: this.model, plannerModel: this.model, dialect: 'mock', toolMode: 'native' };
  }

  steps() {
    const use = (name, input) => ({ type: 'tool_use', id: `toolu_b_${crypto.randomBytes(4).toString('hex')}`, name, input });
    return [
      use('list_files', {}),
      ...(this.task.read || []).map((p) => use('read_file', { path: p })),
      ...Object.entries(this.task.reference).map(([p, content]) => use('write_file', { path: p, content })),
      use('run_command', { command: 'npm test' }),
      use('complete_task', { summary: `Applied the reference solution for ${this.task.id}.`, files: Object.keys(this.task.reference), commands: ['npm test'], nextSteps: [] }),
    ];
  }

  async chat(req) {
    const meta = req.meta || {};
    const size = requestSize(req);
    const usage = { input_tokens: Math.ceil(size.chars / 4), output_tokens: 40, reported: true }; // synthetic: chars/4, not a model's count
    if (meta.kind === 'plan') {
      const t = this.task;
      const plan = {
        product: { name: t.title, summary: t.idea, users: ['maintainers'], successCriteria: t.acceptance.filter((a) => !a.liveOnly).map((a) => a.name) },
        tasks: [{ id: 'work', role: 'engineer', title: t.title, description: t.idea, dependsOn: [], acceptance: t.acceptance.filter((a) => !a.liveOnly).map((a) => a.name), outputs: [], files: t.read || [], verify: ['npm test'] }],
        risks: [],
        openQuestions: [],
        finalVerify: ['npm test'],
        deploy: null,
      };
      return { content: [{ type: 'tool_use', id: 'toolu_b_plan', name: 'submit_plan', input: plan }], stop_reason: 'tool_use', usage };
    }
    if (meta.kind === 'task') {
      const turn = req.messages.filter((m) => m.role === 'assistant').length;
      const steps = this.steps();
      return { content: [steps[Math.min(turn, steps.length - 1)]], stop_reason: 'tool_use', usage };
    }
    const res = await super.chat(req);
    return { ...res, usage };
  }
}

const stable = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : JSON.stringify(v));
export const configId = (config) => crypto.createHash('sha1').update(stable(config)).digest('hex').slice(0, 12);

function repoInfo() {
  try {
    return { revision: git(ROOT, 'rev-parse', 'HEAD'), dirty: git(ROOT, 'status', '--porcelain').length > 0 };
  } catch {
    return { revision: null, dirty: null };
  }
}

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Run the task's acceptance commands in the run's workspace; the files they need exist only for the duration of the check. */
export async function accept(task, wsDir, { mode = 'live' } = {}) {
  const ws = new Workspace(wsDir);
  const results = [];
  for (const a of task.acceptance) {
    if (a.liveOnly && mode === 'mock') continue; // needs something only a real model run can produce (e.g. a rendered screenshot)
    const written = Object.keys(a.files || {});
    try {
      writeFiles(wsDir, a.files || {});
      const r = await ws.runCommand(a.command, { timeoutMs: 120_000 });
      results.push({ name: a.name, command: a.command, ok: r.exitCode === 0, exitCode: r.exitCode, durationMs: r.durationMs, output: r.exitCode === 0 ? '' : redact(`${r.stdout}\n${r.stderr}`.trim()).slice(-400) });
    } catch (e) {
      results.push({ name: a.name, command: a.command, ok: false, exitCode: null, durationMs: 0, output: redact(String(e.message)).slice(0, 400) });
    } finally {
      for (const f of written) fs.rmSync(path.join(wsDir, f), { force: true });
    }
  }
  return { ok: results.length > 0 && results.every((r) => r.ok), results };
}

/**
 * Run `tasks` x `repeat` attempts. Never throws for a task-level failure: every attempt yields a result, including errors and
 * runs that did not finish, so rates are computed over everything that was attempted.
 *
 * @param {object} o
 * @param {object[]} o.tasks
 * @param {'mock'|'live'} o.mode
 * @param {string} [o.provider]  live: provider id (required)
 * @param {string} [o.model]     live: model (required)
 * @param {string} [o.engine]    builtin | fx
 * @param {object} [o.settings]  run settings (maxParallel, maxAttempts, maxAgentTurns, tokenBudget, …)
 * @param {object} [o.providerOptions]  numCtx / temperature / toolMode
 * @param {object} [o.cfg]       extra loadConfig overrides (e.g. maxOutputTokens)
 * @param {number} [o.repeat]
 * @param {number} [o.runTimeoutMs]
 * @param {(msg: string) => void} [o.log]
 */
export async function runBenchmark(o) {
  const { tasks, mode = 'mock', repeat = 1, engine = 'builtin', settings = {}, providerOptions, cfg: cfgOverrides = {}, log = () => {} } = o;
  if (!['mock', 'live'].includes(mode)) throw new Error('mode must be "mock" or "live"');
  if (mode === 'live' && (!o.provider || !o.model)) throw new Error('a live benchmark needs an explicit provider and model');
  if (mode === 'mock' && engine !== 'builtin') throw new Error('mock mode drives the built-in engine only');
  const runTimeoutMs = o.runTimeoutMs ?? (mode === 'live' ? 30 * 60_000 : 120_000);
  const started = new Date();
  const results = [];
  let effective = null;

  for (const task of tasks) {
    for (let rep = 1; rep <= repeat; rep++) {
      const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'da-prompt-bench-')));
      const projects = path.join(tmp, 'projects');
      fs.mkdirSync(projects);
      const t0 = performance.now();
      const result = { taskId: task.id, kind: task.kind, repetition: rep, status: 'error', runId: null, runStatus: null, wallMs: null, error: null };
      let factory;
      let store;
      try {
        materialize(task, projects);
        const cfg = loadConfig({ dataDir: path.join(tmp, 'data'), projectRoots: [projects], ...(mode === 'mock' ? { providerFactory: () => new ReferenceProvider(task) } : {}), ...cfgOverrides });
        store = new RunStore(cfg.dataDir);
        factory = new Factory({ cfg, store, previews: { get: () => null, stop() {}, stopAll() {}, start: async () => ({ ok: false, error: 'previews are off in benchmarks' }) } });
        const key = authorizedRoots(cfg)[0].key;
        log(`${task.id} #${rep}: starting`);
        const created = await factory.createRun({
          idea: task.idea,
          provider: mode === 'mock' ? 'offline' : o.provider,
          model: mode === 'mock' ? undefined : o.model,
          engine,
          providerOptions,
          source: { mode: 'local', directoryId: `${key}:${task.id}` },
          settings: { deploy: false, ...settings },
        });
        result.runId = created.id;
        effective ||= { settings: created.settings, providerOptions: created.providerOptions || {}, maxOutputTokens: cfg.maxOutputTokens, engine: created.engine, provider: mode === 'mock' ? 'mock' : created.provider, model: mode === 'mock' ? 'reference-solution' : created.model };

        let timer;
        const finished = factory.start(created.id);
        const timedOut = new Promise((r) => { timer = setTimeout(() => r('timeout'), runTimeoutMs); });
        const first = await Promise.race([finished, timedOut]);
        clearTimeout(timer);
        if (first === 'timeout') {
          await factory.cancel(created.id);
          await Promise.race([finished.catch(() => {}), new Promise((r) => setTimeout(r, 10_000))]);
        }
        const run = await store.load(created.id);
        const events = await store.events(created.id);
        const summary = summarizeRun(run, events, readRecords(store.runDir(created.id)));
        const acceptance = first === 'timeout' ? { ok: false, results: [], skipped: 'the run did not finish' } : await accept(task, store.workspaceDir(created.id), { mode });
        const changed = (run.changes?.files || []).map((f) => f.path); // the factory's own change record (against the base commit)
        const attempts = summary.outcome.tasks.attempts;
        Object.assign(result, {
          status: first === 'timeout' ? 'incomplete' : run.status === 'completed' && acceptance.ok ? 'passed' : 'failed',
          runStatus: run.status,
          error: first === 'timeout' ? `harness time limit (${Math.round(runTimeoutMs / 1000)} s) passed; the run was cancelled` : run.error ? redact(String(run.error)).slice(0, 300) : null,
          phasesMs: summary.phases.durationMs,
          calls: { count: summary.calls.count, byPurpose: Object.fromEntries(Object.entries(summary.calls.byPurpose).map(([k, v]) => [k, { count: v.count, failed: v.failed, durationMs: v.durationMs }])), durationMs: summary.calls.durationMs.total, failuresByKind: summary.calls.failuresByKind },
          turns: summary.calls.byPurpose.agent_turn?.count ?? summary.calls.byPurpose.agent_prompt?.count ?? 0,
          toolCalls: summary.tools.calls,
          toolFailures: summary.tools.failed,
          retries: { transport: summary.calls.retries, taskAttempts: Math.max(0, attempts - summary.outcome.tasks.total) },
          tokens: { ...summary.calls.tokens, basis: mode === 'mock' ? 'synthetic (characters / 4), not a model count' : 'provider-reported' },
          verification: { checklistPassed: summary.outcome.verification.checklistPassed, checklistTotal: summary.outcome.verification.checklistTotal, finalChecks: summary.outcome.verification.finalChecks, tasks: summary.outcome.tasks },
          acceptance,
          delivery: summary.outcome.delivery,
          changedFiles: changed,
          expectedFilesChanged: (task.expectChanged || []).every((f) => (changed || []).includes(f)),
          repeatedToolFailures: summary.repeatedToolFailures.length,
          // The factory said "completed" but the independent acceptance check disagrees: the failure this harness exists to catch.
          falseSuccess: first !== 'timeout' && run.status === 'completed' && !acceptance.ok,
          // The factory's verdict and the independent check agree (both pass, or the run did not claim success and acceptance fails).
          verdictMatchesAcceptance: first !== 'timeout' ? (run.status === 'completed') === acceptance.ok : null,
          ...(run.metrics ? { metrics: { planningMs: run.metrics.planningMs, tasks: run.metrics.tasks, artifacts: run.metrics.artifacts, tools: run.metrics.tools, inference: run.metrics.inference } } : {}),
        });
      } catch (e) {
        result.status = 'error';
        result.error = redact(String(e?.message || e)).slice(0, 300);
      } finally {
        result.wallMs = Math.round(performance.now() - t0);
        results.push(result);
        log(`${task.id} #${rep}: ${result.status}${result.error ? ` — ${result.error}` : ''}`);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  }

  const config = {
    mode,
    provider: effective?.provider ?? (mode === 'mock' ? 'mock' : o.provider),
    model: effective?.model ?? (mode === 'mock' ? 'reference-solution' : o.model),
    engine: effective?.engine ?? engine,
    maxOutputTokens: effective?.maxOutputTokens ?? null,
    settings: effective?.settings
      ? { maxParallel: effective.settings.maxParallel, maxAttempts: effective.settings.maxAttempts, maxAgentTurns: effective.settings.maxAgentTurns, tokenBudget: effective.settings.tokenBudget, timeoutMinutes: effective.settings.timeoutMinutes, commandTimeoutMs: effective.settings.commandTimeoutMs }
      : settings,
    providerOptions: effective?.providerOptions ?? providerOptions ?? {},
  };
  return buildReport({ results, config, startedAt: started, repeat, tasks });
}

/** Assemble the report from attempt results. Pure, so it can be tested without running anything. */
export function buildReport({ results, config, startedAt = new Date(), repeat = 1, tasks = [] }) {
  const count = (pred) => results.filter(pred).length;
  const attempted = results.length;
  const byTask = {};
  for (const r of results) {
    const t = (byTask[r.taskId] ||= { attempted: 0, passed: 0, failed: 0, incomplete: 0, error: 0, wallMs: [] });
    t.attempted += 1;
    t[r.status] += 1;
    t.wallMs.push(r.wallMs);
  }
  for (const t of Object.values(byTask)) {
    t.passRate = t.attempted ? t.passed / t.attempted : null;
    t.medianWallMs = median(t.wallMs);
    delete t.wallMs;
  }
  const sum = (f) => results.reduce((a, r) => a + (Number(f(r)) || 0), 0);
  return {
    schema: BENCH_SCHEMA,
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    mode: config.mode,
    notice: config.mode === 'mock'
      ? 'MOCK RUN: a scripted reference solution stood in for a model. Timings and token counts do not describe any model, provider or machine and must not be compared with live results.'
      : 'LIVE RUN: a real provider was called. Results describe this provider, model, hardware and configuration on this date only.',
    repository: repoInfo(),
    node: process.version,
    config,
    configId: configId(config),
    tasks: (tasks.length ? tasks.map((t) => t.id) : [...new Set(results.map((r) => r.taskId))]),
    repeat,
    results,
    summary: {
      attempted,
      passed: count((r) => r.status === 'passed'),
      failed: count((r) => r.status === 'failed'),
      incomplete: count((r) => r.status === 'incomplete'),
      error: count((r) => r.status === 'error'),
      // Over everything attempted: failed, incomplete and errored attempts stay in the denominator.
      passRate: attempted ? count((r) => r.status === 'passed') / attempted : null,
      byTask,
      totals: { wallMs: sum((r) => r.wallMs), modelCalls: sum((r) => r.calls?.count), toolCalls: sum((r) => r.toolCalls), transportRetries: sum((r) => r.retries?.transport), taskRetries: sum((r) => r.retries?.taskAttempts), inputTokens: sum((r) => r.tokens?.input), outputTokens: sum((r) => r.tokens?.output), callsWithoutUsage: sum((r) => r.tokens?.callsUnavailable) },
      medianWallMs: median(results.map((r) => r.wallMs)),
      // Recomputed from the stored results so a report from an older revision (without these fields) still compares.
      falseSuccesses: count((r) => r.falseSuccess === true || (r.runStatus === 'completed' && r.acceptance && r.acceptance.ok === false)),
      verificationAccuracy: (() => {
        const judged = results.filter((r) => r.acceptance && (r.status === 'passed' || r.status === 'failed'));
        return judged.length ? judged.filter((r) => (r.runStatus === 'completed') === (r.acceptance.ok === true)).length / judged.length : null;
      })(),
    },
  };
}

/**
 * Side-by-side comparison of two reports. It states differences in configuration and in recorded results; it does not decide
 * which is "better", and it refuses to treat mock and live results as comparable.
 */
export function compareReports(a, b) {
  const notes = [];
  if (a.schema !== BENCH_SCHEMA || b.schema !== BENCH_SCHEMA) notes.push('At least one file is not a da-prompt benchmark report.');
  if (a.mode !== b.mode) notes.push(`Modes differ (${a.mode} vs ${b.mode}): the numbers are not comparable.`);
  if (a.mode === 'mock' || b.mode === 'mock') notes.push('A mock report contains no model measurements.');
  if (a.repository?.revision !== b.repository?.revision) notes.push('The repository revisions differ.');
  if (a.repository?.dirty || b.repository?.dirty) notes.push('At least one report was produced from a working tree with uncommitted changes.');
  const flat = (o, prefix = '', out = {}) => {
    for (const [k, v] of Object.entries(o || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, `${prefix}${k}.`, out);
      else out[`${prefix}${k}`] = v;
    }
    return out;
  };
  const fa = flat(a.config);
  const fb = flat(b.config);
  const configDiff = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort().filter((k) => stable(fa[k]) !== stable(fb[k])).map((key) => ({ key, a: fa[key] ?? null, b: fb[key] ?? null }));
  const ids = [...new Set([...Object.keys(a.summary?.byTask || {}), ...Object.keys(b.summary?.byTask || {})])].sort();
  const side = (r, id) => {
    const t = r.summary?.byTask?.[id];
    if (!t) return null;
    const rs = (r.results || []).filter((x) => x.taskId === id);
    return { attempted: t.attempted, passed: t.passed, failed: t.failed, incomplete: t.incomplete, error: t.error, passRate: t.passRate, medianWallMs: t.medianWallMs, modelCalls: rs.reduce((x, y) => x + (y.calls?.count || 0), 0), toolCalls: rs.reduce((x, y) => x + (y.toolCalls || 0), 0), transportRetries: rs.reduce((x, y) => x + (y.retries?.transport || 0), 0) };
  };
  return {
    schema: 'da-prompt.bench-comparison/1',
    a: { configId: a.configId, mode: a.mode, generatedAt: a.generatedAt, passRate: a.summary?.passRate ?? null, attempted: a.summary?.attempted ?? 0 },
    b: { configId: b.configId, mode: b.mode, generatedAt: b.generatedAt, passRate: b.summary?.passRate ?? null, attempted: b.summary?.attempted ?? 0 },
    sameConfig: a.configId === b.configId,
    configDiff,
    tasks: ids.map((id) => ({ id, a: side(a, id), b: side(b, id) })),
    notes,
  };
}
