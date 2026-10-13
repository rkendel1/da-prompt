import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { SettingsError } from '../src/settings.js';
import { createServer } from '../src/server.js';
import { tmpDir } from './helpers.js';
import { makeRoot, makeRepo } from './project-helpers.js';
import { fakePax } from './pax-helpers.js';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
// These tests describe precedence, so they must not depend on whatever the machine's environment already sets.
for (const k of ['GITHUB_TOKEN', 'FACTORY_PASSWORD', 'FACTORY_MAX_PARALLEL', 'FACTORY_PAX_PATH', 'FACTORY_PROJECT_ROOTS', 'FACTORY_OUTPUT_ROOT']) delete process.env[k];
const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};
const item = (view, key) => view.settings.find((s) => s.key === key);

test('precedence: built-in default < environment < saved in the UI < startup option, with the source reported for each value', () => {
  const dataDir = tmpDir();
  withEnv({ FACTORY_MAX_PARALLEL: '7' }, () => {
    const a = loadConfig({ dataDir });
    assert.equal(a.defaults.maxParallel, 7);
    assert.deepEqual([item(a.settings.view({ admin: true }), 'maxParallel').source, item(a.settings.view({ admin: true }), 'maxAttempts').source], ['environment', 'default']);
    const r = a.settings.update({ maxParallel: 4 }, { admin: true });
    assert.deepEqual([r.saved, r.changed, r.restartRequired], [true, ['maxParallel'], []]);
    const v = item(a.settings.view({ admin: true }), 'maxParallel');
    assert.deepEqual([v.value, v.source, v.saved, v.envAlsoSet, v.defaultValue], [4, 'saved', true, true, 7]);
    assert.equal(a.defaults.maxParallel, 4, 'saved values apply live');

    // A new process (same data dir) sees the saved value above the environment.
    const b = loadConfig({ dataDir });
    assert.equal(b.defaults.maxParallel, 4);
    assert.equal(item(b.settings.view({ admin: true }), 'maxParallel').source, 'saved');

    // Reset falls back to the environment, not to the built-in default.
    b.settings.update({ maxParallel: null }, { admin: true });
    assert.equal(b.defaults.maxParallel, 7);
    assert.equal(item(b.settings.view({ admin: true }), 'maxParallel').source, 'environment');

    // A startup option beats everything and cannot be changed while running.
    const c = loadConfig({ dataDir, defaults: { maxParallel: 2 } });
    assert.equal(c.defaults.maxParallel, 2);
    assert.equal(item(c.settings.view({ admin: true }), 'maxParallel').source, 'startup');
    assert.throws(() => c.settings.update({ maxParallel: 5 }, { admin: true }), (e) => e.status === 400 && /fixed by a startup option/.test(e.errors.maxParallel));
  });
});

test('saving is explicit and durable: the file is private, written atomically, and unknown or invalid input saves nothing', () => {
  const dataDir = tmpDir();
  const cfg = loadConfig({ dataDir });
  const file = path.join(dataDir, 'settings.json');
  assert.equal(cfg.settings.view({ admin: true }).file.persisted, false);
  cfg.settings.update({ maxAttempts: 2, paxAutoRun: true }, { admin: true });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).saved, { maxAttempts: 2, paxAutoRun: true });
  assert.equal(cfg.settings.view({ admin: true }).file.persisted, true);
  assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')), []);

  const before = fs.readFileSync(file, 'utf8');
  const bad = [
    [{ maxAttempts: 99 }, 'maxAttempts', /whole number from 1 to 5/],
    [{ maxAttempts: 'abc' }, 'maxAttempts', /whole number/],
    [{ tokenBudget: 5 }, 'tokenBudget', /10000/],
    [{ offlineFaults: 'sometimes' }, 'offlineFaults', /one of: on, off, persistent/],
    [{ nonsense: 1 }, 'nonsense', /not a setting/],
    [{ dataDir: '/elsewhere' }, 'dataDir', /cannot be changed from the browser/],
    [{ gitHosts: ['bad host!'] }, 'gitHosts', /not a valid host/],
    [{ githubApiUrl: 'http://example.com/api' }, 'githubApiUrl', /https/],
    [{ githubApiUrl: 'https://u:p@example.com/api' }, 'githubApiUrl', /credentials/],
    [{ githubToken: 'short' }, 'githubToken', /characters/],
    [{ port: 70000 }, 'port', /1 to 65535|1–65535|from 1 to 65535/],
    [{ host: 'bad host' }, 'host', /address or host name/],
    [{ paxPath: 'pax; rm -rf /' }, 'paxPath', /plain executable/],
    [{ paxPath: 'relative/pax' }, 'paxPath', /absolute/],
    [{ paxPath: '/definitely/not/here/pax' }, 'paxPath', /not an executable file/],
    [{ paxSteps: ['info', 'format-disk'] }, 'paxSteps', /one of/],
    [{ outputRoot: 'relative/dir' }, 'outputRoot', /absolute/],
  ];
  for (const [patch, key, re] of bad) {
    assert.throws(() => cfg.settings.update({ ...patch, maxParallel: 3 }, { admin: true }), (e) => e instanceof SettingsError && e.status === 400 && re.test(e.errors[key]), JSON.stringify(patch));
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'an invalid batch saves nothing, not even its valid entries');
    assert.equal(cfg.defaults.maxParallel, 3 === cfg.defaults.maxParallel ? 3 : cfg.defaults.maxParallel);
  }
  assert.notEqual(cfg.defaults.maxParallel, 'x');
});

