// Local models through the real adapters: the shapes local models actually produce (tool calls written as qwen3-coder XML,
// JSON with raw newlines, invented tool and argument names, plans written as text with loose fields), history kept inside
// Ollama's context window, and the fx engine served through da-prompt's own provider by the loopback bridge.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { blockNetwork } from './offline-guard.js';
import { serve, completion } from './http-stub.js';
import { tmpDir } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { RunStore } from '../src/store.js';
import { Factory } from '../src/factory.js';
import { parseToolCallsFromText, parseLenient, resolveToolName } from '../src/providers/tooltext.js';
import { fromOpenAIMessage, OpenAICompatProvider } from '../src/providers/openai.js';
import { startBridge, fromOpenAIRequest } from '../src/providers/bridge.js';
import { normalizePlan, planFromText, normalizeToolInput } from '../src/agents.js';
import { compactHistory, historyBudget } from '../src/providers/history.js';
import { validatePlan } from '../src/graph.js';

blockNetwork();
const servers = [];
after(() => Promise.all(servers.map((s) => s.close())));

const NAMES = ['list_files', 'read_file', 'write_file', 'run_command', 'complete_task'];

test('tool calls in the formats local models write are recovered', () => {
  // qwen3-coder writes its calls as XML when Ollama's parser misses them.
  const xml = parseToolCallsFromText('I will create it.\n<tool_call>\n<function=write_file>\n<parameter=path>\nsrc/a.js\n</parameter>\n<parameter=content>\nif (x) {\n  y();\n}\n</parameter>\n</function>\n</tool_call>', NAMES);
  assert.deepEqual(xml.calls, [{ name: 'write_file', input: { path: 'src/a.js', content: 'if (x) {\n  y();\n}' } }]);
  assert.equal(xml.text, 'I will create it.');
  const lists = parseToolCallsFromText('<function=complete_task><parameter=summary>ok</parameter><parameter=files>["a.js"]</parameter></function>', NAMES);
  assert.deepEqual(lists.calls[0].input, { summary: 'ok', files: ['a.js'] });
  const invoke = parseToolCallsFromText('<invoke name="run_command"><parameter name="command">npm test</parameter></invoke>', NAMES);
  assert.deepEqual(invoke.calls, [{ name: 'run_command', input: { command: 'npm test' } }]);
  // JSON with a raw newline in a string and a trailing comma, under a namespaced tool name.
  const loose = parseToolCallsFromText('{"name": "functions.write_file", "arguments": {"path": "a.txt", "content": "one\ntwo, [3,]",},}', NAMES);
  assert.deepEqual(loose.calls, [{ name: 'write_file', input: { path: 'a.txt', content: 'one\ntwo, [3,]' } }]);
  // Names from other agents' tool sets map to the factory's; unknown ones are still refused.
  assert.equal(resolveToolName('Bash', NAMES), 'run_command');
  assert.equal(resolveToolName('create_file', NAMES), 'write_file');
  assert.equal(resolveToolName('attempt_completion', NAMES), 'complete_task');
  assert.equal(resolveToolName('rm_rf', NAMES), null);
  assert.equal(parseToolCallsFromText('{"tool":"rm_rf","input":{}}', NAMES).calls.length, 0);
  // Native calls with a namespaced name are mapped too.
  const native = fromOpenAIMessage({ content: '', tool_calls: [{ function: { name: 'functions.read_file', arguments: '{"path":"x"}' } }] }, { toolNames: new Set(NAMES) });
  assert.equal(native[0].name, 'read_file');
  assert.equal(parseLenient('not json'), undefined);
});

