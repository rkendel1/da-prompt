// PAX adapter: discover the `pax` executable in the backend process's environment, verify what the
// installed version actually supports, and run a fixed catalog of documented PAX commands against a
// run's workspace, keeping the output as evidence.
//
// PAX (https://github.com/rkendel1/pax) inspects project artifacts and reports structured observations.
// Its own boundary document says an observation is not a verified outcome, and that "declared", "present"
// and "ran successfully" are different facts. This module keeps that line:
//   - PAX results are stored as `run.pax`, separate from the factory's verification (`run.finalVerification`,
//     the checklist and the verdict). Nothing here ever changes a run's verdict.
//   - A process exiting 0 is recorded as that, not as "the requested outcome was achieved".
//   - Only commands/flags documented in PAX's README and `--help` are used (see STEPS). Capability checks
//     read the installed binary's own `--version` / `--help`, never a guess.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { safeEnv } from './sandbox.js';
import { redact } from './security.js';

export const SEMANTICS = 'PAX observations describe what PAX read or what a native tool reported. They are not the factory\'s verification and do not change a run\'s verdict; whether the requested change works is decided by the project\'s own checks and your review.';

// The only PAX invocations the factory makes. `class`: observation = read-only (PAX boundary rule 1);
// plan = shows what a delegated command would run, without running it; execution = runs the project's native
// test command through PAX and may change files exactly as that command does (boundary rule 2).
export const STEPS = {
  info: { title: 'Project info', class: 'observation', args: ['info'], command: 'info', minVersion: '0.1.0', about: 'Detected ecosystems, package manager and why it was selected, lockfiles and workspaces.' },
  doctor: { title: 'Project diagnostics', class: 'observation', args: ['doctor'], command: 'doctor', minVersion: '0.1.0', about: 'The same detection plus consistency diagnostics (manifest, lockfile, workspace).' },
  reality: { title: 'Declared vs installed (presence)', class: 'observation', args: ['reality'], command: 'reality', minVersion: '0.1.0', about: 'Layered presence observations: manifests, lockfiles, install directories. Not a check that anything works.' },
  drift: { title: 'Drift between layers', class: 'observation', args: ['drift'], command: 'drift', minVersion: '0.1.0', about: 'Contradictions between declared, resolved and installed state. Exit code 1 means drift was found; it is a result, not a failure.' },
  graph: { title: 'Dependency graph', class: 'observation', args: ['graph'], command: 'graph', minVersion: '0.1.0', about: 'Declared dependency and workspace relationships.' },
  'test-plan': { title: 'Test plan (dry run)', class: 'plan', args: ['--dry-run', 'test'], command: 'test', flags: ['--dry-run'], minVersion: '0.1.0', about: 'The native test command PAX would run, without running it.' },
  test: { title: 'Test execution result', class: 'execution', args: ['test'], command: 'test', minVersion: '0.3.0', contract: 'pax.execution-result.v1', about: 'Runs the project\'s native tests through PAX and reports what PAX could establish (pax.execution-result.v1). May change files like the native command does.' },
};
const KNOWN_COMMANDS = ['info', 'doctor', 'deps', 'scripts', 'workspaces', 'lock', 'graph', 'reality', 'drift', 'observe', 'build', 'test', 'lint', 'typecheck', 'run', 'x', 'install', 'add', 'remove', 'exec', 'deploy'];
const MAX_CAPTURE = 2 * 1024 * 1024;

