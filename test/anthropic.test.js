import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { PLAN_TOOL } from '../src/agents.js';

test('AnthropicProvider sends a Messages API request, forces the plan tool, and retries overloads', async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    if (seen.length === 1) {
      res.writeHead(529, { 'retry-after': '0' });
      return res.end('{"type":"error","error":{"type":"overloaded_error"}}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'submit_plan', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const p = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-sonnet-5-5', plannerModel: 'claude-opus-5-5', baseUrl: `http://127.0.0.1:${server.address().port}`, maxTokens: 1000 });
  const res = await p.chat({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [PLAN_TOOL], meta: { kind: 'plan', forceTool: 'submit_plan' } });
  server.close();

  assert.equal(seen.length, 2);
  const { url, headers, body } = seen[1];
  assert.equal(url, '/v1/messages');
  assert.equal(headers['x-api-key'], 'test-key');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(body.model, 'claude-opus-5-5');
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'submit_plan' });
  assert.equal(body.tools[0].name, 'submit_plan');
  assert.equal(res.content[0].name, 'submit_plan');
  assert.equal(res.usage.input_tokens, 10);
});

test('AnthropicProvider requires a key and surfaces non-retryable errors', async () => {
  assert.throws(() => new AnthropicProvider({ apiKey: '', model: 'm', baseUrl: 'http://x' }), /ANTHROPIC_API_KEY/);
  const server = http.createServer((req, res) => {
    res.writeHead(400);
    res.end('{"error":{"message":"bad request"}}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const p = new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: `http://127.0.0.1:${server.address().port}`, maxTokens: 10 });
  await assert.rejects(p.chat({ system: 's', messages: [{ role: 'user', content: 'x' }] }), /Anthropic API \(m\): HTTP 400/);
  server.close();
});

test('a model that refuses a forced tool_choice is asked for the tool in words instead, and remembered', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push(body);
      if (body.tool_choice) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model"}}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'tool_use', id: 't1', name: 'submit_plan', input: { ok: true } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const p = new AnthropicProvider({ apiKey: 'k', model: 'claude-sonnet-5-5', baseUrl: `http://127.0.0.1:${server.address().port}`, maxTokens: 100 });
  const ask = () => p.chat({ system: 'sys', messages: [{ role: 'user', content: 'plan' }], tools: [PLAN_TOOL], meta: { kind: 'plan', forceTool: 'submit_plan' } });
  const first = await ask();
  assert.equal(first.content[0].name, 'submit_plan');
  assert.equal(seen.length, 2, 'one refused attempt, one retry without the forced choice');
  assert.ok(seen[0].tool_choice && !seen[1].tool_choice);
  assert.match(seen[1].system[0].text, /You must reply by calling the tool "submit_plan"/);
  await ask();
  assert.equal(seen.length, 3, 'the next call does not try the forced choice again');
  assert.ok(!seen[2].tool_choice);
  // A different 400 is still an error, not silently retried.
  const bad = http.createServer((req, res) => { res.writeHead(400); res.end('{"error":{"message":"bad request"}}'); });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  const q = new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: `http://127.0.0.1:${bad.address().port}`, maxTokens: 10 });
  await assert.rejects(q.chat({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [PLAN_TOOL], meta: { forceTool: 'submit_plan' } }), /HTTP 400.*bad request/);
  server.close();
  bad.close();
});
