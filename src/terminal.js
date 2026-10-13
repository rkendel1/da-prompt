// Embedded developer terminal: host-side shell sessions on a real PTY.
//
// This is a privileged feature. A session runs the user's own login shell with the backend's permissions and can reach
// anything that user can. Authorization (who may create/attach), the start-directory policy and cleanup live here and in
// the /api/terminal routes of server.js; nothing in this file knows about agents, providers, PAX or runs.
import { spawn, spawnSync, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './security.js';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'terminal-pty.py');
export const SIGNALS = ['INT', 'QUIT', 'TERM', 'HUP', 'KILL', 'TSTP', 'CONT'];
const MAX_INPUT = 64 * 1024;

export class TerminalError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const clamp = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.max(lo, Math.min(hi, Math.round(Number(n)))) : d);
const newId = () => crypto.randomBytes(24).toString('base64url'); // 192 bits: a capability, never an index

/** Descendants of `root` (children, grandchildren…), from one `ps` snapshot. Works on Linux and macOS. */
export function descendants(root) {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) return [];
  const kids = new Map();
  for (const line of r.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const out = [];
  const stack = [root];
  while (stack.length) for (const k of kids.get(stack.pop()) || []) (out.push(k), stack.push(k));
  return out;
}

/** Is the process running? A zombie (dead, waiting for its parent to reap it) counts as gone. */
export const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  try {
    if (process.platform === 'linux') return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    return r.status === 0 && r.stdout.trim() !== '' && !r.stdout.trim().startsWith('Z');
  } catch {
    return false;
  }
};

/** The environment a terminal starts with: the backend's own, minus da-prompt's access password, plus terminal basics. */
export function terminalEnv(base = process.env) {
  // Started through `npm start`, the backend carries npm's launcher variables (npm_config_prefix=/opt/homebrew, ...) and
  // PATH entries for the project's node_modules/.bin. A login shell must not inherit them: nvm refuses to load while
  // npm_config_prefix is set, and the project's .bin is not the user's PATH. Only strip when npm really launched us.
  const viaNpm = Boolean(base.npm_lifecycle_event || base.npm_execpath || base.npm_config_user_agent);
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (k === 'FACTORY_PASSWORD' || k === 'DA_PROMPT_PASSWORD' || k === 'NODE_TEST_CONTEXT' || /^DA_PTY_/.test(k)) continue;
    if (viaNpm && (/^npm_/i.test(k) || k === 'INIT_CWD')) continue;
    env[k] = v;
  }
  if (viaNpm && env.PATH) env.PATH = env.PATH.split(path.delimiter).filter((d) => !/[\\/]node_modules[\\/]\.bin$|[\\/]node-gyp-bin$/.test(d)).join(path.delimiter);
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.DA_PROMPT_TERMINAL = '1';
  if (!env.LANG && !env.LC_ALL) env.LANG = 'en_US.UTF-8';
  return env;
}

export function pickShell(cfg = {}) {
  const candidates = [cfg.terminalShell, process.env.SHELL, (() => { try { return os.userInfo().shell; } catch { return ''; } })(), process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', '/bin/sh'];
  for (const c of candidates) {
    if (!c || !path.isAbsolute(c)) continue;
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* try the next */
    }
  }
  return '/bin/sh';
}

let ptyProbe = null;
/** Can this host give us a PTY? (Python 3 with the standard `pty` module.) Cached briefly. */
export function ptySupport(cfg = {}) {
  const python = cfg.terminalPython || 'python3';
  if (ptyProbe && ptyProbe.python === python && Date.now() - ptyProbe.at < 30_000) return ptyProbe.result;
  const r = spawnSync(python, ['-c', 'import pty, termios, fcntl, select; print("ok")'], { encoding: 'utf8', timeout: 8000 });
  const ok = r.status === 0 && /ok/.test(r.stdout);
  const result = ok
    ? { ok: true, python }
    : { ok: false, python, reason: r.error?.code === 'ENOENT' ? `"${python}" was not found on the backend's PATH. The terminal needs Python 3 (standard library only) to allocate a pseudo-terminal. On macOS: xcode-select --install; on Debian/Ubuntu: apt install python3.` : `"${python}" cannot import the pty module (${redact((r.stderr || '').trim().split('\n').pop() || 'unknown error')}).` };
  ptyProbe = { python, at: Date.now(), result };
  return result;
}

