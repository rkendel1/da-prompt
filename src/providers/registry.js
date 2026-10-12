// Provider registry: built-in presets, user-added providers, saved keys/URLs, and live discovery
// of which providers are usable right now and which models each one offers.

import fs from 'node:fs';
import path from 'node:path';
import { requestJson, HttpError, describeError } from './http.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai.js';
import { OfflineProvider } from './offline.js';
import { redact } from '../security.js';

export const TYPES = ['anthropic', 'openai', 'ollama', 'offline'];

// Order matters: it is the order shown in the UI and the order used to pick a default.
export const PRESETS = [
  { id: 'anthropic', label: 'Anthropic (Claude)', type: 'anthropic', baseUrl: 'https://api.anthropic.com', baseUrlEnv: ['ANTHROPIC_BASE_URL'], keyEnv: ['ANTHROPIC_API_KEY'], needsKey: true, preferred: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-sonnet-4', 'claude-3-7-sonnet'], keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', baseUrlEnv: ['OPENAI_BASE_URL'], keyEnv: ['OPENAI_API_KEY'], needsKey: true, preferred: ['gpt-5', 'gpt-4.1', 'o4-mini', 'gpt-4o'], keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'ollama', label: 'Ollama', type: 'ollama', baseUrl: 'http://127.0.0.1:11434', baseUrlEnv: ['OLLAMA_HOST', 'OLLAMA_BASE_URL'], local: true, needsKey: false, preferred: ['qwen3-coder', 'qwen2.5-coder', 'devstral', 'gpt-oss', 'qwen3', 'llama3.3', 'llama3.1', 'mistral-small', 'mistral-nemo'], defaultNumCtx: 32768 },
  { id: 'lmstudio', label: 'LM Studio', type: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', baseUrlEnv: ['LMSTUDIO_BASE_URL'], local: true, needsKey: false, preferred: ['qwen3-coder', 'qwen2.5-coder', 'devstral', 'gpt-oss', 'qwen3'] },
  { id: 'llamacpp', label: 'llama.cpp server', type: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', baseUrlEnv: ['LLAMACPP_BASE_URL'], local: true, needsKey: false },
  { id: 'vllm', label: 'vLLM', type: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', baseUrlEnv: ['VLLM_BASE_URL'], keyEnv: ['VLLM_API_KEY'], local: true, needsKey: false },
  { id: 'openrouter', label: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: ['OPENROUTER_API_KEY'], needsKey: true, preferred: ['anthropic/claude-sonnet', 'openai/gpt-5', 'qwen/qwen3-coder', 'google/gemini-2.5-pro'], headers: { 'x-title': 'da-prompt' }, keyUrl: 'https://openrouter.ai/keys' },
  { id: 'gemini', label: 'Google Gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], needsKey: true, preferred: ['gemini-2.5-pro', 'gemini-2.5-flash'], keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'groq', label: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: ['GROQ_API_KEY'], needsKey: true, preferred: ['moonshotai/kimi-k2', 'openai/gpt-oss-120b', 'llama-3.3-70b'], keyUrl: 'https://console.groq.com/keys' },
  { id: 'mistral', label: 'Mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', keyEnv: ['MISTRAL_API_KEY'], needsKey: true, preferred: ['devstral', 'mistral-large', 'codestral'], keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'deepseek', label: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', keyEnv: ['DEEPSEEK_API_KEY'], needsKey: true, preferred: ['deepseek-chat', 'deepseek-reasoner'], keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'xai', label: 'xAI (Grok)', type: 'openai', baseUrl: 'https://api.x.ai/v1', keyEnv: ['XAI_API_KEY'], needsKey: true, preferred: ['grok-code', 'grok-4', 'grok-3'], keyUrl: 'https://console.x.ai' },
  { id: 'together', label: 'Together AI', type: 'openai', baseUrl: 'https://api.together.xyz/v1', keyEnv: ['TOGETHER_API_KEY'], needsKey: true, preferred: ['Qwen/Qwen3-Coder', 'deepseek-ai/DeepSeek-V3', 'meta-llama/Llama-3.3-70B'], keyUrl: 'https://api.together.ai/settings/api-keys' },
  { id: 'offline', label: 'Offline demo agents', type: 'offline', local: true, needsKey: false },
];

const NON_CHAT = /(embed|embedding|whisper|tts|transcribe|dall-e|gpt-image|image|moderation|audio|realtime|search-preview|davinci|babbage|rerank|guard|vision-preview|veo|imagen|aqa|lyria)/i;
const CACHE_MS = 30_000;

function normalizeUrl(u, type) {
  if (!u) return u;
  let s = String(u).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  s = s.replace(/\/+$/, '').replace('://0.0.0.0', '://127.0.0.1');
  if (type === 'ollama') s = s.replace(/\/(api|v1)$/, '');
  return s;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export class ProviderRegistry {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = path.join(cfg.dataDir, 'providers.json');
    this.cache = new Map(); // id -> { at, result }
    this.env = cfg.env || process.env;
    this.settings = this.load();
  }

  // ── persistence ─────────────────────────────────────────────────────────────────────────
  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { overrides: s.overrides || {}, custom: Array.isArray(s.custom) ? s.custom : [], defaults: s.defaults || {} };
    } catch {
      return { overrides: {}, custom: [], defaults: {} };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache.clear();
  }

  // ── resolution ──────────────────────────────────────────────────────────────────────────
  envValue(names = []) {
    for (const n of names) if (this.env[n]) return { value: this.env[n], name: n };
    return null;
  }

  /** Every provider (presets + custom) with keys and URLs resolved. */
  all() {
    const list = [];
    for (const p of PRESETS) list.push(this.resolvePreset(p));
    for (const c of this.settings.custom) list.push(this.resolveCustom(c));
    return list.filter((p) => !(p.id === 'offline' && this.cfg.hideOffline));
  }

  resolvePreset(p) {
    const o = this.settings.overrides[p.id] || {};
    const envKey = this.envValue(p.keyEnv);
    const envUrl = this.envValue(p.baseUrlEnv);
    const apiKey = o.apiKey || envKey?.value || '';
    return {
      ...p,
      custom: false,
      baseUrl: normalizeUrl(o.baseUrl || envUrl?.value || p.baseUrl, p.type),
      baseUrlSource: o.baseUrl ? 'saved' : envUrl ? envUrl.name : 'default',
      apiKey,
      keySource: o.apiKey ? 'saved' : envKey ? envKey.name : null,
      enabled: o.enabled !== false,
      defaultModel: o.defaultModel || (p.id === this.cfg.defaultProvider ? this.cfg.defaultModel : '') || '',
      numCtx: o.numCtx || p.defaultNumCtx || null,
      toolMode: o.toolMode || 'auto',
    };
  }

  resolveCustom(c) {
    return {
      id: c.id,
      label: c.label || c.id,
      type: c.type || 'openai',
      baseUrl: normalizeUrl(c.baseUrl, c.type),
      baseUrlSource: 'saved',
      apiKey: c.apiKey || '',
      keySource: c.apiKey ? 'saved' : null,
      needsKey: Boolean(c.needsKey),
      local: c.local ?? /\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|host\.docker\.internal)/.test(c.baseUrl || ''),
      custom: true,
      enabled: c.enabled !== false,
      defaultModel: c.defaultModel || '',
      numCtx: c.numCtx || (c.type === 'ollama' ? 32768 : null),
      toolMode: c.toolMode || 'auto',
      preferred: [],
      headers: c.headers || {},
    };
  }

  get(id) {
    const p = this.all().find((x) => x.id === id);
    if (!p) throw new Error(`unknown provider "${id}"`);
    return p;
  }

  /** Public, secret-free view of a provider. */
  view(p) {
    return {
      id: p.id,
      label: p.label,
      type: p.type,
      baseUrl: p.baseUrl || null,
      baseUrlSource: p.baseUrlSource || null,
      local: Boolean(p.local),
      custom: Boolean(p.custom),
      needsKey: Boolean(p.needsKey),
      hasKey: Boolean(p.apiKey),
      keySource: p.keySource,
      keyHint: p.apiKey ? `…${p.apiKey.slice(-4)}` : null,
      keyEnv: p.keyEnv?.[0] || null,
      keyUrl: p.keyUrl || null,
      enabled: p.enabled !== false,
      defaultModel: p.defaultModel || null,
      numCtx: p.numCtx || null,
      toolMode: p.toolMode || 'auto',
    };
  }

  // ── discovery ───────────────────────────────────────────────────────────────────────────
  async discover({ refresh = false } = {}) {
    const list = this.all();
    const results = await Promise.all(list.map((p) => this.probe(p, { refresh })));
    const providers = list.map((p, i) => ({ ...this.view(p), ...results[i] }));
    return { providers, defaultProvider: this.pickDefault(providers) };
  }

  pickDefault(providers) {
    const ready = providers.filter((p) => p.status === 'ready' && p.enabled);
    const want = this.cfg.defaultProvider || this.settings.defaults.provider;
    if (want && ready.some((p) => p.id === want)) return want;
    return (ready.find((p) => p.type !== 'offline') || ready[0] || { id: 'offline' }).id;
  }

  async probe(p, { refresh = false } = {}) {
    const hit = this.cache.get(p.id);
    const fingerprint = `${p.baseUrl}|${p.apiKey ? p.apiKey.slice(-6) : ''}`;
    if (!refresh && hit && hit.fingerprint === fingerprint && Date.now() - hit.at < CACHE_MS) return hit.result;
    const result = await this.probeUncached(p);
    if (result.models) result.defaultModel = this.chooseModel(p, result.models);
    result.checkedAt = new Date().toISOString();
    this.cache.set(p.id, { at: Date.now(), fingerprint, result });
    return result;
  }

  async probeUncached(p) {
    if (p.enabled === false) return { status: 'disabled', models: [] };
    if (p.type === 'offline') return { status: 'ready', models: [{ id: 'offline-template-agent', label: 'Template agents (no LLM)', tools: true }] };
    if (p.needsKey && !p.apiKey) return { status: 'no_key', models: [], message: `Add an API key${p.keyEnv?.[0] ? ` or set ${p.keyEnv[0]}` : ''}` };
    const timeoutMs = p.local ? 2500 : 8000;
    try {
      const models = await listModels(p, timeoutMs);
      if (!models.length) return { status: 'empty', models: [], message: p.type === 'ollama' ? 'Ollama is running but has no models. Run: ollama pull qwen2.5-coder' : 'Server returned no models' };
      return { status: 'ready', models };
    } catch (err) {
      const msg = redact(describeError(err));
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return { status: 'auth_error', models: [], message: `Key rejected: ${msg}` };
      if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'EAI_AGAIN'].includes(err.code)) {
        return { status: 'unreachable', models: [], message: p.local ? `Not running at ${p.baseUrl}` : `Cannot reach ${p.baseUrl}: ${msg}` };
      }
      return { status: 'error', models: [], message: msg };
    }
  }

  chooseModel(p, models) {
    if (!models.length) return null;
    const ids = models.map((m) => m.id);
    if (p.defaultModel && ids.includes(p.defaultModel)) return p.defaultModel;
    const usable = models.filter((m) => m.tools !== false);
    for (const pref of p.preferred || []) {
      const m = usable.find((x) => x.id === pref || x.id.startsWith(`${pref}:`) || x.id.startsWith(pref)) || models.find((x) => x.id.startsWith(pref));
      if (m) return m.id;
    }
    return (usable[0] || models[0]).id;
  }

  // ── mutation (Providers page) ───────────────────────────────────────────────────────────
  update(id, patch = {}) {
    const isPreset = PRESETS.some((p) => p.id === id);
    const target = isPreset ? (this.settings.overrides[id] ||= {}) : this.settings.custom.find((c) => c.id === id);
    if (!target) throw new Error(`unknown provider "${id}"`);
    if ('apiKey' in patch) {
      if (patch.apiKey === null || patch.apiKey === '') delete target.apiKey;
      else target.apiKey = String(patch.apiKey).trim();
    }
    if ('baseUrl' in patch) {
      if (!patch.baseUrl) delete target.baseUrl;
      else target.baseUrl = checkUrl(patch.baseUrl);
    }
    for (const k of ['enabled']) if (k in patch) target[k] = Boolean(patch[k]);
    if ('defaultModel' in patch) target.defaultModel = patch.defaultModel ? String(patch.defaultModel) : undefined;
    if ('numCtx' in patch) target.numCtx = patch.numCtx ? Math.max(2048, Math.min(1_048_576, Number(patch.numCtx) | 0)) : undefined;
    if ('toolMode' in patch) target.toolMode = ['auto', 'native', 'json'].includes(patch.toolMode) ? patch.toolMode : 'auto';
    if (!isPreset && 'label' in patch && patch.label) target.label = String(patch.label).slice(0, 60);
    this.save();
    return this.view(this.get(id));
  }

  addCustom({ label, type = 'openai', baseUrl, apiKey, needsKey } = {}) {
    if (!['openai', 'ollama', 'anthropic'].includes(type)) throw new Error('type must be openai, ollama or anthropic');
    if (!label || !String(label).trim()) throw new Error('label is required');
    const url = checkUrl(baseUrl);
    let id = slug(label) || 'custom';
    while (this.all().some((p) => p.id === id)) id = `${id}-2`;
    this.settings.custom.push({ id, label: String(label).trim().slice(0, 60), type, baseUrl: url, ...(apiKey ? { apiKey: String(apiKey).trim() } : {}), needsKey: Boolean(needsKey) });
    this.save();
    return this.view(this.get(id));
  }

  remove(id) {
    const i = this.settings.custom.findIndex((c) => c.id === id);
    if (i === -1) {
      if (PRESETS.some((p) => p.id === id)) {
        delete this.settings.overrides[id];
        this.save();
        return true;
      }
      throw new Error(`unknown provider "${id}"`);
    }
    this.settings.custom.splice(i, 1);
    this.save();
    return true;
  }

  remember(provider, model) {
    this.settings.defaults = { provider, model };
    try {
      this.save();
    } catch {
      /* non-fatal */
    }
  }

  /** Send a tiny tool-calling request to check a provider/model works end to end. */
  async test(id, model) {
    const p = this.get(id);
    if (p.type === 'offline') return { ok: true, toolCalling: 'native', latencyMs: 0, reply: 'offline agents need no model' };
    const chosen = model || (await this.probe(p)).defaultModel;
    if (!chosen) throw new Error(`${p.label} has no model to test`);
    const provider = this.create(id, { model: chosen });
    const tool = { name: 'report_status', description: 'Report your status to the factory.', input_schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] } };
    const started = Date.now();
    try {
      const res = await provider.chat({
        system: 'You are a connectivity check for a software factory. Use the tool.',
        messages: [{ role: 'user', content: 'Call report_status with status "ok".' }],
        tools: [tool],
        maxTokens: 400,
        meta: { kind: 'test', forceTool: 'report_status' },
      });
      const use = res.content.find((c) => c.type === 'tool_use');
      const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ').slice(0, 300);
      const mode = use ? (provider.modeFor?.(chosen) === 'json' ? 'json' : 'native') : 'none';
      return {
        ok: Boolean(use),
        model: chosen,
        toolCalling: mode,
        latencyMs: Date.now() - started,
        reply: use ? `report_status(${JSON.stringify(use.input)})` : text,
        message: use
          ? mode === 'json'
            ? 'Works. This model has no native tool calling, so the factory will use JSON tool calls.'
            : 'Works with native tool calling.'
          : 'The model answered but did not call the tool. It may struggle as a factory agent; try a larger or tool-capable model.',
      };
    } catch (err) {
      return { ok: false, model: chosen, latencyMs: Date.now() - started, message: redact(err.message) };
    }
  }

  // ── instantiation ───────────────────────────────────────────────────────────────────────
  create(id, { model, plannerModel, options = {} } = {}) {
    const p = this.get(id);
    if (p.enabled === false) throw new Error(`provider "${p.label}" is disabled`);
    if (p.type === 'offline') return new OfflineProvider({ faults: this.cfg.offlineFaults });
    if (p.needsKey && !p.apiKey) throw new Error(`${p.label} needs an API key${p.keyEnv?.[0] ? ` (set ${p.keyEnv[0]} or add it on the Providers page)` : ''}`);
    const common = {
      id: p.id,
      label: p.label,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model,
      plannerModel: plannerModel || model,
      maxTokens: options.maxTokens || this.cfg.maxOutputTokens,
      temperature: options.temperature ?? undefined,
    };
    if (p.type === 'anthropic') return new AnthropicProvider(common);
    return new OpenAICompatProvider({
      ...common,
      headers: p.headers || {},
      dialect: p.type === 'ollama' ? 'ollama' : 'openai',
      toolMode: options.toolMode || p.toolMode || 'auto',
      numCtx: p.type === 'ollama' ? options.numCtx || p.numCtx || 32768 : undefined,
    });
  }
}

