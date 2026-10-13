// Inference diagnostics, the offline preflight and the tuning contract. Everything here is deterministic: mock servers and
// scripted providers only. No Ollama, no credentials, no live inference.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tmpDir } from './helpers.js';
import { startMockLLM } from './mock-llm.js';
import { startBackend, cli, cleanMachineEnv } from './cli-helpers.js';
import { setup, Scripted, task, plan, done, toolUse } from './project-helpers.js';
import { loadConfig } from '../src/config.js';
import { RunStore } from '../src/store.js';
import { Factory } from '../src/factory.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { OpenAICompatProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OfflineProvider } from '../src/providers/offline.js';
import { RunDiagnostics, MAX_RECORDS, instrumentProvider, failureKind, usageOf, readRecords, summarizeRun, repeatedToolFailures, safeMessage, requestSize } from '../src/diagnostics.js';
import { describeInference, contractWarnings } from '../src/contract.js';

cleanMachineEnv();
const closers = [];
after(async () => { await Promise.all(closers.map((c) => c())); });
const mock = async (o) => { const m = await startMockLLM(o); closers.push(() => m.close()); return m; };
const SENTINEL = 'SENTINEL-credential-9f3a7c1d5b2e8a40'; // deliberately not shaped like any known key pattern
const files = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(f); } }; walk(dir); return out; };
const noSecret = (dir, secret = SENTINEL) => { for (const f of files(dir)) assert.ok(!fs.readFileSync(f, 'latin1').includes(secret), `${path.relative(dir, f)} contains the secret`); };

/** A tiny HTTP server: `route(req, body) -> [status, object, headers?]`. */
async function serve(route) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    log.push({ method: req.method, url: req.url, body, headers: req.headers });
    const [status, obj, headers = {}] = await route(req, body, log);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => (server.closeAllConnections?.(), server.close(r))));
  return { url: `http://127.0.0.1:${server.address().port}`, log };
}
const reply = (extra = {}) => [200, { choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], ...extra }];

// ── records ──────────────────────────────────────────────────────────────────────────────────

test('a run records a structured entry per model call and per phase, labelled as factory-measured or provider-reported', async () => {
  const api = await mock({ flavor: 'openai', models: ['m1'], apiKey: SENTINEL });
  const cfg = loadConfig({ dataDir: tmpDir(), env: { OPENAI_API_KEY: SENTINEL, OPENAI_BASE_URL: api.url }, defaultProvider: 'openai', defaultModel: 'm1' });
  const store = new RunStore(cfg.dataDir);
  const factory = new Factory({ cfg, store, previews: { get: () => null, stop() {}, stopAll() {}, start: async () => ({ ok: false }) } });
  const run = await factory.start((await factory.createRun({ idea: 'A reading list', settings: { deploy: false } })).id);
  assert.equal(run.status, 'completed', run.error);

  const records = readRecords(store.runDir(run.id));
  const calls = records.filter((r) => r.type === 'call');
  assert.ok(calls.length > 10);
  for (const c of calls) {
    assert.equal(c.engine, 'builtin');
    assert.equal(c.provider, 'openai');
    assert.equal(c.model, 'm1');
    assert.equal(c.timing, 'factory-measured');
    assert.ok(Number.isInteger(c.durationMs) && c.durationMs >= 0);
    assert.deepEqual(c.firstResponse, { supported: false, ms: null }, 'chat() cannot report a first-response time, and says so');
    assert.equal(c.outcome, 'ok');
    assert.equal(c.retries, 0);
    assert.ok(c.request.messages >= 1 && c.request.chars > 0);
  }
  assert.deepEqual([...new Set(calls.map((c) => c.purpose))].sort(), ['agent_turn', 'plan', 'summary']);
  assert.equal(calls.find((c) => c.purpose === 'plan').role, 'planner');
  assert.ok(calls.some((c) => c.response?.toolCalls > 0 && c.response.tools.length > 0), 'tool-call counts are recorded');
  assert.ok(calls.every((c) => c.usage.source === 'provider' && c.usage.input > 0), 'the mock reports usage');
  const phases = records.filter((r) => r.type === 'phase');
  assert.ok(phases.some((p) => p.layer === 'plan' && p.state === 'active') && phases.some((p) => p.layer === 'plan' && p.state === 'done'));

  const s = summarizeRun(run, await store.events(run.id), records);
  assert.equal(s.run.status, 'completed');
  assert.equal(s.calls.count, calls.length);
  assert.ok(s.calls.tokens.input > 0 && s.calls.tokens.callsUnavailable === 0);
  assert.equal(s.outcome.verification.checklistPassed, s.outcome.verification.checklistTotal);
  assert.equal(s.outcome.delivery.produced, true);
  assert.ok(s.phases.durationMs.plan >= 0 && 'execution' in s.phases.durationMs);
  assert.ok(s.tools.calls > 0 && s.tools.byTool.write_file.calls > 0);
  assert.equal(s.calls.byPurpose.plan.count + s.calls.byPurpose.agent_turn.count + s.calls.byPurpose.summary.count, calls.length);
  noSecret(cfg.dataDir); // the key was configured, and appears nowhere on disk
});

