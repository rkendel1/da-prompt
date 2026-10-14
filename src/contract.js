// The inference contract, stated once and checked offline: which provider, model and engine a run would use and why, which
// tuning options each engine honours, and which checks need a live provider (so were not performed here).
//
// Nothing in this file makes a network request or a model call. It reads configuration (environment, saved settings,
// providers.json) and the constants the adapters export. Secrets are reported as present/absent plus the NAME of the
// environment variable or "saved", never the value.
import { ENGINES, loadEngineModule, enginesDir } from './engines/index.js';
import { FX_FIRST_RESPONSE_SECONDS, FX_MAX_MALFORMED_RETRIES } from './engines/fx.js';
import { BRIDGE_KEEPALIVE_MS } from './providers/bridge.js';
import { REQUEST_TIMEOUT_MS as OPENAI_TIMEOUT_MS, OLLAMA_HTTP_RETRIES } from './providers/openai.js';
import { REQUEST_TIMEOUT_MS as ANTHROPIC_TIMEOUT_MS } from './providers/anthropic.js';
import { DEFAULT_HTTP_RETRIES } from './providers/http.js';

export const CONTRACT_SCHEMA = 'da-prompt.inference-contract/1';

const min = (ms) => `${Math.round(ms / 60_000)} min`;

/** How one option behaves per engine: supported | fixed (cannot be changed) | unsupported | not-applicable. */
const row = (o) => o;

