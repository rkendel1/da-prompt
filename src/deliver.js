// <deliver>: package the working application, test results and a factory report.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { safeEnv } from './sandbox.js';
import { isExisting, verificationSummary, changeSummary, changePatch, commitChanges } from './project.js';

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('error', (e) => resolve({ code: 1, out: e.message }));
    child.on('close', (code) => resolve({ code, out: out.slice(-4000) }));
  });
}

// ── Output location ───────────────────────────────────────────────────────────────────────────
const MARKER = '.da-prompt-run';
const NOT_EXPORTED = new Set(['node_modules', '.home', '.git']);
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/**
 * Turn the user's requested output directory into a safe absolute path (or null for "none").
 * Throws a user-readable error for locations the factory must never write into.
 */
export function resolveOutputDir(cfg, input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return null;
  if (raw.includes('\0')) throw new Error('outputDir is not a valid path');
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw;
  const dir = path.resolve(cfg.outputRoot || process.cwd(), expanded);
  if (cfg.outputRoot && (dir === cfg.outputRoot || !within(dir, cfg.outputRoot))) throw new Error(`outputDir must be inside ${cfg.outputRoot}`);
  const protectedDirs = [path.parse(dir).root, os.homedir(), cfg.root, cfg.dataDir];
  if (protectedDirs.some((p) => dir === p || within(p, dir)) || within(dir, cfg.dataDir)) throw new Error(`outputDir ${dir} is a protected location; choose a new project folder`);
  return dir;
}

/** Fail early when the target can't be used: a file, or a folder holding someone else's work. */
export async function checkOutputDir(dir, runId) {
  let st;
  try {
    st = await fsp.stat(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw new Error(`cannot use outputDir ${dir}: ${err.message}`);
  }
  if (!st.isDirectory()) throw new Error(`outputDir ${dir} exists and is not a directory`);
  const entries = await fsp.readdir(dir);
  if (!entries.length) return;
  const marker = await fsp.readFile(path.join(dir, MARKER), 'utf8').catch(() => '');
  if (marker.trim() !== runId) throw new Error(`outputDir ${dir} already has files in it; choose a new or empty folder`);
}

/** Copy the finished project (minus dependencies and internals) into the requested directory. */
export async function exportProject(ws, dir, runId) {
  try {
    await checkOutputDir(dir, runId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.cp(ws.root, dir, {
      recursive: true,
      filter: async (src) => {
        if (NOT_EXPORTED.has(path.basename(src))) return false;
        return !(await fsp.lstat(src)).isSymbolicLink();
      },
    });
    await fsp.writeFile(path.join(dir, MARKER), `${runId}\n`);
    return { ok: true, dir };
  } catch (err) {
    return { ok: false, dir, error: err.message };
  }
}

/** One honest word for the state of the project's checks. */
export function verdictOf(run) {
  const v = verificationSummary(run);
  if (v.regressions || v.newFailures || v.blocked) return 'failed';
  if (!v.passed && !v.fixed) return 'unverified';
  if (v.unavailable) return 'partially-verified';
  if (v.preexisting) return 'verified-with-preexisting-failures';
  return 'verified';
}

const STATE_LABEL = { passed: 'passed', fixed: 'passed (was failing at baseline)', preexisting: 'FAILED — pre-existing, nothing new', regression: 'FAILED — regression introduced by this run', 'new-failure': 'FAILED — new check failing', unavailable: 'NOT RUN — tool or command unavailable', blocked: 'NOT RUN — blocked by command policy' };

function existingSections(run) {
  const L = [];
  const src = run.source;
  L.push('## Source');
  L.push(`- Mode: **${src.mode === 'github' ? 'GitHub repository' : 'local directory'}** — ${src.label}${src.ref ? ` @ ${src.ref}` : ''}`);
  L.push(`- Isolation: \`${src.workingMode}\` (the source itself is never edited)`);
  if (src.baseSha) L.push(`- Baseline commit: \`${src.baseSha.slice(0, 12)}\`${src.baseBranch ? ` on \`${src.baseBranch}\`` : ''}`);
  if (src.branch) L.push(`- Working branch: \`${src.branch}\``);
  if (src.snapshotNote) L.push(`- Note: ${src.snapshotNote}`);
  const i = run.project?.inspection;
  if (i) L.push(`- Detected: ${i.ecosystems.join(', ') || 'unknown stack'}, ${i.files} files; checks: ${i.baselineCommands.map((c) => `\`${c.command}\``).join(', ') || 'none detected'}`);
  L.push('');
  if (run.project?.baseline?.length) {
    L.push('## Baseline (before any change)', '| Command | Result | Notes |', '| --- | --- | --- |');
    for (const b of run.project.baseline) L.push(`| \`${b.command}\` | ${b.status} | ${(b.limitation || b.signature?.[0] || '').replace(/\|/g, '\\|').slice(0, 140)} |`);
    L.push('');
  }
  if (run.finalVerification?.length) {
    const v = verificationSummary(run);
    L.push(`## Verification — ${verdictOf(run).replace(/-/g, ' ')}`);
    L.push(`${v.passed + v.fixed} passed · ${v.preexisting} pre-existing failure(s) · ${v.regressions + v.newFailures} new failure(s) · ${v.unavailable + v.blocked} not run`, '');
    for (const c of run.finalVerification) L.push(`- \`${c.command}\` → ${STATE_LABEL[c.state] || (c.ok ? 'passed' : 'failed')} (exit ${c.exitCode})`);
    L.push('');
  } else {
    L.push('## Verification — unverified', 'No project checks were run, so nothing here is claimed as verified.', '');
  }
  if (run.changes) {
    L.push(`## Changes (${run.changes.files.length} file${run.changes.files.length === 1 ? '' : 's'}, +${run.changes.additions} −${run.changes.deletions})`);
    for (const f of run.changes.files.slice(0, 80)) L.push(`- \`${f.status}\` ${f.path} (+${f.additions}/−${f.deletions})`);
    if (!run.changes.files.length) L.push('- No files were changed.');
    L.push('');
  }
  if (run.delivery) {
    const d = run.delivery;
    L.push('## Delivery');
    L.push(`- Readiness: **${d.readiness?.ready ? 'ready for review' : 'not ready'}**${d.readiness?.reasons?.length ? ` — ${d.readiness.reasons.join('; ')}` : ''}`);
    if (d.integrity) L.push(`- Source protection: ${d.integrity.ok ? 'verified — the source ref and history were not modified' : `VIOLATED — ${d.integrity.problems.join('; ')}`}`);
    const pub = d.publication;
    if (pub) {
      L.push(`- Publication: **${pub.state}**${pub.error ? ` — ${pub.error}` : ''}${pub.prError ? ` — ${pub.prError}` : ''}`);
      if (pub.pr) L.push(`- Pull request: ${pub.pr.url}${pub.pr.draft ? ' (draft)' : ''}${pub.pr.reused ? ' (existing)' : ''}`);
    } else {
      L.push(`- Publication: ${src.mode === 'github' ? 'not requested (push and pull request are explicit)' : 'not applicable (local runs never push)'}`);
    }
    if (d.local?.applied) L.push(`- Applied to the source directory: ${d.local.applied.files.length} file(s)`);
    if (d.local?.branch) L.push(`- Exported branch in your repository: \`${d.local.branch.branch}\``);
    L.push('');
  }
  return L;
}