test('missing usage is "unavailable", never a fabricated zero; provider-reported usage is labelled as such', async () => {
  const none = await serve(() => reply()); // no usage block at all
  const some = await serve(() => reply({ usage: { prompt_tokens: 11, completion_tokens: 3 } }));
  const ollama = await serve(() => [200, { message: { role: 'assistant', content: 'hi' }, done: true }]); // no eval counts
  const dir = tmpDir();
  const diag = new RunDiagnostics({ dir, runId: 'r1' });
  const mk = (url, extra = {}) => instrumentProvider(new OpenAICompatProvider({ id: 'p', baseUrl: url, model: 'm', ...extra }), diag, 'agent');
  for (const p of [mk(none.url), mk(some.url), mk(ollama.url, { dialect: 'ollama' })]) await p.chat({ system: 's', messages: [{ role: 'user', content: 'x' }], meta: { kind: 'task', task: { id: 't' }, attempt: 1 } });
  const [a, b, c] = readRecords(dir).filter((r) => r.type === 'call');
  assert.deepEqual(a.usage, { source: 'unavailable' });
  assert.deepEqual(b.usage, { source: 'provider', input: 11, output: 3 });
  assert.deepEqual(c.usage, { source: 'unavailable' });
  assert.deepEqual(usageOf(undefined), { source: 'unavailable' });
  assert.deepEqual(usageOf({ input_tokens: 0, output_tokens: 0 }), { source: 'unavailable' }, 'an injected provider that says nothing positive is not believed');
  assert.deepEqual(usageOf({ input_tokens: 0, output_tokens: 0, reported: true }), { source: 'provider', input: 0, output: 0 });
  const s = summarizeRun({ id: 'r1' }, [], readRecords(dir));
  assert.equal(s.calls.tokens.callsUnavailable, 2);
  assert.equal(s.calls.tokens.input, 11);
});

