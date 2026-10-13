// The persistent project registry: identity, persistence, conflicts, repair, authorization, and its use by runs and
// terminals. Real temp git repositories and a real backend restarted over the same data directory; no network, no
// live GitHub credentials.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { cleanMachineEnv } from './cli-helpers.js';
import { startRegistryBackend, initRepo, git, writer, NEW_FILE, writeFiles } from './registry-helpers.js';
import { makeRemote } from './project-helpers.js';
import { tmpDir, waitFor } from './helpers.js';
import { remoteKey } from '../src/registry.js';

cleanMachineEnv();
const backends = [];
const boot = async (opts) => {
  const be = await startRegistryBackend(opts);
  backends.push(be);
  return be;
};
after(async () => { for (const b of backends) await b.close().catch(() => {}); });
const repo = (d, o) => initRepo(d, o);
const REMOTE = 'https://github.com/acme/widgets.git';

test('register, list, read, update, archive, restore: opaque stable ids and no credentials or server paths for non-admins', async () => {
  const be = await boot({ roots: { checkout: (d) => repo(d, { remote: REMOTE }), notes: (d) => writeFiles(d, { 'a.txt': 'x' }) } });
  const p = await be.register('checkout');
  assert.match(p.id, /^prj_[A-Za-z0-9_-]{16}$/);
  assert.equal(p.name, 'checkout');
  assert.equal(p.kind, 'local');
  assert.equal(p.status, 'available');
  assert.equal(p.repo.isGit, true);
  assert.equal(p.repo.remoteUrl, REMOTE);
  assert.equal(p.repo.defaultBranch, 'main');
  assert.equal(p.settings.workingMode, 'clone');
  assert.ok(p.createdAt && p.updatedAt);
  assert.equal(p.location.label, path.basename(be.roots.root) + '/checkout');

  const n = await be.register('notes'); // not a git folder: allowed, snapshot only
  assert.equal(n.repo.isGit, false);
  assert.equal(n.settings.workingMode, 'snapshot');
  assert.equal((await be.call('PATCH', `/api/projects/${n.id}`, { workingMode: 'clone' })).status, 400);

  const list = (await be.call('GET', '/api/projects')).body.projects;
  assert.deepEqual(list.map((x) => x.id).sort(), [p.id, n.id].sort());
  assert.deepEqual((await be.call('GET', '/api/projects?q=notes')).body.projects.map((x) => x.id), [n.id]);
  assert.deepEqual((await be.call('GET', '/api/projects?q=acme/widgets')).body.projects.map((x) => x.id), [p.id], 'search matches the remote too');

  const got = (await be.call('GET', `/api/projects/${p.id}`)).body;
  assert.equal(got.git.isGit, true);
  assert.equal(got.git.branch, 'main');
  assert.equal(got.git.dirty, false);
  assert.equal(got.git.remotes[0].url, REMOTE);

  // Rename: same id, new name, bumped updatedAt.
  const r = await be.call('PATCH', `/api/projects/${p.id}`, { name: '  Widgets (work)  ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.project.id, p.id);
  assert.equal(r.body.project.name, 'Widgets (work)');
  assert.ok(r.body.project.updatedAt >= p.updatedAt);

  // Archive/restore keep everything; archived is hidden by default.
  assert.equal((await be.call('POST', `/api/projects/${p.id}/archive`)).body.project.archived, true);
  assert.ok(!(await be.call('GET', '/api/projects')).body.projects.some((x) => x.id === p.id));
  assert.deepEqual((await be.call('GET', '/api/projects?archived=only')).body.projects.map((x) => x.id), [p.id]);
  assert.equal((await be.call('POST', `/api/projects/${p.id}/restore`)).body.project.archived, false);

  // Unknown / malformed ids look the same.
  for (const id of ['prj_doesnotexist0000', 'prj_', '../x', 'abc']) assert.equal((await be.call('GET', `/api/projects/${id}`)).status, 404, id);
});

test('the registry survives restarts: same ids, names, settings, and an atomic private file with no secrets', async () => {
  const be = await boot({ roots: { app: (d) => repo(d, { remote: REMOTE }) }, extra: { githubToken: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } });
  const a = await be.register('app', { name: 'My App', workingMode: 'snapshot' });
  await be.call('POST', `/api/projects/${a.id}/archive`);
  await be.restart();
  const after1 = (await be.call('GET', '/api/projects?archived=all')).body.projects;
  assert.equal(after1.length, 1);
  assert.equal(after1[0].id, a.id);
  assert.equal(after1[0].name, 'My App');
  assert.equal(after1[0].archived, true);
  assert.equal(after1[0].settings.workingMode, 'snapshot');
  assert.equal(after1[0].createdAt, a.createdAt);
  const file = path.join(be.dataDir, 'projects.json');
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'private to the user');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('ghp_') && !/token|password|authorization/i.test(text), 'no credentials in project records');
  assert.deepEqual(fs.readdirSync(be.dataDir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left by the atomic writes');
  // A corrupt file is set aside, never silently overwritten, and the backend still starts.
  await be.close();
  fs.writeFileSync(file, '{ not json');
  await be.restart();
  assert.deepEqual((await be.call('GET', '/api/projects')).body.projects, []);
  assert.ok(fs.readdirSync(be.dataDir).some((f) => f.startsWith('projects.json.corrupt-')));
});

test('identity is not the folder name, path, URL or branch: renames, branch switches and a remote with another name keep one identity', async () => {
  const be = await boot({ roots: { 'client-work': (d) => repo(d, { remote: 'git@github.com:acme/Totally-Different.git' }) } });
  const p = await be.register('client-work');
  assert.equal(p.name, 'client-work');
  assert.equal(p.repo.remoteUrl, 'git@github.com:acme/Totally-Different.git', 'the remote is whatever git reports, not assumed to be GitHub over https');
  const dir = be.roots.dirs['client-work'];
  git(dir, 'checkout', '-q', '-b', 'feature/x');
  const got = (await be.call('GET', `/api/projects/${p.id}`)).body;
  assert.equal(got.project.id, p.id);
  assert.equal(got.git.branch, 'feature/x');
  assert.equal(got.project.status, 'available', 'a branch switch is not an identity change');
  await be.call('PATCH', `/api/projects/${p.id}`, { name: 'Acme client' });
  assert.equal((await be.call('GET', `/api/projects/${p.id}`)).body.project.id, p.id);
  assert.equal(remoteKey('git@github.com:acme/Totally-Different.git'), remoteKey('https://GitHub.com/acme/totally-different.git/'));
});

test('duplicate registration: the same folder is a hard conflict; the same repository from another checkout needs an explicit decision', async () => {
  const be = await boot({ roots: { one: (d) => repo(d, { remote: REMOTE }) } });
  const a = await be.register('one');
  const again = await be.call('POST', '/api/projects', { directoryId: await be.dirId('one') });
  assert.equal(again.status, 409);
  assert.equal(again.body.conflicts[0].type, 'path_conflict');
  assert.equal(again.body.conflicts[0].projectId, a.id);
  assert.match(again.body.conflicts[0].resolution, /existing project|remove its registration/);
  // A second checkout of the same repository (same first commit and remote).
  const two = path.join(be.roots.root, 'two');
  git(be.roots.root, 'clone', '-q', be.roots.dirs.one, two);
  git(two, 'remote', 'set-url', 'origin', REMOTE);
  const dup = await be.call('POST', '/api/projects', { directoryId: await be.dirId('two') });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.conflicts[0].type, 'same_repository');
  assert.match(dup.body.error, /already registered from another checkout/);
  const ok = await be.call('POST', '/api/projects', { directoryId: await be.dirId('two'), acknowledgeSameRepository: true, name: 'two (second checkout)' });
  assert.equal(ok.status, 201);
  assert.notEqual(ok.body.project.id, a.id, 'a separate project: the distinction is explicit');
  // Concurrent registrations of the same folder: exactly one wins (checked inside the serialized write).
  const be2 = await boot({ roots: { z: (d) => repo(d) } });
  const id = await be2.dirId('z');
  const results = await Promise.all([1, 2, 3, 4].map(() => be2.call('POST', '/api/projects', { directoryId: id })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409]);
  assert.equal((await be2.call('GET', '/api/projects')).body.projects.length, 1);
});

test('remote repositories: a project is the repository, not a clone; credentials are rejected; the remote is never silently cloned', async () => {
  const remote = makeRemote();
  const be = await boot({ roots: {}, extra: { gitConfig: remote.insteadOf } });
  const r = await be.call('POST', '/api/projects', { kind: 'remote', repoUrl: 'acme/widgets' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const p = r.body.project;
  assert.equal(p.kind, 'remote');
  assert.equal(p.location.url, 'https://github.com/acme/widgets.git');
  assert.equal(p.repo.defaultBranch, 'main');
  assert.equal(p.status, 'available');
  assert.equal(p.settings.workingMode, 'clone');
  assert.ok(!fs.existsSync(path.join(be.dataDir, 'runs')) || fs.readdirSync(path.join(be.dataDir, 'runs')).length === 0, 'registering clones nothing');
  assert.equal((await be.call('POST', '/api/projects', { kind: 'remote', repoUrl: 'https://github.com/acme/widgets' })).status, 409, 'same repository twice');
  const cred = await be.call('POST', '/api/projects', { kind: 'remote', repoUrl: 'https://user:hunter2secret@github.com/acme/other.git' });
  assert.equal(cred.status, 400);
  assert.ok(!JSON.stringify(cred.body).includes('hunter2secret'));
  assert.equal((await be.call('POST', '/api/projects', { kind: 'remote', repoUrl: 'https://evil.example/acme/x.git' })).status, 400, 'hosts are allow-listed');
  assert.equal((await be.call('PATCH', `/api/projects/${p.id}`, { remoteUrl: 'acme/renamed' })).status, 409, 'changing a repository URL is an explicit identity change');
  const moved = await be.call('PATCH', `/api/projects/${p.id}`, { remoteUrl: 'acme/renamed', acceptNewRemote: true });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.project.id, p.id, 'the id survives a changed URL');
  assert.equal(moved.body.project.location.repo, 'renamed');
  // Unreachable repositories are still registered (with a visible warning) unless a check is demanded.
  const miss = await be.call('POST', '/api/projects', { kind: 'remote', repoUrl: 'acme/does-not-exist' });
  assert.equal(miss.status, 201);
  assert.equal(miss.body.project.status, 'attention');
  assert.equal(miss.body.project.errors[0].code, 'unreachable');
  assert.notEqual((await be.call('POST', '/api/projects', { kind: 'remote', repoUrl: 'acme/also-missing', check: true })).status, 201);
});

test('a folder that moves or disappears keeps its record, is marked missing, blocks work, and can be repaired without a new identity', async () => {
  const be = await boot({ roots: { app: (d) => repo(d, { remote: REMOTE }) } });
  const p = await be.register('app');
  const old = be.roots.dirs.app;
  const moved = path.join(be.roots.root, 'app-moved');
  fs.renameSync(old, moved);
  const got = (await be.call('GET', `/api/projects/${p.id}`)).body.project;
  assert.equal(got.status, 'missing');
  assert.equal(got.id, p.id);
  assert.equal(got.errors[0].code, 'missing');
  assert.match(got.errors[0].message, /history are kept/);
  assert.equal((await be.call('GET', '/api/projects')).body.projects.find((x) => x.id === p.id).status, 'missing', 'still listed');
  // Work that needs the folder is blocked with the reason.
  const term = await be.call('POST', '/api/terminal/sessions', { projectId: p.id });
  assert.equal(term.status, 409);
  assert.match(term.body.error, /missing/);
  const run = await be.call('POST', '/api/runs', { idea: 'x', source: { projectId: p.id } });
  assert.equal(run.status, 409);
  // Repair to the new location (a path: administrators only, inside an authorized root).
  const fixed = await be.call('POST', `/api/projects/${p.id}/repair`, { path: moved });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.project.id, p.id);
  assert.equal(fixed.body.project.status, 'available');
  assert.equal(fixed.body.project.location.rel, 'app-moved');
  // Repair to a different repository is refused unless explicitly accepted.
  const other = initRepo(path.join(be.roots.root, 'stranger'), { remote: 'https://github.com/other/thing.git', message: 'first commit of something else', files: { 'x.txt': 'other' } });
  const bad = await be.call('POST', `/api/projects/${p.id}/repair`, { path: other });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.conflicts[0].type, 'identity_mismatch');
  assert.equal((await be.call('GET', `/api/projects/${p.id}`)).body.project.location.rel, 'app-moved', 'nothing changed');
  const accepted = await be.call('POST', `/api/projects/${p.id}/repair`, { path: other, acceptDifferentRepository: true });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.project.id, p.id);
  assert.equal(accepted.body.project.repo.remoteUrl, 'https://github.com/other/thing.git');
  // A folder that is already another project cannot be taken over.
  const b = await be.register('stranger').catch((e) => e);
  void b;
  const third = initRepo(path.join(be.roots.root, 'third'), { files: { 'y.txt': 'y' }, message: 'third' });
  const tp = (await be.call('POST', '/api/projects', { path: third })).body.project;
  const steal = await be.call('POST', `/api/projects/${tp.id}/repair`, { path: other, acceptDifferentRepository: true });
  assert.equal(steal.status, 409);
  assert.equal(steal.body.conflicts[0].type, 'path_conflict');
});

