// Inference diagnostics: one small, privacy-safe record per model call and per run phase, kept next to the run
// (<run dir>/diagnostics.jsonl). They are observations only: nothing here feeds task decisions, retries, verification,
// the checklist or delivery, and recording can never fail a call (every write is guarded).
//
// What is stored: identifiers (run, task, attempt), provider/model/engine, purpose, timings, token counts, counts of
// messages/characters/tool calls, a classified failure kind and a short redacted message. What is never stored: prompts,
// file contents, model replies, headers, keys. Timings are `factory-measured` (monotonic clock around the call);
// token counts are `provider-reported` or explicitly `unavailable`.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { redact, hideSecretValues } from './security.js';

export const DIAG_FILE = 'diagnostics.jsonl';
export const DIAG_SCHEMA = 'da-prompt.diagnostics/1';
export const MAX_RECORDS = 5000; // per run; later records are counted, not stored
const MAX_MESSAGE = 300;
const MAX_LIST = 8;

/** Failure kinds shared by both engines. */
export const FAILURE_KINDS = ['authentication', 'model_not_found', 'rate_limited', 'provider_error', 'connection', 'timeout', 'first_response_timeout', 'cancelled', 'budget', 'malformed_tool_call', 'malformed_response', 'other'];

const callContext = new AsyncLocalStorage();

/** Called by the HTTP retry loop: counts a retry against the model call that is currently running (if any). */
export function noteRetry(reason) {
  const c = callContext.getStore();
  if (!c) return;
  c.retries += 1;
  if (c.retryReasons.length < MAX_LIST) c.retryReasons.push(String(reason || 'unknown').slice(0, 40));
}

/** Classify an error from either engine without depending on where it was thrown. */
export function failureKind(err) {
  const code = String(err?.code || '');
  const kind = String(err?.kind || '');
  const msg = String(err?.message ?? err ?? '');
  if (code === 'LIBFX_MODEL_TIMEOUT') return 'first_response_timeout';
  if (code === 'LIBFX_MODEL_CANCELLED' || code === 'ABORT_ERR' || /^cancelled$/i.test(msg)) return 'cancelled';
  if (kind === 'malformed_tool_call') return 'malformed_tool_call';
  if (kind === 'rate_limited' || /rate limited|HTTP 429/i.test(msg)) return 'rate_limited';
  if (kind === 'server_error' || /provider-side error|HTTP 5\d\d/i.test(msg)) return 'provider_error';
  if (code === 'LIBFX_MODEL_CREDENTIAL_MISSING' || code === 'LIBFX_MODEL_CREDENTIAL_INVALID' || /authentication failed|HTTP 40[13]/i.test(msg)) return 'authentication';
  if (/model or endpoint not found|HTTP 404/i.test(msg)) return 'model_not_found';
  if (/token budget/i.test(msg)) return 'budget';
  if (code === 'ETIMEDOUT' || /timed out/i.test(msg)) return 'timeout';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|connection failed|connection refused|host not found/i.test(`${code} ${msg}`)) return 'connection';
  if (/invalid JSON|malformed/i.test(msg)) return 'malformed_response';
  return 'other';
}

/** A bounded, secret-free version of an error message. `secrets` are exact values to remove (keys, tokens). */
export function safeMessage(text, secrets = []) {
  return redact(hideSecretValues(text, secrets)).replace(/[\0\r]/g, '').slice(0, MAX_MESSAGE);
}

/** Size of a request without serializing it: counts messages and the characters of their text. */
export function requestSize(req = {}) {
  let chars = String(req.system || '').length;
  const messages = req.messages || [];
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else for (const b of m.content || []) chars += String(b.text ?? (typeof b.content === 'string' ? b.content : b.content ? JSON.stringify(b.content) : '') ?? '').length + (b.input ? JSON.stringify(b.input).length : 0);
  }
  return { messages: messages.length, chars, tools: (req.tools || []).length };
}

/**
 * Token usage as the provider reported it. Adapters set `usage.reported` (false when the response had no usage block);
 * a provider that does not say is believed only when it returned a positive count. Never invents a number.
 */
