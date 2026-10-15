// Test-first QA: define correctness first, implement against it, verify independently.
//
//   Plan → QA test definition → baseline → implementation → independent QA → final verification
//
// This module holds the pure parts: how a plan is reshaped so the order is carried by real task dependencies, how a baseline
// result is classified, how QA-owned test files are sealed and checked, and which earlier results may be reused. It adds no
// task graph, evidence store or test runner of its own: it works on the plan's tasks (graph.js), the run's checks
// (project.js) and the factory's workspace. The factory (factory.js) calls it at the points named in each function.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const KIND_TEST_DEFINITION = 'test-definition';
export const KIND_INDEPENDENT_QA = 'independent-qa';
/** How many times independent QA may send the implementation back before the QA task is escalated. */
export const MAX_QA_REPAIR_ROUNDS = 2;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isImplementation = (t) => t.role === 'engineer';

/** Every task id `id` depends on, directly or not. */
function ancestors(byId, id) {
  const seen = new Set();
  const walk = (x) => {
    for (const d of byId.get(x)?.dependsOn || []) if (!seen.has(d)) { seen.add(d); walk(d); }
  };
  walk(id);
  return seen;
}

/**
 * Reshape a (valid) plan so that, for every implementation task, a QA test-definition task comes first and an independent QA
 * task comes after. Planner-made QA tasks are reused where they already fit; a task is only added when nothing fits.
 * Returns { plan, repairs } like repairPlan(): `repairs` says what was changed, in words. A plan with no implementation task
 * (nothing to implement) is left alone.
 *
 *  - A QA task that does not depend on any implementation task is the test definition for the implementation tasks.
 *  - A QA task that depends on every implementation task is the independent QA.
 *  - Test definitions get `baseline`: the commands that run the acceptance tests (default: the plan's final checks).
 */
export function enforceTestFirst(plan, { existing = false } = {}) {
  const repairs = [];
  const tasks = plan.tasks.map((t) => ({ ...t, dependsOn: [...(t.dependsOn || [])] }));
  const impl = tasks.filter(isImplementation);
  if (!impl.length) return { plan: { ...plan, tasks }, repairs };
  const byId = () => new Map(tasks.map((t) => [t.id, t]));
  const implIds = new Set(impl.map((t) => t.id));
  const dependsOnImpl = (t) => [...ancestors(byId(), t.id)].some((d) => implIds.has(d));
  const baselineDefault = [...new Set((plan.finalVerify || []).filter(Boolean))];

  // 1. Test definition: a QA task that stands before the implementation.
  let defs = tasks.filter((t) => t.role === 'qa' && !dependsOnImpl(t) && (t.kind === KIND_TEST_DEFINITION || !t.kind));
  const unfinished = defs.filter((t) => t.kind !== KIND_TEST_DEFINITION);
  for (const t of unfinished) {
    t.kind = KIND_TEST_DEFINITION;
    repairs.push(`task "${t.id}" is QA work that does not depend on the implementation: it is the test definition`);
  }
  if (!defs.length) {
    const upstream = [...new Set(impl.flatMap((t) => t.dependsOn).filter((d) => ['product', 'research'].includes(byId().get(d)?.role)))];
    let id = 'qa-define';
    while (byId().has(id)) id = `${id}-x`;
    tasks.push({
      id,
      role: 'qa',
      kind: KIND_TEST_DEFINITION,
      title: 'Define the acceptance tests before implementation',
      description: existing
        ? 'Read the acceptance criteria and the existing tests. Decide whether the existing tests already cover the criteria; add only the missing tests (positive, negative, boundary, regression) next to the existing ones. Do not implement the feature.'
        : 'Read the acceptance criteria and write the automated tests that prove them (positive, negative and boundary cases) before any implementation exists. Do not implement the feature.',
      dependsOn: upstream,
      acceptance: ['Every acceptance criterion is covered by an executable test, new or existing', 'The tests have been run against the project as it is, and the result recorded'],
      outputs: [],
      files: [],
      verify: [],
      baseline: baselineDefault,
    });
    defs = [tasks.at(-1)];
    repairs.push(`no QA task came before the implementation: added "${id}" to define the acceptance tests first`);
  }
  for (const d of defs) {
    if (!Array.isArray(d.baseline) || !d.baseline.length) d.baseline = baselineDefault.length ? baselineDefault : (d.verify || []);
    // The baseline is a record of what the tests do before the implementation; they are expected to fail, so the plan's own
    // "must exit 0" checks are not applied to this task.
    d.verify = [];
  }
  for (const t of impl) {
    const have = ancestors(byId(), t.id);
    for (const d of defs) {
      if (!have.has(d.id)) {
        t.dependsOn.push(d.id);
        repairs.push(`task "${t.id}" now depends on "${d.id}" (acceptance tests are defined before it starts)`);
      }
    }
  }

  // 2. Independent QA: a QA task that comes after all the implementation.
  let indep = tasks.filter((t) => t.role === 'qa' && t.kind !== KIND_TEST_DEFINITION && impl.every((i) => ancestors(byId(), t.id).has(i.id)));
  if (!indep.length) {
    const partial = tasks.filter((t) => t.role === 'qa' && t.kind !== KIND_TEST_DEFINITION && dependsOnImpl(t));
    for (const t of partial) {
      for (const i of impl) if (!ancestors(byId(), t.id).has(i.id)) { t.dependsOn.push(i.id); repairs.push(`task "${t.id}" now waits for "${i.id}" so QA sees all the implementation`); }
    }
    indep = partial;
  }
  if (!indep.length) {
    let id = 'qa-verify';
    while (byId().has(id)) id = `${id}-x`;
    tasks.push({
      id,
      role: 'qa',
      kind: KIND_INDEPENDENT_QA,
      title: 'Independently verify the implementation',
      description: 'Verify the finished implementation against the acceptance criteria and the pre-existing acceptance tests. Do not trust the engineer\'s summary: run the tests and probe negative cases and boundaries yourself. Report defects; do not fix the implementation.',
      dependsOn: impl.map((t) => t.id),
      acceptance: ['The acceptance tests defined before implementation pass', 'Negative cases and boundaries behave as the criteria require'],
      outputs: [],
      files: [],
      verify: baselineDefault,
    });
    repairs.push(`no QA task came after the implementation: added "${id}" for independent verification`);
  } else {
    for (const t of indep) {
      if (t.kind !== KIND_INDEPENDENT_QA) { t.kind = KIND_INDEPENDENT_QA; repairs.push(`task "${t.id}" is the independent QA`); }
      if (!t.verify?.length && baselineDefault.length) t.verify = baselineDefault;
    }
  }
  return { plan: { ...plan, tasks }, repairs };
}

