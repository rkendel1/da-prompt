import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { tmpDir } from './helpers.js';
import { resolveDirectory, listDirectories, directoryIdForPath, authorizedRoots, parseRepoUrl, validateRef, inspectRemote, normalizeSource, gitState } from '../src/project.js';
import { makeRepo, makeRoot, makeRemote, dirId, git, writeFiles, setup, Scripted, task, plan, toolUse, done, PY_FILES } from './project-helpers.js';

test('new-project runs are unchanged: no source, or source mode "new", behaves exactly as before', async () => {
  const { factory } = setup();
  const a = await factory.createRun({ idea: 'A tiny app', provider: 'offline', start: false });
  const b = await factory.createRun({ idea: 'A tiny app', provider: 'offline', source: { mode: 'new' } });
  for (const run of [a, b]) {
    assert.equal(run.source, undefined);
    assert.equal(run.project, undefined);
    assert.match(run.inputs.stack, /Node\.js/);
  }
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', source: { mode: 'ftp' } }), /source\.mode/);
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', source: 'local' }), /source must be an object/);
});

test('local directories: only server-authorized ids resolve, and ids never contain server paths', async () => {
  const { root, dirs, cfg: rootCfg } = makeRoot({ app: (d) => fs.cpSync(makeRepo(), d, { recursive: true }), plain: (d) => writeFiles(d, PY_FILES) });
  const cfg = loadConfig({ dataDir: tmpDir(), ...rootCfg });
  const id = dirId(cfg, 'app');
  assert.ok(!id.includes(root));
  const dir = resolveDirectory(cfg, id);
  assert.equal(dir.real, dirs.app);
  assert.equal(dir.readOnly, false);

  // The list names directories but never exposes filesystem paths.
  const listing = await listDirectories(cfg);
  const body = JSON.stringify(listing);
  assert.ok(!body.includes(root) && !body.includes(path.dirname(root)));
  const app = listing.directories.find((d) => d.name === 'app');
  assert.equal(app.git.isGit, true);
  assert.equal(app.git.branch, 'main');
  assert.equal(app.git.dirty, false);
  assert.equal(listing.directories.find((d) => d.name === 'plain').git.isGit, false);

  // Unauthorized or malformed references are refused; a raw path is never an id.
  for (const bad of [undefined, '', dirs.app, `${dirs.app}:`, 'deadbeef00:app', '0123456789:app', 'zz', `${id.split(':')[0]}:nope`]) {
    assert.throws(() => resolveDirectory(cfg, bad), (e) => [400, 403, 404].includes(e.status), String(bad));
  }
  assert.throws(() => resolveDirectory(loadConfig({ dataDir: tmpDir() }), id), /not authorized/);
  await assert.rejects(setup({ cfg: {} }).factory.createRun({ idea: 'x', provider: 'offline', source: { mode: 'local', directoryId: id } }), /not authorized/);
});

test('path traversal and symlinks cannot escape an authorized root', async () => {
  const outside = fs.realpathSync(tmpDir('da-prompt-outside-'));
  writeFiles(outside, { 'secret.txt': 's3cret' });
  const { root, cfg: rootCfg } = makeRoot({ app: (d) => writeFiles(d, PY_FILES) });
  fs.symlinkSync(outside, path.join(root, 'escape'));
  fs.symlinkSync(path.join(root, 'app'), path.join(root, 'alias'));
  const cfg = loadConfig({ dataDir: tmpDir(), ...rootCfg });
  const key = authorizedRoots(cfg)[0].key;

  for (const rel of ['../x', 'app/../../x', '..', '.', 'app/./x', '/etc', 'a//b', 'app\\..\\x', 'ap\0p']) {
    assert.throws(() => resolveDirectory(cfg, `${key}:${rel}`), (e) => e.status === 403 || e.status === 404, rel);
  }
  assert.throws(() => resolveDirectory(cfg, `${key}:escape`), /outside its authorized root/);
  assert.equal(resolveDirectory(cfg, `${key}:alias`).real, path.join(root, 'app')); // a symlink that stays inside the root is fine

  const listed = (await listDirectories(cfg)).directories.map((d) => d.name);
  assert.ok(!listed.includes('escape'), 'escaping symlink must not be offered');
  await assert.rejects(setup({ cfg: rootCfg }).factory.createRun({ idea: 'x', provider: 'offline', source: { mode: 'local', directoryId: `${key}:escape` } }), /outside its authorized root/);
  // CLI-style path mapping uses the same rules.
  assert.throws(() => directoryIdForPath(cfg, outside), /not inside an authorized root/);
  assert.throws(() => directoryIdForPath(cfg, path.join(root, 'escape')), /not inside an authorized root/);
  assert.equal(directoryIdForPath(cfg, path.join(root, 'app')), `${key}:app`);
  assert.equal(directoryIdForPath(cfg, `${key}:app`), `${key}:app`);
  assert.throws(() => directoryIdForPath(loadConfig({ dataDir: tmpDir() }), root), /FACTORY_PROJECT_ROOTS/);
  assert.throws(() => resolveDirectory(loadConfig({ dataDir: tmpDir(), projectRoots: ['/'] }), `${key}:x`), /not authorized/); // the filesystem root is never a root
});

