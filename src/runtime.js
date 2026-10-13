// Who owns this data directory? One backend process at a time. The server writes a record when it starts
// listening and removes it on exit; the CLI reads it to find (or to avoid duplicating) the running backend.
// Run state lives in that one process and its data directory — the CLI never keeps a second copy.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export const recordPath = (cfg) => path.join(cfg.dataDir, 'server.json');
export const lockPath = (cfg) => path.join(cfg.dataDir, 'server.lock');
export const logPath = (cfg) => path.join(cfg.dataDir, 'server.log');

export function readRecord(cfg) {
  try {
    const r = JSON.parse(fs.readFileSync(recordPath(cfg), 'utf8'));
    return r && Number.isInteger(r.pid) && typeof r.url === 'string' ? r : null;
  } catch {
    return null;
  }
}

export function writeRecord(cfg, rec) {
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${recordPath(cfg)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, recordPath(cfg));
}

/** Remove the record only if it still names `pid` (a newer server may have replaced it). */
export function removeRecord(cfg, pid = process.pid) {
  const r = readRecord(cfg);
  if (r && r.pid === pid) fs.rmSync(recordPath(cfg), { force: true });
}

export const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** GET /api/health with a short timeout. True only if a da-prompt backend answered. */
export function healthy(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const req = http.get(new URL('/api/health', url), { timeout: timeoutMs }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            finish(res.statusCode === 200 && JSON.parse(body).ok === true);
          } catch {
            finish(false);
          }
        });
      });
      req.on('timeout', () => (req.destroy(), finish(false)));
      req.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/** The running backend for this data directory, if any. A stale record (dead pid, no answer) is removed. */
export async function liveServer(cfg) {
  const r = readRecord(cfg);
  if (!r) return null;
  if (pidAlive(r.pid) && (await healthy(r.url))) return r;
  if (!pidAlive(r.pid)) fs.rmSync(recordPath(cfg), { force: true });
  return null;
}