test('tool arguments under the names models use are mapped to the factory\'s', () => {
  assert.deepEqual(normalizeToolInput('write_file', { file_path: ' a.js ', contents: 'x' }), { file_path: ' a.js ', contents: 'x', path: 'a.js', content: 'x' });
  assert.equal(normalizeToolInput('write_file', { path: 'package.json', content: { name: 'x' } }).content, '{\n  "name": "x"\n}\n');
  assert.equal(normalizeToolInput('write_file', { path: 'empty.txt', content: '' }).content, '');
  assert.equal(normalizeToolInput('run_command', { cmd: ['npm ci', 'npm test'] }).command, 'npm ci && npm test');
  assert.equal(normalizeToolInput('run_command', { _raw: 'ls -la' }).command, 'ls -la');
  assert.equal(normalizeToolInput('run_command', { command: 'sleep 1', timeout: '30' }).timeout_seconds, 30);
  assert.equal(normalizeToolInput('read_file', { filename: 'b.js' }).path, 'b.js');
  assert.deepEqual(normalizeToolInput('complete_task', 'oops'), {});
});

test('loosely shaped plans are repaired, and a plan written as text is found', () => {
  const loose = {
    tasks: [
      { id: 'Task 1', role: 'Backend', title: 'API', description: 'build the api', verify: 'npm test' },
      { id: 'Task 2', role: 'frontend', title: 'UI', description: 'build the ui', dependsOn: 'Task 1', acceptance: 'page loads' },
      { id: 'Task 3', role: 'wizard', title: 'Docs', description: 'write docs', dependsOn: ['API', 'Task 3', 'nonexistent'] },
    ],
    finalVerify: 'npm test',
    deploy: 'node server.js',
  };
  const p = normalizePlan(loose, { idea: 'A todo app' });
  assert.deepEqual(validatePlan(p), []);
  assert.deepEqual(p.tasks.map((t) => [t.id, t.role, t.dependsOn]), [['task-1', 'engineer', []], ['task-2', 'design', ['task-1']], ['task-3', 'engineer', ['task-1']]]);
  assert.deepEqual(p.tasks[0].acceptance, ['`npm test` exits 0']);
  assert.equal(p.product.summary, 'A todo app');
  assert.ok(p.product.successCriteria.length > 0);
  assert.deepEqual(p.finalVerify, ['npm test']);
  assert.deepEqual(p.deploy, { start: 'node server.js', healthPath: '/' });
  // Real problems still fail validation: a cycle is not "repaired".
  const cyc = normalizePlan({ product: { summary: 's', successCriteria: ['x'] }, tasks: [{ id: 'a', role: 'qa', title: 'a', description: 'a', dependsOn: ['b'], acceptance: ['x'] }, { id: 'b', role: 'qa', title: 'b', description: 'b', dependsOn: ['a'], acceptance: ['x'] }] });
  assert.match(validatePlan(cyc).join(), /cycle/);
  // Plans written in the reply, bare or wrapped.
  assert.equal(planFromText([{ type: 'text', text: 'Plan:\n```json\n{"plan": {"tasks": [{"id": "a"}]}}\n```' }]).tasks[0].id, 'a');
  assert.equal(planFromText([{ type: 'text', text: 'no plan here {"x": 1}' }]), null);
});

test('history is shortened to fit a small context window, keeping the brief and the latest rounds whole', () => {
  const brief = { role: 'user', content: '# Task t: the brief' };
  const messages = [brief];
  for (let i = 0; i < 12; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `u${i}`, name: 'write_file', input: { path: `f${i}.js`, content: 'x'.repeat(4000) } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `u${i}`, content: 'y'.repeat(4000) }] });
  }
  assert.equal(compactHistory(messages, Infinity), messages, 'no window known: nothing changes');
  const size = (ms) => JSON.stringify(ms).length;
  const mid = compactHistory(messages, 40_000);
  assert.equal(mid.length, messages.length, 'shortening old rounds was enough');
  assert.match(mid[1].content[0].input.content, /4000 characters written/);
  assert.equal(mid.at(-2).content[0].input.content.length, 4000, 'the latest rounds are whole');
  const tight = compactHistory(messages, 12_000);
  assert.ok(tight.length < messages.length && size(tight) < size(messages));
  assert.match(tight[0].content, /^# Task t: the brief[\s\S]*left out to fit the model's context window/);
  for (let i = 1; i < tight.length; i += 2) assert.equal(tight[i].role, 'assistant');
  for (let i = 1; i < tight.length; i += 2) assert.equal(tight[i].content[0].id, tight[i + 1].content[0].tool_use_id, 'every tool result keeps its call');
  assert.equal(messages[1].content[0].input.content.length, 4000, 'the stored history is not changed');
  assert.equal(historyBudget({ model: 'm' }), Infinity);
  assert.ok(historyBudget({ numCtx: 32768, maxTokens: 8192 }, 'sys') > 50_000);
  assert.equal(historyBudget({ numCtx: 2048, maxTokens: 8192 }, 'x'.repeat(50_000)), 6000, 'a floor, never a negative budget');
});

