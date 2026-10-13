import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers.js';
import { startMockLLM } from './mock-llm.js';
import { loadConfig } from '../src/config.js';
import { RunStore } from '../src/store.js';
import { Factory } from '../src/factory.js';
import { PreviewManager } from '../src/deploy.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { parseToolCallsFromText, extractJsonValues } from '../src/providers/tooltext.js';
import { toOpenAIMessages, fromOpenAIMessage } from '../src/providers/openai.js';

const previews = new PreviewManager({ max: 2 });
const mocks = [];
after(async () => {
  previews.stopAll();
  await Promise.all(mocks.map((m) => m.close()));
});
const mock = async (opts) => {
  const m = await startMockLLM(opts);
  mocks.push(m);
  return m;
};
const setup = (env = {}) => {
  const cfg = loadConfig({ dataDir: tmpDir(), env, defaultProvider: '', defaultModel: '' });
  const store = new RunStore(cfg.dataDir);
  return { cfg, store, factory: new Factory({ cfg, store, previews }) };
};

test('tool calls written as text are recovered in every common shape', () => {
  const names = ['write_file', 'complete_task'];
  const a = parseToolCallsFromText('Sure!\n```json\n{"tool":"write_file","input":{"path":"a.js","content":"x {}"}}\n```', names);
  assert.deepEqual(a.calls, [{ name: 'write_file', input: { path: 'a.js', content: 'x {}' } }]);
  assert.equal(a.text, 'Sure!');
  const b = parseToolCallsFromText('<think>hmm {"tool":"nope"}</think>{"name":"complete_task","arguments":"{\\"summary\\":\\"done\\",\\"files\\":[]}"}', names);
  assert.equal(b.calls[0].name, 'complete_task');
  assert.equal(b.calls[0].input.summary, 'done');
  const c = parseToolCallsFromText('[{"function":{"name":"write_file","arguments":{"path":"b"}}},{"tool":"complete_task","input":{}}]', names);
  assert.equal(c.calls.length, 2);
  assert.equal(parseToolCallsFromText('{"tool":"rm_rf","input":{}}', names).calls.length, 0);
  assert.equal(extractJsonValues('x {"a": "}"} y').length, 1);
});

test('messages translate to OpenAI and Ollama formats and back', () => {
  const messages = [
    { role: 'user', content: 'build it' },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'wrote a', is_error: false }] },
  ];
  const oa = toOpenAIMessages('sys', messages);
  assert.equal(oa[2].tool_calls[0].function.arguments, '{"path":"a"}');
  assert.deepEqual(oa[3], { role: 'tool', tool_call_id: 't1', content: 'wrote a' });
  const ol = toOpenAIMessages('sys', messages, { dialect: 'ollama' });
  assert.deepEqual(ol[2].tool_calls[0].function.arguments, { path: 'a' });
  assert.equal(ol[3].tool_name, 'write_file');
  const js = toOpenAIMessages('sys', messages, { mode: 'json' });
  assert.match(js[2].content, /"tool":"write_file"/);
  assert.match(js[3].content, /^Result of write_file:/);
  const back = fromOpenAIMessage({ content: null, tool_calls: [{ id: 'x', function: { name: 'write_file', arguments: '{"path":"b"}' } }] }, { toolNames: new Set(['write_file']) });
  assert.deepEqual(back, [{ type: 'tool_use', id: 'x', name: 'write_file', input: { path: 'b' } }]);
});