test('a project that overlaps the factory data directory is refused', () => {
  const { root, cfg: rootCfg } = makeRoot({ app: (d) => writeFiles(d, PY_FILES) });
  const data = path.join(root, 'app', 'data');
  const cfg = loadConfig({ dataDir: data, ...rootCfg });
  assert.throws(() => resolveDirectory(cfg, dirId(cfg, 'app')), /overlaps the factory data directory/);
});

test('read-only roots can be inspected but are flagged read-only', async () => {
  const { cfg: rootCfg } = makeRoot({ app: (d) => fs.cpSync(makeRepo(), d, { recursive: true }) }, { readOnly: true });
  const cfg = loadConfig({ dataDir: tmpDir(), ...rootCfg });
  const id = dirId(cfg, 'app');
  assert.equal(resolveDirectory(cfg, id).readOnly, true);
  const listing = await listDirectories(cfg);
  assert.equal(listing.directories[0].readOnly, true);
  assert.equal(normalizeSource(cfg, { mode: 'local', directoryId: id }).readOnly, true);
});

test('git state: branch, HEAD, working-tree status and remotes (credentials redacted) are reported without modifying the repo', async () => {
  const repo = makeRepo();
  git(repo, 'remote', 'add', 'origin', 'https://user:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/acme/widgets.git');
  fs.appendFileSync(path.join(repo, 'README.md'), 'edit\n');
  writeFiles(repo, { 'new.txt': 'x' });
  git(repo, 'add', 'new.txt');
  const indexBefore = fs.statSync(path.join(repo, '.git', 'index')).mtimeMs;
  const g = await gitState(loadConfig({ dataDir: tmpDir() }), repo);
  assert.equal(g.isGit, true);
  assert.equal(g.branch, 'main');
  assert.equal(g.head, git(repo, 'rev-parse', 'HEAD'));
  assert.equal(g.dirty, true);
  assert.deepEqual(g.counts, { staged: 1, unstaged: 1, untracked: 0 });
  assert.ok(g.changedFiles.some((f) => f.path === 'README.md'));
  assert.ok(!JSON.stringify(g.remotes).includes('ghp_'));
  assert.equal(fs.statSync(path.join(repo, '.git', 'index')).mtimeMs, indexBefore, 'inspection must not rewrite the index');
  // A subdirectory of a repository is not itself a repository.
  fs.mkdirSync(path.join(repo, 'sub'));
  assert.equal((await gitState(loadConfig({ dataDir: tmpDir() }), path.join(repo, 'sub'))).isGit, false);
});

test('GitHub URLs and refs are validated before anything touches the network', () => {
  const cfg = loadConfig({ dataDir: tmpDir() });
  assert.deepEqual(parseRepoUrl(cfg, 'acme/widgets'), { host: 'github.com', owner: 'acme', repo: 'widgets', url: 'https://github.com/acme/widgets.git', webUrl: 'https://github.com/acme/widgets' });
  assert.equal(parseRepoUrl(cfg, 'https://github.com/acme/widgets.git').repo, 'widgets');
  assert.equal(parseRepoUrl(cfg, 'https://GitHub.com/acme/widgets').url, 'https://github.com/acme/widgets.git');
  const bad = {
    'http://github.com/acme/widgets': /https/,
    'git@github.com:acme/widgets.git': /valid URL/,
    'ssh://github.com/acme/widgets': /https/,
    'file:///etc/passwd': /https/,
    'https://user:pw@github.com/acme/widgets': /credentials/,
    'https://github.com:8443/acme/widgets': /plain/,
    'https://github.com/acme/widgets?x=1': /plain/,
    'https://github.com/acme': /<owner>\/<repo>/,
    'https://github.com/acme/widgets/tree/main': /<owner>\/<repo>/,
    'https://evil.example/acme/widgets': /not enabled/,
    'https://github.com/../widgets': /<owner>\/<repo>|invalid/,
    '': /valid URL/,
  };
  for (const [url, re] of Object.entries(bad)) assert.throws(() => parseRepoUrl(cfg, url), re, url);
  assert.equal(parseRepoUrl(loadConfig({ dataDir: tmpDir(), gitHosts: ['ghe.example.com'] }), 'https://ghe.example.com/a/b').host, 'ghe.example.com');

  assert.equal(validateRef(''), '');
  assert.equal(validateRef('feature/login-2'), 'feature/login-2');
  assert.equal(validateRef('v1.2.3'), 'v1.2.3');
  assert.equal(validateRef('0123abc'), '0123abc');
  for (const r of ['--upload-pack=evil', '-x', 'a..b', 'a b', 'a;rm', 'a/', 'x.lock', '$(id)', 'a\nb', 'x'.repeat(201), 'a//b']) assert.throws(() => validateRef(r), /not a valid branch/, JSON.stringify(r));
});