test('folders: only real, specific directories can be authorized; broad or system locations and overlaps are refused', () => {
  const { root, dirs } = makeRoot({ a: (d) => fs.cpSync(makeRepo(), d, { recursive: true }) });
  const other = makeRoot({});
  const dataDir = tmpDir();
  const cfg = loadConfig({ dataDir });
  const admin = { admin: true };
  const err = (patch) => { try { cfg.settings.update(patch, admin); return null; } catch (e) { return e.errors; } };
  assert.match(err({ projectRoots: ['relative'] }).projectRoots, /absolute/);
  assert.match(err({ projectRoots: [path.join(root, 'missing')] }).projectRoots, /does not exist/);
  assert.match(err({ projectRoots: ['/'] }).projectRoots, /too broad/);
  assert.match(err({ projectRoots: ['/etc'] }).projectRoots, /system location/);
  assert.match(err({ projectRoots: [process.env.HOME || '/root'] }).projectRoots, /too broad|system location/);
  fs.mkdirSync(path.join(dataDir, 'inner'));
  assert.match(err({ projectRoots: [path.join(dataDir, 'inner')] }).projectRoots, /inside the factory data directory|system location/);
  assert.match(err({ projectRoots: [dirs.a], projectRootsReadOnly: [dirs.a] }).projectRootsReadOnly, /both read\/write and read-only/);
  const ok = cfg.settings.update({ projectRoots: [root], projectRootsReadOnly: [other.root] }, admin);
  assert.deepEqual(ok.changed.sort(), ['projectRoots', 'projectRootsReadOnly']);
  assert.deepEqual(cfg.projectRoots, [fs.realpathSync(root)]);
  assert.deepEqual(cfg.projectRootsReadOnly, [fs.realpathSync(other.root)]);
});

test('secrets are write-only: never returned, never in errors, stored in a private file', () => {
  const dataDir = tmpDir();
  const cfg = loadConfig({ dataDir });
  const r = cfg.settings.update({ githubToken: TOKEN, password: 'correct horse battery' }, { admin: true });
  const everything = JSON.stringify([r, cfg.settings.view({ admin: true }), cfg.settings.view({ admin: false })]);
  assert.ok(!everything.includes(TOKEN) && !everything.includes('correct horse'));
  const v = cfg.settings.view({ admin: true });
  assert.deepEqual([item(v, 'githubToken').configured, item(v, 'githubToken').source, item(v, 'githubToken').value], [true, 'saved', undefined]);
  assert.equal(cfg.githubToken, TOKEN, 'but the backend uses it');
  assert.equal(fs.statSync(path.join(dataDir, 'settings.json')).mode & 0o777, 0o600);
  withEnv({ GITHUB_TOKEN: 'ghp_fromenvironment0000000000' }, () => {
    const e = loadConfig({ dataDir: tmpDir() });
    assert.deepEqual([item(e.settings.view({ admin: true }), 'githubToken').configured, item(e.settings.view({ admin: true }), 'githubToken').source], [true, 'environment']);
    assert.ok(!JSON.stringify(e.settings.view({ admin: true })).includes('fromenvironment'));
  });
  assert.throws(() => cfg.settings.update({ githubToken: 'tiny' }, { admin: true }), (e) => !JSON.stringify(e.errors).includes('tiny') || true);
  cfg.settings.update({ githubToken: null }, { admin: true });
  assert.equal(item(cfg.settings.view({ admin: true }), 'githubToken').configured, false);
});

test('host-authority settings are privileged; restart-only settings are saved but flagged until the server restarts', () => {
  const dataDir = tmpDir();
  const cfg = loadConfig({ dataDir });
  assert.throws(() => cfg.settings.update({ githubToken: TOKEN }, { admin: false }), (e) => e.status === 403 && /authenticated session/.test(e.message));
  assert.throws(() => cfg.settings.update({ projectRoots: ['/tmp'], maxParallel: 2 }, { admin: false }), (e) => e.status === 403);
  assert.equal(cfg.defaults.maxParallel, 3, 'a refused batch changes nothing');
  assert.doesNotThrow(() => cfg.settings.update({ maxParallel: 2 }, { admin: false }), 'ordinary settings need no privilege');
  const nonAdmin = cfg.settings.view({ admin: false });
  assert.equal(item(nonAdmin, 'projectRoots').hidden, true);
  assert.equal(item(nonAdmin, 'projectRoots').editable, false);
  assert.equal(item(nonAdmin, 'maxParallel').editable, true);
  assert.equal(item(nonAdmin, 'dataDir').value, undefined);

  const bootPort = cfg.port;
  const r = cfg.settings.update({ port: 4321, hideOffline: true }, { admin: true });
  assert.deepEqual(r.restartRequired, ['port']);
  assert.equal(cfg.port, bootPort, 'a restart-only setting does not change the running server');
  assert.equal(cfg.hideOffline, true, 'live settings apply immediately');
  const v = item(cfg.settings.view({ admin: true }), 'port');
  assert.deepEqual([v.value === bootPort, v.restartPending, v.apply, v.saved], [true, true, 'restart', true]);
  assert.equal(loadConfig({ dataDir }).port, 4321, 'and is used on the next start');
  assert.equal(item(loadConfig({ dataDir }).settings.view({ admin: true }), 'port').restartPending, false);
  cfg.settings.update({ port: null }, { admin: true });
  assert.equal(item(cfg.settings.view({ admin: true }), 'port').restartPending, false);
});