function settingsTable(cfg, spec, options) {
  const src = (k) => cfg.settings.source(k);
  const ollama = spec?.type === 'ollama';
  const timeoutNote = spec?.type === 'anthropic' ? min(ANTHROPIC_TIMEOUT_MS) : min(OPENAI_TIMEOUT_MS);
  return [
    row({ key: 'maxOutputTokens', label: 'Max tokens per reply', value: cfg.maxOutputTokens, default: 8192, source: src('maxOutputTokens'), env: 'FACTORY_MAX_OUTPUT_TOKENS', perRun: false, precedence: 'startup > saved setting > environment > default', builtin: { status: 'supported', how: 'max_tokens / num_predict on every request' }, fx: { status: 'supported', how: 'passed as the agent\'s maxOutputTokens' } }),
    row({ key: 'maxParallel', label: 'Parallel agents (concurrency)', value: cfg.defaults.maxParallel, default: 3, source: src('maxParallel'), env: 'FACTORY_MAX_PARALLEL', perRun: true, runOption: '--parallel', range: [1, 8], precedence: 'run option > startup > saved > environment > default', governs: 'how many plan tasks execute at once (each runs its own agent loop and its own model calls); planning and the final summary are always single calls', builtin: { status: 'supported', how: 'executionLoop' }, fx: { status: 'supported', how: 'executionLoop' }, note: 'Set to 1 for a serial run. The default is unchanged and the same for local and hosted providers.' }),
    row({ key: 'maxAttempts', label: 'Attempts per task', value: cfg.defaults.maxAttempts, default: 3, source: src('maxAttempts'), env: 'FACTORY_MAX_ATTEMPTS', perRun: true, runOption: '--attempts', range: [1, 5], precedence: 'run option > startup > saved > environment > default', builtin: { status: 'supported' }, fx: { status: 'supported' } }),
    row({ key: 'maxAgentTurns', label: 'Tool turns per attempt', value: cfg.defaults.maxAgentTurns, default: 40, source: src('maxAgentTurns'), env: 'FACTORY_MAX_AGENT_TURNS', perRun: true, runOption: '--turns', range: [2, 200], precedence: 'run option > startup > saved > environment > default', builtin: { status: 'supported', how: 'loop bound' }, fx: { status: 'supported', how: 'maxSteps (model requests per prompt)' } }),
    row({ key: 'tokenBudget', label: 'Token budget per run', value: cfg.defaults.tokenBudget, default: 2_000_000, source: src('tokenBudget'), env: 'FACTORY_TOKEN_BUDGET', perRun: true, runOption: '--budget', precedence: 'run option > startup > saved > environment > default', builtin: { status: 'supported', how: 'checked before every model call' }, fx: { status: 'supported', how: 'checked before every tool call and added after every prompt (coarser than builtin)' } }),
    row({ key: 'timeoutMinutes', label: 'Run time limit', value: 120, default: 120, source: 'default', env: null, perRun: true, precedence: 'run setting > default', builtin: { status: 'supported' }, fx: { status: 'supported' }, note: 'The run is aborted (and not marked completed) when the limit passes.' }),
    row({ key: 'commandTimeoutMs', label: 'Shell command timeout', value: cfg.defaults.commandTimeoutMs, default: 180_000, source: src('commandTimeoutMs'), env: 'FACTORY_COMMAND_TIMEOUT_MS', perRun: false, precedence: 'startup > saved > environment > default', builtin: { status: 'supported' }, fx: { status: 'supported' } }),
    row({ key: 'numCtx', label: 'Context window (Ollama num_ctx)', value: ollama ? spec.numCtx || null : null, default: ollama ? 32768 : null, source: ollama ? ('provider setting or default') : null, env: null, perRun: true, runOption: 'New Run form, API providerOptions.numCtx, or the headless runner (npm run factory -- --num-ctx)', precedence: 'run option > provider setting (Providers page) > 32768', builtin: { status: ollama ? 'supported' : 'not-applicable', how: ollama ? 'options.num_ctx on /api/chat' : 'only Ollama accepts a context-window option; other providers ignore it' }, fx: { status: ollama ? 'supported' : 'not-applicable', how: ollama ? 'fx\'s requests go through the da-prompt bridge to options.num_ctx on /api/chat' : 'only Ollama accepts a context-window option; other providers ignore it' } }),
    row({ key: 'temperature', label: 'Temperature', value: options?.temperature ?? null, default: null, source: options?.temperature != null ? 'run option' : null, env: null, perRun: true, precedence: 'run option > provider default', builtin: { status: 'supported' }, fx: { status: 'supported', how: 'applied by the provider adapter behind the bridge' } }),
    row({ key: 'toolMode', label: 'Tool-call mode (auto | native | json)', value: options?.toolMode || spec?.toolMode || 'auto', default: 'auto', source: options?.toolMode ? 'run option' : 'provider setting', env: null, perRun: true, precedence: 'run option > provider setting > auto', builtin: { status: spec?.type === 'anthropic' ? 'not-applicable' : 'supported', how: 'falls back to JSON tool calls for models without native tools' }, fx: { status: spec?.type === 'anthropic' ? 'not-applicable' : 'supported', how: 'the bridge answers through the provider adapter, which handles JSON tool calls and recovers calls written as text before fx sees them' } }),
    row({ key: 'requestTimeout', label: 'Request timeout (total)', value: timeoutNote, default: timeoutNote, source: 'fixed', env: null, perRun: false, precedence: 'not configurable', builtin: { status: 'fixed', how: `${timeoutNote} per request (constructor constant)` }, fx: { status: 'fixed', how: `${timeoutNote} per model request, enforced by the provider adapter behind the bridge` } }),
    row({ key: 'firstResponseTimeout', label: 'First-response timeout', value: null, default: null, source: 'fixed', env: null, perRun: false, precedence: 'not configurable', builtin: { status: 'unsupported', how: 'non-streaming requests: only the total timeout applies' }, fx: { status: 'not-applicable', how: `fx waits about ${FX_FIRST_RESPONSE_SECONDS} s for response headers (@appport/fx 0.1.2); the bridge sends them at once and a keepalive every ${BRIDGE_KEEPALIVE_MS / 1000} s, so only the request timeout applies` } }),
    row({ key: 'transportRetries', label: 'Transport retries', value: ollama ? OLLAMA_HTTP_RETRIES : DEFAULT_HTTP_RETRIES, default: DEFAULT_HTTP_RETRIES, source: 'fixed', env: null, perRun: false, precedence: 'not configurable', builtin: { status: 'fixed', how: `${ollama ? OLLAMA_HTTP_RETRIES : DEFAULT_HTTP_RETRIES} retries on 408/409/425/429/5xx and transient network errors, with backoff (a timeout is retried too)` }, fx: { status: 'fixed', how: `the same retries, applied by the provider adapter behind the bridge; a model that still writes an unusable tool call is re-prompted up to ${FX_MAX_MALFORMED_RETRIES} times` } }),
  ];
}