function checkUrl(u) {
  const s = normalizeUrl(u);
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new Error('base URL is not a valid URL');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('base URL must be http(s)');
  return s;
}

// ── model listing per API flavour ─────────────────────────────────────────────────────────
async function listModels(p, timeoutMs) {
  if (p.type === 'ollama') return listOllama(p, timeoutMs);
  if (p.type === 'anthropic') {
    const res = await requestJson(`${p.baseUrl}/v1/models?limit=100`, { headers: { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' }, timeoutMs });
    return (res.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id, tools: true, created: m.created_at }));
  }
  const res = await requestJson(`${p.baseUrl}/models`, { headers: { ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}), ...(p.headers || {}) }, timeoutMs });
  const raw = Array.isArray(res) ? res : res.data || res.models || [];
  let models = raw
    .map((m) => {
      const id = String(m.id || m.name || '').replace(/^models\//, '');
      const sp = m.supported_parameters;
      return {
        id,
        label: m.name && m.name !== m.id ? m.name : id,
        tools: Array.isArray(sp) ? sp.includes('tools') : null,
        ctx: m.context_length || m.context_window || m.max_context_length || null,
        created: m.created || null,
      };
    })
    .filter((m) => m.id && !NON_CHAT.test(m.id));
  if (p.id === 'openrouter') models = models.filter((m) => m.tools !== false);
  models.sort((a, b) => (b.created || 0) - (a.created || 0) || a.id.localeCompare(b.id));
  return models;
}

