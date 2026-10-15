// Model routing (a model per role, a retry model), plan repair and the standard plan, the new-app workspace seed, and the
// per-model results (src/performance.js). Everything runs through the real factory with the offline agents; only which
// provider instance answers is injected.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, waitFor } from './helpers.js';
import { blockNetwork } from './offline-guard.js';
import { loadConfig } from '../src/config.js';
import { RunStore } from '../src/store.js';
import { Factory } from '../src/factory.js';
import { PreviewManager } from '../src/deploy.js';
import { createServer } from '../src/server.js';
import { OfflineProvider } from '../src/providers/offline.js';
import { repairPlan, repairCommand, normalizePlan, standardPlan } from '../src/agents.js';
import { validatePlan } from '../src/graph.js';
import { runModelPerformance, aggregatePerformance } from '../src/performance.js';
import { readRecords } from '../src/diagnostics.js';

blockNetwork();
const previews = new PreviewManager({ max: 3 });
after(() => previews.stopAll());

/** An offline agent that answers as provider `id` / model `model`, and logs which task each call was for. */
class Tagged extends OfflineProvider {
  constructor(id, model, log, opts = {}) {
    super({ faults: 'on', delayMs: 0, ...opts });
    Object.assign(this, { name: id, model, log });
  }
  describe() {
    return { name: this.name, label: this.name, model: this.model, plannerModel: this.model };
  }
  async chat(req) {
    this.log.push({ provider: this.name, model: this.model, kind: req.meta?.kind, task: req.meta?.task?.id, attempt: req.meta?.attempt });
    return super.chat(req);
  }
}

function setup(make) {
  const log = [];
  const cfg = loadConfig({ dataDir: tmpDir(), providerFactory: (id, _cfg, run) => (make ? make(id, run, log) : new Tagged(id, run.model, log)) });
  const store = new RunStore(cfg.dataDir);
  return { cfg, store, log, factory: new Factory({ cfg, store, previews }) };
}

test('each role runs on its own model, retries move to the retry model, and every attempt records the model that made it', async () => {
  const { factory, store, log } = setup();
  const created = await factory.createRun({
    idea: 'A packing checklist for trips',
    provider: 'main', model: 'small-coder',
    roles: { design: { provider: 'big', model: 'big-coder' }, product: { provider: 'main', model: 'small-coder' } }, // the second is no override
    retryModel: { provider: 'big', model: 'retry-coder' },
    settings: { deploy: false },
  });
  assert.deepEqual(Object.keys(created.roleModels), ['design'], 'an entry equal to the agent model is not an override');
  assert.equal(created.retryModel.model, 'retry-coder');
  const run = await factory.start(created.id);
  assert.equal(run.status, 'completed', run.error);

  const ui = run.plan.tasks.find((t) => t.role === 'design');
  assert.deepEqual(ui.attempts.map((a) => [a.model.provider, a.model.model, a.model.via]), [['big', 'big-coder', 'role']]);
  // The offline engineer fails its first attempt on purpose (faults: 'on'); the second attempt is the retry model's.
  const core = run.plan.tasks.find((t) => t.id === 'core');
  assert.deepEqual(core.attempts.map((a) => [a.model.model, a.model.via, a.ok]), [['small-coder', 'default', false], ['retry-coder', 'retry', true]]);
  // The calls really went to those providers: the role and retry models answered exactly their attempts.
  assert.ok(log.filter((c) => c.task === ui.id).every((c) => c.model === 'big-coder'));
  assert.ok(log.filter((c) => c.task === 'core' && c.attempt === 2).every((c) => c.model === 'retry-coder'));
  assert.ok(log.filter((c) => c.task === 'core' && c.attempt === 1).every((c) => c.model === 'small-coder'));
  assert.ok(log.some((c) => c.kind === 'plan' && c.model === 'small-coder'), 'the planner follows the agent model by default');

  // The run's model results: who did what and how it went, joined with the diagnostics' calls.
  const perf = runModelPerformance(run, readRecords(store.runDir(run.id)));
  const by = (m) => perf.models.find((x) => x.model === m);
  assert.deepEqual(Object.keys(by('big-coder').stages), ['design']);
  assert.deepEqual(by('big-coder').stages.design, { tasks: 1, verified: 1, escalated: 0, attempts: 1, attemptsVerified: 1, firstTry: 1, firstTryVerified: 1, attemptMs: by('big-coder').stages.design.attemptMs, finishedAttempts: 1 });
  assert.equal(by('retry-coder').stages.engineer.verified, 1, 'the verified task goes to the model that made the last attempt');
  assert.equal(by('small-coder').stages.engineer.verified, 0);
  assert.equal(by('small-coder').stages.engineer.firstTry, 1);
  assert.equal(by('small-coder').plan.outcome, 'planned');
  assert.equal(by('small-coder').plan.attempts, 1);
  assert.ok(by('big-coder').calls.count > 0 && by('retry-coder').calls.count > 0, 'diagnostics calls are attributed per model');
  assert.ok(perf.tasks.find((t) => t.id === 'core').attempts[1].via === 'retry');

  const events = await store.events(run.id);
  assert.ok(events.some((e) => e.type === 'task' && e.taskId === 'core' && e.attempt === 2 && e.via === 'retry' && /retry-coder/.test(e.model)));
  assert.deepEqual(events.find((e) => e.type === 'run.created').roleModels, { design: 'big · big-coder' });
});