/** The implementation tasks that `task` (transitively) waits for: where its findings go back to. */
export function upstreamImplementation(tasks, task) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return [...ancestors(byId, task.id)].map((id) => byId.get(id)).filter((t) => t && isImplementation(t));
}

/** Problems with how a plan orders QA and implementation (empty when it follows the contract). */
export function checkTestFirst(plan) {
  const problems = [];
  const tasks = plan.tasks || [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const impl = tasks.filter(isImplementation);
  if (!impl.length) return problems;
  const defs = tasks.filter((t) => t.kind === KIND_TEST_DEFINITION);
  const indep = tasks.filter((t) => t.kind === KIND_INDEPENDENT_QA);
  if (!(plan.product?.successCriteria || []).length) problems.push('acceptance criteria are missing');
  if (!defs.length) problems.push('no QA test-definition task');
  if (!indep.length) problems.push('no independent QA task');
  for (const d of defs) {
    if (d.role !== 'qa') problems.push(`test definition "${d.id}" is not owned by QA`);
    if ([...ancestors(byId, d.id)].some((a) => isImplementation(byId.get(a) || {}))) problems.push(`test definition "${d.id}" depends on implementation`);
    if (!d.baseline?.length) problems.push(`test definition "${d.id}" has no baseline command`);
  }
  for (const t of impl) {
    const have = ancestors(byId, t.id);
    if (!defs.some((d) => have.has(d.id))) problems.push(`implementation "${t.id}" does not wait for a test definition`);
  }
  for (const q of indep) {
    const have = ancestors(byId, q.id);
    for (const t of impl) if (!have.has(t.id)) problems.push(`independent QA "${q.id}" does not wait for implementation "${t.id}"`);
  }
  return problems;
}

// ── Baseline: what the acceptance tests do before the implementation ───────────────────────────────────────────────

/** A bare package or tool that is not installed, as opposed to a project file that does not exist yet. */
const MISSING_PACKAGE = /(?:Cannot find (?:module|package) ['\x22](?![./]|[A-Za-z]:|node:)[^'\x22]+['\x22])|ModuleNotFoundError|No module named|ImportError|command not found|not found in PATH|could not find or load main class|sh: \d*:? ?\S+: not found/i;
// The project has no command that runs tests at all (npm without a test script): nothing was executed.
const NO_RUNNER = /Missing script|no test specified|npm (?:ERR!|error) (?:code )?ENOENT/i;
/** True when `text` says a package or tool is not installed (not that a file of the project itself is missing). */
export const isMissingDependency = (text) => MISSING_PACKAGE.test(String(text));
const BROKEN_TEST = /SyntaxError|Unexpected token|Unexpected identifier|ParseError|IndentationError|invalid syntax/i;

/**
 * Classify one baseline run of the acceptance tests.
 *  already-passing    exit 0: the behaviour exists already
 *  expected-failure   the tests ran (or tried to load the not-yet-written project code) and failed: the behaviour is missing
 *  preexisting-failure  fails exactly as the project's own baseline did before this run
 *  cannot-execute     could not run: tool or dependency missing, blocked, timed out. This says nothing about the behaviour
 *  unexpected-failure the test file itself is broken (it does not parse)
 * `r` = { exitCode, timedOut }, `text` its output. `projectBaseline` is the project's baseline entry for the same command.
 */
export function classifyBaseline(r, text = '', { projectBaseline = null } = {}) {
  if (r.exitCode === 0) return { classification: 'already-passing', reason: 'the command exits 0 before any implementation: the behaviour already exists' };
  if (r.timedOut) return { classification: 'cannot-execute', reason: 'the command timed out' };
  if (r.exitCode === 127) return { classification: 'cannot-execute', reason: 'the command or tool is not available' };
  if (r.exitCode === 126 && /^blocked:/m.test(text)) return { classification: 'cannot-execute', reason: 'the command is blocked by this run\'s policy' };
  if (NO_RUNNER.test(text)) return { classification: 'cannot-execute', reason: 'the project has no command that runs tests (no test script), so nothing was executed' };
  const m = text.match(MISSING_PACKAGE);
  if (m) return { classification: 'cannot-execute', reason: `a dependency or tool is missing (${m[0].slice(0, 80)}); this is not evidence that the behaviour is missing` };
  if (BROKEN_TEST.test(text)) return { classification: 'unexpected-failure', reason: 'the tests do not parse or load: they are broken, not failing on missing behaviour' };
  if (projectBaseline && projectBaseline.status === 'failed' && projectBaseline.exitCode === r.exitCode && (projectBaseline.signature || []).length && sameFailures(projectBaseline.signature, text)) {
    return { classification: 'preexisting-failure', reason: 'fails exactly as it did before this run' };
  }
  return { classification: 'expected-failure', reason: 'the tests ran and fail: the required behaviour is missing' };
}

const sameFailures = (signature, text) => {
  const now = new Set(String(text).toLowerCase().split('\n').map((l) => l.trim()));
  return signature.every((s) => [...now].some((l) => l.includes(String(s).slice(0, 40))));
};

/** The classifications the baseline gate accepts: the implementation may start. */
export const BASELINE_OK = new Set(['expected-failure', 'already-passing', 'preexisting-failure']);

// ── Workspace state: which code a result applies to ───────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['.git', 'node_modules', '.home', '.cache', '.npm', 'dist', 'build', 'coverage', '__pycache__', '.next', '.venv', 'target']);
// Files the factory itself keeps up to date while it runs; they are not code under test.
const MAX_STATE_FILES = 20_000;
const FACTORY_FILES = new Set(['CLAUDE.md', 'PLAN.md', 'FACTORY_REPORT.md']);

/** A hash of the workspace's files (not dependencies, caches or the factory's own notes). Same files → same state. */
export function workspaceState(root) {
  const h = crypto.createHash('sha256');
  let files = 0;
  let tooBig = false;
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r); continue; }
      if (!e.isFile() || (!rel && FACTORY_FILES.has(e.name))) continue;
      if (files >= MAX_STATE_FILES) { tooBig = true; return; }
      let buf;
      try { buf = fs.readFileSync(path.join(dir, e.name)); } catch { continue; }
      h.update(`${r}\0${sha(buf)}\0`);
      files++;
    }
  };
  walk(root, '');
  // A workspace too large to hash cheaply has no state hash, so nothing is ever reused for it.
  return { hash: tooBig ? null : h.digest('hex').slice(0, 16), files };
}

