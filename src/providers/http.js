// Minimal JSON-over-HTTP client on node:http/https.
// Unlike global fetch it has no 5-minute headers timeout, which matters for local models
// that can take many minutes to answer a long prompt on CPU.

import http from 'node:http';
import https from 'node:https';

export class HttpError extends Error {
  constructor(status, body, headers = {}) {
    super(`HTTP ${status}: ${String(body).slice(0, 500)}`);
    this.status = status;
    this.body = String(body);
    this.headers = headers;
  }
}

/**
 * Request JSON. Resolves with parsed JSON for 2xx; rejects with HttpError for other statuses,
 * or an Error with `code` for network failures (ECONNREFUSED, ETIMEDOUT, ...).
 */
export function requestJson(url, { method = 'GET', headers = {}, body, signal, timeoutMs = 15 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(Object.assign(new Error(`invalid URL: ${url}`), { code: 'EINVALIDURL' }));
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = lib.request(
      u,
      {
        method,
        headers: {
          accept: 'application/json',
          ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          cleanup();
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new HttpError(res.statusCode, text, res.headers));
          if (!text) return resolve({});
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(Object.assign(new Error(`invalid JSON from ${u.host}: ${text.slice(0, 200)}`), { code: 'EBADJSON' }));
          }
        });
        res.on('error', (err) => {
          cleanup();
          reject(err);
        });
      },
    );
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`request timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })), timeoutMs);
    const onAbort = () => req.destroy(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    req.on('error', (err) => {
      cleanup();
      reject(err);
    });
    if (signal?.aborted) onAbort();
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const NET_RETRYABLE = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET']);

/** requestJson with retries on rate limits, overloads and transient network errors. */
export async function requestWithRetry(url, opts = {}, { retries = 4 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new Error('cancelled');
    try {
      return await requestJson(url, opts);
    } catch (err) {
      last = err;
      if (opts.signal?.aborted) throw new Error('cancelled');
      const retryable = err instanceof HttpError ? RETRYABLE.has(err.status) : NET_RETRYABLE.has(err.code);
      if (!retryable || attempt === retries) throw err;
      const ra = Number(err.headers?.['retry-after']);
      const wait = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 400);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

/** Turn provider/network errors into one readable line. */
export function describeError(err) {
  if (err instanceof HttpError) {
    let msg = err.body;
    try {
      const j = JSON.parse(err.body);
      msg = j.error?.message || j.error || j.message || err.body;
    } catch {
      /* not JSON */
    }
    return `HTTP ${err.status}: ${String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 300)}`;
  }
  if (err?.code === 'ECONNREFUSED') return 'connection refused (is the server running?)';
  if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') return 'host not found';
  if (err?.code === 'ETIMEDOUT') return 'timed out';
  return err?.message || String(err);
}