const semver = (s) => (String(s).match(/^(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
export const versionAtLeast = (v, min) => {
  const a = semver(v);
  const b = semver(min);
  if (a.length < 3) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

const isExec = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Where is `pax`? Looks in the backend process's own environment (its PATH), or at the configured path. */
export function resolvePax(cfg, { candidate, env = process.env } = {}) {
  const configured = (candidate ?? cfg.paxPath ?? '').trim();
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const name = configured && !configured.includes('/') ? configured : 'pax';
  if (configured.includes('/')) {
    if (!fs.existsSync(configured)) return { source: 'configured', configured, path: null, problem: 'not-found', message: `${configured} does not exist on the machine the da-prompt server runs on.` };
    if (!isExec(configured)) return { source: 'configured', configured, path: configured, problem: 'permission', message: `${configured} exists but is not an executable file for the server's user.` };
    return { source: 'configured', configured, path: configured, problem: null };
  }
  for (const d of dirs) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) {
      if (isExec(p)) return { source: configured ? 'configured' : 'PATH', configured, path: p, problem: null, searched: dirs.length };
      return { source: configured ? 'configured' : 'PATH', configured, path: p, problem: 'permission', message: `${p} was found on the PATH but is not executable for the server's user.`, searched: dirs.length };
    }
  }
  return { source: configured ? 'configured' : 'PATH', configured, path: null, problem: 'not-found', message: `"${name}" was not found on the PATH of the da-prompt server process (${dirs.length} folder${dirs.length === 1 ? '' : 's'} searched).`, searched: dirs.length };
}

/** Run an argv (no shell) with a timeout, a process-group kill and bounded capture. */
export function execArgv(file, args, { cwd, env, timeoutMs = 30_000, signal } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ spawnError: e.code || 'EERR', message: e.message, exitCode: null, stdout: '', stderr: '', durationMs: 0 });
    }
    const out = [];
    const err = [];
    let nOut = 0;
    let nErr = 0;
    let truncated = false;
    child.stdout.on('data', (c) => (nOut < MAX_CAPTURE ? (out.push(c), (nOut += c.length)) : (truncated = true)));
    child.stderr.on('data', (c) => (nErr < MAX_CAPTURE ? (err.push(c), (nErr += c.length)) : (truncated = true)));
    let timedOut = false;
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    let spawnError = null;
    child.on('error', (e) => {
      spawnError = e;
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({
        exitCode: code,
        signal: sig,
        timedOut,
        truncated,
        cancelled: Boolean(signal?.aborted),
        spawnError: spawnError?.code || null,
        message: spawnError?.message,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

const observeEnv = () => ({ ...safeEnv(), NO_COLOR: '1' });

/**
 * Ask the installed binary what it is and what it supports. Never assumes: identity comes from
 * `--version`, command and flag support from `--help`, step availability from both.
 */
export async function probePax(cfg, { candidate, signal } = {}) {
  const found = resolvePax(cfg, { candidate });
  const base = { checkedAt: new Date().toISOString(), source: found.source, configured: found.configured || null, path: found.path, searched: found.searched };
  if (found.problem === 'not-found') return { ...base, state: 'unavailable', message: found.message };
  if (found.problem === 'permission') return { ...base, state: 'permission', message: found.message };
  const timeoutMs = Math.min(15_000, cfg.paxTimeoutMs || 15_000);
  const v = await execArgv(found.path, ['--version'], { env: observeEnv(), timeoutMs, signal });
  if (v.spawnError) return { ...base, state: v.spawnError === 'EACCES' ? 'permission' : 'error', message: `Could not start ${found.path}: ${redact(v.message || v.spawnError)}` };
  if (v.timedOut) return { ...base, state: 'timeout', message: `${found.path} --version did not finish within ${Math.round(timeoutMs / 1000)}s.` };
  const m = v.stdout.trim().match(/^pax (\d+\.\d+\.\d+\S*)$/);
  if (v.exitCode !== 0 || !m) {
    return { ...base, state: 'incompatible', identity: 'not-pax', message: `${found.path} does not identify itself as PAX (expected "pax <version>" from --version, got ${JSON.stringify(redact(v.stdout.trim().slice(0, 80) || v.stderr.trim().slice(0, 80)))}, exit ${v.exitCode}). It may be a different program named pax, such as the POSIX archive tool.` };
  }
  const version = m[1];
  const h = await execArgv(found.path, ['--help'], { env: observeEnv(), timeoutMs, signal });
  const help = `${h.stdout}\n${h.stderr}`;
  if (h.exitCode !== 0 || !/PAX is a/.test(help)) {
    return { ...base, state: 'incompatible', version, identity: 'unrecognized-help', message: `${found.path} reports version ${version} but its --help output is not recognisable as PAX, so its commands cannot be verified.` };
  }
  const region = help.split(/\nOptions:/)[0];
  const commands = KNOWN_COMMANDS.filter((c) => new RegExp(`(^|[\\s,])${c}([\\s,]|$)`, 'm').test(region));
  const flags = ['--json', '--dir', '--dry-run', '--live'].filter((f) => help.includes(f));
  const steps = {};
  for (const [id, s] of Object.entries(STEPS)) {
    const need = ['--json', '--dir', ...(s.flags || [])];
    let reason = null;
    if (!commands.includes(s.command)) reason = `this PAX does not list the "${s.command}" command`;
    else if (need.some((f) => !flags.includes(f))) reason = `this PAX does not list ${need.filter((f) => !flags.includes(f)).join(', ')}`;
    else if (!versionAtLeast(version, s.minVersion)) reason = `needs PAX ${s.minVersion} or newer (installed ${version})`;
    steps[id] = { available: !reason, reason };
  }
  return { ...base, state: 'ok', identity: 'pax', version, commands, flags, steps, helpBytes: help.length, message: `PAX ${version} at ${found.path}` };
}

// ── Summaries of documented output (only fields documented in the PAX README) ───────────────────

function summarize(id, j) {
  if (!j || typeof j !== 'object') return null;
  if (id === 'info' || id === 'doctor') {
    const levels = (j.diagnostics || []).reduce((a, d) => ((a[d.level] = (a[d.level] || 0) + 1), a), {});
    return { summary: j.result?.summary ?? null, manager: j.manager?.name ?? null, selectedBy: j.manager?.selectedBy ?? null, diagnostics: levels, components: Array.isArray(j.components) ? j.components.length : undefined };
  }
  if (id === 'reality') {
    return { layers: Object.fromEntries(Object.entries(j).filter(([, v]) => v && Array.isArray(v.observations)).map(([k, v]) => [k, v.observations.map((o) => `${o.subject}: ${o.status}`).slice(0, 6)])) };
  }
  if (id === 'drift') return { status: j.status ?? null, issues: (j.issues || []).slice(0, 8).map((i) => ({ subject: i.subject, expected: i.expected, actual: i.actual })), issueCount: (j.issues || []).length };
  if (id === 'test') return { status: j.status, reason: j.reason, tool: j.tool, exitCode: j.exit_code, tests: j.tests ?? null };
  if (id === 'graph' || id === 'test-plan') return { keys: Object.keys(j).slice(0, 12) };
  return null;
}

function interpret(id, step, r, json) {
  if (r.spawnError) return r.spawnError === 'EACCES' ? { outcome: 'permission', detail: 'The executable could not be started (permission denied).' } : { outcome: 'unavailable', detail: `Could not start PAX: ${redact(r.message || r.spawnError)}` };
  if (r.cancelled) return { outcome: 'cancelled', detail: 'Cancelled before PAX finished.' };
  if (r.timedOut) return { outcome: 'timeout', detail: 'PAX did not finish within the time limit and was stopped.' };
  if (step.contract) {
    if (!json) return { outcome: 'unrecognized-output', detail: `Expected one ${step.contract} JSON document on stdout; got something else (exit ${r.exitCode}).` };
    if (json.schema !== step.contract) return { outcome: 'unrecognized-output', detail: `Output declares schema ${JSON.stringify(json.schema)}, not ${step.contract}; not interpreted.` };
    const meaning = { passed: 'PAX established that tests ran and passed', failed: 'PAX established that the native operation failed', not_run: 'No tests executed', unsupported: 'PAX has no authoritative test semantics here; the exit code is not a result', ambiguous: 'PAX could not choose a tool unambiguously; nothing ran', error: 'PAX could not run the operation' }[json.status] || 'unrecognized status';
    return { outcome: json.status, detail: `${meaning}${json.reason ? ` (${json.reason})` : ''}.` };
  }
  if (id === 'drift') {
    if (!json) return { outcome: 'unrecognized-output', detail: `Expected JSON on stdout (exit ${r.exitCode}).` };
    if (r.exitCode === 0) return { outcome: 'no-drift', detail: 'PAX found no contradictions between the layers it observes.' };
    if (r.exitCode === 1) return { outcome: 'drift-detected', detail: 'PAX found contradictions between declared and observed state (see issues). This is a finding, not a tool failure.' };
    if (r.exitCode === 2) return { outcome: 'ambiguous', detail: 'PAX could not decide (ambiguous evidence or invalid input).' };
    return { outcome: 'error', detail: `Unexpected exit code ${r.exitCode}.` };
  }
  if (r.exitCode !== 0) return { outcome: 'error', detail: `PAX exited with code ${r.exitCode}${r.stderr.trim() ? `: ${redact(r.stderr.trim().split('\n')[0].slice(0, 200))}` : ''}.` };
  if (!json) return { outcome: 'unrecognized-output', detail: 'PAX exited 0 but its stdout was not a JSON document.' };
  const schema = json.schemaVersion ?? json.schema_version;
  if (schema !== '1' && step.class !== 'plan') return { outcome: 'unrecognized-output', detail: `Output declares schema version ${JSON.stringify(schema)}; only "1" is understood.` };
  return { outcome: step.class === 'plan' ? 'planned' : 'observed', detail: step.class === 'plan' ? 'PAX printed the command it would run; nothing was executed.' : 'PAX reported its observations (see the evidence).' };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tryJson = (s) => {
  const t = s.trim();
  if (!t.startsWith('{')) return null;
  try {
    const j = JSON.parse(t);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
};

/**
 * Run the selected PAX steps against a workspace and store the output as evidence files.
 * Returns the record to persist as `run.pax`. Never throws for expected failures.
 */
export async function collectPaxEvidence(cfg, { wsRoot, evidenceDir, steps, signal, emit = () => {}, scrub = [] }) {
  const startedAt = new Date().toISOString();
  const probe = await probePax(cfg, { signal });
  const record = {
    version: 1,
    state: probe.state === 'ok' ? 'collected' : probe.state,
    startedAt,
    binary: { path: probe.path || null, version: probe.version || null, source: probe.source, identity: probe.identity || null },
    semantics: SEMANTICS,
    steps: [],
  };
  if (probe.state !== 'ok') {
    record.message = probe.message;
    record.finishedAt = new Date().toISOString();
    return record;
  }
  await fsp.rm(evidenceDir, { recursive: true, force: true });
  await fsp.mkdir(evidenceDir, { recursive: true });
  const hide = (text) => {
    let t = String(text);
    for (const p of [wsRoot, ...scrub].filter((x) => x && x.length > 3).sort((a, b) => b.length - a.length)) t = t.split(p).join('<workspace>');
    return redact(t);
  };
  const timeoutMs = cfg.paxTimeoutMs || 120_000;
  for (const id of steps) {
    const step = STEPS[id];
    if (!step) continue;
    if (signal?.aborted) break;
    const cap = probe.steps[id];
    const entry = { id, title: step.title, class: step.class, about: step.about, command: `pax ${[...(step.args.includes('--dry-run') ? ['--dry-run'] : []), '--json', '--dir', '<workspace>', ...step.args.filter((a) => a !== '--dry-run')].join(' ')}` };
    if (!cap.available) {
      record.steps.push({ ...entry, outcome: 'not-supported', detail: `Skipped: ${cap.reason}.`, artifacts: [] });
      emit('pax', { step: id, outcome: 'not-supported' });
      continue;
    }
    const argv = step.args.includes('--dry-run') ? ['--dry-run', '--json', '--dir', wsRoot, ...step.args.filter((a) => a !== '--dry-run')] : ['--json', '--dir', wsRoot, ...step.args];
    // The test step runs project code, so it gets the same throw-away HOME as every other workspace command.
    const env = step.class === 'execution' ? { ...observeEnv(), HOME: path.join(wsRoot, '.home'), CI: '1' } : observeEnv();
    if (step.class === 'execution') await fsp.mkdir(env.HOME, { recursive: true });
    const r = await execArgv(probe.path, argv, { cwd: wsRoot, env, timeoutMs, signal });
    const json = tryJson(r.stdout);
    const { outcome, detail } = interpret(id, step, r, json);
    const artifacts = [];
    const outText = hide(r.stdout);
    const errText = hide(r.stderr);
    if (outText.trim()) {
      const name = `${id}.stdout.${json ? 'json' : 'txt'}`;
      await fsp.writeFile(path.join(evidenceDir, name), outText);
      artifacts.push({ name, kind: 'stdout', bytes: Buffer.byteLength(outText), sha256: sha(outText) });
    }
    if (errText.trim()) {
      const name = `${id}.stderr.txt`;
      await fsp.writeFile(path.join(evidenceDir, name), errText);
      artifacts.push({ name, kind: 'stderr', bytes: Buffer.byteLength(errText), sha256: sha(errText) });
    }
    const item = {
      ...entry,
      startedAt: new Date(Date.now() - r.durationMs).toISOString(),
      durationMs: r.durationMs,
      exitCode: r.exitCode,
      signal: r.signal || null,
      timedOut: Boolean(r.timedOut),
      truncated: Boolean(r.truncated),
      outcome,
      detail,
      result: json ? summarize(id, JSON.parse(hide(JSON.stringify(json)))) : null,
      stderrTail: errText.trim().split('\n').slice(-6).join('\n').slice(-800) || null,
      artifacts,
    };
    record.steps.push(item);
    emit('pax', { step: id, outcome, exitCode: r.exitCode, durationMs: r.durationMs });
  }
  record.finishedAt = new Date().toISOString();
  if (signal?.aborted) record.state = 'cancelled';
  record.summary = {
    steps: record.steps.length,
    observed: record.steps.filter((s) => ['observed', 'no-drift', 'planned', 'passed'].includes(s.outcome)).length,
    findings: record.steps.filter((s) => ['drift-detected', 'failed'].includes(s.outcome)).length,
    problems: record.steps.filter((s) => ['error', 'timeout', 'permission', 'unavailable', 'unrecognized-output', 'not-supported', 'cancelled'].includes(s.outcome)).length,
  };
  await fsp.writeFile(path.join(evidenceDir, 'manifest.json'), JSON.stringify(record, null, 2));
  return record;
}

/** Evidence files for a run (names are validated by the caller before reading). */
export async function listEvidence(evidenceDir) {
  try {
    const names = (await fsp.readdir(evidenceDir)).filter((n) => /^[a-z0-9.-]+$/.test(n));
    return Promise.all(names.map(async (name) => ({ name, bytes: (await fsp.stat(path.join(evidenceDir, name))).size })));
  } catch {
    return [];
  }
}