test('failures are classified, retries are counted and bounded, and the key never reaches a record', async () => {
  let n = 0;
  let ollamaHits = 0;
  const flaky = await serve((req) => {
    if (req.url === '/api/chat') ollamaHits++;
    else n++;
    return [503, { error: { message: `overloaded; token ${SENTINEL}` } }, { 'retry-after': '0' }];
  });
  const dir = tmpDir();
  const diag = new RunDiagnostics({ dir, runId: 'r1', secrets: () => [SENTINEL] });
  const p = instrumentProvider(new OpenAICompatProvider({ id: 'p', baseUrl: flaky.url, apiKey: SENTINEL, model: 'm' }), diag, 'agent');
  await assert.rejects(p.chat({ system: 's', messages: [{ role: 'user', content: 'x' }], meta: { kind: 'plan' } }), /provider-side error/);
  assert.equal(n, 5, 'one try plus the four fixed retries, then it stops');
  const [rec] = readRecords(dir).filter((r) => r.type === 'call');
  assert.equal(rec.outcome, 'error');
  assert.equal(rec.failure.kind, 'provider_error');
  assert.equal(rec.retries, 4);
  assert.deepEqual(rec.retryReasons, ['http_503', 'http_503', 'http_503', 'http_503']);
  assert.ok(!JSON.stringify(rec).includes(SENTINEL), 'a secret echoed by the provider is scrubbed');
  assert.ok(rec.failure.message.length <= 300);
  assert.equal(rec.purpose, 'plan');

  // The Ollama dialect has its own, smaller bound.
  const q = instrumentProvider(new OpenAICompatProvider({ id: 'o', baseUrl: flaky.url, model: 'm', dialect: 'ollama' }), diag, 'agent');
  await assert.rejects(q.chat({ system: 's', messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(readRecords(dir).filter((r) => r.type === 'call').at(-1).retries, 2);
  assert.equal(ollamaHits, 3, 'one try plus the two fixed Ollama retries');

  for (const [input, kind] of [
    [new Error('Provider (m): authentication failed (check the API key): HTTP 401: nope'), 'authentication'],
    [new Error('model or endpoint not found: HTTP 404: x'), 'model_not_found'],
    [new Error('rate limited: HTTP 429: slow'), 'rate_limited'],
    [new Error('connection failed: connection refused (is the server running?)'), 'connection'],
    [Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), 'timeout'],
    [Object.assign(new Error('model call timed out'), { code: 'LIBFX_MODEL_TIMEOUT' }), 'first_response_timeout'],
    [Object.assign(new Error('x'), { code: 'LIBFX_MODEL_FAILED', kind: 'rate_limited' }), 'rate_limited'],
    [Object.assign(new Error('x'), { code: 'LIBFX_MODEL_FAILED', kind: 'malformed_tool_call' }), 'malformed_tool_call'],
    [new Error('cancelled'), 'cancelled'],
    [new Error('token budget exhausted (1 / 1)'), 'budget'],
    [new Error('something else'), 'other'],
  ]) assert.equal(failureKind(input), kind, String(input.message));
  assert.equal(safeMessage(`Bearer abcdefghijklmnop ${SENTINEL}`, [SENTINEL]).includes(SENTINEL), false);
  assert.ok(!/abcdefghijklmnop/.test(safeMessage('Bearer abcdefghijklmnop')));
});

test('recording is bounded and can never affect a call: a broken diagnostics file changes nothing', async () => {
  const dir = tmpDir();
  const diag = new RunDiagnostics({ dir, runId: 'r1' });
  for (let i = 0; i < MAX_RECORDS + 25; i++) diag.phase('plan', i % 2 ? 'done' : 'active');
  const all = readRecords(dir);
  assert.equal(all.filter((r) => r.type === 'phase').length, MAX_RECORDS);
  assert.equal(all.filter((r) => r.type === 'truncated').length, 1);
  assert.equal(summarizeRun({ id: 'r1' }, [], all).truncated, true);

  const broken = new RunDiagnostics({ dir: path.join(tmpDir(), 'does', 'not', 'exist'), runId: 'r2' });
  const p = instrumentProvider(new OfflineProvider({ faults: false, delayMs: 0 }), broken, 'agent');
  const res = await p.chat({ system: 's', messages: [], meta: { kind: 'summary', run: { plan: { product: {}, tasks: [] }, checklist: [] } } });
  assert.ok(res.content, 'the reply passes through untouched');
  const boom = { chat: async () => { throw Object.assign(new Error('x'), { code: 'KEEP' }); }, describe: () => ({}) };
  await assert.rejects(instrumentProvider(boom, broken, 'agent').chat({ messages: [] }), (e) => e.code === 'KEEP', 'errors pass through unchanged');
  assert.deepEqual(requestSize({ system: 'abc', messages: [{ role: 'user', content: 'de' }, { role: 'user', content: [{ type: 'tool_result', content: 'fgh' }] }] }), { messages: 2, chars: 8, tools: 0 });
});

test('identical failing tool calls are reported, so a stuck loop is visible (diagnosis only; nothing is retried or skipped)', () => {
  const ev = (tool, input, ok) => ({ type: 'tool', taskId: 't', tool, input, ok });
  const rep = repeatedToolFailures([ev('run_command', { command: 'npm test' }, false), ev('run_command', { command: 'npm test' }, false), ev('run_command', { command: 'npm test' }, true), ev('write_file', { path: 'a' }, false), ev('run_command', { command: 'npm test' }, false)]);
  assert.deepEqual(rep.map((r) => [r.tool, r.count]), [['run_command', 3]]);
});

// ── engines ──────────────────────────────────────────────────────────────────────────────────

test('the configured output-token limit reaches every built-in provider request', async () => {
  const cfgFor = (env) => loadConfig({ dataDir: tmpDir(), env, maxOutputTokens: 1234, defaultProvider: '', defaultModel: '' });
  const openai = await serve(() => reply());
  const ollama = await serve(() => [200, { message: { role: 'assistant', content: 'hi' }, done: true }]);
  const claude = await serve(() => [200, { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }]);
  const ask = (p) => p.chat({ system: 's', messages: [{ role: 'user', content: 'x' }] });
  const reg = new ProviderRegistry(cfgFor({ OPENAI_API_KEY: 'k-openai-123456', OPENAI_BASE_URL: openai.url, OLLAMA_HOST: ollama.url, ANTHROPIC_API_KEY: 'k-claude-123456', ANTHROPIC_BASE_URL: claude.url }));
  await ask(reg.create('openai', { model: 'm' }));
  await ask(reg.create('ollama', { model: 'm' }));
  await ask(reg.create('anthropic', { model: 'm' }));
  assert.equal(openai.log.at(-1).body.max_tokens, 1234);
  assert.equal(ollama.log.at(-1).body.options.num_predict, 1234);
  assert.equal(claude.log.at(-1).body.max_tokens, 1234);
  assert.equal(ollama.log.at(-1).body.options.num_ctx, 32768, 'the Ollama context window reaches the request body');
  assert.equal(reg.create('ollama', { model: 'm', options: { numCtx: 8192 } }).numCtx, 8192, 'a run-level context overrides the provider default');
  // …and the default when nothing is configured.
  assert.equal(loadConfig({ dataDir: tmpDir() }).maxOutputTokens, 8192);
  assert.equal(new AnthropicProvider({ apiKey: 'k', model: 'm' }).maxTokens, 8192);
});

test('concurrency: the default is unchanged, and 1 runs tasks strictly one at a time', async () => {
  const run = async (maxParallel) => {
    let inflight = 0;
    let peak = 0;
    class Slow extends Scripted {
      async chat(req) {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 25));
        try { return await super.chat(req); } finally { inflight--; }
      }
    }
    const prov = new Slow({ plan: () => plan(['a', 'b', 'c', 'd'].map((id) => task(id)), { finalVerify: [] }), task: ({ turn }) => (turn === 0 ? [toolUse('write_file', { path: 'x.txt', content: 'x' })] : [done('ok')]) });
    const { factory } = setup({ provider: prov });
    const created = await factory.createRun({ idea: 'four independent tasks', provider: 'offline', settings: { deploy: false, ...(maxParallel ? { maxParallel } : {}) } });
    const finished = await factory.start(created.id);
    assert.equal(finished.plan.tasks.filter((t) => t.status === 'completed').length, 4, finished.error);
    return { peak, setting: finished.settings.maxParallel };
  };
  assert.deepEqual(await run(), { peak: 3, setting: 3 });
  assert.deepEqual(await run(1), { peak: 1, setting: 1 });
});

