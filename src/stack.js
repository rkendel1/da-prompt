// Selectable product stacks for NEW generated applications.
//
// templates/stack.json is the single source: which components exist (AppPort, FeltDB, Distribution Protocol, and the
// known-but-unsupported AuthBoundry, AppPort Services and AppBoundry), their exact published package versions, what each
// requires, whether it is supported, and the rules agents are given. A run's selection (settings.stack) is validated here,
// resolved into the generated app's dependencies, passed to planning/implementation/QA, and checked by the stack gate:
// selected integrations are present and working, unselected packages are absent. Unsupported components fail early with
// their verified blocker and the next step; nothing is silently downgraded or replaced.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const STACK = JSON.parse(fs.readFileSync(new URL('../templates/stack.json', import.meta.url), 'utf8'));
export const STACK_COMPONENTS = STACK.components;
export const STACK_IDS = Object.keys(STACK.components);
export const DEFAULT_STACK = [...STACK.default];
export const INSTALL_COMMAND = STACK.install;

export class StackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StackError';
  }
}

const unsupportedMessage = (id) => {
  const c = STACK.components[id];
  return `${c.label} (${id}) is not supported yet. Blocker: ${c.blocker} Next step: ${c.next}`;
};

/**
 * Validate and normalize a requested stack for a new app. `selection` is an array of component ids (or a comma-separated
 * string); omitted means the default. AppPort is required and implied (selecting "feltdb" means AppPort + FeltDB) unless the
 * run has an explicit AppPort exception, in which case it is left out. Returns the ids in stack.json order. Throws StackError with an actionable message.
 */
export function resolveStack(selection, { exception = '' } = {}) {
  let ids = selection == null || selection === '' ? [...DEFAULT_STACK] : typeof selection === 'string' ? selection.split(',') : selection;
  if (!Array.isArray(ids)) throw new StackError('stack must be a list of component ids, e.g. ["appport", "feltdb"]');
  ids = [...new Set(ids.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  const unknown = ids.filter((id) => !STACK.components[id]);
  if (unknown.length) throw new StackError(`Unknown stack component${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Known: ${STACK_IDS.join(', ')}.`);
  const unsupported = ids.filter((id) => STACK.components[id].status !== 'supported');
  if (unsupported.length) throw new StackError(unsupported.map(unsupportedMessage).join(' '));
  if (exception) {
    if (selection != null && ids.includes('appport')) throw new StackError('This run has an AppPort exception, so the stack cannot include appport. Remove one of the two.');
    ids = ids.filter((id) => id !== 'appport');
  } else if (!ids.includes('appport')) {
    ids.unshift('appport'); // required and implied: only an explicit appportException leaves it out
  }
  for (const id of ids) {
    const missing = (STACK.components[id].requires || []).filter((r) => !ids.includes(r));
    if (missing.length) throw new StackError(`${STACK.components[id].label} requires ${missing.map((r) => STACK.components[r].label).join(' and ')}; add ${missing.join(', ')} to the stack.`);
  }
  return STACK_IDS.filter((id) => ids.includes(id));
}

/** The dependencies a stack resolves to: exactly the selected components' packages, nothing else. */
export function stackDependencies(ids) {
  const dependencies = {};
  const devDependencies = {};
  for (const id of ids) {
    Object.assign(dependencies, STACK.components[id].dependencies || {});
    Object.assign(devDependencies, STACK.components[id].devDependencies || {});
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return { dependencies: sorted(dependencies), devDependencies: sorted(devDependencies) };
}

/** Every package a component can bring in (declared deps and the packages it is known by). */
const packagesOf = (id) => {
  const c = STACK.components[id];
  return [...new Set([...Object.keys(c.dependencies || {}), ...Object.keys(c.devDependencies || {}), ...(c.packages || []), ...Object.keys(c.verified || {})])];
};

/** The stack rules agents are given (src/agents.js), after the AppPort rules; empty for the default stack. */
export function stackRules(ids) {
  const optional = ids.filter((id) => id !== 'appport');
  const absent = STACK_IDS.filter((id) => !ids.includes(id));
  const lines = [
    `Selected stack: ${ids.map((id) => STACK.components[id].label).join(' + ') || 'none'}. Use exactly these packages: ${Object.entries({ ...stackDependencies(ids).dependencies, ...stackDependencies(ids).devDependencies }).map(([k, v]) => `${k}@${v}`).join(' ') || 'none'}.`,
    `Do not add packages of unselected components: ${absent.flatMap(packagesOf).join(', ')}. The factory checks that they are absent.`,
  ];
  for (const id of optional) lines.push(...(STACK.components[id].rules || []).map((r) => `- ${r}`));
  return lines.join('\n');
}

/** A label for logs and the report, e.g. "AppPort + FeltDB". */
export const stackLabel = (ids) => (ids || []).map((id) => STACK.components[id]?.label || id).join(' + ');

/** Public view for GET /api/stack and the New Run form. */
export function describeStack() {
  return {
    default: [...DEFAULT_STACK],
    components: STACK_IDS.map((id) => {
      const c = STACK.components[id];
      return {
        id,
        label: c.label,
        summary: c.summary,
        status: c.status,
        required: Boolean(c.required),
        requires: c.requires || [],
        packages: c.status === 'supported' ? { ...c.dependencies, ...c.devDependencies } : { ...c.verified },
        ...(c.status === 'supported' ? {} : { blocker: c.blocker, next: c.next }),
      };
    }),
  };
}

// ── stack gate ─────────────────────────────────────────────────────────────────────────────────

const semver = (v) => String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) || null;
/** Pre-1.0 packages break on minor versions, so 0.x must match major and minor exactly; 1.x+ the major. */
const compatible = (installed, pinned) => {
  const a = semver(installed);
  const b = semver(pinned);
  if (!a || !b || a[0] !== b[0] || (b[0] === 0 && a[1] !== b[1])) return false;
  return a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2]);
};
const LOCAL_SPEC = /^(file:|link:|workspace:|portal:|git(\+[a-z]+)?:|github:|https?:)/i;

