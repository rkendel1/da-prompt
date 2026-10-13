// The FX engine: one task attempt run by @appport/fx. fx supplies the agent loop and the model connection; every effect still
// goes through da-prompt's own tools (`execTool` over the sandboxed Workspace), so file, command and policy rules are exactly
// the built-in engine's. The result has the same shape as runAgent(), so verification and feedback do not change.
import crypto from 'node:crypto';
import { redact } from '../security.js';
import { AGENT_TOOLS, BudgetError, agentSystem, completionFields, taskBrief, execTool, summarizeInput } from '../agents.js';
import { loadEngineModule, fxEndpoint, EngineError } from './index.js';

const NUDGE = 'Continue the task using the tools, and call complete_task when it is done and verified.';
const MAX_ROUNDS = 3;
// Local models often write a tool call as plain text (e.g. `<function=write_file>`). fx refuses to run such text and does not
// retry, and it drops the failed prompt from its history, so we start the attempt's prompt again. Earlier tool effects are
// in the workspace, so the retry says so.
const MAX_MALFORMED_RETRIES = 4;
export const FX_TIMEOUT_MESSAGE = 'FX model error (LIBFX_MODEL_TIMEOUT): the model did not start answering in time. The FX engine allows about 120 seconds for the first response byte (@appport/fx 0.1.2) and offers no setting to change that, so a slow local model (a long prompt on CPU) can exceed it even though the built-in engine would wait. Switch this run to the built-in engine (\`--engine builtin\`; it waits up to 30 minutes per request), use a smaller or faster model, or use a hosted provider.';
const RECOVER = 'NOTE: your previous reply in this attempt wrote a tool call as plain text instead of using the tool-calling interface, so it could not run. Files you already wrote are still in the workspace — inspect it first (list_files / read_file) instead of redoing finished work. Always call tools through the structured tool-calling interface, and finish by calling complete_task.';

export function makeFxRunner(cfg) {
  return async function runAgentFx({ provider, ws, run, task, attempt, maxAttempts, feedback, upstream, lessons, settings, signal, emit, track }) {
    const fx = await loadEngineModule(cfg, 'fx');
    const ep = fxEndpoint(provider);
    // fx reads the credential from a named environment variable on every request (it never passes through JS). The name
    // matches the secret filter in safeEnv(), so agent shells never see it.
    const envName = ep.apiKey ? `DA_PROMPT_FX_KEY_${crypto.randomBytes(6).toString('hex')}` : '';
    if (envName) process.env[envName] = ep.apiKey;
    // FACTORY_MAX_OUTPUT_TOKENS, like the built-in adapters (fx's own default is "unset", i.e. the server's).
    const outputTokens = Number.isSafeInteger(provider?.maxTokens) && provider.maxTokens > 0 ? provider.maxTokens : cfg.maxOutputTokens;
    const state = { completion: null, files: new Set(), commands: [], budget: null, turn: null, steps: 0 };
    let agent;
    try {
      const model = await fx.createFxModel({ baseUrl: ep.baseUrl, model: ep.model, ...(envName ? { apiKeyEnv: envName } : {}) });
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
          const out = await execTool(ws, { name: t.name, input }, { settings, signal: ctx.signal || signal });
          if (t.name === 'write_file' && !out.isError) state.files.add(out.path);
          if (t.name === 'run_command') state.commands.push({ command: input?.command, exitCode: out.exitCode });
          emit('tool', { taskId: task.id, role: task.role, tool: t.name, input: summarizeInput({ name: t.name, input }), ok: !out.isError, output: redact(out.preview || '').slice(0, 4000), exitCode: out.exitCode, durationMs: out.durationMs });
          return out.text.slice(0, 12_000);
        },
      }));
      agent = await fx.createFxAgent({ model, tools, instructions: agentSystem(run, task, lessons).slice(0, 60_000), maxSteps: settings.maxAgentTurns, maxOutputTokens: outputTokens });

      let lastStop = null;
      let malformed = 0;
      for (let round = 0; round < MAX_ROUNDS + malformed && !state.completion && !state.budget; round++) {
        if (signal?.aborted) return { ok: false, error: 'cancelled' };
        const brief = taskBrief(run, task, { attempt, maxAttempts, feedback, upstream });
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
            if (ev.type === 'text_delta') text += ev.delta || '';
            else if (ev.type === 'tool_start') { flush(); state.steps++; }
          }
        } catch { /* the failure is reported by turn.result */ }
        flush();
        let result;
        try {
          result = await turn.result;
        } catch (e) {
          if (signal?.aborted) return { ok: false, error: 'cancelled' };
          if (e.kind === 'malformed_tool_call' && malformed < MAX_MALFORMED_RETRIES) {
            malformed++;
            state.recovering = true;
            emit('agent.message', { taskId: task.id, role: task.role, text: `The model wrote a tool call as plain text (retry ${malformed} of ${MAX_MALFORMED_RETRIES}).` });
            continue;
          }
          if (e.code === 'LIBFX_MODEL_TIMEOUT') return { ok: false, error: FX_TIMEOUT_MESSAGE };
          return { ok: false, error: redact(`FX model error${e.kind || e.code ? ` (${e.kind || e.code})` : ''}: ${String(e.message || e).split('\n')[0]}`).slice(0, 600) };
        }
        track?.add({ input_tokens: result?.usage?.inputTokens || 0, output_tokens: result?.usage?.outputTokens || 0 });
        lastStop = result?.stopReason;
        if (lastStop === 'max_turn_requests' && !state.completion) break;
      }
      if (state.budget) throw state.budget instanceof BudgetError ? state.budget : new BudgetError(String(state.budget.message));
      if (signal?.aborted) return { ok: false, error: 'cancelled' };
      if (!state.completion) return { ok: false, error: `agent did not finish within ${settings.maxAgentTurns} turns` };
      return { ok: true, result: { ...completionFields(state.completion, state.files), commandsRun: state.commands, turns: Math.max(1, state.steps) } };
    } catch (e) {
      if (e instanceof BudgetError || e instanceof EngineError) throw e;
      throw new EngineError(redact(String(e.message || e)));
    } finally {
      if (envName) delete process.env[envName];
      await agent?.close?.().catch(() => {});
    }
  };
}
