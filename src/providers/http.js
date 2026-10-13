// Minimal JSON-over-HTTP client on node:http/https.
// Unlike global fetch it has no 5-minute headers timeout, which matters for local models
// that can take many minutes to answer a long prompt on CPU.

import http from 'node:http';
import https from 'node:https';
import { noteRetry } from '../diagnostics.js';

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


/**
 * POST and stream the response body: `onChunk(string)` is called for every piece as it arrives. Resolves when the
 * body ends; rejects with HttpError for non-2xx (after reading the error body) or an Error with `code` for network
 * failures. Aborting `signal` ends the request with Error('cancelled'). No retries: a half-delivered stream is not retried.
 */
export function requestStream(url, { method = 'POST', headers = {}, body, signal, timeoutMs = 15 * 60_000, idleMs = 5 * 60_000 } = {}, onChunk) {
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
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(idle);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const req = lib.request(u, { method, headers: { accept: 'text/event-stream, application/x-ndjson, application/json', ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish(reject, new HttpError(res.statusCode, Buffer.concat(chunks).toString('utf8'), res.headers)));
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (c) => {
        resetIdle();
        try {
          onChunk(c);
        } catch (e) {
          req.destroy(e);
        }
      });
      res.on('end', () => finish(resolve));
      res.on('error', (e) => finish(reject, e));
      res.on('aborted', () => finish(reject, Object.assign(new Error('the connection closed before the response finished'), { code: 'ECONNRESET' })));
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`request timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })), timeoutMs);
    let idle;
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => req.destroy(Object.assign(new Error(`no data for ${Math.round(idleMs / 1000)}s`), { code: 'ETIMEDOUT' })), idleMs);
    };
    const onAbort = () => req.destroy(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => finish(reject, signal?.aborted ? Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }) : e));
    if (signal?.aborted) onAbort();
    if (payload !== undefined) req.write(payload);
    req.end();
    resetIdle();
  });
}

/** Split a stream into complete lines (handles chunks that end mid-line). */
export function lineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        onLine(line);
      }
    },
    end() {
      if (buf.trim()) onLine(buf.replace(/\r$/, ''));
      buf = '';
    },
  };
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const NET_RETRYABLE = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET']);

/** requestJson with retries on rate limits, overloads and transient network errors. */
export const DEFAULT_HTTP_RETRIES = 4;
export async function requestWithRetry(url, opts = {}, { retries = DEFAULT_HTTP_RETRIES } = {}) {
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
      noteRetry(err instanceof HttpError ? `http_${err.status}` : err.code);
      const ra = Number(err.headers?.['retry-after']);
      const wait = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 400);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

/** Turn provider/network errors into one readable line that says what kind of failure it was. */
export function describeError(err) {
  if (err instanceof HttpError) {
    let msg = err.body;
    try {
      const j = JSON.parse(err.body);
      msg = j.error?.message || j.error || j.message || err.body;
    } catch {
      /* not JSON */
    }
    const kind = err.status === 401 || err.status === 403 ? 'authentication failed (check the API key)' : err.status === 404 ? 'model or endpoint not found' : err.status === 429 ? 'rate limited' : err.status >= 500 ? 'provider-side error' : '';
    return `${kind ? `${kind}: ` : ''}HTTP ${err.status}: ${String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 300)}`;
  }
  if (err?.code === 'ECONNREFUSED') return 'connection failed: connection refused (is the server running?)';
  if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') return 'connection failed: host not found';
  if (err?.code === 'ETIMEDOUT') return 'inference timed out: no response in time';
  return err?.message || String(err);
}
