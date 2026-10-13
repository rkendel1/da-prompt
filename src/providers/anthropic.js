// Claude via the Anthropic Messages API, with tool use. No SDK dependency.

import { requestWithRetry, requestStream, lineSplitter, describeError } from './http.js';

// Fixed limit (not configurable): one request may take this long in total.
export const REQUEST_TIMEOUT_MS = 15 * 60_000;

export class AnthropicProvider {
  constructor({ id = 'anthropic', label = 'Anthropic', apiKey, model, plannerModel, baseUrl = 'https://api.anthropic.com', maxTokens = 8192, temperature, timeoutMs }) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set; add a key on the Providers page or choose another provider');
    if (!model) throw new Error('no model selected for Anthropic');
    this.name = id;
    this.label = label;
    this.apiKey = apiKey;
    this.model = model;
    this.plannerModel = plannerModel || model;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.timeoutMs = timeoutMs || REQUEST_TIMEOUT_MS;
    this.noForcedTool = new Set(); // models that rejected a forced tool_choice
  }

  describe() {
    return { name: this.name, label: this.label, model: this.model, plannerModel: this.plannerModel, dialect: 'anthropic', toolMode: 'native' };
  }

  async chat({ system, messages, tools, maxTokens, signal, meta = {} }) {
    const model = meta.kind === 'plan' ? this.plannerModel : this.model;
    const body = {
      model,
      max_tokens: maxTokens || this.maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
    };
    if (this.temperature != null) body.temperature = this.temperature;
    if (tools?.length) body.tools = tools;
    // Some models (newer ones, and any with extended thinking) refuse a forced tool_choice. Remember that per model and ask
    // for the tool in words instead: the caller already handles a reply that did not call it.
    const forced = tools?.length && meta.forceTool;
    const send = (b) => requestWithRetry(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: b,
      signal,
      timeoutMs: this.timeoutMs,
    });
    const withoutForce = () => ({ ...body, system: [{ type: 'text', text: `${system}\n\nYou must reply by calling the tool "${meta.forceTool}".`, cache_control: { type: 'ephemeral' } }] });
    try {
      let json;
      if (forced && !this.noForcedTool.has(model)) {
        try {
          json = await send({ ...body, tool_choice: { type: 'tool', name: meta.forceTool } });
        } catch (err) {
          if (signal?.aborted || !/tool_choice/i.test(String(err.message || describeError(err)))) throw err;
          this.noForcedTool.add(model);
          json = await send(withoutForce());
        }
      } else json = await send(forced ? withoutForce() : body);
      return { content: json.content || [], stop_reason: json.stop_reason, usage: { ...(json.usage || {}), reported: Boolean(json.usage) } };
    } catch (err) {
      if (signal?.aborted) throw new Error('cancelled');
      throw new Error(`Anthropic API (${model}): ${describeError(err)}`);
    }
  }

  /** Plain-text conversation with streaming (no tools). `onText(delta)` is called as tokens arrive. */
  async chatStream({ system, messages, maxTokens, signal, onText }) {
    const model = this.model;
    const body = { model, max_tokens: maxTokens || this.maxTokens, stream: true, system: [{ type: 'text', text: system }], messages };
    if (this.temperature != null) body.temperature = this.temperature;
    let text = '';
    let usage = { input_tokens: 0, output_tokens: 0 };
    let stop = 'end_turn';
    const lines = lineSplitter((line) => {
      if (!line.startsWith('data:')) return;
      let j;
      try {
        j = JSON.parse(line.slice(5).trim());
      } catch {
        return;
      }
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
        text += j.delta.text;
        onText?.(j.delta.text);
      } else if (j.type === 'message_start') usage.input_tokens = j.message?.usage?.input_tokens || 0;
      else if (j.type === 'message_delta') {
        usage.output_tokens = j.usage?.output_tokens || usage.output_tokens;
        if (j.delta?.stop_reason === 'max_tokens') stop = 'max_tokens';
      } else if (j.type === 'error') throw new Error(j.error?.message || 'the provider reported an error');
    });
    try {
      await requestStream(`${this.baseUrl}/v1/messages`, { body, signal, headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }, timeoutMs: this.timeoutMs }, (c) => lines.push(c));
      lines.end();
    } catch (err) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { partial: text });
      throw Object.assign(new Error(`Anthropic API (${model}): ${describeError(err)}`), { partial: text });
    }
    return { text, usage, stop };
  }
}