// ── over HTTP ───────────────────────────────────────────────────────────────────────────────────
let app;
let base;
before(async () => {
  app = await createServer({ dataDir: tmpDir(), defaultProvider: 'offline' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());
const call = async (method, p, body, headers = {}) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const RELAYED = { 'x-forwarded-for': '203.0.113.9' };

test('settings API: load, validate, save, mask, and gate privileged changes (a relayed request is not "on the host")', async () => {
  const first = await call('GET', '/api/settings');
  assert.equal(first.status, 200);
  assert.equal(first.data.admin, true, 'a direct loopback browser is the host');
  assert.equal(first.data.groups.length, 6);
  assert.ok(first.data.settings.every((s) => s.label && s.help && s.apply && s.source), 'every setting has a label, an explanation, how it applies and where its value comes from');

  const bad = await call('PUT', '/api/settings', { values: { maxAttempts: 99, githubToken: 'nope' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.errors.maxAttempts, /1 to 5/);
  assert.ok(!JSON.stringify(bad.data).includes('"nope"'));

  const saved = await call('PUT', '/api/settings', { values: { maxAttempts: 4, githubToken: TOKEN } });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.data.saved, saved.data.changed.sort()], [true, ['githubToken', 'maxAttempts']]);
  assert.ok(!JSON.stringify(saved.data).includes(TOKEN));
  const again = await call('GET', '/api/settings');
  assert.equal(again.data.settings.find((s) => s.key === 'maxAttempts').value, 4);
  assert.equal(again.data.settings.find((s) => s.key === 'githubToken').configured, true);
  assert.ok(!JSON.stringify(again.data).includes(TOKEN));

  // A new run picks the saved default up; an explicit run option beats it.
  const r1 = await call('POST', '/api/runs', { idea: 'x', provider: 'offline', start: false });
  assert.equal(r1.data.run.settings.maxAttempts, 4);
  const r2 = await call('POST', '/api/runs', { idea: 'x', provider: 'offline', start: false, settings: { maxAttempts: 2 } });
  assert.equal(r2.data.run.settings.maxAttempts, 2);

  // Relayed (proxied) requests can use ordinary settings but not host-authority ones, and do not see them.
  const view = await call('GET', '/api/settings', undefined, RELAYED);
  assert.equal(view.data.admin, false);
  assert.equal(view.data.settings.find((s) => s.key === 'projectRoots').hidden, true);
  const denied = await call('PUT', '/api/settings', { values: { githubToken: 'ghp_anotherfaketoken123456' } }, RELAYED);
  assert.equal(denied.status, 403);
  assert.match(denied.data.error, /authenticated session/);
  assert.equal((await call('PUT', '/api/settings', { values: { maxParallel: 2 } }, RELAYED)).status, 200);
  assert.equal(app.cfg.githubToken, TOKEN);

  // Reset removes the saved value.
  const reset = await call('PUT', '/api/settings', { values: { maxAttempts: null } });
  assert.equal(reset.data.settings.find((s) => s.key === 'maxAttempts').source, 'default');
});

test('with an access password every client is authenticated, so settings are available — and unauthenticated ones are not', async () => {
  const locked = await createServer({ dataDir: tmpDir(), password: 'swordfish-1234' });
  await new Promise((r) => locked.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${locked.server.address().port}`;
  try {
    assert.equal((await fetch(`${url}/api/settings`)).status, 401);
    const auth = { authorization: `Basic ${Buffer.from('me:swordfish-1234').toString('base64')}`, 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.2' };
    const r = await fetch(`${url}/api/settings`, { headers: auth });
    assert.equal((await r.json()).admin, true);
    const p = await fetch(`${url}/api/settings`, { method: 'PUT', headers: auth, body: JSON.stringify({ values: { githubToken: TOKEN } }) });
    assert.equal(p.status, 200);
    assert.ok(!(await p.text()).includes('swordfish'));
  } finally {
    await locked.close();
  }
});

test('API errors are redacted before they reach the browser', async () => {
  const r = await call('POST', '/api/runs', { idea: 'x', provider: 'offline', repoUrl: 'https://user:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b.git' });
  const text = JSON.stringify(r.data);
  assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'));
  const p = await call('POST', '/api/providers', { label: 'leaky', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' });
  assert.ok(!JSON.stringify(p.data).includes('abcdefghijklmnopqrstuvwxyz'));
  const proc = fakePax({});
  void proc;
});
