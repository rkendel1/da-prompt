// How runs, events and evidence are shown in a terminal. Everything displayed comes from backend data;
// nothing here decides that something succeeded.
import { dur, ago } from './core.js';

const hhmmss = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false });
const pad = (s, n) => String(s).padEnd(n);

export function statusPaint(out, status) {
  const f = { completed: out.green, running: out.cyan, planning: out.cyan, completing: out.cyan, queued: out.cyan, needs_attention: out.yellow, interrupted: out.yellow, failed: out.red, cancelled: out.dim }[status] || ((s) => s);
  return f(status.replace(/_/g, ' '));
}

/** One event as zero or more lines. `verbose` adds agent chatter and every tool call. */
export function formatEvent(e, out, { verbose = false } = {}) {
  const t = out.dim(hhmmss(e.at));
  const L = (s) => `${t} ${s}`;
  const ok = (b) => (b ? out.green('✓') : out.red('✗'));
  switch (e.type) {
    case 'run.created': return [L(`run created · ${e.provider}${e.model ? ` / ${e.model}` : ''}${e.source ? ` · ${e.source.mode} ${e.source.label}` : ''}`)];
    case 'run.status': return [L(`${out.bold('status →')} ${statusPaint(out, e.status)}${e.note ? ` (${e.note})` : ''}`)];
    case 'layer': return e.state === 'pending' ? [] : [L(out.dim(`layer ${e.layer}: ${e.state}`))];
    case 'stage': return [L(`${out.cyan(e.stage)} ${e.state}${e.detail ? ` — ${e.detail}` : ''}`)];
    case 'source': return [L(`source: ${e.mode} ${e.label}${e.ref ? ` @ ${e.ref}` : ''} · ${e.workingMode} · base ${String(e.baseSha || '').slice(0, 10)} · branch ${e.branch}${e.note ? ` · ${e.note}` : ''}`)];
    case 'inspect': return [L(`inspected: ${e.summary}${e.instructions?.length ? ` · instructions: ${e.instructions.join(', ')}` : ''}`)];
    case 'baseline': return [L(`baseline ${ok(e.status === 'passed')} ${e.command} → ${e.status}${e.limitation ? ` (${e.limitation})` : ''}`)];
    case 'plan': return [L(`${out.bold('plan:')} ${e.tasks} tasks in ${e.levels} levels`)];
    case 'agents': return [L(`agents: ${e.roles.join(', ')}`)];
    case 'task': return [L(`[${out.bold(e.taskId)}] ${e.status === 'completed' ? out.green(e.status) : e.status === 'blocked' ? out.yellow(e.status) : e.status}${e.attempt ? ` (attempt ${e.attempt})` : ''}${e.title && e.status === 'running' ? ` — ${e.title}` : ''}${e.summary ? ` — ${e.summary}` : ''}${e.blockedBy ? ` by ${e.blockedBy}` : ''}`)];
    case 'tool': {
      if (verbose) return [L(out.dim(`    ${e.taskId} › ${e.tool} ${e.input?.path || e.input?.command || ''}${e.ok ? '' : ' ✗'}`))];
      if (e.tool === 'run_command' && !e.ok) return [L(out.dim(`    ${e.taskId} › $ ${e.input?.command} → exit ${e.exitCode}`))];
      return [];
    }
    case 'agent.message': return verbose ? [L(out.dim(`    ${e.taskId}: “${e.text}”`))] : [];
    case 'verify': return [L(`verify ${e.taskId === '_final' ? 'final' : e.taskId}: ${e.results.map((r) => `${ok(r.ok)} ${r.command}${r.state && !['passed'].includes(r.state) ? ` (${r.state})` : ''}`).join('  ')}`)];
    case 'feedback': return [L(out.yellow(`feedback ${e.taskId}: ${e.headline}${e.willRetry ? ' → retrying' : ''}`))];
    case 'lesson': return verbose ? [L(out.dim(`lesson: ${e.text}`))] : [];
    case 'escalation': return [L(out.red(`ESCALATED ${e.taskId}: ${e.reason}`)), `         ${out.dim(`→ da-prompt runs retry <run> ${e.taskId}   |   da-prompt runs skip <run> ${e.taskId}`)}`];
    case 'escalation.resolved': return [L(`escalation resolved: ${e.taskId} ${e.action}`)];
    case 'checklist': return e.items.map((i) => L(`checklist ${ok(i.ok)} ${i.label}${i.state && !['pass', 'fail'].includes(i.state) ? ` (${i.state})` : ''} — ${i.detail || ''}`));
    case 'deploy': return [L(e.ok ? `deployed: ${e.url}` : out.red(`deploy failed: ${e.error}`))];
    case 'deliver': return [L(`delivered: ${[e.report, e.patch, e.archive].filter(Boolean).join(', ')}`)];
    case 'output': return [L(e.ok ? `exported to ${e.dir}` : out.red(`export to ${e.dir} failed: ${e.error}`))];
    case 'git': return [L(e.ok ? `pushed to ${e.repoUrl}` : out.red(`git push failed: ${e.error}`))];
    case 'pax': return [L(`PAX ${e.step}: ${e.outcome}${e.exitCode != null ? ` (exit ${e.exitCode})` : ''}`)];
    case 'pax.done': return [L(`PAX evidence ${e.state}${e.message ? ` — ${e.message}` : ''}`)];
    case 'publish': return [L(e.state === 'failed' ? out.red(`publish failed (${e.step}): ${e.error}`) : `publish: ${e.state}${e.branch ? ` ${e.branch}` : ''}${e.pr ? ` — ${e.pr.url}` : ''}${e.prError ? out.yellow(` — ${e.prError}`) : ''}`)];
    case 'apply': return [L(e.mode === 'branch' ? `branch exported: ${e.branch}` : e.ok ? `applied ${e.files} file(s)` : out.red(`apply refused: ${(e.conflicts || []).length} conflict(s)`))];
    case 'review': return [L(`review: ${e.decision}`)];
    case 'reverify': return [L(`re-verified: ${e.results.map((r) => `${ok(r.ok)} ${r.command} (${r.state})`).join('  ')}`)];
    case 'error': return [L(out.red(`error: ${e.message}`))];
    case 'log': return [L(e.level === 'warn' ? out.yellow(e.text) : out.dim(e.text))];
    default: return verbose ? [L(out.dim(e.type))] : [];
  }
}

