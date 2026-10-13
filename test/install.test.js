// Dependency installs for existing projects: the baseline only means something if the project's dependencies are there.
// A fake `npm` on the PATH stands in for the network: `npm test` fails with "Cannot find module" until node_modules exists.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installCommands } from '../src/project.js';
import { Workspace } from '../src/sandbox.js';
import { startRegistryBackend, initRepo } from './registry-helpers.js';
import { tmpDir, waitFor } from './helpers.js';

const bin = tmpDir('fake-npm-');
const oldPath = process.env.PATH;
before(() => {
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
echo "npm $*" >> "$FAKE_NPM_LOG"
case "$1" in
  ci) if [ -f FAIL_CI ]; then echo "npm ERR! lockfile out of sync" >&2; exit 1; fi; mkdir -p node_modules; exit 0 ;;
  install) mkdir -p node_modules; exit 0 ;;
  test) if [ -d node_modules ]; then echo "ok"; exit 0; fi; echo "Error: Cannot find module 'left-pad'" >&2; exit 1 ;;
esac
exit 0
`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  process.env.FAKE_NPM_LOG = path.join(bin, 'log.txt');
});
after(() => { process.env.PATH = oldPath; delete process.env.FAKE_NPM_LOG; });

const files = (extra = {}) => ({ 'package.json': JSON.stringify({ name: 'widgets', version: '1.0.0', scripts: { test: 'node t.js' }, dependencies: { 'left-pad': '1.0.0' } }), 'README.md': '# widgets\n', ...extra });
const boot = async (projectFiles) => {
  const be = await startRegistryBackend({ roots: { widgets: (d) => initRepo(d, { files: projectFiles }) } });
  be.p = await be.register('widgets', { name: 'Widgets' });
  return be;
};
const start = async (be, body) => {
  const r = await be.call('POST', '/api/runs', { idea: 'add a note', provider: 'offline', settings: { deploy: false }, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await waitFor(async () => { const x = (await be.call('GET', `/api/runs/${r.body.run.id}`)).body.run; return ['completed', 'needs_attention', 'failed'].includes(x.status) && !x.executing; }, { timeoutMs: 90_000 });
  return (await be.call('GET', `/api/runs/${r.body.run.id}`)).body.run;
};
const log = () => (fs.existsSync(process.env.FAKE_NPM_LOG) ? fs.readFileSync(process.env.FAKE_NPM_LOG, 'utf8') : '');

test('which install commands are used for what the inspection found', async () => {
  const ws = (names) => { const d = tmpDir('ws-'); for (const [n, c] of Object.entries(names)) { fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true }); fs.writeFileSync(path.join(d, n), c); } return new Workspace(d); };
  const insp = (extra = {}) => ({ ecosystems: ['node'], manifests: [{ path: 'package.json' }], commands: { hasDependencies: true, packageManager: 'npm' }, ...extra });
  assert.deepEqual(installCommands(insp(), ws({ 'package.json': '{}', 'package-lock.json': '{}' })).map((c) => [c.command, c.fallback]), [['npm ci', 'npm install']]);
  assert.deepEqual(installCommands(insp(), ws({ 'package.json': '{}' })).map((c) => [c.command, c.fallback]), [['npm install', undefined]]);
  assert.deepEqual(installCommands(insp({ commands: { hasDependencies: true, packageManager: 'pnpm' } }), ws({ 'package.json': '{}' })).map((c) => c.command), ['pnpm install --frozen-lockfile']);
  assert.deepEqual(installCommands(insp(), ws({ 'package.json': '{}', 'node_modules/x/index.js': '' })), [], 'already installed: nothing to do');
  assert.deepEqual(installCommands(insp({ commands: { hasDependencies: false } }), ws({ 'package.json': '{}' })), [], 'nothing to install');
  const many = installCommands({ ecosystems: ['rust', 'go', 'ruby', 'php'], manifests: ['Cargo.toml', 'go.mod', 'Gemfile', 'composer.json'].map((path) => ({ path })), commands: {} }, ws({}));
  assert.deepEqual(many.map((c) => c.command), ['cargo fetch', 'go mod download', 'bundle install', 'composer install --no-interaction']);
});

test('with installs off the baseline cannot run and says exactly how to fix it; with installs on they happen first', async () => {
  const be = await boot(files({ 't.js': '' }));
  try {
    const off = await start(be, { source: { projectId: be.p.id, allowInstall: false } });
    assert.equal(off.source.allowInstall, false);
    assert.deepEqual(off.project.install, []);
    const b = off.project.baseline[0];
    assert.equal(b.status, 'failed');
    assert.match(b.limitation, /installing them is off for this run — re-run with dependency installs allowed/);
    assert.ok(!/npm (install|ci)/.test(log()), 'nothing was installed');

    const on = await start(be, { source: { projectId: be.p.id, allowInstall: true } });
    assert.deepEqual(on.project.install.map((i) => [i.command, i.status]), [['npm install', 'passed']]);
    assert.equal(on.project.baseline[0].status, 'passed');
    assert.equal(on.project.baseline[0].limitation, null);
    assert.match(log(), /npm install/);
    // The install happened in the isolated workspace; the source directory was never touched.
    assert.ok(!fs.existsSync(path.join(be.roots.dirs.widgets, 'node_modules')));
    assert.ok(fs.existsSync(path.join(be.store.workspaceDir(on.id), 'node_modules')));
    // node_modules is not part of the change.
    assert.ok(!(on.changes?.files || []).some((f) => /node_modules/.test(f.path)));
    assert.ok((await be.store.events(on.id)).some((e) => e.type === 'install' && e.status === 'passed' && e.command === 'npm install'));
  } finally { await be.close(); }
});

test('a stale lockfile falls back to a plain install instead of leaving the baseline unrunnable', async () => {
  const be = await boot(files({ 't.js': '', 'package-lock.json': '{}', FAIL_CI: '1' }));
  try {
    const before = log().length;
    const run = await start(be, { source: { projectId: be.p.id, allowInstall: true } });
    assert.deepEqual(run.project.install.map((i) => [i.command, i.status]), [['npm install', 'passed']], 'the recorded command is the one that worked');
    assert.match(log().slice(before), /npm ci[\s\S]*npm install/);
    assert.equal(run.project.baseline[0].status, 'passed');
  } finally { await be.close(); }
});

test('the install default comes from the project, then the server; a run can always say otherwise', async () => {
  const be = await boot(files({ 't.js': '' }));
  try {
    assert.equal((await start(be, { source: { projectId: be.p.id } })).source.allowInstall, false, 'off unless asked for');
    const set = await be.call('PATCH', `/api/projects/${be.p.id}`, { allowInstall: true });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.project.settings.allowInstall, true);
    assert.equal((await start(be, { source: { projectId: be.p.id } })).source.allowInstall, true, 'the project says yes');
    assert.equal((await start(be, { source: { projectId: be.p.id, allowInstall: false } })).source.allowInstall, false, 'this run says no');
    assert.equal((await be.call('PATCH', `/api/projects/${be.p.id}`, { allowInstall: 'yes' })).status, 400);
    assert.equal((await be.call('PATCH', `/api/projects/${be.p.id}`, { allowInstall: null })).body.project.settings.allowInstall, undefined, 'null goes back to the server default');
    // Server-wide default.
    be.app.cfg.defaults.allowInstall = true;
    assert.equal((await start(be, { source: { projectId: be.p.id } })).source.allowInstall, true);
    be.app.cfg.defaults.allowInstall = false;
  } finally { await be.close(); }
});

test('re-run with installs allowed starts a NEW run with the same request and leaves the first one alone', async () => {
  const be = await boot(files({ 't.js': '' }));
  try {
    const first = await start(be, { idea: 'add a note about X', requirements: 'be brief', source: { projectId: be.p.id, allowInstall: false } });
    assert.equal(first.project.baseline[0].status, 'failed');
    const r = await be.call('POST', `/api/runs/${first.id}/rerun`, { allowInstall: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const second = await waitFor(async () => { const x = (await be.call('GET', `/api/runs/${r.body.run.id}`)).body.run; return ['completed', 'needs_attention', 'failed'].includes(x.status) && !x.executing && x; }, { timeoutMs: 90_000 });
    assert.notEqual(second.id, first.id);
    assert.equal(second.inputs.idea, 'add a note about X');
    assert.equal(second.inputs.requirements, 'be brief');
    assert.equal(second.projectId, be.p.id);
    assert.equal(second.source.allowInstall, true);
    assert.equal(second.project.baseline[0].status, 'passed');
    const again = (await be.call('GET', `/api/runs/${first.id}`)).body.run;
    assert.equal(again.source.allowInstall, false);
    assert.equal(again.project.baseline[0].status, 'failed', 'the original is exactly as it was');
    // Only runs against an existing project can be re-run this way.
    const fresh = await be.call('POST', '/api/runs', { idea: 'A packing list', provider: 'offline', settings: { deploy: false } });
    assert.equal((await be.call('POST', `/api/runs/${fresh.body.run.id}/rerun`, {})).status, 409);
  } finally { await be.close(); }
});
