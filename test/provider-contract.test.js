// Provider and engine contract tests: the production adapters, registry and engine boundary against loopback stubs and test
// doubles. Offline by construction (blockNetwork), no credentials, no Ollama.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { blockNetwork, blocked } from './offline-guard.js';
import { serve, completion } from './http-stub.js';
import { startMockLLM } from './mock-llm.js';
import { tmpDir } from './helpers.js';
import { setup, Scripted, task, plan, done } from './project-helpers.js';
import { loadConfig } from '../src/config.js';
import { RunStore } from '../src/store.js';
import { Factory } from '../src/factory.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { OpenAICompatProvider, toOpenAIMessages, fromOpenAIMessage } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { describeInference } from '../src/contract.js';
import { AGENT_TOOLS, execTool } from '../src/agents.js';
import { Workspace } from '../src/sandbox.js';
import fs from 'node:fs';

const restoreNet = blockNetwork();
const closers = [];
after(async () => {
  await Promise.all(closers.map((c) => c()));
  restoreNet();
  assert.deepEqual(blocked, []);
});
const stub = async (route) => { const s = await serve(route); closers.push(s.close); return s; };
const mock = async (o) => { const m = await startMockLLM(o); closers.push(() => m.close()); return m; };
const KEY = 'contract-test-key-0123456789abcdef';
const chatOf = (p, extra = {}) => p.chat({ system: 'be brief', messages: [{ role: 'user', content: 'hi' }], ...extra });
const TOOL = AGENT_TOOLS.find((t) => t.name === 'write_file');
const quiet = () => new Promise((r) => setTimeout(r, 0));

// ── request behaviour ────────────────────────────────────────────────────────────────────────

test('an explicit provider and model reach exactly that adapter, and no other provider is contacted', async () => {
  const a = await mock({ flavor: 'openai', models: ['model-a'], apiKey: KEY });
  const b = await mock({ flavor: 'openai', models: ['model-b'] });
  const cfg = loadConfig({ dataDir: tmpDir(), env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: a.url, LMSTUDIO_BASE_URL: b.url }, defaultProvider: 'openai', defaultModel: 'model-a' });
  const factory = new Factory({ cfg, store: new RunStore(cfg.dataDir), previews: { get: () => null, stop() {}, stopAll() {}, start: async () => ({ ok: false }) } });
  const created = await factory.createRun({ idea: 'A tiny list', provider: 'lmstudio', model: 'model-b', settings: { deploy: false } });
  assert.deepEqual([created.provider, created.model], ['lmstudio', 'model-b'], 'the explicit choice beats the configured default');
  const run = await factory.start(created.id);
  assert.equal(run.status, 'completed', run.error);
  const chats = (m) => m.log.filter((r) => r.url.endsWith('/chat/completions'));
  assert.ok(chats(b).length > 5 && chats(b).every((r) => r.body.model === 'model-b'));
  assert.equal(chats(a).length, 0, 'the configured default provider was not used');
  assert.ok(chats(b).every((r) => !r.headers.authorization), 'the other provider\'s key was not sent');
});

