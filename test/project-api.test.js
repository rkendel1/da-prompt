import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { OfflineProvider } from '../src/providers/offline.js';
import { tmpDir, waitFor } from './helpers.js';
import { makeRepo, makeRoot, makeRemote, startMockApi, authorizedKey, git, writeFiles, Scripted, task, plan, toolUse, done, PY_FILES } from './project-helpers.js';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
let app;
let base;
let roots;
let remote;
let api;
let key;
let delayMs = 0;

before(async () => {
  roots = makeRoot({
    widgets: (d) => fs.cpSync(makeRepo(), d, { recursive: true }),
    notes: (d) => writeFiles(d, { 'a.txt': 'plain folder\n' }),
    calc: (d) => fs.cpSync(makeRepo(PY_FILES), d, { recursive: true }),
  });
  fs.appendFileSync(path.join(roots.dirs.calc, 'README.md'), 'local edit\n');
  remote = makeRemote(undefined, { branches: ['develop'] });
  api = await startMockApi();
  app = await createServer({
    dataDir: tmpDir(),
    defaultProvider: 'offline',
    ...roots.cfg,
    gitConfig: remote.insteadOf,
    githubToken: TOKEN,
    githubApiUrl: api.url,
    providerFactory: () => new OfflineProvider({ faults: false, delayMs }),
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  key = authorizedKey(app.cfg);
});
after(async () => {
  await app.close();
  await api.close();
});

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
};
const get = (p) => call('GET', p);
const post = (p, b = {}) => call('POST', p, b);
const finished = (id) => waitFor(async () => {
  const r = (await get(`/api/runs/${id}`)).data.run;
  return ['completed', 'needs_attention', 'failed', 'cancelled'].includes(r.status) && !r.executing ? r : null;
});
const localSource = (name, extra = {}) => ({ mode: 'local', directoryId: `${key}:${name}`, ...extra });

test('config advertises capabilities, not paths', async () => {
  const { data } = await get('/api/config');
  assert.equal(data.projects.local, true);
  assert.equal(data.projects.canPublish, true);
  assert.deepEqual(data.projects.githubHosts, ['github.com']);
  const body = JSON.stringify(data);
  assert.ok(!body.includes(roots.root) && !body.includes(TOKEN));
});

test('directory discovery lists only authorized directories, with git state and no server paths', async () => {
  const { status, data } = await get('/api/projects/directories');
  assert.equal(status, 200);
  assert.ok(!JSON.stringify(data).includes(roots.root));
  const byName = Object.fromEntries(data.directories.map((d) => [d.name, d]));
  assert.deepEqual(Object.keys(byName).sort(), ['calc', 'notes', 'widgets']);
  assert.deepEqual([byName.widgets.git.isGit, byName.widgets.git.branch, byName.widgets.git.dirty], [true, 'main', false]);
  assert.deepEqual([byName.calc.git.isGit, byName.calc.git.dirty], [true, true]);
  assert.equal(byName.notes.git.isGit, false);
  assert.equal(byName.widgets.id, `${key}:widgets`);
});

test('inspecting a source is read-only and constrained to authorized roots', async () => {
  const widgets = await post('/api/projects/inspect', { source: localSource('widgets') });
  assert.equal(widgets.status, 200);
  assert.equal(widgets.data.defaultWorkingMode, 'clone');
  assert.deepEqual(widgets.data.detected.ecosystems, ['node']);
  assert.deepEqual(widgets.data.detected.checks.map((c) => c.command), ['npm test']);
  assert.deepEqual(widgets.data.detected.instructions, ['AGENTS.md']);
  assert.match(widgets.data.summary, /your directory is only written if you apply/);
  assert.ok(!JSON.stringify(widgets.data).includes(roots.root));

  const calc = (await post('/api/projects/inspect', { source: localSource('calc') })).data;
  assert.deepEqual(calc.workingModes, ['clone', 'snapshot']);
  assert.ok(calc.warnings.some((w) => /uncommitted change/.test(w)));
  const notes = (await post('/api/projects/inspect', { source: localSource('notes') })).data;
  assert.deepEqual(notes.workingModes, ['snapshot']);
  assert.equal(notes.git.isGit, false);
  assert.ok(notes.warnings.some((w) => /Not a git repository/.test(w)));

  for (const bad of [`${key}:../`, `${key}:widgets/../..`, 'ffffffffff:widgets', roots.dirs.widgets, '']) {
    const r = await post('/api/projects/inspect', { source: { mode: 'local', directoryId: bad } });
    assert.ok([400, 403].includes(r.status), `${bad} → ${r.status}`);
    assert.ok(!JSON.stringify(r.data).includes(roots.root));
  }
  assert.equal((await post('/api/projects/inspect', { source: { mode: 'ftp' } })).status, 400);
  assert.equal(fs.existsSync(path.join(roots.dirs.widgets, '.home')), false, 'inspection must not write into the project');
});

test('inspecting a GitHub repository reports the default branch, branches and the selected ref', async () => {
  const ok = await post('/api/projects/inspect', { source: { mode: 'github', repoUrl: remote.url, ref: 'develop' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.repo, 'acme/widgets');
  assert.equal(ok.data.defaultBranch, 'main');
  assert.deepEqual(ok.data.branches.sort(), ['develop', 'main']);
  assert.equal(ok.data.ref.kind, 'branch');
  assert.equal(ok.data.canPublish, true);
  assert.equal(ok.data.workingBranch, 'da-prompt/<run id>');
  assert.match(ok.data.summary, /develop is never modified/);
  const def = (await post('/api/projects/inspect', { source: { mode: 'github', repoUrl: 'acme/widgets' } })).data;
  assert.equal(def.ref.kind, 'default');

  const missingRef = await post('/api/projects/inspect', { source: { mode: 'github', repoUrl: remote.url, ref: 'nope' } });
  assert.equal(missingRef.status, 404);
  assert.match(missingRef.data.error, /ref "nope" was not found/);
  assert.equal((await post('/api/projects/inspect', { source: { mode: 'github', repoUrl: 'http://github.com/a/b' } })).status, 400);
  assert.equal((await post('/api/projects/inspect', { source: { mode: 'github', repoUrl: 'https://github.com/acme/ghost' } })).status, 404);
});

test('run creation rejects unauthorized sources with the right status and never leaks paths', async () => {
  const outside = await post('/api/runs', { idea: 'x', provider: 'offline', source: { mode: 'local', directoryId: 'ffffffffff:widgets' } });
  assert.equal(outside.status, 403);
  const trav = await post('/api/runs', { idea: 'x', provider: 'offline', source: localSource('../../etc') });
  assert.equal(trav.status, 403);
  const bad = await post('/api/runs', { idea: 'x', provider: 'offline', source: { mode: 'local' } });
  assert.equal(bad.status, 400);
  assert.equal((await post('/api/runs', { idea: 'x', provider: 'offline', source: localSource('widgets', { publish: true }) })).status, 400);
  assert.equal((await post('/api/runs', { idea: '', provider: 'offline', source: localSource('widgets') })).status, 400);
  assert.ok(!JSON.stringify([outside, trav, bad]).includes(roots.root));
  assert.equal((await get('/api/runs')).data.runs.filter((r) => r.source).length, 0, 'no run is created for a refused source');
});

test('a local run over HTTP: events, changes, diff, downloads, apply (idempotent) and conflicts', async () => {
  const created = await post('/api/runs', { idea: 'Add password reset to this application', provider: 'offline', source: localSource('widgets') });
  assert.equal(created.status, 201);
  assert.equal(created.data.run.source.mode, 'local');
  assert.ok(!JSON.stringify(created.data).includes(roots.root));
  const run = await finished(created.data.run.id);
  assert.equal(run.status, 'completed', JSON.stringify(run.checklist));
  assert.equal(run.title.startsWith('Add Password Reset'), true);
  assert.equal(run.source.label, 'widgets');

  // The record of work includes the new stages.
  const ctrl = new AbortController();
  const sse = await fetch(`${base}/api/runs/${run.id}/events`, { signal: ctrl.signal });
  const reader = sse.body.getReader();
  let text = '';
  while (!text.includes('"type":"deliver"')) text += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  for (const t of ['stage', 'source', 'inspect', 'baseline', 'plan', 'verify', 'checklist', 'deliver']) assert.match(text, new RegExp(`"type":"${t}"`), t);
  assert.ok(!text.includes(roots.root));

  const changes = (await get(`/api/runs/${run.id}/changes`)).data;
  assert.deepEqual(changes.files.map((f) => [f.status, f.path]), [['A', 'docs/da-prompt-change-request.md']]);
  const diff = (await get(`/api/runs/${run.id}/changes?path=${encodeURIComponent('docs/da-prompt-change-request.md')}`)).data;
  assert.match(diff.diff, /\+Add password reset to this application/);
  assert.equal((await get(`/api/runs/${run.id}/changes?path=--output%3D/etc/x`)).status, 400);
  assert.equal((await get(`/api/runs/${run.id}/files?path=../../run.json`)).status, 404);

  const patch = await fetch(`${base}/api/runs/${run.id}/download/changes.patch`);
  assert.equal(patch.status, 200);
  assert.match(patch.headers.get('content-disposition'), /\.patch/);
  assert.match(await patch.text(), /da-prompt-change-request/);
  assert.equal((await fetch(`${base}/api/runs/${run.id}/download/project.tar.gz`)).status, 200);
  assert.equal((await fetch(`${base}/api/runs/${run.id}/download/run.json`)).status, 404);
  const report = await (await fetch(`${base}/api/runs/${run.id}/report`)).text();
  assert.match(report, /## Request\nAdd password reset/);
  assert.match(report, /Verification — verified/);

  // Nothing was written until we ask.
  assert.equal(fs.existsSync(path.join(roots.dirs.widgets, 'docs')), false);
  assert.equal((await post(`/api/runs/${run.id}/apply`, { mode: 'working-tree' })).status, 409, 'applying needs an approval first');
  assert.equal((await post(`/api/runs/${run.id}/review`, { decision: 'approve' })).status, 200);
  const applied = await post(`/api/runs/${run.id}/apply`, { mode: 'working-tree' });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.run.delivery.local.applied.files.length, 1);
  assert.match(fs.readFileSync(path.join(roots.dirs.widgets, 'docs/da-prompt-change-request.md'), 'utf8'), /password reset/);
  assert.equal((await post(`/api/runs/${run.id}/apply`, { mode: 'working-tree' })).status, 200, 'applying the same result twice is harmless');

  // A second run based on the same project now conflicts with the first result.
  fs.writeFileSync(path.join(roots.dirs.widgets, 'docs/da-prompt-change-request.md'), 'edited by hand after the run\n');
  const conflict = await post(`/api/runs/${run.id}/apply`, { mode: 'working-tree' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.conflicts[0].path, 'docs/da-prompt-change-request.md');
  assert.match(conflict.data.error, /nothing was written/);
  assert.equal(fs.readFileSync(path.join(roots.dirs.widgets, 'docs/da-prompt-change-request.md'), 'utf8'), 'edited by hand after the run\n');

  assert.equal((await post(`/api/runs/${run.id}/publish`, {})).status, 409);
  assert.equal((await post(`/api/runs/${run.id}/apply`, { mode: 'bogus' })).status, 400);
  assert.equal((await get('/api/runs')).data.runs.find((r) => r.id === run.id).source.mode, 'local');
});

test('a GitHub run over HTTP: explicit publish pushes the branch and opens the pull request', async () => {
  const created = await post('/api/runs', { idea: 'Add a changelog', provider: 'offline', source: { mode: 'github', repoUrl: remote.url, ref: 'develop' } });
  assert.equal(created.status, 201);
  const run = await finished(created.data.run.id);
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.source.baseBranch, 'develop');
  assert.equal(run.delivery.publication, undefined);
  assert.equal((await post(`/api/runs/${run.id}/apply`, { mode: 'working-tree' })).status, 409);

  assert.equal((await post(`/api/runs/${run.id}/publish`, { pullRequest: true })).status, 409, 'publishing needs an approval first');
  assert.equal((await post(`/api/runs/${run.id}/review`, { decision: 'approve' })).status, 200);
  const pub = await post(`/api/runs/${run.id}/publish`, { pullRequest: true });
  assert.equal(pub.status, 200);
  assert.equal(pub.data.run.delivery.publication.state, 'pr-created');
  assert.equal(pub.data.run.delivery.publication.pr.base, 'develop');
  assert.equal(api.calls.filter((c) => c.method === 'POST').at(-1).body.base, 'develop');
  assert.equal(git(remote.bare, 'rev-list', '--count', `develop..da-prompt/${run.id}`), '1');
  assert.ok(!JSON.stringify(pub.data).includes(TOKEN));
});

test('cancel and resume work for existing-project runs over HTTP', async () => {
  delayMs = 150;
  try {
    const created = await post('/api/runs', { idea: 'Add a slow change', provider: 'offline', source: localSource('widgets', { workingMode: 'snapshot' }) });
    const id = created.data.run.id;
    await waitFor(async () => (await get(`/api/runs/${id}`)).data.run.project?.stages?.baseline?.state === 'done', { intervalMs: 20 });
    assert.equal((await post(`/api/runs/${id}/cancel`)).status, 202);
    const cancelled = await finished(id);
    assert.equal(cancelled.status, 'cancelled');
    delayMs = 0;
    assert.equal((await post(`/api/runs/${id}/resume`)).status, 202);
    const run = await finished(id);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.project.stages.connect.state, 'done');
    // Deleting a run removes its workspace and leaves the project alone.
    assert.equal((await call('DELETE', `/api/runs/${id}`)).status, 200);
    assert.equal(fs.existsSync(app.store.runDir(id)), false);
    assert.ok(fs.existsSync(path.join(roots.dirs.widgets, 'package.json')));
  } finally {
    delayMs = 0;
  }
});

test('previewing an existing project needs explicit authorization', async () => {
  const withDeploy = new Scripted({ plan: () => plan([task('t')], { deploy: { start: 'node src/greet.js', healthPath: '/' } }), task: ({ turn }) => (turn === 0 ? [toolUse('write_file', { path: 'a.txt', content: 'a' })] : [done('ok')]) });
  const old = app.factory.makeProvider;
  app.factory.makeProvider = () => withDeploy;
  app.factory.makePlannerProvider = () => withDeploy;
  try {
    const created = await post('/api/runs', { idea: 'Add a.txt', provider: 'offline', source: localSource('widgets') });
    const run = await finished(created.data.run.id);
    assert.equal(run.deployment, undefined);
    const denied = await post(`/api/runs/${run.id}/deploy`, {});
    assert.equal(denied.status, 403);
    assert.match(denied.data.error, /explicit authorization/);
    assert.notEqual((await post(`/api/runs/${run.id}/deploy`, { authorize: true })).status, 403);
  } finally {
    app.factory.makeProvider = old;
    app.factory.makePlannerProvider = old;
    app.previews.stopAll();
  }
});

test('the UI ships the Project section and the existing-project views', async () => {
  const html = await (await fetch(`${base}/`)).text();
  for (const marker of ['name="sourceMode" value="new" checked', 'value="local"', 'value="github"', 'id="directory-id"', 'id="src-summary"', 'id="idea-label"']) assert.ok(html.includes(marker), marker);
  const js = await (await fetch(`${base}/app.js`)).text();
  for (const marker of ['What do you want to change?', 'mountProjectPicker', 'renderDeliveryExisting', 'renderChangedFiles', 'api/projects/inspect']) assert.ok(js.includes(marker), marker);
});

test('project endpoints sit behind the same password as everything else', async () => {
  const locked = await createServer({ dataDir: tmpDir(), password: 's3cret', ...roots.cfg });
  await new Promise((r) => locked.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${locked.server.address().port}`;
  try {
    for (const p of ['/api/projects/directories', '/api/config']) assert.equal((await fetch(url + p)).status, 401, p);
    assert.equal((await fetch(`${url}/api/projects/inspect`, { method: 'POST', body: '{}' })).status, 401);
    const auth = { authorization: `Basic ${Buffer.from('u:s3cret').toString('base64')}` };
    assert.equal((await fetch(`${url}/api/projects/directories`, { headers: auth })).status, 200);
  } finally {
    await locked.close();
  }
});