test('a cancelled run is not completed, and a model that always times out cannot complete a task', async () => {
  const hang = new Scripted({ plan: () => plan([task('t')], { finalVerify: [] }), task: () => [done('x')] });
  hang.chat = (req) => (req.meta?.kind === 'plan' ? Scripted.prototype.chat.call(hang, req) : new Promise((_, rej) => req.signal?.addEventListener('abort', () => rej(new Error('cancelled')))));
  const a = setup({ provider: hang });
  const created = await a.factory.createRun({ idea: 'x', provider: 'offline', settings: { deploy: false } });
  const p = a.factory.start(created.id);
  await new Promise((r) => setTimeout(r, 150));
  await a.factory.cancel(created.id);
  const cancelled = await p;
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(!cancelled.delivery, 'nothing is delivered for a cancelled run');
  const rec = readRecords(a.store.runDir(created.id)).filter((r) => r.type === 'call');
  assert.ok(rec.some((r) => r.outcome === 'cancelled' && r.failure.kind === 'cancelled'), 'the in-flight call is recorded as cancelled');

  const timing = new Scripted({ plan: () => plan([task('t', { verify: ['test -f never.txt'] })], { finalVerify: [] }), task: () => [done('claimed it is done')] });
  const real = timing.chat.bind(timing);
  timing.chat = async (req) => { if (req.meta?.kind === 'task') throw Object.assign(new Error('Provider (m): inference timed out: no response in time'), { code: 'ETIMEDOUT' }); return real(req); };
  const b = setup({ provider: timing });
  const run = await b.factory.start((await b.factory.createRun({ idea: 'x', provider: 'offline', settings: { deploy: false, maxAttempts: 2 } })).id);
  assert.notEqual(run.status, 'completed');
  assert.equal(run.plan.tasks[0].status, 'escalated');
  const calls = readRecords(b.store.runDir(run.id)).filter((r) => r.type === 'call' && r.purpose === 'agent_turn');
  // The built-in engine lets a provider exception escalate the task at once (existing behaviour, unchanged here).
  assert.equal(calls.length, 1, 'one failing call, not retried by the factory');
  assert.equal(calls[0].failure.kind, 'timeout');
  assert.equal(summarizeRun(run, await b.store.events(run.id), readRecords(b.store.runDir(run.id))).calls.failuresByKind.timeout, 1);
});

