// The FX engine: one task attempt run by @appport/fx. fx supplies the agent loop; every effect still goes through da-prompt's
// own tools (`execTool` over the sandboxed Workspace), so file, command and policy rules are exactly the built-in engine's.
// fx's model client talks to a loopback bridge (src/providers/bridge.js) that answers with the run's own provider, so fx gets
// the same model handling as the built-in engine: Ollama num_ctx, retries, JSON tool mode, recovery of tool calls written as
// text, any provider type, and no 120-second first-response cutoff. The result has the same shape as runAgent(), so
// verification and feedback do not change.
import crypto from 'node:crypto';
import { redact } from '../security.js';
import { AGENT_TOOLS, BudgetError, agentSystem, completionFields, taskBrief, execTool, summarizeInput, normalizeToolInput } from '../agents.js';
import { startBridge } from '../providers/bridge.js';
import { loadEngineModule, fxEndpoint, EngineError } from './index.js';

// Limits of this engine that da-prompt cannot change (see README "Agent engines"): fx's own first-response window comes from
// inspecting the @appport/fx 0.1.2 source (openai_compatible_model_provider.zig), and is not exposed as an option.
export const FX_FIRST_RESPONSE_SECONDS = 120;
export const FX_MAX_ROUNDS = 3;
const NUDGE = 'Continue the task using the tools, and call complete_task when it is done and verified.';
const MAX_ROUNDS = FX_MAX_ROUNDS;
// Local models often write a tool call as plain text (e.g. `<function=write_file>`). fx refuses to run such text and does not
// retry, and it drops the failed prompt from its history, so we start the attempt's prompt again. Earlier tool effects are
// in the workspace, so the retry says so.
export const FX_MAX_MALFORMED_RETRIES = 4;
const MAX_MALFORMED_RETRIES = FX_MAX_MALFORMED_RETRIES;
export const FX_TIMEOUT_MESSAGE = `FX model error (LIBFX_MODEL_TIMEOUT): fx received no response headers within about ${FX_FIRST_RESPONSE_SECONDS} seconds (@appport/fx 0.1.2). da-prompt's bridge sends headers at once and keeps the stream alive while the model works, so this means the bridge itself did not answer (an overloaded machine?). Retry, or switch this run to the built-in engine (--engine builtin).`;
const RECOVER = 'NOTE: your previous reply in this attempt wrote a tool call as plain text instead of using the tool-calling interface, so it could not run. Files you already wrote are still in the workspace — inspect it first (list_files / read_file) instead of redoing finished work. Always call tools through the structured tool-calling interface, and finish by calling complete_task.';

