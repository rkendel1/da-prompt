import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { publishRun } from '../src/publish.js';
import { approve, makeRepo, makeRoot, makeRemote, startMockApi, dirId, git, writeFiles, setup, Scripted, task, plan, toolUse, done, PY_FILES } from './project-helpers.js';
import { tmpDir } from './helpers.js';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const apis = [];
after(() => Promise.all(apis.map((a) => a.close())));
const mockApi = async () => {
  const a = await startMockApi();
  apis.push(a);
  return a;
};

const writer = (files, { finalVerify = ['npm test'], verify = [] } = {}) => new Scripted({
  plan: () => plan([task('t', { verify })], { finalVerify }),
  task: ({ turn }) => (turn === 0 ? Object.entries(files).map(([p, content]) => toolUse('write_file', { path: p, content })) : [done('ok', Object.keys(files))]),
});
const NEW_FILES = { 'src/farewell.js': "export const farewell = (n) => `Bye ${n}`;\n" };

async function githubSetup({ files = NEW_FILES, token = TOKEN, source = {}, provider, remoteOpts } = {}) {
  const remote = makeRemote(undefined, remoteOpts);
  const api = await mockApi();
  const env = setup({ provider: provider || writer(files), cfg: { gitConfig: remote.insteadOf, githubToken: token, githubApiUrl: api.url } });
  const create = (extra = {}) => env.factory.createRun({ idea: 'Add a farewell helper', provider: 'offline', source: { mode: 'github', repoUrl: remote.url, ...source, ...extra } });
  return { remote, api, ...env, create };
}