async function listOllama(p, timeoutMs) {
  const tags = await requestJson(`${p.baseUrl}/api/tags`, { timeoutMs });
  const models = (tags.models || []).map((m) => ({
    id: m.name || m.model,
    label: m.name || m.model,
    size: m.size || null,
    params: m.details?.parameter_size || null,
    family: m.details?.family || null,
    quant: m.details?.quantization_level || null,
    tools: null,
  }));
  // /api/show reports capabilities (tools, embedding…) and context length on recent Ollama.
  const queue = models.slice(0, 60);
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        try {
          const info = await requestJson(`${p.baseUrl}/api/show`, { method: 'POST', body: { model: m.id }, timeoutMs: Math.max(timeoutMs, 4000) });
          if (Array.isArray(info.capabilities)) {
            m.tools = info.capabilities.includes('tools');
            m.embedding = info.capabilities.includes('embedding') && !info.capabilities.includes('completion');
          }
          const ctxKey = Object.keys(info.model_info || {}).find((k) => k.endsWith('.context_length'));
          if (ctxKey) m.ctx = info.model_info[ctxKey];
        } catch {
          /* older Ollama: capabilities unknown */
        }
      }
    }),
  );
  return models.filter((m) => !m.embedding && !/embed/i.test(m.id)).sort((a, b) => (b.tools === true) - (a.tools === true) || a.id.localeCompare(b.id));
}