const LIMITATIONS = [
  'builtin: requests are not streamed, so a first-response time cannot be measured; only the total duration is recorded.',
  'builtin: every model turn resends the message history (it grows with every tool result, each bounded to 12 000 characters); when it would exceed a known small context window (Ollama num_ctx), older rounds are shortened first, keeping the task brief and the latest three rounds whole.',
  'fx: runs the model loop itself; the factory records one diagnostics entry per prompt (with the number of model requests), not one per request, and token usage only as a per-prompt total.',
  'fx: its model requests reach the provider through a loopback bridge in da-prompt, so Ollama num_ctx, temperature, tool mode, timeouts and retries are the built-in engine\'s. Per-request diagnostics are recorded for the bridged calls as well.',
  'Token counts are the provider\'s own; when a provider omits them the diagnostics say "unavailable" instead of zero.',
  'Character counts of requests are a factory-side size indicator, not tokens.',
];

/** Everything that requires a live provider, and the explicit command that performs it. */
function notPerformed(provider, model) {
  const id = provider || '<provider>';
  const m = model ? ` --model ${model}` : '';
  return [
    { check: 'provider reachable', why: 'needs a network request to the provider', run: `da-prompt providers show ${id}` },
    { check: 'model is offered by the provider', why: 'needs the provider\'s model list', run: `da-prompt providers models ${id}` },
    { check: 'tool calling works with this model', why: 'needs one real inference request', run: `da-prompt providers test ${id}${m}` },
    { check: 'latency, throughput, memory or CPU use', why: 'needs real inference; see "Local tuning" in the README and npm run bench', run: 'npm run bench -- run --live …' },
  ];
}

/**
 * The offline preflight. `opts` = { provider, model, engine, providerOptions } (all optional; unset means "whatever the
 * configuration would choose"). Returns a plain object safe to serve and print.
 */