test('discovery: keys, local servers, model lists, defaults — and secrets never leak', async () => {
  const ollama = await mock({ flavor: 'ollama', models: ['llama3.2:3b', 'qwen2.5-coder:7b'] });
  const openai = await mock({ flavor: 'openai', models: ['gpt-4.1', 'gpt-5'], apiKey: 'sk-test-123456789' });
  const env = { OLLAMA_HOST: ollama.url.replace('http://', ''), OPENAI_API_KEY: 'sk-test-123456789', OPENAI_BASE_URL: openai.url };
  const reg = new ProviderRegistry(loadConfig({ dataDir: tmpDir(), env, defaultProvider: '' }));
  const { providers, defaultProvider } = await reg.discover();
  const by = Object.fromEntries(providers.map((p) => [p.id, p]));

  assert.equal(by.ollama.status, 'ready');
  assert.deepEqual(by.ollama.models.map((m) => m.id), ['llama3.2:3b', 'qwen2.5-coder:7b']); // embeddings removed
  assert.equal(by.ollama.models[0].tools, true);
  assert.equal(by.ollama.defaultModel, 'qwen2.5-coder:7b'); // preferred coding model
  assert.equal(by.ollama.hasKey, false);
  assert.equal(by.openai.status, 'ready');
  assert.deepEqual(by.openai.models.map((m) => m.id).sort(), ['gpt-4.1', 'gpt-5']);
  assert.equal(by.openai.defaultModel, 'gpt-5');
  assert.equal(by.openai.keySource, 'OPENAI_API_KEY');
  assert.equal(by.anthropic.status, 'no_key');
  assert.equal(by.offline.status, 'ready');
  assert.equal(defaultProvider, 'openai');
  assert.ok(!JSON.stringify(providers).includes('sk-test-123456789'));

  // A rejected key is reported as such.
  reg.update('openai', { apiKey: 'wrong-key' });
  assert.equal((await reg.probe(reg.get('openai'))).status, 'auth_error');

  // Custom providers and saved keys persist with private permissions.
  const custom = reg.addCustom({ label: 'Team vLLM', type: 'openai', baseUrl: openai.url, apiKey: 'sk-test-123456789' });
  assert.equal(custom.id, 'team-vllm');
  assert.equal((await reg.probe(reg.get('team-vllm'))).status, 'ready');
  const file = path.join(reg.cfg.dataDir, 'providers.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => reg.addCustom({ label: 'x', baseUrl: 'ftp://nope' }), /http/);
  reg.remove('team-vllm');
  assert.throws(() => reg.get('team-vllm'), /unknown provider/);
});

test('a full factory run through Ollama (native tool calls, num_ctx set, no API key)', async () => {
  const ollama = await mock({ flavor: 'ollama', models: ['qwen2.5-coder:7b'] });
  const { factory } = setup({ OLLAMA_HOST: ollama.url });
  const created = await factory.createRun({ idea: 'A habit tracker', provider: 'ollama', providerOptions: { numCtx: 16384 }, settings: { deploy: false } });
  assert.equal(created.model, 'qwen2.5-coder:7b'); // prepopulated from discovery
  const run = await factory.start(created.id);
  assert.equal(run.status, 'completed', run.error || JSON.stringify(run.checklist));
  assert.equal(run.plan.tasks.find((t) => t.id === 'core').attempts.length, 2); // feedback loop through the real adapter
  const chats = ollama.log.filter((r) => r.url === '/api/chat');
  assert.ok(chats.length > 10);
  assert.equal(chats[0].body.options.num_ctx, 16384);
  assert.ok(chats[0].body.tools.some((t) => t.function.name === 'submit_plan'));
  assert.ok(chats.every((r) => !r.headers.authorization));
  assert.ok(run.usage.input > 0);
});

test('a model without tool support falls back to JSON tool calling and still delivers', async () => {
  const ollama = await mock({ flavor: 'ollama', models: ['tiny-chat:1b'], noTools: true });
  const { factory } = setup({ OLLAMA_HOST: ollama.url });
  const providers = (await factory.providers.discover()).providers;
  assert.equal(providers.find((p) => p.id === 'ollama').models[0].tools, false);
  const run = await factory.start((await factory.createRun({ idea: 'A packing list', provider: 'ollama', model: 'tiny-chat:1b', settings: { deploy: false } })).id);
  assert.equal(run.status, 'completed', run.error || JSON.stringify(run.checklist));
  const chats = ollama.log.filter((r) => r.url === '/api/chat');
  assert.ok(chats[0].body.tools); // tried native first
  assert.ok(chats.slice(1).every((r) => !r.body.tools)); // then remembered JSON mode
  assert.match(chats.at(-2).body.messages[0].content, /How to use tools/);
});

test('a full run through an OpenAI-compatible API with a key, planner and agent models chosen separately', async () => {
  const api = await mock({ flavor: 'openai', models: ['big-planner', 'fast-coder'], apiKey: 'sk-test-abcdefghijkl' });
  const { factory } = setup({ OPENAI_API_KEY: 'sk-test-abcdefghijkl', OPENAI_BASE_URL: api.url });
  const created = await factory.createRun({ idea: 'A reading list', provider: 'openai', model: 'fast-coder', plannerModel: 'big-planner', settings: { deploy: false } });
  const run = await factory.start(created.id);
  assert.equal(run.status, 'completed', run.error);
  const chats = api.log.filter((r) => r.url === '/v1/chat/completions');
  assert.equal(chats[0].body.model, 'big-planner');
  assert.deepEqual(chats[0].body.tool_choice, { type: 'function', function: { name: 'submit_plan' } });
  assert.ok(chats.slice(1).some((r) => r.body.model === 'fast-coder'));
  assert.ok(chats.every((r) => r.headers.authorization === 'Bearer sk-test-abcdefghijkl'));
  assert.equal(run.plannerModel, 'big-planner');
});

test('the planner can use a different provider than the agents (frontier plan, local execution)', async () => {
  const frontier = await mock({ flavor: 'openai', models: ['big-planner'], apiKey: 'sk-test-abcdefghijkl' });
  const local = await mock({ flavor: 'ollama', models: ['fast-coder:7b'] });
  const { factory } = setup({ OPENAI_API_KEY: 'sk-test-abcdefghijkl', OPENAI_BASE_URL: frontier.url, OLLAMA_HOST: local.url });
  const created = await factory.createRun({
    idea: 'A reading list',
    provider: 'ollama',
    model: 'fast-coder:7b',
    planner: { provider: 'openai', model: 'big-planner' },
    settings: { deploy: false },
  });
  assert.equal(created.plannerProvider, 'openai');
  assert.equal(created.provider, 'ollama');
  const run = await factory.start(created.id);
  assert.equal(run.status, 'completed', run.error);
  const planCalls = frontier.log.filter((r) => r.url === '/v1/chat/completions');
  assert.equal(planCalls.length, 1); // the frontier model was only asked to plan
  assert.equal(planCalls[0].body.model, 'big-planner');
  assert.deepEqual(planCalls[0].body.tool_choice, { type: 'function', function: { name: 'submit_plan' } });
  const localChats = local.log.filter((r) => r.url === '/api/chat');
  assert.ok(localChats.length > 1);
  assert.ok(localChats.every((r) => r.body.model === 'fast-coder:7b'));
  assert.ok(localChats.every((r) => !JSON.stringify(r.body.tools || []).includes('submit_plan')));
  assert.match((await factory.store.events(run.id)).find((e) => e.type === 'log').text, /Planning with .*big-planner/);
});

test('a planner on another provider must be usable, and offline cannot be mixed with real LLMs', async () => {
  const local = await mock({ flavor: 'ollama', models: ['fast-coder:7b'] });
  const { factory } = setup({ OLLAMA_HOST: local.url });
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'ollama', planner: { provider: 'anthropic' } }), /API key|not ready/);
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'ollama', planner: { provider: 'offline' } }), /offline/);
});