async function readJson(ws, rel) {
  try {
    return JSON.parse(await ws.readFile(rel));
  } catch {
    return null;
  }
}

async function sourceUses(ws, dir, pkg) {
  try {
    for (const f of await ws.listFiles(dir)) if (/\.(m?js|ts)$/.test(f.path) && (await ws.readFile(f.path)).includes(pkg)) return true;
  } catch {
    /* no such folder */
  }
  return false;
}

/**
 * Check a generated app against its selected stack. `launch(env)` starts the app (see launchApp) and resolves
 * { ok, port, stop(), exited() , error? }. Resolves { ok, checks: [{ id, ok, detail }] }. Never throws, never mutates the
 * app's real data: behavioural checks run against a throwaway DATA_DIR.
 */
export async function checkStackConformance({ ws, stack, launch, tmpDir }) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
  const pkg = await readJson(ws, 'package.json');
  if (!pkg) {
    add('stack-packages', false, 'package.json is missing or not valid JSON');
    return { ok: false, checks };
  }
  const declared = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };

  // Selected components: declared, published, installed at compatible versions.
  const problems = [];
  for (const id of stack) {
    const c = STACK.components[id];
    for (const [name, pinned] of Object.entries({ ...c.dependencies, ...c.devDependencies })) {
      const spec = declared[name];
      if (!spec) {
        problems.push(`${name} (${c.label}) is not declared`);
        continue;
      }
      if (LOCAL_SPEC.test(String(spec))) problems.push(`${name} is "${spec}": only published versions are allowed`);
      const installed = (await readJson(ws, `node_modules/${name}/package.json`))?.version;
      if (!installed) problems.push(`${name} is not installed (run: ${INSTALL_COMMAND})`);
      else if (!compatible(installed, pinned)) problems.push(`${name}@${installed} is not compatible with ${pinned}`);
    }
  }
  add('stack-packages', problems.length === 0, problems.length ? problems.join('; ') : `${stackLabel(stack)}: every selected package is declared and installed at a compatible version`);

  // Unselected components: none of their packages may be declared or installed at the top level.
  const extra = [];
  for (const id of STACK_IDS.filter((x) => !stack.includes(x))) {
    for (const name of packagesOf(id)) {
      if (declared[name]) extra.push(`${name} is declared but ${STACK.components[id].label} is not selected`);
      else if (await readJson(ws, `node_modules/${name}/package.json`)) extra.push(`${name} is installed but ${STACK.components[id].label} is not selected`);
    }
  }
  add('stack-unselected-absent', extra.length === 0, extra.length ? extra.join('; ') : 'no package of an unselected component is declared or installed');

  // Required integrations: the selected packages are used by the app, and their behaviour holds.
  if (stack.includes('feltdb')) await checkFeltdb({ ws, launch, tmpDir, add });
  if (stack.includes('distribution')) {
    const used = await sourceUses(ws, 'src', '@distribution-protocol/protocol');
    const tested = await sourceUses(ws, 'test', '@distribution-protocol/protocol');
    add('distribution-used', used && tested, !used ? 'no file under src/ imports @distribution-protocol/protocol' : !tested ? 'no test under test/ exercises @distribution-protocol/protocol (signing, verification, tamper and wrong-artifact rejection)' : 'src/ signs and verifies with @distribution-protocol/protocol, and the app\'s tests exercise it');
  }
  return { ok: checks.every((c) => c.ok), checks };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a command in the app's folder (FeltDB telemetry off, HOME inside the workspace). Never rejects. */
function runIn(root, file, args, env = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: root, timeout: 30_000, maxBuffer: 1 << 20, env: { PATH: process.env.PATH, HOME: path.join(root, '.home'), FELTDB_TELEMETRY: '0', ...env } }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim(), error: err?.message }),
    );
  });
}

