import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { runHealth } from '../src/health.js';
import { loadConfig } from '../src/config.js';
import { OfflineProvider } from '../src/providers/offline.js';
import { startMockLLM } from './mock-llm.js';
import { tmpDir } from './helpers.js';
import { makeRoot, makeRepo } from './project-helpers.js';
import { fakePax, withPath } from './pax-helpers.js';

// First-run conditions: no provider keys or servers from the machine's environment.
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'TOGETHER_API_KEY', 'VLLM_API_KEY', 'GITHUB_TOKEN', 'FACTORY_PASSWORD', 'FACTORY_PROVIDER', 'FACTORY_MODEL', 'FACTORY_PAX_PATH', 'FACTORY_PROJECT_ROOTS', 'FACTORY_PROJECT_ROOTS_READONLY']) delete process.env[k];
// Nothing listens on these ports.
Object.assign(process.env, { OLLAMA_HOST: 'http://127.0.0.1:9', LMSTUDIO_BASE_URL: 'http://127.0.0.1:9/v1', LLAMACPP_BASE_URL: 'http://127.0.0.1:9/v1', VLLM_BASE_URL: 'http://127.0.0.1:9/v1' });

let app;
let base;
const servers = [];
const startServer = async (extra = {}) => {
  const a = await createServer({ dataDir: tmpDir(), hideOffline: false, providerFactory: undefined, ...extra });
  await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  servers.push(a);
  return { app: a, base: `http://127.0.0.1:${a.server.address().port}` };
};
after(async () => {
  for (const s of servers) await s.close();
});
const get = async (b, p, h = {}) => {
  const r = await fetch(b + p, { headers: h });
  return { status: r.status, data: await r.json() };
};
const byId = (health) => Object.fromEntries(health.checks.map((c) => [c.id, c]));

test('first run: nothing is configured, and the health report says exactly what is missing and how to fix it', async () => {
  const s = await startServer();
  const { status, data } = await get(s.base, '/api/system/health?refresh=1');
  assert.equal(status, 200);
  const c = byId(data);
  assert.deepEqual(data.checks.map((x) => x.id), ['backend', 'data', 'security', 'providers', 'default-model', 'output', 'roots', 'git', 'github', 'pax']);
  assert.equal(data.needsSetup, true);
  assert.equal(data.ready, false);
  assert.equal(c.backend.status, 'ok');
  assert.equal(c.data.status, 'ok');
  assert.equal(c.providers.status, 'fail');
  assert.match(c.providers.summary, /No real model provider is usable/);
  assert.equal(c.providers.remediation.ui.href, '#/providers');
  const ollama = c.providers.providers.find((p) => p.id === 'ollama');
  assert.equal(ollama.status, 'unreachable');
  assert.match(ollama.fix.text, /Start it on the machine that runs da-prompt/);
  const anthropic = c.providers.providers.find((p) => p.id === 'anthropic');
  assert.equal(anthropic.status, 'no_key');
  assert.match(anthropic.fix.text, /Add an API key for Anthropic.*never shown again/);
  assert.equal(c['default-model'].status, 'warn');
  assert.match(c['default-model'].summary, /offline demo agents.*cannot change real code/);
  assert.equal(c.roots.status, 'warn');
  assert.equal(c.roots.remediation.ui.href, '#/settings?group=folders');
  assert.equal(c.github.status, 'warn');
  assert.match(c.github.summary, /No GitHub token is configured/);
  assert.equal(c.output.status, 'na');
  assert.equal(c.git.status, 'ok');
  assert.match(c.git.summary, /^git version/);
  assert.equal(c.pax.status, 'warn');
  assert.match(c.pax.summary, /"pax" was not found on the PATH of the da-prompt server process/);
  assert.equal(c.pax.remediation.host, true);
  assert.match(c.pax.remediation.text, /A browser cannot install a program on a host/);
  assert.match(c.pax.note, /not in your browser's or terminal's PATH/);
  assert.equal(c.security.status, 'warn', 'no password and a network-wide bind');
  // Every problem states what was observed and what to do next; host-only fixes say so.
  for (const x of data.checks.filter((k) => ['warn', 'fail'].includes(k.status))) assert.ok(x.remediation && x.remediation.text, `${x.id} has a next step`);
  assert.deepEqual(data.counts.ok + data.counts.warn + data.counts.fail + data.counts.na, data.checks.length);
  assert.ok(!JSON.stringify(data).includes(s.app.cfg.dataDir.replace(/\/[^/]*$/, '/') + 'zzz'));
});

