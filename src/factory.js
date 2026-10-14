// The operator: runs the software factory end-to-end.
// Layer 1 plan → 2 agents → 3 execution (parallel, per-task subgraphs) → 4 artifacts →
// 5 verification → 6 feedback (retry ×3, escalate, record lessons) → 7 completion → deliver.

import { computeLauncher } from './compute.js';
import fs from 'node:fs';
import path from 'node:path';
import { Workspace } from './sandbox.js';
import { normalizeInputs } from './prompt.js';
import { readyTasks, propagateBlocked, dependentsOf, levels, DONE_STATES } from './graph.js';
import { runPlanner, runAgent, writeSummary, BudgetError } from './agents.js';
import { detectCapabilities, checkOutput, validateArtifact, checkTaskContracts, outputKind } from './capabilities.js';
import { InferenceLimiter, limitProvider } from './inference.js';
import { STOP_KINDS, isTransient, failureFingerprint, buildFeedback, taskOutcomes } from './recovery.js';
import { scanWorkspace, redact, existingProjectPolicy, hideSecretValues } from './security.js';
import { runGit, scrubPaths } from './gitutil.js';
import {
  ProjectError, isExisting, normalizeSource, inspectRemote, prepareWorkspace, inspectProject, describeInspection, runChecks, installCommands, installDependencies, classifyCheck,
  verificationSummary, changeSummary, changePatch, verifyIntegrity, resolveDirectory, applyToSource, exportBranch, addExcludes,
} from './project.js';
import { publishRun, buildPrBody } from './publish.js';
import { collectPaxEvidence } from './pax.js';
import { PAX_STEP_IDS } from './settings.js';
import crypto from 'node:crypto';
import { ProviderRegistry } from './providers/registry.js';
import { ENGINE_IDS, checkProvider, loadEngineModule } from './engines/index.js';
import { makeFxRunner } from './engines/fx.js';
import { RunDiagnostics, instrumentProvider, failureKind, readRecords, buildRunMetrics } from './diagnostics.js';
import { contractWarnings } from './contract.js';
import { ProjectRegistry } from './registry.js';
import { packageDelivery, packageExistingDelivery, writeReport, verdictOf, pushToGit, resolveOutputDir, checkOutputDir, exportProject } from './deliver.js';

export const LAYERS = ['plan', 'agents', 'execution', 'artifacts', 'verification', 'feedback', 'completion'];
const ACTIVE = new Set(['queued', 'planning', 'running', 'completing']);
const RESUMABLE = new Set(['needs_attention', 'interrupted', 'failed', 'cancelled']);

export class Factory {
  constructor({ cfg, store, previews, registry }) {
    this.cfg = cfg;
    this.registry = registry || new ProjectRegistry(cfg); // the durable project registry (see src/registry.js)
    this.store = store;
    this.previews = previews;
    this.active = new Map(); // runId -> { controller, promise }
    this.limiters = new Map(); // local inference endpoint -> InferenceLimiter (shared by every run that uses that endpoint)
    this.providers = new ProviderRegistry(cfg);
    // cfg.providerFactory lets tests inject a provider instance.
    this.makeProvider = (run) =>
      cfg.providerFactory?.(run.provider, cfg, run) ||
      this.providers.create(run.provider, { model: run.model, plannerModel: run.plannerModel, options: run.providerOptions });
    this.agentRunners = { builtin: runAgent };
    // The planner may use a different provider (e.g. a frontier API) than the agents (e.g. a local model).
    this.makePlannerProvider = (run) => {
      const own = run.plannerProvider && (run.plannerProvider !== run.provider || run.plannerOptions);
      if (!own) return this.makeProvider(run);
      const planRun = { ...run, provider: run.plannerProvider, model: run.plannerModel, plannerModel: run.plannerModel, providerOptions: run.plannerOptions || {} };
      return this.makeProvider(planRun);
    };
  }