// ── offline preflight ────────────────────────────────────────────────────────────────────────

test('the preflight resolves provider, model and engine from configuration alone and never contacts a provider', async () => {
  const api = await mock({ flavor: 'openai', models: ['m1'], apiKey: SENTINEL });
  const be = await startBackend({ env: { OPENAI_API_KEY: SENTINEL, OPENAI_BASE_URL: api.url }, defaultProvider: 'openai', defaultModel: 'm1' });
  try {
    const r = await cli(['diagnostics', '--json'], { backend: be });
    assert.equal(r.code, 0, r.err + r.out);
    const d = r.json.inference;
    assert.equal(d.offline, true);
    assert.deepEqual([d.selection.provider.id, d.selection.provider.source, d.selection.model.id, d.selection.engine.id], ['openai', 'configured', 'm1', 'builtin']);
    assert.equal(d.provider.mode, 'hosted');
    assert.deepEqual([d.provider.keyRequired, d.provider.keyPresent], [true, true]);
    assert.equal(d.problems.length, 0);
    const by = Object.fromEntries(d.settings.map((s) => [s.key, s]));
    assert.equal(by.maxOutputTokens.builtin.status, 'supported');
    assert.equal(by.maxOutputTokens.fx.status, 'supported');
    assert.equal(by.maxParallel.value, 3);
    assert.equal(by.numCtx.builtin.status, 'not-applicable', 'a hosted provider has no context option');
    assert.equal(by.firstResponseTimeout.fx.status, 'fixed');
    assert.equal(by.requestTimeout.builtin.status, 'fixed');
    assert.deepEqual(d.notPerformed.map((n) => n.check), ['provider reachable', 'model is offered by the provider', 'tool calling works with this model', 'latency, throughput, memory or CPU use']);
    assert.equal(api.log.length, 0, 'no request of any kind reached the provider');

    // Text form, including a problem and the explicit live commands. The key is never printed.
    const text = await cli(['diagnostics', '--provider', 'ollama', '--engine', 'fx', '--num-ctx', '8192'], { backend: be });
    assert.equal(text.code, 1); // fx is not installed in this data dir
    assert.match(text.out, /offline: nothing was contacted/);
    assert.match(text.out, /numCtx .* ✗ unsupported/s);
    assert.match(text.out, /@appport\/fx is not installed/);
    assert.match(text.out, /providers test ollama/);
    assert.ok(!text.out.includes(SENTINEL) && !r.out.includes(SENTINEL));
    assert.equal(api.log.length, 0);
  } finally {
    await be.close();
  }
});

test('the preflight distinguishes a configuration error from a check that needs the provider, and handles nothing configured', async () => {
  const be = await startBackend({ env: { OLLAMA_HOST: 'http://127.0.0.1:1' } }); // unreachable on purpose: it must not matter
  try {
    const nothing = (await cli(['diagnostics', '--json'], { backend: be })).json.inference;
    assert.equal(nothing.selection.provider.resolved, false);
    assert.equal(nothing.selection.provider.source, 'automatic');
    assert.match(nothing.selection.provider.reason, /first ready provider/);
    assert.ok(nothing.candidates.some((c) => c.id === 'ollama' && c.keyRequired === false));
    assert.equal(nothing.ok, true, 'an unresolved default is not an error');

    const noKey = await cli(['diagnostics', '--provider', 'anthropic', '--json'], { backend: be });
    assert.equal(noKey.code, 1);
    assert.match(noKey.json.inference.problems[0].message, /needs an API key/);
    assert.match(noKey.json.inference.problems[0].fix, /ANTHROPIC_API_KEY/);
    assert.ok(noKey.json.inference.notPerformed.length > 0, 'the live checks are still listed as not performed');

    const unknown = await cli(['diagnostics', '--provider', 'nope', '--json'], { backend: be });
    assert.match(unknown.json.inference.problems[0].message, /Unknown provider/);
    const fxAnthropic = (await cli(['diagnostics', '--provider', 'anthropic', '--engine', 'fx', '--json'], { backend: be })).json.inference;
    assert.ok(fxAnthropic.problems.some((p) => /not the Anthropic API/.test(p.message)));
  } finally {
    await be.close();
  }
});