class Session {
  constructor(opts) {
    Object.assign(this, opts);
    this.id = newId();
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    this.state = 'starting'; // starting | running | exited | failed
    this.exitCode = null;
    this.exitSignal = null;
    this.error = null;
    this.chunks = []; // retained output, newest last: { off, buf }
    this.bufStart = 0; // byte offset of the oldest retained byte
    this.total = 0; // bytes ever produced
    this.listeners = new Set(); // data/state callbacks of attached clients
    this.clients = 0;
    this.detachedAt = Date.now();
    this.shellPid = null;
    this.child = null;
    this.cwdCache = { at: 0, value: null };
  }
}

export class TerminalManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.sessions = new Map();
    this.sweeper = setInterval(() => this.sweep(), cfg.terminalSweepMs || 15_000);
    this.sweeper.unref();
  }

  get limits() {
    const c = this.cfg;
    return { maxSessions: c.terminalMaxSessions || 8, bufferBytes: c.terminalBufferBytes || 1_048_576, idleMs: c.terminalIdleMs ?? 30 * 60_000, exitedKeepMs: c.terminalExitedKeepMs ?? 10 * 60_000, maxInput: MAX_INPUT };
  }

  availability() {
    const pty = ptySupport(this.cfg);
    return { enabled: this.cfg.terminalEnabled !== false, pty: pty.ok, reason: pty.ok ? null : pty.reason, shell: path.basename(pickShell(this.cfg)), platform: `${process.platform}/${process.arch}`, ...this.limits };
  }

  /** Same answer for "no such session" and "somebody else's session": ids are capabilities, not hints. */
  get(id, owner) {
    const s = this.sessions.get(String(id));
    if (!s || s.owner !== owner) throw new TerminalError(404, 'terminal session not found (it may have been closed or cleaned up)');
    return s;
  }

  list(owner) {
    return [...this.sessions.values()].filter((s) => s.owner === owner).map((s) => this.view(s));
  }

  view(s) {
    const cwd = this.cwdOf(s);
    return {
      id: s.id, label: s.label, project: s.project, state: s.state, exitCode: s.exitCode, signal: s.exitSignal, error: s.error,
      cwd, startDir: s.startDir, insideProject: cwd ? within(s.startReal, cwd) : null,
      createdAt: new Date(s.createdAt).toISOString(), lastActiveAt: new Date(s.lastActive).toISOString(), cols: s.cols, rows: s.rows,
      attached: s.clients, bufferStart: s.bufStart, total: s.total, shell: path.basename(s.shell), tty: true,
    };
  }

  /** Start a session in `dir` (already authorized by the caller; see server.js resolveDirectory). */
  create({ owner, dir, project, label, cols, rows }) {
    if (this.cfg.terminalEnabled === false) throw new TerminalError(403, 'The terminal is turned off on this server (Settings → Server → Terminal).');
    const lim = this.limits;
    if ([...this.sessions.values()].filter((s) => s.owner === owner && s.state !== 'exited' && s.state !== 'failed').length >= lim.maxSessions) throw new TerminalError(429, `At most ${lim.maxSessions} terminals can be open at once. Close one first.`);
    const pty = ptySupport(this.cfg);
    if (!pty.ok) throw new TerminalError(503, pty.reason);
    let real;
    try {
      real = fs.realpathSync(dir);
      if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
    } catch (e) {
      throw new TerminalError(409, `The project directory is not available (${e.code === 'ENOENT' ? 'it was deleted or moved' : e.code === 'EACCES' ? 'permission denied' : 'not a directory'}). Nothing was started.`);
    }
    const shell = pickShell(this.cfg);
    const s = new Session({ owner, label: String(label || project?.name || path.basename(real)).slice(0, 60), project, startDir: real, startReal: real, shell, cols: clamp(cols, 20, 500, 100), rows: clamp(rows, 5, 200, 30) });
    const env = { ...terminalEnv(), DA_PTY_CWD: real, DA_PTY_COLS: String(s.cols), DA_PTY_ROWS: String(s.rows) };
    // argv is an array end to end: no shell string is ever built from user input.
    const child = spawn(pty.python, [HELPER, '--', shell, '-l'], { cwd: real, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], detached: true });
    s.child = child;
    child.on('error', (e) => this.fail(s, `Could not start the terminal helper: ${redact(e.message)}`));
    let ev = '';
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', (d) => {
      ev += d;
      let i;
      while ((i = ev.indexOf('\n')) >= 0) {
        const line = ev.slice(0, i);
        ev = ev.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.event === 'started') (s.shellPid = m.pid, this.setState(s, 'running'));
          if (m.event === 'exit') this.exited(s, m.code, m.signal);
        } catch {
          /* ignore noise */
        }
      }
    });
    child.stdout.on('data', (buf) => this.output(s, buf));
    let errText = '';
    child.stderr.on('data', (d) => { if (errText.length < 2000) errText += d; });
    child.stdin.on('error', () => {});
    child.stdio[3].on('error', () => {});
    child.on('close', (code) => {
      if (s.state === 'starting' || s.state === 'running') {
        // The helper died without reporting: python crashed, was killed, or never started.
        this.exited(s, code, null);
        if (errText.trim()) s.error = redact(errText.trim().split('\n').slice(-3).join(' | '));
      }
    });
    this.sessions.set(s.id, s);
    return s;
  }

  fail(s, message) {
    s.error = message;
    this.setState(s, 'failed');
  }

  setState(s, state) {
    if (s.state === state) return;
    s.state = state;
    s.stateAt = Date.now();
    for (const l of s.listeners) l.onState?.(this.view(s));
  }

  exited(s, code, signal) {
    if (s.state === 'exited') return;
    s.exitCode = code ?? null;
    s.exitSignal = signal ?? null;
    this.setState(s, 'exited');
    this.reapTree(s);
  }

  /** Append output to the bounded ring and wake attached clients. Memory per session is capped at `bufferBytes`. */
  output(s, buf) {
    s.chunks.push({ off: s.total, buf });
    s.total += buf.length;
    let kept = s.total - s.bufStart;
    const max = this.limits.bufferBytes;
    while (kept > max && s.chunks.length > 1) {
      const c = s.chunks.shift();
      s.bufStart = c.off + c.buf.length;
      kept = s.total - s.bufStart;
    }
    for (const l of s.listeners) l.onData?.();
  }

  /** Bytes from `from` (clamped to what is still retained). Returns { off, buf, skipped } — skipped>0 means output was dropped. */
  read(s, from, maxBytes = 65536) {
    let want = Math.max(0, Number(from) || 0);
    let skipped = 0;
    if (want < s.bufStart) (skipped = s.bufStart - want, want = s.bufStart);
    if (want >= s.total) return { off: want, buf: Buffer.alloc(0), skipped };
    const parts = [];
    let got = 0;
    for (const c of s.chunks) {
      const end = c.off + c.buf.length;
      if (end <= want) continue;
      const slice = c.buf.subarray(Math.max(0, want - c.off));
      parts.push(slice);
      got += slice.length;
      if (got >= maxBytes) break;
    }
    return { off: want, buf: Buffer.concat(parts).subarray(0, maxBytes), skipped };
  }

  /** Register a client. `onData` / `onState` are callbacks; the returned function detaches (the session keeps running). */
  attach(s, listener) {
    s.listeners.add(listener);
    s.clients += 1;
    s.lastActive = Date.now();
    return () => {
      if (!s.listeners.delete(listener)) return;
      s.clients -= 1;
      s.detachedAt = Date.now();
    };
  }

  write(s, data) {
    const buf = Buffer.from(String(data ?? ''), 'utf8');
    if (buf.length > MAX_INPUT) throw new TerminalError(413, `Input is limited to ${MAX_INPUT} bytes per message. Paste smaller pieces or use a file.`);
    // 'starting' is fine: the pipe holds the bytes and the PTY line discipline buffers them until the shell reads.
    if (s.state !== 'running' && s.state !== 'starting') throw new TerminalError(409, 'The terminal is not running.');
    s.lastActive = Date.now();
    if (!s.child.stdin.writable) throw new TerminalError(409, 'The terminal is closing.');
    s.child.stdin.write(buf);
  }

  resize(s, cols, rows) {
    s.cols = clamp(cols, 2, 1000, s.cols);
    s.rows = clamp(rows, 1, 500, s.rows);
    if (s.state === 'running') s.child.stdio[3].write(`resize ${s.cols} ${s.rows}\n`);
    return s;
  }

  /** Signal the terminal's foreground process group (what Ctrl-C does). */
  signal(s, name) {
    if (!SIGNALS.includes(name)) throw new TerminalError(400, `Unsupported signal. Use one of: ${SIGNALS.join(', ')}.`);
    if (s.state !== 'running') throw new TerminalError(409, 'The terminal is not running.');
    s.lastActive = Date.now();
    s.child.stdio[3].write(`signal ${name}\n`);
  }

  /** Close: hang up the shell, then make sure nothing it started is left. Resolves when the tree is gone. */
  async close(s, { remove = true } = {}) {
    if (s.closing) return s.closing;
    s.closing = (async () => {
      const tree = s.shellPid ? descendants(s.shellPid) : [];
      if (s.child && s.state !== 'exited' && s.state !== 'failed') {
        try { s.child.stdio[3].write('kill\n'); } catch { /* helper already gone */ }
        await waitFor(() => s.state === 'exited' || s.state === 'failed' || !alive(s.child.pid), 3500);
      }
      this.reapTree(s, tree);
      if (s.child && alive(s.child.pid)) {
        try { process.kill(-s.child.pid, 'SIGKILL'); } catch { /* gone */ }
        try { process.kill(s.child.pid, 'SIGKILL'); } catch { /* gone */ }
      }
      if (s.state !== 'exited' && s.state !== 'failed') { s.exitSignal ??= 9; this.setState(s, 'exited'); }
      for (const l of [...s.listeners]) l.onClose?.();
      if (remove) this.sessions.delete(s.id);
    })();
    return s.closing;
  }

  /** Kill whatever is left of a session's process tree (daemonized children that outlived the shell). */
  reapTree(s, known = []) {
    const pids = new Set([...known, ...(s.shellPid ? descendants(s.shellPid) : [])]);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }

  cwdOf(s) {
    if (s.state !== 'running' || !s.shellPid) return s.cwdCache.value || s.startDir;
    if (Date.now() - s.cwdCache.at < 800) return s.cwdCache.value;
    let value = null;
    try {
      if (process.platform === 'linux') value = fs.readlinkSync(`/proc/${s.shellPid}/cwd`);
      else {
        const r = spawnSync('lsof', ['-a', '-p', String(s.shellPid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 2000 });
        value = (r.stdout || '').split('\n').find((l) => l.startsWith('n'))?.slice(1) || null;
      }
    } catch {
      /* process just exited */
    }
    s.cwdCache = { at: Date.now(), value: value || s.cwdCache.value };
    return s.cwdCache.value;
  }

  /** Abandoned sessions (no client for idleMs) and long-exited ones are cleaned up. */
  sweep(now = Date.now()) {
    const { idleMs, exitedKeepMs } = this.limits;
    for (const s of [...this.sessions.values()]) {
      if (s.closing) continue;
      const dead = s.state === 'exited' || s.state === 'failed';
      if (dead && s.clients === 0 && now - (s.stateAt || s.lastActive) > exitedKeepMs) this.close(s);
      else if (!dead && idleMs > 0 && s.clients === 0 && now - Math.max(s.detachedAt, s.lastActive) > idleMs) this.close(s);
    }
  }

  async closeAll() {
    clearInterval(this.sweeper);
    await Promise.allSettled([...this.sessions.values()].map((s) => this.close(s)));
  }

  /** Which developer tools does a login shell on this host find? Never includes secrets (only paths of known tools). */
  async diagnostics() {
    const shell = pickShell(this.cfg);
    const tools = ['git', 'node', 'npm', 'python3', 'cargo', 'rustc', 'ollama', 'pax', 'make'];
    const script = `printf '__DAP_PATH__%s\\n' "$PATH"; for t in ${tools.join(' ')}; do printf '__DAP_TOOL__%s=%s\\n' "$t" "$(command -v "$t" 2>/dev/null)"; done`;
    const out = await new Promise((resolve) => {
      execFile(shell, ['-l', '-i', '-c', script], { env: terminalEnv(), timeout: 15_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 20 }, (err, stdout) => resolve({ err, stdout: stdout || '' }));
    });
    const pathLine = /__DAP_PATH__(.*)/.exec(out.stdout)?.[1] || '';
    const found = Object.fromEntries([...out.stdout.matchAll(/__DAP_TOOL__(\w+)=(.*)/g)].map((m) => [m[1], m[2] || null]));
    const bgPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const loginPath = pathLine.split(path.delimiter).filter(Boolean);
    return {
      shell,
      startup: `${path.basename(shell)} is started as a login shell (-l): it reads the same startup files a Terminal.app window does (for zsh: /etc/zprofile incl. path_helper, ~/.zprofile, ~/.zshrc). da-prompt never edits them.`,
      timedOut: Boolean(out.err && out.err.killed),
      tools: tools.map((name) => ({ name, path: found[name] || null })),
      path: loginPath,
      onlyInLoginShell: loginPath.filter((p) => !bgPath.includes(p)),
      backendPath: bgPath,
    };
  }
}

function within(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}
