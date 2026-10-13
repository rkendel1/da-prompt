// Finding, starting and stopping the one local backend. Lifecycle rules (all tested):
//  - one backend per data directory, recorded in <data dir>/server.json by the server itself;
//  - commands reuse a live backend; otherwise they start a detached one bound to 127.0.0.1 (unless --no-start);
//  - a lock file serialises concurrent starts, so two CLIs never launch two servers;
//  - the backend outlives the terminal, which is what makes reconnecting to a run possible;
//  - `server stop` terminates only the process named in the record.
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from './client.js';
import { CliError, EXIT, clean } from './core.js';
import { liveServer, healthy, pidAlive, readRecord, lockPath, logPath, recordPath } from '../runtime.js';

const SERVER_ENTRY = fileURLToPath(new URL('../server.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isLocalUrl = (u) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(new URL(u).hostname);

export function logTail(cfg, lines = 15) {
  try {
    return clean(fs.readFileSync(logPath(cfg), 'utf8').trimEnd().split('\n').slice(-lines).join('\n'));
  } catch {
    return '';
  }
}

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

/** Start the detached local backend (or return the one that is already running). */
export async function startServer(cfg, { port, waitMs = 20_000 } = {}) {
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const already = await liveServer(cfg);
  if (already) return { record: already, started: false };

  // Serialise starts: whoever creates the lock file starts the server; the rest wait for it.
  let fd = null;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fd = fs.openSync(lockPath(cfg), 'wx');
      fs.writeSync(fd, String(process.pid));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = NaN;
      try {
        holder = Number(fs.readFileSync(lockPath(cfg), 'utf8'));
      } catch {
        /* gone */
      }
      if (!pidAlive(holder)) fs.rmSync(lockPath(cfg), { force: true });
      const live = await liveServer(cfg);
      if (live) return { record: live, started: false };
      if (Date.now() > deadline) throw new CliError('Another da-prompt command has been starting the backend for too long.', { code: EXIT.TIMEOUT, hint: `Check ${logPath(cfg)}, or remove ${lockPath(cfg)} if no da-prompt process is running.` });
      await sleep(200);
    }
  }
  try {
    const live = await liveServer(cfg);
    if (live) return { record: live, started: false };
    const want = port ?? cfg.port;
    if (!(await portFree(want))) {
      const theirs = await healthy(`http://127.0.0.1:${want}`);
      throw new CliError(theirs ? `Port ${want} is served by a da-prompt backend that belongs to a different data directory, so this command cannot use it.` : `Port ${want} is in use by another program.`, { code: EXIT.UNAVAILABLE, hint: 'Choose a free port: da-prompt server start --port <n>  (or set PORT).' });
    }
    const out = fs.openSync(logPath(cfg), 'a', 0o600);
    const child = spawn(process.execPath, [SERVER_ENTRY], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, HOST: '127.0.0.1', PORT: String(want), FACTORY_DATA_DIR: cfg.dataDir, DA_PROMPT_MANAGED: '1' } });
    let exited = null;
    child.on('exit', (code) => (exited = code));
    child.unref();
    while (Date.now() < deadline) {
      const rec = await liveServer(cfg);
      if (rec) return { record: rec, started: true };
      if (exited !== null) throw new CliError(`The backend exited during startup (code ${exited}).`, { code: EXIT.UNAVAILABLE, hint: `Last log lines:\n${logTail(cfg)}` });
      await sleep(120);
    }
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    throw new CliError(`The backend did not become ready within ${Math.round(waitMs / 1000)}s.`, { code: EXIT.TIMEOUT, hint: `Last log lines:\n${logTail(cfg)}` });
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(lockPath(cfg), { force: true });
  }
}

export async function stopServer(cfg, { force = false, waitMs = 15_000 } = {}) {
  const rec = readRecord(cfg);
  if (!rec || !pidAlive(rec.pid)) {
    fs.rmSync(recordPath(cfg), { force: true });
    return { stopped: false, reason: 'not-running' };
  }
  try {
    process.kill(rec.pid, 'SIGTERM');
  } catch (e) {
    throw new CliError(`Cannot signal pid ${rec.pid}: ${e.message}`, { code: EXIT.DENIED });
  }
  const end = Date.now() + waitMs;
  while (Date.now() < end && pidAlive(rec.pid)) await sleep(150);
  if (pidAlive(rec.pid)) {
    if (!force) throw new CliError(`The backend (pid ${rec.pid}) did not exit within ${Math.round(waitMs / 1000)}s.`, { code: EXIT.TIMEOUT, hint: 'Re-run with --force to kill it.' });
    process.kill(rec.pid, 'SIGKILL');
    await sleep(300);
    fs.rmSync(recordPath(cfg), { force: true });
  }
  return { stopped: true, pid: rec.pid };
}

/**
 * Work out which backend to talk to and make sure it is up. Precedence: --url, DA_PROMPT_URL, the running local
 * backend, then a newly started one. The password comes from the environment, or — for the local backend only —
 * from the saved settings (the CLI is a user process on the same host and could read that file anyway).
 */
export async function connect({ cfg, opts, env = process.env, noStart = false }) {
  const timeoutMs = (opts.timeout ? Number(opts.timeout) : 30) * 1000;
  const explicit = opts.url || env.DA_PROMPT_URL;
  const envPassword = env.DA_PROMPT_PASSWORD || env.FACTORY_PASSWORD || '';
  if (explicit) {
    let u;
    try {
      u = new URL(explicit);
    } catch {
      throw new CliError(`--url ${JSON.stringify(explicit)} is not a valid URL.`, { code: EXIT.USAGE });
    }
    const password = envPassword || (isLocalUrl(u.href) ? cfg.password : '');
    if (!(await healthy(u.href, Math.min(timeoutMs, 5000)))) throw new CliError(`No da-prompt backend answered at ${u.origin}.`, { code: EXIT.UNAVAILABLE, hint: 'Check the URL, or omit --url to use (and start) the local backend.' });
    return { client: new Client({ url: u.href, password, timeoutMs }), started: false, record: null, remote: !isLocalUrl(u.href) };
  }
  let rec = await liveServer(cfg);
  let started = false;
  if (!rec) {
    if (noStart) throw new CliError('The da-prompt backend is not running.', { code: EXIT.UNAVAILABLE, hint: 'Run: da-prompt server start   (or drop --no-start so commands start it for you).' });
    ({ record: rec, started } = await startServer(cfg));
  }
  return { client: new Client({ url: rec.url, password: envPassword || cfg.password, timeoutMs }), started, record: rec, remote: false };
}
