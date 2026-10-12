// OpenAI-compatible chat providers: OpenAI, OpenRouter, Groq, Gemini, Mistral, DeepSeek, xAI,
// Together, LM Studio, llama.cpp, vLLM … plus Ollama's native /api/chat (dialect "ollama"),
// which lets us set the context window that Ollama otherwise keeps small.
//
// The factory speaks Anthropic-style content blocks internally (text / tool_use / tool_result);
// this module translates both ways, and falls back to JSON-in-text tool calling for models
// that have no native function calling.

import { requestWithRetry, HttpError, describeError } from './http.js';
import { parseArgs, parseToolCallsFromText, jsonToolInstructions, stripThinking } from './tooltext.js';

// Remember models that rejected native tools so we don't pay for the failure every call.
const JSON_MODE_MODELS = new Set();

const NO_TOOLS_ERROR = /does not support tools|tools? (are|is) not supported|tool[_ ]?(use|calling|choice).*not supported|unsupported.*tool|unrecognized.*tools|Extra inputs.*tools|function calling is not/i;

export class OpenAICompatProvider {
  constructor({ id, label, baseUrl, apiKey, headers = {}, model, plannerModel, dialect = 'openai', toolMode = 'auto', numCtx, temperature, maxTokens = 8192, timeoutMs }) {
    if (!model) throw new Error(`no model selected for provider "${label || id}"`);
    this.name = id;
    this.label = label || id;
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.headers = headers;
    this.model = model;
    this.plannerModel = plannerModel || model;
    this.dialect = dialect;
    this.toolMode = toolMode; // auto | native | json
    this.numCtx = numCtx;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs || 30 * 60_000;
  }

  describe() {
    return { name: this.name, label: this.label, model: this.model, plannerModel: this.plannerModel, dialect: this.dialect, toolMode: this.toolMode };
  }

  modeFor(model) {
    if (this.toolMode === 'json' || this.toolMode === 'native') return this.toolMode;
    return JSON_MODE_MODELS.has(`${this.baseUrl}|${model}`) ? 'json' : 'native';
  }

  async chat({ system, messages, tools = [], maxTokens, signal, meta = {} }) {
    const model = meta.kind === 'plan' ? this.plannerModel : this.model;
    const mode = tools.length ? this.modeFor(model) : 'native';
    try {
      return await this.send({ model, system, messages, tools, mode, maxTokens, signal, meta });
    } catch (err) {
      // A model that rejects native tools: switch to JSON tool calling and retry once.
      if (tools.length && mode === 'native' && this.toolMode === 'auto' && err instanceof HttpError && NO_TOOLS_ERROR.test(err.body)) {
        JSON_MODE_MODELS.add(`${this.baseUrl}|${model}`);
        return this.send({ model, system, messages, tools, mode: 'json', maxTokens, signal, meta });
      }
      if (signal?.aborted) throw new Error('cancelled');
      throw new Error(`${this.label} (${model}): ${describeError(err)}`);
    }
  }

  async send({ model, system, messages, tools, mode, maxTokens, signal, meta }) {
    const sys = mode === 'json' && tools.length ? `${system}\n\n${jsonToolInstructions(tools, { forceTool: meta.forceTool })}` : system;
    const msgs = toOpenAIMessages(sys, messages, { mode, dialect: this.dialect });
    const toolNames = new Set(tools.map((t) => t.name));
    const limit = maxTokens || this.maxTokens;
    let raw;
    if (this.dialect === 'ollama') {
      const body = { model, messages: msgs, stream: false, options: { num_predict: limit } };
      if (this.numCtx) body.options.num_ctx = this.numCtx;
      if (this.temperature != null) body.options.temperature = this.temperature;
      if (mode === 'native' && tools.length) body.tools = tools.map(toOpenAITool);
      const res = await requestWithRetry(`${this.baseUrl}/api/chat`, { method: 'POST', body, signal, headers: this.authHeaders(), timeoutMs: this.timeoutMs }, { retries: 2 });
      raw = {
        message: res.message || {},
        finish: res.done_reason === 'length' ? 'length' : 'stop',
        usage: { input_tokens: res.prompt_eval_count || 0, output_tokens: res.eval_count || 0 },
      };
    } else {
      const body = { model, messages: msgs, max_tokens: limit };
      if (this.temperature != null) body.temperature = this.temperature;
      if (mode === 'native' && tools.length) {
        body.tools = tools.map(toOpenAITool);
        if (meta.forceTool) body.tool_choice = { type: 'function', function: { name: meta.forceTool } };
      }
      const res = await requestWithRetry(`${this.baseUrl}/chat/completions`, { method: 'POST', body, signal, headers: this.authHeaders(), timeoutMs: this.timeoutMs });
      const choice = res.choices?.[0] || {};
      raw = {
        message: choice.message || {},
        finish: choice.finish_reason,
        usage: { input_tokens: res.usage?.prompt_tokens || 0, output_tokens: res.usage?.completion_tokens || 0 },
      };
    }
    const content = fromOpenAIMessage(raw.message, { toolNames });
    const hasTool = content.some((c) => c.type === 'tool_use');
    return { content, stop_reason: hasTool ? 'tool_use' : raw.finish === 'length' ? 'max_tokens' : 'end_turn', usage: raw.usage };
  }