  /**
   * The canonical directory an existing-project run applies back to. A run made from a registered project follows the
   * project's *current* location (so moving the folder does not strand the run), and is blocked while the project is
   * archived, missing, inaccessible or needs attention. Older runs fall back to their recorded directoryId.
   */
  async sourceDir(run, { purpose, writable = false }) {
    if (run.projectId) {
      const known = await this.registry.find(run.projectId).catch(() => null);
      if (known) return (await this.registry.locate(run.projectId, { purpose, writable })).dir;
    }
    const dir = resolveDirectory(this.cfg, run.source.directoryId); // re-authorized on every use
    if (writable && dir.readOnly) throw new ProjectError(403, 'this directory is in a read-only root; download the patch instead');
    return dir;
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
    let project = null;
    try {
      if (raw && typeof raw === 'object' && raw.projectId) {
        // A registered project is the common workspace reference: its location is re-resolved and re-authorized now.
        const located = await this.registry.locate(raw.projectId, { purpose: 'start a task' });
        project = located.project;
        const st = project.settings || {};
        raw = project.kind === 'local'
          ? { mode: 'local', directoryId: located.dir.id, workingMode: raw.workingMode || st.workingMode || '', allowInstall: raw.allowInstall ?? st.allowInstall ?? this.cfg.defaults.allowInstall, publish: raw.publish, autoApply: raw.autoApply }
          : { mode: 'github', repoUrl: project.remote.url, ref: raw.ref || st.defaultRef || '', publish: raw.publish, allowInstall: raw.allowInstall ?? st.allowInstall ?? this.cfg.defaults.allowInstall };
      }
      source = normalizeSource(this.cfg, raw);
      if (project) Object.assign(source, { projectId: project.id });
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
    const engine = await this.resolveEngine(body.engine, choice);
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
      // Recovery: one task may spend this long in total, and stops early when the same failure repeats this many times in a row.
      taskDeadlineMinutes: clamp(s.taskDeadlineMinutes, 1, 24 * 60, d.taskDeadlineMinutes),
      maxRepeatedFailures: clamp(s.maxRepeatedFailures, 1, 5, d.maxRepeatedFailures),
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
      engine,
      plannerProvider: choice.plannerProvider,
      plannerProviderLabel: choice.plannerLabel,
      plannerModel: choice.plannerModel,
      plannerOptions: choice.plannerProvider === choice.provider ? null : choice.plannerOptions,
      providerOptions: choice.options,
      outputDir,
      inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, redact(v)])),
      settings,
      repoUrl,
      ...(typeof body.taskId === 'string' && /^tsk_[\w-]+$/.test(body.taskId) ? { taskId: body.taskId } : {}),
      ...(source.projectId ? { projectId: source.projectId, projectName: (await this.registry.find(source.projectId).catch(() => null))?.name } : {}),
      ...(existing ? { source, project: { stages: {} } } : {}),
      layers: Object.fromEntries(LAYERS.map((l) => [l, 'pending'])),
      plan: null,
      usage: { input: 0, output: 0, calls: 0 },
      lessons: [],
      checklist: [],
    };
    await this.store.create(run);
    if (run.projectId) this.registry.touch(run.projectId);
    this.store.event(id, 'run.created', {
      title: run.title, provider: run.provider, model: run.model, engine, plannerProvider: run.plannerProvider, plannerModel: run.plannerModel, outputDir, settings,
      ...(existing ? { source: { mode: source.mode, label: source.label, ref: source.ref || null, workingMode: source.workingMode || null, publish: Boolean(source.publish), autoApply: Boolean(source.autoApply) } } : {}),
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
      // The model the last run used on this provider is remembered with it (providers.json "defaults"); honour it unless
      // a configured default model or a per-provider default already decided, and only if the provider still lists it.
      const saved = this.providers.settings.defaults || {};
      if (!spec.defaultModel && saved.provider === providerId && saved.model && (probe.models || []).some((m) => m.id === saved.model)) model = saved.model;
      if (!model) throw new Error(`${spec.label} has no models available`);
    }
    const o = providerOptions || {};
    const options = {};
    if (Number(o.numCtx) > 0) options.numCtx = Math.max(2048, Math.min(1_048_576, Math.round(Number(o.numCtx))));
    if (o.temperature !== undefined && o.temperature !== '' && Number.isFinite(Number(o.temperature))) options.temperature = Math.max(0, Math.min(2, Number(o.temperature)));
    if (['auto', 'native', 'json'].includes(o.toolMode)) options.toolMode = o.toolMode;
    // Ollama-only request options; other providers ignore them (see the settings table in src/contract.js).
    if (typeof o.keepAlive === 'string' ? /^(-1|\d+(ms|s|m|h)?)$/.test(o.keepAlive.trim()) : Number.isFinite(o.keepAlive)) options.keepAlive = typeof o.keepAlive === 'string' ? o.keepAlive.trim() : o.keepAlive;
    if (o.seed !== undefined && o.seed !== '' && Number.isInteger(Number(o.seed))) options.seed = Number(o.seed);
    if (o.topP !== undefined && o.topP !== '' && Number.isFinite(Number(o.topP))) options.topP = Math.max(0, Math.min(1, Number(o.topP)));
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

  /**
   * Start a NEW run from an existing one with the same request, model, engine, settings and source, changing only what
   * is given (today: whether dependency installs are allowed). The earlier run and its results are left exactly as they are.
   */
  async rerun(id, { allowInstall } = {}) {
    const old = await this.store.load(id);
    if (!isExisting(old)) throw new ProjectError(409, 'only runs against an existing project can be re-run this way');
    const o = old.source;
    const source = o.projectId
      ? { projectId: o.projectId, workingMode: o.workingMode, publish: o.publish, autoApply: o.autoApply, allowInstall: allowInstall ?? o.allowInstall }
      : { mode: o.mode, directoryId: o.directoryId, repoUrl: o.repoUrl, ref: o.ref, workingMode: o.workingMode, publish: o.publish, autoApply: o.autoApply, allowInstall: allowInstall ?? o.allowInstall };
    const s = old.settings || {};
    return this.createRun({
      ...old.inputs,
      provider: old.provider, model: old.model, providerOptions: old.providerOptions, engine: old.engine,
      planner: { provider: old.plannerProvider, model: old.plannerModel, providerOptions: old.plannerOptions || undefined },
      settings: { maxParallel: s.maxParallel, maxAttempts: s.maxAttempts, maxAgentTurns: s.maxAgentTurns, tokenBudget: s.tokenBudget, timeoutMinutes: s.timeoutMinutes, taskDeadlineMinutes: s.taskDeadlineMinutes, maxRepeatedFailures: s.maxRepeatedFailures, deploy: s.deploy, pax: s.pax, paxSteps: s.paxSteps },
      source,
    });
  }

  /**
   * Change a stopped run and (optionally) carry on: a different provider, model, planner or engine, other limits, the
   * request text, or a note to the agents. Work already done is kept; the next attempt uses the new choices. A run that is
   * still executing can be interrupted first (`interrupt: true`). `resume: true` continues it right after saving.
   */
  async updateRun(id, body = {}) {
    if (this.active.has(id)) {
      if (body.interrupt !== true) throw new ProjectError(409, 'the run is still executing; interrupt it first (or send interrupt: true)');
      const running = this.active.get(id)?.promise;
      await this.cancel(id);
      await running?.catch(() => {});
    }
    const run = await this.store.load(id);
    if (!RESUMABLE.has(run.status) && run.status !== 'queued') throw new ProjectError(409, `a ${run.status.replace(/_/g, ' ')} run cannot be edited; only stopped, failed, cancelled or needs-attention runs can`);
    const changed = [];
    const set = (key, value) => {
      if (JSON.stringify(run[key]) !== JSON.stringify(value)) changed.push(key);
      run[key] = value;
    };

    // Model: provider, model, planner and engine are validated exactly as when a run starts (ready provider, key, model).
    const wantsModel = ['provider', 'model', 'providerOptions', 'planner', 'plannerProvider', 'plannerModel'].some((k) => body[k] !== undefined);
    let choice = null;
    if (wantsModel) {
      const providerChanged = body.provider !== undefined && body.provider !== run.provider;
      const follows = run.plannerProvider === run.provider; // the planner used the same provider as the agents
      const planner = body.planner !== undefined || body.plannerProvider !== undefined || body.plannerModel !== undefined
        ? body.planner
        : providerChanged && follows ? {} : { provider: run.plannerProvider, model: run.plannerModel, providerOptions: run.plannerOptions || undefined };
      choice = await this.resolveModelChoice({
        provider: body.provider ?? run.provider,
        model: body.model ?? (providerChanged ? '' : run.model),
        providerOptions: body.providerOptions ?? run.providerOptions,
        planner,
        plannerProvider: body.plannerProvider,
        plannerModel: body.plannerModel,
      });
      set('provider', choice.provider);
      set('providerLabel', choice.label);
      set('model', choice.model);
      set('providerOptions', choice.options);
      set('plannerProvider', choice.plannerProvider);
      set('plannerProviderLabel', choice.plannerLabel);
      set('plannerModel', choice.plannerModel);
      set('plannerOptions', choice.plannerProvider === choice.provider ? null : choice.plannerOptions);
    }
    if (body.engine !== undefined) {
      const engine = await this.resolveEngine(body.engine, choice || { provider: run.provider, model: run.model, label: run.providerLabel, options: run.providerOptions, plannerProvider: run.plannerProvider, plannerModel: run.plannerModel, plannerOptions: run.plannerOptions });
      set('engine', engine);
    }

    // Limits.
    if (body.settings && typeof body.settings === 'object') {
      const s = body.settings;
      const cur = run.settings;
      const clamp = (v, lo, hi, def) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? def : Math.min(hi, Math.max(lo, Math.round(Number(v)))));
      const next = {
        ...cur,
        maxParallel: clamp(s.maxParallel, 1, 8, cur.maxParallel),
        maxAttempts: clamp(s.maxAttempts, 1, 5, cur.maxAttempts),
        maxAgentTurns: clamp(s.maxAgentTurns, 2, 200, cur.maxAgentTurns),
        tokenBudget: clamp(s.tokenBudget, 10_000, 50_000_000, cur.tokenBudget),
        timeoutMinutes: clamp(s.timeoutMinutes, 1, 24 * 60, cur.timeoutMinutes),
        taskDeadlineMinutes: clamp(s.taskDeadlineMinutes, 1, 24 * 60, cur.taskDeadlineMinutes ?? this.cfg.defaults.taskDeadlineMinutes),
        maxRepeatedFailures: clamp(s.maxRepeatedFailures, 1, 5, cur.maxRepeatedFailures ?? this.cfg.defaults.maxRepeatedFailures),
        ...(typeof s.deploy === 'boolean' ? { deploy: s.deploy } : {}),
      };
      set('settings', next);
    }
    if (typeof body.allowInstall === 'boolean' && run.source) {
      if (run.source.allowInstall !== body.allowInstall) changed.push('allowInstall');
      run.source.allowInstall = body.allowInstall;
    }

    // The request itself, and notes to the agents.
    if (body.inputs && typeof body.inputs === 'object') {
      const inputs = Object.fromEntries(Object.entries(normalizeInputs({ ...run.inputs, ...body.inputs }, { existing: isExisting(run) })).map(([k, v]) => [k, redact(v)]));
      set('inputs', inputs);
      if (!run.plan) run.title = inputs.idea.split('\n')[0].slice(0, 90);
    }
    const note = typeof body.note === 'string' ? redact(body.note.trim()).slice(0, 2000) : '';
    if (note) {
      run.guidance = [...(run.guidance || []), { at: new Date().toISOString(), text: note }].slice(-20);
      changed.push('note');
    }

    if (!changed.length && body.resume !== true) throw new ProjectError(400, 'nothing to change');
    delete run.error;
    await this.store.save(run);
    if (changed.length) this.store.event(id, 'run.updated', { fields: changed, provider: run.provider, model: run.model, engine: run.engine || 'builtin', plannerProvider: run.plannerProvider, plannerModel: run.plannerModel, note: note || undefined });
    if (body.resume === true) return this.resume(id);
    return run;
  }

  /** Which engine runs the tasks of this run. A non-default engine is checked now, so a missing install fails fast. */
  async resolveEngine(requested, choice) {
    const id = (typeof requested === 'string' && requested.trim()) || this.cfg.defaultEngine || 'builtin';
    if (!ENGINE_IDS.includes(id)) throw new Error(`unknown agent engine "${id}" (use ${ENGINE_IDS.join(' or ')})`);
    if (id === 'builtin') return id;
    if (choice.provider === 'offline') throw new Error('The offline demo agents have no model, so they cannot use the FX engine. Use the built-in engine, or pick a real provider.');
    try {
      await loadEngineModule(this.cfg, id);
      checkProvider(id, this.makeProvider({ ...choice, providerOptions: choice.options }));
    } catch (e) {
      throw new Error(e.message);
    }
    return id;
  }

  /** The function that runs one task attempt for this run. Runs created before engines existed use the built-in loop. */
  agentRunner(run) {
    if (run.engine === 'fx') return (this.agentRunners.fx ||= makeFxRunner(this.cfg));
    return this.agentRunners.builtin;
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
        delete t.blockedReason; // capabilities are checked again when the run starts
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
    delete task.failure;
    delete task.blockedReason;
    for (const d of dependentsOf(run.plan.tasks, taskId)) {
      const t = run.plan.tasks.find((x) => x.id === d);
      if (t.status === 'blocked') {
        t.status = 'pending';
        delete t.blockedBy;
        delete t.blockedReason;
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
    const ws = new Workspace(this.store.workspaceDir(id), { launcher: computeLauncher(this.cfg), ...(existing ? { policy: existingProjectPolicy({ allowInstall: run.source.allowInstall }), protectGit: true } : {}) });
    // Factory notes (plan, lessons) live beside the workspace for existing projects, never inside the project.
    const notes = existing ? new Workspace(this.store.notesDir(id)) : ws;
    const save = () => this.store.save(run);
    const emit = (type, data) => this.store.event(id, type, data);
    const setStatus = async (status, extra = {}) => {
      run.status = status;
      await save();
      emit('run.status', { status, ...extra });
    };
    const rawProvider = this.makeProvider(run);
    const rawPlanner = this.makePlannerProvider(run);
    // Observation only (src/diagnostics.js): times each model call and run phase; it cannot change what the call returns.
    const diag = new RunDiagnostics({ dir: this.store.runDir(id), runId: id, engine: run.engine || 'builtin', secrets: () => [rawProvider.apiKey, rawPlanner.apiKey, this.cfg.githubToken, this.cfg.password] });
    // Order matters: the diagnostics wrapper is outermost, so a call's recorded duration includes any wait for a generation slot,
    // and the limiter (inner) reports that wait and the server's own load/generation timings on the reply.
    const provider = instrumentProvider(this.limited(rawProvider, run.provider), diag, 'agent');
    const plannerProvider = instrumentProvider(this.limited(rawPlanner, run.plannerProvider || run.provider), diag, 'planner');
    const caps = detectCapabilities(this.cfg, { engine: run.engine || 'builtin' });
    emit('capabilities', Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, v.available ? { available: true } : { available: false, reason: v.reason }])));
    const layer = async (name, state) => {
      if (run.layers[name] === state) return;
      run.layers[name] = state;
      await save();
      diag.phase(name, state);
      emit('layer', { layer: name, state });
    };
    for (const text of contractWarnings(run, this.providers)) emit('log', { level: 'warn', text });
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
        const planStart = Date.now();
        const plan = await runPlanner({ provider: plannerProvider, run, signal, track, caps, log: (text) => emit('log', { level: 'warn', text }) });
        run.planningMs = Date.now() - planStart;
        const depth = levels(plan.tasks);
        plan.tasks = plan.tasks.map((t) => ({ ...t, status: 'pending', attempts: [], level: depth[t.id] }));
        run.plan = plan;
        run.title = plan.product.name || run.title;
        await save();
        await this.writePlanArtifacts(run, existing ? notes : ws);
        emit('plan', { tasks: plan.tasks.length, levels: Math.max(...Object.values(depth)) + 1 });
        for (const text of plan.warnings || []) emit('log', { level: 'warn', text });
        for (const text of plan.adjustments || []) emit('log', { level: 'warn', text: `Plan adjusted: ${text}` });
        await layer('plan', 'done');
      }

      // ── Layer 2: spin up only the agents the plan needs ───────────────────────────────────
      run.agents = [...new Set(run.plan.tasks.map((t) => t.role))];
      await layer('agents', 'done');
      emit('agents', { roles: run.agents });

      // ── Execution loop (layers 3–6) ───────────────────────────────────────────────────────
      await setStatus('running');
      await layer('execution', 'active');
      await this.executionLoop(run, { ws, notes, provider, signal, track, emit, save, layer, diag, caps });
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
      this.collectMetrics(run);
      await save();
      emit('deliver', run.delivery);
      emit('run.status', { status: run.status });
    } catch (err) {
      const cancelled = signal.aborted;
      const reason = cancelled ? String(signal.reason?.message || 'cancelled') : err.message;
      for (const t of run.plan?.tasks || []) if (t.status === 'running') t.status = cancelled ? 'cancelled' : 'pending';
      run.error = this.hideSecrets(existing ? this.scrub(run, reason) : redact(reason));
      run.finishedAt = new Date().toISOString();
      run.status = cancelled ? 'cancelled' : err instanceof BudgetError ? 'needs_attention' : 'failed';
      this.collectMetrics(run);
      await save();
      emit('error', { message: run.error });
      emit('run.status', { status: run.status });
    } finally {
      clearTimeout(timer);
    }
    return run;
  }

  /**
   * Local inference is shared by every run on the same endpoint: wrap the provider so at most `maxLocalInference` generations
   * run at once there. Cloud providers keep their own limits (maxParallel); an offline or unknown provider is left alone.
   */
  limited(raw, providerId) {
    let key = null;
    try {
      const spec = this.providers.get(providerId);
      if (spec.type !== 'offline' && (spec.local || spec.type === 'ollama')) key = String(spec.baseUrl);
    } catch {
      /* an injected provider has no registry entry */
    }
    if (!key && raw?.local === true) key = `injected:${providerId}`;
    if (!key) return raw;
    const max = this.cfg.defaults.maxLocalInference || 1;
    let limiter = this.limiters.get(key);
    if (!limiter || limiter.max !== max) this.limiters.set(key, (limiter = new InferenceLimiter(max)));
    return limitProvider(raw, limiter);
  }

  /** Run-level accounting kept on the run record (observation only; it never feeds a decision). */
  collectMetrics(run) {
    try {
      run.metrics = buildRunMetrics(run, readRecords(this.store.runDir(run.id)), [...this.limiters.entries()].map(([endpoint, l]) => ({ endpoint: endpoint.replace(/^https?:\/\//, ''), ...l.snapshot() })), taskOutcomes(run.plan?.tasks || []));
    } catch {
      /* metrics must never fail a run */
    }
  }

  /** Mark tasks that promise something no available tool can produce as blocked, with the capability reason. Nothing is weakened. */
  async blockCapabilityGaps(run, { caps, save, emit }) {
    const { gaps } = checkTaskContracts({ tasks: run.plan.tasks }, caps);
    for (const t of run.plan.tasks) {
      const own = [...gaps.filter((g) => g.taskId === t.id)];
      for (const c of t.capabilities || []) {
        const cap = c === 'render_screenshot' ? caps.browser_render : c === 'generate_image' ? caps.image_generation : null;
        if (cap && !cap.available) own.push({ capability: c, reason: `${c} is required but not available: ${cap.reason}` });
      }
      if (!own.length || t.status !== 'pending') continue;
      t.status = 'blocked';
      t.blockedReason = { kind: 'capability', capability: own[0].capability, reason: own.map((g) => g.reason).join('; ') };
      t.failure = { category: 'capability', kind: 'capability', reason: t.blockedReason.reason };
      emit('task', { taskId: t.id, status: 'blocked', reason: t.blockedReason.reason, category: 'capability' });
    }
    await save();
  }

  async executionLoop(run, ctx) {
    const { signal, save, emit } = ctx;
    const running = new Map();
    const runningTasks = new Map();
    const tasks = run.plan.tasks;
    if (ctx.caps) await this.blockCapabilityGaps(run, ctx);
    while (!signal.aborted) {
      const blocked = propagateBlocked(tasks);
      if (blocked.length) {
        await save();
        for (const b of blocked) emit('task', { taskId: b, status: 'blocked', blockedBy: tasks.find((t) => t.id === b).blockedBy });
      }
      // Two tasks never write the same declared output at the same time (the planner is told this too; this is the runtime guarantee).
      const held = new Set([...runningTasks.values()].flatMap((t) => t.outputs || []));
      for (const t of readyTasks(tasks)) {
        if (running.size >= run.settings.maxParallel) break;
        if ((t.outputs || []).some((o) => held.has(o))) continue;
        (t.outputs || []).forEach((o) => held.add(o));
        t.status = 'running';
        runningTasks.set(t.id, t);
        const p = this.runTask(run, t, ctx)
          .catch(async (err) => {
            if (err instanceof BudgetError || signal.aborted) throw err;
            t.status = 'escalated';
            t.error = this.hideSecrets(redact(err.message));
            t.failure = { category: 'execution', kind: failureKind(err), reason: t.error };
            t.escalation = escalationFor(t, err.message);
            await save();
            emit('escalation', { taskId: t.id, reason: t.error, options: t.escalation.options });
          })
          .finally(() => {
            running.delete(t.id);
            runningTasks.delete(t.id);
          });
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

  async runTask(run, task, { ws, notes = ws, provider, signal: runSignal, track, emit, save, layer, diag, caps }) {
    const d = this.cfg.defaults;
    const maxAttempts = Math.min(task.maxAttempts || run.settings.maxAttempts, run.settings.maxAttempts);
    const repeatLimit = run.settings.maxRepeatedFailures ?? d.maxRepeatedFailures ?? 2;
    const deadlineMs = (run.settings.taskDeadlineMinutes ?? d.taskDeadlineMinutes ?? 30) * 60_000;
    const base = task.attemptBase || 0;
    const resumed = task.attempts.length > base ? task.attempts.at(-1) : null;
    let feedback = resumed ? resumed.feedback : null;
    let prevFp = resumed?.fingerprint || null;
    let repeats = resumed?.repeats || 0;
    let previousFailed = (resumed?.verification || []).filter((c) => !c.ok).map((c) => c.command);
    let reuse = resumed?.reuse || [];
    task.startedAt ||= new Date().toISOString();
    // One deadline for the whole task (all attempts), separate from the run's own time limit and from cancellation.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error(`task deadline of ${Math.round(deadlineMs / 60_000)} minute(s) reached`)), deadlineMs);
    const signal = AbortSignal.any([runSignal, deadline.signal]);
    const upstream = (task.dependsOn || [])
      .map((id) => run.plan.tasks.find((t) => t.id === id))
      .filter((t) => t?.status === 'completed' || t?.status === 'skipped')
      .map((t) => ({ id: t.id, role: t.role, files: t.verified?.files || [], summary: t.status === 'completed' ? String(t.result?.summary || '').slice(0, 300) : 'skipped' }));

    /** The task cannot go on: record why in one place (status, failure, escalation) and tell the run. */
    const stop = async (status, failure, attempt) => {
      task.status = status;
      task.error = this.hideSecrets(redact(failure.reason));
      task.failure = { ...failure, reason: task.error, attempts: task.attempts.length };
      if (status === 'blocked') task.blockedReason = { kind: failure.category, capability: failure.capability, reason: task.error };
      else task.escalation = escalationFor(task, failure.reason);
      await this.recordLesson(run, notes, task, attempt, emit, { unresolved: true });
      await save();
      emit(status === 'blocked' ? 'task' : 'escalation', status === 'blocked' ? { taskId: task.id, status, reason: task.error, category: failure.category } : { taskId: task.id, reason: task.error, category: failure.category, options: task.escalation.options });
    };

    try {
      let last = null;
      for (let n = task.attempts.length - base + 1; n <= maxAttempts; n++) {
        if (runSignal.aborted) return;
        const attempt = { n, startedAt: new Date().toISOString(), provider: run.provider, model: run.model, verification: [] };
        task.attempts.push(attempt);
        task.status = 'running';
        await save();
        emit('task', { taskId: task.id, status: 'running', attempt: n, role: task.role, title: task.title });

        const lessons = await readLessons(notes);
        let out;
        const t0 = Date.now();
        try {
          out = await this.agentRunner(run)({
            provider, ws, run, task, attempt: n, maxAttempts, feedback, upstream, lessons, reuse,
            settings: run.settings, signal, track, diag, caps, cfg: this.cfg,
            emit: (type, data) => emit(type, { ...data, attempt: n }),
          });
        } catch (err) {
          if (err instanceof BudgetError || runSignal.aborted) throw err;
          const kind = deadline.signal.aborted ? 'deadline' : failureKind(err);
          // The HTTP layer has already retried transient errors, so the task stops here (as it always did) with the cause classified.
          out = { ok: false, fatal: true, error: err.message, failure: { category: deadline.signal.aborted ? 'deadline' : 'execution', kind, transient: isTransient(kind) } };
        }
        attempt.agentMs = Date.now() - t0;
        if (runSignal.aborted) return;
        if (out.tools) attempt.tools = out.tools;
        if (out.ops) attempt.ops = out.ops;
        if (out.workDigest) attempt.workDigest = out.workDigest;
        last = attempt;

        if (!out.ok) {
          attempt.ok = false;
          attempt.error = this.hideSecrets(redact(String(out.error || 'the agent did not complete the task')));
          attempt.failure = { category: 'execution', kind: 'agent', ...(out.failure || {}), reason: attempt.error };
          attempt.fingerprint = failureFingerprint(attempt);
          repeats = attempt.fingerprint === prevFp ? repeats + 1 : 1;
          prevFp = attempt.fingerprint;
          attempt.repeats = repeats;
          feedback = buildFeedback({ attemptNo: n, maxAttempts, error: attempt.error, tools: out.tools, repeats });
          previousFailed = [];
        } else {
          attempt.result = out.result;
          // ── Layer 5: verify before moving on. The agent's own words are not an input to this. ──
          await layer('verification', 'active');
          const v = await this.verifyTask(task, ws, run, signal, { result: out.result, tools: out.tools, caps, previousFailed });
          if (runSignal.aborted) return;
          const checks = v.results;
          attempt.verification = checks;
          attempt.partial = v.partial || undefined;
          emit('verify', { taskId: task.id, attempt: n, partial: v.partial || undefined, results: checks.map(({ command, criterion, check, exitCode, ok, durationMs, output, state, capability }) => ({ command, criterion, check, exitCode, ok, durationMs, output: redact(output).slice(-3000), ...(state ? { state } : {}), ...(capability ? { capability } : {}) })) });
          const failed = checks.filter((c) => !c.ok);
          attempt.ok = failed.length === 0 && !v.partial;
          if (attempt.ok) {
            attempt.finishedAt = new Date().toISOString();
            task.status = 'completed';
            task.result = out.result;
            delete task.failure;
            task.verified = { at: attempt.finishedAt, outputs: checks.flatMap((c) => c.artifact || []).map(({ path: p, bytes, kind, width, height }) => ({ path: p, bytes, kind, ...(width ? { width, height } : {}) })), files: [...new Set([...(out.result.files || []), ...checks.flatMap((c) => (c.artifact || []).map((a) => a.path))])].filter(Boolean) };
            if (task.attempts.length > 1) await this.recordLesson(run, notes, task, attempt, emit);
            await save();
            emit('task', { taskId: task.id, status: 'completed', attempt: n, summary: out.result.summary, verified: task.verified.outputs.length });
            return;
          }
          const gap = failed.find((c) => c.capability);
          attempt.failure = gap
            ? { category: 'capability', kind: 'capability', capability: gap.capability, reason: gap.output }
            : { category: 'acceptance', kind: 'verification', reason: headline(failed.map((c) => `${c.criterion || c.command}: ${c.output}`).join('\n')) };
          attempt.fingerprint = failureFingerprint(attempt);
          repeats = attempt.fingerprint === prevFp ? repeats + 1 : 1;
          prevFp = attempt.fingerprint;
          attempt.repeats = repeats;
          reuse = checks.filter((c) => c.ok && c.artifact?.length).flatMap((c) => c.artifact.map((a) => a.path));
          attempt.reuse = reuse;
          previousFailed = failed.map((c) => c.command);
          const hints = [];
          if (failed.some((c) => c.check === 'artifact' && outputKind(c.command.replace(/^artifact /, '')) === 'image') && caps?.browser_render?.available) hints.push('An image is made by writing an HTML file with write_file and then calling render_screenshot; describing it in text creates nothing.');
          if (v.partial) hints.push('Only the checks that failed last time were re-run; the full set runs once they pass.');
          feedback = buildFeedback({ attemptNo: n, maxAttempts, failed, reuse, tools: out.tools, repeats, hints });
        }

        // ── Layer 6: feedback ──
        attempt.finishedAt = new Date().toISOString();
        attempt.feedback = this.hideSecrets(redact(feedback));
        const f = attempt.failure;
        const final = deadline.signal.aborted ? { category: 'deadline', reason: `the task deadline of ${Math.round(deadlineMs / 60_000)} minute(s) was reached` }
          : f.category === 'capability' ? f
          : STOP_KINDS.has(f.kind) ? { ...f, reason: `${f.kind.replace(/_/g, ' ')}: retrying cannot help. ${f.reason}` }
          : out.fatal ? { ...f, reason: attempt.error }
          : repeats >= repeatLimit && !f.transient ? { category: 'no_progress', kind: f.kind, reason: `the same failure repeated ${repeats} times in a row without progress: ${f.reason}` }
          : null;
        await layer('feedback', 'active');
        await save();
        emit('feedback', { taskId: task.id, attempt: n, category: f.category, kind: f.kind || null, transient: f.transient || undefined, repeats, willRetry: !final && n < maxAttempts, message: redact(feedback).slice(0, 3000), headline: headline(feedback) });
        if (final) return stop(final.category === 'capability' ? 'blocked' : 'escalated', final, attempt);
      }

      // Attempts exhausted: escalate, naming the failure category of the last attempt.
      const f = last?.failure || { category: 'execution', reason: 'no attempt ran' };
      return stop('escalated', f, last);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Check a task against the workspace as it is now: every declared output (present, non-empty, valid for its type), every
   * file the agent claimed, and the task's verify commands. A task with none of these must at least have executed some work.
   * `previousFailed` (the checks that failed last time) are re-run first; the rest run only once those pass, so a retry
   * does not re-pay for checks it did not touch, and completion still requires the full set.
   */
  async verifyTask(task, ws, run, signal, { result = {}, tools = null, caps = null, previousFailed = [] } = {}) {
    const existing = isExisting(run);
    const imageGap = !(caps?.browser_render?.available || caps?.image_generation?.available);
    const checks = [];
    const declared = new Set((task.outputs || []).map((o) => o.replace(/\/$/, '')));
    for (const o of task.outputs || []) {
      checks.push({ key: `artifact ${o}`, run: async () => {
        const r = await checkOutput(ws, o);
        if (!r.ok && outputKind(o) === 'image' && imageGap) return { ...r, capability: 'image', output: `${r.output}. No available tool can produce an image (no browser to render a screenshot, no image provider), so retrying cannot help.` };
        return r;
      } });
    }
    for (const command of task.verify || []) {
      checks.push({ key: command, run: async () => {
        const r = await ws.runCommand(command, { timeoutMs: run.settings.commandTimeoutMs, signal });
        const output = `${r.stdout}\n${r.stderr}`.trim();
        if (existing) {
          // A command that already failed at baseline passes the task if it fails in no new way.
          const cls = classifyCheck(run.project.baseline?.find((b) => b.command === command), r);
          return { command, criterion: `command exits 0: ${command}`, check: 'command', exitCode: r.exitCode, ok: cls.ok, state: cls.state, newFailures: cls.newFailures, durationMs: r.durationMs, output };
        }
        return { command, criterion: `command exits 0: ${command}`, check: 'command', exitCode: r.exitCode, ok: r.exitCode === 0, durationMs: r.durationMs, output };
      } });
    }
    for (const f of [...new Set(result.claimed || [])].filter((x) => typeof x === 'string' && x.trim() && !x.endsWith('/') && !declared.has(x))) {
      checks.push({ key: `claimed file ${f}`, run: async () => {
        const t0 = Date.now();
        const v = await validateArtifact(ws, f);
        return { command: `claimed file ${f}`, criterion: `file ${f} named in complete_task`, check: 'claim', exitCode: v.ok ? 0 : 1, ok: v.ok, durationMs: Date.now() - t0, output: v.ok ? '' : `${v.detail} (the agent said it produced this file)`, artifact: v.ok ? [v] : undefined };
      } });
    }
    if (!(task.outputs || []).length && !(task.verify || []).length) {
      checks.push({ key: 'executed work', run: async () => {
        const wrote = tools ? tools.writes : (result.files || []).length;
        const ran = tools ? tools.commandsOk : (result.commandsRun || []).filter((c) => c.exitCode === 0).length;
        const ok = wrote > 0 || ran > 0;
        return { command: 'executed work', criterion: 'the task has no output or verify command, so it must at least have executed work', check: 'work', exitCode: ok ? 0 : 1, ok, durationMs: 0, output: ok ? '' : 'no file was written and no command succeeded during this attempt; the agent only described the work' };
      } });
    }

    const first = checks.filter((c) => previousFailed.includes(c.key));
    const rest = checks.filter((c) => !previousFailed.includes(c.key));
    const results = [];
    const runAll = async (list) => {
      for (const c of list) {
        if (signal?.aborted) break;
        const r = await c.run();
        const { key, ...clean } = { ...r, key: c.key };
        results.push(clean);
      }
    };
    if (first.length && rest.length) {
      await runAll(first);
      if (results.some((r) => !r.ok)) return { results, partial: true };
    }
    await runAll(first.length && rest.length ? rest : checks);
    return { results, partial: false };
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
  /**
   * Remove the exact values of every configured credential from text that is stored or shown. redact() only knows common key
   * shapes; a provider that echoes back a credential of any other shape in an error body must not get it persisted.
   */
  hideSecrets(text) {
    return hideSecretValues(text, [...this.providers.all().map((p) => p.apiKey), this.cfg.githubToken, this.cfg.password]);
  }

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
    // When installs are authorized, install what the project needs in the isolated workspace first; otherwise the checks
    // cannot run on a fresh clone and the baseline says nothing. Your own directory is never touched by this.
    const installs = src.allowInstall ? installCommands(insp, ws) : [];
    run.project.install = [];
    if (installs.length) {
      await stage('baseline', 'active', `Installing dependencies (${installs.map((i) => i.command).join(', ')}), then running ${insp.baselineCommands.length} check(s)`);
      run.project.install = await installDependencies(ws, installs, {
        timeoutMs: Math.max(run.settings.commandTimeoutMs, 600_000),
        signal,
        onResult: (r) => emit('install', { command: r.command, ecosystem: r.ecosystem, status: r.status, exitCode: r.exitCode, durationMs: r.durationMs, output: r.output.slice(-1000) }),
      });
      if (signal.aborted) throw new Error('cancelled');
    }
    await stage('baseline', 'active', `Running ${insp.baselineCommands.length} check(s) before any change`);
    run.project.baseline = await runChecks(ws, insp.baselineCommands, {
      timeoutMs: run.settings.commandTimeoutMs,
      installsAllowed: Boolean(src.allowInstall),
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
    if (src.mode === 'local' && src.autoApply && !signal.aborted) await this.autoApplyLocal(run, { emit });
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
    if (run.projectId && (await this.registry.find(run.projectId).catch(() => null))) await this.registry.locate(run.projectId, { purpose: 'publish changes' });
    await this.assertApproved(run, 'publish them');
    const ws = new Workspace(this.store.workspaceDir(id), { protectGit: true, launcher: computeLauncher(this.cfg) });
    run.delivery.publication = await this.publishNow(run, { ws, emit: (t, d) => this.store.event(id, t, d), pullRequest });
    await writeReport(run, this.store.deliveryDir(id));
    await this.store.save(run);
    return run;
  }

  /**
   * "Apply automatically" (chosen when the run was started): once the run is delivered AND ready — source protection
   * clean, every checklist item passed, no new failures — approve exactly these changes and write them into the source
   * directory with the usual conflict check. Anything less leaves the result for a person to review; nothing is forced.
   */
  async autoApplyLocal(run, { emit }) {
    const d = run.delivery;
    d.local ||= {};
    const skip = (reason) => { d.local.autoApply = { state: 'skipped', reason, at: new Date().toISOString() }; emit('apply', { mode: 'working-tree', ok: false, auto: true, skipped: reason }); };
    if (!d.integrity?.ok) return skip('source protection did not pass');
    if (!run.changes?.files?.length) return skip('the run changed no files');
    if (!d.readiness?.ready) return skip(`the run is not ready for review (${(d.readiness?.reasons || [])[0] || 'checks did not all pass'})`);
    try {
      const dir = await this.sourceDir(run, { purpose: 'apply changes', writable: true });
      run.review = { decision: 'approved', at: new Date().toISOString(), note: 'Approved automatically: "apply automatically" was chosen when the run was started, and the run was verified and ready.', changesHash: await this.changesHash(run), files: run.changes.files.length, auto: true };
      this.store.event(run.id, 'review', { decision: 'approved', files: run.review.files, auto: true });
      await this.applyNow(run, dir, 'working-tree');
      d.local.autoApply = { state: 'applied', at: new Date().toISOString() };
    } catch (e) {
      const reason = e.conflicts?.length ? `${e.conflicts.length} file(s) changed in your directory since the run started, so nothing was written` : this.scrub(run, e.message);
      d.local.autoApply = { state: 'failed', reason, at: new Date().toISOString() };
      emit('apply', { mode: 'working-tree', ok: false, auto: true, error: reason });
    }
  }

  /** Write the approved changes into the source directory (or export a branch). The caller has checked approval. */
  async applyNow(run, dir, mode) {
    const wsDir = this.store.workspaceDir(run.id);
    const emit = (t, d) => this.store.event(run.id, t, d);
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
  }

  /**
   * Explicit apply action (local runs): write the result into the source directory, or export a branch.
   * `approve: true` records an approval of these exact changes first, so reviewing and applying is one step.
   */
  async applyLocal(id, { mode = 'working-tree', approve = false } = {}) {
    if (this.active.has(id)) throw new ProjectError(409, 'run is still executing');
    let run = await this.store.load(id);
    if (!isExisting(run) || run.source.mode !== 'local') throw new ProjectError(409, 'only local-directory runs can be applied');
    if (!run.delivery?.integrity?.ok) throw new ProjectError(409, 'the run has not been delivered with a clean source-protection check');
    const dir = await this.sourceDir(run, { purpose: 'apply changes', writable: true });
    if (approve === true) {
      const current = run.review?.decision === 'approved' && run.review.changesHash === (await this.changesHash(run));
      if (!current) run = await this.review(id, { decision: 'approve', note: 'Approved when applying.' });
    }
    await this.assertApproved(run, mode === 'branch' ? 'add them to your repository' : 'apply them to your directory');
    await this.applyNow(run, dir, mode);
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
    const ws = new Workspace(this.store.workspaceDir(id), { launcher: computeLauncher(this.cfg), ...(isExisting(run) ? { protectGit: true } : {}) });
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

  /**
   * Re-run the run's end-of-run checks in its workspace and classify each against the baseline. The result is
   * recorded as `run.reverify`, separate from the verdict recorded when the run finished, so a recheck never
   * rewrites history; it shows what the workspace looks like now.
   */
  async reverify(id) {
    if (this.active.has(id)) throw new ProjectError(409, 'the run is still executing; wait for it to finish');
    const run = await this.store.load(id);
    if (!run.plan || !fs.existsSync(this.store.workspaceDir(id))) throw new ProjectError(409, 'the run has no workspace to check');
    const existing = isExisting(run);
    const ws = new Workspace(this.store.workspaceDir(id), { launcher: computeLauncher(this.cfg), ...(existing ? { policy: existingProjectPolicy({ allowInstall: run.source.allowInstall }), protectGit: true } : {}) });
    const base = run.project?.baseline || [];
    const commands = [...new Set([...(run.plan.finalVerify || []), ...base.map((b) => b.command)])].filter(Boolean);
    if (!commands.length) throw new ProjectError(409, 'this run has no checks to run (no baseline or final verification commands)');
    const controller = new AbortController();
    this.active.set(id, { controller, promise: Promise.resolve() });
    try {
      const results = [];
      for (const command of commands) {
        const r = await ws.runCommand(command, { timeoutMs: run.settings.commandTimeoutMs, signal: controller.signal });
        const cls = classifyCheck(base.find((b) => b.command === command), r);
        results.push({ command, exitCode: r.exitCode, ok: cls.ok, state: cls.state, newFailures: cls.newFailures, durationMs: r.durationMs, output: redact(`${r.stdout}\n${r.stderr}`.trim()).slice(-4000) });
      }
      run.reverify = { at: new Date().toISOString(), results };
      await this.store.save(run);
      this.store.event(id, 'reverify', { results: results.map(({ command, state, ok, exitCode }) => ({ command, state, ok, exitCode })) });
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