test('GitHub sources: reachable repos resolve their default branch and ref; missing refs and repos fail with actionable messages', async () => {
  const remote = makeRemote(undefined, { branches: ['feature-x'] });
  git(remote.seed, 'tag', 'v1');
  git(remote.seed, 'push', '-q', 'origin', 'v1');
  const cfg = loadConfig({ dataDir: tmpDir(), gitConfig: remote.insteadOf });
  const info = await inspectRemote(cfg, { repoUrl: remote.url });
  assert.equal(info.defaultBranch, 'main');
  assert.deepEqual(info.selected, { kind: 'default', name: 'main', sha: git(remote.seed, 'rev-parse', 'main') });
  assert.deepEqual(info.branches.sort(), ['feature-x', 'main']);
  assert.equal((await inspectRemote(cfg, { repoUrl: remote.url, ref: 'feature-x' })).selected.kind, 'branch');
  assert.equal((await inspectRemote(cfg, { repoUrl: remote.url, ref: 'v1' })).selected.kind, 'tag');
  assert.equal((await inspectRemote(cfg, { repoUrl: remote.url, ref: git(remote.seed, 'rev-parse', '--short', 'main') })).selected.kind, 'commit');

  await assert.rejects(inspectRemote(cfg, { repoUrl: remote.url, ref: 'no-such-branch' }), (e) => e.status === 404 && /ref "no-such-branch" was not found/.test(e.message) && /branches include: .*main/.test(e.message));
  await assert.rejects(inspectRemote(cfg, { repoUrl: 'https://github.com/acme/missing' }), (e) => /repository not found|authentication/.test(e.message));
  // createRun surfaces the same errors before any workspace exists.
  const { factory } = setup({ cfg: { gitConfig: remote.insteadOf } });
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', source: { mode: 'github', repoUrl: remote.url, ref: 'nope' } }), /was not found/);
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', source: { mode: 'github', repoUrl: 'http://github.com/a/b' } }), /https/);
  await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', source: { mode: 'github', repoUrl: remote.url, workingMode: 'snapshot' } }), /isolated clone/);
});

test('network failures and an unusable git are reported with actionable messages', async () => {
  const cfg = loadConfig({ dataDir: tmpDir(), gitConfig: [['url.http://127.0.0.1:1/.insteadOf', 'https://github.com/'], ['http.proxy', '']] });
  await assert.rejects(inspectRemote(cfg, { repoUrl: 'acme/widgets' }), (e) => e.status === 502 && /network error/.test(e.message));

  const savedPath = process.env.PATH;
  const { cfg: rootCfg } = makeRoot({ app: (d) => writeFiles(d, PY_FILES) });
  const { factory, cfg: c2 } = setup({ cfg: rootCfg });
  try {
    process.env.PATH = tmpDir('da-prompt-nogit-');
    await assert.rejects(factory.createRun({ idea: 'x', provider: 'offline', source: { mode: 'local', directoryId: dirId(c2, 'app') } }), (e) => e.status === 500 && /git is not installed/.test(e.message));
    await assert.rejects(inspectRemote(c2, { repoUrl: 'acme/widgets' }), /git is not installed/);
  } finally {
    process.env.PATH = savedPath;
  }
});

test('an empty repository cannot be cloned for changes and a bare folder falls back to a snapshot', async () => {
  const empty = fs.realpathSync(tmpDir('da-prompt-empty-'));
  git(empty, 'init', '-q', '-b', 'main');
  const { dirs, cfg: rootCfg } = makeRoot({ empty: (d) => fs.cpSync(empty, d, { recursive: true }) });
  const { factory, cfg, store } = setup({ cfg: rootCfg, provider: new Scripted({ plan: () => plan([task('t')], { finalVerify: [] }), task: ({ turn }) => (turn === 0 ? [toolUse('write_file', { path: 'a.txt', content: 'hi' })] : [done('ok')]) }) });
  const forced = await factory.createRun({ idea: 'add a.txt', provider: 'offline', source: { mode: 'local', directoryId: dirId(cfg, 'empty'), workingMode: 'clone' } });
  const failed = await factory.start(forced.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /no commits/);
  assert.equal(failed.project.stages.connect.state, 'failed');
  assert.ok(!failed.error.includes(dirs.empty), 'errors never contain the server path');

  const auto = await factory.createRun({ idea: 'add a.txt', provider: 'offline', source: { mode: 'local', directoryId: dirId(cfg, 'empty') } });
  assert.equal(auto.source.workingMode, '');
  const run = await factory.start(auto.id);
  assert.equal(run.source.workingMode, 'snapshot');
  assert.deepEqual(run.changes.files.map((f) => f.path), ['a.txt']);
  assert.ok(fs.existsSync(path.join(store.workspaceDir(run.id), 'a.txt')));
  assert.deepEqual(fs.readdirSync(dirs.empty).sort(), ['.git']);
});