test('routing is validated like the agent model, and Edit run can change or clear it', async () => {
  const { factory } = setup();
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'main', model: 'a', roles: { wizard: { provider: 'big', model: 'b' } } }), /unknown role "wizard"/);
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'main', model: 'a', roles: { qa: { provider: 'offline' } } }), /offline agents cannot be combined/);
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'main', model: 'a', retryModel: { provider: 'offline' } }), /retry model/);

  const run = await factory.createRun({ idea: 'A packing checklist', provider: 'main', model: 'a', roles: { qa: { provider: 'big', model: 'b' } }, retryModel: { provider: 'big', model: 'r' } });
  let edited = await factory.updateRun(run.id, { roles: { engineer: { provider: 'big', model: 'e' } } });
  assert.deepEqual(Object.keys(edited.roleModels), ['engineer'], 'roles replace the earlier routing');
  assert.equal(edited.retryModel.model, 'r', 'the retry model is kept unless given');
  edited = await factory.updateRun(run.id, { retryModel: null });
  assert.equal(edited.retryModel, null);
  assert.equal(edited.roleModels.engineer.model, 'e');
  // A rerun keeps the routing.
  const again = await factory.rerun(run.id);
  assert.equal(again.roleModels.engineer.model, 'e');
});

test('plan repair: the defects seen in real local-model plans become runnable checks, and nothing legitimate is touched', () => {
  // Shapes taken from qwen2.5-coder:7b plans that escalated or failed before any work.
  const plan = normalizePlan({
    product: { name: 'Reading list', summary: 'Books for clubs', users: ['members'], successCriteria: ['works'] },
    tasks: [
      { id: 'product', role: 'product', title: 'PRD', description: 'd', dependsOn: [], acceptance: ['a'], verify: ['write_file PRD.md'] },
      { id: 'api', role: 'engineer', title: 'API', description: 'd', dependsOn: ['product'], acceptance: ['a'], verify: ['run_command npm test', 'run_command'] },
      { id: 'ui', role: 'design', title: 'UI', description: 'd', dependsOn: ['product'], acceptance: ['a'], outputs: ['public/index.html', 'public/images/hero.png'], verify: ['ls public/images/hero.png', 'test -s public/index.html'] },
      { id: 'devops', role: 'devops', title: 'Docker', description: 'd', dependsOn: ['api'], acceptance: ['a'], verify: ['docker build -t app . && docker run -p 3000:3000 app && curl -I localhost:3000'] },
      { id: 'finalVerify', role: 'qa', title: 'Final Verification', description: 'd', dependsOn: ['api', 'ui', 'devops'], acceptance: ['a'], verify: ['npm test && npm start'] },
      { id: 'readme', role: 'product', title: 'README', description: 'd', dependsOn: ['finalVerify'], acceptance: ['a'], verify: ['test -s README.md'] },
    ],
    finalVerify: ['docker run -p 3000:3000 app'],
    deploy: { start: 'docker run -p 3000:3000 app', healthPath: '/health' },
  });
  const { plan: fixed, repairs } = repairPlan(plan);
  assert.deepEqual(validatePlan(fixed), []);
  const t = Object.fromEntries(fixed.tasks.map((x) => [x.id, x]));
  assert.deepEqual(t.product.verify, ['test -s PRD.md']);
  assert.deepEqual(t.api.verify, ['npm test']);
  assert.deepEqual(t.ui.outputs, ['public/index.html']);
  assert.deepEqual(t.ui.verify, ['test -s public/index.html']);
  assert.deepEqual(t.devops.verify, ['docker build -t app .'], 'the foreground server and the curl that needs it are cut; the build is kept');
  assert.equal(t.finalVerify, undefined, 'the pseudo-task is gone');
  assert.deepEqual(t.readme.dependsOn.sort(), ['api', 'devops', 'ui'], 'its dependents wait for what it waited for');
  assert.deepEqual(fixed.finalVerify, ['npm test']);
  assert.deepEqual(fixed.deploy, { start: 'npm start', healthPath: '/health' });
  assert.ok(repairs.length >= 7, repairs.join('\n'));

  // Untouched: backgrounded servers, test files run with node, real commands; and existing projects keep their own deploy.
  for (const c of ['npm start & sleep 2 && curl -sf localhost:3000', 'node test/app.test.js', 'npm test -- --grep api', 'test -s Dockerfile && grep -q HEALTHCHECK Dockerfile']) assert.deepEqual(repairCommand(c), { cmd: c });
  // A request to a server nobody started can only fail; one after a backgrounded start is kept (above).
  assert.equal(repairCommand("curl http://localhost:3000/health | grep -q '200 OK'").cmd, null);
  assert.equal(repairCommand('npm test && curl -sf 127.0.0.1:3000/api/items').cmd, 'npm test');
  assert.equal(repairCommand('curl -sf https://registry.npmjs.org/').cmd, 'curl -sf https://registry.npmjs.org/');
  const existing = repairPlan({ ...fixed, finalVerify: [], deploy: null }, { existing: true });
  assert.deepEqual(existing.plan.finalVerify, []);
  assert.equal(existing.plan.deploy, null);
  // The standard plan passes its own validation.
  assert.deepEqual(validatePlan(standardPlan({ inputs: { idea: 'A tool to track equipment loans' } })), []);
});

