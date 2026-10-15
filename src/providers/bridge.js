// A loopback OpenAI-compatible endpoint in front of one of da-prompt's own providers, for agent engines that bring their own
// model client (today: the fx engine). The engine talks to http://127.0.0.1:<port>/v1; every request is answered by
// `provider.chat()`, so the engine gets exactly what the built-in agents get: Ollama's native API with num_ctx, transport
// retries, JSON tool calling for models without native tools, recovery of tool calls written as text, and every provider
// type (Anthropic included). The real credential never leaves this process: the engine authenticates to the bridge with a
// one-off token.
//
// Streaming requests get their response headers at once and a keepalive comment every few seconds while the model works, so
// an engine's own "first response" deadline (fx: 120 s) does not cut off a slow local model; the provider's own timeouts apply.

import http from 'node:http';
import crypto from 'node:crypto';
import { parseArgs } from './tooltext.js';
import { compactHistory, historyBudget } from './history.js';

export const BRIDGE_KEEPALIVE_MS = 5_000;
const MAX_BODY = 64 * 1024 * 1024;

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text' || typeof p?.text === 'string').map((p) => p.text).join('\n') : c == null ? '' : String(c));

/** OpenAI chat request → the factory's Anthropic-style { system, messages, tools }. */
export function fromOpenAIRequest(body = {}) {
  const system = [];
  const messages = [];
  const push = (role, blocks) => {
    const last = messages.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') {
      system.push(textOf(m.content));
    } else if (m.role === 'assistant') {
      const blocks = [];
      const text = textOf(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (c?.function?.name) blocks.push({ type: 'tool_use', id: String(c.id || `call_${crypto.randomBytes(4).toString('hex')}`), name: c.function.name, input: parseArgs(c.function.arguments) });
      }
      if (blocks.length) push('assistant', blocks);
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: String(m.tool_call_id || ''), content: textOf(m.content) }]);
    } else {
      const text = textOf(m.content);
      if (text) push('user', [{ type: 'text', text }]);
    }
  }
  // A conversation starts with the user; plain-text user turns are sent as strings, like the factory's own.
  if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
  for (const m of messages) if (m.role === 'user' && m.content.every((b) => b.type === 'text')) m.content = m.content.map((b) => b.text).join('\n\n');
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .map((t) => t?.function || t)
    .filter((f) => f && typeof f.name === 'string')
    .map((f) => ({ name: f.name, description: f.description || '', input_schema: f.parameters || { type: 'object', properties: {} } }));
  return { system: system.filter(Boolean).join('\n\n'), messages, tools };
}

/** The factory's reply → one OpenAI assistant message plus finish reason and usage. */
export function toOpenAIReply(res = {}) {
  const content = Array.isArray(res.content) ? res.content : [];
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const toolCalls = content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
  const finish = toolCalls.length ? 'tool_calls' : res.stop_reason === 'max_tokens' ? 'length' : 'stop';
  const usage = { prompt_tokens: res.usage?.input_tokens || 0, completion_tokens: res.usage?.output_tokens || 0 };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  return { message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish, usage };
}

/**
 * Start a bridge for `provider` on 127.0.0.1 (random port). Resolves { baseUrl, token, lastError(), budget(), close() }. `meta` is passed
 * to every provider.chat() call. `track` (the run's { check, add }) is charged for every model request the engine makes, as the
 * built-in loop does: the engine only reports usage when a whole turn ends, which would let a budget be passed unnoticed and
 * would lose the usage of requests in a turn that failed. A request is refused once the budget is spent; budget() then holds
 * the BudgetError so the engine can stop the attempt as a budget stop, not a model error.
 * `token` (default: random) must be sent as `Authorization: Bearer <token>`.
 */
export function startBridge(provider, { token = crypto.randomBytes(24).toString('hex'), meta = {}, keepaliveMs = BRIDGE_KEEPALIVE_MS, track } = {}) {
  let lastError = null;
  let budget = null;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '');
    const reply = (status, obj) => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const auth = String(req.headers.authorization || '');
    const given = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '');
    const want = Buffer.from(token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return reply(401, { error: { message: 'unauthorized', type: 'auth_error' } });
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) return reply(200, { object: 'list', data: [{ id: provider.model, object: 'model' }] });
    if (req.method !== 'POST' || (path !== '/v1/chat/completions' && path !== '/chat/completions')) return reply(404, { error: { message: 'not found' } });

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(400, { error: { message: 'invalid JSON body' } });
      }
      const ac = new AbortController();
      // A dead socket does not always emit 'close' on the request once its body was read; watch the response too.
      const abort = () => { if (!res.writableFinished) ac.abort(); };
      res.on('close', abort);
      const stream = body.stream === true;
      const id = `chatcmpl-${crypto.randomBytes(6).toString('hex')}`;
      const created = Math.floor(Date.now() / 1000);
      const model = String(body.model || provider.model || '');
      let ping;
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.flushHeaders();
        res.write(': da-prompt bridge\n\n');
        ping = setInterval(() => res.write(': keepalive\n\n'), keepaliveMs);
      }
      const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      try {
        const req2 = fromOpenAIRequest(body);
        // The engine keeps its whole history; what is sent must still fit the model's window (see history.js).
        req2.messages = compactHistory(req2.messages, historyBudget(provider, req2.system, req2.tools));
        const maxTokens = Number(body.max_tokens ?? body.max_completion_tokens);
        try {
          track?.check();
        } catch (e) {
          budget = e;
          throw e;
        }
        const out = await provider.chat({ ...req2, ...(Number.isSafeInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}), signal: ac.signal, meta: { kind: 'task', ...meta } });
        track?.add(out.usage);
        const { message, finish, usage } = toOpenAIReply(out);
        lastError = null;
        if (!stream) return reply(200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }], usage });
        clearInterval(ping);
        const delta = { role: 'assistant' };
        if (message.content) delta.content = message.content;
        if (message.tool_calls) delta.tool_calls = message.tool_calls.map((c, index) => ({ index, ...c }));
        sse({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: null }] });
        sse({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage });
        res.end('data: [DONE]\n\n');
      } catch (err) {
        clearInterval(ping);
        if (ac.signal.aborted) return res.destroy(); // the engine hung up (cancelled turn): not a model error
        lastError = String(err?.message || err);
        const error = { message: lastError, type: 'provider_error' };
        if (stream) res.end(`data: ${JSON.stringify({ error })}\n\n`);
        else reply(502, { error });
      }
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        token,
        lastError: () => lastError,
        budget: () => budget,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}