test('providers and models: a working local provider makes the system ready; a bad default model is called out with what is actually offered', async () => {
  const llm = await startMockLLM({ flavor: 'ollama', models: ['qwen2.5-coder:7b', 'llama3.1:8b'] });
  const saved = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = llm.url;
  try {
    const s = await startServer();
    let h = (await get(s.base, '/api/system/health?refresh=1')).data;
    let c = byId(h);
    assert.equal(c.providers.status, 'ok');
    assert.match(c.providers.summary, /1 provider ready: Ollama/);
    assert.deepEqual([c['default-model'].status, /Ollama will use/.test(c['default-model'].summary)], ['ok', true]);
    assert.equal(h.ready, true);
    assert.equal(h.needsSetup, false);

    // The effective default model is checked against the models the provider really lists.
    const put = await fetch(`${s.base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { defaultProvider: 'ollama', defaultModel: 'not-a-real-model' } }) });
    assert.equal(put.status, 200);
    h = (await get(s.base, '/api/system/health?refresh=1')).data;
    c = byId(h);
    assert.equal(c['default-model'].status, 'fail');
    assert.match(c['default-model'].summary, /"not-a-real-model" is not offered by Ollama/);
    assert.match(c['default-model'].details.find((d) => d.k === 'Models offered').v, /(?=.*qwen2\.5-coder:7b)(?=.*llama3\.1:8b)/);
    assert.equal(c['default-model'].remediation.ui.href, '#/settings?group=models');
    assert.equal(h.ready, false);
    await fetch(`${s.base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { defaultModel: 'llama3.1:8b' } }) });
    assert.equal(byId((await get(s.base, '/api/system/health?refresh=1')).data)['default-model'].status, 'ok');
  } finally {
    process.env.OLLAMA_HOST = saved;
    await llm.close();
  }
});

test('provider errors are explained: a rejected key and an unreachable server', async () => {
  const llm = await startMockLLM({ flavor: 'openai', models: ['gpt-test'], apiKey: 'the-right-key' });
  const s = await startServer();
  const patch = (id, body) => fetch(`${s.base}/api/providers/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await patch('openai', { baseUrl: llm.url, apiKey: 'a-wrong-key-123456' });
    let c = byId((await get(s.base, '/api/system/health?refresh=1')).data);
    const openai = c.providers.providers.find((p) => p.id === 'openai');
    assert.equal(openai.status, 'auth_error');
    assert.match(openai.fix.text, /rejected the key.*Replace it on the Providers page/);
    assert.ok(!JSON.stringify(c).includes('a-wrong-key-123456'));
    await patch('openai', { apiKey: 'the-right-key' });
    c = byId((await get(s.base, '/api/system/health?refresh=1')).data);
    assert.equal(c.providers.providers.find((p) => p.id === 'openai').status, 'ready');
  } finally {
    await llm.close();
  }
});

test('GitHub readiness is a real call: authenticated, rejected, unreachable, and not configured', async () => {
  let mode = 'ok';
  const calls = [];
  const gh = http.createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization });
    if (mode === 'rejected') return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Bad credentials' }));
    const headers = { 'content-type': 'application/json' };
    if (mode === 'classic') headers['x-oauth-scopes'] = 'repo, read:org';
    if (mode === 'noscope') headers['x-oauth-scopes'] = 'read:user';
    res.writeHead(200, headers).end(JSON.stringify({ login: 'octo-reviewer' }));
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${gh.address().port}`;
  const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  try {
    const s = await startServer({ githubToken: TOKEN, githubApiUrl: apiUrl });
    const check = async () => byId((await get(s.base, '/api/system/health?refresh=1')).data).github;
    mode = 'classic';
    let g = await check();
    assert.equal(g.status, 'ok');
    assert.match(g.summary, /Authenticated as octo-reviewer/);
    assert.equal(calls.at(-1).auth, `Bearer ${TOKEN}`);
    assert.equal(calls.at(-1).url, '/user');
    mode = 'ok';
    g = await check();
    assert.equal(g.status, 'ok');
    assert.match(g.note, /fine-grained token.*only confirmed when you publish/);
    mode = 'noscope';
    g = await check();
    assert.equal(g.status, 'warn');
    assert.match(g.summary, /no repository scope/);
    mode = 'rejected';
    g = await check();
    assert.equal(g.status, 'fail');
    assert.match(g.summary, /rejected the token \(401\)/);
    assert.equal(g.remediation.ui.href, '#/settings?group=github');
    assert.ok(!JSON.stringify(g).includes(TOKEN), 'the token is never in a health report');
    await new Promise((r) => gh.close(r));
    const down = await check();
    assert.equal(down.status, 'fail');
    assert.match(down.summary, /Could not reach the GitHub API/);
    assert.equal(down.remediation.host, true);
  } finally {
    gh.closeAllConnections?.();
    if (gh.listening) await new Promise((r) => gh.close(r));
  }
});

test('project folders, git and PAX report what they actually observed', async () => {
  const { root } = makeRoot({ one: (d) => fs.cpSync(makeRepo(), d, { recursive: true }), two: (d) => fs.mkdirSync(path.join(d, 'sub')) });
  const gone = path.join(tmpDir(), 'vanished');
  const pax = fakePax({ version: '0.5.0' });
  const s = await startServer({ projectRoots: [root, gone], paxPath: pax.file });
  const c = byId((await get(s.base, '/api/system/health?refresh=1')).data);
  // roots
  assert.equal(c.roots.status, 'warn');
  assert.match(c.roots.summary, /1 configured folder does not exist/);
  assert.deepEqual(c.roots.roots.map((r) => [r.readOnly, r.canRead, r.canWrite, r.dirs, r.repos]), [[false, true, true, 2, 1]]);
  assert.ok(!JSON.stringify(c.roots).includes(root), 'folder health shows names, not host paths, in its structured data');
  // pax
  assert.equal(c.pax.status, 'ok');
  assert.match(c.pax.summary, /PAX 0\.5\.0 found at /);
  assert.equal(c.pax.pax.source, 'configured');
  assert.match(c.pax.details.find((d) => d.k === 'Commands').v, /drift/);
  // git missing from the server's PATH
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = tmpDir('da-prompt-nogit-');
    const g = byId((await get(s.base, '/api/system/health?refresh=1')).data).git;
    assert.equal(g.status, 'fail');
    assert.match(g.remediation.text, /A browser cannot install software on a host/);
    assert.equal(g.remediation.host, true);
  } finally {
    process.env.PATH = savedPath;
  }
  // PAX that is not PAX
  const bad = await startServer({ paxPath: fakePax({ help: 'posix' }).file });
  const p = byId((await get(bad.base, '/api/system/health?refresh=1')).data).pax;
  assert.equal(p.status, 'fail');
  assert.match(p.summary, /does not identify itself as PAX/);
});