test('createRun rejects providers that are not usable, and the connection test reports tool support', async () => {
  const ollama = await mock({ flavor: 'ollama', models: ['tiny-chat:1b'], noTools: true });
  const { factory } = setup({ OLLAMA_HOST: ollama.url });
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'anthropic' }), /needs an API key|not ready/);
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'lmstudio' }), /not ready/);
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'nope' }), /unknown provider/);
  const t = await factory.providers.test('ollama', 'tiny-chat:1b');
  assert.equal(t.ok, true);
  assert.equal(t.toolCalling, 'json');
  const bad = await factory.providers.test('ollama', 'missing-model');
  assert.equal(bad.ok, false);
  assert.match(bad.message, /not found/);
});

// ── Hosted execution readiness ──────────────────────────────────────────────────────────────
// A mocked hosted endpoint proves the wiring (selection, tool calls, verification, delivery) with Ollama absent. It says
// nothing about a real provider's speed, tool quality or limits; see "Real hosted-provider smoke test" in the README.
import net from 'node:net';

const deadPort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const KEY = 'sk-hosted-test-0123456789abcdef';
const allText = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.size !== 0) out.push([f, fs.readFileSync(f, 'latin1')]);
    }
  };
  walk(dir);
  return out;
};

test('a complete run uses a hosted OpenAI-compatible endpoint with Ollama unavailable, and the gates still decide', async () => {
  const hosted = await mock({ flavor: 'openai', models: ['hosted-coder'], apiKey: KEY });
  const ollamaGone = `http://127.0.0.1:${await deadPort()}`;
  const cfg = loadConfig({ dataDir: tmpDir(), env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: hosted.url, OLLAMA_HOST: ollamaGone }, defaultProvider: 'openai', defaultModel: 'hosted-coder' });
  const store = new RunStore(cfg.dataDir);
  const factory = new Factory({ cfg, store, previews });

  const found = await factory.providers.discover();
  assert.equal(found.providers.find((p) => p.id === 'ollama').status, 'unreachable');
  assert.equal(found.defaultProvider, 'openai');
  assert.deepEqual([found.defaultModel, found.defaultSource], ['hosted-coder', 'configured']);

  const created = await factory.createRun({ idea: 'A reading list', settings: { deploy: false } }); // no provider named: the configuration decides
  assert.deepEqual([created.provider, created.model, created.engine], ['openai', 'hosted-coder', 'builtin']);
  const run = await factory.start(created.id);
  assert.equal(run.status, 'completed', run.error || JSON.stringify(run.checklist));

  const chats = hosted.log.filter((r) => r.url === '/v1/chat/completions');
  assert.ok(chats.length > 10, 'planning and every agent turn went to the hosted endpoint');
  assert.ok(chats.every((r) => r.body.model === 'hosted-coder' && r.headers.authorization === `Bearer ${KEY}`));
  assert.deepEqual(chats[0].body.tool_choice, { type: 'function', function: { name: 'submit_plan' } });
  assert.ok(chats.some((r) => r.body.tools?.some((t) => t.function.name === 'write_file')), 'agents were offered the sandboxed tools');
  const events = await store.events(run.id);
  assert.ok(events.some((e) => e.type === 'tool' && e.tool === 'write_file' && e.ok), 'tool calls were executed in the workspace');
  assert.ok(events.some((e) => e.type === 'verify' && e.taskId !== '_final'), 'task verification ran');
  assert.ok(events.some((e) => e.type === 'verify' && e.taskId === '_final'), 'final verification ran');
  assert.ok(run.checklist.length > 0 && run.checklist.every((c) => c.ok), JSON.stringify(run.checklist));
  assert.ok(run.delivery, 'delivery was produced');
  assert.ok(!hosted.log.some((r) => r.url.startsWith('/api/')), 'nothing spoke the Ollama protocol');

  // The credential stays out of everything persisted and everything served.
  for (const [file, text] of allText(cfg.dataDir)) assert.ok(!text.includes(KEY), `${file} must not contain the key`);
  assert.ok(!JSON.stringify(found).includes(KEY));
});