test('history and tool definitions reach each adapter in its own wire format, with forced tools and JSON mode handled', async () => {
  const history = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: [{ type: 'text', text: 'writing' }, { type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'a.txt', content: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'wrote a.txt', is_error: false }] },
  ];
  const openai = await stub(() => completion({ content: 'ok' }));
  await chatOf(new OpenAICompatProvider({ id: 'o', baseUrl: openai.url, apiKey: KEY, model: 'm' }), { messages: history, tools: [TOOL], meta: { forceTool: 'write_file' } });
  const o = openai.log[0].body;
  assert.deepEqual(o.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(o.messages[2].tool_calls[0].id, 'call_1');
  assert.deepEqual(JSON.parse(o.messages[2].tool_calls[0].function.arguments), { path: 'a.txt', content: 'x' });
  assert.deepEqual([o.messages[3].tool_call_id, o.messages[3].content], ['call_1', 'wrote a.txt']);
  assert.deepEqual(o.tools[0], { type: 'function', function: { name: 'write_file', description: TOOL.description, parameters: TOOL.input_schema } });
  assert.deepEqual(o.tool_choice, { type: 'function', function: { name: 'write_file' } });
  assert.equal(openai.log[0].headers.authorization, `Bearer ${KEY}`);

  // Not forced when nothing asks for it.
  await chatOf(new OpenAICompatProvider({ id: 'o', baseUrl: openai.url, model: 'm' }), { tools: [TOOL] });
  assert.equal(openai.log[1].body.tool_choice, undefined);
  assert.equal(openai.log[1].headers.authorization, undefined, 'no key configured, none sent');

  // JSON tool mode: no native tools field; the tools are described in the system prompt and results come back as plain turns.
  await chatOf(new OpenAICompatProvider({ id: 'o', baseUrl: openai.url, model: 'm', toolMode: 'json' }), { messages: history, tools: [TOOL] });
  const j = openai.log[2].body;
  assert.equal(j.tools, undefined);
  assert.match(j.messages[0].content, /write_file/);
  assert.ok(j.messages.every((m) => m.role !== 'tool'));

  const ollama = await stub(() => [200, { message: { role: 'assistant', content: 'ok' }, done: true }]);
  await chatOf(new OpenAICompatProvider({ id: 'l', baseUrl: ollama.url, model: 'm', dialect: 'ollama', numCtx: 4096, maxTokens: 777, temperature: 0.1 }), { messages: history, tools: [TOOL] });
  const l = ollama.log[0].body;
  assert.equal(ollama.log[0].url, '/api/chat');
  assert.deepEqual([l.stream, l.options.num_ctx, l.options.num_predict, l.options.temperature], [false, 4096, 777, 0.1]);
  assert.equal(l.messages.at(-1).role, 'tool');
  assert.equal(l.messages.at(-1).tool_name, 'write_file');
  assert.deepEqual(l.messages[2].tool_calls[0].function.arguments, { path: 'a.txt', content: 'x' }, 'Ollama takes arguments as an object');

  const claude = await stub(() => [200, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } }]);
  await chatOf(new AnthropicProvider({ apiKey: KEY, baseUrl: claude.url, model: 'm', maxTokens: 555, temperature: 0 }), { messages: history, tools: [TOOL], meta: { forceTool: 'write_file' } });
  const c = claude.log[0];
  assert.equal(c.headers['x-api-key'], KEY);
  assert.deepEqual([c.body.max_tokens, c.body.temperature, c.body.tools[0].name, c.body.tool_choice], [555, 0, 'write_file', { type: 'tool', name: 'write_file' }]);
  assert.equal(c.body.system[0].cache_control.type, 'ephemeral', 'a provider-specific capability is preserved');
  assert.deepEqual(c.body.messages, history);
});

test('options an adapter cannot take are not sent, and the contract says so', async () => {
  const openai = await stub(() => completion({ content: 'ok' }));
  const reg = new ProviderRegistry(loadConfig({ dataDir: tmpDir(), env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: openai.url }, defaultProvider: '', defaultModel: '' }));
  await chatOf(reg.create('openai', { model: 'm', options: { numCtx: 8192, temperature: 0.3 } }));
  const sent = openai.log[0].body;
  assert.equal(JSON.stringify(sent).includes('num_ctx'), false, 'a context window option is Ollama-only; it is not smuggled into another API');
  assert.equal(sent.options, undefined);
  assert.equal(sent.temperature, 0.3, 'a supported option does arrive');
  const d = await describeInference(reg.cfg, reg, { provider: 'openai', providerOptions: { numCtx: 8192 } });
  assert.equal(d.settings.find((s) => s.key === 'numCtx').builtin.status, 'not-applicable');
  assert.equal(d.settings.find((s) => s.key === 'temperature').builtin.status, 'supported');
});

// ── responses ────────────────────────────────────────────────────────────────────────────────

test('responses are normalised: text, one or several tool calls, empty and malformed replies, truncation, missing usage', async () => {
  const replies = [
    completion({ content: 'plain text' }, { usage: { prompt_tokens: 7, completion_tokens: 2 } }),
    completion({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a","content":"1"}' } }, { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }),
    completion({ content: null }),
    [200, { choices: [] }],
    completion({ content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'write_file', arguments: '{"path": "a", ' } }] }),
    completion({ content: 'cut off mid' }, { finish: 'length' }),
    completion({ content: 'no usage block' }),
  ];
  let i = 0;
  const api = await stub(() => replies[i++]);
  const p = new OpenAICompatProvider({ id: 'o', baseUrl: api.url, model: 'm' });
  const ask = () => chatOf(p, { tools: AGENT_TOOLS });
  const text = await ask();
  assert.deepEqual([text.content, text.stop_reason, text.usage], [[{ type: 'text', text: 'plain text' }], 'end_turn', { input_tokens: 7, output_tokens: 2, reported: true }]);
  const two = await ask();
  assert.deepEqual(two.content.map((b) => [b.type, b.name, b.id]), [['tool_use', 'write_file', 'c1'], ['tool_use', 'read_file', 'c2']], 'order and ids are preserved');
  assert.equal(two.stop_reason, 'tool_use');
  assert.deepEqual((await ask()).content, [], 'an empty reply is an empty content list, not an exception');
  assert.deepEqual((await ask()).content, [], 'a reply with no choices is the same');
  const broken = await ask();
  assert.deepEqual(broken.content[0].input, { _raw: '{"path": "a", ' }, 'unparseable arguments are kept raw, never guessed at');
  const dir = tmpDir();
  const out = await execTool(new Workspace(dir), broken.content[0], { settings: {} });
  assert.equal(out.isError, true, 'the tool layer rejects them');
  assert.match(out.text, /path is required/);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== '.home'), [], 'and nothing was written');
  const cut = await ask();
  assert.equal(cut.stop_reason, 'max_tokens');
  const nousage = await ask();
  assert.equal(nousage.usage.reported, false, 'missing usage is flagged, not turned into a believable zero');
});