test('a replaced repository or changed remote is detected from Git itself, blocks work, and needs an explicit decision', async () => {
  const be = await boot({ roots: { app: (d) => repo(d, { remote: REMOTE }) } });
  const p = await be.register('app');
  const dir = be.roots.dirs.app;
  // Remote URL changed: attention, not silently followed.
  git(dir, 'remote', 'set-url', 'origin', 'https://github.com/acme/renamed-repo.git');
  let got = (await be.call('GET', `/api/projects/${p.id}`)).body.project;
  assert.equal(got.status, 'attention');
  assert.equal(got.errors[0].code, 'remote_changed');
  assert.equal((await be.call('POST', '/api/terminal/sessions', { projectId: p.id })).status, 409);
  const acc = await be.call('PATCH', `/api/projects/${p.id}`, { acceptRemoteChange: true });
  assert.equal(acc.body.project.status, 'available');
  assert.equal(acc.body.project.repo.remoteUrl, 'https://github.com/acme/renamed-repo.git');
  // Folder replaced by a different repository (same name, same remote!): the first commit differs.
  fs.rmSync(dir, { recursive: true, force: true });
  initRepo(dir, { remote: 'https://github.com/acme/renamed-repo.git', message: 'a completely different history', files: { 'other.txt': 'x' } });
  got = (await be.call('GET', `/api/projects/${p.id}`)).body.project;
  assert.equal(got.status, 'attention');
  assert.equal(got.errors[0].code, 'repository_replaced');
  assert.equal((await be.call('POST', '/api/runs', { idea: 'x', source: { projectId: p.id } })).status, 409);
  // The same folder is accepted only through an explicit repair.
  assert.equal((await be.call('POST', `/api/projects/${p.id}/repair`, { path: dir })).status, 409);
  const ok = await be.call('POST', `/api/projects/${p.id}/repair`, { path: dir, acceptDifferentRepository: true });
  assert.equal(ok.body.project.status, 'available');
  // No longer a repository at all.
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  got = (await be.call('GET', `/api/projects/${p.id}`)).body.project;
  assert.equal(got.errors[0].code, 'repository_missing');
});