// ── Sealed tests: QA owns them ────────────────────────────────────────────────────────────────────────────────────

/**
 * Seal the tests a test-definition task defines or relies on: record a hash of each file and keep a copy outside the
 * workspace (`dir`) so a changed file can be put back. Returns the entries that were sealed. Files that do not exist are
 * reported in `missing` (a test the QA agent named but did not write is not a test).
 */
export function sealTests(run, task, ws, files, dir) {
  const contract = (run.testContract ||= { sealed: {}, baseline: [], qaRounds: {} });
  const sealed = [];
  const missing = [];
  for (const f of [...new Set(files)]) {
    let abs;
    try { abs = ws.resolve(f); } catch { missing.push(f); continue; }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { missing.push(f); continue; }
    const rel = ws.rel(abs);
    const buf = fs.readFileSync(abs);
    const copy = path.join(dir, rel);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, buf);
    contract.sealed[rel] = { owner: task.id, sha256: sha(buf), sealedAt: new Date().toISOString() };
    sealed.push(rel);
  }
  return { sealed, missing };
}

/** Why `task` may not write `rel`, or null. Only the task that sealed a file may change it. */
export function sealedWriteGuard(run, task) {
  return (rel) => {
    const s = run.testContract?.sealed?.[String(rel).replace(/\\/g, '/').replace(/^\.\/+/, '')];
    return s && s.owner !== task.id ? `${rel} is a QA-owned test (sealed by "${s.owner}"): do not edit it. If it is wrong, say so in complete_task disputedTests and leave it as it is.` : null;
  };
}

