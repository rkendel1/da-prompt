// The operator: runs the software factory end-to-end.
// Layer 1 plan → 2 agents → 3 execution (parallel, per-task subgraphs) → 4 artifacts →
// 5 verification → 6 feedback (retry ×3, escalate, record lessons) → 7 completion → deliver.

import fs from 'node:fs';
import path from 'node:path';
import { Workspace } from './sandbox.js';
import { normalizeInputs } from './prompt.js';
import { readyTasks, propagateBlocked, dependentsOf, levels, DONE_STATES } from './graph.js';
import { runPlanner, runAgent, writeSummary, BudgetError } from './agents.js';
import { scanWorkspace, redact, existingProjectPolicy } from './security.js';
import { runGit, scrubPaths } from './gitutil.js';
import {
  ProjectError, isExisting, normalizeSource, inspectRemote, prepareWorkspace, inspectProject, describeInspection, runChecks, classifyCheck,
  verificationSummary, changeSummary, changePatch, verifyIntegrity, resolveDirectory, applyToSource, exportBranch, addExcludes,
} from './project.js';
import { publishRun, buildPrBody } from './publish.js';
import { collectPaxEvidence } from './pax.js';
import { PAX_STEP_IDS } from './settings.js';
import crypto from 'node:crypto';
import { ProviderRegistry } from './providers/registry.js';
import { packageDelivery, packageExistingDelivery, writeReport, verdictOf, pushToGit, resolveOutputDir, checkOutputDir, exportProject } from './deliver.js';

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
    // The planner may use a different provider (e.g. a frontier API) than the agents (e.g. a local model).
    this.makePlannerProvider = (run) => {
      const own = run.plannerProvider && (run.plannerProvider !== run.provider || run.plannerOptions);
      if (!own) return this.makeProvider(run);
      const planRun = { ...run, provider: run.plannerProvider, model: run.plannerModel, plannerModel: run.plannerModel, providerOptions: run.plannerOptions || {} };
      return this.makeProvider(planRun);
    };
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

  /** Validate the source descriptor and (for GitHub) check that the repository and ref are reachable. */
  async resolveSource(raw) {
    let source;
    try {
      source = normalizeSource(this.cfg, raw);
      if (source.mode !== 'new') {
        const g = await runGit(['--version'], {});
        if (g.code !== 0) throw new ProjectError(500, 'git is not working on the server');
      }
      if (source.mode === 'github') {
        const info = await inspectRemote(this.cfg, { repoUrl: source.repoUrl, ref: source.ref });
        source.defaultBranch = info.defaultBranch;
      }
    } catch (err) {
      if (err instanceof ProjectError) throw err;
      throw new ProjectError(err.code === 'no-git' ? 500 : 400, err.message);
    }
    return source;
  }

  async createRun(body = {}) {
    const source = await this.resolveSource(body.source);
    const existing = source.mode !== 'new';
    const inputs = normalizeInputs(body, { existing });
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
      // Existing projects are never deployed unless the request explicitly authorizes a local preview.
      deploy: existing ? s.deploy === true : s.deploy !== false,
      // PAX evidence is opt-in per run (default from Settings). The steps are fixed at creation so a run is reproducible.
      pax: typeof s.pax === 'boolean' ? s.pax : Boolean(this.cfg.paxAutoRun),
      paxSteps: (Array.isArray(s.paxSteps) ? s.paxSteps : this.cfg.paxSteps || []).filter((x) => PAX_STEP_IDS.includes(x)),
    };
    const repoUrl = !existing && typeof body.repoUrl === 'string' && body.repoUrl.trim() ? body.repoUrl.trim() : null;
    if (repoUrl && !/^https:\/\/[^\s]+$/.test(repoUrl)) throw new Error('repoUrl must be an https:// git URL');
    if (repoUrl && /^https:\/\/[^/?#]*@/.test(repoUrl)) throw new Error('repoUrl must not contain credentials; add a GitHub token in Settings instead');
    const id = this.store.newId();
    const outputDir = resolveOutputDir(this.cfg, body.outputDir);
    if (outputDir) await checkOutputDir(outputDir, id);
    if (outputDir && source.mode === 'local') {
      const dir = resolveDirectory(this.cfg, source.directoryId);
      const real = fs.existsSync(outputDir) ? fs.realpathSync(outputDir) : outputDir;
      if (real === dir.real || real.startsWith(dir.real + path.sep) || dir.real.startsWith(real + path.sep)) throw new Error('outputDir must be outside the source project; use a new folder elsewhere');
    }
    const run = {
      id,
      title: inputs.idea.split('\n')[0].slice(0, 90),
      createdAt: new Date().toISOString(),
      status: 'queued',
      provider: choice.provider,
      providerLabel: choice.label,
      model: choice.model,
      plannerProvider: choice.plannerProvider,
      plannerProviderLabel: choice.plannerLabel,
      plannerModel: choice.plannerModel,
      plannerOptions: choice.plannerProvider === choice.provider ? null : choice.plannerOptions,
      providerOptions: choice.options,
      outputDir,
      inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, redact(v)])),
      settings,
      repoUrl,
      ...(existing ? { source, project: { stages: {} } } : {}),
      layers: Object.fromEntries(LAYERS.map((l) => [l, 'pending'])),
      plan: null,
      usage: { input: 0, output: 0, calls: 0 },
      lessons: [],
      checklist: [],
    };
    await this.store.create(run);
    this.store.event(id, 'run.created', {
      title: run.title, provider: run.provider, model: run.model, plannerProvider: run.plannerProvider, plannerModel: run.plannerModel, outputDir, settings,
      ...(existing ? { source: { mode: source.mode, label: source.label, ref: source.ref || null, workingMode: source.workingMode || null, publish: Boolean(source.publish) } } : {}),
    });
    if (choice.provider !== 'offline') this.providers.remember(choice.provider, choice.model);
    return run;
  }

  /** Validate one provider/model pair, filling in discovered defaults. */
  async resolveEndpoint({ provider, model, providerOptions }) {
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : '');
    let providerId = str(provider);
    model = str(model);
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
    } else if (!model && spec.type !== 'injected') {
      const probe = await this.providers.probe(spec);
      if (probe.status !== 'ready') throw new Error(`${spec.label} is not ready: ${probe.message || probe.status}`);
      model = probe.defaultModel;
      if (!model) throw new Error(`${spec.label} has no models available`);
    }
    const o = providerOptions || {};
    const options = {};
    if (Number(o.numCtx) > 0) options.numCtx = Math.max(2048, Math.min(1_048_576, Math.round(Number(o.numCtx))));
    if (o.temperature !== undefined && o.temperature !== '' && Number.isFinite(Number(o.temperature))) options.temperature = Math.max(0, Math.min(2, Number(o.temperature)));
    if (['auto', 'native', 'json'].includes(o.toolMode)) options.toolMode = o.toolMode;
    return { provider: providerId, label: spec.label, type: spec.type, model: model || 'default', options };
  }

  /**
   * Validate the requested provider/model for the agents and, separately, for the planner.
   * The planner defaults to the agents' provider; `planner: { provider, model, providerOptions }`
   * (or the older flat `plannerModel`) picks something else, such as a frontier model for design.
   */
  async resolveModelChoice(body = {}) {
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : '');
    const main = await this.resolveEndpoint(body);
    const pb = body.planner && typeof body.planner === 'object' ? body.planner : {};
    let plannerProvider = str(pb.provider) || str(body.plannerProvider);
    let plannerModel = str(pb.model) || str(body.plannerModel);
    let pOptions = pb.providerOptions;
    if (!plannerProvider && !plannerModel && this.cfg.defaultPlannerProvider) {
      plannerProvider = this.cfg.defaultPlannerProvider;
      plannerModel = this.cfg.defaultPlannerModel;
    }
    let planner;
    if (!plannerProvider || plannerProvider === main.provider) {
      if (!plannerModel && main.provider === this.cfg.defaultProvider) plannerModel = this.cfg.defaultPlannerModel;
      planner = { ...main, model: main.type === 'offline' ? main.model : plannerModel || main.model };
    } else {
      planner = await this.resolveEndpoint({ provider: plannerProvider, model: plannerModel, providerOptions: pOptions });
      if ((planner.type === 'offline') !== (main.type === 'offline')) throw new Error('the built-in offline agents cannot be combined with a real LLM provider; use offline for both or neither');
    }
    const choice = {
      provider: main.provider,
      label: main.label,
      model: main.model,
      options: main.options,
      plannerProvider: planner.provider,
      plannerLabel: planner.label,
      plannerModel: planner.model,
      plannerOptions: planner.options,
    };
    // fail fast: missing key, disabled provider, missing model
    this.makeProvider({ ...choice, providerOptions: choice.options });
    this.makePlannerProvider({ ...choice, providerOptions: choice.options });
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
    const existing = isExisting(run);
    // Existing projects: commands pass through the project command policy and .git is write-protected.
    const ws = new Workspace(this.store.workspaceDir(id), existing ? { policy: existingProjectPolicy({ allowInstall: run.source.allowInstall }), protectGit: true } : {});
    // Factory notes (plan, lessons) live beside the workspace for existing projects, never inside the project.
    const notes = existing ? new Workspace(this.store.notesDir(id)) : ws;
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
    const plannerProvider = this.makePlannerProvider(run);
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
      // ── Layer 1: plan (existing projects first connect, inspect and baseline) ──────────────
      if (existing && !['done', 'skipped'].includes(run.project?.stages?.baseline?.state)) {
        await setStatus('planning');
        await layer('plan', 'active');
        await this.prepareExisting(run, { ws, signal, emit, save });
      }
      if (!run.plan) {
        if (run.status !== 'planning') await setStatus('planning');
        await layer('plan', 'active');
        const desc = plannerProvider.describe();
        emit('log', { text: `Planning with ${desc.label || desc.name} · ${desc.plannerModel || desc.model}…` });
        const plan = await runPlanner({ provider: plannerProvider, run, signal, track, log: (text) => emit('log', { level: 'warn', text }) });
        const depth = levels(plan.tasks);
        plan.tasks = plan.tasks.map((t) => ({ ...t, status: 'pending', attempts: [], level: depth[t.id] }));
        run.plan = plan;
        run.title = plan.product.name || run.title;
        await save();
        await this.writePlanArtifacts(run, existing ? notes : ws);
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
      await this.executionLoop(run, { ws, notes, provider, signal, track, emit, save, layer });
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
      await this.complete(run, { ws, notes, provider, signal, track, emit, save, allDone });
      const ok = run.checklist.every((c) => c.ok);
      await layer('completion', ok ? 'done' : 'failed');
      // PAX observations are collected after the factory's own verification and are stored apart from it.
      if (run.settings.pax && !signal.aborted) await this.collectPax(run, { ws, emit, save, signal });

      // ── Deliver ───────────────────────────────────────────────────────────────────────────
      run.finishedAt = new Date().toISOString();
      run.status = ok ? 'completed' : 'needs_attention';
      if (existing) {
        run.delivery = await this.deliverExisting(run, { ws, emit, save, signal });
        if (!run.delivery.integrity.ok) run.status = 'needs_attention';
      } else {
        run.delivery = await packageDelivery(run, ws, this.store.deliveryDir(id));
      }
      if (run.outputDir) {
        run.delivery.output = await exportProject(ws, run.outputDir, run.id);
        emit('output', run.delivery.output);
        if (!run.delivery.output.ok) run.status = 'needs_attention';
      }
      if (existing) await writeReport(run, this.store.deliveryDir(id));
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
      run.error = existing ? this.scrub(run, reason) : redact(reason);
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

  async runTask(run, task, { ws, notes = ws, provider, signal, track, emit, save, layer }) {
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

      const lessons = await readLessons(notes);
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
        emit('verify', { taskId: task.id, attempt: n, results: checks.map(({ command, exitCode, ok, durationMs, output, state }) => ({ command, exitCode, ok, durationMs, output: redact(output).slice(-3000), ...(state ? { state } : {}) })) });
        const failed = checks.filter((c) => !c.ok);
        attempt.ok = failed.length === 0;
        if (attempt.ok) {
          attempt.finishedAt = new Date().toISOString();
          task.status = 'completed';
          task.result = out.result;
          if (task.attempts.length > 1) await this.recordLesson(run, notes, task, attempt, emit);
          await save();
          emit('task', { taskId: task.id, status: 'completed', attempt: n, summary: out.result.summary });
          return;
        }
        feedback = failed.map((c) => `$ ${c.command}\nexit code ${c.exitCode}${c.state === 'regression' ? '\n(REGRESSION: this command passed or had different failures before your change)' : ''}${c.newFailures?.length ? `\nnew failures:\n${c.newFailures.map((x) => `  - ${x}`).join('\n')}` : ''}\n${c.output.slice(-3500)}`).join('\n\n');
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
    await this.recordLesson(run, notes, task, task.attempts.at(-1), emit, { unresolved: true });
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
    const existing = isExisting(run);
    for (const command of task.verify || []) {
      const r = await ws.runCommand(command, { timeoutMs: run.settings.commandTimeoutMs, signal });
      const output = `${r.stdout}\n${r.stderr}`.trim();
      if (existing) {
        // A command that already failed at baseline passes the task if it fails in no new way.
        const cls = classifyCheck(run.project.baseline?.find((b) => b.command === command), r);
        results.push({ command, exitCode: r.exitCode, ok: cls.ok, state: cls.state, newFailures: cls.newFailures, durationMs: r.durationMs, output });
      } else {
        results.push({ command, exitCode: r.exitCode, ok: r.exitCode === 0, durationMs: r.durationMs, output });
      }
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
    if (p.architecture) lines.push('', '## Existing architecture', p.architecture);
    if (p.affectedFiles?.length) lines.push('', '## Files likely to change', ...p.affectedFiles.map((f) => `- ${f}`));
    lines.push('', '## Risks', ...(p.risks.length ? p.risks.map((r) => `- ${r}`) : ['- none identified']), '', '## Open questions', ...(p.openQuestions.length ? p.openQuestions.map((r) => `- ${r}`) : ['- none']), '');
    await ws.writeFile('PLAN.md', lines.join('\n'));
    if (!ws.exists('CLAUDE.md')) {
      await ws.writeFile(
        'CLAUDE.md',
        `# CLAUDE.md\n\n${p.product.name} — ${p.product.summary}\n\n## Commands\n- Test: ${p.finalVerify.map((c) => `\`${c}\``).join(', ') || 'n/a'}\n- Start: ${p.deploy ? `\`${p.deploy.start}\` (reads PORT)` : 'n/a'}\n\n## Lessons\n_No lessons yet._\n`,
      );
    }
  }

  // ── Existing projects ───────────────────────────────────────────────────────────────────────────

  /** Remove server-side paths and credentials from text that is stored or shown. */
  scrub(run, text) {
    const paths = [this.store.workspaceDir(run.id), this.store.runDir(run.id), this.cfg.dataDir];
    try {
      if (run.source?.directoryId) paths.push(resolveDirectory(this.cfg, run.source.directoryId).real);
    } catch {
      /* no longer authorized */
    }
    return scrubPaths(text, paths);
  }

  /** Connect → Inspect → Baseline, all inside the plan layer, before any edit is made. */
  async prepareExisting(run, { ws, signal, emit, save }) {
    const stage = async (name, state, detail) => {
      run.project.stages[name] = { state, detail: detail ? this.scrub(run, detail) : undefined, at: new Date().toISOString() };
      await save();
      emit('stage', { stage: name, state, detail: run.project.stages[name].detail });
    };
    run.project ||= { stages: {} };
    const src = run.source;

    // Connect: authorize the source and build the isolated workspace.
    const intact = src.prepared && fs.existsSync(path.join(ws.root, '.git'));
    if (!intact) {
      if (src.prepared && run.plan) throw new Error('the isolated workspace is missing; start a new run');
      src.prepared = false;
      await stage('connect', 'active', 'Authorizing the source and creating an isolated workspace');
      try {
        const facts = await prepareWorkspace(this.cfg, run, ws.root, { signal, log: (text) => emit('log', { text }) });
        Object.assign(src, facts, { prepared: true });
      } catch (err) {
        await stage('connect', 'failed', err.message);
        throw new Error(signal.aborted ? 'cancelled' : err.message);
      }
      await stage('connect', 'done', `${src.mode === 'github' ? src.label : src.label} · ${src.workingMode} · base ${src.baseSha.slice(0, 10)} · branch ${src.branch}`);
      emit('source', { mode: src.mode, label: src.label, ref: src.ref || null, workingMode: src.workingMode, baseSha: src.baseSha, baseBranch: src.baseBranch || null, branch: src.branch, git: src.sourceGit || null, note: src.snapshotNote || null, publish: Boolean(src.publish) });
    } else {
      await stage('connect', 'done', 'Reusing the existing isolated workspace');
    }
    if (signal.aborted) throw new Error('cancelled');

    // Inspect: structure, manifests, instructions, scripts, deploy configuration.
    await stage('inspect', 'active', 'Reading the project');
    run.project.inspection = await inspectProject(ws);
    const insp = run.project.inspection;
    await stage('inspect', 'done', describeInspection(insp));
    emit('inspect', { summary: describeInspection(insp), ecosystems: insp.ecosystems, commands: insp.baselineCommands, instructions: insp.instructions.map((i) => i.path), deploy: insp.deploy });

    // Baseline: run the project's own checks before editing, and keep what already failed.
    if (!insp.baselineCommands.length) {
      run.project.baseline = [];
      await stage('baseline', 'skipped', 'No test, lint or build command was detected, so there is no baseline');
      return;
    }
    await stage('baseline', 'active', `Running ${insp.baselineCommands.length} check(s) before any change`);
    run.project.baseline = await runChecks(ws, insp.baselineCommands, {
      timeoutMs: run.settings.commandTimeoutMs,
      signal,
      onResult: (r) => emit('baseline', { command: r.command, kind: r.kind, status: r.status, exitCode: r.exitCode, durationMs: r.durationMs, limitation: r.limitation, output: r.output.slice(-1500) }),
    });
    if (signal.aborted) throw new Error('cancelled');
    // Whatever the baseline run left behind (caches, build output) is not part of the change.
    const st = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: ws.root, cfg: this.cfg });
    const leftovers = st.stdout.split('\0').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).replace(/\/$/, ''));
    await addExcludes(ws.root, leftovers);
    run.project.baselineArtifacts = leftovers.slice(0, 50);
    const bad = run.project.baseline.filter((b) => b.status !== 'passed');
    await stage('baseline', 'done', `${run.project.baseline.length - bad.length} passed, ${bad.length} already failing or not runnable`);
  }

  /** Layer 7 for an existing project: re-run the project's checks and classify every result against the baseline. */
  async completeExisting(run, { ws, notes, provider, signal, track, emit, save, allDone }) {
    const items = [];
    const tasks = run.plan.tasks;
    const completed = tasks.filter((t) => t.status === 'completed' || t.status === 'skipped').length;
    const skipped = tasks.filter((t) => t.status === 'skipped').length;
    items.push({ id: 'tasks', label: 'Requested change implemented; every planned task verified', ok: completed === tasks.length && !skipped, state: completed === tasks.length && !skipped ? 'pass' : 'fail', detail: `${completed - skipped}/${tasks.length} tasks completed and verified${skipped ? `, ${skipped} skipped` : ''}` });

    // Final verification: the plan's finalVerify plus every baseline check, each compared with its baseline.
    const base = run.project.baseline || [];
    const required = new Set([...run.plan.finalVerify, ...(run.project.inspection.commands.test || []).map((c) => c.command)]);
    const commands = [...new Set([...run.plan.finalVerify, ...base.map((b) => b.command)])].filter(Boolean);
    run.finalVerification = [];
    for (const command of commands) {
      if (signal.aborted) break;
      const r = await ws.runCommand(command, { timeoutMs: run.settings.commandTimeoutMs, signal });
      const cls = classifyCheck(base.find((b) => b.command === command), r);
      run.finalVerification.push({ command, required: required.has(command), exitCode: r.exitCode, ok: cls.ok, state: cls.state, newFailures: cls.newFailures, durationMs: r.durationMs, output: redact(`${r.stdout}\n${r.stderr}`.trim()).slice(-6000) });
    }
    emit('verify', { taskId: '_final', results: run.finalVerification.map(({ command, exitCode, ok, state, durationMs, output, newFailures }) => ({ command, exitCode, ok, state, durationMs, newFailures, output: output.slice(-2000) })) });

    const fv = run.finalVerification;
    const v = verificationSummary(run);
    const badReq = fv.filter((c) => !c.ok && (c.required || c.state === 'regression' || c.state === 'new-failure'));
    const notRunOptional = fv.filter((c) => !c.ok && !badReq.includes(c));
    const proven = v.passed + v.fixed > 0;
    let testsState = 'pass';
    if (!fv.length) testsState = 'skipped';
    else if (badReq.length) testsState = badReq.some((c) => c.state === 'regression' || c.state === 'new-failure') ? 'fail' : 'skipped';
    else if (!proven) testsState = 'skipped';
    else if (notRunOptional.length) testsState = 'partial';
    const testsOk = (testsState === 'pass' || testsState === 'partial') && completed === tasks.length;
    const parts = fv.map((c) => `${c.command} → ${c.state}`);
    items.push({
      id: 'tests',
      label: 'Project checks pass with no regressions',
      ok: testsOk,
      state: testsOk ? testsState : testsState === 'pass' || testsState === 'partial' ? 'fail' : testsState,
      detail: (fv.length ? parts.join(', ') : 'no project checks could be run — nothing is claimed as verified') + (testsOk || completed === tasks.length ? '' : ` (not counted: ${tasks.length - completed} task(s) incomplete)`),
    });
    const pre = fv.filter((c) => c.state === 'preexisting');
    if (pre.length || base.some((b) => b.status === 'unavailable' || b.status === 'blocked')) {
      items.push({ id: 'baseline', label: 'Pre-existing failures (present before this run)', ok: true, state: 'warn', detail: `${pre.length} still failing exactly as at baseline${v.baselineNotRun ? `, ${v.baselineNotRun} baseline check(s) could not run` : ''}; not caused by this change` });
    }

    // Security review of what this run changed (the project's pre-existing code is not re-litigated).
    const changed = await changeSummary(this.cfg, run, ws.root);
    run.security = await scanWorkspace(ws, { only: new Set(changed.files.filter((f) => f.status !== 'D').map((f) => f.path)) });
    const crit = run.security.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
    items.push({ id: 'security', label: 'No critical errors or security issues in the changed files', ok: run.security.ok, state: run.security.ok ? 'pass' : 'fail', detail: crit.length ? crit.map((f) => `${f.rule} at ${f.file}:${f.line}`).slice(0, 5).join('; ') : `${changed.files.length} changed file(s) scanned, ${run.security.findings.length} low/medium findings, 0 blocking` });

    // Deployment applies only when it was explicitly authorized.
    if (run.settings.deploy && run.plan.deploy && allDone && !signal.aborted) {
      emit('log', { text: `Starting the authorized local preview: ${run.plan.deploy.start}` });
      const d = await this.previews.start(run.id, ws.root, run.plan.deploy);
      run.deployment = { ...d, start: run.plan.deploy.start, healthPath: run.plan.deploy.healthPath, url: d.ok ? `/preview/${run.id}/` : null, at: new Date().toISOString() };
      emit('deploy', { ok: d.ok, url: run.deployment.url, error: d.error, logs: d.logs });
      items.push({ id: 'deploy', label: 'Local preview starts and passes its health check', ok: Boolean(d.ok), state: d.ok ? 'pass' : 'fail', detail: d.ok ? `live at ${run.deployment.url}` : d.error || 'preview did not start' });
    } else if (run.settings.deploy) {
      run.deployment = { ok: false, start: run.plan.deploy?.start, error: run.plan.deploy ? 'skipped: not all tasks completed' : 'no start command in the plan' };
      items.push({ id: 'deploy', label: 'Local preview starts and passes its health check', ok: false, state: 'skipped', detail: run.deployment.error });
    } else {
      items.push({ id: 'deploy', label: 'Deployment', ok: true, state: 'na', detail: 'not requested for this run — nothing was deployed' });
    }
    items.push({ id: 'docs', label: 'Documentation', ok: true, state: 'na', detail: 'only changed when the request or a plan task calls for it' });

    run.checklist = items;
    run.summary = redact(await writeSummary({ provider, run, signal, track }));
    items.push({ id: 'summary', label: 'Final summary and next steps provided', ok: Boolean(run.summary) && !run.summary.startsWith('Summary unavailable'), state: run.summary && !run.summary.startsWith('Summary unavailable') ? 'pass' : 'fail', detail: 'FACTORY_REPORT.md' });
    run.checklist = items;
    await save();
    emit('checklist', { items });
  }

  /** Commit to the run branch, package patch/archive/report, check source protection, and publish if it was asked for. */
  async deliverExisting(run, { ws, emit, save, signal }) {
    const src = run.source;
    const integrity = await verifyIntegrity(this.cfg, run, ws.root);
    const pkg = await packageExistingDelivery(this.cfg, run, ws, this.store.deliveryDir(run.id), { commit: integrity.ok });
    const reasons = [];
    if (!integrity.ok) reasons.push(...integrity.problems);
    if (!run.changes.files.length) reasons.push('the run changed no files');
    for (const c of run.checklist || []) if (!c.ok) reasons.push(`${c.label}${c.detail ? ` (${c.detail})` : ''}`);
    const delivery = { ...pkg, integrity, readiness: { ready: reasons.length === 0, reasons, verdict: verdictOf(run) }, publication: run.delivery?.publication, local: run.delivery?.local };
    run.delivery = delivery;
    if (src.mode === 'github' && src.publish && integrity.ok && !signal.aborted) {
      delivery.publication = await this.publishNow(run, { ws, emit, pullRequest: true });
    }
    await save();
    return delivery;
  }

  async publishNow(run, { ws, emit, pullRequest = true }) {
    const verdict = verdictOf(run);
    const pub = await publishRun(this.cfg, run, {
      wsDir: ws.root,
      pullRequest,
      draft: !run.delivery?.readiness?.ready,
      prTitle: `${run.title}`.slice(0, 120),
      prBody: buildPrBody(run, { changes: run.changes, verification: verdict.replace(/-/g, ' ') }),
    });
    emit('publish', { state: pub.state, branch: pub.branch, sha: pub.sha, pr: pub.pr || null, error: pub.error || null, prError: pub.prError || null, step: pub.step || null });
    return pub;
  }

  /** Explicit publish action (GitHub runs): push the run branch and optionally open the pull request. Safe to repeat. */
  async publish(id, { pullRequest = true } = {}) {
    if (this.active.has(id)) throw new ProjectError(409, 'run is still executing');
    const run = await this.store.load(id);
    if (!isExisting(run) || run.source.mode !== 'github') throw new ProjectError(409, 'only GitHub-backed runs can be published');
    if (!run.delivery?.integrity) throw new ProjectError(409, 'the run has not been delivered yet');
    await this.assertApproved(run, 'publish them');
    const ws = new Workspace(this.store.workspaceDir(id), { protectGit: true });
    run.delivery.publication = await this.publishNow(run, { ws, emit: (t, d) => this.store.event(id, t, d), pullRequest });
    await writeReport(run, this.store.deliveryDir(id));
    await this.store.save(run);
    return run;
  }

  /** Explicit apply action (local runs): write the result into the source directory, or export a branch. */
  async applyLocal(id, { mode = 'working-tree' } = {}) {
    if (this.active.has(id)) throw new ProjectError(409, 'run is still executing');
    const run = await this.store.load(id);
    if (!isExisting(run) || run.source.mode !== 'local') throw new ProjectError(409, 'only local-directory runs can be applied');
    if (!run.delivery?.integrity?.ok) throw new ProjectError(409, 'the run has not been delivered with a clean source-protection check');
    const dir = resolveDirectory(this.cfg, run.source.directoryId); // re-authorized on every use
    if (dir.readOnly) throw new ProjectError(403, 'this directory is in a read-only root; download the patch instead');
    await this.assertApproved(run, mode === 'branch' ? 'add them to your repository' : 'apply them to your directory');
    const wsDir = this.store.workspaceDir(id);
    const emit = (t, d) => this.store.event(id, t, d);
    run.delivery.local ||= {};
    if (mode === 'branch') {
      const b = await exportBranch(this.cfg, run, { sourceDir: dir.real, wsDir }).catch((e) => {
        throw new ProjectError(e instanceof ProjectError ? e.status : 409, this.scrub(run, e.message));
      });
      run.delivery.local.branch = { ...b, at: new Date().toISOString() };
      emit('apply', { mode, branch: b.branch });
    } else if (mode === 'working-tree') {
      const r = await applyToSource(this.cfg, run, { sourceDir: dir.real, wsDir });
      if (!r.ok) {
        const err = new ProjectError(409, r.conflicts ? `nothing was written: ${r.conflicts.length} file(s) changed in the source since the run started` : this.scrub(run, r.error));
        err.conflicts = r.conflicts || [];
        emit('apply', { mode, ok: false, conflicts: err.conflicts });
        throw err;
      }
      run.delivery.local.applied = { files: r.files, at: new Date().toISOString() };
      emit('apply', { mode, ok: true, files: r.files.length });
    } else throw new ProjectError(400, 'mode must be working-tree or branch');
    await writeReport(run, this.store.deliveryDir(id));
    await this.store.save(run);
    return run;
  }

  // ── PAX evidence and review ─────────────────────────────────────────────────────────────────────

  /** Run the run's selected PAX steps against its workspace. The result is `run.pax`; it never touches the verdict. */
  async collectPax(run, { ws, emit, save, signal, steps }) {
    const chosen = (steps || run.settings.paxSteps || []).filter((x) => PAX_STEP_IDS.includes(x));
    emit('log', { text: `Collecting PAX evidence (${chosen.join(', ') || 'no steps selected'})…` });
    const scrub = [this.store.runDir(run.id), this.cfg.dataDir];
    run.pax = await collectPaxEvidence(this.cfg, { wsRoot: ws.root, evidenceDir: this.store.paxDir(run.id), steps: chosen, signal, scrub, emit: (t, d) => emit(t, d) });
    await save();
    emit('pax.done', { state: run.pax.state, summary: run.pax.summary || null, message: run.pax.message || null });
    return run.pax;
  }

  /** Explicit action: collect (or refresh) PAX evidence for a run that is not executing. */
  async runPax(id, { steps, confirmTests = false } = {}) {
    if (this.active.has(id)) throw new ProjectError(409, 'the run is still executing; wait for it to finish');
    const run = await this.store.load(id);
    if (!fs.existsSync(path.join(this.store.workspaceDir(id)))) throw new ProjectError(409, 'the run has no workspace to observe');
    const chosen = (Array.isArray(steps) && steps.length ? steps : run.settings.paxSteps?.length ? run.settings.paxSteps : this.cfg.paxSteps).filter((x) => PAX_STEP_IDS.includes(x));
    if (!chosen.length) throw new ProjectError(400, 'choose at least one PAX step');
    if (chosen.includes('test') && confirmTests !== true) throw new ProjectError(400, 'the "test" step runs the project\'s native tests through PAX and can change files; confirm it explicitly ({"confirmTests": true})');
    const ws = new Workspace(this.store.workspaceDir(id), isExisting(run) ? { protectGit: true } : {});
    const emit = (t, d) => this.store.event(id, t, d);
    const controller = new AbortController();
    this.active.set(id, { controller, promise: Promise.resolve() });
    try {
      await this.collectPax(run, { ws, emit, save: () => this.store.save(run), signal: controller.signal, steps: chosen });
      if (isExisting(run)) await writeReport(run, this.store.deliveryDir(id));
    } finally {
      this.active.delete(id);
    }
    return run;
  }

  /** Hash of the exact change set, so an approval cannot silently carry over to different changes. */
  async changesHash(run) {
    const patch = await changePatch(this.cfg, run, this.store.workspaceDir(run.id));
    return crypto.createHash('sha256').update(patch).digest('hex');
  }

  /** Record the reviewer's decision about the delivered changes. Apply and publish require an approval of these exact changes. */
  async review(id, { decision, note = '' } = {}) {
    if (this.active.has(id)) throw new ProjectError(409, 'the run is still executing');
    if (!['approve', 'reject', 'clear'].includes(decision)) throw new ProjectError(400, 'decision must be approve, reject or clear');
    const run = await this.store.load(id);
    if (!isExisting(run) || !run.delivery?.integrity) throw new ProjectError(409, 'only a delivered run against an existing project can be reviewed');
    if (decision === 'clear') {
      delete run.review;
    } else {
      if (decision === 'approve' && !run.delivery.integrity.ok) throw new ProjectError(409, 'source protection failed for this run; its changes cannot be approved');
      if (decision === 'approve' && !run.changes?.files?.length) throw new ProjectError(409, 'the run changed no files; there is nothing to approve');
      run.review = { decision: decision === 'approve' ? 'approved' : 'rejected', at: new Date().toISOString(), note: redact(String(note || '')).slice(0, 500), changesHash: await this.changesHash(run), files: run.changes?.files.length || 0 };
    }
    await this.store.save(run);
    this.store.event(id, 'review', { decision: run.review?.decision || 'cleared', files: run.review?.files ?? null });
    return run;
  }

  async assertApproved(run, what) {
    const r = run.review;
    if (r?.decision === 'rejected') throw new ProjectError(409, `these changes were rejected in review; approve them again before you ${what}`);
    if (r?.decision !== 'approved') throw new ProjectError(409, `review the changes and approve them before you ${what}`);
    if ((await this.changesHash(run)) !== r.changesHash) throw new ProjectError(409, `the changes are different from the ones you approved; review and approve them again before you ${what}`);
  }

  /** Live changed-file list, or the diff of one file, from the run's workspace. */
  async changes(id, filePath) {
    const run = await this.store.load(id);
    if (!isExisting(run) || !run.source.baseSha) throw new ProjectError(404, 'this run has no tracked changes');
    const wsDir = this.store.workspaceDir(id);
    if (!filePath) return changeSummary(this.cfg, run, wsDir);
    if (filePath.startsWith('-') || filePath.includes('\0')) throw new ProjectError(400, 'invalid path');
    const patch = (await changePatch(this.cfg, run, wsDir, filePath)).toString('utf8');
    return { path: filePath, diff: redact(patch.length > 300_000 ? `${patch.slice(0, 300_000)}\n…[diff truncated]` : patch) };
  }

  async complete(run, ctx) {
    if (isExisting(run)) return this.completeExisting(run, ctx);
    const { ws, provider, signal, track, emit, save, allDone } = ctx;
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