test('the bridge speaks OpenAI to an engine, answers from the provider, streams headers at once and keeps the stream alive', async () => {
  let finished = false;
  const seen = [];
  const provider = {
    model: 'm',
    async chat(req) {
      seen.push(req);
      await new Promise((r) => setTimeout(r, 150));
      finished = true;
      return { content: [{ type: 'text', text: 'writing' }, { type: 'tool_use', id: 'c1', name: 'write_file', input: { path: 'a', content: 'b' } }], stop_reason: 'tool_use', usage: { input_tokens: 7, output_tokens: 3 } };
    },
  };
  const bridge = await startBridge(provider, { meta: { task: { id: 't' } }, keepaliveMs: 20 });
  servers.push(bridge);
  const url = `${bridge.baseUrl}/chat/completions`;
  const body = {
    model: 'm',
    stream: true,
    max_tokens: 99,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'p1', content: '(empty)' },
    ],
    tools: [{ type: 'function', function: { name: 'write_file', description: 'w', parameters: { type: 'object' } } }],
  };
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(body) })).status, 401, 'the one-off token is required');
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  assert.equal(finished, false, 'headers arrive before the model has answered');
  const text = await res.text();
  assert.match(text, /^: da-prompt bridge/);
  assert.match(text, /: keepalive/);
  const chunks = text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
  assert.equal(chunks[0].choices[0].delta.content, 'writing');
  assert.deepEqual(chunks[0].choices[0].delta.tool_calls, [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a","content":"b"}' } }]);
  assert.equal(chunks[1].choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(chunks[1].usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  assert.match(text, /data: \[DONE\]\n\n$/);
  // What the provider received: the factory's own message shape, the output limit and the task meta.
  const [req] = seen;
  assert.equal(req.system, 'sys');
  assert.equal(req.maxTokens, 99);
  assert.equal(req.meta.kind, 'task');
  assert.equal(req.meta.task.id, 't');
  assert.deepEqual(req.messages, [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'p1', name: 'list_files', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p1', content: '(empty)' }] },
  ]);
  assert.deepEqual(req.tools, [{ name: 'write_file', description: 'w', input_schema: { type: 'object' } }]);

  // A provider failure is an error event on the stream, and its message is kept for the engine's report.
  provider.chat = async () => { throw new Error('Ollama (m): provider-side error: HTTP 500: out of memory'); };
  const bad = await (await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify(body) })).text();
  assert.match(bad, /"error":\{"message":"Ollama \(m\): provider-side error: HTTP 500: out of memory"/);
  assert.match(bridge.lastError(), /out of memory/);
  // Non-streaming requests get a plain completion.
  provider.chat = async () => ({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: {} });
  const plain = await (await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ ...body, stream: false }) })).json();
  assert.deepEqual([plain.choices[0].message.content, plain.choices[0].finish_reason], ['hi', 'stop']);
  assert.equal(fromOpenAIRequest({ messages: [{ role: 'assistant', content: 'x' }] }).messages[0].role, 'user', 'a conversation always starts with the user');

  // fx keeps its whole history; what the bridge sends a small-window model is shortened like the built-in engine's.
  let got;
  const small = await startBridge({ model: 'm', numCtx: 4096, maxTokens: 1024, chat: async (r) => { got = r; return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} }; } });
  servers.push(small);
  const long = [{ role: 'user', content: '# Task t: brief' }];
  for (let i = 0; i < 10; i++) long.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: `c${i}`, content: 'z'.repeat(3000) });
  await (await fetch(`${small.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${small.token}` }, body: JSON.stringify({ messages: long }) })).json();
  assert.ok(got.messages.length < 21 && /^# Task t: brief/.test(got.messages[0].content), 'shortened, brief first');
});

