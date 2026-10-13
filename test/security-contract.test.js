// Credential handling, end to end: sentinel secrets (deliberately not shaped like any known key pattern, so only exact-value
// handling can catch them) must not appear in diagnostics, error records, run state, events, API responses, CLI output or
// files, even when a provider echoes them back or an upstream truncation cuts one in half.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { blockNetwork, blocked } from './offline-guard.js';
import { serve } from './http-stub.js';
import { startBackend, cli, cleanMachineEnv } from './cli-helpers.js';
import { hideSecretValues, scanWorkspace } from '../src/security.js';
import { Workspace } from '../src/sandbox.js';
import { safeMessage } from '../src/diagnostics.js';

cleanMachineEnv();
const restoreNet = blockNetwork();
const closers = [];
after(async () => {
  await Promise.all(closers.map((c) => c()));
  restoreNet();
});
// Random-looking on purpose: no 8-character window of either value is an ordinary word that could appear in a response by chance.
const KEY = 'Zq7Xk2Lm9Pw4Vb8Nc3Hd6Rt1Yf5Gs0Jh';
const GH = 'Wd5Tn8Qa2Ke7Mu4Bx9Cz3Lr6Vp1Fy0Os';
/** True if any 8-character window of `secret` appears in `text` (a partial copy is a leak too). */
const leaks = (text, secret) => { for (let i = 0; i + 8 <= secret.length; i++) if (String(text).includes(secret.slice(i, i + 8))) return true; return false; };
const files = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(f); } }; walk(dir); return out; };

test('a provider that echoes the credential, the Authorization header and a truncated copy leaks nothing into any record, API or output', async () => {
  const echo = await serve((req) => {
    if (req.url.endsWith('/models')) return [200, { data: [{ id: 'm' }] }];
    const filler = 'x'.repeat(285);
    // The adapter keeps 300 characters of the message: with this filler, exactly the first 15 characters of the key survive.
    return [401, { error: { message: `${filler}${KEY}`, detail: `received authorization: ${req.headers.authorization}` } }];
  });
  closers.push(echo.close);
  const be = await startBackend({ env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: echo.url }, defaultProvider: 'openai', defaultModel: 'm', githubToken: GH });
  try {
    const created = await be.factory.createRun({ idea: 'x', settings: { deploy: false } });
    const run = await be.factory.start(created.id);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /authentication failed/, 'the failure kind is still reported');
    assert.ok(echo.log.some((r) => r.headers.authorization === `Bearer ${KEY}`), 'the key really was sent to the provider (so the test is not vacuous)');

    // Every browser-facing read endpoint.
    const urls = ['/api/providers', '/api/providers?refresh=1', '/api/providers/openai', '/api/settings', '/api/config', '/api/engines', '/api/diagnostics/inference?provider=openai', '/api/runs', `/api/runs/${created.id}`, `/api/runs/${created.id}/log`, `/api/runs/${created.id}/evidence`, `/api/runs/${created.id}/diagnostics`, `/api/runs/${created.id}/artifacts`];
    for (const u of urls) {
      const res = await fetch(`${be.url}${u}`);
      const body = await res.text();
      assert.ok(res.status < 500, `${u}: ${res.status}`);
      assert.equal(leaks(body, KEY), false, `${u} leaks the provider key`);
      assert.equal(leaks(body, GH), false, `${u} leaks the forge token`);
      assert.ok(!/Bearer\s+[A-Za-z0-9]/.test(body), `${u} contains an Authorization header value`);
    }
    // The CLI, which only ever sees those same APIs.
    for (const argv of [['providers', 'list'], ['diagnostics'], ['runs', 'show', created.id], ['runs', 'diagnostics', created.id], ['runs', 'logs', created.id], ['config', 'list']]) {
      const r = await cli(argv, { backend: be });
      assert.equal(leaks(r.out + r.err, KEY), false, `da-prompt ${argv.join(' ')} leaks the key`);
      assert.equal(leaks(r.out + r.err, GH), false);
    }
    // Everything on disk: run state, events, diagnostics, reports. Authorization headers are never persisted either.
    const diagFile = path.join(be.store.runDir(created.id), 'diagnostics.jsonl');
    assert.ok(fs.existsSync(diagFile) && fs.readFileSync(diagFile, 'utf8').includes('authentication'));
    for (const f of files(be.dataDir)) {
      const text = fs.readFileSync(f, 'latin1');
      assert.equal(leaks(text, KEY), false, `${path.relative(be.dataDir, f)} leaks the provider key`);
      assert.equal(leaks(text, GH), false, `${path.relative(be.dataDir, f)} leaks the forge token`);
      if (f.includes(`${path.sep}runs${path.sep}`)) assert.ok(!/"authorization"|bearer\s+\w/i.test(text), `${path.relative(be.dataDir, f)} persists an authorization header`);
    }
    // The diagnostic message is bounded and still says what happened.
    const rec = fs.readFileSync(diagFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.failure);
    assert.ok(rec.failure.message.length <= 300);
    assert.equal(rec.failure.kind, 'authentication');
  } finally {
    await be.close();
  }
});

