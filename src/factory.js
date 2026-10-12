// The operator: runs the software factory end-to-end.
// Layer 1 plan → 2 agents → 3 execution (parallel, per-task subgraphs) → 4 artifacts →
// 5 verification → 6 feedback (retry ×3, escalate, record lessons) → 7 completion → deliver.

import path from 'node:path';
import { Workspace } from './sandbox.js';
import { normalizeInputs } from './prompt.js';
import { readyTasks, propagateBlocked, dependentsOf, levels, DONE_STATES } from './graph.js';
import { runPlanner, runAgent, writeSummary, BudgetError } from './agents.js';
import { scanWorkspace, redact } from './security.js';
import { ProviderRegistry } from './providers/registry.js';
import { packageDelivery, pushToGit } from './deliver.js';

export const LAYERS = ['plan', 'agents', 'execution', 'artifacts', 'verification', 'feedback', 'completion'];
const ACTIVE = new Set(['queued', 'planning', 'running', 'completing']);
const RESUMABLE = new Set(['needs_attention', 'interrupted', 'failed', 'cancelled']);

export class Factory {
  constructor({ cfg, store, previews }) {
    this.cfg = cfg;
    this.store = store;
    this.previews = previews;
    this.active = new Map(); // runId -> { controller, promise }
    this.providers = new ProviderRegistry(cfg);
    // cfg.providerFactory lets tests inject a provider instance.
    this.makeProvider = (run) =>
      cfg.providerFactory?.(run.provider, cfg, run) ||
      this.providers.create(run.provider, { model: run.model, plannerModel: run.plannerModel, options: run.providerOptions });
  }

  /** Mark runs that were mid-flight when the process stopped so they can be resumed. */
  async recover() {
    for (const r of await this.store.list()) {
      if (!ACTIVE.has(r.status)) continue;
      const run = await this.store.load(r.id);
      run.status = 'interrupted';
      for (const t of run.plan?.tasks || []) if (t.status === 'running') t.status = 'pending';
      await this.store.save(run);
      this.store.event(run.id, 'run.status', { status: run.status, note: 'server restarted; resume to continue' });
    }
  }