test('authorization: paths are admin-only and confined to authorized roots; a persisted record grants nothing; read-only roots stay read-only', async () => {
  const be = await boot({ roots: { app: (d) => repo(d) }, readOnlyRoots: { ref: (d) => repo(d, { message: 'reference repo' }) } });
  // Non-admin (relayed) requests cannot register by path, only from the authorized list.
  const viaPath = await be.call('POST', '/api/projects', { path: be.roots.dirs.app }, { 'x-forwarded-for': '203.0.113.5' });
  assert.equal(viaPath.status, 403);
  assert.match(viaPath.body.error, /authenticated session|authorized list/);
  // Admins still cannot name arbitrary paths.
  for (const bad of ['/etc', '/', os_tmp(), path.join(be.roots.root, '..'), path.join(be.roots.root, 'app', '..', '..')]) {
    const r = await be.call('POST', '/api/projects', { path: bad });
    assert.ok([400, 403, 404].includes(r.status), `${bad} → ${r.status}`);
  }
  assert.equal((await be.call('POST', '/api/projects', { directoryId: '0000000000:x' })).status, 403);
  assert.equal((await be.call('POST', '/api/projects', { directoryId: `${(await be.dirId('app')).split(':')[0]}:../x` })).status, 403);
  // Symlink escaping the root.
  fs.symlinkSync('/etc', path.join(be.roots.root, 'sneaky'));
  assert.equal((await be.call('POST', '/api/projects', { path: path.join(be.roots.root, 'sneaky') })).status, 403);

  const app = await be.register('app');
  const ref = await be.register('ref');
  assert.equal(ref.location.readOnly, true);
  assert.equal(ref.settings.workingMode, 'clone');
  assert.equal((await be.call('POST', '/api/terminal/sessions', { projectId: ref.id })).status, 403, 'no shell in a read-only root');

  // The record is re-checked on every use: when the root stops being authorized the project becomes inaccessible.
  await be.restart({ projectRoots: [] });
  const gone = (await be.call('GET', `/api/projects/${app.id}`)).body.project;
  assert.equal(gone.status, 'inaccessible');
  assert.equal(gone.errors[0].code, 'outside_roots');
  assert.equal(gone.id, app.id, 'the record is retained');
  assert.equal((await be.call('POST', '/api/terminal/sessions', { projectId: app.id })).status, 409);
  assert.equal((await be.call('POST', '/api/runs', { idea: 'x', source: { projectId: app.id } })).status, 409);
  // Re-authorizing the root makes it available again, same id.
  await be.restart({ projectRoots: [be.roots.root] });
  assert.equal((await be.call('GET', `/api/projects/${app.id}`)).body.project.status, 'available');
  // Password-protected servers need the password for the registry too.
  const pw = await boot({ roots: { app: (d) => repo(d) }, password: 'correct horse battery' });
  assert.equal((await fetch(`${pw.url}/api/projects`)).status, 401);
  assert.equal((await pw.call('GET', '/api/projects')).status, 200);
});
const os_tmp = () => path.dirname(tmpDir());