export function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return { source: 'unavailable' };
  const input = Number(usage.input_tokens ?? usage.inputTokens);
  const output = Number(usage.output_tokens ?? usage.outputTokens);
  const known = Number.isFinite(input) || Number.isFinite(output);
  const reported = usage.reported === undefined ? (input > 0 || output > 0) : Boolean(usage.reported);
  if (!known || !reported) return { source: 'unavailable' };
  return { source: 'provider', input: Number.isFinite(input) ? input : null, output: Number.isFinite(output) ? output : null };
}

const PURPOSES = { plan: 'plan', task: 'agent_turn', summary: 'summary', chat: 'chat', test: 'test' };
export const purposeOf = (kind) => PURPOSES[kind] || 'other';

const now = () => performance.now();

export class RunDiagnostics {
  /**
   * @param {object} o
   * @param {string} o.dir          the run's directory (diagnostics.jsonl lives here)
   * @param {string} o.runId
   * @param {string} o.engine       builtin | fx
   * @param {() => string[]} [o.secrets]  exact secret values to scrub from stored messages
   */
  constructor({ dir, runId, engine = 'builtin', secrets = () => [] }) {
    this.file = dir ? path.join(dir, DIAG_FILE) : null;
    this.runId = runId;
    this.engine = engine;
    this.secrets = secrets;
    this.seq = 0;
    this.stored = 0;
    this.dropped = 0;
    this.t0 = now();
  }

  write(rec) {
    this.seq += 1;
    if (!this.file) return;
    if (this.stored >= MAX_RECORDS) {
      this.dropped += 1;
      if (this.dropped === 1) this.append({ type: 'truncated', v: 1, at: new Date().toISOString(), limit: MAX_RECORDS });
      return;
    }
    this.stored += 1;
    this.append({ ...rec, v: 1, seq: this.seq });
  }

  append(rec) {
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
    } catch {
      /* diagnostics must never affect a run */
    }
  }

  /** Run phase transitions (the factory's layers), timed on the monotonic clock relative to this start. */
  phase(layer, state) {
    try {
      this.write({ type: 'phase', at: new Date().toISOString(), runId: this.runId, layer, state, tMs: Math.round(now() - this.t0) });
    } catch {
      /* ignore */
    }
  }

  /**
   * Time one model call made through provider.chat(). `fn` performs the call; its result and errors pass through untouched.
   * `ctx` = { provider (instance), role: 'agent'|'planner' }.
   */
  async call(ctx, req, fn) {
    const meta = req?.meta || {};
    const store = { retries: 0, retryReasons: [] };
    const started = new Date().toISOString();
    const t = now();
    const tail = (extra) => this.safely(() => this.record(ctx, req, meta, started, now() - t, store, extra));
    try {
      const res = await callContext.run(store, fn);
      tail({ res });
      return res;
    } catch (err) {
      tail({ err, aborted: Boolean(req?.signal?.aborted) });
      throw err;
    }
  }

  record(ctx, req, meta, started, elapsed, store, { res, err, aborted } = {}) {
    const d = ctx.provider?.describe?.() || {};
    const model = meta.kind === 'plan' ? d.plannerModel || d.model : d.model;
    const uses = (res?.content || []).filter((c) => c.type === 'tool_use');
    const kind = err ? (aborted ? 'cancelled' : failureKind(err)) : null;
    this.write({
      type: 'call',
      at: started,
      runId: this.runId,
      engine: this.engine,
      role: ctx.role,
      provider: d.name || ctx.provider?.name || null,
      model: model || null,
      dialect: d.dialect || null,
      purpose: purposeOf(meta.kind),
      taskId: meta.task?.id,
      attempt: meta.attempt,
      durationMs: Math.round(elapsed),
      timing: 'factory-measured',
      firstResponse: { supported: false, ms: null }, // chat() resolves once, with the whole reply
      outcome: err ? (kind === 'cancelled' ? 'cancelled' : 'error') : 'ok',
      failure: err ? { kind, message: safeMessage(err.message, this.secrets()) } : null,
      retries: store.retries,
      retryReasons: store.retryReasons,
      usage: err ? { source: 'unavailable' } : usageOf(res?.usage),
      request: { ...requestSize(req), outputLimit: ctx.provider?.maxTokens ?? null },
      response: err ? null : { toolCalls: uses.length, tools: uses.slice(0, MAX_LIST).map((u) => String(u.name).slice(0, 40)), stopReason: res?.stop_reason || null },
    });
  }

  /** One record for an FX prompt: fx runs the model loop itself, so the factory sees prompts, not individual requests. */
  fxPrompt({ ctx, taskId, attempt, durationMs, firstEventMs, modelRequests, requestMs, toolCalls, result, err, retries = 0, provider }) {
    this.safely(() => {
      const kind = err ? failureKind(err) : null;
      this.write({
        type: 'call',
        at: new Date().toISOString(),
        runId: this.runId,
        engine: 'fx',
        role: 'agent',
        provider: provider?.name || null,
        model: provider?.model || null,
        dialect: provider?.dialect || null,
        purpose: 'agent_prompt',
        taskId,
        attempt,
        durationMs: Math.round(durationMs),
        timing: 'factory-measured',
        firstResponse: firstEventMs == null ? { supported: true, ms: null } : { supported: true, ms: Math.round(firstEventMs), basis: 'first streamed event' },
        outcome: err ? (kind === 'cancelled' ? 'cancelled' : 'error') : 'ok',
        failure: err ? { kind, message: safeMessage(err.message, this.secrets()) } : null,
        retries,
        retryReasons: retries ? ['malformed_tool_call'] : [],
        usage: err ? { source: 'unavailable' } : { ...usageOf(result?.usage), scope: 'prompt' },
        request: { modelRequests, outputLimit: ctx?.outputLimit ?? null },
        modelRequestMs: (requestMs || []).slice(0, 50),
        response: err ? null : { toolCalls, stopReason: result?.stopReason || null },
      });
    });
  }

  safely(fn) {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }
}