test('truncation cannot leave a recognisable piece of a credential at either end of a stored message', () => {
  assert.equal(hideSecretValues(`failed with ${KEY}`, [KEY]), 'failed with ***');
  assert.equal(hideSecretValues(`failed with ${KEY.slice(0, 15)}`, [KEY]), 'failed with ***', 'a cut-off prefix at the end');
  assert.equal(hideSecretValues(`${KEY.slice(-12)} was the end of it`, [KEY]), '*** was the end of it', 'a cut-off suffix at the start');
  assert.equal(hideSecretValues('short words are left alone: abc', ['abc']), 'short words are left alone: abc', 'values under 8 characters are never treated as secrets');
  assert.equal(hideSecretValues('nothing to see', [KEY, undefined, null]), 'nothing to see');
  const stored = safeMessage(`${'y'.repeat(290)}${KEY}`, [KEY]);
  assert.equal(leaks(stored, KEY), false);
  assert.ok(stored.length <= 300);
  // redact() still handles the shapes it knows, in the same pass.
  assert.ok(!safeMessage('Bearer abcdefghijklmnop and sk-ant-abcdefghijklmnopqrstuvwxyz', []).match(/abcdefghijkl/));
});

test('replay fixtures and fixtures helpers carry no credentials or private content', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'replay');
  const found = [];
  const scan = async () => scanWorkspace(new Workspace(dir));
  return scan().then((r) => {
    assert.deepEqual(r.findings.filter((f) => f.severity !== 'low'), [], 'no credential-shaped strings in the fixtures');
    for (const f of files(dir)) {
      const text = fs.readFileSync(f, 'utf8');
      assert.ok(!/api[_-]?key\s*[:=]\s*['"][^'"]{8,}|Bearer\s+[A-Za-z0-9]{10,}|ghp_|sk-[A-Za-z0-9]{10,}/.test(text), `${path.basename(f)} looks like it holds a secret`);
      assert.ok(!/\/home\/|\/Users\//.test(text), `${path.basename(f)} names a private path`);
    }
    void found;
  });
});

test('the offline guard is real: tests cannot reach a real provider, even by accident', async () => {
  const before = blocked.length;
  await assert.rejects(new Promise((resolve, reject) => { const s = net.connect(443, 'api.openai.com'); s.on('error', reject); s.on('connect', resolve); }), (e) => e.code === 'ETESTNETBLOCKED');
  await assert.rejects(fetch('https://api.anthropic.com/v1/models'), (e) => /fetch failed/.test(e.message) && e.cause?.code === 'ETESTNETBLOCKED');
  assert.deepEqual(blocked.slice(before), ['api.openai.com', 'api.anthropic.com']);
  blocked.length = 0; // the intended blocks above are not failures of this file
  const local = await serve(() => [200, { ok: true }]);
  closers.push(local.close);
  assert.equal((await fetch(local.url)).status, 200, 'loopback (the mock servers) stays open');
  assert.deepEqual(blocked, []);
});