test('removing a registration needs the name, deletes nothing, and run history keeps its project id', async () => {
  const be = await boot({ roots: { app: (d) => repo(d) }, extra: { providerFactory: () => writer() } });
  const p = await be.register('app');
  const run = (await be.call('POST', '/api/runs', { idea: 'Add a farewell helper', provider: 'offline', source: { projectId: p.id } })).body.run;
  assert.equal(run.projectId, p.id);
  await waitFor(async () => (await be.call('GET', `/api/runs/${run.id}`)).body.run.status === 'completed', { timeoutMs: 120_000 });
  const noConfirm = await be.call('DELETE', `/api/projects/${p.id}`, {});
  assert.equal(noConfirm.status, 400);
  assert.match(noConfirm.body.error, /not deleted/);
  assert.equal((await be.call('DELETE', `/api/projects/${p.id}`, { confirm: 'wrong name' })).status, 400);
  const del = await be.call('DELETE', `/api/projects/${p.id}`, { confirm: 'app' });
  assert.equal(del.status, 200);
  assert.match(del.body.note, /Only the registration/);
  assert.ok(fs.existsSync(path.join(be.roots.dirs.app, '.git')), 'the repository is untouched');
  assert.equal((await be.call('GET', `/api/projects/${p.id}`)).status, 404);
  const rows = (await be.call('GET', '/api/runs')).body.runs;
  assert.equal(rows[0].projectId, p.id);
  assert.equal(rows[0].projectName, 'app');
  assert.equal(rows[0].projectRemoved, true);
  assert.equal((await be.call('GET', `/api/runs/${run.id}`)).status, 200, 'the run is intact');
  assert.equal(fs.existsSync(be.store.runDir(run.id)), true);
  // Registering the folder again gives a new identity (the removed one is gone), without disturbing history.
  assert.notEqual((await be.register('app')).id, p.id);
});