/** Wrap a provider so its chat() calls are recorded. The wrapper delegates everything else (describe, modeFor, …). */
export function instrumentProvider(provider, diag, role) {
  if (!provider || typeof provider.chat !== 'function' || !diag) return provider;
  const wrapped = Object.create(provider);
  wrapped.chat = (req) => diag.call({ provider, role }, req, () => provider.chat(req));
  return wrapped;
}

// ── reading ─────────────────────────────────────────────────────────────────────────────────────

export function readRecords(dir) {
  try {
    return fs
      .readFileSync(path.join(dir, DIAG_FILE), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Identical failing tool calls (same tool and input summary) seen more than once: a loop the model is stuck in. */
export function repeatedToolFailures(events) {
  const seen = new Map();
  for (const e of events) {
    if (e.type !== 'tool' || e.ok !== false) continue;
    const key = `${e.taskId}|${e.tool}|${JSON.stringify(e.input)}`;
    const cur = seen.get(key) || { taskId: e.taskId, tool: e.tool, input: e.input, count: 0 };
    cur.count += 1;
    seen.set(key, cur);
  }
  return [...seen.values()].filter((x) => x.count > 1).sort((a, b) => b.count - a.count).slice(0, 10);
}

/**
 * Everything the diagnostics say about one run, built from the stored records plus the run record and its events.
 * Pure: no I/O. Provider-reported figures (token counts, stop reasons) and factory-measured figures (durations, counts)
 * are labelled; a missing figure is null and counted, never zero-filled.
 */
export function summarizeRun(run, events = [], records = []) {
  const calls = records.filter((r) => r.type === 'call');
  const phases = records.filter((r) => r.type === 'phase');
  const byPurpose = {};
  for (const c of calls) {
    const p = (byPurpose[c.purpose] ||= { count: 0, ok: 0, failed: 0, cancelled: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, usageUnavailable: 0, retries: 0 });
    p.count += 1;
    p[c.outcome === 'ok' ? 'ok' : c.outcome === 'cancelled' ? 'cancelled' : 'failed'] += 1;
    p.durationMs += c.durationMs || 0;
    p.retries += c.retries || 0;
    if (c.usage?.source === 'provider') {
      p.inputTokens += c.usage.input || 0;
      p.outputTokens += c.usage.output || 0;
    } else if (c.outcome === 'ok') p.usageUnavailable += 1;
  }
  const failuresByKind = {};
  for (const c of calls) if (c.failure) failuresByKind[c.failure.kind] = (failuresByKind[c.failure.kind] || 0) + 1;

  // Phase durations: active → done/failed per layer, on the monotonic clock (a resumed run adds up its stretches).
  const open = new Map();
  const phaseMs = {};
  for (const p of phases) {
    if (p.state === 'active') open.set(p.layer, p.tMs);
    else if (open.has(p.layer)) {
      phaseMs[p.layer] = (phaseMs[p.layer] || 0) + Math.max(0, p.tMs - open.get(p.layer));
      open.delete(p.layer);
    }
  }

  const toolEvents = events.filter((e) => e.type === 'tool');
  const byTool = {};
  for (const e of toolEvents) {
    const t = (byTool[e.tool] ||= { calls: 0, failed: 0 });
    t.calls += 1;
    if (e.ok === false) t.failed += 1;
  }
  const verifyMs = sum(events.filter((e) => e.type === 'verify').flatMap((e) => (e.results || []).map((r) => r.durationMs || 0)));
  const tasks = run.plan?.tasks || [];
  const checklist = run.checklist || [];
  const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
  const reported = calls.filter((c) => c.usage?.source === 'provider');

  return {
    schema: DIAG_SCHEMA,
    run: {
      id: run.id,
      status: run.status,
      engine: run.engine || 'builtin',
      provider: run.provider,
      model: run.model,
      plannerProvider: run.plannerProvider || null,
      plannerModel: run.plannerModel || null,
      startedAt: run.startedAt || null,
      finishedAt: run.finishedAt || null,
      durationMs: Number.isFinite(started) && Number.isFinite(finished) ? finished - started : null,
      settings: run.settings ? { maxParallel: run.settings.maxParallel, maxAttempts: run.settings.maxAttempts, maxAgentTurns: run.settings.maxAgentTurns, tokenBudget: run.settings.tokenBudget, timeoutMinutes: run.settings.timeoutMinutes, commandTimeoutMs: run.settings.commandTimeoutMs } : null,
      providerOptions: run.providerOptions || {},
    },
    outcome: {
      status: run.status,
      tasks: { total: tasks.length, completed: tasks.filter((t) => t.status === 'completed').length, escalated: tasks.filter((t) => t.status === 'escalated').length, attempts: sum(tasks.map((t) => t.attempts?.length || 0)) },
      verification: { checklistPassed: checklist.filter((c) => c.ok).length, checklistTotal: checklist.length, finalChecks: (run.finalVerification || []).slice(0, 20).map((v) => ({ command: String(v.command).slice(0, 120), ok: v.ok, state: v.state || null })), verifyMs },
      delivery: { produced: Boolean(run.delivery), integrityOk: run.delivery?.integrity ? run.delivery.integrity.ok : null },
      error: run.error ? safeMessage(run.error) : null,
    },
    phases: { durationMs: phaseMs, basis: 'factory-measured, monotonic' },
    calls: {
      count: calls.length,
      byPurpose,
      failuresByKind,
      retries: sum(calls.map((c) => c.retries || 0)),
      durationMs: { total: sum(calls.map((c) => c.durationMs || 0)), median: median(calls.map((c) => c.durationMs || 0)), basis: 'factory-measured, monotonic' },
      tokens: { basis: 'provider-reported', input: sum(reported.map((c) => c.usage.input || 0)), output: sum(reported.map((c) => c.usage.output || 0)), callsReporting: reported.length, callsUnavailable: calls.length - reported.length },
      request: { medianChars: median(calls.map((c) => c.request?.chars).filter(Number.isFinite)), maxChars: Math.max(0, ...calls.map((c) => c.request?.chars || 0)), maxMessages: Math.max(0, ...calls.map((c) => c.request?.messages || 0)), basis: 'factory-measured characters, not tokens' },
    },
    tools: { calls: toolEvents.length, failed: toolEvents.filter((e) => e.ok === false).length, byTool },
    repeatedToolFailures: repeatedToolFailures(events),
    truncated: records.some((r) => r.type === 'truncated'),
  };
}