/** A mock Ollama that answers like a small local model: the plan as text with loose fields, tool calls as qwen3-coder XML. */
async function localOllama() {
  const srv = await serve((req, body) => {
    if (req.url === '/api/tags') return [200, { models: [{ name: 'qwen3-coder:30b', details: {} }] }];
    if (req.url === '/api/show') return [200, { capabilities: ['completion', 'tools'] }];
    if (req.url !== '/api/chat') return [404, {}];
    const tools = (body.tools || []).map((t) => t.function.name);
    const turn = body.messages.filter((m) => m.role === 'assistant').length;
    const say = (content) => [200, { message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 50, eval_count: 20 }];
    if (tools.includes('submit_plan')) {
      return say(`Here is the plan:\n\`\`\`json\n${JSON.stringify({ product: { name: 'Hello', summary: 'a greeting file' }, tasks: [{ id: 'Write greeting', role: 'backend', title: 'Greeting', description: 'write hello.txt', verify: 'grep -q "{hello}" hello.txt' }], finalVerify: 'test -f hello.txt' })}\n\`\`\``);
    }
    if (tools.includes('complete_task')) {
      if (turn === 0) return say('<tool_call>\n<function=write_file>\n<parameter=path>\nhello.txt\n</parameter>\n<parameter=content>\n{hello}\nworld\n</parameter>\n</function>\n</tool_call>');
      return say('<function=complete_task>\n<parameter=summary>\nwrote hello.txt\n</parameter>\n<parameter=files>\n["hello.txt"]\n</parameter>\n</function>');
    }
    return say('Summary: hello.txt was written and verified.');
  });
  servers.push(srv);
  return srv;
}

const factoryFor = (ollama, extra = {}) => {
  const cfg = loadConfig({ dataDir: tmpDir(), env: { OLLAMA_HOST: ollama.url }, defaultProvider: '', defaultModel: '', ...extra });
  const store = new RunStore(cfg.dataDir);
  return { store, factory: new Factory({ cfg, store, previews: { get: () => null, stop: () => {}, stopAll: () => {}, start: async () => ({ ok: false, error: 'off' }) } }) };
};

test('a local model that writes its plan as text and its tool calls as XML completes a run on the built-in engine', async () => {
  const ollama = await localOllama();
  const { store, factory } = factoryFor(ollama);
  const run = await factory.start((await factory.createRun({ idea: 'a hello file', provider: 'ollama', model: 'qwen3-coder:30b', settings: { deploy: false } })).id);
  // The plan, the tool calls and verification all worked (this tiny app has no README or deploy, so the run itself needs attention).
  const item = (id) => run.checklist.find((c) => c.id === id);
  assert.deepEqual([item('tasks').ok, item('tests').ok], [true, true], run.error || JSON.stringify(run.checklist));
  assert.deepEqual(run.plan.tasks.map((t) => [t.id, t.role, t.status]), [['write-greeting', 'engineer', 'completed']]);
  assert.equal(fs.readFileSync(path.join(store.workspaceDir(run.id), 'hello.txt'), 'utf8'), '{hello}\nworld');
  assert.equal(run.plan.tasks[0].result.summary, 'wrote hello.txt');
  const chats = ollama.log.filter((r) => r.url === '/api/chat');
  assert.ok(chats.every((r) => r.body.options.num_ctx === 32768));
});

/**
 * A stand-in for @appport/fx that, like the real one, sends streaming OpenAI-compatible requests over HTTP to the model
 * handle's baseUrl (authenticating with the key read from apiKeyEnv), runs the tool calls it gets back, and stops when the
 * model answers without one. It exercises the whole bridge path; tests/engines.test.js covers the engine contract itself.
 */
