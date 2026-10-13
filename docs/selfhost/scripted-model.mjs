#!/usr/bin/env node
// A scripted stand-in for a language model, used ONLY to demonstrate the da-prompt CLI end to end where no real
// model credentials exist. It speaks the OpenAI Chat Completions protocol (GET /v1/models, POST
// /v1/chat/completions with tool calls), so the whole factory path — planner, agent loop, tool sandbox, verification,
// review, apply — is the real one. Only the "thinking" is canned: it plans one task, reads src/security.js, rewrites
// redact() to also mask Bearer tokens and x-api-key headers, writes test/redact.test.js, runs it, and reports.
//
//   node docs/selfhost/scripted-model.mjs [port]     prints the base URL to use (default: random free port)
import http from 'node:http';

const MODEL = 'scripted-selfhost';

const PLAN = {
  product: { name: 'Redact credentials in headers', summary: 'redact() masks Authorization: Bearer tokens and x-api-key headers in addition to the key formats it already handles.', users: ['maintainers'], successCriteria: ['redact("Authorization: Bearer <token>") hides the token', 'redact("x-api-key: <key>") hides the key', 'existing redactions are unchanged', 'npm test passes'] },
  tasks: [{
    id: 'redact',
    role: 'engineer',
    title: 'Mask Bearer tokens and x-api-key values in redact()',
    description: 'In src/security.js, extend redact() so that "Bearer <token>" (token of 8+ characters from the usual token alphabet) becomes "Bearer ***" and "x-api-key: <value>" becomes "x-api-key: ***" (case-insensitive header name). Keep every existing replacement. Add test/redact.test.js covering both new cases, case-insensitivity, non-matching text and the existing formats.',
    dependsOn: [],
    acceptance: ['Bearer tokens are masked', 'x-api-key values are masked', 'existing redactions still work', 'node --test test/redact.test.js passes'],
    outputs: ['src/security.js', 'test/redact.test.js'],
    files: ['src/security.js', 'test/redact.test.js'],
    verify: ['node --test test/redact.test.js test/sandbox.test.js'],
  }],
  risks: ['over-redacting ordinary prose containing the word Bearer'],
  openQuestions: [],
  finalVerify: ['node --test test/redact.test.js test/sandbox.test.js', 'node scripts/check.mjs'],
  deploy: null,
};

const TEST_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/security.js';

test('Bearer tokens are masked, keeping the scheme so the log line still makes sense', () => {
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop1234567890'), 'Authorization: Bearer ***');
  assert.equal(redact('curl -H "Authorization: Bearer eyJhbGciOi.abc-def_ghi.jkl" https://x'), 'curl -H "Authorization: Bearer ***" https://x');
  assert.equal(redact('authorization: bearer abcdefgh12345678'), 'authorization: bearer ***');
});

test('x-api-key header values are masked, whatever the case of the header name', () => {
  assert.equal(redact('x-api-key: abcdef1234567890zzzz'), 'x-api-key: ***');
  assert.equal(redact('X-API-Key: abcdef1234567890zzzz'), 'X-API-Key: ***');
  assert.equal(redact('{"x-api-key":"abcdef1234567890zzzz"}'), '{"x-api-key":"***"}');
});

test('ordinary text and short words are left alone', () => {
  assert.equal(redact('the bearer of bad news'), 'the bearer of bad news');
  assert.equal(redact('Bearer of gifts'), 'Bearer of gifts');
  assert.equal(redact('x-api-key header is required'), 'x-api-key header is required');
});

test('the existing key formats are still masked', () => {
  assert.equal(redact(\`token ghp_\${'b'.repeat(30)}\`), 'token ghp_***');
  assert.equal(redact(\`sk-ant-\${'a'.repeat(30)}\`), 'sk-ant-***');
  assert.equal(redact(42), 42);
});
`;

const EXTRA = `    .replace(/\\b(Bearer)\\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/(x-api-key["']?\\s*[:=]\\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
`;

const tc = (name, args, i) => ({ id: `call_${Date.now()}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const textOf = (c) => (typeof c === 'string' ? c : (c || []).map((p) => p.text || '').join('\n'));

function next(body) {
  const names = (body.tools || []).map((t) => t.function.name);
  if (names.includes('submit_plan')) return { calls: [tc('submit_plan', PLAN, 0)] };
  if (names.includes('complete_task')) {
    const turn = body.messages.filter((m) => m.role === 'assistant').length;
    const results = body.messages.filter((m) => m.role === 'tool').map((m) => textOf(m.content));
    if (turn === 0) return { text: 'I will read the current redact() first.', calls: [tc('read_file', { path: 'src/security.js' }, 0)] };
    if (turn === 1) {
      const src = results.find((r) => r.includes('export function redact'));
      if (!src) return { text: 'I could not read the file.', calls: [tc('complete_task', { summary: 'Could not read src/security.js', files: [], commands: [], nextSteps: [] }, 0)] };
      const marker = "    .replace(/\\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***');\n";
      if (!src.includes(marker)) return { text: 'The redact() function does not look as expected.', calls: [tc('complete_task', { summary: 'redact() has an unexpected shape; no change made', files: [], commands: [], nextSteps: ['review src/security.js by hand'] }, 0)] };
      const updated = src.replace(marker, `    .replace(/\\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***')\n${EXTRA.replace(/\n$/, ';\n')}`);
      return { text: 'Extending redact() and adding its tests.', calls: [tc('write_file', { path: 'src/security.js', content: updated }, 0), tc('write_file', { path: 'test/redact.test.js', content: TEST_FILE }, 1)] };
    }
    if (turn === 2) return { text: 'Running the new tests and the existing security tests.', calls: [tc('run_command', { command: 'node --test test/redact.test.js test/sandbox.test.js' }, 0)] };
    return { text: 'Done.', calls: [tc('complete_task', { summary: 'redact() now masks "Bearer <token>" and "x-api-key" values; test/redact.test.js covers both, case-insensitivity, non-matching text and the existing formats.', files: ['src/security.js', 'test/redact.test.js'], commands: ['node --test test/redact.test.js test/sandbox.test.js'], nextSteps: [] }, 0)] };
  }
  return { text: 'The change is made and its tests pass.' };
}

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: MODEL, object: 'model' }] });
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    const body = raw ? JSON.parse(raw) : {};
    if (body.model !== MODEL) return send(404, { error: { message: `model "${body.model}" not found` } });
    const { calls = [], text = '' } = next(body);
    const message = { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) };
    return send(200, { id: 'chatcmpl-scripted', choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 50 } });
  }
  return send(404, { error: { message: 'not found' } });
});
server.listen(Number(process.argv[2]) || 0, '127.0.0.1', () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}/v1\n`);
});
