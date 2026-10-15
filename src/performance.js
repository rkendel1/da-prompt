// Which model did what, and how well it went: per run, and as a track record across runs.
// Built from the run record (each task attempt carries the model that made it; run.planning carries the planner's record)
// and, for one run, its diagnostics records (model calls, time in the model, tokens). Observation only, like
// src/diagnostics.js: nothing here feeds a decision, retry, verification or delivery. Attempts made before attempts carried
// their model are attributed to the run's agent model and counted as `inferred`.

export const STAGE_ORDER = ['planner', 'product', 'engineer', 'design', 'qa', 'devops', 'research', 'summary'];

const key = (provider, model) => `${provider}|${model}`;
const ms = (a, b) => {
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) && d >= 0 ? d : 0;
};

const emptyStage = () => ({ tasks: 0, verified: 0, escalated: 0, attempts: 0, attemptsVerified: 0, firstTry: 0, firstTryVerified: 0, attemptMs: 0, finishedAttempts: 0 });

function attemptModel(run, a) {
  if (a.model?.provider) return { ...a.model, inferred: false };
  return { provider: run.provider, label: run.providerLabel || run.provider, model: run.model, via: 'default', inferred: true };
}

/** How the planner did: planned (by the model), standard (the factory's standard plan was used), failed, cancelled, or planning. */
function planOutcome(run) {
  const p = run.planning;
  if (p?.source === 'standard') return 'standard';
  if (run.plan) return 'planned';
  if (['queued', 'planning'].includes(run.status)) return 'planning';
  if (run.status === 'cancelled' || run.status === 'interrupted') return 'cancelled';
  return 'failed';
}

/**
 * One run: every model that took part, the stages it served, and its results.
 * @param {object} run       the stored run record
 * @param {object[]} records the run's diagnostics records (optional)
 */
