// Streaming through the real provider adapters (OpenAI-compatible SSE, Ollama NDJSON, Anthropic SSE): incremental
// deltas, usage, cancellation, mid-stream failure (partial text kept), and HTTP errors without leaking the key.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAICompatProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { startMockLLM } from './mock-llm.js';

const closers = [];
after(async () => { for (const c of closers) await c(); });
const msgs = [{ role: 'user', content: 'say something' }];

test('OpenAI-compatible streaming: text arrives in pieces, usage is reported, the key is only sent as a header', async () => {
  const llm = await startMockLLM({ flavor: 'openai', models: ['m1'], apiKey: 'sk-test-secret-key-1234567890', streamOpts: { slowMs: 5 } });
  closers.push(llm.close);
  const p = new OpenAICompatProvider({ id: 'mock', label: 'Mock', baseUrl: llm.url, apiKey: 'sk-test-secret-key-1234567890', model: 'm1' });
  const pieces = [];
  const r = await p.chatStream({ system: 'sys', messages: msgs, onText: (d) => pieces.push(d) });
  assert.ok(pieces.length > 2, `incremental: ${pieces.length} pieces`);
  assert.equal(pieces.join(''), r.text);
  assert.match(r.text, /Mock summary/);
  assert.equal(r.usage.output_tokens > 0, true);
  const sent = llm.log.at(-1);
  assert.equal(sent.body.stream, true);
  assert.equal(sent.headers.authorization, 'Bearer sk-test-secret-key-1234567890');
  assert.ok(!JSON.stringify(sent.body).includes('sk-test-secret'), 'the key is never in the request body');
});

test('Ollama streaming (NDJSON) and a mid-stream failure keep the partial text', async () => {
  const llm = await startMockLLM({ flavor: 'ollama', models: ['qwen'], streamOpts: { slowMs: 2 } });
  closers.push(llm.close);
  const p = new OpenAICompatProvider({ id: 'ollama', label: 'Ollama', baseUrl: llm.url, model: 'qwen', dialect: 'ollama' });
  const pieces = [];
  const r = await p.chatStream({ system: 'sys', messages: msgs, onText: (d) => pieces.push(d) });
  assert.ok(pieces.length > 2);
  assert.equal(r.text, pieces.join(''));
  assert.ok(r.usage.output_tokens > 0);

  const flaky = await startMockLLM({ flavor: 'ollama', models: ['qwen'], streamOpts: { failAfter: 2 } });
  closers.push(flaky.close);
  const q = new OpenAICompatProvider({ id: 'ollama', label: 'Ollama', baseUrl: flaky.url, model: 'qwen', dialect: 'ollama' });
  await assert.rejects(q.chatStream({ system: 'sys', messages: msgs, onText() {} }), (e) => {
    assert.match(e.message, /Ollama \(qwen\)/);
    assert.equal(e.partial.length > 0, true, 'what had arrived is kept');
    return true;
  });
});

test('cancelling a stream aborts the request and reports cancelled with the partial text', async () => {
  const llm = await startMockLLM({ flavor: 'openai', models: ['m1'], streamOpts: { slowMs: 30 } });
  closers.push(llm.close);
  const p = new OpenAICompatProvider({ id: 'mock', label: 'Mock', baseUrl: llm.url, model: 'm1' });
  const ctl = new AbortController();
  let n = 0;
  const run = p.chatStream({ system: 'sys', messages: msgs, signal: ctl.signal, onText: () => { if (++n === 2) ctl.abort(); } });
  await assert.rejects(run, (e) => e.message === 'cancelled' && typeof e.partial === 'string' && e.partial.length > 0);
});

test('HTTP errors are readable and never echo the credential', async () => {
  const llm = await startMockLLM({ flavor: 'openai', models: ['m1'], apiKey: 'sk-the-real-key-abcdefghijklmnop' });
  closers.push(llm.close);
  const p = new OpenAICompatProvider({ id: 'mock', label: 'Mock', baseUrl: llm.url, apiKey: 'sk-wrong-key-zzzzzzzzzzzzzzzzzzzz', model: 'm1' });
  await assert.rejects(p.chatStream({ system: 's', messages: msgs }), (e) => /HTTP 401/.test(e.message) && !/sk-wrong-key/.test(e.message));
  const gone = new OpenAICompatProvider({ id: 'x', label: 'X', baseUrl: 'http://127.0.0.1:9', model: 'm' });
  await assert.rejects(gone.chatStream({ system: 's', messages: msgs }), /connection refused/);
});

test('Anthropic streaming parses the Messages SSE events', async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let b = '';
    for await (const c of req) b += c;
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(b) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    ev({ type: 'message_start', message: { usage: { input_tokens: 11 } } });
    for (const t of ['Hello', ', ', 'world']) ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } });
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => server.close(r)));
  const p = new AnthropicProvider({ apiKey: 'sk-ant-test-key-aaaaaaaaaaaaaaaa', model: 'claude-test', baseUrl: `http://127.0.0.1:${server.address().port}` });
  const pieces = [];
  const r = await p.chatStream({ system: 'sys', messages: msgs, onText: (d) => pieces.push(d) });
  assert.deepEqual(pieces, ['Hello', ', ', 'world']);
  assert.equal(r.text, 'Hello, world');
  assert.deepEqual(r.usage, { input_tokens: 11, output_tokens: 3 });
  assert.equal(seen[0].body.stream, true);
  assert.equal(seen[0].headers['x-api-key'], 'sk-ant-test-key-aaaaaaaaaaaaaaaa');
});
