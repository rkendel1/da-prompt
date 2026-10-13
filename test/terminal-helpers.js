// Fixtures for terminal tests: a real backend with an authorized project, a tiny HTTP client, and an SSE reader.
import fs from 'node:fs';
import path from 'node:path';
import { startBackend } from './cli-helpers.js';
import { makeRoot, git, writeFiles, NODE_FILES } from './project-helpers.js';
import { waitFor } from './helpers.js';

export const gitProject = (d) => {
  git(d, 'init', '-q', '-b', 'main');
  writeFiles(d, NODE_FILES);
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'initial');
};

export async function startTerminalBackend({ password, extra = {}, projects = { app: gitProject }, readOnly = false } = {}) {
  const roots = makeRoot(projects, { readOnly });
  const be = await startBackend({ ...roots.cfg, terminalShell: '/bin/sh', ...(password ? { password } : {}), ...extra });
  const headers = (h = {}) => ({ 'content-type': 'application/json', ...(password ? { authorization: `Basic ${Buffer.from(`u:${password}`).toString('base64')}` } : {}), ...h });
  const call = async (method, p, body, h) => {
    const res = await fetch(be.url + p, { method, headers: headers(h), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, body: data };
  };
  const dirId = async (name = 'app') => (await call('GET', '/api/projects/directories')).body.directories.find((d) => d.name === name).id;
  const open = async (name = 'app', extraBody = {}) => {
    const r = await call('POST', '/api/terminal/sessions', { directoryId: await dirId(name), cols: 100, rows: 30, ...extraBody });
    if (r.status !== 201) throw new Error(`open failed ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body.session;
  };
  const sse = (id, after = 0, h) => new Sse(`${be.url}/api/terminal/sessions/${id}/stream?after=${after}`, headers(h));
  const type = async (id, data, expect = 200) => {
    const r = await call('POST', `/api/terminal/sessions/${id}/input`, { data });
    if (expect !== null && r.status !== expect) throw new Error(`input got ${r.status}: ${JSON.stringify(r.body)}`);
    return r;
  };
  return { ...be, roots, call, open, dirId, sse, type, headers };
}

/** Reads a terminal event stream: accumulates decoded output, remembers offsets and state events. */
export class Sse {
  constructor(url, headers) {
    this.text = '';
    this.chunks = [];
    this.states = [];
    this.truncated = [];
    this.offset = 0;
    this.status = null;
    this.ended = false;
    this.ctl = new AbortController();
    this.ready = this.run(url, headers);
  }

  async run(url, headers) {
    let res;
    try {
      res = await fetch(url, { headers, signal: this.ctl.signal });
    } catch {
      this.ended = true;
      return;
    }
    this.status = res.status;
    if (res.status !== 200) {
      this.body = await res.text();
      this.ended = true;
      return;
    }
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const part of res.body) {
        buf += dec.decode(part, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          this.handle(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      }
    } catch { /* aborted */ }
    this.ended = true;
  }

  handle(block) {
    const ev = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (!ev || !data) return;
    const m = JSON.parse(data);
    if (ev === 'data') {
      const bytes = Buffer.from(m.b64, 'base64');
      this.chunks.push({ off: m.off, len: bytes.length });
      this.offset = m.off + bytes.length;
      this.text += bytes.toString('utf8');
    } else if (ev === 'state') this.states.push(m);
    else if (ev === 'truncated') this.truncated.push(m);
  }

  get state() { return this.states.at(-1); }
  waitText(re, timeoutMs = 15000) { return waitFor(() => (re instanceof RegExp ? re.test(this.text) : this.text.includes(re)), { timeoutMs, intervalMs: 25 }); }
  waitState(fn, timeoutMs = 15000) { return waitFor(() => this.states.some(fn), { timeoutMs, intervalMs: 25 }); }
  close() { this.ctl.abort(); }
}

export const pidsFrom = (text, tag) => [...text.replace(/\r/g, '').matchAll(new RegExp(`${tag}=(\\d+)`, 'g'))].map((m) => Number(m[1]));
export { fs, path };
