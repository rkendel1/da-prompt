// Mock LLM servers that speak the real OpenAI Chat Completions and Ollama /api/chat protocols.
// Their "brain" is the offline template agent, so a whole factory run can go through the real
// HTTP adapters, message translation and tool-call parsing.

import http from 'node:http';
import { OfflineProvider } from '../src/providers/offline.js';

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).map((c) => c.text || '').join('\n');
}

/** Decide the next reply from an OpenAI-style message list and the tool names on offer. */
async function think(messages, toolNames, brain) {
  const users = messages.filter((m) => m.role === 'user');
  const first = textOf(users[0]?.content);
  const assistantTurns = messages.filter((m) => m.role === 'assistant').length;
  if (toolNames.includes('submit_plan')) {
    const idea = (first.match(/Idea: (.*)/) || [])[1] || 'App';
    const res = await brain.chat({ messages: [], meta: { kind: 'plan', inputs: { idea } } });
    return { calls: res.content.filter((c) => c.type === 'tool_use') };
  }
  if (toolNames.includes('complete_task')) {
    const head = first.match(/# Task ([\w-]+): (.*?)\s+\(role: (\w+), attempt (\d+) of (\d+)\)/);
    const verify = [...(first.split('## Verification')[1] || '').split('\n## ')[0].matchAll(/^- `(.*)`$/gm)].map((m) => m[1]);
    const task = { id: head[1], title: head[2], role: head[3], verify };
    const fake = Array.from({ length: assistantTurns }, () => ({ role: 'assistant' }));
    const res = await brain.chat({ messages: fake, meta: { kind: 'task', task, attempt: Number(head[4]), inputs: { idea: 'Mock app' } } });
    return { calls: res.content.filter((c) => c.type === 'tool_use'), text: textOf(res.content.filter((c) => c.type === 'text')) };
  }
  if (toolNames.includes('report_status')) return { calls: [{ name: 'report_status', input: { status: 'ok' } }] };
  return { text: 'Mock summary: the app was built and verified.' };
}

/**
 * Start a mock server.
 *  flavor "openai": GET /v1/models, POST /v1/chat/completions (native tool_calls)
 *  flavor "ollama": GET /api/tags, POST /api/show, POST /api/chat
 *  noTools: reject requests that include tools (like an Ollama model without tool support);
 *           the client must fall back to JSON tool calls in text.
 */
export async function startMockLLM({ flavor = 'openai', models = ['mock-coder'], noTools = false, apiKey = null } = {}) {
  const brain = new OfflineProvider({ faults: 'on', delayMs: 0 });
  const log = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    log.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { error: { message: 'invalid api key' } });

    if (flavor === 'openai' && req.method === 'GET' && req.url === '/v1/models') {
      return send(200, { object: 'list', data: [...models.map((id) => ({ id, object: 'model' })), { id: 'text-embedding-3-small', object: 'model' }] });
    }
    if (flavor === 'ollama' && req.method === 'GET' && req.url === '/api/tags') {
      return send(200, { models: [...models.map((name) => ({ name, size: 4_000_000_000, details: { parameter_size: '7B', family: 'qwen2' } })), { name: 'nomic-embed-text:latest', details: {} }] });
    }
    if (flavor === 'ollama' && req.method === 'POST' && req.url === '/api/show') {
      const caps = /embed/.test(body.model) ? ['embedding'] : noTools ? ['completion'] : ['completion', 'tools'];
      return send(200, { capabilities: caps, model_info: { 'qwen2.context_length': 32768 } });
    }
    const isChat = (flavor === 'openai' && req.url === '/v1/chat/completions') || (flavor === 'ollama' && req.url === '/api/chat');
    if (!isChat || req.method !== 'POST') return send(404, { error: 'not found' });
    if (!models.includes(body.model)) return send(404, { error: `model "${body.model}" not found` });
    if (noTools && body.tools?.length) return send(400, { error: `registry.ollama.ai/library/${body.model} does not support tools` });

    // In JSON mode the tool list lives in the system prompt.
    const sys = textOf(body.messages[0]?.content);
    const toolNames = body.tools?.length
      ? body.tools.map((t) => t.function.name)
      : [...sys.matchAll(/^- (\w+): /gm)].map((m) => m[1]);
    const { calls = [], text = '' } = await think(body.messages, toolNames, brain);
    const usage = { prompt: Math.ceil(raw.length / 4), completion: 50 };

    let message;
    if (!body.tools?.length && calls.length) {
      // JSON tool calls in text, one object per line (as weaker local models tend to do).
      message = { role: 'assistant', content: calls.map((c) => JSON.stringify({ tool: c.name, input: c.input })).join('\n') };
    } else if (flavor === 'ollama') {
      message = { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.input } })) } : {}) };
    } else {
      message = { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map((c, i) => ({ id: `call_${log.length}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) };
    }
    if (flavor === 'ollama') return send(200, { model: body.model, message, done: true, done_reason: 'stop', prompt_eval_count: usage.prompt, eval_count: usage.completion });
    return send(200, { id: 'chatcmpl-mock', choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: flavor === 'ollama' ? `http://127.0.0.1:${port}` : `http://127.0.0.1:${port}/v1`,
    log,
    close: () => new Promise((r) => server.close(r)),
  };
}
