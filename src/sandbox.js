import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SKIP_DIRS = new Set(['node_modules', '.git', '.home', '.cache', '__pycache__', '.venv', 'dist', 'build']);
const MAX_FILE_BYTES = 1_000_000;
const MAX_OUTPUT = 48_000;

// Commands an agent may never run. Real isolation comes from running the factory in a container;
// this list stops the obvious foot-guns.
const DENY = [
  [/\bsudo\b/, 'sudo is not allowed'],
  [/\brm\s+(-[a-z]*\s+)*(\/|~|\$HOME)(\s|$)/i, 'deleting outside the workspace is not allowed'],
  [/\bmkfs\b|\bshutdown\b|\breboot\b|\bhalt\b/, 'system commands are not allowed'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bombs are not allowed'],
  [/\bgit\s+push\b/, 'agents cannot push; the factory delivers code'],
];

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

export class Workspace {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
    this.realRoot = fs.realpathSync(this.root);
  }

  /** Resolve a workspace-relative path, refusing anything that escapes the workspace. */
  resolve(rel) {
    if (typeof rel !== 'string' || !rel.trim()) throw new Error('path is required');
    const clean = rel.replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (path.isAbsolute(clean)) throw new Error(`absolute paths are not allowed: ${rel}`);
    const abs = path.resolve(this.root, clean);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error(`path escapes workspace: ${rel}`);
    // Guard against symlinks that point outside.
    let probe = abs;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep)) throw new Error(`path escapes workspace: ${rel}`);
    return abs;
  }

  async writeFile(rel, content) {
    const abs = this.resolve(rel);
    const data = String(content ?? '');
    if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new Error(`file too large (max ${MAX_FILE_BYTES} bytes)`);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, data);
    return { path: this.rel(abs), bytes: Buffer.byteLength(data) };
  }

  async readFile(rel, { maxBytes = 200_000 } = {}) {
    const abs = this.resolve(rel);
    const st = await fsp.stat(abs);
    if (st.isDirectory()) throw new Error(`${rel} is a directory`);
    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) return `[binary file, ${buf.length} bytes]`;
    const text = buf.toString('utf8');
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n…[truncated ${text.length - maxBytes} chars]` : text;
  }

  exists(rel) {
    try {
      return fs.existsSync(this.resolve(rel));
    } catch {
      return false;
    }
  }

  rel(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  /** List files (not directories) under the workspace, skipping dependency/vcs folders. */
  async listFiles(sub = '.', { limit = 2000 } = {}) {
    const start = sub === '.' || sub === '' ? this.root : this.resolve(sub);
    const out = [];
    const walk = async (dir) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= limit) return;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) await walk(abs);
        } else if (e.isFile()) {
          const st = await fsp.stat(abs);
          out.push({ path: this.rel(abs), size: st.size });
        }
      }
    };
    await walk(start);
    return out;
  }

  /** Run a shell command inside the workspace with a timeout and a scrubbed environment. */
  runCommand(command, { timeoutMs = 180_000, env = {}, signal } = {}) {
    return new Promise((resolve) => {
      const denied = DENY.find(([re]) => re.test(command));
      if (denied) {
        resolve({ command, exitCode: 126, stdout: '', stderr: `blocked: ${denied[1]}`, durationMs: 0, timedOut: false });
        return;
      }
      const started = Date.now();
      const home = path.join(this.root, '.home');
      fs.mkdirSync(home, { recursive: true });
      const child = spawn('sh', ['-c', command], {
        cwd: this.root,
        env: { ...safeEnv(), HOME: home, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const cap = (s, chunk) => {
        s += chunk.toString();
        return s.length > MAX_OUTPUT * 2 ? s.slice(-MAX_OUTPUT) : s;
      };
      child.stdout.on('data', (c) => (stdout = cap(stdout, c)));
      child.stderr.on('data', (c) => (stderr = cap(stderr, c)));
      let timedOut = false;
      const kill = () => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const onAbort = () => kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (err) => {
        stderr += String(err.message);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({
          command,
          exitCode: timedOut ? 124 : code ?? 1,
          stdout: tail(stdout),
          stderr: tail(stderr) + (timedOut ? `\n[timed out after ${timeoutMs}ms]` : ''),
          durationMs: Date.now() - started,
          timedOut,
        });
      });
    });
  }
}

function tail(s) {
  return s.length > MAX_OUTPUT ? `…[truncated]\n${s.slice(-MAX_OUTPUT)}` : s;
}

/** The parent environment minus anything that looks like a credential. */
export function safeEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV.test(k)) continue;
    env[k] = v;
  }
  return env;
}
