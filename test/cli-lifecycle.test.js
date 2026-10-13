// Backend lifecycle driven through real `node src/cli.js` processes: one server per data dir, no port collisions,
// no orphans, and the development path (check/build) working with no backend at all.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { spawnCli, privateEnv, alive, ROOT, cleanMachineEnv } from './cli-helpers.js';
import { makeRoot } from './project-helpers.js';
import { tmpDir, waitFor } from './helpers.js';

cleanMachineEnv();
const envs = [];
const fresh = async (extra) => {
  const e = await privateEnv(extra);
  envs.push(e);
  return e;
};
const record = (e) => {
  try { return JSON.parse(fs.readFileSync(path.join(e.dataDir, 'server.json'), 'utf8')); } catch { return null; }
};
after(async () => {
  for (const e of envs) await spawnCli(['server', 'stop', '--force'], { env: e.env }).catch(() => {});
});

test('the first command starts one managed backend; later commands, even concurrent ones, reuse it', async () => {
  const e = await fresh();
  assert.equal(record(e), null);
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => spawnCli(['runs', 'list', '--json'], { env: e.env })));
  for (const r of [a, b, c]) assert.equal(r.code, 0, r.err);
  const rec = record(e);
  assert.ok(rec && alive(rec.pid), 'a server is running');
  assert.equal(rec.managed, true);
  assert.equal(rec.port, Number(e.port));
  assert.equal(rec.host, '127.0.0.1', 'managed backends listen on loopback only');
  const notices = [a, b, c].filter((r) => /Started the local da-prompt backend/.test(r.err)).length;
  assert.equal(notices, 1, 'exactly one command started it');

  const again = await spawnCli(['runs', 'list', '--json'], { env: e.env });
  assert.equal(again.code, 0);
  assert.equal(record(e).pid, rec.pid, 'the same server was reused');
  const st = await spawnCli(['server', 'status', '--json'], { env: e.env });
  assert.equal(st.json.running, true);
  assert.equal(st.json.record.pid, rec.pid);
  const top = await spawnCli(['status', '--json'], { env: e.env });
  assert.equal(top.code, 0);
  assert.equal(top.json.backend.pid, rec.pid);

  const stop = await spawnCli(['server', 'stop', '--json'], { env: e.env });
  assert.equal(stop.code, 0, stop.err);
  await waitFor(() => !alive(rec.pid), { timeoutMs: 15_000 });
  assert.equal(record(e), null, 'the record is removed');
  const after1 = await spawnCli(['server', 'status', '--json'], { env: e.env });
  assert.equal(after1.code, 3);
  assert.equal(after1.json.running, false);
});

test('--no-start and status never launch a backend', async () => {
  const e = await fresh();
  const r = await spawnCli(['runs', 'list', '--no-start'], { env: e.env });
  assert.equal(r.code, 3);
  assert.match(r.err, /not running/);
  const s = await spawnCli(['status'], { env: e.env });
  assert.equal(s.code, 3);
  assert.equal(record(e), null);
  assert.ok(!fs.existsSync(path.join(e.dataDir, 'server.log')), 'no server was spawned');
});

test('a stale record (crashed server) is cleaned up and replaced, not trusted', async () => {
  const e = await fresh();
  fs.mkdirSync(e.dataDir, { recursive: true });
  fs.writeFileSync(path.join(e.dataDir, 'server.json'), JSON.stringify({ pid: 2_000_000_000, host: '127.0.0.1', port: Number(e.port), url: `http://127.0.0.1:${e.port}`, startedAt: new Date().toISOString(), managed: true, dataDir: e.dataDir }));
  const st = await spawnCli(['server', 'status', '--json'], { env: e.env });
  assert.equal(st.code, 3);
  assert.equal(st.json.running, false);
  const r = await spawnCli(['runs', 'list', '--json'], { env: e.env });
  assert.equal(r.code, 0, r.err);
  const rec = record(e);
  assert.notEqual(rec.pid, 2_000_000_000);
  assert.ok(alive(rec.pid));
});

test('a second server on the same data directory is refused, and the first keeps running', async () => {
  const e = await fresh();
  assert.equal((await spawnCli(['runs', 'list'], { env: e.env })).code, 0);
  const rec = record(e);
  const second = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { env: { PATH: process.env.PATH, ...e.env, PORT: String(e.port + 1) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
    setTimeout(() => p.kill('SIGKILL'), 20_000).unref();
  });
  assert.notEqual(second.code, 0);
  assert.match(second.out, /already running/);
  assert.match(second.out, /da-prompt server stop/);
  assert.equal(record(e).pid, rec.pid);
  assert.ok(alive(rec.pid));
});

test('a busy port is a clear error: nothing is recorded and nothing is left running', async () => {
  const e = await fresh();
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(Number(e.port), '127.0.0.1', r));
  try {
    const r = await spawnCli(['server', 'start'], { env: e.env });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /port .*in use|already in use|EADDRINUSE|busy/i);
    assert.match(r.err, /PORT|--port|another port/i, 'says how to pick another port');
    assert.equal(record(e), null);
    // The other process on that port was not mistaken for a da-prompt backend.
    const list = await spawnCli(['runs', 'list', '--no-start'], { env: e.env });
    assert.equal(list.code, 3);
  } finally {
    blocker.close();
  }
});