function httpFx() {
  const log = { models: [] };
  return {
    log,
    createFxModel: async (o) => { log.models.push(o); return o; },
    createFxAgent: async ({ model, tools, instructions, maxSteps }) => {
      const history = [{ role: 'system', content: instructions }];
      return {
        close: async () => {},
        prompt(input, { signal } = {}) {
          let cancelled = false;
          let finish;
          let fail;
          const result = new Promise((r, j) => { finish = r; fail = j; });
          return {
            result,
            cancel: () => { cancelled = true; },
            async *[Symbol.asyncIterator]() {
              history.push({ role: 'user', content: input });
              const usage = { inputTokens: 0, outputTokens: 0 };
              for (let step = 0; step < maxSteps && !cancelled; step++) {
                const res = await fetch(`${model.baseUrl}/chat/completions`, { method: 'POST', signal, headers: { authorization: `Bearer ${process.env[model.apiKeyEnv]}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: model.model, stream: true, messages: history, tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }) });
                const text = await res.text();
                const chunks = text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
                if (res.status !== 200 || chunks.some((c) => c.error)) { fail(Object.assign(new Error('ProviderError'), { code: 'LIBFX_MODEL_REQUEST_FAILED' })); return; }
                const delta = chunks[0].choices[0].delta;
                usage.inputTokens += chunks.at(-1).usage?.prompt_tokens || 0;
                usage.outputTokens += chunks.at(-1).usage?.completion_tokens || 0;
                if (delta.content) yield { type: 'text_delta', delta: delta.content };
                history.push({ role: 'assistant', content: delta.content || null, ...(delta.tool_calls ? { tool_calls: delta.tool_calls.map(({ index, ...c }) => c) } : {}) });
                if (!delta.tool_calls) break;
                for (const c of delta.tool_calls) {
                  yield { type: 'tool_start', id: c.id, name: c.function.name };
                  const out = await tools.find((t) => t.name === c.function.name).execute(JSON.parse(c.function.arguments), { signal });
                  history.push({ role: 'tool', tool_call_id: c.id, content: out });
                  if (cancelled) break;
                }
              }
              finish({ stopReason: cancelled ? 'cancelled' : 'end_turn', usage });
            },
          };
        },
      };
    },
  };
}

test('the fx engine reaches a local model through the bridge: num_ctx, text tool-call recovery and the provider\'s own errors', async () => {
  const ollama = await localOllama();
  const fx = httpFx();
  const { store, factory } = factoryFor(ollama, { engineModules: { fx } });
  const run = await factory.start((await factory.createRun({ idea: 'a hello file', provider: 'ollama', model: 'qwen3-coder:30b', engine: 'fx', providerOptions: { numCtx: 16384 }, settings: { deploy: false } })).id);
  // The plan, the tool calls and verification all worked (this tiny app has no README or deploy, so the run itself needs attention).
  const item = (id) => run.checklist.find((c) => c.id === id);
  assert.deepEqual([item('tasks').ok, item('tests').ok], [true, true], run.error || JSON.stringify(run.checklist));
  assert.equal(fs.readFileSync(path.join(store.workspaceDir(run.id), 'hello.txt'), 'utf8'), '{hello}\nworld');
  assert.equal(run.plan.tasks[0].result.summary, 'wrote hello.txt');
  // fx was pointed at the loopback bridge, never at Ollama; every model request reached Ollama's native API with num_ctx.
  assert.match(fx.log.models[0].baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(fx.log.models[0].model, 'qwen3-coder:30b');
  const chats = ollama.log.filter((r) => r.url === '/api/chat');
  assert.ok(chats.length >= 4 && chats.every((r) => r.body.options.num_ctx === 16384));
  assert.ok(!(await store.events(run.id)).some((e) => e.type === 'log' && e.level === 'warn' && /not applied/.test(e.text)), 'no option is reported as dropped');
  assert.deepEqual(Object.keys(process.env).filter((k) => k.startsWith('DA_PROMPT_FX_KEY')), []);

  // When the model fails, the attempt reports the provider's own message rather than fx's bare "ProviderError".
  const broken = await serve((req, body) => {
    if (req.url === '/api/tags') return [200, { models: [{ name: 'm:7b' }] }];
    if (req.url === '/api/show') return [200, {}];
    if ((body.tools || []).some((t) => t.function.name === 'submit_plan')) return [200, { message: { role: 'assistant', content: JSON.stringify({ tasks: [{ id: 't', title: 't', description: 'd', verify: 'true' }] }) }, done: true }];
    return [400, { error: 'model requires more system memory (12 GiB) than is available' }];
  });
  servers.push(broken);
  const b = factoryFor(broken, { engineModules: { fx } });
  const failed = await b.factory.start((await b.factory.createRun({ idea: 'x', provider: 'ollama', model: 'm:7b', engine: 'fx', settings: { deploy: false, maxAttempts: 1 } })).id);
  assert.notEqual(failed.status, 'completed');
  assert.ok(failed.plan, failed.error);
  assert.match(failed.plan.tasks[0].attempts[0].error, /^Model error: Ollama \(m:7b\): HTTP 400: model requires more system memory/);
});

// ── Deterministic local smoke tests: no live model, every reply scripted ───────────────────────────────────────────

/** Mock Ollama whose agent never finishes on its own (it keeps writing files), so only the budget or the turn limit stops it. */
async function busyOllama({ promptTokens = 6000 } = {}) {
  const srv = await serve((req, body) => {
    if (req.url === '/api/tags') return [200, { models: [{ name: 'q:7b', details: {} }] }];
    if (req.url === '/api/show') return [200, { capabilities: ['completion', 'tools'] }];
    const tools = (body.tools || []).map((t) => t.function.name);
    const say = (message) => [200, { message: { role: 'assistant', ...message }, done: true, done_reason: 'stop', prompt_eval_count: promptTokens, eval_count: 20 }];
    if (tools.includes('submit_plan')) {
      return say({ content: '', tool_calls: [{ function: { name: 'submit_plan', arguments: { product: { name: 'G', summary: 'greeting', successCriteria: ['a.txt exists'] }, tasks: [{ id: 'a', role: 'engineer', title: 'A', description: 'write a.txt', acceptance: ['a.txt exists'], verify: ['test -f a.txt'] }], finalVerify: ['test -f a.txt'] } } }] });
    }
    return say({ content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: `f${body.messages.length}.txt`, content: 'x' } } }] });
  });
  servers.push(srv);
  return srv;
}

test('Ollama planning requests turn thinking off; every other request and dialect is left alone', async () => {
  const ollama = await localOllama();
  const { factory } = factoryFor(ollama);
  await factory.start((await factory.createRun({ idea: 'a hello file', provider: 'ollama', model: 'qwen3-coder:30b', settings: { deploy: false } })).id);
  const chats = ollama.log.filter((r) => r.url === '/api/chat');
  const isPlan = (r) => (r.body.tools || []).some((t) => t.function.name === 'submit_plan');
  const plans = chats.filter(isPlan);
  assert.ok(plans.length >= 1 && plans.every((r) => r.body.think === false), 'plan requests carry think:false');
  assert.ok(plans.every((r) => r.body.tools.some((t) => t.function.name === 'submit_plan')), 'the plan contract (submit_plan tool) is still sent');
  const others = chats.filter((r) => !isPlan(r));
  assert.ok(others.length >= 2 && others.every((r) => !('think' in r.body)), 'agent and summary requests do not set think');

  // Other dialects never get the field, planning or not.
  const openai = await serve((req) => (req.url.endsWith('/chat/completions') ? completion({ content: 'ok' }) : [404, {}]));
  servers.push(openai);
  const compat = new OpenAICompatProvider({ id: 'x', label: 'X', baseUrl: `${openai.url}/v1`, model: 'm', dialect: 'openai' });
  await compat.chat({ system: 's', messages: [{ role: 'user', content: 'go' }], meta: { kind: 'plan' } });
  await compat.chat({ system: 's', messages: [{ role: 'user', content: 'go' }], meta: { kind: 'task' } });
  const sent = openai.log.filter((r) => r.url.endsWith('/chat/completions'));
  assert.equal(sent.length, 2);
  assert.ok(sent.every((r) => !('think' in r.body) && !('options' in r.body)));
});

test('native tool calls from Ollama are parsed, and an incomplete plan does not pass', async () => {
  const srv = await serve(() => [200, { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'src/a.js', content: 'export {}' } } }, { function: { name: 'complete_task', arguments: { summary: 'done', files: ['src/a.js'] } } }] }, done: true, done_reason: 'stop', prompt_eval_count: 11, eval_count: 5 }]);
  servers.push(srv);
  const provider = new OpenAICompatProvider({ id: 'ollama', label: 'Ollama', baseUrl: srv.url, model: 'm', dialect: 'ollama' });
  const tools = NAMES.map((name) => ({ name, description: name, input_schema: { type: 'object' } }));
  const res = await provider.chat({ system: 's', messages: [{ role: 'user', content: 'go' }], tools, meta: { kind: 'task' } });
  assert.equal(res.stop_reason, 'tool_use');
  assert.deepEqual(res.content.filter((c) => c.type === 'tool_use').map((c) => [c.name, c.input]), [['write_file', { path: 'src/a.js', content: 'export {}' }], ['complete_task', { summary: 'done', files: ['src/a.js'] }]]);
  assert.deepEqual(res.usage, { input_tokens: 11, output_tokens: 5, reported: true });

  const good = { product: { summary: 's', successCriteria: ['c'] }, tasks: [{ id: 'a', role: 'engineer', title: 't', description: 'd', acceptance: ['x'], verify: ['true'] }] };
  assert.deepEqual(validatePlan(good), []);
  assert.ok(validatePlan({ ...good, tasks: [] }).length, 'no tasks');
  assert.ok(validatePlan({ ...good, product: { summary: 's' } }).some((m) => /successCriteria/.test(m)), 'no success criteria');
  assert.ok(validatePlan({ ...good, tasks: [{ ...good.tasks[0], acceptance: [] }] }).some((m) => /acceptance/.test(m)));
  assert.ok(validatePlan({ ...good, tasks: [{ ...good.tasks[0], dependsOn: ['ghost'] }] }).some((m) => /unknown task/.test(m)));
  assert.ok(validatePlan({ ...good, tasks: [{ ...good.tasks[0], verify: 'true' }] }).some((m) => /verify/.test(m)), 'verify must be a list');
});

test('a model that never returns a plan cannot complete a run (the standard plan tasks escalate)', async () => {
  const mute = await serve((req) => (req.url === '/api/chat' ? [200, { message: { role: 'assistant', content: 'I will think about it.' }, done: true, done_reason: 'stop' }] : req.url === '/api/tags' ? [200, { models: [{ name: 'q:7b', details: {} }] }] : [200, { capabilities: ['completion', 'tools'] }]));
  servers.push(mute);
  const { store, factory } = factoryFor(mute);
  const run = await factory.start((await factory.createRun({ idea: 'x', provider: 'ollama', model: 'q:7b', settings: { deploy: false } })).id);
  assert.notEqual(run.status, 'completed');
  assert.equal(run.status, 'needs_attention');
  assert.ok((await store.events(run.id)).some((e) => e.type === 'plan' && e.source !== 'model'), 'the plan is recorded as not coming from the model');
  assert.ok(!(run.plan?.tasks || []).some((t) => t.status === 'completed'));
});

test('the bridge charges the budget per model request, refuses once it is spent, and keeps cancellation apart from errors', async () => {
  let used = 0;
  const track = { check() { if (used >= 100) throw new Error('token budget exhausted'); }, add(u) { used += (u.input_tokens || 0) + (u.output_tokens || 0); } };
  let calls = 0;
  const provider = { model: 'm', chat: async () => { calls++; return { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 80, output_tokens: 20 } }; } };
  const bridge = await startBridge(provider, { track });
  servers.push(bridge);
  const post = (body = {}) => fetch(`${bridge.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], ...body }) });
  assert.equal((await post()).status, 200);
  assert.equal(used, 100, 'usage is charged when the request is answered, not when a turn ends');
  assert.equal(bridge.budget(), null);
  assert.equal((await post()).status, 502, 'the next request is refused');
  assert.equal(calls, 1, 'and never reaches the model');
  assert.match(bridge.budget().message, /token budget exhausted/);

  // A hung-up request is a cancellation: no error is recorded and nothing is charged.
  let seenSignal;
  const slow = { model: 'm', chat: ({ signal }) => new Promise((_, rej) => { seenSignal = signal; signal.addEventListener('abort', () => rej(new Error('cancelled'))); }) };
  let spent = 0;
  const b2 = await startBridge(slow, { track: { check() {}, add: (u) => { spent += u.input_tokens || 0; } } });
  servers.push(b2);
  const ac = new AbortController();
  const pending = fetch(`${b2.baseUrl}/chat/completions`, { method: 'POST', signal: ac.signal, headers: { authorization: `Bearer ${b2.token}` }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) }).catch(() => null);
  await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  await pending;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(seenSignal.aborted, true, 'the provider call is cancelled');
  assert.equal(b2.lastError(), null);
  assert.equal(spent, 0);
});

test('fx: the budget stops an attempt between model requests, every request is counted, and the run says it is incomplete', async () => {
  const ollama = await busyOllama({ promptTokens: 6000 });
  const { factory } = factoryFor(ollama, { engineModules: { fx: httpFx() } });
  const created = await factory.createRun({ idea: 'a', provider: 'ollama', model: 'q:7b', engine: 'fx', settings: { deploy: false, maxAttempts: 1, tokenBudget: 10_000 } });
  const run = await factory.start(created.id);
  const chats = ollama.log.filter((r) => r.url === '/api/chat');
  const agentRequests = chats.filter((r) => !(r.body.tools || []).some((t) => t.function.name === 'submit_plan')).length;
  // plan (6020) + one agent request (6020) = 12040 >= 10000: the second agent request is refused before it reaches the model.
  assert.equal(agentRequests, 1, 'no request is sent once the budget is spent');
  assert.equal(run.usage.calls, chats.length, 'usage.calls counts model requests, not engine turns');
  assert.equal(run.usage.input + run.usage.output, chats.length * 6020, 'usage is the sum of what the provider reported');
  assert.equal(run.status, 'needs_attention');
  assert.match(run.error, /token budget exhausted \(12040 \/ 10000\)/);
  assert.notEqual(run.plan.tasks[0].status, 'completed');
  assert.equal(run.delivery, undefined, 'nothing is delivered as if it were finished');
});

test('a task whose required verification fails cannot make the run succeed', async () => {
  const ollama = await serve((req, body) => {
    if (req.url === '/api/tags') return [200, { models: [{ name: 'q:7b', details: {} }] }];
    if (req.url === '/api/show') return [200, { capabilities: ['completion', 'tools'] }];
    const tools = (body.tools || []).map((t) => t.function.name);
    const call = (name, args) => [200, { message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 10 }];
    if (tools.includes('submit_plan')) return call('submit_plan', { product: { name: 'G', summary: 'greeting', successCriteria: ['works'] }, tasks: [{ id: 'a', role: 'engineer', title: 'A', description: 'write a.txt', acceptance: ['works'], verify: ['test -f never-written.txt'] }], finalVerify: ['true'] });
    if (tools.includes('complete_task')) return call('complete_task', { summary: 'all done, trust me', files: [] });
    return [200, { message: { role: 'assistant', content: 'summary' }, done: true, done_reason: 'stop' }];
  });
  servers.push(ollama);
  const { factory } = factoryFor(ollama);
  const run = await factory.start((await factory.createRun({ idea: 'a', provider: 'ollama', model: 'q:7b', settings: { deploy: false, maxAttempts: 2 } })).id);
  const t = run.plan.tasks[0];
  assert.equal(t.status, 'escalated');
  assert.equal(t.attempts.length, 2);
  assert.ok(t.attempts.every((a) => a.verification.some((v) => v.ok === false)), 'verification really ran and failed');
  assert.notEqual(run.status, 'completed');
  assert.equal(run.checklist.find((c) => c.id === 'tasks')?.ok, false);
});