export async function describeInference(cfg, registry, opts = {}) {
  const problems = [];
  const problem = (level, message, fix) => problems.push({ level, message, ...(fix ? { fix } : {}) });
  const saved = registry.settings.defaults || {};
  const all = registry.all();
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

  // provider
  let id = str(opts.provider);
  let providerReason;
  let providerSource;
  let resolved = true;
  if (id) [providerReason, providerSource] = ['chosen explicitly for this check', 'explicit'];
  else if (cfg.defaultProvider) [id, providerReason, providerSource] = [cfg.defaultProvider, `configured default (${cfg.settings.source('defaultProvider')}: FACTORY_PROVIDER or the saved setting)`, 'configured'];
  else if (saved.provider) [id, providerReason, providerSource] = [saved.provider, 'the provider the last run used (remembered in providers.json)', 'last run'];
  else {
    resolved = false;
    providerReason = 'not configured: with no configured or remembered provider, a run uses the first ready provider, which can only be found by contacting the providers';
    providerSource = 'automatic';
  }
  let spec = null;
  if (id) {
    spec = all.find((p) => p.id === id) || null;
    if (!spec) problem('error', `Unknown provider "${id}".`, `Known: ${all.map((p) => p.id).join(', ')}`);
  }

  // model
  let model = str(opts.model);
  let modelReason;
  if (model) modelReason = 'chosen explicitly for this check';
  else if (spec && cfg.defaultProvider === spec.id && cfg.defaultModel) [model, modelReason] = [cfg.defaultModel, `configured default model (${cfg.settings.source('defaultModel')})`];
  else if (spec?.defaultModel) [model, modelReason] = [spec.defaultModel, 'the provider\'s own default model (Providers page)'];
  else if (spec && saved.provider === spec.id && saved.model) [model, modelReason] = [saved.model, 'the model the last run used on this provider (used only if the provider still lists it: not checked here)'];
  else modelReason = spec?.type === 'offline' ? 'the offline agents need no model' : 'not configured: the provider\'s preferred available model is chosen from its model list (not contacted here)';

  // engine
  const engineId = str(opts.engine) || cfg.defaultEngine || 'builtin';
  const engineReason = str(opts.engine) ? 'chosen explicitly for this check' : `${cfg.settings.source('defaultEngine')}: FACTORY_AGENT_ENGINE or the saved setting; builtin unless changed`;
  if (!ENGINES.some((e) => e.id === engineId)) problem('error', `Unknown agent engine "${engineId}".`, `Use ${ENGINES.map((e) => e.id).join(' or ')}.`);

  // configuration presence (no secret values)
  let provider = null;
  if (spec) {
    const view = registry.view(spec);
    provider = { ...view, hosted: !spec.local && spec.type !== 'offline', mode: spec.type === 'offline' ? 'offline demo agents (no model)' : spec.local ? 'local' : 'hosted', keyPresent: Boolean(spec.apiKey), keyRequired: Boolean(spec.needsKey) };
    if (spec.enabled === false) problem('error', `${spec.label} is disabled.`, 'Enable it on the Providers page.');
    if (spec.needsKey && !spec.apiKey) problem('error', `${spec.label} needs an API key.`, `Set ${spec.keyEnv?.[0] || 'its key'} or add it on the Providers page (printf %s "$KEY" | da-prompt providers set-key ${spec.id} --stdin).`);
  }

  // engine availability and compatibility, still without contacting anything
  const engine = { id: engineId, reason: engineReason, source: str(opts.engine) ? 'explicit' : cfg.settings.source('defaultEngine') };
  if (engineId === 'fx') {
    try {
      await loadEngineModule(cfg, 'fx');
      engine.installed = true;
    } catch (e) {
      engine.installed = false;
      problem('error', e.message, `npm run engine:install -- fx   (installs under ${enginesDir(cfg)})`);
    }
    if (spec?.type === 'offline') problem('error', 'The offline demo agents have no model, so they cannot use the fx engine.', 'Use the built-in engine.');
  }

  const settings = settingsTable(cfg, spec, opts.providerOptions);
  // Options explicitly requested but not honoured by the chosen engine.
  const unsupported = settings.filter((s) => s.value != null && (s[engineId === 'fx' ? 'fx' : 'builtin']?.status === 'unsupported') && ['numCtx', 'temperature', 'toolMode'].includes(s.key) && opts.providerOptions && s.key in opts.providerOptions).map((s) => s.key);
  for (const k of unsupported) problem('warn', `${k} is set but the ${engineId} engine does not support it; it will not be applied.`, k === 'numCtx' ? 'Use the built-in engine if you need a specific Ollama context window.' : undefined);

  return {
    schema: CONTRACT_SCHEMA,
    offline: true,
    selection: {
      provider: { id: id || null, resolved, source: providerSource, reason: providerReason },
      model: { id: model || null, reason: modelReason },
      engine,
    },
    provider,
    candidates: resolved ? undefined : all.filter((p) => p.type !== 'offline').map((p) => ({ id: p.id, label: p.label, mode: p.local ? 'local' : 'hosted', keyPresent: Boolean(p.apiKey), keyRequired: Boolean(p.needsKey) })),
    settings,
    limitations: LIMITATIONS,
    problems,
    notPerformed: notPerformed(id, model),
    ok: !problems.some((p) => p.level === 'error'),
  };
}

/** Messages (logged once at run start) for options that this run's engine will not honour. */
export function contractWarnings(run, registry) {
  const out = [];
  const o = run.providerOptions || {};
  let spec = null;
  try {
    spec = registry.get(run.provider);
  } catch {
    /* injected provider */
  }
  // Both engines reach the model through the same provider adapter (fx through the bridge), so they honour the same options.
  if (o.numCtx && spec && spec.type !== 'ollama') {
    out.push(`numCtx ${o.numCtx} is ignored: only Ollama accepts a context-window option.`);
  }
  return out;
}