  async createRun(body = {}) {
    const inputs = normalizeInputs(body);
    const choice = await this.resolveModelChoice(body);
    const d = this.cfg.defaults;
    const s = body.settings || {};
    const clamp = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : def);
    const settings = {
      maxParallel: clamp(s.maxParallel, 1, 8, d.maxParallel),
      maxAttempts: clamp(s.maxAttempts, 1, 5, d.maxAttempts),
      maxAgentTurns: clamp(s.maxAgentTurns, 2, 200, d.maxAgentTurns),
      tokenBudget: clamp(s.tokenBudget, 10_000, 50_000_000, d.tokenBudget),
      timeoutMinutes: clamp(s.timeoutMinutes, 1, 24 * 60, 120),
      commandTimeoutMs: d.commandTimeoutMs,
      deploy: s.deploy !== false,
    };
    const repoUrl = typeof body.repoUrl === 'string' && body.repoUrl.trim() ? body.repoUrl.trim() : null;
    if (repoUrl && !/^https:\/\/[^\s]+$/.test(repoUrl)) throw new Error('repoUrl must be an https:// git URL');
    const id = this.store.newId();
    const run = {
      id,
      title: inputs.idea.split('\n')[0].slice(0, 90),
      createdAt: new Date().toISOString(),
      status: 'queued',
      provider: choice.provider,
      providerLabel: choice.label,
      model: choice.model,
      plannerModel: choice.plannerModel,
      providerOptions: choice.options,
      inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, redact(v)])),
      settings,
      repoUrl,
      layers: Object.fromEntries(LAYERS.map((l) => [l, 'pending'])),
      plan: null,
      usage: { input: 0, output: 0, calls: 0 },
      lessons: [],
      checklist: [],
    };
    await this.store.create(run);
    this.store.event(id, 'run.created', { title: run.title, provider: run.provider, model: run.model, plannerModel: run.plannerModel, settings });
    if (choice.provider !== 'offline') this.providers.remember(choice.provider, choice.model);
    return run;
  }

  /** Validate the requested provider/model, filling in discovered defaults. */
  async resolveModelChoice(body = {}) {
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : '');
    let providerId = str(body.provider);
    let model = str(body.model);
    let plannerModel = str(body.plannerModel);
    if (!providerId) {
      providerId = (await this.providers.discover()).defaultProvider;
      if (!model && this.cfg.defaultProvider === providerId) model = this.cfg.defaultModel;
    }
    let spec;
    try {
      spec = this.providers.get(providerId);
    } catch (err) {
      if (!this.cfg.providerFactory) throw err;
      spec = { id: providerId, label: providerId, type: 'injected' };
    }
    if (spec.type === 'offline') {
      model = 'offline-template-agent';
      plannerModel = model;
    } else if (!model && spec.type !== 'injected') {
      const probe = await this.providers.probe(spec);
      if (probe.status !== 'ready') throw new Error(`${spec.label} is not ready: ${probe.message || probe.status}`);
      model = probe.defaultModel;
      if (!model) throw new Error(`${spec.label} has no models available`);
    }
    if (!plannerModel && providerId === this.cfg.defaultProvider && this.cfg.defaultPlannerModel) plannerModel = this.cfg.defaultPlannerModel;
    const o = body.providerOptions || {};
    const options = {};
    if (Number(o.numCtx) > 0) options.numCtx = Math.max(2048, Math.min(1_048_576, Math.round(Number(o.numCtx))));
    if (o.temperature !== undefined && o.temperature !== '' && Number.isFinite(Number(o.temperature))) options.temperature = Math.max(0, Math.min(2, Number(o.temperature)));
    if (['auto', 'native', 'json'].includes(o.toolMode)) options.toolMode = o.toolMode;
    const choice = { provider: providerId, label: spec.label, model: model || 'default', plannerModel: plannerModel || model || 'default', options };
    this.makeProvider(choice); // fail fast: missing key, disabled provider, missing model
    return choice;
  }

  isActive(id) {
    return this.active.has(id);
  }

  /** Start (or resume) the execution loop for a run in the background. */
  start(id) {
    if (this.active.has(id)) return this.active.get(id).promise;
    const controller = new AbortController();
    const promise = this.execute(id, controller).finally(() => this.active.delete(id));
    this.active.set(id, { controller, promise });
    return promise;
  }

  async resume(id) {
    const run = await this.store.load(id);
    if (this.active.has(id)) return run;
    if (!RESUMABLE.has(run.status) && run.status !== 'queued') throw new Error(`run is ${run.status}; nothing to resume`);
    for (const t of run.plan?.tasks || []) {
      if (t.status === 'blocked' || t.status === 'cancelled' || t.status === 'running') {
        t.status = 'pending';
        delete t.blockedBy;
      }
    }
    await this.store.save(run);
    this.start(id);
    return run;
  }

  async cancel(id) {
    const a = this.active.get(id);
    if (a) a.controller.abort();
    this.previews.stop(id);
    return Boolean(a);
  }

  /** Escalation option: retry a task (optionally with an edited spec). */
  async retryTask(id, taskId, edits = {}) {
    if (this.active.has(id)) throw new Error('run is still executing; wait for it to stop or cancel it first');
    const run = await this.store.load(id);
    const task = run.plan?.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (typeof edits.description === 'string' && edits.description.trim()) task.description = edits.description.trim();
    if (Array.isArray(edits.verify)) task.verify = edits.verify.filter((v) => typeof v === 'string' && v.trim());
    if (Array.isArray(edits.acceptance) && edits.acceptance.length) task.acceptance = edits.acceptance.filter((v) => typeof v === 'string' && v.trim());
    task.status = 'pending';
    task.attemptBase = task.attempts.length; // fresh budget of attempts
    delete task.escalation;
    delete task.error;
    for (const d of dependentsOf(run.plan.tasks, taskId)) {
      const t = run.plan.tasks.find((x) => x.id === d);
      if (t.status === 'blocked') {
        t.status = 'pending';
        delete t.blockedBy;
      }
    }
    await this.store.save(run);
    this.store.event(id, 'escalation.resolved', { taskId, action: 'retry', edited: Object.keys(edits) });
    return this.resume(id);
  }

  /** Escalation option: skip a task and let its dependents run. */
  async skipTask(id, taskId) {
    if (this.active.has(id)) throw new Error('run is still executing; wait for it to stop or cancel it first');
    const run = await this.store.load(id);
    const task = run.plan?.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (task.status === 'completed') throw new Error('task already completed');
    task.status = 'skipped';
    delete task.escalation;
    await this.store.save(run);
    this.store.event(id, 'escalation.resolved', { taskId, action: 'skip' });
    return this.resume(id);
  }

  // ---------------------------------------------------------------------------------------------

  async execute(id, controller) {
    const { signal } = controller;
    let run = await this.store.load(id);
    const ws = new Workspace(this.store.workspaceDir(id));
    const save = () => this.store.save(run);
    const emit = (type, data) => this.store.event(id, type, data);
    const setStatus = async (status, extra = {}) => {
      run.status = status;
      await save();
      emit('run.status', { status, ...extra });
    };
    const layer = async (name, state) => {
      if (run.layers[name] === state) return;
      run.layers[name] = state;
      await save();
      emit('layer', { layer: name, state });
    };
    const provider = this.makeProvider(run);
    const track = {
      check: () => {
        const used = run.usage.input + run.usage.output;
        if (used >= run.settings.tokenBudget) throw new BudgetError(`token budget exhausted (${used} / ${run.settings.tokenBudget})`);
      },
      add: (u = {}) => {
        run.usage.input += u.input_tokens || 0;
        run.usage.output += u.output_tokens || 0;
        run.usage.calls += 1;
      },
    };
    const timer = setTimeout(() => controller.abort(new Error('time limit reached')), run.settings.timeoutMinutes * 60_000);
    run.startedAt ||= new Date().toISOString();
    delete run.error;

    try {
      // ── Layer 1: plan ────────────────────────────────────────────────────────────────────
      if (!run.plan) {
        await setStatus('planning');
        await layer('plan', 'active');
        const desc = provider.describe();
        emit('log', { text: `Planning with ${desc.label || desc.name} · ${desc.plannerModel || desc.model}…` });
        const plan = await runPlanner({ provider, run, signal, track, log: (text) => emit('log', { level: 'warn', text }) });
        const depth = levels(plan.tasks);
        plan.tasks = plan.tasks.map((t) => ({ ...t, status: 'pending', attempts: [], level: depth[t.id] }));
        run.plan = plan;
        run.title = plan.product.name || run.title;
        await save();
        await this.writePlanArtifacts(run, ws);
        emit('plan', { tasks: plan.tasks.length, levels: Math.max(...Object.values(depth)) + 1 });
        await layer('plan', 'done');
      }

      // ── Layer 2: spin up only the agents the plan needs ───────────────────────────────────
      run.agents = [...new Set(run.plan.tasks.map((t) => t.role))];
      await layer('agents', 'done');
      emit('agents', { roles: run.agents });

      // ── Execution loop (layers 3–6) ───────────────────────────────────────────────────────
      await setStatus('running');
      await layer('execution', 'active');
      await this.executionLoop(run, { ws, provider, signal, track, emit, save, layer });
      if (signal.aborted) throw signal.reason || new Error('cancelled');
      const tasks = run.plan.tasks;
      const allDone = tasks.every((t) => DONE_STATES.has(t.status));
      await layer('execution', allDone ? 'done' : 'failed');
      await layer('artifacts', 'done');
      if (run.layers.feedback === 'active') await layer('feedback', 'done');
      await layer('verification', tasks.every((t) => t.status === 'completed') ? 'done' : 'failed');

      // ── Layer 7: completion ───────────────────────────────────────────────────────────────
      await setStatus('completing');
      await layer('completion', 'active');
      await this.complete(run, { ws, provider, signal, track, emit, save, allDone });
      const ok = run.checklist.every((c) => c.ok);
      await layer('completion', ok ? 'done' : 'failed');

      // ── Deliver ───────────────────────────────────────────────────────────────────────────
      run.finishedAt = new Date().toISOString();
      run.status = ok ? 'completed' : 'needs_attention';
      run.delivery = await packageDelivery(run, ws, this.store.deliveryDir(id));
      if (run.repoUrl && this.cfg.githubToken) {
        run.git = await pushToGit(ws, { repoUrl: run.repoUrl, token: this.cfg.githubToken, message: `${run.plan.product.name}: built by da-prompt factory run ${run.id}` });
        emit('git', run.git);
      }
      await save();
      emit('deliver', run.delivery);
      emit('run.status', { status: run.status });
    } catch (err) {
      const cancelled = signal.aborted;
      const reason = cancelled ? String(signal.reason?.message || 'cancelled') : err.message;
      for (const t of run.plan?.tasks || []) if (t.status === 'running') t.status = cancelled ? 'cancelled' : 'pending';
      run.error = redact(reason);
      run.finishedAt = new Date().toISOString();
      run.status = cancelled ? 'cancelled' : err instanceof BudgetError ? 'needs_attention' : 'failed';
      await save();
      emit('error', { message: run.error });
      emit('run.status', { status: run.status });
    } finally {
      clearTimeout(timer);
    }
    return run;
  }

  async executionLoop(run, ctx) {
    const { signal, save, emit } = ctx;
    const running = new Map();
    const tasks = run.plan.tasks;
    while (!signal.aborted) {
      const blocked = propagateBlocked(tasks);
      if (blocked.length) {
        await save();
        for (const b of blocked) emit('task', { taskId: b, status: 'blocked', blockedBy: tasks.find((t) => t.id === b).blockedBy });
      }
      for (const t of readyTasks(tasks)) {
        if (running.size >= run.settings.maxParallel) break;
        t.status = 'running';
        const p = this.runTask(run, t, ctx)
          .catch(async (err) => {
            if (err instanceof BudgetError || signal.aborted) throw err;
            t.status = 'escalated';
            t.error = redact(err.message);
            t.escalation = escalationFor(t, err.message);
            await save();
            emit('escalation', { taskId: t.id, reason: t.error, options: t.escalation.options });
          })
          .finally(() => running.delete(t.id));
        running.set(t.id, p);
      }
      if (running.size === 0) break;
      try {
        await Promise.race(running.values());
      } catch (err) {
        // Budget exhausted or cancelled: let in-flight agents stop, then surface the error.
        await Promise.allSettled(running.values());
        throw err;
      }
    }
    await Promise.allSettled(running.values());
  }

  async runTask(run, task, { ws, provider, signal, track, emit, save, layer }) {
    const maxAttempts = run.settings.maxAttempts;
    const base = task.attemptBase || 0;
    let feedback = task.attempts.length > base ? task.attempts.at(-1).feedback : null;
    const upstream = (task.dependsOn || [])
      .map((d) => run.plan.tasks.find((t) => t.id === d))
      .filter((t) => t?.result)
      .map((t) => ({ id: t.id, role: t.role, summary: t.result.summary, files: t.result.files }));

    for (let n = task.attempts.length - base + 1; n <= maxAttempts; n++) {
      if (signal.aborted) return;
      const attempt = { n, startedAt: new Date().toISOString(), verification: [] };
      task.attempts.push(attempt);
      task.status = 'running';
      await save();
      emit('task', { taskId: task.id, status: 'running', attempt: n, role: task.role, title: task.title });

      const lessons = await readLessons(ws);
      const out = await runAgent({
        provider, ws, run, task, attempt: n, maxAttempts, feedback, upstream, lessons,
        settings: run.settings, signal, track,
        emit: (type, data) => emit(type, { ...data, attempt: n }),
      });
      if (signal.aborted) return;

      if (!out.ok) {
        attempt.ok = false;
        attempt.error = out.error;
        feedback = `The agent did not complete the task: ${out.error}`;
      } else {
        attempt.result = out.result;
        // ── Layer 5: verify before moving on ──
        await layer('verification', 'active');
        const checks = await this.verifyTask(task, ws, run, signal);
        attempt.verification = checks;
        emit('verify', { taskId: task.id, attempt: n, results: checks.map(({ command, exitCode, ok, durationMs, output }) => ({ command, exitCode, ok, durationMs, output: redact(output).slice(-3000) })) });
        const failed = checks.filter((c) => !c.ok);
        attempt.ok = failed.length === 0;
        if (attempt.ok) {
          attempt.finishedAt = new Date().toISOString();
          task.status = 'completed';
          task.result = out.result;
          if (task.attempts.length > 1) await this.recordLesson(run, ws, task, attempt, emit);
          await save();
          emit('task', { taskId: task.id, status: 'completed', attempt: n, summary: out.result.summary });
          return;
        }
        feedback = failed.map((c) => `$ ${c.command}\nexit code ${c.exitCode}\n${c.output.slice(-3500)}`).join('\n\n');
      }

      // ── Layer 6: feedback ──
      attempt.finishedAt = new Date().toISOString();
      attempt.feedback = redact(feedback);
      await layer('feedback', 'active');
      await save();
      emit('feedback', { taskId: task.id, attempt: n, willRetry: n < maxAttempts, message: redact(feedback).slice(0, 3000), headline: headline(feedback) });
    }

    // Retries exhausted: escalate with options.
    task.status = 'escalated';
    task.error = headline(feedback);
    task.escalation = escalationFor(task, feedback);
    await this.recordLesson(run, ws, task, task.attempts.at(-1), emit, { unresolved: true });
    await save();
    emit('escalation', { taskId: task.id, reason: task.error, options: task.escalation.options });
  }

  async verifyTask(task, ws, run, signal) {
    const results = [];
    for (const f of task.outputs || []) {
      if (/[*?]/.test(f)) continue;
      const ok = ws.exists(f.replace(/\/$/, ''));
      results.push({ command: `exists ${f}`, exitCode: ok ? 0 : 1, ok, durationMs: 0, output: ok ? '' : `expected output ${f} was not produced` });
    }
    for (const command of task.verify || []) {
      const r = await ws.runCommand(command, { timeoutMs: run.settings.commandTimeoutMs, signal });
      results.push({ command, exitCode: r.exitCode, ok: r.exitCode === 0, durationMs: r.durationMs, output: `${r.stdout}\n${r.stderr}`.trim() });
    }
    return results;
  }

  async recordLesson(run, ws, task, attempt, emit, { unresolved = false } = {}) {
    const first = task.attempts.find((a) => a.feedback)?.feedback || attempt?.feedback || '';
    const text = unresolved
      ? `${task.id} (${task.role}): still failing after ${task.attempts.length} attempts — "${headline(first)}". Escalated; check this before building on ${task.id}.`
      : `${task.id} (${task.role}): verification failed with "${headline(first)}"; fixed on attempt ${task.attempts.length}: ${(attempt.result?.summary?.slice(0, 240) || 'see task result').replace(/\.+$/, '')}. Re-run the task's checks before completing.`;
    const lesson = { at: new Date().toISOString(), taskId: task.id, text };
    run.lessons.push(lesson);
    const file = 'CLAUDE.md';
    let md = ws.exists(file) ? await ws.readFile(file) : '# CLAUDE.md\n\n## Lessons\n';
    if (!md.includes('## Lessons')) md += '\n## Lessons\n';
    md = md.replace('_No lessons yet._\n', '');
    await ws.writeFile(file, `${md.trimEnd()}\n- ${lesson.at.slice(0, 10)} — ${text}\n`);
    emit('lesson', lesson);
  }

  async writePlanArtifacts(run, ws) {
    const p = run.plan;
    const lines = [`# Plan — ${p.product.name}`, '', p.product.summary, '', '## Users', ...p.product.users.map((u) => `- ${u}`), '', '## Success criteria', ...p.product.successCriteria.map((c) => `- ${c}`), '', '## Task graph', '| Task | Role | Depends on | Level |', '| --- | --- | --- | --- |'];
    for (const t of p.tasks) lines.push(`| ${t.id} — ${t.title} | ${t.role} | ${t.dependsOn.join(', ') || '—'} | ${t.level} |`);
    lines.push('', '## Risks', ...(p.risks.length ? p.risks.map((r) => `- ${r}`) : ['- none identified']), '', '## Open questions', ...(p.openQuestions.length ? p.openQuestions.map((r) => `- ${r}`) : ['- none']), '');
    await ws.writeFile('PLAN.md', lines.join('\n'));
    if (!ws.exists('CLAUDE.md')) {
      await ws.writeFile(
        'CLAUDE.md',
        `# CLAUDE.md\n\n${p.product.name} — ${p.product.summary}\n\n## Commands\n- Test: ${p.finalVerify.map((c) => `\`${c}\``).join(', ') || 'n/a'}\n- Start: ${p.deploy ? `\`${p.deploy.start}\` (reads PORT)` : 'n/a'}\n\n## Lessons\n_No lessons yet._\n`,
      );
    }
  }

  async complete(run, { ws, provider, signal, track, emit, save, allDone }) {
    const items = [];
    const tasks = run.plan.tasks;
    const completed = tasks.filter((t) => t.status === 'completed').length;
    items.push({ id: 'tasks', label: 'All core features work and are tested', ok: completed === tasks.length, detail: `${completed}/${tasks.length} tasks completed and verified` });

    // Full test suite.
    run.finalVerification = [];
    for (const command of run.plan.finalVerify) {
      if (signal.aborted) break;
      const r = await ws.runCommand(command, { timeoutMs: run.settings.commandTimeoutMs, signal });
      run.finalVerification.push({ command, exitCode: r.exitCode, ok: r.exitCode === 0, durationMs: r.durationMs, output: redact(`${r.stdout}\n${r.stderr}`.trim()).slice(-6000) });
    }
    const suiteOk = run.finalVerification.length > 0 && run.finalVerification.every((v) => v.ok);
    const suiteDetail = run.finalVerification.map((v) => `${v.command} → ${v.exitCode}`).join(', ') || 'no final verification commands';
    // A green suite over an incomplete plan proves little (the tests may not exist yet).
    items.push({ id: 'tests', label: 'Full test suite passes', ok: suiteOk && completed === tasks.length, detail: completed === tasks.length ? suiteDetail : `${suiteDetail} (not counted: ${tasks.length - completed} task(s) incomplete)` });
    emit('verify', { taskId: '_final', results: run.finalVerification });

    // Security review.
    run.security = await scanWorkspace(ws);
    const crit = run.security.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
    items.push({ id: 'security', label: 'No critical errors or security issues', ok: run.security.ok, detail: crit.length ? crit.map((f) => `${f.rule} at ${f.file}:${f.line}`).slice(0, 5).join('; ') : `${run.security.findings.length} low/medium findings, 0 blocking` });

    // Deployment.
    const docsDeploy = ws.exists('DEPLOY.md') || /deploy/i.test(ws.exists('README.md') ? await ws.readFile('README.md') : '');
    if (run.plan.deploy && run.settings.deploy && allDone && !signal.aborted) {
      emit('log', { text: `Deploying: ${run.plan.deploy.start}` });
      const d = await this.previews.start(run.id, ws.root, run.plan.deploy);
      run.deployment = { ...d, start: run.plan.deploy.start, healthPath: run.plan.deploy.healthPath, url: d.ok ? `/preview/${run.id}/` : null, at: new Date().toISOString() };
      emit('deploy', { ok: d.ok, url: run.deployment.url, error: d.error, logs: d.logs });
    } else if (run.plan.deploy) {
      run.deployment = { ok: false, start: run.plan.deploy.start, healthPath: run.plan.deploy.healthPath, error: allDone ? 'live preview disabled' : 'skipped: not all tasks completed' };
    }
    const deployOk = Boolean(run.deployment?.ok) || (docsDeploy && (!run.plan.deploy || run.settings.deploy === false));
    items.push({ id: 'deploy', label: 'Deployment is successful (URL or clear instructions)', ok: deployOk, detail: run.deployment?.ok ? `live at ${run.deployment.url}${docsDeploy ? ' + DEPLOY.md' : ''}` : run.deployment?.error || (docsDeploy ? 'instructions only' : 'no deployment') });

    // Documentation.
    let readme = '';
    if (ws.exists('README.md')) readme = await ws.readFile('README.md');
    items.push({ id: 'docs', label: 'Documentation is updated', ok: readme.trim().length > 200, detail: readme ? `README.md (${readme.length} chars)${docsDeploy ? ', DEPLOY.md' : ''}` : 'README.md missing' });

    // Final summary.
    run.checklist = items;
    run.summary = redact(await writeSummary({ provider, run, signal, track }));
    items.push({ id: 'summary', label: 'Final summary and next steps provided', ok: Boolean(run.summary) && !run.summary.startsWith('Summary unavailable'), detail: 'FACTORY_REPORT.md' });
    run.checklist = items;
    await save();
    emit('checklist', { items });
  }
}

