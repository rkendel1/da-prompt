// Layer 7 deployment: start the generated app as a managed process and health-check it.
// The factory's HTTP server exposes it at /preview/<runId>/ so the deployment has a real URL.

import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { safeEnv } from './sandbox.js';

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Stop a process started by launchApp (its whole process group): SIGTERM, then SIGKILL after 2 s. */
export function stopProcess(child) {
  for (const [signal, delay] of [['SIGTERM', 0], ['SIGKILL', 2000]]) {
    const kill = () => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* gone */
      }
    };
    if (delay) setTimeout(kill, delay).unref();
    else kill();
  }
}

/**
 * Start a generated app the way it is deployed: `start` through sh in `root`, PORT on a free loopback port, the secret-free
 * environment plus `env`, and wait until `healthPath` answers 2xx. Resolves { ok, port, child, logs, status?, body?, error? };
 * the caller stops a running app with stopProcess(child). A failed start is stopped here. Used by previews and the AppPort gate.
 */
export async function launchApp(root, { start, healthPath = '/' }, { timeoutMs = 30_000, env = {}, onSpawn } = {}) {
  const port = await freePort();
  const home = path.join(root, '.home');
  fs.mkdirSync(home, { recursive: true });
  const child = spawn('sh', ['-c', start], {
    cwd: root,
    env: { ...safeEnv(), HOME: home, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  const push = (stream) => (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line) continue;
      logs.push(`[${stream}] ${line}`);
      if (logs.length > 200) logs.shift();
    }
  };
  child.stdout.on('data', push('out'));
  child.stderr.on('data', push('err'));
  onSpawn?.({ port, child, logs });

  const deadline = Date.now() + timeoutMs;
  let lastErr = 'not started';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { ok: false, port, child, error: `process exited with code ${child.exitCode}`, logs: logs.slice(-40) };
    try {
      const res = await fetch(`http://127.0.0.1:${port}${healthPath.startsWith('/') ? healthPath : `/${healthPath}`}`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = (await res.text()).slice(0, 500);
        return { ok: true, port, child, status: res.status, body, logs: logs.slice(-20) };
      }
      lastErr = `health check returned ${res.status}`;
    } catch (err) {
      lastErr = err.cause?.code || err.message;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  stopProcess(child);
  return { ok: false, port, child, error: `health check failed: ${lastErr}`, logs: logs.slice(-40) };
}

export class PreviewManager {
  constructor({ max = 5 } = {}) {
    this.max = max;
    this.previews = new Map(); // runId -> { port, child, startedAt, logs }
  }

  get(runId) {
    const p = this.previews.get(runId);
    return p && p.child.exitCode === null && !p.child.killed ? p : null;
  }

  async start(runId, workspaceRoot, { start, healthPath = '/' }, { timeoutMs = 30_000 } = {}) {
    this.stop(runId);
    // Keep resource use bounded: evict the oldest preview.
    while (this.previews.size >= this.max) {
      const oldest = [...this.previews.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
      this.stop(oldest[0]);
    }
    const r = await launchApp(workspaceRoot, { start, healthPath }, {
      timeoutMs,
      onSpawn: (entry) => this.previews.set(runId, { ...entry, startedAt: Date.now(), healthPath }),
    });
    if (!r.ok) this.previews.delete(runId);
    const { child, ...result } = r;
    return result;
  }

  stop(runId) {
    const p = this.previews.get(runId);
    if (!p) return false;
    stopProcess(p.child);
    this.previews.delete(runId);
    return true;
  }

  stopAll() {
    for (const id of [...this.previews.keys()]) this.stop(id);
  }
}