test('a planner that never produces a valid plan: the run continues on the standard plan (visibly), or stops when that is off', async () => {
  class NoPlan extends OfflineProvider {
    async chat(req) {
      if (req.meta?.kind === 'plan') return { content: [{ type: 'text', text: 'Here is my plan: build it.' }], stop_reason: 'end_turn', usage: {} };
      return super.chat(req);
    }
  }
  const { factory, store } = setup((id, run, log) => (id === 'weak' ? new NoPlan({ faults: false, delayMs: 0 }) : new Tagged(id, run.model, log, { faults: false })));
  const created = await factory.createRun({ idea: 'A tool to track equipment loans', provider: 'main', model: 'm', planner: { provider: 'weak', model: 'tiny' }, settings: { deploy: false, maxAttempts: 1 } });
  const run = await factory.start(created.id);
  assert.equal(run.planning.source, 'standard');
  assert.equal(run.planning.attempts, 3);
  assert.equal(run.planning.rejections.length, 3);
  assert.match(run.planning.error, /could not produce a valid plan/);
  assert.deepEqual(run.plan.tasks.map((t) => t.id), ['prd', 'app', 'ui', 'qa', 'devops', 'readme']);
  // The agents worked on the standard plan (the offline agents have templates for some of its tasks, such as the PRD).
  assert.equal(run.plan.tasks.find((t) => t.id === 'prd').status, 'completed');
  const planEvent = (await store.events(run.id)).find((e) => e.type === 'plan');
  assert.equal(planEvent.source, 'standard');
  const perf = runModelPerformance(run);
  assert.equal(perf.models.find((m) => m.model === 'tiny').plan.outcome, 'standard');

  const strict = await factory.createRun({ idea: 'A tool to track equipment loans', provider: 'main', model: 'm', planner: { provider: 'weak', model: 'tiny' }, settings: { standardPlanOnFailure: false } });
  const stopped = await factory.start(strict.id);
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.plan, null);
  assert.match(stopped.planning.error, /could not produce a valid plan/);
  assert.equal(runModelPerformance(stopped).models[0].plan.outcome, 'failed');
});