export function runModelPerformance(run, records = []) {
  const models = new Map();
  const entry = (provider, label, model) => {
    const k = key(provider, model);
    if (!models.has(k)) models.set(k, { key: k, provider, label: label || provider, model, stages: {}, plan: null, inferred: 0, calls: { count: 0, failed: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, tokensUnavailable: 0 } });
    return models.get(k);
  };
  const stageOf = (e, s) => (e.stages[s] ||= emptyStage());

  if (run.plannerModel || run.planning) {
    const p = run.planning || {};
    const e = entry(p.provider || run.plannerProvider || run.provider, p.providerLabel || run.plannerProviderLabel || run.providerLabel, p.model || run.plannerModel || run.model);
    stageOf(e, 'planner');
    e.plan = { outcome: planOutcome(run), attempts: p.attempts ?? null, rejected: p.rejections?.length ?? null, rejections: (p.rejections || []).map((r) => r.slice(0, 3)), repairs: p.repairs || [], durationMs: p.durationMs ?? null, error: p.error || null, recorded: Boolean(run.planning) };
  }

  const tasks = [];
  for (const t of run.plan?.tasks || []) {
    const attempts = (t.attempts || []).map((a, i) => {
      const m = attemptModel(run, a);
      const e = entry(m.provider, m.label, m.model);
      const s = stageOf(e, t.role);
      const finished = Boolean(a.finishedAt) || a.ok === true;
      s.attempts += 1;
      if (a.ok) s.attemptsVerified += 1;
      // The first attempt of each fresh set (a retry from an escalation starts a new set at n = 1).
      if (a.n === 1 || (i === 0 && a.n == null)) {
        s.firstTry += 1;
        if (a.ok) s.firstTryVerified += 1;
      }
      if (finished) {
        s.finishedAttempts += 1;
        s.attemptMs += ms(a.startedAt, a.finishedAt);
      }
      if (m.inferred) e.inferred += 1;
      return { n: a.n, key: e.key, provider: m.provider, label: m.label, model: m.model, via: m.via, inferred: m.inferred, ok: a.ok === true, finished, durationMs: finished ? ms(a.startedAt, a.finishedAt) : null, error: a.ok ? null : String(a.error || (a.feedback ? a.feedback.split('\n').find((l) => l.trim() && !l.startsWith('$')) || '' : '')).slice(0, 200) || null };
    });
    // Every model that worked on the task is counted once for it; the outcome goes to the model that made the last attempt.
    for (const k of new Set(attempts.map((a) => a.key))) stageOf(models.get(k), t.role).tasks += 1;
    const last = attempts.at(-1);
    if (last && t.status === 'completed') stageOf(models.get(last.key), t.role).verified += 1;
    if (last && t.status === 'escalated') stageOf(models.get(last.key), t.role).escalated += 1;
    tasks.push({ id: t.id, title: t.title, role: t.role, status: t.status, attempts });
  }

  for (const r of records) {
    if (r.type !== 'call' || !r.provider || !r.model) continue;
    const e = models.get(key(r.provider, r.model)) || entry(r.provider, r.provider, r.model);
    if (r.purpose === 'summary') stageOf(e, 'summary');
    e.calls.count += 1;
    if (r.outcome === 'error') e.calls.failed += 1;
    e.calls.durationMs += r.durationMs || 0;
    if (r.usage?.source === 'provider') {
      e.calls.inputTokens += r.usage.input || 0;
      e.calls.outputTokens += r.usage.output || 0;
    } else if (r.outcome === 'ok') e.calls.tokensUnavailable += 1;
  }

  const order = (e) => Math.min(...Object.keys(e.stages).map((s) => STAGE_ORDER.indexOf(s)).filter((i) => i >= 0), 99);
  return {
    routing: {
      agent: { provider: run.provider, label: run.providerLabel || run.provider, model: run.model },
      planner: { provider: run.plannerProvider || run.provider, label: run.plannerProviderLabel || run.plannerProvider || run.providerLabel, model: run.plannerModel || run.model },
      roles: run.roleModels || {},
      retry: run.retryModel || null,
    },
    models: [...models.values()].sort((a, b) => order(a) - order(b)),
    tasks,
    callsRecorded: records.some((r) => r.type === 'call'),
  };
}

/**
 * The track record across runs: per model, per stage, summed. `runs` are full run records. Small sample sizes are the
 * caller's to show; nothing here ranks or recommends.
 */
export function aggregatePerformance(runs) {
  const models = new Map();
  for (const run of runs) {
    let perf;
    try {
      perf = runModelPerformance(run);
    } catch {
      continue; // a malformed old record must not hide the others
    }
    for (const m of perf.models) {
      const a = models.get(m.key) || { key: m.key, provider: m.provider, label: m.label, model: m.model, runs: 0, lastUsedAt: null, inferred: 0, stages: {}, plans: { total: 0, planned: 0, standard: 0, failed: 0, cancelled: 0, attempts: 0, rejected: 0, repairs: 0 } };
      models.set(m.key, a);
      a.runs += 1;
      a.inferred += m.inferred;
      const at = run.startedAt || run.createdAt;
      if (at && (!a.lastUsedAt || at > a.lastUsedAt)) a.lastUsedAt = at;
      for (const [s, v] of Object.entries(m.stages)) {
        const t = (a.stages[s] ||= emptyStage());
        for (const f of Object.keys(t)) t[f] += v[f] || 0;
      }
      if (m.plan && m.plan.outcome !== 'planning') {
        a.plans.total += 1;
        if (a.plans[m.plan.outcome] !== undefined) a.plans[m.plan.outcome] += 1;
        a.plans.attempts += m.plan.attempts || 0;
        a.plans.rejected += m.plan.rejected || 0;
        a.plans.repairs += m.plan.repairs?.length || 0;
      }
    }
  }
  return { models: [...models.values()].sort((x, y) => String(y.lastUsedAt).localeCompare(String(x.lastUsedAt))), runs: runs.length };
}
