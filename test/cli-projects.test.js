// The registry through the CLI: register once, select by name or id, rename/move/repair/archive/remove, and run on it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanMachineEnv, cli } from './cli-helpers.js';
import { startRegistryBackend, initRepo, writer } from './registry-helpers.js';
import { tmpDir, waitFor } from './helpers.js';
import { EXIT } from '../src/cli/core.js';

cleanMachineEnv();
const backends = [];
after(async () => { for (const b of backends) await b.close().catch(() => {}); });
const boot = async (opts) => {
  const be = await startRegistryBackend({ extra: { providerFactory: () => writer() }, ...opts });
  backends.push(be);
  const run = (argv, o = {}) => cli(argv, { backend: { url: be.url, cfg: be.app.cfg }, ...o });
  return Object.assign(be, { cli: run });
};

test('add / list / show / use: register once by path, select by name or id, and the selection survives (it stores the id, not a path)', async () => {
  const be = await boot({ roots: { repo1: (d) => initRepo(d, { remote: 'https://github.com/acme/r1.git' }) } });
  const cfgDir = tmpDir('da-prompt-cli-cfg-');
  const out = await be.cli(['projects', 'add', be.roots.dirs.repo1, '--name', 'Repo One', '--use', '--json'], { configDir: cfgDir });
  assert.equal(out.code, 0, out.err);
  const id = out.json.project.id;
  assert.match(id, /^prj_/);
  assert.equal(out.json.project.name, 'Repo One');
  const state = JSON.parse(fs.readFileSync(path.join(cfgDir, 'cli.json'), 'utf8'));
  assert.deepEqual([state.project.projectId, state.project.mode], [id, 'registered']);
  assert.ok(!JSON.stringify(state).includes(be.roots.root), 'the CLI state holds the id, not a path');

  const list = await be.cli(['projects', 'list', '--json']);
  assert.deepEqual(list.json.projects.map((p) => p.id), [id]);
  assert.match((await be.cli(['projects', 'list'], { configDir: cfgDir })).out, /Repo One[\s\S]*available/);
  const show = await be.cli(['projects', 'show', 'Repo One']);
  assert.equal(show.code, 0);
  assert.match(show.out, /local git repository/);
  assert.match(show.out, /github\.com\/acme\/r1/);
  assert.equal((await be.cli(['projects', 'show', id, '--json'])).json.git.branch, 'main');
  const cur = await be.cli(['projects', 'current', '--json'], { configDir: cfgDir });
  assert.equal(cur.json.project.projectId, id);
  // By a path that is registered, `use` finds the registered project rather than creating anything.
  const viaPath = await be.cli(['projects', 'use', be.roots.dirs.repo1, '--json'], { configDir: tmpDir('da-prompt-cli-cfg-') });
  assert.equal(viaPath.json.selected.projectId, id);
  const dup = await be.cli(['projects', 'add', be.roots.dirs.repo1]);
  assert.equal(dup.code, EXIT.DENIED);
  assert.match(dup.err, /already registered/);
  assert.match(dup.err, new RegExp(id), 'the conflict names the existing project');
  assert.equal((await be.cli(['projects', 'add', '/etc'])).code, EXIT.DENIED, 'outside the authorized roots');
});