/**
 * Check every sealed file that `task` does not own. Anything changed or deleted is put back from the sealed copy.
 * Returns the paths that had been altered (empty when the tests are untouched).
 */
export function enforceSeals(run, task, ws, dir) {
  const altered = [];
  for (const [rel, s] of Object.entries(run.testContract?.sealed || {})) {
    if (s.owner === task.id) continue;
    const abs = path.join(ws.root, rel);
    let now = null;
    try { now = sha(fs.readFileSync(abs)); } catch { /* deleted */ }
    if (now === s.sha256) continue;
    altered.push(rel);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, fs.readFileSync(path.join(dir, rel)));
    } catch { /* the record of the alteration is what matters */ }
  }
  return altered;
}

/** Are all sealed tests exactly as sealed right now? (read-only; used by the final gate) */
export function sealsIntact(run, ws) {
  const bad = [];
  for (const [rel, s] of Object.entries(run.testContract?.sealed || {})) {
    let now = null;
    try { now = sha(fs.readFileSync(path.join(ws.root, rel))); } catch { /* deleted */ }
    if (now !== s.sha256) bad.push(rel);
  }
  return bad;
}

// ── Evidence reuse ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A recorded result of the same command on exactly the same workspace state, run by the factory, or null. A result from any
 * other state (the code changed since) never matches. Never used in place of an independent QA task: it only saves the
 * factory re-running a command whose answer is already known.
 */
export function reusableEvidence(run, command, stateHash, { taskKind = KIND_INDEPENDENT_QA } = {}) {
  if (!stateHash) return null;
  for (const e of [...(run.testContract?.evidence || [])].reverse()) {
    if (e.command === command && e.codeState === stateHash && typeof e.exitCode === 'number' && e.source === 'factory' && e.taskKind === taskKind) return e;
  }
  return null;
}

/** Remember a command result the factory produced, with the workspace state it applies to. */
export function recordEvidence(run, entry) {
  const c = (run.testContract ||= { sealed: {}, baseline: [], qaRounds: {} });
  c.evidence ||= [];
  c.evidence.push({ source: 'factory', at: new Date().toISOString(), ...entry });
  if (c.evidence.length > 200) c.evidence.splice(0, c.evidence.length - 200);
}

/**
 * The checklist item for the test-first contract: the acceptance tests were defined and baselined before implementation,
 * independent QA completed (not skipped) on the code that was delivered, and the sealed tests are untouched.
 */
export function qaChecklistItem(run, ws) {
  const tasks = run.plan.tasks;
  const defs = tasks.filter((t) => t.kind === KIND_TEST_DEFINITION);
  const indep = tasks.filter((t) => t.kind === KIND_INDEPENDENT_QA);
  const problems = [];
  for (const d of defs) {
    if (d.status !== 'completed') problems.push(`test definition "${d.id}" is ${d.status}`);
    else if (!(run.testContract?.baseline || []).some((b) => b.taskId === d.id)) problems.push(`no baseline was recorded for "${d.id}"`);
  }
  for (const q of indep) if (q.status !== 'completed') problems.push(`independent QA "${q.id}" is ${q.status}`);
  if (!defs.length || !indep.length) problems.push('the plan has no test definition or independent QA task');
  const altered = ws ? sealsIntact(run, ws) : [];
  if (altered.length) problems.push(`QA-owned tests changed: ${altered.join(', ')}`);
  const ok = problems.length === 0;
  return {
    id: 'qa',
    label: 'Acceptance tests were defined before implementation and independently verified',
    ok,
    state: ok ? 'pass' : 'fail',
    detail: ok
      ? `${defs.length} test definition(s) baselined (${(run.testContract.baseline || []).map((b) => `${b.command} → ${b.classification}`).join(', ')}), ${indep.length} independent QA task(s) verified by the factory's own runs (code state ${indep.map((q) => q.qaState || 'unrecorded').join(', ')})`
      : problems.join('; '),
  };
}