/** A single self-updating status line for terminals. */
export class Progress {
  constructor(out) {
    this.out = out;
    this.tasks = new Map();
    this.total = 0;
    this.layer = '';
    this.started = Date.now();
    this.shown = false;
  }

  seed(run) {
    for (const t of run.plan?.tasks || []) this.tasks.set(t.id, { status: t.status, attempt: t.attempts?.length || 0 });
    this.total = run.plan?.tasks?.length || 0;
    this.started = Date.parse(run.startedAt || run.createdAt) || Date.now();
  }

  update(e) {
    if (e.type === 'plan') this.total = e.tasks;
    if (e.type === 'task') this.tasks.set(e.taskId, { status: e.status, attempt: e.attempt || this.tasks.get(e.taskId)?.attempt || 0 });
    if (e.type === 'layer' && e.state === 'active') this.layer = e.layer;
    if (e.type === 'stage' && e.state === 'active') this.layer = e.stage;
  }

  text() {
    const done = [...this.tasks.values()].filter((t) => t.status === 'completed' || t.status === 'skipped').length;
    const running = [...this.tasks].filter(([, t]) => t.status === 'running').map(([id, t]) => `${id}${t.attempt > 1 ? `(try ${t.attempt})` : ''}`);
    return `${this.total ? `${done}/${this.total} tasks` : 'starting'}${running.length ? ` · running: ${running.join(', ')}` : ''}${this.layer ? ` · ${this.layer}` : ''} · ${dur(new Date(this.started).toISOString())}`;
  }

  draw(stream) {
    stream.write(`\r\x1b[K${this.out.dim(this.text())}`);
    this.shown = true;
  }

  clear(stream) {
    if (this.shown) stream.write('\r\x1b[K');
  }
}

export const taskRows = (run) => (run.plan?.tasks || []).map((t) => ({ id: t.id, role: t.role, status: t.status, attempts: t.attempts?.length || 0, level: t.level, dependsOn: t.dependsOn || [], title: t.title, error: t.error || t.escalation?.reason || null, verify: t.verify || [] }));

