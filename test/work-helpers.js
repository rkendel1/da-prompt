// Fixtures for chat/backlog tests: a real backend over temp repos with a scripted provider that records what it was asked.
import fs from 'node:fs';
import path from 'node:path';
import { startRegistryBackend, initRepo, writer, git, writeFiles, NODE_FILES } from './registry-helpers.js';
import { OfflineProvider } from '../src/providers/offline.js';

export { initRepo, git, writeFiles, NODE_FILES, writer, path, fs };

/**
 * A deterministic chat provider. `reply(req)` returns the text (or throws); `stream` splits it into word-sized deltas
 * with an optional per-delta gate so tests can stop/observe mid-stream. Every request is kept in `calls`.
 */
export class ChatFake extends OfflineProvider {
  constructor({ reply = (r) => `Echo: ${r.last}`, stream = true, delayMs = 0, label = 'fake', model = 'fake-model' } = {}) {
    super({ faults: false, delayMs: 0 });
    this.replyFn = reply;
    this.streamMode = stream;
    this.deltaDelay = delayMs;
    this.calls = [];
    this.gate = null; // a promise the stream waits on after the first delta
    this.label = label;
    this.model = model;
    if (!stream) this.chatStream = undefined;
  }

  record(req) {
    const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content;
    const call = { system: req.system, messages: req.messages, last: typeof last === 'string' ? last : '' };
    this.calls.push(call);
    return call;
  }

  async chat(req) {
    if (req.meta?.kind !== 'chat') return super.chat(req);
    const call = this.record(req);
    if (req.signal?.aborted) throw new Error('cancelled');
    const text = await this.replyFn(call);
    return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  }
}

// Define chatStream on the prototype so `stream:false` can remove it per instance.
ChatFake.prototype.chatStream = async function chatStream(req) {
  const call = this.record(req);
  const text = await this.replyFn(call);
  const parts = text.match(/\S+\s*/g) || [text];
  let first = true;
  for (const p of parts) {
    if (req.signal?.aborted) throw Object.assign(new Error('cancelled'), { partial: '' });
    req.onText?.(p);
    if (first && this.gate) { first = false; await Promise.race([this.gate, new Promise((_, rej) => req.signal?.addEventListener('abort', () => rej(Object.assign(new Error('cancelled'), { partial: '' })), { once: true }))]); }
    if (this.deltaDelay) await new Promise((r) => setTimeout(r, this.deltaDelay));
  }
  return { text, usage: { input_tokens: 10, output_tokens: parts.length }, stop: 'end_turn' };
};

/** Backend with projects and a chat provider. */
export async function startWorkBackend({ roots, readOnlyRoots, password, fake = new ChatFake(), extra = {}, dataDir, rootInfo } = {}) {
  const be = await startRegistryBackend({ roots, readOnlyRoots, password, dataDir, rootInfo, extra: { providerFactory: (id) => (id === 'offline' ? new OfflineProvider({ faults: false, delayMs: 0 }) : fake), ...extra } });
  be.fake = fake;
  /** Read a conversation event stream until `until(events)` is true (or time runs out). */
  be.events = (id, until, { timeoutMs = 15000 } = {}) => new Promise((resolve, reject) => {
    const events = [];
    const ctl = new AbortController();
    const timer = setTimeout(() => { ctl.abort(); reject(new Error(`events timed out; saw ${events.map((e) => e.type).join(',')}`)); }, timeoutMs);
    fetch(`${be.url}/api/chat/conversations/${id}/stream`, { signal: ctl.signal, headers: be.password ? { authorization: `Basic ${Buffer.from(`u:${be.password}`).toString('base64')}` } : {} }).then(async (res) => {
      let buf = '';
      for await (const part of res.body) {
        buf += Buffer.from(part).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data) events.push({ ...JSON.parse(data), type: ev });
          if (until(events)) { clearTimeout(timer); ctl.abort(); return resolve(events); }
        }
      }
    }).catch((e) => { if (!ctl.signal.aborted) reject(e); });
  });
  /** Send a message and wait until that response is final; returns the final conversation. */
  be.ask = async (convoId, content, extraBody = {}) => {
    const r = await be.call('POST', `/api/chat/conversations/${convoId}/messages`, { content, ...extraBody });
    if (r.status !== 202) throw new Error(`send failed ${r.status}: ${JSON.stringify(r.body)}`);
    await be.settled(convoId);
    return { ...r.body, conversation: (await be.call('GET', `/api/chat/conversations/${convoId}`)).body.conversation };
  };
  be.settled = async (convoId, timeoutMs = 20000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const c = (await be.call('GET', `/api/chat/conversations/${convoId}`)).body.conversation;
      if (!c.generating && !c.messages.some((m) => m.status === 'streaming')) return c;
      if (Date.now() > end) throw new Error('response did not settle');
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  be.newConvo = async (projectId, body = {}) => {
    const r = await be.call('POST', '/api/chat/conversations', { projectId, provider: 'fake', model: 'fake-model', ...body });
    if (r.status !== 201) throw new Error(`create failed ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body.conversation;
  };
  be.newTask = async (body) => {
    const r = await be.call('POST', '/api/tasks', body);
    if (r.status !== 201) throw new Error(`task failed ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body.task;
  };
  return be;
}