test('--url / DA_PROMPT_URL connect to an existing backend without starting another; a password is required when one is set', async () => {
  const e = await fresh({ FACTORY_PASSWORD: 'correct horse battery staple' });
  const e2 = await fresh();
  // e runs a protected backend; connect to it from a different config/data dir.
  const start = await spawnCli(['server', 'start', '--json'], { env: e.env });
  assert.equal(start.code, 0, start.err);
  const url = record(e).url;
  const noPw = await spawnCli(['runs', 'list', '--url', url, '--json'], { env: e2.env });
  assert.equal(noPw.code, 4);
  assert.match(noPw.json.error.hint, /DA_PROMPT_PASSWORD/);
  const wrong = await spawnCli(['runs', 'list', '--json'], { env: { ...e2.env, DA_PROMPT_URL: url, DA_PROMPT_PASSWORD: 'nope' } });
  assert.equal(wrong.code, 4);
  const right = await spawnCli(['runs', 'list', '--json'], { env: { ...e2.env, DA_PROMPT_URL: url, DA_PROMPT_PASSWORD: 'correct horse battery staple' } });
  assert.equal(right.code, 0, right.err);
  assert.equal(record(e2), null, 'no second backend was started');
  assert.ok(!(right.out + right.err + wrong.err).includes('correct horse battery staple'));
  assert.equal((await spawnCli(['server', 'stop'], { env: e.env })).code, 0);
});

test('setup is non-interactive, validates before saving, and touches only its own files', async () => {
  const e = await fresh();
  const roots = makeRoot({ a: () => {} });
  const home = e.base;
  fs.writeFileSync(path.join(home, '.zshrc'), '# mine\n');
  const bad = await spawnCli(['setup', '--non-interactive', '--provider', 'no-such-provider', '--json'], { env: e.env });
  assert.notEqual(bad.code, 0);
  assert.equal(fs.existsSync(path.join(e.dataDir, 'settings.json')), false, 'nothing saved after a failed validation');
  const ok = await spawnCli(['setup', '--non-interactive', '--provider', 'offline', '--project-root', roots.root, '--json'], { env: e.env });
  // The requested changes were saved; the exit code says the environment is still not ready (only offline agents).
  assert.equal(ok.code, 1, ok.err + ok.out);
  assert.equal(ok.json.ok, false);
  assert.deepEqual(ok.json.actions.map((a) => a.setting), ['projectRoots', 'defaultProvider', 'defaultModel']);
  assert.ok(ok.json.remaining.some((r) => r.id === 'providers' && r.next));
  const cfg = await spawnCli(['config', 'get', 'projectRoots', '--json'], { env: e.env });
  assert.deepEqual(cfg.json.value, [fs.realpathSync(roots.root)]);
  assert.equal(cfg.json.source, 'saved');
  assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), '# mine\n', 'shell profiles are never edited');
  const files = fs.readdirSync(home).filter((f) => !['cfg', 'data', '.zshrc'].includes(f));
  assert.deepEqual(files, [], 'nothing else was written to HOME');
  const again = await spawnCli(['projects', 'list', '--folders', '--json'], { env: e.env });
  assert.equal(again.json.authorizedFolders[0].name, 'a');
  assert.equal((await spawnCli(['server', 'stop'], { env: e.env })).code, 0);
});

// ── the development path does not depend on da-prompt ──────────────────────────────────────────────

test('check and build run with no backend, no config and no network, and report their results', async () => {
  const e = await fresh();
  const chk = await spawnCli(['--version'], { env: e.env }); // CLI itself works with no backend
  assert.equal(chk.code, 0);
  const run = (script, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: tmpDir(), HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
  const check = await run('check.mjs', '--json');
  assert.equal(check.code, 0, check.out + check.err);
  const parsed = JSON.parse(check.out);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.checked > 50);
  assert.ok(parsed.skipped.some((s) => /eslint/.test(s)), 'a check that could not run is reported as skipped, not passed');
  const build = await run('build.mjs', '--json');
  assert.equal(build.code, 0, build.out + build.err);
  const b = JSON.parse(build.out);
  assert.equal(b.ok, true);
  assert.deepEqual(b.steps.map((s) => s.name), ['static checks', 'package contents', 'required files present in package', 'bin entry', 'cli --help', 'cli --version', 'terminal PTY helper', 'modules import cleanly']);
  assert.equal(record(e), null, 'no backend was involved');
});

test('check fails with exit 1 and file:line when the code is broken', async () => {
  const dir = tmpDir('da-prompt-broken-');
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'check.mjs'), path.join(dir, 'scripts', 'check.mjs'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'src', 'ok.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'bad.js'), "import { nope } from './missing.js';\nexport const b = (;\n");
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(dir, 'scripts', 'check.mjs')], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /src\/bad\.js.*syntax/);
  assert.match(r.err, /src\/bad\.js:1\s+import-missing/);
});