export function summaryOf(run, evidence) {
  const tasks = taskRows(run);
  return {
    id: run.id,
    title: run.title,
    status: run.status,
    executing: Boolean(run.executing),
    task: run.inputs?.idea,
    project: run.source ? { mode: run.source.mode, label: run.source.label, workingMode: run.source.workingMode, baseBranch: run.source.baseBranch || null, branch: run.source.branch || null } : { mode: 'new' },
    provider: run.provider,
    model: run.model,
    plannerProvider: run.plannerProvider,
    plannerModel: run.plannerModel,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error || null,
    tasks,
    verification: evidence ? { verdict: evidence.factory.verdict, checklist: evidence.factory.checklist.map((c) => ({ id: c.id, ok: c.ok, state: c.state, detail: c.detail })), missing: evidence.missing, notes: evidence.notes } : null,
    pax: run.pax ? { state: run.pax.state, steps: (run.pax.steps || []).map((s) => ({ id: s.id, outcome: s.outcome })) } : null,
    changes: run.changes ? { files: run.changes.files.length, additions: run.changes.additions, deletions: run.changes.deletions } : null,
    delivery: run.delivery ? { ready: run.delivery.readiness?.ready ?? null, reasons: run.delivery.readiness?.reasons || [], integrity: run.delivery.integrity?.ok ?? null, publication: run.delivery.publication ? { state: run.delivery.publication.state, branch: run.delivery.publication.branch, pr: run.delivery.publication.pr?.url || null, error: run.delivery.publication.error || run.delivery.publication.prError || null } : null, applied: run.delivery.local?.applied ? run.delivery.local.applied.files.length : null, branchExport: run.delivery.local?.branch?.branch || null } : null,
    review: run.review ? { decision: run.review.decision, at: run.review.at, note: run.review.note } : null,
    next: nextActions(run, evidence).map((n) => n.cmd),
  };
}

export function nextActions(run, evidence) {
  const id = run.id;
  const n = [];
  if (run.executing) return [{ cmd: `da-prompt runs follow ${id}`, why: 'watch it' }, { cmd: `da-prompt runs cancel ${id}`, why: 'stop it' }];
  const esc = (run.plan?.tasks || []).filter((t) => t.status === 'escalated');
  for (const t of esc) n.push({ cmd: `da-prompt runs retry ${id} ${t.id}`, why: `retry the escalated task "${t.id}"` }, { cmd: `da-prompt runs skip ${id} ${t.id}`, why: `skip "${t.id}" and continue` });
  if (['needs_attention', 'interrupted', 'failed', 'cancelled'].includes(run.status)) n.push({ cmd: `da-prompt runs resume ${id}`, why: 'continue from where it stopped' });
  n.push({ cmd: `da-prompt runs evidence ${id}`, why: 'see agent claims, factory verification and PAX separately' });
  if (run.source && run.delivery?.integrity) {
    n.push({ cmd: `da-prompt runs diff ${id}`, why: 'review the changes' });
    const d = run.review?.decision;
    if (!d) n.push({ cmd: `da-prompt runs review ${id} approve`, why: 'approve these exact changes (required before apply/publish)' });
    if (d === 'approved' && run.source.mode === 'local' && !run.delivery.local?.applied) n.push({ cmd: `da-prompt runs apply ${id}`, why: 'write the approved changes into your directory' });
    if (d === 'approved' && run.source.mode === 'github' && !run.delivery.publication?.pr) n.push({ cmd: `da-prompt runs publish ${id}`, why: 'push the run branch and open a pull request' });
  }
  void evidence;
  return n;
}