test('a data folder that cannot be written is a failure with a host-level fix; a check that throws is reported, not hidden', async () => {
  const blocker = path.join(tmpDir(), 'a-file');
  fs.writeFileSync(blocker, 'x');
  const cfg = loadConfig({ dataDir: path.join(blocker, 'data') });
  const factory = { active: new Map(), providers: { discover: async () => { throw new Error('discovery exploded'); } } };
  const h = await runHealth({ cfg, factory });
  const c = byId(h);
  assert.equal(c.data.status, 'fail');
  assert.match(c.data.summary, /Cannot write to the data folder \((ENOTDIR|EEXIST)/);
  assert.match(c.data.remediation.text, /writable for the user that runs da-prompt/);
  assert.equal(c.data.remediation.host, true);
  const broken = h.checks.find((x) => x.status === 'fail' && /The check itself failed: discovery exploded/.test(x.summary));
  assert.ok(broken, 'an internal failure is surfaced');
  assert.equal(h.ready, false);
});

test('environment honesty: the report says whether this server is on a host or in a container', async () => {
  const s = await startServer();
  const h = (await get(s.base, '/api/system/health')).data;
  assert.ok(['host', 'container'].includes(h.environment.kind));
  const backend = byId(h).backend;
  assert.match(backend.summary, /Running (inside a .* container|directly on a host)/);
  assert.match(backend.note, h.environment.kind === 'container' ? /refer to the container, not to your computer/ : /refer to the machine this server runs on/);
  assert.equal(h.admin, true);
  assert.equal((await get(s.base, '/api/system/health', { 'x-forwarded-for': '1.2.3.4' })).data.admin, false);
});

test('the Docker/CLI liveness endpoint stays unauthenticated and minimal', async () => {
  const s = await startServer({ password: 'a-long-password' });
  const r = await fetch(`${s.base}/api/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal((await fetch(`${s.base}/api/system/health`)).status, 401);
});
void OfflineProvider; void withPath; void before;