export function buildReport(run) {
  const existing = isExisting(run);
  const p = run.plan;
  const L = [];
  L.push(`# ${p?.product?.name || run.title} — Factory Report`, '');
  L.push(`- Run: \`${run.id}\``, `- Status: **${run.status}**`, `- Provider: ${run.provider}${run.model ? ` (${run.model})` : ''}`);
  if (run.plannerProvider && (run.plannerProvider !== run.provider || run.plannerModel !== run.model)) L.push(`- Planner: ${run.plannerProvider} (${run.plannerModel})`);
  if (run.outputDir) L.push(`- Delivered to: \`${run.outputDir}\``);
  L.push(`- Tokens: ${(run.usage?.input || 0) + (run.usage?.output || 0)} (${run.usage?.input || 0} in / ${run.usage?.output || 0} out), ${run.usage?.calls || 0} model calls`);
  if (run.startedAt && run.finishedAt) L.push(`- Duration: ${Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000)}s`);
  L.push('', existing ? '## Request' : '## Idea', run.inputs.idea, '');
  if (existing) L.push(...existingSections(run));
  if (run.summary) L.push('## Summary', run.summary, '');
  if (p) {
    L.push('## Product', p.product.summary, '', '**Success criteria**', ...p.product.successCriteria.map((c) => `- ${c}`), '');
    L.push('## Tasks', '| Task | Role | Status | Attempts | Result |', '| --- | --- | --- | --- | --- |');
    for (const t of p.tasks) {
      L.push(`| ${t.id} — ${t.title} | ${t.role} | ${t.status} | ${t.attempts?.length || 0} | ${(t.result?.summary || t.error || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220)} |`);
    }
    L.push('');
  }
  if (run.checklist?.length) {
    L.push('## Completion checklist');
    for (const c of run.checklist) L.push(`- [${c.ok ? 'x' : ' '}] ${c.label}${c.state && c.state !== 'pass' && c.state !== 'fail' ? ` (${c.state})` : ''}${c.detail ? ` — ${c.detail}` : ''}`);
    L.push('');
  }
  if (!existing && run.finalVerification?.length) {
    L.push('## Test results');
    for (const v of run.finalVerification) L.push(`- \`${v.command}\` → exit ${v.exitCode} (${v.durationMs}ms)`);
    L.push('');
  }
  if (existing && !run.deployment) L.push('## Deployment', run.settings.deploy ? 'No deployment was started.' : 'Not requested for this run (nothing was deployed).', '');
  if (run.pax) {
    L.push('## PAX observation (separate from verification)', `_${run.pax.semantics}_`, '');
    if (run.pax.state !== 'collected') L.push(`PAX evidence was not collected: ${run.pax.state}${run.pax.message ? ` — ${run.pax.message}` : ''}.`, '');
    else {
      L.push(`PAX ${run.pax.binary?.version || '?'} (${run.pax.binary?.source === 'configured' ? 'configured path' : 'from PATH'})`, '');
      for (const s of run.pax.steps) L.push(`- **${s.title}** (\`${s.command}\`) → ${s.outcome}${s.exitCode != null ? ` (exit ${s.exitCode})` : ''} — ${s.detail}`);
      L.push('');
    }
  }
  if (run.deployment) {
    L.push('## Deployment');
    if (run.deployment.ok) L.push(`Live preview: ${run.deployment.url} (health ${run.deployment.healthPath} → ${run.deployment.status})`);
    else L.push(`Live preview failed: ${run.deployment.error}`);
    L.push(`Start command: \`${run.deployment.start}\`. See DEPLOY.md for production deployment.`, '');
  }
  if (run.lessons?.length) {
    L.push(existing ? '## Lessons recorded (factory notes; your repository was not modified)' : '## Lessons recorded (CLAUDE.md)', ...run.lessons.map((l) => `- ${l.text}`), '');
  }
  const left = [];
  for (const t of p?.tasks || []) if (t.status !== 'completed') left.push(`${t.id}: ${t.status}${t.error ? ` (${t.error})` : ''}`);
  for (const c of run.checklist || []) if (!c.ok) left.push(`Checklist: ${c.label}`);
  L.push("## What's left", ...(left.length ? left.map((x) => `- ${x}`) : ['- Nothing blocking. See recommendations in the summary.']), '');
  if (p?.risks?.length) L.push('## Risks', ...p.risks.map((r) => `- ${r}`), '');
  if (p?.openQuestions?.length) L.push('## Open questions', ...p.openQuestions.map((r) => `- ${r}`), '');
  return L.join('\n');
}