export function renderRunSummary(run, evidence, out) {
  const L = [];
  const tasks = taskRows(run);
  L.push(`${out.bold(run.title)}  ${out.dim(run.id)}`);
  L.push(`  status    ${statusPaint(out, run.status)}${run.executing ? out.cyan(' (executing)') : ''}   ${out.dim(`${dur(run.startedAt || run.createdAt, run.finishedAt)} · ${ago(run.createdAt)}`)}`);
  L.push(`  task      ${String(run.inputs?.idea || '').split('\n')[0].slice(0, 100)}`);
  L.push(`  project   ${run.source ? `${run.source.mode === 'github' ? 'GitHub' : 'local'} ${run.source.label}${run.source.workingMode ? ` · ${run.source.workingMode}` : ''}${run.source.branch ? ` · branch ${run.source.branch}` : ''}` : 'new application'}`);
  L.push(`  model     ${run.provider}${run.model ? ` / ${run.model}` : ''}${run.plannerProvider && (run.plannerProvider !== run.provider || run.plannerModel !== run.model) ? `   planner ${run.plannerProvider} / ${run.plannerModel}` : ''}`);
  if (run.error) L.push(`  ${out.red('error')}     ${run.error}`);
  if (tasks.length) {
    L.push('', out.bold('Tasks'));
    for (const t of tasks) L.push(`  ${t.status === 'completed' ? out.green('✓') : t.status === 'escalated' || t.status === 'failed' ? out.red('✗') : t.status === 'blocked' ? out.yellow('!') : t.status === 'running' ? out.cyan('●') : '○'} ${pad(t.id, 14)} ${pad(t.role, 9)} ${pad(t.status, 10)} ${t.attempts ? `${t.attempts} attempt${t.attempts === 1 ? '' : 's'}` : ''}${t.dependsOn.length ? out.dim(`  after ${t.dependsOn.join(', ')}`) : ''}${t.error ? out.red(`  ${t.error}`) : ''}`);
  }
  if (evidence) {
    const f = evidence.factory;
    L.push('', `${out.bold('Factory verification')}  ${f.verdict ? ({ verified: out.green('verified'), failed: out.red('failed'), unverified: out.yellow('not verified'), 'partially-verified': out.yellow('partially verified'), 'verified-with-preexisting-failures': out.yellow('verified, pre-existing failures remain') }[f.verdict] || f.verdict) : out.dim('(checklist below)')}`);
    for (const c of f.checklist) L.push(`  ${c.ok ? out.green('✓') : out.red('✗')} ${c.label || c.id}${c.state && !['pass', 'fail'].includes(c.state) ? ` (${c.state})` : ''}${c.detail ? out.dim(` — ${c.detail}`) : ''}`);
    for (const m of evidence.missing) L.push(`  ${out.yellow('!')} missing: ${m}`);
    for (const m of evidence.notes) L.push(`  ${out.yellow('!')} ${m}`);
  }
  if (run.pax) L.push('', `${out.bold('PAX observation')} ${out.dim('(not verification)')}  ${run.pax.state}${run.pax.summary ? ` · ${run.pax.summary.observed}/${run.pax.summary.steps} observed, ${run.pax.summary.findings} finding(s), ${run.pax.summary.problems} problem(s)` : ''}`);
  if (run.changes) L.push('', `${out.bold('Changes')}  ${run.changes.files.length} file(s) +${run.changes.additions} −${run.changes.deletions}`);
  if (run.delivery?.readiness) L.push(`${out.bold('Delivery')}  ${run.delivery.readiness.ready ? out.green('ready for review') : out.yellow('not ready')}${run.delivery.readiness.reasons?.length ? ` — ${run.delivery.readiness.reasons.join('; ')}` : ''}${run.delivery.integrity?.ok === false ? out.red('  SOURCE PROTECTION FAILED') : ''}`);
  if (run.review) L.push(`${out.bold('Review')}  ${run.review.decision}${run.review.note ? ` — “${run.review.note}”` : ''}`);
  const pub = run.delivery?.publication;
  if (pub) L.push(`${out.bold('Publication')}  ${pub.state}${pub.pr ? ` — ${pub.pr.url}${pub.pr.draft ? ' (draft)' : ''}` : ''}${pub.error ? out.red(` — ${pub.error}`) : ''}${pub.prError ? out.yellow(` — ${pub.prError}`) : ''}`);
  if (run.delivery?.local?.applied) L.push(`${out.bold('Applied')}  ${run.delivery.local.applied.files.length} file(s) written to your directory`);
  const next = nextActions(run, evidence);
  if (next.length) L.push('', out.bold('Next'), ...next.map((x) => `  ${x.cmd}   ${out.dim(`# ${x.why}`)}`));
  return L.join('\n');
}
