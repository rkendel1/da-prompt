// Edit a stopped (or interrupted) run: pick another provider/model/engine, change limits or the request, add a note to the
// agents, and carry on from where it stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { RunStore } from '../src/store.js';
import { Factory } from '../src/factory.js';
import { Scripted, task, plan, done, toolUse } from './project-helpers.js';
import { tmpDir, waitFor } from './helpers.js';

const onePlan = () => plan([task('t', { verify: [] })], { finalVerify: [] });
class Bad extends Scripted {
  async chat(req) {
    if (req.meta?.kind === 'plan') throw new Error('Anthropic API (claude-sonnet-5-5): HTTP 400: tool_choice: type "tool" and "any" are not supported for this model');
    return super.chat(req);
  }
}
class Hold extends Scripted {
  constructor(o) { super(o); this.hold = null; this.started = 0; }
  async chat(req) {
    if (req.meta?.kind === 'task' && this.hold) {
      this.started++;
      await new Promise((resolve, reject) => { this.hold.then(resolve); req.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
    }
    return super.chat(req);
  }
}
const make = (providers) => {
  const cfg = loadConfig({ dataDir: tmpDir(), providerFactory: (id) => providers[id] || providers.good });
  const store = new RunStore(cfg.dataDir);
  const factory = new Factory({ cfg, store, previews: { get: () => null, stop: () => {}, stopAll: () => {}, start: async () => ({ ok: false }) } });
  return { cfg, store, factory };
};
const create = (factory, extra = {}) => factory.createRun({ idea: 'make a thing', provider: 'bad', model: 'm1', settings: { deploy: false, maxAttempts: 1 }, ...extra });
const good = () => new Scripted({ plan: onePlan, task: ({ turn }) => (turn === 0 ? [toolUse('write_file', { path: 'a.txt', content: 'a' })] : [done('ok', ['a.txt'])]) });

test('a run that failed on its provider can be switched to another and resumed from the plan', async () => {
  const goodProv = good();
  const { store, factory } = make({ bad: new Bad({ plan: onePlan, task: () => [done('x')] }), good: goodProv });
  const run = await factory.start((await create(factory)).id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /tool_choice/);
  assert.equal(run.plan, null);

  const fixed = await factory.updateRun(run.id, { provider: 'good', model: 'm2', resume: true });
  assert.equal(fixed.provider, 'good');
  assert.equal(fixed.model, 'm2');
  assert.equal(fixed.plannerProvider, 'good', 'a planner that followed the agents follows them to the new provider');
  assert.equal(fixed.error, undefined);
  await waitFor(() => !factory.isActive(run.id), { timeoutMs: 30_000 });
  const done1 = await store.load(run.id);
  assert.equal(done1.plan.tasks[0].status, 'completed', done1.error);
  assert.ok((await store.events(run.id)).some((e) => e.type === 'run.updated' && e.fields.includes('provider') && e.provider === 'good'));
});

test('limits, the request text and a note to the agents change what the next attempt sees', async () => {
  const prov = good();
  const { factory } = make({ bad: new Bad({ plan: onePlan, task: () => [done('x')] }), good: prov });
  const run = await factory.start((await create(factory)).id);
  const upd = await factory.updateRun(run.id, {
    provider: 'good', model: 'm2',
    settings: { tokenBudget: 777_000, maxAttempts: 4, maxParallel: 99, timeoutMinutes: 'abc' },
    inputs: { idea: 'make a thing, but in TypeScript', requirements: 'strict mode' },
    note: 'Use TypeScript strict mode. token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  });
  assert.equal(upd.settings.tokenBudget, 777_000);
  assert.equal(upd.settings.maxAttempts, 4);
  assert.equal(upd.settings.maxParallel, 8, 'clamped');
  assert.equal(upd.settings.timeoutMinutes, 120, 'a nonsense value keeps the old one');
  assert.equal(upd.title, 'make a thing, but in TypeScript', 'the title follows the request while there is no plan yet');
  assert.equal(upd.guidance.length, 1);
  assert.ok(!upd.guidance[0].text.includes('ghp_abcdefghij'), 'secrets are redacted');
  await factory.resume(run.id);
  await waitFor(() => !factory.isActive(run.id), { timeoutMs: 30_000 });
  const planPrompt = prov.seen.find((x) => x.kind === 'plan').system;
  const taskPrompt = prov.seen.find((x) => x.kind === 'task').system;
  for (const p of [planPrompt, taskPrompt]) {
    assert.match(p, /<updates>[\s\S]*Use TypeScript strict mode\.[\s\S]*<\/updates>/);
    assert.match(p, /but in TypeScript/);
  }
});

test('an executing run is refused unless you interrupt it; interrupting stops it, applies the change and resumes', async () => {
  const prov = new Hold({ plan: onePlan, task: ({ turn }) => (turn === 0 ? [toolUse('write_file', { path: 'a.txt', content: 'a' })] : [done('ok', ['a.txt'])]) });
  let release;
  prov.hold = new Promise((r) => { release = r; });
  const { store, factory } = make({ good: prov });
  const created = await factory.createRun({ idea: 'make a thing', provider: 'good', model: 'm1', settings: { deploy: false, maxAttempts: 2 } });
  factory.start(created.id);
  await waitFor(() => prov.started > 0, { timeoutMs: 20_000 });
  await assert.rejects(factory.updateRun(created.id, { note: 'x' }), /still executing; interrupt it first/);

  prov.hold = null; // from now on the model answers straight away
  release();
  const r = await factory.updateRun(created.id, { interrupt: true, note: 'Name the file a.txt', settings: { maxAttempts: 3 }, resume: true });
  assert.equal(r.settings.maxAttempts, 3);
  await waitFor(async () => (await store.load(created.id)).plan?.tasks.every((t) => t.status === 'completed'), { timeoutMs: 30_000 });
  const final = await store.load(created.id);
  assert.equal(final.guidance[0].text, 'Name the file a.txt');
  const types = (await store.events(created.id)).map((e) => e.type);
  assert.ok(types.includes('run.updated'));
});

test('only stopped runs can be edited, and an edit must change something valid', async () => {
  const { factory } = make({ good: good() });
  const run = await factory.start((await factory.createRun({ idea: 'make a thing', provider: 'good', model: 'm', settings: { deploy: false } })).id);
  await waitFor(() => !factory.isActive(run.id));
  const finished = await factory.store.load(run.id);
  finished.status = 'completed';
  await factory.store.save(finished);
  await assert.rejects(factory.updateRun(run.id, { note: 'late' }), /completed run cannot be edited/);
  finished.status = 'failed';
  await factory.store.save(finished);
  await assert.rejects(factory.updateRun(run.id, {}), /nothing to change/);
  await assert.rejects(factory.updateRun(run.id, { engine: 'chip' }), /unknown agent engine/);
  await assert.rejects(factory.updateRun(run.id, { inputs: { idea: '' } }), /idea is required/);
});

test('PATCH /api/runs/:id over HTTP, with the same rules', async () => {
  const { cfg, factory, store } = make({ bad: new Bad({ plan: onePlan, task: () => [done('x')] }), good: good() });
  const app = await createServer({ dataDir: cfg.dataDir, defaultProvider: 'offline', providerFactory: cfg.providerFactory });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    const created = await call('POST', '/api/runs', { idea: 'make a thing', provider: 'bad', model: 'm1', settings: { deploy: false, maxAttempts: 1 } });
    const id = created.body.run.id;
    await waitFor(async () => (await call('GET', `/api/runs/${id}`)).body.run.status === 'failed', { timeoutMs: 30_000 });
    assert.equal((await call('PATCH', `/api/runs/${id}`, {})).status, 400);
    const ok = await call('PATCH', `/api/runs/${id}`, { provider: 'good', model: 'm2', note: 'be brief', resume: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.run.provider, 'good');
    await waitFor(async () => (await call('GET', `/api/runs/${id}`)).body.run.plan?.tasks?.every((t) => t.status === 'completed'), { timeoutMs: 30_000 });
    assert.equal((await call('PATCH', '/api/runs/20200101000000-abcdef', { note: 'x' })).status, 404);
  } finally {
    await app.close();
  }
  assert.ok(store && factory);
});