// Read with the app's own @feltdb/core, in a separate process after the app stopped: the flow's compiled contract hash and
// the store's active model. The namespace does not partition a local store, so any name reads the app's data.
const READ_ACTIVE_MODEL = `
import fs from 'node:fs';
import { createFeltDB, parseFlowSpec, validateFlowSpec, compileApplicationContract } from '@feltdb/core';
const spec = parseFlowSpec(fs.readFileSync('feltdb.flow', 'utf8'));
const errors = validateFlowSpec(spec).filter((d) => d.severity === 'error').map((d) => d.message);
const expected = (await compileApplicationContract(spec, 'local', spec.app)).hashes.application;
const db = createFeltDB({ namespace: 'da-prompt-stack-gate', mode: 'local', path: process.env.DATA_DIR });
let active = {};
try { active = await db.application.get(); } catch (e) { active = { error: e.message }; }
await db.close();
console.log(JSON.stringify({ app: spec.app, collections: spec.collections.map((c) => c.name), errors, expected, active: active.contract_hash || null, version: active.version ?? null, error: active.error || null }));
`;

/** The flow is the authority: present, valid by FeltDB's own CLI, and exactly the model the running app deployed. */
async function checkFlow({ ws, dataDir, add, ran = true }) {
  let source = null;
  try {
    source = await ws.readFile('feltdb.flow');
  } catch {
    /* missing */
  }
  if (source === null) {
    add('feltdb-flow', false, 'feltdb.flow is missing at the project root: the data model must be declared there and deployed by the app');
    return;
  }
  const bin = path.join(ws.root, 'node_modules', '.bin', 'feltdb');
  const valid = await runIn(ws.root, bin, ['validate', 'feltdb.flow']);
  add('feltdb-flow', valid.ok, valid.ok ? `feltdb validate: ${valid.out.split('\n').pop()}` : `feltdb validate feltdb.flow failed: ${(valid.out || valid.error || '').slice(0, 300)}`);
  if (!valid.ok || !ran) return;
  const read = await runIn(ws.root, process.execPath, ['--input-type=module', '-e', READ_ACTIVE_MODEL], { DATA_DIR: dataDir });
  let r = null;
  try {
    r = JSON.parse(read.out.split('\n').pop());
  } catch {
    /* reported below */
  }
  if (!r) return add('feltdb-flow-deployed', false, `could not read the store's active model: ${(read.out || read.error || '').slice(0, 300)}`);
  const ok = r.active && r.active === r.expected;
  add(
    'feltdb-flow-deployed',
    ok,
    ok
      ? `the app deployed feltdb.flow (${r.app}: ${r.collections.join(', ')}) as its store's active model, version ${r.version}, contract ${r.expected.slice(0, 19)}…`
      : r.active
        ? `the store's active model (${r.active}) is not feltdb.flow (${r.expected}): the app must deploy the flow it ships`
        : `the app ran but deployed no data model (${r.error || 'none'}): it must deploy feltdb.flow with db.deployFlowSpec at startup`,
  );
}

async function checkFeltdb({ ws, launch, tmpDir, add }) {
  const used = await sourceUses(ws, 'src', '@feltdb/core');
  const tested = await sourceUses(ws, 'test', '@feltdb/core');
  add('feltdb-used', used && tested, !used ? 'no file under src/ imports @feltdb/core' : !tested ? 'no test under test/ reads the app\'s state back through @feltdb/core' : 'src/ stores state in @feltdb/core, and the app\'s tests read it back');
  if (!used) return;
  const dataDir = path.join(tmpDir, `stack-gate-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const first = await launch({ DATA_DIR: dataDir });
  if (!first.ok) {
    add('feltdb-durable-store', false, `the app did not start with DATA_DIR set: ${first.error || 'unknown error'}`);
    await checkFlow({ ws, dataDir, add, ran: false });
    return;
  }
  try {
    const files = fs.readdirSync(dataDir);
    const feltFiles = files.filter((f) => /^state\.|\.journal$/.test(f));
    add('feltdb-durable-store', feltFiles.length > 0, feltFiles.length ? `the app opened its FeltDB store in DATA_DIR (${feltFiles.join(', ')})` : `the app started but created no FeltDB state in DATA_DIR (found: ${files.join(', ') || 'nothing'}); it must open createFeltDB({ mode: 'local', path: process.env.DATA_DIR }) and deploy feltdb.flow at startup`);
    // The app is the sole writer: a second instance on the same DATA_DIR must refuse to start.
    const second = await launch({ DATA_DIR: dataDir }, { timeoutMs: 8000 });
    if (second.ok) second.stop();
    add('feltdb-sole-writer', !second.ok, second.ok ? 'a second instance started on the same DATA_DIR; the app must refuse (FeltDB does not enforce its single-writer lock)' : 'a second instance on the same DATA_DIR is refused');
  } finally {
    first.stop();
  }
  // A stopped app closes FeltDB and releases its writer lock; then its active model is read from a separate process.
  const lock = path.join(dataDir, '.writer.lock');
  for (let i = 0; i < 50 && fs.existsSync(lock); i++) await sleep(100);
  add('feltdb-clean-shutdown', !fs.existsSync(lock), fs.existsSync(lock) ? 'after SIGTERM the app did not release DATA_DIR/.writer.lock within 5 s: it must close FeltDB and remove its lock on shutdown' : 'after SIGTERM the app closed its store and released DATA_DIR/.writer.lock');
  await checkFlow({ ws, dataDir, add });
}
