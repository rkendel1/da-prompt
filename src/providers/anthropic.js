// Claude via the Anthropic Messages API, with tool use. No SDK dependency: plain fetch.

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export class AnthropicProvider {
  constructor({ apiKey, model, plannerModel, baseUrl, maxTokens }) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set; use the offline provider or set the key');
    this.name = 'anthropic';
    this.apiKey = apiKey;
    this.model = model;
    this.plannerModel = plannerModel || model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.maxTokens = maxTokens;
  }

  describe() {
    return { name: this.name, model: this.model, plannerModel: this.plannerModel };
  }

  async chat({ system, messages, tools, maxTokens, signal, meta = {} }) {
    const body = {
      model: meta.kind === 'plan' ? this.plannerModel : this.model,
      max_tokens: maxTokens || this.maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
    };
    if (tools?.length) body.tools = tools;
    if (meta.forceTool) body.tool_choice = { type: 'tool', name: meta.forceTool };

    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (signal?.aborted) throw new Error('cancelled');
      let res;
      try {
        res = await fetch(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw new Error('cancelled');
        lastErr = err;
        await sleep(backoff(attempt));
        continue;
      }
      if (res.ok) {
        const json = await res.json();
        return { content: json.content || [], stop_reason: json.stop_reason, usage: json.usage || {} };
      }
      const text = await res.text().catch(() => '');
      lastErr = new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
      if (!RETRYABLE.has(res.status)) throw lastErr;
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
    }
    throw lastErr;
  }
}

const backoff = (n) => Math.min(30_000, 1000 * 2 ** n) + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