export async function packageDelivery(run, ws, deliveryDir) {
  await fsp.mkdir(deliveryDir, { recursive: true });
  const report = buildReport(run);
  await fsp.writeFile(path.join(deliveryDir, 'FACTORY_REPORT.md'), report);
  await ws.writeFile('FACTORY_REPORT.md', report);
  const tests = {
    final: run.finalVerification || [],
    tasks: (run.plan?.tasks || []).map((t) => ({ id: t.id, status: t.status, verification: t.attempts?.at(-1)?.verification || [] })),
    security: run.security || null,
    pax: run.pax ? { state: run.pax.state, steps: (run.pax.steps || []).map((s) => ({ id: s.id, outcome: s.outcome, exitCode: s.exitCode })) } : null,
  };
  await fsp.writeFile(path.join(deliveryDir, 'test-results.json'), JSON.stringify(tests, null, 2));
  const archive = path.join(deliveryDir, 'project.tar.gz');
  const name = (run.plan?.product?.name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
  const base = ['-czf', archive, '--exclude=node_modules', '--exclude=.home', '--exclude=.git'];
  // GNU tar renames with --transform; bsdtar (macOS) uses -s.
  let r = await sh('tar', [...base, `--transform=s,^\\.,${name},`, '.'], { cwd: ws.root });
  if (r.code !== 0) r = await sh('tar', [...base, '-s', `,^\\.,${name},`, '.'], { cwd: ws.root });
  return { report: 'FACTORY_REPORT.md', tests: 'test-results.json', archive: r.code === 0 ? 'project.tar.gz' : null, archiveError: r.code === 0 ? null : r.out };
}

/** Optional: push the generated project to a git remote (e.g. a GitHub repo) with a token. */
export async function pushToGit(ws, { repoUrl, token, branch = 'main', message, author = { name: 'da-prompt factory', email: 'factory@da-prompt.local' } }) {
  if (!/^https:\/\//.test(repoUrl)) return { ok: false, error: 'only https:// remotes are supported' };
  const env = { ...safeEnv(), GIT_TERMINAL_PROMPT: '0', HOME: path.join(ws.root, '.home') };
  const opts = { cwd: ws.root, env };
  const steps = [
    ['git', ['init', '-q', '-b', branch]],
    ['git', ['add', '-A']],
    ['git', ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '--allow-empty', '-m', message]],
  ];
  await fsp.writeFile(path.join(ws.root, '.gitignore'), await fsp.readFile(path.join(ws.root, '.gitignore'), 'utf8').catch(() => 'node_modules/\n') + '\n.home/\n');
  for (const [c, a] of steps) {
    const r = await sh(c, a, opts);
    if (r.code !== 0) return { ok: false, error: r.out };
  }
  const auth = token ? ['-c', `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : [];
  const r = await sh('git', [...auth, 'push', '-q', repoUrl, `HEAD:${branch}`], opts);
  return r.code === 0 ? { ok: true, repoUrl, branch } : { ok: false, error: r.out.replace(/basic [A-Za-z0-9+/=]+/g, 'basic ***') };
}

/**
 * Delivery for a run against an existing project: commit the work onto the run branch (workspace only),
 * then write the patch, a changed-files archive, the report and the machine-readable results into the
 * run's delivery folder. Nothing is written into the project itself.
 */
export async function packageExistingDelivery(cfg, run, ws, deliveryDir, { commit: doCommit = true } = {}) {
  await fsp.mkdir(deliveryDir, { recursive: true });
  const commit = doCommit ? await commitChanges(cfg, run, ws.root, `da-prompt: ${run.title}`) : { sha: null, commits: 0, committed: false, skipped: 'source protection check failed' };
  const changes = await changeSummary(cfg, run, ws.root);
  run.changes = changes;
  const patch = await changePatch(cfg, run, ws.root);
  await fsp.writeFile(path.join(deliveryDir, 'changes.patch'), patch);
  const keep = changes.files.filter((f) => f.status !== 'D').map((f) => f.path);
  const removed = changes.files.filter((f) => f.status === 'D').map((f) => f.path);
  let archive = null;
  let archiveError = null;
  if (keep.length) {
    const list = path.join(deliveryDir, 'changed-files.list');
    await fsp.writeFile(list, `${keep.join('\0')}\0`);
    const r = await sh('tar', ['-czf', path.join(deliveryDir, 'project.tar.gz'), '--null', '-T', list], { cwd: ws.root });
    await fsp.rm(list, { force: true });
    if (r.code === 0) archive = 'project.tar.gz';
    else archiveError = r.out;
  } else {
    await fsp.rm(path.join(deliveryDir, 'project.tar.gz'), { force: true });
  }
  if (removed.length) await fsp.writeFile(path.join(deliveryDir, 'DELETED_FILES.txt'), `${removed.join('\n')}\n`);
  const tests = {
    verdict: verdictOf(run),
    baseline: (run.project?.baseline || []).map(({ command, kind, status, exitCode, limitation }) => ({ command, kind, status, exitCode, limitation })),
    final: (run.finalVerification || []).map(({ command, state, ok, exitCode, durationMs }) => ({ command, state, ok, exitCode, durationMs })),
    tasks: (run.plan?.tasks || []).map((t) => ({ id: t.id, status: t.status, verification: (t.attempts?.at(-1)?.verification || []).map(({ command, state, ok, exitCode }) => ({ command, state, ok, exitCode })) })),
    security: run.security || null,
    pax: run.pax ? { state: run.pax.state, steps: (run.pax.steps || []).map((s) => ({ id: s.id, outcome: s.outcome, exitCode: s.exitCode })) } : null,
    changes: changes.files,
  };
  await fsp.writeFile(path.join(deliveryDir, 'test-results.json'), JSON.stringify(tests, null, 2));
  return { report: 'FACTORY_REPORT.md', tests: 'test-results.json', patch: 'changes.patch', archive, archiveError, deleted: removed.length ? 'DELETED_FILES.txt' : null, commit };
}

export async function writeReport(run, deliveryDir) {
  await fsp.writeFile(path.join(deliveryDir, 'FACTORY_REPORT.md'), buildReport(run));
}