test('publishing is explicit: with publish off nothing is pushed or opened, and a later explicit publish pushes only the run branch', async () => {
  const { remote, api, factory, create } = await githubSetup();
  const mainBefore = git(remote.bare, 'rev-parse', 'main');
  const run = await factory.start((await create()).id);
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.delivery.publication, undefined);
  assert.equal(api.calls.length, 0);
  assert.equal(git(remote.bare, 'branch', '--list').replace(/\*/g, '').trim(), 'main');

  await assert.rejects(factory.publish(run.id), /review the changes and approve them/);
  await approve(factory, run.id);
  const published = await factory.publish(run.id, { pullRequest: true });
  const pub = published.delivery.publication;
  assert.equal(pub.state, 'pr-created');
  assert.equal(pub.branch, `da-prompt/${run.id}`);
  assert.equal(pub.pr.number, 1);
  assert.equal(pub.pr.url, 'https://github.com/acme/widgets/pull/1');
  assert.equal(pub.pr.draft, false);
  // The remote has the run branch (one commit on top of main) and main did not move.
  assert.equal(git(remote.bare, 'rev-parse', 'main'), mainBefore);
  assert.equal(git(remote.bare, 'rev-parse', `da-prompt/${run.id}`), pub.sha);
  assert.equal(git(remote.bare, 'rev-list', '--count', `main..da-prompt/${run.id}`), '1');
  assert.equal(git(remote.bare, 'show', `da-prompt/${run.id}:src/farewell.js`), NEW_FILES['src/farewell.js'].trim());
  assert.deepEqual(git(remote.bare, 'diff', '--name-only', `main`, `da-prompt/${run.id}`).split('\n'), ['src/farewell.js']);
  // The pull request targets the selected base and describes the work truthfully.
  const post = api.calls.find((c) => c.method === 'POST');
  assert.equal(post.body.base, 'main');
  assert.equal(post.body.head, `da-prompt/${run.id}`);
  assert.equal(post.body.draft, false);
  assert.match(post.body.body, /## Goal\n\nAdd a farewell helper/);
  assert.match(post.body.body, /## Verification/);
  assert.match(post.body.body, /✅ `npm test`/);
  assert.equal(post.auth, `Bearer ${TOKEN}`);
});

test('publish:true on the run publishes at the end; the credential never reaches the run record, events, report or agent shell', async () => {
  process.env.GITHUB_TOKEN = TOKEN;
  try {
    const spy = new Scripted({
      plan: () => plan([task('t')]),
      task: ({ turn }) => (turn === 0 ? [toolUse('write_file', { path: 'src/farewell.js', content: 'export const f = 1;\n' }), toolUse('run_command', { command: 'env' })] : [done('ok')]),
    });
    const { remote, api, store, factory, create } = await githubSetup({ provider: spy, source: { publish: true } });
    const run = await factory.start((await create()).id);
    assert.equal(run.status, 'completed', JSON.stringify(run.delivery.publication));
    assert.equal(run.delivery.publication.state, 'pr-created');
    assert.equal(api.prs.length, 1);
    assert.equal(git(remote.bare, 'rev-list', '--count', `main..da-prompt/${run.id}`), '1');

    const dump = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? (e.name !== 'objects' && walk(path.join(d, e.name))) : dump.push(fs.readFileSync(path.join(d, e.name), 'utf8'))));
    walk(store.runDir(run.id));
    assert.ok(!dump.join('\n').includes(TOKEN), 'token must not be persisted anywhere in the run directory');
    assert.ok(!git(store.workspaceDir(run.id), 'config', '--list').includes(TOKEN));
    assert.equal(git(store.workspaceDir(run.id), 'remote', 'get-url', 'origin'), remote.url);
    const envOut = (await store.events(run.id)).find((e) => e.type === 'tool' && e.tool === 'run_command').output;
    assert.ok(!/GITHUB_TOKEN|ghp_/.test(envOut), 'the agent shell never sees the token');
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test('retrying delivery is idempotent: same branch, same commit, same pull request', async () => {
  const { remote, api, factory, create } = await githubSetup({ source: { publish: true } });
  const run = await factory.start((await create()).id);
  const first = run.delivery.publication;
  assert.equal(first.state, 'pr-created');
  const pushedAt = first.pushedAt;

  await approve(factory, run.id);
  const again = (await factory.publish(run.id)).delivery.publication;
  assert.equal(again.state, 'pr-exists');
  assert.equal(again.pr.number, 1);
  assert.equal(again.pr.reused, true);
  assert.equal(again.sha, first.sha);
  assert.equal(again.pushedAt, pushedAt, 'an unchanged branch is not pushed again');
  assert.equal(api.prs.length, 1);
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(git(remote.bare, 'branch', '--list').split('\n').length, 2); // main + the one run branch

});

test('resuming a run re-runs delivery without a second branch, commit or pull request', async () => {
  const { remote, api, factory, create } = await githubSetup({ provider: writer(NEW_FILES, { verify: ['test -s never-created.txt'] }), source: { publish: true } });
  const run = await factory.start((await create()).id);
  assert.equal(run.status, 'needs_attention');
  const first = run.delivery.publication;
  assert.equal(first.state, 'pr-created');

  await factory.resume(run.id);
  const resumed = await factory.active.get(run.id).promise;
  assert.equal(resumed.delivery.publication.state, 'pr-exists');
  assert.equal(resumed.delivery.publication.sha, first.sha);
  assert.equal(resumed.delivery.publication.pushedAt, first.pushedAt);
  assert.equal(api.prs.length, 1);
  assert.equal(git(remote.bare, 'rev-list', '--count', `main..da-prompt/${run.id}`), '1');
});

test('a pull-request failure is reported as such: the branch is pushed, verification is not misreported, and a retry opens the PR without re-pushing', async () => {
  const { remote, api, factory, create } = await githubSetup({ source: { publish: true } });
  api.failWith({ status: 403, message: 'Resource not accessible by personal access token' });
  const run = await factory.start((await create()).id);
  const pub = run.delivery.publication;
  assert.equal(run.status, 'completed', 'implementation verification is separate from publication');
  assert.equal(pub.state, 'pushed');
  assert.match(pub.prError, /Looking for an existing pull request: forbidden \(403\)/);
  assert.equal(pub.pr, undefined);
  assert.equal(git(remote.bare, 'rev-list', '--count', `main..da-prompt/${run.id}`), '1');
  const report = fs.readFileSync(path.join(factory.store.deliveryDir(run.id), 'FACTORY_REPORT.md'), 'utf8');
  assert.match(report, /Publication: \*\*pushed\*\* — .*forbidden \(403\)/);
  assert.doesNotMatch(report, /Pull request: http/);

  api.failWith(null);
  await approve(factory, run.id);
  const retried = (await factory.publish(run.id)).delivery.publication;
  assert.equal(retried.state, 'pr-created');
  assert.equal(retried.prError, undefined);
  assert.equal(retried.pushedAt, pub.pushedAt);
  assert.equal(api.prs.length, 1);
});

test('push problems are reported without claiming delivery: no token, a diverged remote branch, an unsupported base', async () => {
  // No credential configured.
  const a = await githubSetup({ token: '', source: { publish: true } });
  const runA = await a.factory.start((await a.create()).id);
  assert.equal(runA.status, 'completed');
  assert.equal(runA.delivery.publication.state, 'failed');
  assert.match(runA.delivery.publication.error, /GITHUB_TOKEN is not configured/);
  assert.ok(runA.delivery.patch && runA.delivery.archive, 'the patch is still delivered');
  assert.equal(a.api.calls.length, 0);

  // The remote already has a different branch with the run's name: it is never overwritten.
  const b = await githubSetup({ source: { publish: true } });
  const createdB = await b.create();
  git(b.remote.seed, 'checkout', '-q', '-b', `da-prompt/${createdB.id}`);
  writeFiles(b.remote.seed, { 'someone-else.txt': 'theirs' });
  git(b.remote.seed, 'add', '-A');
  git(b.remote.seed, 'commit', '-q', '-m', 'unrelated work');
  git(b.remote.seed, 'push', '-q', 'origin', `da-prompt/${createdB.id}`);
  const theirs = git(b.remote.bare, 'rev-parse', `da-prompt/${createdB.id}`);
  const runB = await b.factory.start(createdB.id);
  assert.equal(runB.delivery.publication.state, 'failed');
  assert.equal(runB.delivery.publication.step, 'push');
  assert.match(runB.delivery.publication.error, /already has a different da-prompt\/.*no force pushes/);
  assert.equal(git(b.remote.bare, 'rev-parse', `da-prompt/${createdB.id}`), theirs);
  assert.equal(b.api.calls.length, 0);

  // A tag base can be pushed but cannot be a pull request target.
  const c = await githubSetup({ source: { publish: true, ref: 'v1' } });
  git(c.remote.seed, 'tag', 'v1');
  git(c.remote.seed, 'push', '-q', 'origin', 'v1');
  const runC = await c.factory.start((await c.create()).id);
  assert.equal(runC.delivery.publication.state, 'pushed');
  assert.match(runC.delivery.publication.prError, /needs a branch to target; the selected ref is a tag/);
  assert.equal(c.api.prs.length, 0);
});

test('an unverified result is published as a draft pull request', async () => {
  const { api, factory, create } = await githubSetup({ provider: writer(NEW_FILES, { verify: ['test -s never-created.txt'] }), source: { publish: true } });
  const run = await factory.start((await create()).id);
  assert.equal(run.status, 'needs_attention');
  assert.equal(run.delivery.readiness.ready, false);
  assert.equal(run.delivery.publication.state, 'pr-created');
  assert.equal(run.delivery.publication.pr.draft, true);
  const body = api.calls.find((c) => c.method === 'POST').body;
  assert.equal(body.draft, true);
  assert.match(body.body, /## Outstanding/);
  assert.match(body.body, /Task `t` escalated/);
});

test('publishing refuses anything that is not a dedicated run branch, and never forces', async () => {
  const { factory, store, create, cfg } = await githubSetup();
  const run = await factory.start((await create()).id);
  const wsDir = store.workspaceDir(run.id);
  for (const branch of ['main', 'master', 'release']) {
    const forged = { ...run, source: { ...run.source, branch, baseBranch: 'main', defaultBranch: 'main' } };
    const r = await publishRun(cfg, forged, { wsDir });
    assert.equal(r.state, 'failed', branch);
    assert.match(r.error, /not a dedicated run branch/);
  }
  const src = fs.readFileSync(new URL('../src/publish.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /--force|-f\b|\+refs/, 'there is no force-push code path');
});

test('local-only runs never push or open pull requests', async () => {
  const api = await mockApi();
  const { cfg: rootCfg } = makeRoot({ app: (d) => fs.cpSync(makeRepo(), d, { recursive: true }) });
  const { cfg, factory } = setup({ provider: writer(NEW_FILES), cfg: { ...rootCfg, githubToken: TOKEN, githubApiUrl: api.url } });
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', source: { mode: 'local', directoryId: dirId(cfg, 'app'), publish: true } }), /local runs never push/);
  const run = await factory.start((await factory.createRun({ idea: 'x', provider: 'offline', source: { mode: 'local', directoryId: dirId(cfg, 'app') } })).id);
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.delivery.publication, undefined);
  await assert.rejects(factory.publish(run.id), /only GitHub-backed runs/);
  assert.equal(api.calls.length, 0);
  assert.match(fs.readFileSync(path.join(factory.store.deliveryDir(run.id), 'FACTORY_REPORT.md'), 'utf8'), /Publication: not applicable \(local runs never push\)/);
});

test('the patch and archive contain exactly the intended changes and apply cleanly to a fresh checkout of the base', async () => {
  const files = { 'src/farewell.js': 'export const f = 1;\n', 'README.md': '# widgets\nnow with farewell\n', 'docs/new/deep.md': 'deep\n' };
  const prov = new Scripted({
    plan: () => plan([task('t')]),
    task: ({ turn }) => (turn === 0 ? [...Object.entries(files).map(([p, content]) => toolUse('write_file', { path: p, content })), toolUse('run_command', { command: 'rm test/greet.test.js && mkdir -p build/out && echo junk > build/out/x.o' })] : [done('ok')]),
  });
  const { remote, store, factory, create } = await githubSetup({ provider: prov });
  const run = await factory.start((await create()).id);
  assert.equal(run.status, 'completed', JSON.stringify(run.checklist));

  // A file the agent created under build/ is a real new file, so it is part of the change; factory scratch files are not.
  const expected = ['A build/out/x.o', 'A docs/new/deep.md', 'A src/farewell.js', 'D test/greet.test.js', 'M README.md'];
  assert.deepEqual(run.changes.files.map((f) => `${f.status} ${f.path}`).sort(), expected);
  const dir = store.deliveryDir(run.id);
  const patch = path.join(dir, 'changes.patch');
  const text = fs.readFileSync(patch, 'utf8');
  assert.doesNotMatch(text, /\.home|PLAN\.md|CLAUDE\.md|FACTORY_REPORT|node_modules/);

  const fresh = tmpDir('da-prompt-fresh-');
  execFileSync('git', ['clone', '-q', remote.bare, fresh], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  execFileSync('git', ['apply', '--check', patch], { cwd: fresh });
  execFileSync('git', ['apply', patch], { cwd: fresh });
  assert.equal(fs.readFileSync(path.join(fresh, 'README.md'), 'utf8'), files['README.md']);
  assert.ok(!fs.existsSync(path.join(fresh, 'test/greet.test.js')));
  assert.equal(git(fresh, 'status', '--porcelain').split('\n').length, run.changes.files.length);

  // The archive holds the added/modified files only (deletions are listed separately), relative to the project root.
  const listed = execFileSync('tar', ['-tzf', path.join(dir, 'project.tar.gz')], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  assert.deepEqual(listed, run.changes.files.filter((f) => f.status !== 'D').map((f) => f.path).sort());
  assert.equal(fs.readFileSync(path.join(dir, 'DELETED_FILES.txt'), 'utf8').trim(), 'test/greet.test.js');
});

test('generated noise the project checks leave behind is not mistaken for the change', async () => {
  const { cfg: rootCfg } = makeRoot({ calc: (d) => fs.cpSync(makeRepo(PY_FILES), d, { recursive: true }) });
  const prov = new Scripted({
    plan: () => plan([task('t', { verify: ['python3 -m unittest discover -q'] })], { finalVerify: ['python3 -m unittest discover -q'] }),
    task: ({ turn }) => (turn === 0 ? [toolUse('write_file', { path: 'calc.py', content: 'def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n' })] : [done('added mul')]),
  });
  const { cfg, store, factory } = setup({ provider: prov, cfg: rootCfg });
  const run = await factory.start((await factory.createRun({ idea: 'add mul', provider: 'offline', source: { mode: 'local', directoryId: dirId(cfg, 'calc') } })).id);
  assert.equal(run.status, 'completed', JSON.stringify(run.checklist));
  assert.ok(fs.existsSync(path.join(store.workspaceDir(run.id), '__pycache__')), 'the checks did run and leave a cache');
  assert.deepEqual(run.changes.files.map((f) => f.path), ['calc.py']);
});