test('rename keeps the id; archive/restore; validate exits 6 for a missing folder and repair fixes it without a new identity', async () => {
  const be = await boot({ roots: { app: (d) => initRepo(d) } });
  const id = (await be.cli(['projects', 'add', be.roots.dirs.app, '--json'])).json.project.id;
  const r = await be.cli(['projects', 'rename', id, 'Fancy', 'Name', '--json']);
  assert.equal(r.json.project.name, 'Fancy Name');
  assert.equal(r.json.project.id, id);
  assert.equal((await be.cli(['projects', 'archive', 'Fancy Name'])).code, 0);
  assert.deepEqual((await be.cli(['projects', 'list', '--json'])).json.projects, [], 'archived projects are hidden by default');
  assert.equal((await be.cli(['projects', 'list', '--archived', '--json'])).json.projects[0].id, id);
  assert.equal((await be.cli(['projects', 'restore', 'Fancy Name'])).code, 0);
  assert.equal((await be.cli(['projects', 'validate', id])).code, 0);
  const moved = path.join(be.roots.root, 'app2');
  fs.renameSync(be.roots.dirs.app, moved);
  const v = await be.cli(['projects', 'validate', id, '--json']);
  assert.equal(v.code, EXIT.ATTENTION);
  assert.equal(v.json.project.status, 'missing');
  const show = await be.cli(['projects', 'show', id]);
  assert.equal(show.code, EXIT.ATTENTION);
  assert.match(show.out, /projects repair/);
  const run = await be.cli(['run', 'x', '--project', id, '--detach']);
  assert.equal(run.code, EXIT.DENIED, 'work is blocked while the folder is missing');
  assert.match(run.err, /missing/);
  const fixed = await be.cli(['projects', 'repair', id, moved, '--json']);
  assert.equal(fixed.code, 0, fixed.err);
  assert.equal(fixed.json.project.id, id);
  assert.equal(fixed.json.project.status, 'available');
  const other = initRepo(path.join(be.roots.root, 'other'), { message: 'other repo', files: { 'o.txt': 'o' } });
  const bad = await be.cli(['projects', 'repair', id, other]);
  assert.equal(bad.code, EXIT.DENIED);
  assert.match(bad.err, /different repository|does not look like/);
  assert.equal((await be.cli(['projects', 'repair', id, other, '--accept-different-repository'])).code, 0);
});

test('remove needs explicit confirmation, deletes no files, and a run on a registered project is tied to its id', async () => {
  const be = await boot({ roots: { work: (d) => initRepo(d) } });
  const id = (await be.cli(['projects', 'add', be.roots.dirs.work, '--name', 'Work', '--json'])).json.project.id;
  const started = await be.cli(['run', 'Add a farewell helper', '--project', 'Work', '--detach', '--json']);
  assert.equal(started.code, 0, started.err);
  const runId = started.json.id;
  await waitFor(async () => (await be.cli(['runs', 'show', runId, '--json'])).json.status === 'completed', { timeoutMs: 120_000 });
  const shown = (await be.cli(['runs', 'show', runId, '--json'])).json;
  assert.equal(shown.projectId, id);
  const list = (await be.cli(['runs', 'list', '--json'])).json.runs;
  assert.equal(list[0].projectId, id);
  assert.equal((await be.cli(['projects', 'show', id, '--json'])).json.runs, 1);
  // Non-interactive removal needs --yes or the name.
  const refused = await be.cli(['projects', 'remove', 'Work']);
  assert.equal(refused.code, EXIT.USAGE);
  assert.match(refused.err, /not deleted|confirmation/);
  const wrong = await be.cli(['projects', 'remove', 'Work', '--confirm-name', 'nope']);
  assert.notEqual(wrong.code, 0);
  const ok = await be.cli(['projects', 'remove', 'Work', '--yes', '--json']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.json.note, /Only the registration/);
  assert.ok(fs.existsSync(path.join(be.roots.dirs.work, '.git')));
  assert.equal((await be.cli(['projects', 'show', id])).code, EXIT.NOT_FOUND);
  assert.equal((await be.cli(['runs', 'show', runId, '--json'])).json.projectId, id, 'history keeps the id');
  assert.equal((await be.cli(['runs', 'list', '--json'])).json.runs[0].projectRemoved, true);
});

test('remote repositories are registered by owner/repo with no clone and no credentials; a bad reference is a usage error', async () => {
  const be = await boot({ roots: {}, extra: { gitConfig: [] } });
  const r = await be.cli(['projects', 'add', 'acme/widgets', '--no-check', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.project.kind, 'remote');
  assert.equal(r.json.project.location.url, 'https://github.com/acme/widgets.git');
  const dup = await be.cli(['projects', 'add', 'https://github.com/acme/widgets', '--no-check']);
  assert.equal(dup.code, EXIT.DENIED);
  const cred = await be.cli(['projects', 'add', 'https://user:hunter2secret@github.com/acme/x.git', '--no-check']);
  assert.notEqual(cred.code, 0);
  assert.ok(!(cred.err + cred.out).includes('hunter2secret'));
  assert.equal((await be.cli(['projects', 'connect', 'not a repo'])).code, EXIT.USAGE);
  const t = await be.cli(['projects', 'list']);
  assert.match(t.out, /remote/);
});
