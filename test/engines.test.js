// Agent engines: the built-in loop stays the default and untouched; the optional FX engine runs a task through the same
// sandboxed tools and the same verification. @appport/fx is replaced by a scripted fake (cfg.engineModules) so this runs offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { OfflineProvider } from '../src/providers/offline.js';
import { engineStatus, fxEndpoint } from '../src/engines/index.js';
import { setup, Scripted, task, plan, done, toolUse } from './project-helpers.js';
import { tmpDir } from './helpers.js';

/** A provider that looks like an Ollama/OpenAI-compatible one (what the FX engine needs) but answers from a script. */
class EndpointProvider extends Scripted {
  constructor(opts, endpoint = {}) {
    super(opts);
    Object.assign(this, { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3-coder', dialect: 'ollama', apiKey: '' }, endpoint);
  }

  describe() {
    return { name: 'fxfake', label: 'fxfake', model: this.model, dialect: this.dialect };
  }
}

/**
 * A fake @appport/fx. `script(helpers)` returns the steps of one prompt: { text } or { tool, input }. Tools run through the
 * host's own `execute`, exactly as the real kernel calls them, and the turn ends early when cancelled.
 */
function fakeFx(script) {
  const log = { models: [], agents: [], prompts: [], closed: 0, envAtCall: [] };
  return {
    log,
    createFxModel: async (o) => { log.models.push(o); log.envAtCall.push(o.apiKeyEnv ? process.env[o.apiKeyEnv] : undefined); return { o }; },
    createFxAgent: async (opts) => {
      log.agents.push(opts);
      return {
        close: async () => { log.closed++; },
        prompt(input, { signal } = {}) {
          log.prompts.push(input);
          let cancelled = false;
          let finish;
          let fail;
          const result = new Promise((r, j) => { finish = r; fail = j; });
          return {
            result,
            cancel: () => { cancelled = true; },
            async *[Symbol.asyncIterator]() {
              for (const step of script({ prompt: input, round: log.prompts.length, tools: opts.tools })) {
                if (cancelled || signal?.aborted) break;
                if (step.throw) { fail(step.throw); return; }
                if (step.fail) { fail(Object.assign(new Error(`model request failed: ${step.fail}`), { code: 'LIBFX_MODEL_FAILED', kind: step.fail })); return; }
                if (step.text) yield { type: 'text_delta', delta: step.text };
                if (step.tool) {
                  yield { type: 'tool_start', id: 'x', name: step.tool, input: step.input };
                  const t = opts.tools.find((x) => x.name === step.tool);
                  step.out = await t.execute(step.input, { signal });
                  yield { type: 'tool_end', id: 'x', name: step.tool };
                }
              }
              finish({ stopReason: cancelled ? 'cancelled' : 'end_turn', usage: { inputTokens: 120, outputTokens: 30 } });
            },
          };
        },
      };
    },
  };
}

const makeEnv = ({ fx, provider, cfg = {} } = {}) => setup({ provider, cfg: { engineModules: fx ? { fx } : undefined, ...cfg } });
const planOneFile = () => plan([task('t', { verify: ['test -f src/hello.txt'] })], { finalVerify: [] });
const noTask = () => [done('builtin')];
const create = (factory, extra = {}) => factory.createRun({ idea: 'make a hello file', provider: 'fxfake', model: 'qwen3-coder', settings: { deploy: false }, ...extra });

test('the FX engine runs a task through the sandboxed tools, and verification still decides the outcome', async () => {
  const fx = fakeFx(() => [
    { text: 'Writing the file. ' },
    { tool: 'write_file', input: { path: 'src/hello.txt', content: 'hi\n' } },
    { tool: 'complete_task', input: { summary: 'made hello', files: [] } },
    { tool: 'run_command', input: { command: 'echo never reached' } }, // after complete_task the turn is over
  ]);
  const { store, factory } = makeEnv({ fx, provider: new EndpointProvider({ plan: planOneFile, task: noTask }) });
  const created = await create(factory, { engine: 'fx' });
  assert.equal(created.engine, 'fx');
  const run = await factory.start(created.id);
  assert.equal(run.plan.tasks[0].status, 'completed', run.error);
  assert.equal(run.layers.verification, 'done');
  assert.equal(fs.readFileSync(path.join(store.workspaceDir(run.id), 'src/hello.txt'), 'utf8'), 'hi\n');
  const t = run.plan.tasks[0];
  assert.equal(t.status, 'completed');
  assert.equal(t.result.summary, 'made hello');
  assert.deepEqual(t.result.files, ['src/hello.txt']);
  // The model handle points at the provider's endpoint; Ollama is reached through its OpenAI-compatible /v1 API.
  assert.deepEqual(fx.log.models[0], { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-coder' });
  assert.equal(fx.log.agents[0].maxSteps, run.settings.maxAgentTurns);
  assert.match(fx.log.agents[0].instructions, /LAYER 3|executing ONE task/);
  assert.match(fx.log.prompts[0], /# Task t:/);
  assert.deepEqual(fx.log.agents[0].tools.map((x) => x.name).sort(), ['complete_task', 'list_files', 'read_file', 'run_command', 'write_file']);
  assert.equal(fx.log.prompts.length, 1, 'the model finished with complete_task; no nudges');
  assert.equal(fx.log.closed >= 1, true, 'the agent is always closed');
  // Same events and token accounting as the built-in engine.
  const events = await store.events(run.id);
  assert.ok(events.some((e) => e.type === 'tool' && e.tool === 'write_file' && e.ok));
  assert.ok(!events.some((e) => e.type === 'tool' && e.tool === 'run_command'));
  assert.ok(events.some((e) => e.type === 'agent.message' && /Writing the file/.test(e.text)));
  assert.ok(run.usage.input >= 120 && run.usage.output >= 30);
  assert.match(fs.readFileSync(path.join(store.deliveryDir(run.id), 'FACTORY_REPORT.md'), 'utf8'), /Agent engine: fx/);
});

test('the built-in engine is the default, never touches FX, and a run keeps its engine', async () => {
  const fx = fakeFx(() => { throw new Error('FX must not run'); });
  const { factory } = makeEnv({ fx, provider: new EndpointProvider({ plan: planOneFile, task: ({ turn }) => (turn === 0 ? [{ type: 'tool_use', id: 'a', name: 'write_file', input: { path: 'src/hello.txt', content: 'x' } }] : [done('built-in did it')]) }) });
  const run = await factory.start((await create(factory)).id);
  assert.equal(run.engine, 'builtin');
  assert.equal(run.plan.tasks[0].status, 'completed', run.error);
  assert.equal(run.plan.tasks[0].result.summary, 'built-in did it');
  assert.equal(fx.log.models.length + fx.log.agents.length, 0);
  // Switching back is a per-run choice: the default can be changed without touching existing runs.
  const second = await create(factory, { engine: 'builtin' });
  assert.equal(second.engine, 'builtin');
});

test('sandbox rules are unchanged under FX: a path escape is refused and reported to the model, not performed', async () => {
  const outside = path.join(tmpDir(), 'evil.txt');
  const outcomes = [];
  const fx = fakeFx(() => [
    { tool: 'write_file', input: { path: outside, content: 'pwned' } },
    { tool: 'write_file', input: { path: '../evil.txt', content: 'pwned' } },
    { tool: 'complete_task', input: { summary: 'tried' } },
  ].map((s) => { outcomes.push(s); return s; }));
  const { factory } = makeEnv({ fx, provider: new EndpointProvider({ plan: () => plan([task('t')], { finalVerify: [] }), task: noTask }) });
  const run = await factory.start((await create(factory, { engine: 'fx' })).id);
  assert.equal(fs.existsSync(outside), false);
  assert.ok(outcomes.slice(0, 2).every((o) => /error/i.test(o.out)), JSON.stringify(outcomes.map((o) => o.out)));
  assert.equal(run.plan.tasks[0].status, 'completed');
});

test('credentials reach fx only as an environment variable name, are not visible to agent shells, and are removed afterwards', async () => {
  const SECRET = 'sk-test-engine-secret-123456';
  let seenByShell = null;
  const fx = fakeFx(() => [
    { tool: 'run_command', input: { command: 'env | grep -c DA_PROMPT_FX_KEY || true' } },
    { tool: 'complete_task', input: { summary: 'ok' } },
  ]);
  const { store, factory } = makeEnv({ fx, provider: new EndpointProvider({ plan: () => plan([task('t')], { finalVerify: [] }), task: noTask }, { dialect: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: SECRET }) });
  const before = Object.keys(process.env).filter((k) => k.startsWith('DA_PROMPT_FX_KEY'));
  const run = await factory.start((await create(factory, { engine: 'fx' })).id);
  assert.equal(run.plan.tasks[0].status, 'completed', run.error);
  const opts = fx.log.models[0];
  assert.equal(opts.baseUrl, 'https://api.example.com/v1');
  assert.match(opts.apiKeyEnv, /^DA_PROMPT_FX_KEY_/);
  assert.equal(JSON.stringify(opts).includes(SECRET), false, 'the key itself is never handed to fx');
  assert.equal(fx.log.envAtCall[0], SECRET, 'the variable holds the key while the model is in use');
  assert.deepEqual(Object.keys(process.env).filter((k) => k.startsWith('DA_PROMPT_FX_KEY')), before, 'and is gone afterwards');
  const shell = (await store.events(run.id)).find((e) => e.type === 'tool' && e.tool === 'run_command');
  assert.match(shell.output, /^0\b/, 'the agent\'s shell cannot see it');
  seenByShell = shell.output;
  assert.equal(JSON.stringify(await store.events(run.id)).includes(SECRET), false);
  assert.ok(seenByShell !== null);
});

test('a model that writes a tool call as plain text is retried with a note, and earlier work in the workspace is kept', async () => {
  const fx = fakeFx(({ round }) => (round === 1
    ? [{ tool: 'write_file', input: { path: 'src/hello.txt', content: 'hi\n' } }, { fail: 'malformed_tool_call' }]
    : [{ tool: 'list_files', input: {} }, { tool: 'complete_task', input: { summary: 'finished after a retry' } }]));
  const { store, factory } = makeEnv({ fx, provider: new EndpointProvider({ plan: planOneFile, task: noTask }) });
  const run = await factory.start((await create(factory, { engine: 'fx' })).id);
  assert.equal(run.plan.tasks[0].status, 'completed', run.error);
  assert.equal(run.plan.tasks[0].result.summary, 'finished after a retry');
  assert.equal(fx.log.prompts.length, 2);
  assert.doesNotMatch(fx.log.prompts[0], /previous reply/);
  assert.match(fx.log.prompts[1], /# Task t:[\s\S]*wrote a tool call as plain text[\s\S]*inspect it first/);
  assert.equal(fs.readFileSync(path.join(store.workspaceDir(run.id), 'src/hello.txt'), 'utf8'), 'hi\n');
  assert.ok((await store.events(run.id)).some((e) => e.type === 'agent.message' && /plain text \(retry 1 of 4\)/.test(e.text)));
});

test('retries are bounded, and other model failures are reported as they are', async () => {
  const always = fakeFx(() => [{ fail: 'malformed_tool_call' }]);
  const a = makeEnv({ fx: always, provider: new EndpointProvider({ plan: () => plan([task('t')], { finalVerify: [] }), task: noTask }) });
  const ra = await a.factory.start((await create(a.factory, { engine: 'fx', settings: { deploy: false, maxAttempts: 1 } })).id);
  assert.equal(always.log.prompts.length, 5, 'one try plus four retries, then it stops');
  assert.match(ra.plan.tasks[0].attempts[0].error, /FX model error \(malformed_tool_call\)/);
  const limited = fakeFx(() => [{ fail: 'rate_limited' }]);
  const b = makeEnv({ fx: limited, provider: new EndpointProvider({ plan: () => plan([task('t')], { finalVerify: [] }), task: noTask }) });
  const rb = await b.factory.start((await create(b.factory, { engine: 'fx', settings: { deploy: false, maxAttempts: 1 } })).id);
  assert.equal(limited.log.prompts.length, 1, 'a rate limit is not retried blindly');
  assert.match(rb.plan.tasks[0].attempts[0].error, /rate_limited/);
});

test('the configured output-token limit reaches the FX agent, and a first-response timeout is explained', async () => {
  const done = () => [{ tool: 'complete_task', input: { summary: 'x', files: [] } }];
  const dflt = fakeFx(done);
  const a = makeEnv({ fx: dflt, provider: new EndpointProvider({ plan: planOneFile, task: noTask }) });
  await a.factory.start((await create(a.factory, { engine: 'fx', settings: { deploy: false, maxAttempts: 1 } })).id);
  assert.equal(dflt.log.agents[0].maxOutputTokens, 8192, 'FACTORY_MAX_OUTPUT_TOKENS default');
  const custom = fakeFx(done);
  const b = makeEnv({ fx: custom, cfg: { maxOutputTokens: 3000 }, provider: new EndpointProvider({ plan: planOneFile, task: noTask }) });
  await b.factory.start((await create(b.factory, { engine: 'fx', settings: { deploy: false, maxAttempts: 1 } })).id);
  assert.equal(custom.log.agents[0].maxOutputTokens, 3000);
  assert.equal(custom.log.agents[0].maxSteps, 40, 'the turn limit is still passed as before');

  const slow = fakeFx(() => [{ throw: Object.assign(new Error('model call timed out'), { code: 'LIBFX_MODEL_TIMEOUT' }) }]);
  const c = makeEnv({ fx: slow, provider: new EndpointProvider({ plan: planOneFile, task: noTask }) });
  const rc = await c.factory.start((await create(c.factory, { engine: 'fx', settings: { deploy: false, maxAttempts: 1 } })).id);
  const err = rc.plan.tasks[0].attempts[0].error;
  assert.match(err, /LIBFX_MODEL_TIMEOUT/);
  assert.match(err, /about 120 seconds/);
  assert.match(err, /--engine builtin/);
  assert.equal(slow.log.prompts.length, 1, 'a timeout is not retried blindly inside the attempt');
  assert.notEqual(rc.status, 'completed');
});

test('an agent that never calls complete_task is nudged, then the attempt fails with the usual message', async () => {
  const fx = fakeFx(({ round }) => [{ text: `still thinking ${round}` }]);
  const { factory } = makeEnv({ fx, provider: new EndpointProvider({ plan: () => plan([task('t')], { finalVerify: [] }), task: noTask }), cfg: { defaults: { maxAttempts: 1 } } });
  const created = await create(factory, { engine: 'fx', settings: { deploy: false, maxAttempts: 1 } });
  const run = await factory.start(created.id);
  assert.equal(fx.log.prompts.length, 3, 'one brief and two nudges per attempt');
  assert.match(fx.log.prompts[1], /call complete_task/);
  const a = run.plan.tasks[0].attempts[0];
  assert.equal(a.ok, false);
  assert.match(a.error, /did not finish/);
  assert.notEqual(run.status, 'completed');
});

test('an engine is checked before the run starts, with a reason you can act on', async () => {
  const provider = new EndpointProvider({ plan: planOneFile, task: noTask });
  const missing = makeEnv({ provider }); // no fx module and nothing installed under the data dir
  await assert.rejects(create(missing.factory, { engine: 'fx' }), /not installed.*npm run engine:install -- fx/);
  const fx = fakeFx(() => []);
  const ok = makeEnv({ fx, provider });
  await assert.rejects(create(ok.factory, { engine: 'chip' }), /unknown agent engine "chip"/);
  await assert.rejects(ok.factory.createRun({ idea: 'x', provider: 'offline', engine: 'fx' }), /offline demo agents/);
  const anthropicLike = makeEnv({ fx, provider: Object.assign(new EndpointProvider({ plan: planOneFile, task: noTask }), { describe: () => ({ dialect: 'anthropic' }) }) });
  await assert.rejects(create(anthropicLike.factory, { engine: 'fx' }), /not the Anthropic API/);
  assert.throws(() => fxEndpoint({ model: 'm', describe: () => ({}) }), /needs a provider with a base URL/);
  // Nothing was created for any of the refusals.
  assert.deepEqual(await missing.store.list(), []);
});

test('the default engine can be set, and /api/engines says what is usable and why not', async () => {
  const fx = fakeFx(() => []);
  const app = await createServer({ dataDir: tmpDir(), defaultProvider: 'offline', defaultEngine: 'fx', engineModules: { fx }, providerFactory: () => new OfflineProvider({ faults: false, delayMs: 0 }) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const j = await (await fetch(`${base}/api/engines`)).json();
    assert.equal(j.default, 'fx');
    assert.deepEqual(j.engines.map((e) => [e.id, e.available, e.experimental]), [['builtin', true, false], ['fx', true, true]]);
    const none = await engineStatus({ dataDir: tmpDir() });
    assert.equal(none.find((e) => e.id === 'fx').available, false);
    assert.match(none.find((e) => e.id === 'fx').reason, /npm run engine:install -- fx/);
    assert.equal(none.find((e) => e.id === 'builtin').default, true);
    // The saved setting maps to the field the runtime reads.
    const s = await (await fetch(`${base}/api/settings`)).json();
    assert.ok(s.settings.some((x) => x.key === 'defaultEngine' && x.group === 'models'));
  } finally {
    await app.close();
  }
});

test('loose completion fields (a string where a list was asked for) are accepted by every engine, not a crash', async () => {
  const loose = { summary: 'ok', nextSteps: 'run npm test', files: 'a.txt', commands: null };
  const fx = fakeFx(() => [{ tool: 'complete_task', input: loose }]);
  const a = makeEnv({ fx, provider: new EndpointProvider({ plan: () => plan([task('t')], { finalVerify: [] }), task: noTask }) });
  const ra = await a.factory.start((await create(a.factory, { engine: 'fx' })).id);
  assert.equal(ra.plan.tasks[0].status, 'completed', ra.error);
  assert.deepEqual(ra.plan.tasks[0].result.nextSteps, ['run npm test']);
  assert.deepEqual(ra.plan.tasks[0].result.files, ['a.txt']);
  assert.deepEqual(ra.plan.tasks[0].result.commands, []);
  const b = makeEnv({ provider: new EndpointProvider({ plan: () => plan([task('t')], { finalVerify: [] }), task: () => [toolUse('complete_task', loose)] }) });
  const rb = await b.factory.start((await create(b.factory)).id);
  assert.equal(rb.plan.tasks[0].status, 'completed', rb.error);
  assert.deepEqual(rb.plan.tasks[0].result.nextSteps, ['run npm test']);
});