test('a verification failure is not hidden by the provider: a hosted run whose checks fail does not complete', async () => {
  const hosted = await mock({ flavor: 'openai', models: ['hosted-coder'] });
  const { factory } = setup({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: hosted.url });
  hosted.log.length = 0;
  // The mock's brain injects one bug that only a second attempt fixes (see the full-run tests above).
  const created = await factory.createRun({ idea: 'A reading list', provider: 'openai', model: 'hosted-coder', settings: { deploy: false, maxAttempts: 1 } });
  const run = await factory.start(created.id);
  // With a single attempt the bug is not fixed, so the verdict must say so rather than trust the model's claim of completion.
  assert.notEqual(run.status, 'completed');
  assert.ok(run.plan.tasks.some((t) => t.status === 'escalated'), 'the failed task is escalated, not reported as done');
});

test('provider and model selection: explicit choice, configured default, saved last choice, and visible defaults', async () => {
  const api = await mock({ flavor: 'openai', models: ['alpha-coder', 'gpt-5'], apiKey: KEY });
  const env = { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: api.url, OLLAMA_HOST: `http://127.0.0.1:${await deadPort()}` };
  const cfg = loadConfig({ dataDir: tmpDir(), env, defaultProvider: '', defaultModel: '' });
  const factory = new Factory({ cfg, store: new RunStore(cfg.dataDir), previews });

  // Nothing chosen yet: the first ready provider and its preferred model, and the page/CLI can say why.
  let d = await factory.providers.discover();
  assert.deepEqual([d.defaultProvider, d.defaultModel, d.defaultSource], ['openai', 'gpt-5', 'first ready provider']);
  assert.equal((await factory.createRun({ idea: 'x', settings: { deploy: false } })).model, 'gpt-5');

  // An explicit choice wins, and is remembered together with its model.
  const explicit = await factory.createRun({ idea: 'x', provider: 'openai', model: 'alpha-coder', settings: { deploy: false } });
  assert.equal(explicit.model, 'alpha-coder');
  d = await factory.providers.discover();
  assert.deepEqual([d.defaultProvider, d.defaultModel, d.defaultSource], ['openai', 'alpha-coder', 'last run']);
  const next = await factory.createRun({ idea: 'x', settings: { deploy: false } });
  assert.deepEqual([next.provider, next.model], ['openai', 'alpha-coder'], 'the remembered model is used, not just the remembered provider');

  // A model that is no longer offered is not forced on the user.
  factory.providers.remember('openai', 'retired-model');
  assert.equal((await factory.createRun({ idea: 'x', settings: { deploy: false } })).model, 'gpt-5');

  // A configured model (FACTORY_MODEL / settings) outranks the remembered one; precedence is otherwise unchanged.
  const pinned = loadConfig({ dataDir: cfg.dataDir, env, defaultProvider: 'openai', defaultModel: 'gpt-5' });
  const f2 = new Factory({ cfg: pinned, store: new RunStore(pinned.dataDir), previews });
  f2.providers.remember('openai', 'alpha-coder');
  assert.equal((await f2.createRun({ idea: 'x', settings: { deploy: false } })).model, 'gpt-5');
  assert.equal((await f2.providers.discover()).defaultSource, 'configured');
});

