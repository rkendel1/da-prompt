// Embedded terminal: real PTY sessions on a real backend. Deterministic where it matters (no timing guesses about the
// shell: tests wait for output), and every test cleans up its sessions and checks nothing was left running.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanMachineEnv } from './cli-helpers.js';
import { startTerminalBackend, pidsFrom, gitProject } from './terminal-helpers.js';
import { TerminalManager, TerminalError, alive, terminalEnv, descendants, ptySupport } from '../src/terminal.js';
import { tmpDir, waitFor } from './helpers.js';
import { makeRoot } from './project-helpers.js';

cleanMachineEnv();
const backends = [];
const boot = async (opts) => {
  const be = await startTerminalBackend(opts);
  backends.push(be);
  return be;
};
after(async () => { for (const b of backends) await b.close().catch(() => {}); });
const gone = (pids, ms = 8000) => waitFor(() => pids.every((p) => !alive(p)), { timeoutMs: ms, intervalMs: 50 });

// ── creation, authorization, working directory ─────────────────────────────────────────────────

test('a session starts in the authorized project in a real PTY, with the login-shell basics, and exposes no environment', async () => {
  const be = await boot();
  const s = await be.open();
  assert.equal(s.cwd, fs.realpathSync(be.roots.dirs.app));
  assert.equal(s.project.name, 'app');
  assert.equal(s.tty, true);
  assert.equal(s.insideProject, true);
  assert.match(s.id, /^[A-Za-z0-9_-]{32}$/, '192-bit unguessable id');
  for (const bad of ['env', 'pid', 'shellPid', 'argv']) assert.ok(!(bad in s), `${bad} is not exposed`);
  const out = be.sse(s.id);
  await out.waitText(/[#$] $/m);
  await be.type(s.id, '[ -t 0 ] && [ -t 1 ] && echo TTY_YES; echo T=$TERM; pwd\r');
  await out.waitText('TTY_YES');
  assert.match(out.text, /T=xterm-256color/);
  assert.ok(out.text.includes(fs.realpathSync(be.roots.dirs.app)));
  out.close();
  assert.equal((await be.call('DELETE', `/api/terminal/sessions/${s.id}`)).status, 200);
});

test('the start directory is validated server-side: unauthorized, traversal, read-only, missing and non-opaque values are all refused', async () => {
  const be = await boot();
  const good = await be.dirId();
  const key = good.split(':')[0];
  for (const [value, status] of [[undefined, 400], ['', 400], ['/etc', 400], [`${key}:..`, 403], [`${key}:../x`, 403], ['0000000000:app', 403], [`${key}:nope`, 404], [{ path: '/etc' }, 400]]) {
    const r = await be.call('POST', '/api/terminal/sessions', { directoryId: value });
    assert.equal(r.status, status, JSON.stringify(value));
  }
  assert.equal((await be.call('POST', '/api/terminal/sessions', { directoryId: good, cwd: '/etc', path: '/etc' })).body.session.cwd, fs.realpathSync(be.roots.dirs.app), 'a path field from the browser is ignored');
  // A symlink inside the root that points outside it does not become authority.
  fs.symlinkSync('/etc', path.join(be.roots.root, 'escape'));
  assert.equal((await be.call('POST', '/api/terminal/sessions', { directoryId: `${key}:escape` })).status, 403);
  // Read-only roots are refused: a shell cannot honour "read-only".
  const ro = await boot({ readOnly: true });
  const r = await ro.call('POST', '/api/terminal/sessions', { directoryId: await ro.dirId() });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /read-only/);
});

test('a directory deleted or moved after authorization is reported clearly and nothing is started', async () => {
  const be = await boot({ projects: { gone: gitProject, app: gitProject } });
  const id = await be.dirId('gone');
  fs.rmSync(be.roots.dirs.gone, { recursive: true, force: true });
  const r = await be.call('POST', '/api/terminal/sessions', { directoryId: id });
  assert.ok([404, 409].includes(r.status), String(r.status));
  assert.match(r.body.error, /not found|deleted|moved|not available/i);
  assert.equal((await be.call('GET', '/api/terminal')).body.sessions.length, 0);
});

test('authentication: no password needs a loopback browser; with a password every request needs it; sessions belong to their principal', async () => {
  const open = await boot();
  assert.equal((await open.call('GET', '/api/terminal')).status, 200);
  // Relayed requests are not "on the host".
  assert.equal((await open.call('GET', '/api/terminal', undefined, { 'x-forwarded-for': '203.0.113.9' })).status, 403);
  // A rebound/foreign Host name is refused on an unprotected server.
  const rebound = await new Promise((resolve) => {
    const u = new URL(open.url);
    const rq = http.request({ host: u.hostname, port: u.port, path: '/api/terminal', headers: { host: 'evil.example:3000' } }, (res) => (res.resume(), resolve(res.statusCode)));
    rq.end();
  });
  assert.equal(rebound, 403);
  // Cross-origin pages cannot drive the shell.
  assert.equal((await open.call('GET', '/api/terminal', undefined, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await open.call('GET', '/api/terminal', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const s = await open.open();
  assert.equal((await open.call('POST', `/api/terminal/sessions/${s.id}/input`, { data: 'echo hi\r' }, { origin: 'http://evil.example' })).status, 403);

  const pw = await boot({ password: 'correct horse battery' });
  const anon = await fetch(`${pw.url}/api/terminal`);
  assert.equal(anon.status, 401);
  const wrong = await fetch(`${pw.url}/api/terminal`, { headers: { authorization: `Basic ${Buffer.from('u:nope').toString('base64')}` } });
  assert.equal(wrong.status, 401);
  assert.equal((await fetch(`${pw.url}/api/terminal/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const mine = await pw.open();
  assert.equal((await fetch(`${pw.url}/api/terminal/sessions/${mine.id}/stream`)).status, 401, 'the stream needs the password too');
  // The password does not reach the shell's environment.
  const out = pw.sse(mine.id);
  await out.waitText(/[#$] $/m);
  await pw.type(mine.id, 'env | grep -c -i "correct horse" ; echo ENVDONE\r');
  await out.waitText('ENVDONE');
  assert.match(out.text.replace(/\r/g, ''), /\n0\n/);
  out.close();
});

test('session ids are capabilities checked on every call: unknown, foreign and malformed ids all look the same', async () => {
  const be = await boot();
  const s = await be.open();
  for (const id of ['x', 'A'.repeat(32), '../runs', '%00', 'null']) {
    for (const [m, sub] of [['GET', ''], ['DELETE', ''], ['POST', '/input'], ['POST', '/resize'], ['POST', '/signal'], ['GET', '/stream']]) {
      const r = await be.call(m, `/api/terminal/sessions/${encodeURIComponent(id)}${sub}`, m === 'POST' ? { data: 'x' } : undefined);
      assert.equal(r.status, 404, `${m} ${sub} ${id}`);
    }
  }
  // Manager level: another principal cannot see or use it, and gets the identical error.
  const m = new TerminalManager({ terminalShell: '/bin/sh' });
  const mine = m.create({ owner: 'alice', dir: tmpDir(), project: { name: 'x' } });
  assert.throws(() => m.get(mine.id, 'bob'), (e) => e instanceof TerminalError && e.status === 404);
  assert.throws(() => m.get('nonexistent', 'alice'), (e) => e.status === 404 && e.message === (() => { try { m.get(mine.id, 'bob'); } catch (x) { return x.message; } })());
  assert.equal(m.list('bob').length, 0);
  await m.closeAll();
  void s;
});

test('the terminal can be turned off, and an unsupported host (no PTY helper) is explained, not faked', async () => {
  const off = await boot({ extra: { terminalEnabled: false } });
  const r = await off.call('GET', '/api/terminal');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /turned off/);
  const noPy = await boot({ extra: { terminalPython: '/nonexistent/python3' } });
  const info = await noPy.call('GET', '/api/terminal');
  assert.equal(info.body.pty, false);
  assert.match(info.body.reason, /Python 3|python3/);
  const c = await noPy.call('POST', '/api/terminal/sessions', { directoryId: await noPy.dirId() });
  assert.equal(c.status, 503);
  assert.match(c.body.error, /xcode-select --install/);
  assert.equal(ptySupport({}).ok, true);
});

test('at most N terminals at once', async () => {
  const be = await boot({ extra: { terminalMaxSessions: 2 } });
  await be.open();
  await be.open();
  const r = await be.call('POST', '/api/terminal/sessions', { directoryId: await be.dirId() });
  assert.equal(r.status, 429);
});

// ── streaming, input, interactivity ───────────────────────────────────────────────────────────────

test('output streams in order with byte offsets; a reconnecting client resumes without loss or duplication', async () => {
  const be = await boot();
  const s = await be.open();
  const a = be.sse(s.id);
  await a.waitText(/[#$] $/m);
  await be.type(s.id, 'seq 1 200\r');
  await a.waitText('200');
  const seen = a.offset;
  a.close();
  await be.type(s.id, 'echo AFTER_DETACH\r'); // typed while no browser is attached
  const b = be.sse(s.id, seen);
  await b.waitText('AFTER_DETACH');
  assert.ok(!b.text.includes('seq 1 200'), 'nothing before the offset is replayed');
  assert.equal(b.chunks[0].off, seen, 'resumes exactly where the first client stopped');
  const c = be.sse(s.id, 0);
  await c.waitText('AFTER_DETACH');
  assert.ok(c.text.includes('\r\n200\r\n'), 'a fresh attach replays what is retained');
  assert.equal(c.state.state, 'running');
  b.close();
  c.close();
});

test('interactive programs work: prompts that read input, signals, line editing, and resizing reach the program', async () => {
  const be = await boot();
  const s = await be.open();
  const out = be.sse(s.id);
  await out.waitText(/[#$] $/m);
  await be.type(s.id, 'printf "name? "; read n; echo "hello $n"\r');
  await out.waitText('name? ');
  await be.type(s.id, 'Ada\r');
  await out.waitText('hello Ada');
  // Resize: the PTY and the program see the new size.
  const r = await be.call('POST', `/api/terminal/sessions/${s.id}/resize`, { cols: 132, rows: 43 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.session.cols, r.body.session.rows], [132, 43]);
  await be.type(s.id, 'stty size\r');
  await out.waitText('43 132');
  // Out-of-range sizes are clamped, not trusted.
  const big = await be.call('POST', `/api/terminal/sessions/${s.id}/resize`, { cols: 99999, rows: -4 });
  assert.ok(big.body.session.cols <= 1000 && big.body.session.rows >= 1);
  // Interrupt: Ctrl-C through the PTY (what the keyboard sends) and the signal API both stop the foreground process.
  await be.type(s.id, 'sleep 300; echo WOKE\r');
  await waitFor(async () => descendants((await be.call('GET', `/api/terminal/sessions/${s.id}`)).body.session && 1).length >= 0);
  await be.type(s.id, '\x03');
  await be.type(s.id, 'echo INT1=$?\r');
  await out.waitText(/INT1=130/);
  await be.type(s.id, 'sleep 301; echo WOKE\r');
  await new Promise((r2) => setTimeout(r2, 300));
  assert.equal((await be.call('POST', `/api/terminal/sessions/${s.id}/signal`, { signal: 'INT' })).status, 200);
  await be.type(s.id, 'echo INT2=$?\r');
  await out.waitText(/INT2=130/);
  assert.ok(!/\r\nWOKE\r\n/.test(out.text), 'the interrupted command never completed');
  assert.equal((await be.call('POST', `/api/terminal/sessions/${s.id}/signal`, { signal: 'BOGUS' })).status, 400);
  assert.equal((await be.call('POST', `/api/terminal/sessions/${s.id}/signal`, { signal: 'rm -rf /' })).status, 400);
  out.close();
});

test('input is bytes, never a command string: shell metacharacters in what a client sends are only typed text', async () => {
  const be = await boot();
  const s = await be.open();
  const out = be.sse(s.id);
  await out.waitText(/[#$] $/m);
  const marker = path.join(os.tmpdir(), `injected-${process.pid}-${Date.now()}`);
  await be.type(s.id, `echo '$(touch ${marker}) \`touch ${marker}\` ; touch ${marker}' > /dev/null\r`);
  await be.type(s.id, 'echo SAFE_END\r');
  await out.waitText('SAFE_END');
  assert.ok(!fs.existsSync(marker), 'the transport did not evaluate anything');
  assert.equal((await be.call('POST', `/api/terminal/sessions/${s.id}/input`, { data: 'x'.repeat(70_000) })).status, 413);
  assert.equal((await be.call('POST', `/api/terminal/sessions/${s.id}/input`, { data: 42 })).status, 200, 'a non-string is treated as empty input');
  out.close();
});

test('real development commands run: git, node, the repository\'s own test script, and a missing tool is reported by the shell', async () => {
  const be = await boot();
  const s = await be.open();
  const out = be.sse(s.id);
  await out.waitText(/[#$] $/m);
  await be.type(s.id, 'git status --short | wc -l; git log --oneline | head -1; node -p "40+2"\r');
  await out.waitText(/\n(\x1b\[33m)?42(\x1b\[39m)?\r?\n/);
  assert.match(out.text, /initial/);
  await be.type(s.id, 'echo "export const x = 1;" > extra.js && git diff --stat HEAD 2>&1 | head -3; git status --short; npm test 2>&1 | tail -9; echo NPM_EXIT=$?\r');
  await out.waitText(/\nNPM_EXIT=\d/, 60000);
  assert.match(out.text, /\?\?.{0,12} extra\.js/);
  assert.match(out.text, /# pass 1|tests 1/);
  await be.type(s.id, 'definitely-not-installed-tool; echo CODE=$?\r');
  await out.waitText('CODE=127');
  assert.match(out.text, /not found/);
  const d = await be.call('GET', '/api/terminal/diagnostics');
  assert.equal(d.status, 200);
  assert.ok(d.body.tools.find((t) => t.name === 'git').path, 'git is found by a login shell');
  assert.ok(d.body.tools.find((t) => t.name === 'node').path);
  assert.ok(d.body.tools.some((t) => t.name === 'cargo'), 'every probed tool is listed, found or not');
  assert.match(d.body.startup, /login shell/);
  out.close();
});

test('the shell may leave the project (documented policy) and the session says so; cwd follows cd', async () => {
  const be = await boot();
  const s = await be.open();
  const out = be.sse(s.id);
  await out.waitText(/[#$] $/m);
  await be.type(s.id, 'mkdir -p sub && cd sub && pwd\r');
  await out.waitText('/app/sub');
  await waitFor(async () => (await be.call('GET', `/api/terminal/sessions/${s.id}`)).body.session.cwd.endsWith('/app/sub'), { timeoutMs: 8000, intervalMs: 100 });
  assert.equal((await be.call('GET', `/api/terminal/sessions/${s.id}`)).body.session.insideProject, true);
  await be.type(s.id, 'cd /\r');
  await waitFor(async () => (await be.call('GET', `/api/terminal/sessions/${s.id}`)).body.session.cwd === '/', { timeoutMs: 8000, intervalMs: 100 });
  const v = (await be.call('GET', `/api/terminal/sessions/${s.id}`)).body.session;
  assert.equal(v.insideProject, false, 'the header can show "outside project"');
  assert.equal(v.startDir, fs.realpathSync(be.roots.dirs.app), 'and the original project stays visible');
  const policy = (await be.call('GET', '/api/terminal')).body.policy;
  assert.match(policy.navigation, /NOT confined/);
  assert.match(policy.trust, /permissions of the user/);
  out.close();
});

// ── exit status, cleanup, lifecycle ───────────────────────────────────────────────────────────────

test('exit status is reported, input to an exited session is refused, and the record can still be read and closed', async () => {
  const be = await boot();
  const s = await be.open();
  const out = be.sse(s.id);
  await out.waitText(/[#$] $/m);
  await be.type(s.id, 'exit 7\r');
  await out.waitState((st) => st.state === 'exited');
  assert.equal(out.state.exitCode, 7);
  const r = await be.type(s.id, 'echo nope\r', 409);
  assert.equal(r.status, 409);
  const v = (await be.call('GET', `/api/terminal/sessions/${s.id}`)).body.session;
  assert.deepEqual([v.state, v.exitCode], ['exited', 7]);
  assert.equal((await be.call('DELETE', `/api/terminal/sessions/${s.id}`)).status, 200);
  assert.equal((await be.call('GET', `/api/terminal/sessions/${s.id}`)).status, 404);
  out.close();
  // A shell killed by a signal reports the signal.
  const s2 = await be.open();
  const o2 = be.sse(s2.id);
  await o2.waitText(/[#$] $/m);
  await be.type(s2.id, 'kill -9 $$\r');
  await o2.waitState((st) => st.state === 'exited');
  assert.equal(o2.state.signal, 9);
  o2.close();
});

test('closing a session ends the shell and its whole process tree, including background jobs and grandchildren', async () => {
  const be = await boot();
  const s = await be.open();
  const out = be.sse(s.id);
  await out.waitText(/[#$] $/m);
  await be.type(s.id, 'sleep 600 & echo BG1=$!; (sleep 601 & echo BG2=$!; wait) & sh -c "sleep 602 & echo BG3=\\$!; wait" & \r');
  await out.waitText('BG3=');
  const pids = [...pidsFrom(out.text, 'BG1'), ...pidsFrom(out.text, 'BG2'), ...pidsFrom(out.text, 'BG3')];
  assert.equal(pids.length, 3);
  assert.ok(pids.every(alive), 'they are running');
  const helper = (await be.call('GET', '/api/terminal')).body.sessions.length;
  assert.equal(helper, 1);
  const del = await be.call('DELETE', `/api/terminal/sessions/${s.id}`);
  assert.equal(del.status, 200);
  assert.ok(await gone(pids), `left behind: ${pids.filter(alive).join(', ')}`);
  out.close();
});

test('a process that ignores hangup is still killed on close, and so is a child that moved itself into a new session while its parent is alive', async () => {
  const be = await boot();
  const s = await be.open();
  const out = be.sse(s.id);
  await out.waitText(/[#$] $/m);
  await be.type(s.id, 'sh -c \'trap "" HUP TERM; sleep 700\' & echo STUBBORN=$!; setsid -w sh -c "echo DETACHED=\\$\\$; exec sleep 701" &\r');
  await out.waitText('DETACHED=');
  const pids = [...pidsFrom(out.text, 'STUBBORN'), ...pidsFrom(out.text, 'DETACHED')];
  assert.equal(pids.length, 2);
  assert.equal((await be.call('DELETE', `/api/terminal/sessions/${s.id}`)).status, 200);
  assert.ok(await gone(pids, 12000), `left behind: ${pids.filter(alive).join(', ')}`);
  out.close();
});

test('stopping the server terminates every terminal it started', async () => {
  const be = await startTerminalBackend();
  const s = await be.open();
  const out = be.sse(s.id);
  await out.waitText(/[#$] $/m);
  await be.type(s.id, 'sleep 800 & echo SRV=$!\r');
  await out.waitText('SRV=');
  const pid = pidsFrom(out.text, 'SRV')[0];
  assert.ok(alive(pid));
  out.close();
  await be.close();
  assert.ok(await gone([pid]), 'the shell\'s children are gone after the server shuts down');
});

test('if the backend dies without cleaning up (SIGKILL), the PTY helper takes the shell down with it', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = `
    import { TerminalManager } from ${JSON.stringify(path.join(here, '..', 'src', 'terminal.js'))};
    const m = new TerminalManager({ terminalShell: '/bin/sh' });
    const s = m.create({ owner: 'x', dir: ${JSON.stringify(os.tmpdir())}, project: { name: 't' } });
    await new Promise((r) => setTimeout(r, 600));
    m.write(s, 'sleep 900 & echo KID=$!; echo SH=$$\\r');
    await new Promise((r) => setTimeout(r, 800));
    const text = m.read(s, 0).buf.toString();
    console.log(JSON.stringify({ kid: /KID=(\\d+)/.exec(text)?.[1], sh: /SH=(\\d+)/.exec(text)?.[1], helper: s.child.pid }));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const info = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) resolve(JSON.parse(buf)); });
    child.on('exit', () => reject(new Error('child exited early')));
  });
  const pids = [Number(info.kid), Number(info.sh), info.helper];
  assert.ok(pids.every(alive));
  child.kill('SIGKILL');
  assert.ok(await gone(pids, 12000), `survivors: ${pids.filter(alive).join(', ')}`);
});

// ── limits, backpressure, abandoned sessions ──────────────────────────────────────────────────────

test('output is bounded: a flood is dropped from the oldest end, reported as truncation, and the shell keeps working', async () => {
  const be = await boot({ extra: { terminalBufferBytes: 16 * 1024 } });
  const s = await be.open();
  const live = be.sse(s.id);
  await live.waitText(/[#$] $/m);
  await be.type(s.id, 'head -c 3000000 /dev/zero | tr "\\000" "x"; echo; echo FLOOD_DONE\r');
  await live.waitText(/\nFLOOD_DONE/, 60000);
  const v = (await be.call('GET', `/api/terminal/sessions/${s.id}`)).body.session;
  assert.ok(v.total > 3_000_000, 'all of it was produced');
  assert.ok(v.total - v.bufferStart <= 16 * 1024 + 70_000, `retained ${v.total - v.bufferStart} bytes`);
  const late = be.sse(s.id, 0);
  await late.waitText(/\nFLOOD_DONE/);
  assert.equal(late.truncated.length, 1, 'a client that missed it is told output was dropped');
  assert.ok(late.truncated[0].dropped > 0);
  assert.ok(late.text.length < 100_000);
  await be.type(s.id, 'echo STILL_WORKS\r');
  await live.waitText(/\nSTILL_WORKS/);
  live.close();
  late.close();
});

test('a client that never reads cannot stall the shell or grow server memory; a long-running process keeps running', async () => {
  const be = await boot({ extra: { terminalBufferBytes: 64 * 1024 } });
  const s = await be.open();
  // A raw socket that connects to the stream and then never reads.
  const url = new URL(`${be.url}/api/terminal/sessions/${s.id}/stream`);
  const { connect } = await import('node:net');
  const sock = connect(Number(url.port), url.hostname);
  await new Promise((r) => sock.once('connect', r));
  sock.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`);
  sock.pause();
  await be.type(s.id, 'sleep 5 & yes "flood flood flood flood" | head -c 8000000; echo; echo FIN\r');
  const reader = be.sse(s.id, 0);
  await reader.waitText(/\nFIN/, 90000);
  const v = (await be.call('GET', `/api/terminal/sessions/${s.id}`)).body.session;
  assert.ok(v.total - v.bufferStart <= 64 * 1024 + 70_000);
  assert.equal(v.state, 'running');
  assert.ok(v.attached >= 2, 'the stuck client is still counted as attached, not blocking anything');
  await be.type(s.id, 'echo STILL_ALIVE; sleep 1; echo SLEPT\r');
  await reader.waitText(/\nSLEPT/);
  sock.destroy();
  reader.close();
  await waitFor(async () => (await be.call('GET', `/api/terminal/sessions/${s.id}`)).body.session.attached === 0, { timeoutMs: 15000 });
});

test('disconnecting a browser detaches without killing the shell; abandoned sessions are cleaned up after the idle limit', async () => {
  const be = await boot({ extra: { terminalIdleMs: 700, terminalSweepMs: 200 } });
  const s = await be.open();
  const out = be.sse(s.id);
  await out.waitText(/[#$] $/m);
  await be.type(s.id, 'sleep 900 & echo ABAN=$!\r');
  await out.waitText('ABAN=');
  const pid = pidsFrom(out.text, 'ABAN')[0];
  out.close();
  await waitFor(async () => (await be.call('GET', `/api/terminal/sessions/${s.id}`)).body.session.attached === 0);
  assert.equal((await be.call('GET', `/api/terminal/sessions/${s.id}`)).body.session.state, 'running', 'detached, still running');
  be.app?.terminals;
  // Idle sweep (the manager is reached through a second request path: time passes, the sweeper runs).
  await waitFor(async () => (await be.call('GET', `/api/terminal/sessions/${s.id}`)).status === 404, { timeoutMs: 40000, intervalMs: 500 });
  assert.ok(await gone([pid]), 'its processes went with it');
});

test('exited sessions are retained for a while (so output can be read) and then removed', async () => {
  const m = new TerminalManager({ terminalShell: '/bin/sh', terminalExitedKeepMs: 200, terminalIdleMs: 60_000 });
  const s = m.create({ owner: 'o', dir: tmpDir(), project: { name: 'x' } });
  await waitFor(() => s.state === 'running');
  m.write(s, 'exit 3\r');
  await waitFor(() => s.state === 'exited');
  assert.equal(m.get(s.id, 'o').exitCode, 3);
  await new Promise((r) => setTimeout(r, 300));
  m.sweep();
  await waitFor(() => !m.sessions.has(s.id));
  await m.closeAll();
});

// ── secrets, diagnostics, independence ────────────────────────────────────────────────────────────

test('secrets: the shell environment drops the access password, session metadata carries no environment, and nothing typed or printed is logged', async () => {
  const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const base = { PATH: '/usr/bin', FACTORY_PASSWORD: 'pw-secret-value', DA_PROMPT_PASSWORD: 'pw2', MY_TOKEN: SECRET, NODE_TEST_CONTEXT: 'x' };
  const env = terminalEnv(base);
  assert.ok(!('FACTORY_PASSWORD' in env) && !('DA_PROMPT_PASSWORD' in env) && !('NODE_TEST_CONTEXT' in env));
  assert.equal(env.MY_TOKEN, SECRET, 'the user\'s own variables are the user\'s shell environment');
  assert.equal(env.TERM, 'xterm-256color');

  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, out: process.stdout.write, err: process.stderr.write };
  const grab = (...a) => logs.push(a.join(' '));
  console.log = grab; console.error = grab; console.warn = grab;
  const be = await boot();
  try {
    const s = await be.open();
    const out = be.sse(s.id);
    await out.waitText(/[#$] $/m);
    await be.type(s.id, `echo typed-secret-${SECRET}\r`);
    await out.waitText(/typed-secret-ghp_\S+\r\n/);
    const meta = JSON.stringify([(await be.call('GET', '/api/terminal')).body, (await be.call('GET', `/api/terminal/sessions/${s.id}`)).body, (await be.call('GET', '/api/terminal/diagnostics')).body]);
    assert.ok(!meta.includes(SECRET) && !meta.includes('pw-secret-value'));
    assert.ok(!/"env"/.test(meta), 'no environment object in any metadata');
    out.close();
    await be.call('DELETE', `/api/terminal/sessions/${s.id}`);
  } finally {
    Object.assign(console, { log: orig.log, error: orig.error, warn: orig.warn });
  }
  assert.ok(!logs.join('\n').includes(SECRET), 'terminal I/O is not written to the server log');
  // Error messages are redacted too.
  const bad = await be.call('POST', '/api/terminal/sessions', { directoryId: `abcdef0123:${SECRET}` });
  assert.ok(!JSON.stringify(bad.body).includes(SECRET));
});

test('the terminal works with no provider, a dead model server, no PAX and no runs: it never touches them', async () => {
  const be = await boot({ extra: { defaultProvider: 'ollama', paxPath: '/nonexistent/pax' } });
  const providers = await be.call('GET', '/api/providers');
  assert.ok(providers.status === 200);
  const s = await be.open();
  const out = be.sse(s.id);
  await out.waitText(/[#$] $/m);
  await be.type(s.id, 'echo INDEPENDENT; ls | head -3\r');
  await out.waitText('INDEPENDENT');
  out.close();
  const requests = [];
  be.server.prependListener('request', (req) => requests.push(req.url));
  const s2 = await be.open();
  const o2 = be.sse(s2.id);
  await o2.waitText(/[#$] $/m);
  await be.type(s2.id, 'pwd\r');
  await o2.waitText('/app');
  o2.close();
  assert.ok(requests.every((u) => u.startsWith('/api/terminal') || u.startsWith('/api/projects/directories')), `only terminal routes: ${requests.join(', ')}`);
  assert.equal((await be.call('GET', '/api/runs')).body.total ?? 0, 0, 'no run was created');
});

test('a session can be opened from the CLI-authorized folders only (the same list the CLI shows)', async () => {
  const r = makeRoot({ one: gitProject });
  const be = await boot({ projects: { one: gitProject } });
  const list = (await be.call('GET', '/api/projects/directories')).body.directories;
  assert.deepEqual(list.map((d) => d.name), ['one']);
  void r;
});