test('provider failures keep their kind: authentication, missing model, rate limit, server error, bad body — retries are bounded', async () => {
  let hits = 0;
  const scripted = [[401, { error: { message: 'invalid api key' } }], [404, { error: { message: 'model "x" not found' } }]];
  const api = await stub((req) => {
    hits++;
    if (req.headers['x-case'] === 'body') return [200, 'this is not json'];
    if (req.headers['x-case'] === 'busy') return [429, { error: { message: 'slow down' } }, { 'retry-after': '0' }];
    if (req.headers['x-case'] === 'down') return [502, 'bad gateway', { 'retry-after': '0' }];
    return scripted.shift();
  });
  const mk = (kase) => new OpenAICompatProvider({ id: 'o', label: 'Stub', baseUrl: api.url, model: 'm', headers: { 'x-case': kase } });
  await assert.rejects(chatOf(mk('auth')), /^Error: Stub \(m\): authentication failed \(check the API key\): HTTP 401: invalid api key$/);
  assert.equal(hits, 1, 'a 401 is not retried');
  await assert.rejects(chatOf(mk('missing')), /model or endpoint not found: HTTP 404/);
  assert.equal(hits, 2, 'a 404 is not retried');
  hits = 0;
  await assert.rejects(chatOf(mk('busy')), /rate limited: HTTP 429: slow down/);
  assert.equal(hits, 5, 'one try and four retries');
  hits = 0;
  await assert.rejects(chatOf(mk('down')), /provider-side error: HTTP 502/);
  assert.equal(hits, 5);
  hits = 0;
  await assert.rejects(chatOf(mk('body')), /invalid JSON/);
  assert.equal(hits, 1, 'a malformed body is not retried');
});

test('connection failures and timeouts surface as such after a bounded number of tries (Ollama dialect: two retries)', async () => {
  const hang = await stub(() => 'hang');
  const dead = await stub(() => [200, {}]);
  const deadUrl = dead.url;
  await dead.close();
  const t0 = Date.now();
  await assert.rejects(chatOf(new OpenAICompatProvider({ id: 'l', baseUrl: deadUrl, model: 'm', dialect: 'ollama' })), /connection failed: connection refused/);
  await assert.rejects(chatOf(new OpenAICompatProvider({ id: 'l', baseUrl: hang.url, model: 'm', dialect: 'ollama', timeoutMs: 60 })), /inference timed out/);
  assert.equal(hang.log.length, 3, 'one try and two retries, not an endless loop');
  assert.ok(Date.now() - t0 < 20_000);
});

test('cancelling an in-flight request rejects promptly as "cancelled" and does not retry', async () => {
  const hang = await stub(() => 'hang');
  const c = new AbortController();
  const p = chatOf(new OpenAICompatProvider({ id: 'o', baseUrl: hang.url, model: 'm' }), { signal: c.signal });
  while (hang.log.length === 0) await quiet();
  const t0 = Date.now();
  c.abort();
  await assert.rejects(p, /cancelled/);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(hang.log.length, 1);
});

test('a text-written tool call is recovered by the built-in adapter (the contract difference with the fx engine)', () => {
  const blocks = fromOpenAIMessage({ content: 'I will write it.\n{"tool":"write_file","input":{"path":"a","content":"1"}}' }, { toolNames: new Set(['write_file']) });
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'tool_use']);
  assert.deepEqual(toOpenAIMessages('s', [{ role: 'user', content: 'x' }]).map((m) => m.role), ['system', 'user']);
});

// ── lifecycle: failed inference never becomes completion, and nothing falls back silently ────

