// run, runs list|show|tasks|logs|follow|cancel|resume|update|rerun|retry|skip|files|diff|tests|verify|report|evidence|artifacts|review|apply|publish|delete
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { CliError, EXIT, TERMINAL, RESUMABLE, ago, bytes, exitForRun, table, usageError } from '../core.js';
import { projectFor } from '../ops.js';
import { Progress, formatEvent, nextActions, renderRunSummary, statusPaint, summaryOf, taskRows } from '../runview.js';

const num = (v, name, min = 1, max = Infinity) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw usageError(`--${name} must be a number from ${min}${max === Infinity ? ' up' : ` to ${max}`}.`);
  return n;
};
const getRun = async (client, id) => (await client.get(`/api/runs/${encodeURIComponent(id)}`)).run;
export const getEvidence = async (client, id) => (await client.get(`/api/runs/${encodeURIComponent(id)}/evidence`)).evidence;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function confirm(ctx, message) {
  if (ctx.opts.yes) return true;
  if (!(ctx.io.stdin.isTTY && process.stdout.isTTY) || ctx.out.json) throw new CliError(`${message}\nRefusing to continue without explicit confirmation in a non-interactive session.`, { code: EXIT.USAGE, hint: 'Pass --yes to confirm.' });
  const rl = readline.createInterface({ input: ctx.io.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${message} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

// ── starting and following ──────────────────────────────────────────────────────────────────────

export const RUN_OPTIONS = {
  project: { type: 'string', valueName: 'PROJECT', description: 'Project id, name, path (inside an authorized folder) or owner/repo. Default: the one from "projects use".' },
  new: { type: 'boolean', description: 'Build a new application instead of changing a project.' },
  ref: { type: 'string', valueName: 'REF', description: 'GitHub branch, tag or commit to start from.' },
  'working-mode': { type: 'string', valueName: 'MODE', description: 'Local projects: clone (committed state) or snapshot (working tree).' },
  provider: { type: 'string', valueName: 'ID', description: 'Provider for this run (default: configured default).' },
  model: { type: 'string', valueName: 'NAME', description: 'Model for this run.' },
  engine: { type: 'string', valueName: 'ENGINE', description: 'Agent engine: builtin (default) or fx (experimental, @appport/fx).' },
  'planner-provider': { type: 'string', valueName: 'ID', description: 'Planner provider for this run.' },
  'planner-model': { type: 'string', valueName: 'NAME', description: 'Planner model for this run.' },
  parallel: { type: 'string', valueName: 'N', description: 'Parallel agents (1-8).' },
  attempts: { type: 'string', valueName: 'N', description: 'Attempts per task before escalation (1-5).' },
  budget: { type: 'string', valueName: 'TOKENS', description: 'Token budget for the run.' },
  turns: { type: 'string', valueName: 'N', description: 'Tool turns per attempt.' },
  pax: { type: 'boolean', description: 'Collect PAX observations after verification.' },
  'no-pax': { type: 'boolean', description: 'Do not collect PAX observations.' },
  'pax-steps': { type: 'string', valueName: 'LIST', description: 'Comma-separated PAX steps (info,doctor,reality,drift,graph,test-plan,test).' },
  deploy: { type: 'boolean', description: 'Authorize a local preview of the result.' },
  stack: { type: 'string', valueName: 'IDS', description: 'New apps only: product stack components, comma-separated (AppPort is always included), e.g. feltdb or distribution. See: da-prompt stack' },
  'appport-exception': { type: 'string', valueName: 'REASON', description: 'New apps only: do not require an AppPort capability boundary, for the stated reason (recorded in the run).' },
  'allow-install': { type: 'boolean', description: 'Allow dependency installs (they run project scripts).' },
  'auto-apply': { type: 'boolean', description: 'Local directory runs: apply the result to your directory automatically when it is verified and ready.' },
  publish: { type: 'boolean', description: 'GitHub: push the run branch and open a PR when done (explicit authorization).' },
  output: { type: 'string', valueName: 'DIR', description: 'Also export the resulting project to a new folder.' },
  requirements: { type: 'string', valueName: 'TEXT', description: 'Extra requirements.' },
  stack: { type: 'string', valueName: 'TEXT', description: 'Stack / constraints.' },
  detach: { type: 'boolean', description: 'Start the run and return immediately (follow later with "runs follow").' },
  'wait-timeout': { type: 'string', valueName: 'SECONDS', description: 'Stop following after this long (the run keeps going); exit 7.' },
  'cancel-on-interrupt': { type: 'boolean', description: 'Ctrl-C cancels the run instead of just detaching.' },
  verbose: { type: 'boolean', short: 'v', description: 'Show agent messages and every tool call.' },
};

export async function startRun(ctx, { forceNew = false } = {}) {
  const { out, opts, args } = ctx;
  const task = args.join(' ').trim();
  if (!task) throw usageError('Describe the task: da-prompt run "what you want changed" --project <project>');
  if (opts.pax && opts['no-pax']) throw usageError('Use either --pax or --no-pax.');
  const client = await ctx.api();
  let source;
  if (forceNew || opts.new) {
    if (opts.project) throw usageError('--new and --project cannot be combined.');
  } else source = await projectFor(ctx, client);
  if (opts.publish && source?.mode !== 'github' && !(source?.mode === 'registered' && source.kind === 'remote')) throw usageError('--publish only applies to GitHub projects (local runs never push).');
  const settings = {};
  const set = (k, v) => v !== undefined && (settings[k] = v);
  set('maxParallel', num(opts.parallel, 'parallel', 1, 8));
  set('maxAttempts', num(opts.attempts, 'attempts', 1, 5));
  set('tokenBudget', num(opts.budget, 'budget', 10_000));
  set('maxAgentTurns', num(opts.turns, 'turns', 2, 200));
  if (opts.pax) settings.pax = true;
  if (opts['no-pax']) settings.pax = false;
  if (opts['pax-steps']) settings.paxSteps = opts['pax-steps'].split(',').map((s) => s.trim()).filter(Boolean);
  if (opts.deploy) settings.deploy = true;
  if (opts.stack !== undefined) {
    if (source) throw usageError('--stack only applies to new applications (--new); an existing project keeps its own stack.');
    settings.stack = opts.stack.split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (opts['appport-exception'] !== undefined) {
    if (source) throw usageError('--appport-exception only applies to new applications (--new).');
    if (!opts['appport-exception'].trim()) throw usageError('--appport-exception needs a reason.');
    settings.appportException = opts['appport-exception'];
  }
  const body = {
    idea: task,
    requirements: opts.requirements,
    stack: opts.stack,
    provider: opts.provider,
    model: opts.model,
    ...(opts.engine ? { engine: opts.engine } : {}),
    ...(opts['planner-provider'] || opts['planner-model'] ? { planner: { provider: opts['planner-provider'], model: opts['planner-model'] } } : {}),
    outputDir: opts.output,
    settings,
    ...(source ? { source: { ...(source.projectId ? { projectId: source.projectId } : { mode: source.mode }), directoryId: source.directoryId, repoUrl: source.repoUrl, ref: source.ref, workingMode: source.workingMode, publish: opts.publish || undefined, allowInstall: opts['allow-install'] || undefined, autoApply: opts['auto-apply'] || undefined } } : {}),
  };
  const { run } = await client.post('/api/runs', body, { timeoutMs: 120_000 });
  out.info(`Run ${run.id} started${source ? ` on ${source.label || source.directoryId || source.repoUrl}` : ' (new application)'} · ${run.provider}${run.model ? ` / ${run.model}` : ''}`);
  out.info(`Reconnect any time: da-prompt runs follow ${run.id}   ·   browser: ${client.url}/#/runs/${run.id}`);
  if (opts.detach) {
    out.data({ id: run.id, status: run.status, url: `${client.url}/#/runs/${run.id}` });
    out.print(run.id);
    return EXIT.OK;
  }
  return followRun(ctx, client, run.id, { from: 0, verbose: opts.verbose, waitTimeout: num(opts['wait-timeout'], 'wait-timeout'), cancelOnInterrupt: opts['cancel-on-interrupt'], tail: 0 });
}

/**
 * Follow a run until it reaches a terminal state. Ctrl-C detaches (the run keeps going on the backend) unless
 * --cancel-on-interrupt; a dropped connection is retried and resumes from the last event seen.
 */
export async function followRun(ctx, client, id, { from = 0, verbose = false, waitTimeout, cancelOnInterrupt = false, tail = 0 } = {}) {
  const { out } = ctx;
  let run = await getRun(client, id);
  const tty = Boolean(process.stdout.isTTY) && !out.json && !ctx.opts['no-color'];
  const progress = new Progress(out);
  progress.seed(run);
  let seq = from;
  if (tail > 0 || from === 0) {
    const h = await client.get(`/api/runs/${encodeURIComponent(id)}/log?${tail > 0 ? `tail=${tail}` : 'after=0'}`);
    for (const e of h.events) {
      progress.update(e);
      if (out.json) out.line(e);
      else for (const l of formatEvent(e, out, { verbose })) out.print(l);
    }
    seq = h.lastSeq;
    if (tail > 0 && h.total > h.events.length) out.info(out.dim(`(${h.total - h.events.length} earlier events not shown; see da-prompt runs logs ${id})`));
  }
  let final = TERMINAL.has(run.status) && !run.executing ? run : null;
  if (!final) {
    const ac = new AbortController();
    let how = null;
    const deadline = waitTimeout ? Date.now() + waitTimeout * 1000 : null;
    const onSigint = () => {
      if (cancelOnInterrupt && how !== 'cancel') {
        how = 'cancel';
        out.info('\nCancelling the run… (press Ctrl-C again to detach instead)');
        client.post(`/api/runs/${encodeURIComponent(id)}/cancel`).catch(() => {});
      } else {
        how = 'detach';
        ac.abort();
      }
    };
    process.on('SIGINT', onSigint);
    let maybeDone = false;
    const check = async () => {
      try {
        const r = await getRun(client, id);
        if (TERMINAL.has(r.status) && !r.executing) {
          final = r;
          ac.abort();
        }
      } catch {
        /* backend away: the stream will reconnect */
      }
    };
    const poll = setInterval(() => {
      if (deadline && Date.now() > deadline && !how) {
        how = 'timeout';
        ac.abort();
      } else if (maybeDone) check();
    }, 600);
    const slow = setInterval(check, 5000);
    const draw = tty ? setInterval(() => progress.draw(process.stdout), 500) : null;
    try {
      await client.follow(id, {
        after: seq,
        signal: ac.signal,
        onState: (s) => s === 'reconnecting' && out.info(out.dim('connection lost; reconnecting…')),
        onEvent: (e) => {
          if (tty) progress.clear(process.stdout);
          progress.update(e);
          if (out.json) out.line(e);
          else for (const l of formatEvent(e, out, { verbose })) out.print(l);
          if (e.type === 'run.status' && TERMINAL.has(e.status)) maybeDone = true;
          if (tty) progress.draw(process.stdout);
          return false;
        },
      });
    } finally {
      clearInterval(poll);
      clearInterval(slow);
      if (draw) clearInterval(draw);
      if (tty) progress.clear(process.stdout);
      process.off('SIGINT', onSigint);
    }
    if (!final && how === 'cancel') {
      for (let i = 0; i < 40 && !final; i++) {
        await sleep(500);
        await check();
      }
    }
    if (!final) {
      run = await getRun(client, id).catch(() => run);
      const code = how === 'timeout' ? EXIT.TIMEOUT : EXIT.INTERRUPTED;
      out.data({ id, status: run.status, executing: run.executing, followed: false, reason: how || 'disconnected' });
      out.print(out.yellow(`\n${how === 'timeout' ? 'Stopped waiting' : 'Detached'}: the run is still ${run.status.replace(/_/g, ' ')}${run.executing ? ' on the backend' : ''}.`));
      out.print(`  Follow again: da-prompt runs follow ${id}      Cancel: da-prompt runs cancel ${id}`);
      return code;
    }
  }
  const evidence = await getEvidence(client, id).catch(() => null);
  final = await getRun(client, id).catch(() => final);
  const summary = summaryOf(final, evidence);
  if (out.json) out.line({ type: 'result', exitCode: exitForRun(final), run: summary });
  else {
    out.print('');
    out.print(renderRunSummary(final, evidence, out));
  }
  return exitForRun(final);
}

// ── inspecting ──────────────────────────────────────────────────────────────────────────────────

async function list(ctx) {
  const { out, opts } = ctx;
  const byId = /^prj_[\w-]+$/.test(opts.project || '');
  const { runs } = await (await ctx.api()).get(`/api/runs${byId ? `?projectId=${opts.project}` : ''}`);
  let rows = runs;
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  if (opts.active) rows = rows.filter((r) => r.executing);
  if (opts.project && !byId) rows = rows.filter((r) => `${r.projectName || ''} ${r.source?.label || 'new'}`.toLowerCase().includes(opts.project.toLowerCase()));
  const limit = num(opts.limit, 'limit') ?? 20;
  const shown = rows.slice(0, limit);
  out.data({ total: rows.length, runs: shown.map((r) => ({ id: r.id, title: r.title, status: r.status, executing: r.executing, project: r.source ? `${r.source.mode}:${r.source.label}` : 'new', projectId: r.projectId || null, projectName: r.projectName || null, projectRemoved: r.projectRemoved || undefined, provider: r.provider, model: r.model, createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt, tasks: r.tasks, completedTasks: r.completedTasks, verdict: r.verdict || null, review: r.review || null, publication: r.publication || null, pax: r.pax || null })) });
  if (!shown.length) out.print('No runs match.');
  else out.print(table(shown, [{ title: 'id', key: 'id' }, { title: 'status', get: (r) => statusPaint(out, r.status) + (r.executing ? '*' : '') }, { title: 'project', get: (r) => r.projectName || (r.source ? r.source.label : 'new'), max: 22 }, { title: 'tasks', get: (r) => (r.tasks ? `${r.completedTasks}/${r.tasks}` : '—') }, { title: 'verified', get: (r) => (r.verdict || (r.checklistOk === undefined ? '—' : r.checklistOk ? 'checklist ok' : 'checklist fail')).replace(/-/g, ' '), max: 24 }, { title: 'age', get: (r) => ago(r.createdAt) }, { title: 'task', key: 'title', max: 42 }], out));
  if (rows.length > shown.length) out.print(out.dim(`… ${rows.length - shown.length} more (use --limit)`));
  return EXIT.OK;
}

async function show(ctx) {
  const client = await ctx.api();
  const run = await getRun(client, ctx.args[0]);
  const ev = await getEvidence(client, ctx.args[0]).catch(() => null);
  ctx.out.data(summaryOf(run, ev));
  ctx.out.print(renderRunSummary(run, ev, ctx.out));
  return EXIT.OK;
}

async function tasks(ctx) {
  const { out, opts } = ctx;
  const run = await getRun(await ctx.api(), ctx.args[0]);
  const rows = taskRows(run);
  out.data({ id: run.id, status: run.status, tasks: rows });
  if (!rows.length) {
    out.print('No plan yet.');
    return EXIT.OK;
  }
  if (opts.graph) {
    const levels = [...new Set(rows.map((t) => t.level ?? 0))].sort((a, b) => a - b);
    for (const l of levels) {
      const ts = rows.filter((t) => (t.level ?? 0) === l);
      out.print(`${out.dim(`level ${l}${ts.length > 1 ? ` · ${ts.length} in parallel` : ''}`)}`);
      for (const t of ts) out.print(`  ${t.id} [${t.role}] ${t.status}${t.dependsOn.length ? out.dim(`  ← ${t.dependsOn.join(', ')}`) : ''}`);
    }
  } else out.print(table(rows, [{ title: 'task', key: 'id' }, { title: 'role', key: 'role' }, { title: 'status', get: (t) => statusPaint(out, t.status) }, { title: 'tries', key: 'attempts' }, { title: 'after', get: (t) => t.dependsOn.join(',') || '—' }, { title: 'title', key: 'title', max: 44 }, { title: 'problem', get: (t) => t.error || '', max: 40 }], out));
  return EXIT.OK;
}

async function logs(ctx) {
  const { out, opts } = ctx;
  const client = await ctx.api();
  const id = ctx.args[0];
  const tail = num(opts.tail, 'tail');
  const h = await client.get(`/api/runs/${encodeURIComponent(id)}/log?${tail ? `tail=${tail}` : `after=${num(opts.since, 'since', 0) || 0}`}`);
  let events = h.events;
  if (opts.task) events = events.filter((e) => e.taskId === opts.task);
  if (opts.type) events = events.filter((e) => e.type === opts.type);
  if (out.json && !opts.follow) out.data({ id, total: h.total, events });
  else for (const e of events) {
    if (out.json) out.line(e);
    else for (const l of formatEvent(e, out, { verbose: opts.verbose })) out.print(l);
  }
  if (!opts.follow) return EXIT.OK;
  return followRun(ctx, client, id, { from: h.lastSeq, verbose: opts.verbose });
}

async function followCmd(ctx) {
  const client = await ctx.api();
  const tail = ctx.opts.tail === undefined ? 15 : num(ctx.opts.tail, 'tail', 0);
  return followRun(ctx, client, ctx.args[0], { from: 0, tail, verbose: ctx.opts.verbose, waitTimeout: num(ctx.opts['wait-timeout'], 'wait-timeout'), cancelOnInterrupt: ctx.opts['cancel-on-interrupt'] });
}

async function waitIdle(client, id, ms) {
  const end = Date.now() + ms;
  let r;
  while (Date.now() < end) {
    r = await getRun(client, id);
    if (!r.executing) return r;
    await sleep(400);
  }
  return r;
}

async function cancel(ctx) {
  const client = await ctx.api();
  const id = ctx.args[0];
  const before = await getRun(client, id);
  if (!before.executing) {
    ctx.out.data({ id, cancelled: false, status: before.status, reason: 'not-executing' });
    ctx.out.print(`Run ${id} is not executing (${before.status.replace(/_/g, ' ')}); nothing to cancel.`);
    return EXIT.OK;
  }
  await client.post(`/api/runs/${encodeURIComponent(id)}/cancel`);
  const run = await waitIdle(client, id, (num(ctx.opts.wait, 'wait') ?? 30) * 1000);
  const ok = !run.executing;
  ctx.out.data({ id, cancelled: ok && run.status === 'cancelled', status: run.status, executing: run.executing });
  ctx.out.print(ok ? `${ctx.out.yellow('○')} Run ${id} ${run.status === 'cancelled' ? 'cancelled' : `stopped (${run.status.replace(/_/g, ' ')})`}. Resume with: da-prompt runs resume ${id}` : ctx.out.red(`Cancellation requested but the run is still executing after ${ctx.opts.wait || 30}s.`));
  return ok ? EXIT.OK : EXIT.TIMEOUT;
}

async function control(ctx, path, body, verb) {
  const client = await ctx.api();
  const id = ctx.args[0];
  try {
    await client.post(`/api/runs/${encodeURIComponent(id)}/${path}`, body);
  } catch (e) {
    if (e.exitCode === EXIT.DENIED && /unknown task/.test(e.message)) throw new CliError(e.message, { code: EXIT.NOT_FOUND, hint: `Tasks: da-prompt runs tasks ${id}` });
    if (e.exitCode === EXIT.DENIED) throw new CliError(e.message, { code: EXIT.DENIED, hint: `Only ${[...RESUMABLE].join(', ')} runs can be ${verb}. See: da-prompt runs show ${id}` });
    throw e;
  }
  ctx.out.info(`${verb[0].toUpperCase()}${verb.slice(1)} run ${id}.`);
  if (ctx.opts.detach) {
    ctx.out.data({ id, accepted: true });
    return EXIT.OK;
  }
  return followRun(ctx, client, id, { from: 0, tail: 5, verbose: ctx.opts.verbose, waitTimeout: num(ctx.opts['wait-timeout'], 'wait-timeout'), cancelOnInterrupt: ctx.opts['cancel-on-interrupt'] });
}

/** Change a stopped run (or interrupt a running one) and optionally carry on. */
async function update(ctx) {
  const { opts } = ctx;
  const client = await ctx.api();
  const id = ctx.args[0];
  const n = (k) => (opts[k] === undefined ? undefined : num(opts[k], k));
  const settings = Object.fromEntries(Object.entries({ maxParallel: n('parallel'), maxAttempts: n('attempts'), maxAgentTurns: n('turns'), tokenBudget: n('budget') }).filter(([, v]) => v !== undefined));
  const body = {
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts['planner-provider'] || opts['planner-model'] ? { planner: { provider: opts['planner-provider'], model: opts['planner-model'] } } : {}),
    ...(opts.engine ? { engine: opts.engine } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
    ...(opts['allow-install'] ? { allowInstall: true } : {}),
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.interrupt ? { interrupt: true } : {}),
    ...(opts.resume ? { resume: true } : {}),
  };
  if (!Object.keys(body).filter((k) => !['interrupt', 'resume'].includes(k)).length) throw new CliError('Nothing to change.', { code: EXIT.USAGE, hint: 'Give at least one of --provider, --model, --planner-provider, --planner-model, --engine, --budget, --attempts, --parallel, --turns, --allow-install, --note.' });
  await client.patch(`/api/runs/${encodeURIComponent(id)}`, body);
  ctx.out.info(`Updated run ${id}${opts.resume ? ' and resumed it' : '. Resume it with: da-prompt runs resume ' + id}.`);
  if (!opts.resume || opts.detach) {
    ctx.out.data({ id, updated: true, resumed: Boolean(opts.resume) });
    return EXIT.OK;
  }
  return followRun(ctx, client, id, { from: 0, tail: 5, verbose: opts.verbose, waitTimeout: num(opts['wait-timeout'], 'wait-timeout'), cancelOnInterrupt: opts['cancel-on-interrupt'] });
}

/** A new run from an earlier one (same request, model and source), optionally with dependency installs allowed. */
async function rerun(ctx) {
  const client = await ctx.api();
  const id = ctx.args[0];
  const r = await client.post(`/api/runs/${encodeURIComponent(id)}/rerun`, ctx.opts['allow-install'] ? { allowInstall: true } : {});
  const fresh = r.run.id;
  ctx.out.info(`Started run ${fresh} from ${id}${ctx.opts['allow-install'] ? ' with dependency installs allowed' : ''}.`);
  if (ctx.opts.detach) {
    ctx.out.data({ id: fresh, from: id, accepted: true });
    return EXIT.OK;
  }
  return followRun(ctx, client, fresh, { from: 0, tail: 5, verbose: ctx.opts.verbose, waitTimeout: num(ctx.opts['wait-timeout'], 'wait-timeout'), cancelOnInterrupt: ctx.opts['cancel-on-interrupt'] });
}

async function files(ctx) {
  const { out } = ctx;
  const client = await ctx.api();
  const id = ctx.args[0];
  const run = await getRun(client, id);
  if (run.source?.baseSha) {
    const c = await client.get(`/api/runs/${encodeURIComponent(id)}/changes`);
    out.data({ id, additions: c.additions, deletions: c.deletions, files: c.files });
    if (!c.files.length) out.print('No files changed so far. The original project is untouched.');
    else {
      out.print(table(c.files, [{ title: '', key: 'status' }, { title: 'file', key: 'path', max: 70 }, { title: '+', get: (f) => (f.binary ? 'bin' : out.green(`+${f.additions}`)) }, { title: '−', get: (f) => (f.binary ? '' : out.red(`−${f.deletions}`)) }], out));
      out.print(out.dim(`${c.files.length} file(s), +${c.additions} −${c.deletions} against the baseline · diff: da-prompt runs diff ${id}`));
    }
  } else {
    const f = await client.get(`/api/runs/${encodeURIComponent(id)}/files`);
    out.data({ id, files: f.files });
    out.print(table(f.files, [{ title: 'file', key: 'path', max: 70 }, { title: 'size', get: (x) => bytes(x.size) }], out));
  }
  return EXIT.OK;
}

const paintDiff = (text, out) => text.split('\n').map((l) => (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? out.dim(l) : l.startsWith('@@') ? out.cyan(l) : l.startsWith('+') ? out.green(l) : l.startsWith('-') ? out.red(l) : l)).join('\n');

async function diff(ctx) {
  const { out, opts } = ctx;
  const client = await ctx.api();
  const id = ctx.args[0];
  let text;
  if (opts.file) text = (await client.get(`/api/runs/${encodeURIComponent(id)}/changes?path=${encodeURIComponent(opts.file)}`)).diff;
  else {
    const chunks = [];
    try {
      await client.download(`/api/runs/${encodeURIComponent(id)}/download/changes.patch`, { write: (c) => chunks.push(Buffer.from(c)), end: () => {}, on: () => {}, once: () => {}, emit: () => {} });
      text = Buffer.concat(chunks).toString('utf8');
    } catch (e) {
      if (e.exitCode !== EXIT.NOT_FOUND) throw e;
      const c = await client.get(`/api/runs/${encodeURIComponent(id)}/changes`);
      text = (await Promise.all(c.files.map(async (f) => (await client.get(`/api/runs/${encodeURIComponent(id)}/changes?path=${encodeURIComponent(f.path)}`)).diff))).join('\n');
    }
  }
  if (opts.out) {
    fs.writeFileSync(opts.out, text);
    out.data({ id, wrote: opts.out, bytes: Buffer.byteLength(text) });
    out.print(`Wrote ${opts.out} (${bytes(Buffer.byteLength(text))}). Apply it yourself with: git apply ${opts.out}`);
    return EXIT.OK;
  }
  out.data({ id, diff: text });
  out.always(text.trim() ? paintDiff(text, out) : 'No changes.');
  return EXIT.OK;
}

async function report(ctx) {
  const client = await ctx.api();
  const r = await client.raw('GET', `/api/runs/${encodeURIComponent(ctx.args[0])}/report`);
  if (r.status !== 200) throw new CliError(typeof r.data === 'string' ? r.data : r.data?.error || 'report not available', { code: r.status === 404 ? EXIT.NOT_FOUND : EXIT.FAILED });
  if (ctx.opts.out) {
    fs.writeFileSync(ctx.opts.out, r.text);
    ctx.out.data({ id: ctx.args[0], wrote: ctx.opts.out });
    ctx.out.print(`Wrote ${ctx.opts.out}`);
  } else {
    ctx.out.data({ id: ctx.args[0], report: r.text });
    ctx.out.always(r.text);
  }
  return EXIT.OK;
}

export function renderEvidence(ev, out) {
  const L = [];
  L.push(out.bold(`AGENT CLAIMS`) + out.dim('  — what the agents said. Not evidence that anything works.'));
  for (const c of ev.agent.claims) L.push(`  ${c.taskId} (${c.role}, ${c.attempts} attempt${c.attempts === 1 ? '' : 's'}): “${c.summary}”`);
  if (!ev.agent.claims.length) L.push('  (no agent has reported a result)');
  const f = ev.factory;
  L.push('', out.bold('FACTORY VERIFICATION') + out.dim('  — commands the factory ran itself, with their real exit status.') + (f.verdict ? `  verdict: ${f.verdict.replace(/-/g, ' ')}` : ''));
  if (f.baseline.length) {
    L.push('  baseline (before any change):');
    for (const b of f.baseline) L.push(`    ${b.status === 'passed' ? out.green('✓') : out.red('✗')} ${b.command} → ${b.status}${b.limitation ? ` (${b.limitation})` : ''}`);
  }
  L.push(f.final.length ? '  at the end of the run:' : '  (no end-of-run check results on record)');
  for (const v of f.final) L.push(`    ${v.ok ? out.green('✓') : out.red('✗')} ${v.command} → ${v.state} (exit ${v.exitCode})${v.newFailures?.length ? `\n        new failures: ${v.newFailures.slice(0, 3).join(' | ')}` : ''}`);
  for (const t of f.tasks) if (t.checks.length) L.push(`  task ${t.taskId} [${t.status}]: ${t.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.command}`).join('  ')}`);
  for (const c of f.checklist) L.push(`  ${c.ok ? out.green('✓') : out.red('✗')} ${c.label || c.id}${c.state && !['pass', 'fail'].includes(c.state) ? ` (${c.state})` : ''}`);
  L.push('', out.bold('PAX OBSERVATION') + out.dim('  — what PAX observed. Never part of the verdict.') + `  state: ${ev.pax.state}`);
  if (ev.pax.binary?.version) L.push(`  PAX ${ev.pax.binary.version} (${ev.pax.binary.source === 'configured' ? 'configured path' : 'from PATH'})${ev.pax.binary.path ? ` ${ev.pax.binary.path}` : ''}`);
  if (ev.pax.message) L.push(`  ${out.yellow(ev.pax.message)}`);
  for (const s of ev.pax.steps || []) L.push(`  ${['observed', 'no-drift', 'planned', 'passed'].includes(s.outcome) ? out.green('•') : ['drift-detected', 'failed'].includes(s.outcome) ? out.yellow('•') : out.red('•')} ${s.title}: ${s.outcome}${s.exitCode != null ? ` (exit ${s.exitCode})` : ''} — ${s.detail}${(s.artifacts || []).length ? out.dim(`  [${s.artifacts.map((a) => a.name).join(', ')}]`) : ''}`);
  if (ev.pax.state === 'not-requested') L.push('  (not requested for this run; collect with: da-prompt pax verify <run>)');
  if (ev.missing.length || ev.notes.length) L.push('', out.bold('MISSING OR DISAGREEING'));
  for (const m of ev.missing) L.push(`  ${out.yellow('!')} missing: ${m}`);
  for (const n of ev.notes) L.push(`  ${out.yellow('!')} ${n}`);
  return L.join('\n');
}

async function evidence(ctx) {
  const { out, opts } = ctx;
  const ev = await getEvidence(await ctx.api(), ctx.args[0]);
  out.data({ evidence: ev });
  out.always(renderEvidence(ev, out));
  const good = ['verified', 'verified-with-preexisting-failures'].includes(ev.factory.verdict) || (ev.factory.verdict === null && ev.factory.checklist.every((c) => c.ok));
  if (opts.strict && (!good || ev.missing.length)) return EXIT.FAILED;
  return EXIT.OK;
}

async function tests(ctx) {
  const { out, opts } = ctx;
  const client = await ctx.api();
  const id = ctx.args[0];
  if (opts.run) return verify(ctx);
  const [run, ev] = await Promise.all([getRun(client, id), getEvidence(client, id)]);
  const f = ev.factory;
  out.data({ id, verdict: f.verdict, baseline: f.baseline, final: f.final, reverify: run.reverify || null });
  out.print(out.bold('Baseline → result (the factory\'s own checks)'));
  const cmds = [...new Set([...f.baseline.map((b) => b.command), ...f.final.map((v) => v.command)])];
  for (const c of cmds) {
    const b = f.baseline.find((x) => x.command === c);
    const v = f.final.find((x) => x.command === c);
    out.print(`  ${v ? (v.state === 'preexisting' ? out.yellow('!') : v.ok ? out.green('✓') : out.red('✗')) : out.dim('–')} ${c}\n      baseline: ${b ? b.status : 'none'}   result: ${v ? `${v.state} (exit ${v.exitCode})` : 'not run'}${v?.state === 'preexisting' ? '   (already failing or not runnable before the change; not caused by it)' : ''}${v?.newFailures?.length ? `\n      new failures: ${v.newFailures.slice(0, 3).join(' | ')}` : ''}`);
  }
  if (!cmds.length) out.print('  No checks were run for this run, so there is nothing to compare. This run is not verified.');
  if (run.reverify) {
    out.print('', );
    out.print(out.bold(`Re-checked ${ago(run.reverify.at)}`) + out.dim(' (separate from the recorded verdict)'));
    for (const r of run.reverify.results) out.print(`  ${r.ok ? out.green('✓') : out.red('✗')} ${r.command} → ${r.state}`);
  }
  out.print(out.dim(`\nRe-run the checks now: da-prompt runs tests ${id} --run`));
  return EXIT.OK;
}

async function verify(ctx) {
  const { out } = ctx;
  const client = await ctx.api();
  const id = ctx.args[0];
  out.info('Running the run\'s checks in its workspace (this can take a while)…');
  const { run } = await client.post(`/api/runs/${encodeURIComponent(id)}/verify`, {}, { timeoutMs: 900_000 });
  const res = run.reverify.results;
  const bad = res.filter((r) => !r.ok);
  out.data({ id, ok: bad.length === 0, results: res.map(({ command, state, ok, exitCode, durationMs, newFailures }) => ({ command, state, ok, exitCode, durationMs, newFailures })) });
  for (const r of res) {
    out.print(`${r.ok ? out.green('✓') : out.red('✗')} ${r.command} → ${r.state} (exit ${r.exitCode}, ${r.durationMs}ms)`);
    if (!r.ok && r.output) out.print(out.dim(r.output.split('\n').slice(-12).map((l) => `    ${l}`).join('\n')));
  }
  out.print(bad.length ? out.red(`\n${bad.length} check(s) did not pass.`) : out.green('\nAll checks passed in the run\'s workspace now.'));
  return bad.length ? EXIT.FAILED : EXIT.OK;
}

async function artifacts(ctx) {
  const { out, opts } = ctx;
  const client = await ctx.api();
  const id = ctx.args[0];
  const a = await client.get(`/api/runs/${encodeURIComponent(id)}/artifacts`);
  if (opts.get) {
    const all = [...a.delivery.map((x) => ({ ...x, path: x.name })), ...a.pax.map((x) => ({ ...x, path: `pax/${x.name}` }))];
    const hit = all.find((x) => x.name === opts.get || x.path === opts.get);
    if (!hit) throw new CliError(`No artifact named "${opts.get}".`, { code: EXIT.NOT_FOUND, hint: `Available: ${all.map((x) => x.path).join(', ')}` });
    const dest = opts.out || hit.name;
    await client.download(`/api/runs/${encodeURIComponent(id)}/download/${hit.path}`, fs.createWriteStream(dest));
    out.data({ id, saved: dest, artifact: hit.path });
    out.print(`Saved ${hit.path} → ${dest}`);
    return EXIT.OK;
  }
  out.data({ id, ...a });
  out.print(table([...a.delivery.map((x) => ({ kind: 'delivery', name: x.name, bytes: x.bytes, label: x.label })), ...a.pax.map((x) => ({ kind: 'pax evidence', name: `pax/${x.name}`, bytes: x.bytes, label: x.sha256 ? `sha256 ${x.sha256.slice(0, 12)}…` : '' }))], [{ title: 'kind', key: 'kind' }, { title: 'name', key: 'name', max: 40 }, { title: 'size', get: (x) => bytes(x.bytes) }, { title: 'note', key: 'label', max: 40 }], out) || 'No artifacts yet.');
  out.print(out.dim(`Download one: da-prompt runs artifacts ${id} --get <name> [--out <file>]`));
  return EXIT.OK;
}

async function review(ctx) {
  const { out, opts, args } = ctx;
  const [id, decision] = args;
  if (!['approve', 'reject', 'clear'].includes(decision)) throw usageError('Usage: da-prompt runs review <run-id> approve|reject|clear [--note TEXT]');
  const client = await ctx.api();
  const { run } = await client.post(`/api/runs/${encodeURIComponent(id)}/review`, { decision, note: opts.note || '' });
  out.data({ id, review: run.review || null, files: run.changes?.files.length });
  if (decision === 'clear') out.print(`${out.yellow('○')} Decision withdrawn for ${id}.`);
  else out.print(`${decision === 'approve' ? out.green('✓') : out.yellow('✗')} ${run.review.decision} ${run.review.files} file(s) of run ${id}${run.review.note ? ` — “${run.review.note}”` : ''}. ${decision === 'approve' ? 'The approval covers exactly these changes; apply/publish are still separate commands.' : 'Apply and publish stay blocked.'}`);
  if (decision === 'approve') for (const n of nextActions(run).filter((x) => /apply|publish/.test(x.cmd))) out.print(`  ${n.cmd}   ${out.dim(`# ${n.why}`)}`);
  return EXIT.OK;
}

async function apply(ctx) {
  const { out, opts } = ctx;
  const client = await ctx.api();
  const id = ctx.args[0];
  const run = await getRun(client, id);
  if (!run.source) throw new CliError('This run built a new application; there is nothing to apply. Download it with: da-prompt runs artifacts ' + id, { code: EXIT.USAGE });
  if (run.source.mode !== 'local') throw new CliError('Only local-directory runs can be applied. For GitHub runs use: da-prompt runs publish ' + id, { code: EXIT.USAGE });
  if (!opts.approve && run.review?.decision !== 'approved') throw new CliError(`Run ${id} has not been approved${run.review ? ` (it was ${run.review.decision})` : ''}.`, { code: EXIT.DENIED, hint: `Review it first: da-prompt runs diff ${id} && da-prompt runs review ${id} approve — or approve and apply in one step: da-prompt runs apply ${id} --approve --yes` });
  const n = run.changes?.files.length || 0;
  const mode = opts.branch ? 'branch' : 'working-tree';
  const lead = opts.approve && run.review?.decision !== 'approved' ? 'Approve these exact changes and ' : '';
  const msg = mode === 'branch' ? `${lead}${lead ? 'a' : 'A'}dd the run's work to your repository as the branch da-prompt/${id} (nothing is checked out)?` : `${lead}${lead ? 'w' : 'W'}rite ${n} file(s) into your directory "${run.source.label}"? Nothing is staged or committed, and nothing is written if any of them changed since the run started.`;
  if (!(await confirm(ctx, msg))) {
    out.print('Not applied.');
    return EXIT.OK;
  }
  try {
    const r = await client.post(`/api/runs/${encodeURIComponent(id)}/apply`, { mode, approve: opts.approve === true });
    out.data({ id, applied: true, mode, files: r.run.delivery.local?.applied?.files, branch: r.run.delivery.local?.branch });
    out.print(mode === 'branch' ? `${out.green('✓')} Branch ${r.run.delivery.local.branch.branch} added to your repository (${r.run.delivery.local.branch.sha.slice(0, 10)}).` : `${out.green('✓')} Applied ${r.run.delivery.local.applied.files.length} file(s). Review with git status / git diff; nothing was staged or committed.`);
  } catch (e) {
    if (e.details?.conflicts) {
      out.data({ id, applied: false, conflicts: e.details.conflicts });
      out.print(out.red(e.message));
      for (const c of e.details.conflicts) out.print(`  ${c.path} — ${c.reason}`);
      out.print(out.dim('Nothing was written. Reconcile those files in your directory, or apply the patch by hand: da-prompt runs diff <run> --out changes.patch'));
      return EXIT.DENIED;
    }
    throw e;
  }
  return EXIT.OK;
}

async function publish(ctx) {
  const { out, opts } = ctx;
  const client = await ctx.api();
  const id = ctx.args[0];
  const run = await getRun(client, id);
  if (run.source?.mode !== 'github') throw new CliError('Only GitHub-backed runs can be published (local runs never push).', { code: EXIT.USAGE });
  if (run.review?.decision !== 'approved') throw new CliError(`Run ${id} has not been approved${run.review ? ` (it was ${run.review.decision})` : ''}.`, { code: EXIT.DENIED, hint: `Review it first: da-prompt runs diff ${id} && da-prompt runs review ${id} approve` });
  const repo = run.source.repo ? `${run.source.repo.owner}/${run.source.repo.name}` : run.source.label;
  const pr = !opts['no-pr'];
  if (!(await confirm(ctx, `Push the branch ${run.source.branch} to ${repo}${pr ? ` and open a pull request against ${run.source.baseBranch || 'the base branch'}` : ' (no pull request)'}? Only the run branch is pushed, never forced; nothing is merged or deployed.`))) {
    out.print('Not published.');
    return EXIT.OK;
  }
  const { run: after } = await client.post(`/api/runs/${encodeURIComponent(id)}/publish`, { pullRequest: pr }, { timeoutMs: 300_000 });
  const p = after.delivery.publication;
  out.data({ id, publication: { state: p.state, branch: p.branch, sha: p.sha, pr: p.pr || null, error: p.error || null, prError: p.prError || null } });
  if (p.state === 'failed') {
    if (out.json) return EXIT.FAILED;
    throw new CliError(`Publishing failed${p.step ? ` (${p.step})` : ''}: ${p.error}`, { code: EXIT.FAILED, hint: /TOKEN/.test(p.error || '') ? 'Add a token: printf %s "$GITHUB_TOKEN" | da-prompt config set githubToken --stdin' : `Nothing was merged. Retry with: da-prompt runs publish ${id}` });
  }
  out.print(`${out.green('✓')} Pushed ${p.branch}${p.sha ? ` @ ${p.sha.slice(0, 10)}` : ''}`);
  if (p.pr) out.print(`${out.green('✓')} Pull request #${p.pr.number}${p.pr.draft ? ' (draft)' : ''}: ${p.pr.url}`);
  if (p.prError) {
    out.print(out.yellow(`! ${p.prError}`));
    return EXIT.FAILED;
  }
  return EXIT.OK;
}

async function del(ctx) {
  if (!(await confirm(ctx, `Delete run ${ctx.args[0]} with its workspace and delivery files? Your project is not affected.`))) return EXIT.OK;
  await (await ctx.api()).del(`/api/runs/${encodeURIComponent(ctx.args[0])}`);
  ctx.out.data({ id: ctx.args[0], deleted: true });
  ctx.out.print(`Deleted ${ctx.args[0]}.`);
  return EXIT.OK;
}

const follow = { 'wait-timeout': RUN_OPTIONS['wait-timeout'], 'cancel-on-interrupt': RUN_OPTIONS['cancel-on-interrupt'], verbose: RUN_OPTIONS.verbose, detach: RUN_OPTIONS.detach };

export default [
  { path: ['run'], summary: 'Start a task on a project and follow it to the end.', description: 'The run executes on the local backend, so it survives closing the terminal: Ctrl-C only detaches (use --cancel-on-interrupt to cancel). Exit code: 0 completed and verified by the factory · 6 needs attention · 1 failed · 8 cancelled · 7 --wait-timeout · 130 detached.', args: '"<task>"', minArgs: 1, maxArgs: 200, options: RUN_OPTIONS, examples: ['da-prompt run "Add password reset" --project my-app', 'da-prompt run "Fix the flaky test in auth" --project . --pax --detach', 'da-prompt run "Add rate limiting" --project acme/api --ref develop --publish', 'da-prompt run "A habit tracker" --new --output ~/projects/habits'], run: (c) => startRun(c) },
  { path: ['runs', 'list'], summary: 'List runs.', options: { status: { type: 'string', valueName: 'STATUS', description: 'completed, needs_attention, failed, cancelled, running…' }, active: { type: 'boolean', description: 'Only executing runs.' }, project: { type: 'string', valueName: 'TEXT', description: 'Project name contains.' }, limit: { type: 'string', valueName: 'N', description: 'How many (default 20).' } }, run: list },
  { path: ['runs', 'show'], summary: 'Everything about one run: tasks, verification, delivery, next steps.', args: '<run-id>', minArgs: 1, run: show },
  { path: ['runs', 'tasks'], summary: 'The task graph and each task\'s status.', args: '<run-id>', minArgs: 1, options: { graph: { type: 'boolean', description: 'Group by dependency level.' } }, run: tasks },
  { path: ['runs', 'logs'], summary: 'The run\'s event history.', args: '<run-id>', minArgs: 1, options: { tail: { type: 'string', valueName: 'N', description: 'Last N events.' }, since: { type: 'string', valueName: 'SEQ', description: 'Events after this sequence number.' }, task: { type: 'string', valueName: 'ID', description: 'Only this task.' }, type: { type: 'string', valueName: 'TYPE', description: 'Only this event type (verify, feedback, escalation, pax…).' }, follow: { type: 'boolean', short: 'f', description: 'Keep following live events.' }, verbose: RUN_OPTIONS.verbose }, run: logs },
  { path: ['runs', 'follow'], summary: 'Watch a run live; reconnect after a disconnect.', args: '<run-id>', minArgs: 1, options: { ...follow, tail: { type: 'string', valueName: 'N', description: 'History lines shown first (default 15).' } }, run: followCmd },
  { path: ['runs', 'cancel'], summary: 'Cancel an executing run.', args: '<run-id>', minArgs: 1, options: { wait: { type: 'string', valueName: 'SECONDS', description: 'How long to wait for it to stop (default 30).' } }, run: cancel },
  { path: ['runs', 'update'], summary: 'Change a stopped run (provider, model, engine, limits, a note to the agents) and optionally resume it.', args: '<run-id>', minArgs: 1, options: { ...follow, provider: RUN_OPTIONS.provider, model: RUN_OPTIONS.model, 'planner-provider': RUN_OPTIONS['planner-provider'], 'planner-model': RUN_OPTIONS['planner-model'], engine: RUN_OPTIONS.engine, budget: RUN_OPTIONS.budget, attempts: RUN_OPTIONS.attempts, parallel: RUN_OPTIONS.parallel, turns: RUN_OPTIONS.turns, 'allow-install': RUN_OPTIONS['allow-install'], note: { type: 'string', valueName: 'TEXT', description: 'A note added to the agents\' prompt as the newest instruction.' }, interrupt: { type: 'boolean', description: 'Stop the run first if it is still executing.' }, resume: { type: 'boolean', description: 'Continue the run right after saving.' } }, run: update },
  { path: ['runs', 'rerun'], summary: 'Start a new run from an earlier one (same request, model, settings and stack or project).', args: '<run-id>', minArgs: 1, options: { ...follow, 'allow-install': RUN_OPTIONS['allow-install'] }, run: rerun },
  { path: ['runs', 'resume'], summary: 'Continue a stopped, interrupted or cancelled run.', args: '<run-id>', minArgs: 1, options: follow, run: (c) => control(c, 'resume', {}, 'resumed') },
  { path: ['runs', 'retry'], summary: 'Retry an escalated task with a fresh set of attempts.', args: '<run-id> <task-id>', minArgs: 2, options: { description: { type: 'string', valueName: 'TEXT', description: 'Replace the task spec first.' }, verify: { type: 'string', multiple: true, valueName: 'CMD', description: 'Replace the verify commands (repeatable).' }, ...follow }, run: (c) => control({ ...c, args: [c.args[0]] }, `tasks/${encodeURIComponent(c.args[1])}/retry`, { description: c.opts.description, verify: c.opts.verify }, 'retried') },
  { path: ['runs', 'skip'], summary: 'Skip an escalated task and continue.', args: '<run-id> <task-id>', minArgs: 2, options: follow, run: (c) => control({ ...c, args: [c.args[0]] }, `tasks/${encodeURIComponent(c.args[1])}/skip`, {}, 'continued') },
  { path: ['runs', 'files'], summary: 'Files changed by a run.', args: '<run-id>', minArgs: 1, run: files },
  { path: ['runs', 'diff'], summary: 'The changes a run made (separate from applying them).', args: '<run-id>', minArgs: 1, options: { file: { type: 'string', valueName: 'PATH', description: 'Only this file.' }, out: { type: 'string', valueName: 'FILE', description: 'Write the patch to a file instead.' } }, run: diff },
  { path: ['runs', 'tests'], summary: 'Baseline vs result of the factory\'s own checks; --run re-runs them.', args: '<run-id>', minArgs: 1, options: { run: { type: 'boolean', description: 'Run the checks again in the run\'s workspace.' } }, run: tests },
  { path: ['runs', 'verify'], summary: 'Re-run the run\'s checks in its workspace (recorded apart from the verdict).', args: '<run-id>', minArgs: 1, run: verify },
  { path: ['runs', 'report'], summary: 'The factory report (markdown).', args: '<run-id>', minArgs: 1, options: { out: { type: 'string', valueName: 'FILE', description: 'Save to a file.' } }, run: report },
  { path: ['runs', 'evidence'], summary: 'Agent claims, factory verification and PAX observations — shown separately.', args: '<run-id>', minArgs: 1, options: { strict: { type: 'boolean', description: 'Exit 1 unless the factory verified the run with nothing missing.' } }, run: evidence },
  { path: ['runs', 'artifacts'], summary: 'List or download a run\'s artifacts (report, patch, archive, PAX evidence).', args: '<run-id>', minArgs: 1, options: { get: { type: 'string', valueName: 'NAME', description: 'Download this artifact.' }, out: { type: 'string', valueName: 'FILE', description: 'Where to save it.' } }, run: artifacts },
  { path: ['runs', 'review'], summary: 'Approve, reject or clear your decision about the run\'s exact changes.', args: '<run-id> approve|reject|clear', minArgs: 2, options: { note: { type: 'string', valueName: 'TEXT', description: 'Why.' } }, run: review },
  { path: ['runs', 'apply'], summary: 'Write approved changes into your local directory (or add them as a branch).', args: '<run-id>', minArgs: 1, options: { branch: { type: 'boolean', description: 'Add the work as a branch in your repository instead.' }, approve: { type: 'boolean', description: 'Approve these exact changes and apply them in one step (skips the separate review).' }, yes: { type: 'boolean', description: 'Confirm without prompting.' } }, run: apply },
  { path: ['runs', 'publish'], summary: 'Push the approved run branch and open a pull request (GitHub runs).', args: '<run-id>', minArgs: 1, options: { 'no-pr': { type: 'boolean', description: 'Push the branch only.' }, yes: { type: 'boolean', description: 'Confirm without prompting.' } }, run: publish },
  { path: ['runs', 'delete'], summary: 'Delete a run, its workspace and delivery files.', args: '<run-id>', minArgs: 1, options: { yes: { type: 'boolean', description: 'Confirm without prompting.' } }, run: del },
];
