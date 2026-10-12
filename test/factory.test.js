import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpDir } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { RunStore } from '../src/store.js';
import { Factory } from '../src/factory.js';
import { PreviewManager } from '../src/deploy.js';
import { OfflineProvider, buildPlan } from '../src/providers/offline.js';

const previews = new PreviewManager({ max: 3 });
after(() => previews.stopAll());

function setup(providerFactory) {
  const cfg = loadConfig({ dataDir: tmpDir(), providerFactory });
  const store = new RunStore(cfg.dataDir);
  return { cfg, store, factory: new Factory({ cfg, store, previews }) };
}

test('an offline run goes through all seven layers and delivers a working, deployed app', async () => {
  const { store, factory } = setup();
  const created = await factory.createRun({ idea: 'A packing checklist for trips', provider: 'offline' });
  const run = await factory.start(created.id);

  assert.equal(run.status, 'completed', run.error);
  assert.ok(Object.values(run.layers).every((s) => s === 'done'), JSON.stringify(run.layers));
  assert.equal(run.plan.tasks.length, 6);
  assert.ok(run.plan.tasks.every((t) => t.status === 'completed'));
  assert.ok(run.checklist.every((c) => c.ok), JSON.stringify(run.checklist));

  // Layer 6: the injected fault was caught by verification, fixed on retry, and recorded.
  const core = run.plan.tasks.find((t) => t.id === 'core');
  assert.equal(core.attempts.length, 2);
  assert.equal(core.attempts[0].ok, false);
  assert.match(core.attempts[0].feedback, /SyntaxError/);
  assert.equal(run.lessons.length, 1);
  const ws = store.workspaceDir(run.id);
  assert.match(fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8'), /## Lessons\n- .*core \(engineer\)/);

  // Parallelism: core and ui ran at the same level.
  assert.equal(run.plan.tasks.find((t) => t.id === 'ui').level, core.level);

  // Delivery artifacts.
  for (const f of ['FACTORY_REPORT.md', 'test-results.json', 'project.tar.gz']) assert.ok(fs.existsSync(path.join(store.deliveryDir(run.id), f)), f);
  assert.ok(run.finalVerification.every((v) => v.ok));

  // Deployment is live and serves the generated app.
  assert.equal(run.deployment.ok, true);
  const p = previews.get(run.id);
  const res = await fetch(`http://127.0.0.1:${p.port}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Passport' }) });
  assert.equal(res.status, 201);

  // Record of work.
  const types = new Set((await store.events(run.id)).map((e) => e.type));
  for (const t of ['plan', 'task', 'tool', 'verify', 'feedback', 'lesson', 'checklist', 'deploy', 'deliver']) assert.ok(types.has(t), t);
  previews.stop(run.id);
});

test('a task that keeps failing escalates, blocks dependents, and can be fixed and resumed', async () => {
  class BrokenDeploy extends OfflineProvider {
    async chat(req) {
      const res = await super.chat(req);
      if (req.meta?.kind === 'plan') {
        const plan = res.content[0].input;
        plan.tasks.find((t) => t.id === 'deploy').verify = ['echo "Error: registry unreachable" >&2; exit 3'];
      }
      return res;
    }
  }
  const { factory } = setup(() => new BrokenDeploy({ faults: false }));
  const created = await factory.createRun({ idea: 'An equipment loan tracker', provider: 'offline', settings: { deploy: false } });
  let run = await factory.start(created.id);

  assert.equal(run.status, 'needs_attention');
  const deploy = run.plan.tasks.find((t) => t.id === 'deploy');
  assert.equal(deploy.status, 'escalated');
  assert.equal(deploy.attempts.length, 3);
  assert.match(deploy.escalation.reason, /registry unreachable/);
  assert.deepEqual(deploy.escalation.options.map((o) => o.id), ['retry', 'edit', 'skip']);
  assert.equal(run.plan.tasks.find((t) => t.id === 'docs').status, 'blocked');
  assert.equal(run.plan.tasks.find((t) => t.id === 'tests').status, 'completed');
  assert.equal(run.checklist.find((c) => c.id === 'tests').ok, false);
  assert.ok(run.lessons.some((l) => /still failing/.test(l.text)));

  // Escalation option "edit": fix the verify command and retry.
  await factory.retryTask(run.id, 'deploy', { verify: ['test -s Dockerfile'] });
  run = await factory.active.get(run.id).promise;
  assert.equal(run.status, 'completed', JSON.stringify(run.checklist));
  assert.equal(run.plan.tasks.find((t) => t.id === 'docs').status, 'completed');
});

test('the token budget stops a run cleanly', async () => {
  const { factory } = setup();
  const created = await factory.createRun({ idea: 'A tiny app', provider: 'offline', settings: { tokenBudget: 10_000 } });
  const run = await factory.start(created.id);
  assert.equal(run.status, 'needs_attention');
  assert.match(run.error, /token budget/);
});

test('cancel stops an in-flight run', async () => {
  const { factory } = setup(() => new OfflineProvider({ faults: false, delayMs: 200 }));
  const created = await factory.createRun({ idea: 'A slow app', provider: 'offline' });
  const p = factory.start(created.id);
  await new Promise((r) => setTimeout(r, 300));
  await factory.cancel(created.id);
  const run = await p;
  assert.equal(run.status, 'cancelled');
});

test('createRun validates inputs', async () => {
  const { factory } = setup();
  await assert.rejects(factory.createRun({}), /idea is required/);
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'nope' }), /unknown provider/);
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'anthropic' }), /ANTHROPIC_API_KEY/);
  await assert.rejects(factory.createRun({ idea: 'x', repoUrl: 'git@github.com:a/b.git' }), /https/);
  assert.ok(buildPlan({ idea: 'x' }).finalVerify.length > 0);
});

test('persistent faults escalate the engineer task; "retry" from the escalation fixes it', async () => {
  const { factory } = setup(() => new OfflineProvider({ faults: 'persistent' }));
  const created = await factory.createRun({ idea: 'A recipe box', provider: 'offline', settings: { deploy: false } });
  let run = await factory.start(created.id);
  assert.equal(run.plan.tasks.find((t) => t.id === 'core').status, 'escalated');
  assert.deepEqual(run.plan.tasks.filter((t) => t.status === 'blocked').map((t) => t.id).sort(), ['deploy', 'docs', 'tests']);
  await factory.retryTask(run.id, 'core');
  run = await factory.active.get(run.id).promise;
  assert.equal(run.status, 'completed');
  assert.equal(run.plan.tasks.find((t) => t.id === 'core').attempts.length, 4);
  assert.ok(run.lessons.some((l) => /fixed on attempt 4/.test(l.text)));
});

test('the finished project is delivered to the requested folder, and unsafe folders are refused', async () => {
  const { cfg, factory } = setup();
  const out = path.join(tmpDir(), 'my-app');
  const created = await factory.createRun({ idea: 'A bookmark manager', provider: 'offline', outputDir: out, settings: { deploy: false } });
  assert.equal(created.outputDir, out);
  const run = await factory.start(created.id);
  assert.equal(run.status, 'completed', run.error);
  assert.deepEqual(run.delivery.output, { ok: true, dir: out });
  for (const f of ['package.json', 'src/app.js', 'FACTORY_REPORT.md', 'CLAUDE.md']) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.ok(!fs.existsSync(path.join(out, 'node_modules')));
  assert.match(fs.readFileSync(path.join(out, 'FACTORY_REPORT.md'), 'utf8'), /Delivered to/);

  // A folder holding other work is refused up front; the run's own folder is fine to re-deliver into.
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', outputDir: out }), /already has files/);
  const nonEmpty = tmpDir();
  fs.writeFileSync(path.join(nonEmpty, 'mine.txt'), 'keep me');
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', outputDir: nonEmpty }), /already has files/);
  assert.equal(fs.readFileSync(path.join(nonEmpty, 'mine.txt'), 'utf8'), 'keep me');
  for (const bad of ['/', os.homedir(), cfg.dataDir, path.join(cfg.dataDir, 'x'), cfg.root]) {
    await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', outputDir: bad }), /protected location/, bad);
  }
});

test('FACTORY_OUTPUT_ROOT confines output folders and resolves relative names inside it', async () => {
  const root = tmpDir();
  const cfg = loadConfig({ dataDir: tmpDir(), outputRoot: root });
  const factory = new Factory({ cfg, store: new RunStore(cfg.dataDir), previews });
  const run = await factory.createRun({ idea: 'A tiny app', provider: 'offline', outputDir: 'tiny', start: false });
  assert.equal(run.outputDir, path.join(root, 'tiny'));
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', outputDir: '../escape' }), /must be inside/);
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', outputDir: os.tmpdir() }), /must be inside/);
});