test('provider failures say what kind of failure it was, and never include the key', async () => {
  const api = await mock({ flavor: 'openai', models: ['m'], apiKey: KEY });
  const wrong = 'sk-wrong-key-0123456789abcdef';
  const bad = setup({ OPENAI_API_KEY: wrong, OPENAI_BASE_URL: api.url });
  await assert.rejects(bad.factory.createRun({ idea: 'x', provider: 'openai' }), (e) => /not ready: Key rejected: authentication failed/.test(e.message) && !e.message.includes(wrong));

  const refused = setup({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: `http://127.0.0.1:${await deadPort()}` });
  await assert.rejects(refused.factory.createRun({ idea: 'x', provider: 'openai' }), /Cannot reach .*connection failed: connection refused/);
  await assert.rejects(refused.factory.createRun({ idea: 'x', provider: 'anthropic' }), /not ready: Add an API key or set ANTHROPIC_API_KEY/);

  const { describeError, HttpError } = await import('../src/providers/http.js');
  assert.match(describeError(new HttpError(429, '{"error":{"message":"slow down"}}')), /^rate limited: HTTP 429: slow down/);
  assert.match(describeError(new HttpError(503, 'overloaded')), /^provider-side error: HTTP 503/);
  assert.match(describeError(new HttpError(404, '{"error":"no such model"}')), /^model or endpoint not found: HTTP 404/);
  assert.match(describeError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), /^inference timed out/);
});
