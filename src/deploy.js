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
    const port = await freePort();
    const home = path.join(workspaceRoot, '.home');
    fs.mkdirSync(home, { recursive: true });
    const child = spawn('sh', ['-c', start], {
      cwd: workspaceRoot,
      env: { ...safeEnv(), HOME: home, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production' },
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
    const entry = { port, child, startedAt: Date.now(), logs, healthPath };
    this.previews.set(runId, entry);

    const deadline = Date.now() + timeoutMs;
    let lastErr = 'not started';
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        this.previews.delete(runId);
        return { ok: false, port, error: `process exited with code ${child.exitCode}`, logs: logs.slice(-40) };
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}${healthPath.startsWith('/') ? healthPath : `/${healthPath}`}`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const body = (await res.text()).slice(0, 500);
          return { ok: true, port, status: res.status, body, logs: logs.slice(-20) };
        }
        lastErr = `health check returned ${res.status}`;
      } catch (err) {
        lastErr = err.cause?.code || err.message;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    this.stop(runId);
    return { ok: false, port, error: `health check failed: ${lastErr}`, logs: logs.slice(-40) };
  }

  stop(runId) {
    const p = this.previews.get(runId);
    if (!p) return false;
    try {
      process.kill(-p.child.pid, 'SIGTERM');
    } catch {
      /* gone */
    }
    setTimeout(() => {
      try {
        process.kill(-p.child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, 2000).unref();
    this.previews.delete(runId);
    return true;
  }

  stopAll() {
    for (const id of [...this.previews.keys()]) this.stop(id);
  }
}
