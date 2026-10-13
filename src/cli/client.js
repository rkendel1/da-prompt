// A small client for the backend's documented HTTP API. It uses node:http (no client-side headers timeout),
// has explicit timeouts everywhere, and follows the event stream with automatic, resumable reconnects.
import http from 'node:http';
import https from 'node:https';
import { CliError, EXIT } from './core.js';
import { clean } from './core.js';

const NET = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN', 'EPIPE']);

export function httpError(status, body, url) {
  const msg = clean(body?.error || (typeof body === 'string' ? body.slice(0, 200) : '') || `request failed (${status})`);
  const code = status === 400 ? EXIT.USAGE : status === 401 || status === 403 || status === 409 ? EXIT.DENIED : status === 404 ? EXIT.NOT_FOUND : status >= 500 ? EXIT.UNAVAILABLE : EXIT.FAILED;
  const hint = status === 401 ? 'The server needs a password: set DA_PROMPT_PASSWORD (or FACTORY_PASSWORD) for this command.' : status === 403 ? (/authenticated|server machine/.test(msg) ? 'This action needs an authenticated session or a client on the server machine.' : 'The backend refused this; the CLI has no extra authority over the browser.') : undefined;
  return new CliError(msg, { code, hint, details: body && typeof body === 'object' ? { status, ...(body.errors ? { errors: body.errors } : {}), ...(body.conflicts ? { conflicts: body.conflicts } : {}) } : { status } });
}

export class Client {
  constructor({ url, password = '', timeoutMs = 30_000 } = {}) {
    this.base = new URL(url);
    this.password = password;
    this.timeoutMs = timeoutMs;
  }

  get url() {
    return this.base.origin;
  }

  headers(extra = {}) {
    const h = { accept: 'application/json', ...extra };
    if (this.password) h.authorization = `Basic ${Buffer.from(`da-prompt:${this.password}`).toString('base64')}`;
    return h;
  }

  /** One request. Resolves { status, data, headers }; rejects only for transport problems (as CliError). */
  raw(method, path, { body, timeoutMs = this.timeoutMs, signal } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(path, this.base);
      const mod = u.protocol === 'https:' ? https : http;
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = mod.request(u, { method, headers: this.headers(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), timeout: timeoutMs, signal }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = text;
          if ((res.headers['content-type'] || '').includes('json')) {
            try {
              data = JSON.parse(text);
            } catch {
              /* keep text */
            }
          }
          resolve({ status: res.statusCode, data, headers: res.headers, text });
        });
        res.on('error', (e) => reject(this.transport(e, path)));
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', timedOut: true })));
      req.on('error', (e) => reject(e.name === 'AbortError' ? e : this.transport(e, path)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  transport(e, path) {
    if (e.timedOut || e.code === 'ETIMEDOUT') return new CliError(`The backend at ${this.url} did not answer ${path} in ${Math.round(this.timeoutMs / 1000)}s.`, { code: EXIT.TIMEOUT, hint: 'Check that the server is responsive (da-prompt status), or raise --timeout.' });
    if (NET.has(e.code) || /socket hang up/.test(e.message)) return new CliError(`Cannot reach the da-prompt backend at ${this.url} (${e.code || e.message}).`, { code: EXIT.UNAVAILABLE, hint: 'Start it with: da-prompt server start (commands do this for you unless --no-start is given).' });
    return new CliError(`Request to ${this.url} failed: ${clean(e.message)}`, { code: EXIT.UNAVAILABLE });
  }

  /** Request and require success; the parsed body is returned. */
  async call(method, path, body, opts = {}) {
    const r = await this.raw(method, path, { body, ...opts });
    if (r.status >= 200 && r.status < 300) return r.data;
    throw httpError(r.status, r.data, this.url);
  }

  get(path, opts) {
    return this.call('GET', path, undefined, opts);
  }
  post(path, body = {}, opts) {
    return this.call('POST', path, body, opts);
  }
  put(path, body = {}, opts) {
    return this.call('PUT', path, body, opts);
  }
  patch(path, body = {}, opts) {
    return this.call('PATCH', path, body, opts);
  }
  del(path, opts) {
    return this.call('DELETE', path, undefined, opts);
  }

  /** Download a (text or binary) body to a writable stream. */
  download(path, dest, { timeoutMs = 120_000 } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(path, this.base);
      const req = (u.protocol === 'https:' ? https : http).get(u, { headers: this.headers({ accept: '*/*' }), timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            let body = Buffer.concat(chunks).toString('utf8');
            try {
              body = JSON.parse(body);
            } catch {
              /* text */
            }
            reject(httpError(res.statusCode, body, this.url));
          });
          return;
        }
        res.pipe(dest);
        res.on('end', () => resolve());
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', timedOut: true })));
      req.on('error', (e) => reject(this.transport(e, path)));
    });
  }

  /**
   * Follow a run's event stream. Reconnects (resuming after the last seen event) when the connection drops,
   * for up to `reconnectMs` of continuous failure. `onEvent(e)` may return true to stop following.
   * Resolves { lastSeq, reason: 'done' | 'aborted' | 'unreachable' }.
   */
  async follow(runId, { after = 0, onEvent, signal, reconnectMs = 60_000, idleMs = 45_000, onState } = {}) {
    let last = after;
    let failingSince = null;
    while (!signal?.aborted) {
      const outcome = await new Promise((resolve) => {
        const u = new URL(`/api/runs/${encodeURIComponent(runId)}/events?after=${last}`, this.base);
        let buf = '';
        let finished = false;
        let idle;
        const end = (v) => {
          if (finished) return;
          finished = true;
          clearTimeout(idle);
          req.destroy();
          resolve(v);
        };
        const arm = () => {
          clearTimeout(idle);
          idle = setTimeout(() => end({ retry: true, why: 'idle' }), idleMs); // the server pings every 15s
        };
        const req = (u.protocol === 'https:' ? https : http).get(u, { headers: this.headers({ accept: 'text/event-stream' }) }, (res) => {
          if (res.statusCode !== 200) {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              let body = Buffer.concat(chunks).toString('utf8');
              try {
                body = JSON.parse(body);
              } catch {
                /* text */
              }
              end({ fatal: httpError(res.statusCode, body, this.url) });
            });
            return;
          }
          failingSince = null;
          onState?.('connected');
          arm();
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            arm();
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n\n')) !== -1) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
              if (!data) continue;
              let evt;
              try {
                evt = JSON.parse(data);
              } catch {
                continue;
              }
              if (evt.seq > last) {
                last = evt.seq;
                if (onEvent?.(evt) === true) return end({ done: true });
              }
            }
          });
          res.on('end', () => end({ retry: true, why: 'closed' }));
          res.on('error', () => end({ retry: true, why: 'error' }));
        });
        req.on('error', () => end({ retry: true, why: 'unreachable' }));
        signal?.addEventListener('abort', () => end({ aborted: true }), { once: true });
      });
      if (outcome.fatal) throw outcome.fatal;
      if (outcome.done) return { lastSeq: last, reason: 'done' };
      if (outcome.aborted) return { lastSeq: last, reason: 'aborted' };
      failingSince ??= Date.now();
      onState?.('reconnecting');
      if (Date.now() - failingSince > reconnectMs) return { lastSeq: last, reason: 'unreachable' };
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { lastSeq: last, reason: 'aborted' };
  }
}
