// Local inference control: how many generations may run at once on one local endpoint, how much of the context window a
// request may use, and what happens when it does not fit.
//
// Logical task concurrency (maxParallel: how many plan tasks run their agent loops at once) is a different thing from
// generation concurrency (how many model requests the local server works on at once). Tasks spend most of their time in
// tools and verification, so many tasks can be in flight while only `maxLocalInference` of them wait on the GPU. A slot is
// held only for the duration of provider.chat(): never while a tool, a check or the filesystem is busy.

import { ContextOverflowError, outputReserve } from './providers/context.js';
export { ContextOverflowError, outputReserve };

/** An estimate that leans high (code and JSON tokenize worse than prose): 3.5 characters per token. */
export const estimateTokens = (chars) => Math.ceil(chars / 3.5);

export class InferenceLimiter {
  constructor(max = 1) {
    this.max = Math.max(1, Math.floor(max) || 1);
    this.active = 0;
    this.queue = [];
    this.stats = { acquired: 0, peakActive: 0, peakQueued: 0, queuedMs: 0, aborted: 0 };
  }

  /** Resolves with a release function once a slot is free. Rejects promptly (and leaves the queue) when `signal` aborts. */
  acquire(signal) {
    if (signal?.aborted) {
      this.stats.aborted += 1;
      return Promise.reject(new Error('cancelled'));
    }
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.active += 1;
        this.stats.acquired += 1;
        this.stats.peakActive = Math.max(this.stats.peakActive, this.active);
        const waited = performance.now() - t0;
        this.stats.queuedMs += waited;
        let released = false;
        resolve({ queuedMs: Math.round(waited), release: () => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.next();
        } });
      };
      if (this.active < this.max) return grant();
      const waiter = { grant, abort: null };
      waiter.abort = () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        this.stats.aborted += 1;
        reject(new Error('cancelled'));
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      waiter.cleanup = () => signal?.removeEventListener('abort', waiter.abort);
      this.queue.push(waiter);
      this.stats.peakQueued = Math.max(this.stats.peakQueued, this.queue.length);
    });
  }

  next() {
    while (this.active < this.max && this.queue.length) {
      const w = this.queue.shift();
      w.cleanup?.();
      w.grant();
    }
  }

  snapshot() {
    return { max: this.max, active: this.active, queued: this.queue.length, ...this.stats, queuedMs: Math.round(this.stats.queuedMs) };
  }
}

/**
 * Wrap a provider so every chat() takes a generation slot first. The result gains `inference`: { queuedMs, generationMs, …the
 * backend's own timings when it reports them }. The wrapper changes nothing else about the request or the reply.
 */
export function limitProvider(provider, limiter) {
  if (!provider || typeof provider.chat !== 'function' || !limiter) return provider;
  const wrapped = Object.create(provider);
  wrapped.chat = async (req) => {
    const slot = await limiter.acquire(req?.signal);
    const t = performance.now();
    try {
      const res = await provider.chat(req);
      return { ...res, inference: { queuedMs: slot.queuedMs, generationMs: Math.round(performance.now() - t), concurrency: limiter.max, ...(res.timings || {}) } };
    } finally {
      slot.release();
    }
  };
  return wrapped;
}

// ── context budget ────────────────────────────────────────────────────────────────────────────────

const charsOf = (m) => {
  if (typeof m.content === 'string') return m.content.length;
  let n = 0;
  for (const b of m.content || []) n += String(b.text ?? (typeof b.content === 'string' ? b.content : b.content ? JSON.stringify(b.content) : '') ?? '').length + (b.input ? JSON.stringify(b.input).length : 0);
  return n;
};

export const requestChars = (system, messages, tools = []) => String(system || '').length + messages.reduce((a, m) => a + charsOf(m), 0) + JSON.stringify(tools || []).length;

const clip = (s, keep) => (s.length <= keep ? s : `${s.slice(0, Math.ceil(keep * 0.6))}\n…[${s.length - keep} chars trimmed to fit the context window]…\n${s.slice(-Math.floor(keep * 0.4))}`);

/**
 * Fit a conversation into `budgetTokens` (prompt side). Never touches the system prompt or the first user message (the task
 * brief with its acceptance criteria and verification commands) nor the newest turn (the tool results the model must act on).
 * What it does shrink, oldest first: earlier tool results, then the bodies of earlier write_file calls (the file is on disk).
 * Returns { messages, trimmed, tokens }. Throws ContextOverflowError when the protected part alone does not fit.
 */
export function fitContext({ system, messages, tools, budgetTokens }) {
  const protectedTail = 2; // the last assistant turn and its tool results
  let out = messages.map((m) => ({ ...m }));
  const tokens = () => estimateTokens(requestChars(system, out, tools));
  let trimmed = 0;
  if (tokens() <= budgetTokens) return { messages: out, trimmed, tokens: tokens() };
  const lastTrimmable = out.length - protectedTail;
  const shrink = (keep) => {
    for (let i = 1; i < lastTrimmable && tokens() > budgetTokens; i++) {
      const m = out[i];
      if (!Array.isArray(m.content)) continue;
      m.content = m.content.map((b) => {
        if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > keep) {
          trimmed += 1;
          return { ...b, content: clip(b.content, keep) };
        }
        if (b.type === 'tool_use' && b.name === 'write_file' && typeof b.input?.content === 'string' && b.input.content.length > keep) {
          trimmed += 1;
          return { ...b, input: { ...b.input, content: `[${b.input.content.length} chars written to ${b.input.path}; the file is on disk]` } };
        }
        return b;
      });
    }
  };
  for (const keep of [1200, 400, 120]) {
    shrink(keep);
    if (tokens() <= budgetTokens) return { messages: out, trimmed, tokens: tokens() };
  }
  // Last resort before giving up: shrink the newest tool results too (head and tail are kept), but never the brief or the system prompt.
  for (const keep of [1500, 600]) {
    const m = out[out.length - 1];
    if (Array.isArray(m?.content)) {
      m.content = m.content.map((b) => (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > keep ? (trimmed += 1, { ...b, content: clip(b.content, keep) }) : b));
    }
    if (tokens() <= budgetTokens) return { messages: out, trimmed, tokens: tokens() };
  }
  const need = tokens();
  throw new ContextOverflowError(`the request needs about ${need} tokens but only ${budgetTokens} fit in the context window after trimming older turns; raise the context window (numCtx) or split the task`, { needTokens: need, budgetTokens });
}