test('runs keep their project association through renames, moves and restarts; apply follows the project\'s current folder and is blocked while it is unavailable', async () => {
  const be = await boot({ roots: { app: (d) => repo(d) }, extra: { providerFactory: () => writer() } });
  const p = await be.register('app', { name: 'Shop' });
  const created = await be.call('POST', '/api/runs', { idea: 'Add a farewell helper', provider: 'offline', source: { projectId: p.id } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.run.id;
  assert.equal(created.body.run.projectName, 'Shop');
  assert.equal(created.body.run.source.mode, 'local');
  await waitFor(async () => (await be.call('GET', `/api/runs/${id}`)).body.run.status === 'completed', { timeoutMs: 120_000 });
  // Rename + restart: the run is still the project's, now under the new name.
  await be.call('PATCH', `/api/projects/${p.id}`, { name: 'Shop v2' });
  await be.restart();
  const rows = (await be.call('GET', '/api/runs')).body.runs;
  assert.equal(rows[0].projectId, p.id);
  assert.equal(rows[0].projectName, 'Shop v2');
  assert.deepEqual((await be.call('GET', `/api/projects/${p.id}/runs`)).body.runs.map((r) => r.id), [id]);
  assert.deepEqual((await be.call('GET', `/api/runs?projectId=${p.id}`)).body.runs.map((r) => r.id), [id]);
  assert.equal((await be.call('GET', `/api/runs/${id}`)).body.run.projectId, p.id);
  assert.equal((await be.call('GET', `/api/projects/${p.id}`)).body.runs, 1);
  assert.equal((await be.call('POST', `/api/runs/${id}/review`, { decision: 'approve' })).status, 200);
  // The folder moves; apply is blocked (missing), then follows the repaired location.
  const old = be.roots.dirs.app;
  const moved = path.join(be.roots.root, 'shop-moved');
  fs.renameSync(old, moved);
  const blocked = await be.call('POST', `/api/runs/${id}/apply`, { mode: 'working-tree' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /missing/);
  assert.equal((await be.call('POST', `/api/projects/${p.id}/repair`, { path: moved })).status, 200);
  const applied = await be.call('POST', `/api/runs/${id}/apply`, { mode: 'working-tree' });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(fs.readFileSync(path.join(moved, 'src/farewell.js'), 'utf8'), NEW_FILE['src/farewell.js']);
  assert.ok(!fs.existsSync(path.join(old, 'src')), 'nothing was written to the old location');
  // Archived projects take no new work.
  await be.call('POST', `/api/projects/${p.id}/archive`);
  assert.equal((await be.call('POST', '/api/runs', { idea: 'x', source: { projectId: p.id } })).status, 409);
  assert.equal((await be.call('GET', `/api/projects/${p.id}/runs`)).body.runs.length, 1, 'but its history stays');
});

test('terminals started from a project begin in its validated directory and record its id; the session is not the project', async () => {
  const be = await boot({ roots: { app: (d) => repo(d), other: (d) => repo(d) } });
  const p = await be.register('app');
  const t = await be.call('POST', '/api/terminal/sessions', { projectId: p.id, cols: 90, rows: 20 });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const s = t.body.session;
  assert.equal(s.cwd, fs.realpathSync(be.roots.dirs.app));
  assert.equal(s.project.projectId, p.id);
  assert.equal(s.project.name, 'app');
  assert.ok(!('path' in s.project), 'the session record is not where the location lives');
  await be.call('PATCH', `/api/projects/${p.id}`, { name: 'Renamed' });
  assert.equal((await be.call('GET', `/api/terminal/sessions/${s.id}`)).body.session.project.projectId, p.id);
  // Closing the terminal does not touch the project.
  await be.call('DELETE', `/api/terminal/sessions/${s.id}`);
  assert.equal((await be.call('GET', `/api/projects/${p.id}`)).body.project.status, 'available');
  assert.ok((await be.call('GET', `/api/projects/${p.id}`)).body.project.lastUsedAt, 'use is recorded');
  // Legacy directoryId still works; a remote project has no folder; an unknown id is refused.
  const legacy = await be.call('POST', '/api/terminal/sessions', { directoryId: await be.dirId('other') });
  assert.equal(legacy.status, 201);
  await be.call('DELETE', `/api/terminal/sessions/${legacy.body.session.id}`);
  assert.equal((await be.call('POST', '/api/terminal/sessions', { projectId: 'prj_unknown0000000000' })).status, 404);
  await be.call('POST', `/api/projects/${p.id}/archive`);
  assert.equal((await be.call('POST', '/api/terminal/sessions', { projectId: p.id })).status, 409);
  const remote = (await be.call('POST', '/api/projects', { kind: 'remote', repoUrl: 'acme/widgets', check: false })).body.project;
  const rt = await be.call('POST', '/api/terminal/sessions', { projectId: remote.id });
  assert.equal(rt.status, 409);
  assert.match(rt.body.error, /remote repository/);
});

test('migration: earlier runs get projects lazily, once per folder/repository, and re-running creates no duplicates', async () => {
  const remote = makeRemote();
  const be = await boot({ roots: { app: (d) => repo(d), lib: (d) => repo(d) }, extra: { gitConfig: remote.insteadOf, providerFactory: () => writer() } });
  const mk = async (source) => (await be.factory.createRun({ idea: 'Add a farewell helper', provider: 'offline', source })).id;
  // Runs created the old way (no projectId): two on one folder, one on another, one GitHub.
  const a1 = await mk({ mode: 'local', directoryId: await be.dirId('app') });
  const a2 = await mk({ mode: 'local', directoryId: await be.dirId('app') });
  const l1 = await mk({ mode: 'local', directoryId: await be.dirId('lib'), workingMode: 'snapshot' });
  const g1 = await mk({ mode: 'github', repoUrl: remote.url });
  // A run whose folder is no longer authorized keeps its own label and is left alone.
  const orphan = await mk({ mode: 'local', directoryId: await be.dirId('lib') });
  const rec = await be.store.load(orphan);
  rec.source.directoryId = 'ffffffffff:gone';
  await be.store.save(rec);
  for (const id of [a1, a2, l1, g1, orphan]) assert.equal((await be.store.load(id)).projectId, undefined);
  assert.equal((await be.call('GET', '/api/projects')).body.projects.length, 0);

  await be.restart(); // startup migration
  const projects = (await be.call('GET', '/api/projects')).body.projects;
  assert.equal(projects.length, 3, 'app, lib and the GitHub repository: one project each');
  const byKind = Object.fromEntries(projects.map((p) => [p.location.type === 'remote' ? 'remote' : p.name, p]));
  assert.ok(byKind.app && byKind.lib && byKind.remote);
  assert.equal(byKind.app.migratedFrom, 'runs');
  const r1 = await be.store.load(a1);
  const r2 = await be.store.load(a2);
  assert.equal(r1.projectId, byKind.app.id);
  assert.equal(r2.projectId, byKind.app.id);
  assert.equal((await be.store.load(l1)).projectId, byKind.lib.id);
  assert.equal((await be.store.load(g1)).projectId, byKind.remote.id);
  assert.equal((await be.store.load(orphan)).projectId, undefined);
  assert.equal(r1.projectName, 'app');
  assert.equal(r1.source.directoryId.split(':')[1], 'app', 'the old run record is otherwise unchanged');
  await be.restart();
  await be.restart();
  assert.equal((await be.call('GET', '/api/projects')).body.projects.length, 3, 'idempotent: no duplicates');
  // Registering a folder that was migrated is a conflict, not a duplicate.
  assert.equal((await be.call('POST', '/api/projects', { directoryId: await be.dirId('app') })).status, 409);
  // New runs from the registered project and the migrated history sit side by side.
  assert.equal((await be.call('GET', `/api/projects/${byKind.app.id}/runs`)).body.runs.length, 2);
});

test('inspect and runs accept a project id directly (no path or directoryId from the client)', async () => {
  const be = await boot({ roots: { app: (d) => repo(d) } });
  const p = await be.register('app', { name: 'Inspectable' });
  const info = await be.call('POST', '/api/projects/inspect', { source: { projectId: p.id } });
  assert.equal(info.status, 200);
  assert.equal(info.body.mode, 'local');
  assert.equal(info.body.git.branch, 'main');
  assert.ok(!JSON.stringify(info.body).includes(be.roots.root), 'no server path in the response');
  const view = JSON.stringify((await be.call('GET', `/api/projects/${p.id}`, undefined, { 'x-forwarded-for': '203.0.113.5' })).body);
  assert.ok(!view.includes(be.roots.root), 'non-admin views carry no absolute path');
  assert.ok(JSON.stringify((await be.call('GET', `/api/projects/${p.id}`)).body).includes(be.roots.root), 'administrators see where it is');
  void http;
});