test('a provider that keeps failing fails the run; a second configured provider is never used as a silent fallback', async () => {
  let primary = 0;
  const bad = await stub((req) => (req.url.endsWith('/chat/completions') ? (primary++, [503, { error: { message: 'overloaded' } }, { 'retry-after': '0' }]) : [200, { data: [{ id: 'm' }] }]));
  const good = await mock({ flavor: 'openai', models: ['m'] });
  const cfg = loadConfig({ dataDir: tmpDir(), env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: bad.url, LMSTUDIO_BASE_URL: good.url }, defaultProvider: 'openai', defaultModel: 'm' });
  const store = new RunStore(cfg.dataDir);
  const factory = new Factory({ cfg, store, previews: { get: () => null, stop() {}, stopAll() {}, start: async () => ({ ok: false }) } });
  const run = await factory.start((await factory.createRun({ idea: 'x', settings: { deploy: false } })).id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /provider-side error/);
  assert.equal(primary, 5, 'one planner call, retried a fixed number of times, then given up');
  assert.equal(good.log.filter((r) => r.url.endsWith('/chat/completions')).length, 0, 'the healthy provider was never asked');
  assert.equal(run.plan, null);
  assert.deepEqual(run.checklist, []);
  assert.equal(run.delivery, undefined);
  assert.ok(!JSON.stringify(run).includes(KEY));
});

// ── the fx engine boundary ───────────────────────────────────────────────────────────────────

function fakeFx() {
  const log = { models: [], agents: [] };
  return {
    log,
    createFxModel: async (o) => (log.models.push(o), { o }),
    createFxAgent: async (o) => (log.agents.push(o), {
      close: async () => {},
      prompt: () => {
        let finish;
        const result = new Promise((r) => (finish = r));
        return { result, cancel() {}, async *[Symbol.asyncIterator]() { yield { type: 'tool_start', id: 'x', name: 'complete_task' }; await o.tools.find((t) => t.name === 'complete_task').execute({ summary: 'x', files: [] }, {}); finish({ stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }); } };
      },
    }),
  };
}
class Endpoint extends Scripted {
  constructor(opts) {
    super(opts);
    Object.assign(this, { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3-coder', dialect: 'ollama', apiKey: KEY });
  }
  describe() { return { name: 'ep', label: 'ep', model: this.model, dialect: this.dialect }; }
}

test('the fx engine receives every setting the contract says it honours and nothing the contract says it cannot take', async () => {
  const fx = fakeFx();
  const { factory } = setup({ provider: new Endpoint({ plan: () => plan([task('t')], { finalVerify: [] }), task: () => [done('x')] }), cfg: { maxOutputTokens: 4321, engineModules: { fx } } });
  const created = await factory.createRun({ idea: 'x', provider: 'fxfake', model: 'qwen3-coder', engine: 'fx', providerOptions: { numCtx: 16384, temperature: 0.2, toolMode: 'json' }, settings: { deploy: false, maxAgentTurns: 17 } });
  await factory.start(created.id);
  const agent = fx.log.agents[0];
  const model = fx.log.models[0];
  // Honoured, as the contract claims.
  assert.equal(agent.maxOutputTokens, 4321);
  assert.equal(agent.maxSteps, 17);
  const d = await describeInference(factory.cfg, factory.providers, { provider: 'ollama', engine: 'fx' });
  for (const key of ['maxOutputTokens', 'maxAgentTurns']) assert.equal(d.settings.find((s) => s.key === key).fx.status, 'supported', key);
  // Not honoured, as the contract also says: none of it is passed on, and it was said so in the run log.
  for (const key of ['numCtx', 'temperature', 'toolMode', 'firstResponseTimeout', 'transportRetries']) assert.notEqual(d.settings.find((s) => s.key === key).fx.status, 'supported', key);
  assert.deepEqual(Object.keys(agent).sort(), ['instructions', 'maxOutputTokens', 'maxSteps', 'model', 'onEvent', 'tools'], 'an allow-list: a new option must be added to the contract before it can be passed');
  assert.deepEqual(Object.keys(model).sort(), ['apiKeyEnv', 'baseUrl', 'model'], 'the credential travels only as an env var name');
  assert.ok(!JSON.stringify(model).includes(KEY));
  const warnings = (await factory.store.events(created.id)).filter((e) => e.type === 'log' && e.level === 'warn').map((e) => e.text).join('\n');
  assert.match(warnings, /numCtx 16384 is not applied/);
  assert.match(warnings, /temperature is not applied/);
  assert.match(warnings, /toolMode "json" is not applied/);
});
