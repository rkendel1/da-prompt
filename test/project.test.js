import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PreviewManager } from '../src/deploy.js';
import { makeRepo, makeRoot, dirId, git, writeFiles, setup, Scripted, task, plan, toolUse, done, NODE_FILES } from './project-helpers.js';

const previews = new PreviewManager({ max: 2 });
after(() => previews.stopAll());

const FAREWELL = "export const farewell = (name) => `Goodbye, ${name}!`;\n";
const BROKEN_GREET = "export const greet = (name) => `Hi ${name}`;\n"; // breaks the existing greet test
const FAREWELL_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { farewell } from '../src/farewell.js';\ntest('farewell', () => assert.equal(farewell('Ada'), 'Goodbye, Ada!'));\n";

/** An agent that implements `farewell`, but breaks greet() on its first attempt. */
function farewellAgent() {
  return new Scripted({
    plan: () => plan([task('farewell', { title: 'Add farewell()', files: ['src/greet.js'], verify: ['npm test'] })]),
    task: ({ attempt, turn }) => {
      if (turn === 0) {
        return [
          toolUse('write_file', { path: 'src/farewell.js', content: FAREWELL }),
          toolUse('write_file', { path: 'test/farewell.test.js', content: FAREWELL_TEST }),
          // attempt 1 breaks greet(); the retry restores it after reading the real failure output
          toolUse('write_file', { path: 'src/greet.js', content: attempt === 1 ? BROKEN_GREET : NODE_FILES['src/greet.js'] }),
        ];
      }
      return [done('Added farewell()', ['src/farewell.js'])];
    },
  });
}

test('local directory lifecycle: inspect, baseline, regression feedback, repair, isolated diff, source untouched', async () => {
  const { root, dirs, cfg: rootCfg } = makeRoot({ widgets: (d) => {
    const repo = makeRepo();
    fs.cpSync(repo, d, { recursive: true });
  } });
  const dir = dirs.widgets;
  // Pre-existing user work: an uncommitted edit and an untracked file.
  fs.appendFileSync(path.join(dir, 'README.md'), 'my own notes\n');
  writeFiles(dir, { 'scratch.txt': 'wip' });
  const before = { head: git(dir, 'rev-parse', 'HEAD'), branch: git(dir, 'branch', '--show-current'), status: git(dir, 'status', '--porcelain'), readme: fs.readFileSync(path.join(dir, 'README.md'), 'utf8') };

  const provider = farewellAgent();
  const { cfg, store, factory } = setup({ provider, cfg: rootCfg });
  const created = await factory.createRun({ idea: 'Add a farewell() helper', provider: 'offline', source: { mode: 'local', directoryId: dirId(cfg, 'widgets') } });
  assert.equal(created.source.mode, 'local');
  assert.ok(!JSON.stringify(created).includes(root), 'no server path in the persisted run');
  const run = await factory.start(created.id);

  assert.equal(run.status, 'completed', JSON.stringify({ err: run.error, checklist: run.checklist }));
  assert.equal(run.project.stages.connect.state, 'done');
  assert.equal(run.project.stages.baseline.state, 'done');
  assert.deepEqual(run.project.inspection.ecosystems, ['node']);
  assert.equal(run.project.baseline[0].command, 'npm test');
  assert.equal(run.project.baseline[0].status, 'passed');

  // The planner saw the inventory, the project's AGENTS.md (fenced as untrusted) and detected commands.
  const planCall = provider.seen.find((s) => s.kind === 'plan');
  const planText = planCall.messages[0].content;
  assert.match(planText, /Existing project/);
  assert.match(planText, /test: `npm test`/);
  assert.match(planText, /trust="untrusted"/);
  assert.match(planText, /two-space indentation/);
  assert.match(planCall.system, /EXISTING project/);

  // Attempt 1 broke greet(): real failure output went back to the agent; attempt 2 repaired it.
  const t = run.plan.tasks[0];
  assert.equal(t.attempts.length, 2, JSON.stringify(t.attempts.map((a) => [a.ok, a.verification?.map((v) => v.state + v.output.slice(0, 300))])));
  assert.equal(t.attempts[0].ok, false);
  assert.equal(t.attempts[0].verification[0].state, 'regression');
  assert.match(t.attempts[0].feedback, /REGRESSION/);
  assert.match(t.attempts[0].feedback, /not ok|greet/);
  assert.equal(t.status, 'completed');

  // Changes are exactly the intended files; none of the factory's own files land in the project.
  const changed = run.changes.files.map((f) => f.path).sort();
  assert.deepEqual(changed, ['src/farewell.js', 'test/farewell.test.js']);
  const patch = fs.readFileSync(path.join(store.deliveryDir(run.id), 'changes.patch'), 'utf8');
  assert.match(patch, /farewell/);
  assert.doesNotMatch(patch, /PLAN\.md|CLAUDE\.md|FACTORY_REPORT|\.home/);
  assert.equal(run.delivery.integrity.ok, true);
  assert.equal(run.delivery.readiness.ready, true, JSON.stringify(run.delivery.readiness));
  assert.ok(run.delivery.archive);
  assert.equal(fs.existsSync(path.join(store.workspaceDir(run.id), 'PLAN.md')), false);

  // The source: same branch, same HEAD, same uncommitted state, same bytes.
  assert.equal(git(dir, 'rev-parse', 'HEAD'), before.head);
  assert.equal(git(dir, 'branch', '--show-current'), before.branch);
  assert.equal(git(dir, 'status', '--porcelain'), before.status);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), before.readme);
  assert.equal(fs.existsSync(path.join(dir, 'src/farewell.js')), false);

  // Local runs never publish.
  assert.equal(run.delivery.publication, undefined);
  assert.match(fs.readFileSync(path.join(store.deliveryDir(run.id), 'FACTORY_REPORT.md'), 'utf8'), /not applicable \(local runs never push\)/);
});