test('options an engine cannot honour are surfaced, in the run log and in the contract, never silently dropped', async () => {
  const cfg = loadConfig({ dataDir: tmpDir(), env: {} });
  const reg = new ProviderRegistry(cfg);
  const run = (engine, provider, providerOptions) => ({ engine, provider, providerOptions });
  const fx = contractWarnings(run('fx', 'ollama', { numCtx: 16384, temperature: 0.2, toolMode: 'json' }), reg);
  assert.equal(fx.length, 3);
  assert.match(fx.join('\n'), /numCtx 16384 is not applied/);
  assert.match(fx.join('\n'), /temperature is not applied/);
  assert.match(fx.join('\n'), /toolMode "json" is not applied/);
  assert.match(contractWarnings(run('fx', 'ollama', {}), reg)[0], /server default, not the 32768/);
  assert.deepEqual(contractWarnings(run('builtin', 'ollama', { numCtx: 8192 }), reg), []);
  assert.match(contractWarnings(run('builtin', 'openai', { numCtx: 8192 }), reg)[0], /ignored: only Ollama/);
  assert.deepEqual(contractWarnings(run('builtin', 'openai', {}), reg), []);
  const d = await describeInference(cfg, reg, { provider: 'ollama', engine: 'builtin', providerOptions: { numCtx: 4096 } });
  assert.equal(d.settings.find((s) => s.key === 'numCtx').builtin.status, 'supported');
  assert.equal(d.provider.mode, 'local');
});

// ── API and CLI ──────────────────────────────────────────────────────────────────────────────

test('GET /api/runs/:id/diagnostics and `runs diagnostics` serve the summary; a run that failed on a secret-echoing provider exposes no secret anywhere', async () => {
  const echo = await serve((req) => (req.url.endsWith('/models') ? [200, { data: [{ id: 'm1' }] }] : [401, { error: { message: `bad key ${SENTINEL}` } }]));
  const be = await startBackend({ env: { OPENAI_API_KEY: SENTINEL, OPENAI_BASE_URL: echo.url }, defaultProvider: 'openai', defaultModel: 'm1' });
  try {
    const created = await be.factory.createRun({ idea: 'x', settings: { deploy: false } });
    const run = await be.factory.start(created.id);
    assert.equal(run.status, 'failed');
    assert.equal(run.error.includes(SENTINEL), false);
    const res = await fetch(`${be.url}/api/runs/${created.id}/diagnostics`);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!body.includes(SENTINEL), 'the API response is free of the secret');
    const { diagnostics: d, calls } = JSON.parse(body);
    assert.equal(d.calls.failuresByKind.authentication, 1);
    assert.equal(calls[0].failure.kind, 'authentication');
    assert.match(calls[0].failure.message, /authentication failed/);
    assert.equal(d.outcome.delivery.produced, false);
    assert.equal(d.run.status, 'failed');

    const human = await cli(['runs', 'diagnostics', created.id], { backend: be });
    assert.equal(human.code, 0, human.err);
    assert.match(human.out, /Failures: authentication ×1/);
    const json = await cli(['runs', 'diagnostics', created.id, '--json', '--calls', '1'], { backend: be });
    assert.equal(json.json.calls.length, 1);
    assert.ok(!human.out.includes(SENTINEL) && !JSON.stringify(json.json).includes(SENTINEL));
    assert.equal((await fetch(`${be.url}/api/runs/nosuchrun/diagnostics`)).status, 404);
    noSecret(be.dataDir);
  } finally {
    await be.close();
  }
});