  authHeaders() {
    return { ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...this.headers };
  }
}

export function toOpenAITool(t) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } };
}

const asText = (content) =>
  typeof content === 'string'
    ? content
    : (content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

/** Anthropic-style messages → OpenAI/Ollama chat messages. */
export function toOpenAIMessages(system, messages, { mode = 'native', dialect = 'openai' } = {}) {
  const out = [{ role: 'system', content: system }];
  const toolNameById = new Map();
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = asText(m.content);
      const uses = m.content.filter((b) => b.type === 'tool_use');
      uses.forEach((u) => toolNameById.set(u.id, u.name));
      if (mode === 'json') {
        const calls = uses.map((u) => JSON.stringify({ tool: u.name, input: u.input }));
        out.push({ role: 'assistant', content: [text, ...calls].filter(Boolean).join('\n') });
      } else {
        const msg = { role: 'assistant', content: text || (dialect === 'ollama' ? '' : null) };
        if (uses.length) {
          msg.tool_calls = uses.map((u) =>
            dialect === 'ollama'
              ? { function: { name: u.name, arguments: u.input || {} } }
              : { id: u.id, type: 'function', function: { name: u.name, arguments: JSON.stringify(u.input || {}) } },
          );
        }
        out.push(msg);
      }
      continue;
    }
    // user turn: tool results and/or text
    const results = m.content.filter((b) => b.type === 'tool_result');
    const text = asText(m.content);
    for (const r of results) {
      const body = `${r.is_error ? '[error] ' : ''}${typeof r.content === 'string' ? r.content : asText(r.content)}`;
      if (mode === 'json') {
        out.push({ role: 'user', content: `Result of ${toolNameById.get(r.tool_use_id) || 'tool'}:\n${body}` });
      } else if (dialect === 'ollama') {
        out.push({ role: 'tool', content: body, tool_name: toolNameById.get(r.tool_use_id) });
      } else {
        out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: body });
      }
    }
    if (text) out.push({ role: 'user', content: text });
  }
  return mergeConsecutive(out);
}

// Some servers reject two user messages in a row (JSON mode produces them).
function mergeConsecutive(msgs) {
  const out = [];
  for (const m of msgs) {
    const prev = out.at(-1);
    if (prev && prev.role === 'user' && m.role === 'user' && typeof prev.content === 'string' && typeof m.content === 'string') {
      prev.content += `\n\n${m.content}`;
    } else out.push({ ...m });
  }
  return out;
}

let seq = 0;
const newId = () => `call_${Date.now().toString(36)}_${(seq += 1)}`;

/** OpenAI/Ollama assistant message → Anthropic-style content blocks. */
export function fromOpenAIMessage(message = {}, { toolNames = new Set() } = {}) {
  const blocks = [];
  let text = typeof message.content === 'string' ? message.content : asText(message.content);
  const native = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const uses = native
    .map((c) => ({ name: c.function?.name, input: parseArgs(c.function?.arguments), id: c.id }))
    .filter((c) => c.name);
  if (uses.length === 0 && text && toolNames.size) {
    // JSON mode, or a model that wrote its tool call into the text.
    const parsed = parseToolCallsFromText(text, toolNames);
    if (parsed.calls.length) {
      uses.push(...parsed.calls);
      text = parsed.text;
    }
  }
  text = stripThinking(text || '');
  if (text) blocks.push({ type: 'text', text });
  for (const u of uses) blocks.push({ type: 'tool_use', id: u.id || newId(), name: u.name, input: u.input || {} });
  return blocks;
}