export function makeFxRunner(cfg) {
  return async function runAgentFx({ provider, ws, run, task, attempt, maxAttempts, feedback, upstream, lessons, settings, signal, emit, track, diag }) {
    const fx = await loadEngineModule(cfg, 'fx');
    const ep = fxEndpoint(provider);
    // fx authenticates to the bridge with a one-off token read from a named environment variable (the provider's real key
    // never reaches fx). The name matches the secret filter in safeEnv(), so agent shells never see it.
    const token = crypto.randomBytes(24).toString('hex');
    const envName = `DA_PROMPT_FX_KEY_${crypto.randomBytes(6).toString('hex')}`;
    process.env[envName] = token;
    let bridge;
    // FACTORY_MAX_OUTPUT_TOKENS, like the built-in adapters (fx's own default is "unset", i.e. the server's).
    const outputTokens = Number.isSafeInteger(provider?.maxTokens) && provider.maxTokens > 0 ? provider.maxTokens : cfg.maxOutputTokens;
    const state = { completion: null, files: new Set(), commands: [], budget: null, turn: null, steps: 0 };
    let agent;
    // fx reports each model request through onEvent (a documented option): time them on our own monotonic clock.
    const onEvent = (ev) => {
      const c = state.cur;
      if (!c) return;
      if (ev?.type === 'model.request') {
        c.modelRequests++;
        c.reqStart = performance.now();
      } else if (ev?.type === 'model.response' && c.reqStart != null) {
        c.requestMs.push(Math.round(performance.now() - c.reqStart));
        c.reqStart = null;
      }
    };
    try {
      bridge = await startBridge(provider, { token, track, meta: { task, attempt, inputs: run.inputs, stack: run.settings?.stack } });
      const model = await fx.createFxModel({ baseUrl: bridge.baseUrl, model: ep.model, apiKeyEnv: envName });
      const stop = () => queueMicrotask(() => state.turn?.cancel());
      const tools = AGENT_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.input_schema,
        async execute(input, ctx = {}) {
          if (t.name === 'complete_task') {
            state.completion = input || {};
            stop(); // fx would keep looping until the model stops calling tools; the task is done now
            return 'Recorded. The factory will now verify your work.';
          }
          try {
            track?.check();
          } catch (e) {
            state.budget = e;
            stop();
            return 'The token budget is exhausted. Stop.';
          }
          input = normalizeToolInput(t.name, input);
          const out = await execTool(ws, { name: t.name, input }, { settings, signal: ctx.signal || signal });
          if (t.name === 'write_file' && !out.isError) state.files.add(out.path);
          if (t.name === 'run_command') state.commands.push({ command: input?.command, exitCode: out.exitCode });
          emit('tool', { taskId: task.id, role: task.role, tool: t.name, input: summarizeInput({ name: t.name, input }), ok: !out.isError, output: redact(out.preview || '').slice(0, 4000), exitCode: out.exitCode, durationMs: out.durationMs });
          return out.text.slice(0, 12_000);
        },
      }));
      agent = await fx.createFxAgent({ model, tools, instructions: agentSystem(run, task, lessons).slice(0, 60_000), maxSteps: settings.maxAgentTurns, maxOutputTokens: outputTokens, onEvent });

      const record = (cur, extra) => diag?.fxPrompt({ ctx: { outputLimit: outputTokens }, taskId: task.id, attempt, durationMs: performance.now() - cur.t0, firstEventMs: cur.firstEventMs, modelRequests: cur.modelRequests, requestMs: cur.requestMs, toolCalls: cur.toolCalls, provider: { name: provider?.name, model: ep.model, dialect: provider?.dialect }, ...extra });
      let lastStop = null;
      let malformed = 0;
      for (let round = 0; round < MAX_ROUNDS + malformed && !state.completion && !state.budget; round++) {
        if (signal?.aborted) return { ok: false, error: 'cancelled' };
        const brief = taskBrief(run, task, { attempt, maxAttempts, feedback, upstream });
        const cur = (state.cur = { t0: performance.now(), firstEventMs: null, modelRequests: 0, requestMs: [], toolCalls: 0, reqStart: null });
        const turn = agent.prompt(malformed && state.recovering ? `${brief}\n\n${RECOVER}` : round === 0 ? brief : NUDGE, { signal });
        state.recovering = false;
        state.turn = turn;
        let text = '';
        const flush = () => {
          if (text.trim()) emit('agent.message', { taskId: task.id, role: task.role, text: redact(text.trim()).slice(0, 2000) });
          text = '';
        };
        try {
          for await (const ev of turn) {
            if (cur.firstEventMs == null && (ev.type === 'text_delta' || ev.type === 'tool_start' || ev.type === 'reasoning_delta')) cur.firstEventMs = performance.now() - cur.t0;
            if (ev.type === 'text_delta') text += ev.delta || '';
            else if (ev.type === 'tool_start') { flush(); state.steps++; cur.toolCalls++; }
          }
        } catch { /* the failure is reported by turn.result */ }
        flush();
        let result;
        try {
          result = await turn.result;
        } catch (e) {
          record(cur, { err: e, retries: malformed });
          if (signal?.aborted) return { ok: false, error: 'cancelled' };
          if (bridge?.budget()) break; // the bridge refused a request: stopped by the budget, not a model failure
          if (e.kind === 'malformed_tool_call' && malformed < MAX_MALFORMED_RETRIES) {
            malformed++;
            state.recovering = true;
            emit('agent.message', { taskId: task.id, role: task.role, text: `The model wrote a tool call as plain text (retry ${malformed} of ${MAX_MALFORMED_RETRIES}).` });
            continue;
          }
          if (e.code === 'LIBFX_MODEL_TIMEOUT') return { ok: false, error: FX_TIMEOUT_MESSAGE };
          // fx reports a provider failure as a bare "ProviderError"; the bridge kept the provider's own message.
          const cause = bridge?.lastError();
          if (cause) return { ok: false, error: redact(`Model error: ${cause.split('\n')[0]}`).slice(0, 600) };
          return { ok: false, error: redact(`FX model error${e.kind || e.code ? ` (${e.kind || e.code})` : ''}: ${String(e.message || e).split('\n')[0]}`).slice(0, 600) };
        }
        record(cur, { result, retries: malformed });
        // Usage is charged per request by the bridge (above), not here.
        lastStop = result?.stopReason;
        if (lastStop === 'max_turn_requests' && !state.completion) break;
      }
      if (!state.budget && bridge.budget()) state.budget = bridge.budget();
      if (state.budget) throw state.budget instanceof BudgetError ? state.budget : new BudgetError(String(state.budget.message));
      if (signal?.aborted) return { ok: false, error: 'cancelled' };
      if (!state.completion) return { ok: false, error: `agent did not finish within ${settings.maxAgentTurns} turns` };
      return { ok: true, result: { ...completionFields(state.completion, state.files), commandsRun: state.commands, turns: Math.max(1, state.steps) } };
    } catch (e) {
      if (e instanceof BudgetError || e instanceof EngineError) throw e;
      throw new EngineError(redact(String(e.message || e)));
    } finally {
      delete process.env[envName];
      await agent?.close?.().catch(() => {});
      await bridge?.close().catch(() => {});
    }
  };
}
