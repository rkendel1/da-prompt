// Claude via the Anthropic Messages API, with tool use. No SDK dependency.

import { requestWithRetry, describeError } from './http.js';

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
    this.timeoutMs = timeoutMs || 15 * 60_000;
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
    if (tools?.length && meta.forceTool) body.tool_choice = { type: 'tool', name: meta.forceTool };
    try {
      const json = await requestWithRetry(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        body,
        signal,
        timeoutMs: this.timeoutMs,
      });
      return { content: json.content || [], stop_reason: json.stop_reason, usage: json.usage || {} };
    } catch (err) {
      if (signal?.aborted) throw new Error('cancelled');
      throw new Error(`Anthropic API (${model}): ${describeError(err)}`);
    }
  }
}