test('a new app\'s workspace has its own package.json before any agent runs, so npm never finds a project above it', async () => {
  // The data folder sits inside another npm project (as it does in a default install, inside this repository).
  const parent = tmpDir();
  fs.writeFileSync(path.join(parent, 'package.json'), JSON.stringify({ name: 'outer', scripts: { test: 'echo OUTER-SUITE-RAN' } }));
  const log = [];
  const cfg = loadConfig({ dataDir: path.join(parent, 'data'), providerFactory: () => new Tagged('main', 'm', log) });
  const store = new RunStore(cfg.dataDir);
  const factory = new Factory({ cfg, store, previews });
  const created = await factory.createRun({ idea: 'x', provider: 'main', model: 'm', settings: { standardPlanOnFailure: false } });
  // Stop at planning: the seed is written before the planner is asked anything.
  factory.makePlannerProvider = () => ({ describe: () => ({ name: 'p', model: 'p' }), chat: async () => { throw Object.assign(new Error('planner down'), { code: 'connection' }); } });
  await factory.start(created.id);
  const ws = store.workspaceDir(created.id);
  assert.ok(fs.existsSync(path.join(ws, 'package.json')));
  assert.equal(execFileSync('npm', ['prefix'], { cwd: ws, encoding: 'utf8' }).trim(), fs.realpathSync(ws));
  let out = '';
  try {
    out = execFileSync('npm', ['test'], { cwd: ws, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    out = `${e.stdout}${e.stderr}`;
  }
  assert.doesNotMatch(out, /OUTER-SUITE-RAN/);
});

test('HTTP: a run\'s model results and the track record across runs', async () => {
  const app = await createServer({ dataDir: tmpDir(), providerFactory: (id, _cfg, run) => new Tagged(id, run.model, []) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const res = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idea: 'A packing checklist', provider: 'main', model: 'small', roles: { qa: { provider: 'big', model: 'large' } }, settings: { deploy: false } }) });
    assert.equal(res.status, 201, await res.clone().text());
    const { run } = await res.json();
    await waitFor(async () => {
      const r = (await (await fetch(`${base}/api/runs/${run.id}`)).json()).run;
      return !r.executing && ['completed', 'needs_attention', 'failed'].includes(r.status) ? r : null;
    });
    const { performance } = await (await fetch(`${base}/api/runs/${run.id}/models`)).json();
    assert.equal(performance.routing.roles.qa.model, 'large');
    assert.equal(performance.models.find((m) => m.model === 'large').stages.qa.verified, 1);
    assert.ok(performance.callsRecorded);

    const track = await (await fetch(`${base}/api/models/performance`)).json();
    assert.equal(track.runs, 1);
    const small = track.models.find((m) => m.model === 'small');
    assert.equal(small.plans.planned, 1);
    assert.ok(small.stages.engineer.tasks >= 1);
    assert.equal(track.models.find((m) => m.model === 'large').stages.qa.tasks, 1);
  } finally {
    await app.close();
  }
});

test('the track record attributes attempts from before attempts recorded their model to the run\'s agent model, and counts them', () => {
  const old = { id: 'r1', status: 'completed', provider: 'ollama', providerLabel: 'Ollama', model: 'q', plannerModel: 'q', plan: { tasks: [{ id: 'a', role: 'engineer', status: 'completed', attempts: [{ n: 1, ok: true, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z' }] }] } };
  const agg = aggregatePerformance([old, { id: 'broken' }]);
  const q = agg.models.find((m) => m.model === 'q');
  assert.equal(q.inferred, 1);
  assert.equal(q.stages.engineer.verified, 1);
  assert.equal(q.stages.engineer.attemptMs, 60_000);
  assert.equal(q.plans.planned, 1);
});