function headline(text = '') {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /(Error|error:|failed|✖|not ok|ERR!|Exception|Traceback|expected)/.test(l) && !/^\$ /.test(l));
  return redact((hit || lines.find((l) => !/^\$ |^exit code/.test(l)) || lines[0] || 'unknown failure').slice(0, 200));
}

function escalationFor(task, reason) {
  return {
    reason: headline(reason),
    options: [
      { id: 'retry', label: 'Retry with a fresh set of attempts', description: 'Run the agent again with the latest feedback and lessons.' },
      { id: 'edit', label: 'Edit the task spec, then retry', description: 'Clarify the description or fix the verify commands, then rerun.' },
      { id: 'skip', label: 'Skip this task and continue', description: 'Unblock dependents; the completion checklist will flag it.' },
    ],
  };
}

async function readLessons(ws) {
  if (!ws.exists('CLAUDE.md')) return '';
  const md = await ws.readFile('CLAUDE.md');
  const i = md.indexOf('## Lessons');
  if (i === -1) return '';
  const body = md.slice(i + '## Lessons'.length).trim();
  return body && !body.startsWith('_No lessons') ? body.slice(-4000) : '';
}

export async function readDeliveryFile(store, id, name) {
  if (!['FACTORY_REPORT.md', 'test-results.json', 'project.tar.gz'].includes(name)) throw new Error('unknown delivery file');
  return path.join(store.deliveryDir(id), name);
}

