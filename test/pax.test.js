import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { probePax, resolvePax, collectPaxEvidence, versionAtLeast, STEPS } from '../src/pax.js';
import { buildEvidence } from '../src/evidence.js';
import { createServer } from '../src/server.js';
import { fakePax, withPath } from './pax-helpers.js';
import { tmpDir, waitFor } from './helpers.js';
import { makeRepo, makeRoot, dirId, setup, Scripted, task, plan, toolUse, done, NODE_FILES } from './project-helpers.js';
import { OfflineProvider } from '../src/providers/offline.js';

delete process.env.FACTORY_PAX_PATH;
const cfgFor = (extra = {}) => loadConfig({ dataDir: tmpDir(), ...extra });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ALL = ['info', 'doctor', 'reality', 'drift', 'graph', 'test-plan', 'test'];

test('PAX is discovered on the backend process\'s PATH — and its real version and capabilities come from the binary itself', async () => {
  const { dir, file } = fakePax({ version: '0.5.0' });
  await withPath(dir, async () => {
    const found = resolvePax(cfgFor());
    assert.deepEqual([found.source, found.path, found.problem], ['PATH', file, null]);
    const p = await probePax(cfgFor());
    assert.deepEqual([p.state, p.path, p.version, p.source, p.identity], ['ok', file, '0.5.0', 'PATH', 'pax']);
    assert.ok(p.commands.includes('drift') && p.commands.includes('test') && p.commands.includes('observe'));
    assert.deepEqual(p.flags.sort(), ['--dir', '--dry-run', '--json', '--live']);
    assert.ok(Object.values(p.steps).every((s) => s.available));
  });
  // Not on the PATH: honest, specific, and says where it looked.
  await withPath('', async () => {
    const saved = process.env.PATH;
    process.env.PATH = tmpDir('da-prompt-emptypath-');
    try {
      const p = await probePax(cfgFor());
      assert.equal(p.state, 'unavailable');
      assert.match(p.message, /"pax" was not found on the PATH of the da-prompt server process \(1 folder searched\)/);
      assert.equal(p.path, null);
    } finally {
      process.env.PATH = saved;
    }
  });
});

test('an explicit executable path is honoured, validated and distinguishes missing, not-executable and wrong programs', async () => {
  const { file } = fakePax({ name: 'my-pax' });
  const p = await probePax(cfgFor({ paxPath: file }));
  assert.deepEqual([p.state, p.source, p.configured, p.path], ['ok', 'configured', file, file]);
  // A bare command name is looked up on the PATH.
  const bin = path.dirname(file);
  await withPath(bin, async () => assert.equal((await probePax(cfgFor({ paxPath: 'my-pax' }))).path, file));

  const missing = await probePax(cfgFor({ paxPath: '/no/such/pax' }));
  assert.deepEqual([missing.state, /does not exist on the machine the da-prompt server runs on/.test(missing.message)], ['unavailable', true]);

  const noexec = fakePax({ name: 'pax-noexec', mode: 0o644 });
  const perm = await probePax(cfgFor({ paxPath: noexec.file }));
  assert.equal(perm.state, 'permission');
  assert.match(perm.message, /not an executable file for the server's user/);

  // Probing a candidate does not need it to be saved first.
  const cand = await probePax(cfgFor(), { candidate: file });
  assert.equal(cand.state, 'ok');
});

test('incompatible executables are named as such: another program called pax, an unrecognisable help, an old version', async () => {
  const posix = await probePax(cfgFor({ paxPath: fakePax({ help: 'posix' }).file }));
  assert.equal(posix.state, 'incompatible');
  assert.equal(posix.identity, 'not-pax');
  assert.match(posix.message, /does not identify itself as PAX/);
  assert.match(posix.message, /POSIX archive tool/);

  const odd = await probePax(cfgFor({ paxPath: fakePax({ help: 'other', version: '9.9.9' }).file }));
  assert.equal(odd.state, 'incompatible');
  assert.equal(odd.identity, 'unrecognized-help');
  assert.match(odd.message, /not recognisable as PAX/);

  const old = await probePax(cfgFor({ paxPath: fakePax({ version: '0.2.0' }).file }));
  assert.equal(old.state, 'ok');
  assert.deepEqual([old.steps.info.available, old.steps.test.available], [true, false]);
  assert.match(old.steps.test.reason, /needs PAX 0\.3\.0 or newer \(installed 0\.2\.0\)/);
  assert.ok(versionAtLeast('0.5.0', '0.3.0') && versionAtLeast('1.0.0', '0.9.9') && !versionAtLeast('0.2.9', '0.3.0') && !versionAtLeast('x', '0.1.0'));
});

test('a hung executable times out and is reported, not waited on forever', async () => {
  const hang = fakePax({ outputs: {}, sleeps: {} });
  fs.writeFileSync(hang.file, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const t0 = Date.now();
  const p = await probePax(cfgFor({ paxPath: hang.file, paxTimeoutMs: 1200 }));
  assert.equal(p.state, 'timeout');
  assert.match(p.message, /did not finish within 1s/);
  assert.ok(Date.now() - t0 < 6000);
});

test('evidence is captured for real: exit status, JSON results, stderr, artifact hashes, and no host paths', async () => {
  const { file } = fakePax({ drift: 1, stderr: 'warning: something on stderr' });
  const ws = tmpDir('da-prompt-ws-');
  const evidenceDir = path.join(tmpDir(), 'pax');
  const emitted = [];
  const rec = await collectPaxEvidence(cfgFor({ paxPath: file }), { wsRoot: ws, evidenceDir, steps: ALL, emit: (t, d) => emitted.push([t, d.step, d.outcome]) });
  assert.equal(rec.state, 'collected');
  assert.deepEqual([rec.binary.path, rec.binary.version, rec.binary.source], [file, '0.5.0', 'configured']);
  const by = Object.fromEntries(rec.steps.map((s) => [s.id, s]));
  assert.deepEqual(rec.steps.map((s) => s.id), ALL);
  assert.deepEqual([by.info.outcome, by.info.exitCode], ['observed', 0]);
  assert.equal(by.info.result.manager, 'npm');
  assert.deepEqual(by.info.result.diagnostics, { ok: 1, warn: 1 });
  // drift exits 1 when it finds drift: that is a finding, not a failed tool.
  assert.deepEqual([by.drift.outcome, by.drift.exitCode, by.drift.result.issueCount], ['drift-detected', 1, 1]);
  assert.equal(by.drift.result.issues[0].actual, 'node_modules/ absent');
  assert.equal(by['test-plan'].outcome, 'planned');
  assert.deepEqual([by.test.outcome, by.test.result.status, by.test.result.tool], ['passed', 'passed', 'npm']);
  assert.match(by.test.detail, /PAX established that tests ran and passed/);
  assert.equal(by.info.command, 'pax --json --dir <workspace> info');
  assert.equal(by['test-plan'].command, 'pax --dry-run --json --dir <workspace> test');
  assert.deepEqual(rec.summary, { steps: 7, observed: 6, findings: 1, problems: 0 });
  assert.match(by.info.stderrTail, /warning: something on stderr/);
  assert.ok(emitted.some((e) => e[1] === 'drift' && e[2] === 'drift-detected'));

  // Artifact references point at real files whose hashes match.
  for (const s of rec.steps) for (const a of s.artifacts) {
    const text = fs.readFileSync(path.join(evidenceDir, a.name), 'utf8');
    assert.equal(a.sha256, sha(text));
    assert.equal(a.bytes, Buffer.byteLength(text));
    assert.ok(!text.includes(ws), `${a.name} must not contain the host workspace path`);
  }
  assert.ok(fs.readFileSync(path.join(evidenceDir, 'info.stdout.json'), 'utf8').includes('<workspace>'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(evidenceDir, 'manifest.json'), 'utf8')).steps.length, 7);
  assert.match(rec.semantics, /not the factory's verification/);
});

test('PAX failures keep their own meaning: a non-zero exit, unrecognised output, an unknown schema, a timeout and a cancellation', async () => {
  const run = async (opts, steps, cfg = {}, signal) => {
    const { file } = fakePax(opts);
    return Object.fromEntries((await collectPaxEvidence(cfgFor({ paxPath: file, ...cfg }), { wsRoot: tmpDir(), evidenceDir: path.join(tmpDir(), 'e'), steps, signal })).steps.map((s) => [s.id, s]));
  };
  const failing = await run({ exits: { info: 3 }, outputs: { doctor: 'not json at all', reality: JSON.stringify({ schema_version: '7' }) }, test: 'plain' }, ['info', 'doctor', 'reality', 'test']);
  assert.equal(failing.info.outcome, 'error');
  assert.match(failing.info.detail, /exited with code 3/);
  assert.equal(failing.doctor.outcome, 'unrecognized-output');
  assert.match(failing.doctor.detail, /exit 0|exited 0|stdout was not a JSON/);
  assert.equal(failing.reality.outcome, 'unrecognized-output');
  assert.match(failing.reality.detail, /only "1" is understood/);
  assert.equal(failing.test.outcome, 'unrecognized-output');
  assert.match(failing.test.detail, /Expected one pax\.execution-result\.v1/);

  const schema = await run({ test: 'other-schema' }, ['test']);
  assert.equal(schema.test.outcome, 'unrecognized-output');
  assert.match(schema.test.detail, /pax\.execution-result\.v9/);

  const status = await run({ test: 'failed' }, ['test']);
  assert.equal(status.test.outcome, 'failed');
  const unsupported = await run({ test: 'unsupported' }, ['test']);
  assert.equal(unsupported.test.outcome, 'unsupported');
  assert.match(unsupported.test.detail, /exit code is not a result/);
  assert.equal((await run({ drift: 2 }, ['drift'])).drift.outcome, 'ambiguous');
  assert.equal((await run({ drift: 0 }, ['drift'])).drift.outcome, 'no-drift');

  const slow = await run({ sleeps: { graph: 20 } }, ['graph'], { paxTimeoutMs: 1200 });
  assert.equal(slow.graph.outcome, 'timeout');
  assert.equal(slow.graph.timedOut, true);

  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 300);
  const cancelled = await run({ sleeps: { graph: 20 } }, ['graph'], {}, ctl.signal);
  assert.equal(cancelled.graph.outcome, 'cancelled');

  // Steps the installed version cannot do are reported as not supported, not silently skipped.
  const old = await run({ version: '0.2.0' }, ['info', 'test']);
  assert.equal(old.info.outcome, 'observed');
  assert.equal(old.test.outcome, 'not-supported');
  assert.match(old.test.detail, /needs PAX 0\.3\.0/);
});

test('when PAX is unavailable the record says so and nothing is invented', async () => {
  const rec = await collectPaxEvidence(cfgFor({ paxPath: '/no/such/pax' }), { wsRoot: tmpDir(), evidenceDir: path.join(tmpDir(), 'e'), steps: ['info'] });
  assert.deepEqual([rec.state, rec.steps], ['unavailable', []]);
  assert.match(rec.message, /does not exist/);
});

// ── through a real factory run ──────────────────────────────────────────────────────────────────
const projectRoot = () => makeRoot({ app: (d) => fs.cpSync(makeRepo(), d, { recursive: true }) });
const writer = (verify = []) => new Scripted({
  plan: () => plan([task('t', { verify })], { finalVerify: ['npm test'] }),
  task: ({ turn }) => (turn === 0 ? [toolUse('write_file', { path: 'a.txt', content: 'a' })] : [done('ok')]),
});

test('PAX evidence never changes verification: the same run with and without PAX has the same verdict, checklist and status', async () => {
  const { file } = fakePax({ drift: 1, test: 'passed' });
  const make = async (pax) => {
    const { cfg: rootCfg } = projectRoot();
    const env = setup({ provider: writer(), cfg: { ...rootCfg, paxPath: file } });
    const run = await env.factory.start((await env.factory.createRun({ idea: 'add a', provider: 'offline', source: { mode: 'local', directoryId: dirId(env.cfg, 'app') }, settings: { pax, paxSteps: ALL } })).id);
    return { run, ...env };
  };
  const [without, withPax] = [await make(false), await make(true)];
  assert.equal(without.run.pax, undefined);
  assert.equal(withPax.run.pax.state, 'collected');
  assert.deepEqual(withPax.run.checklist.map((c) => [c.id, c.ok, c.state]), without.run.checklist.map((c) => [c.id, c.ok, c.state]));
  assert.equal(withPax.run.status, without.run.status);
  assert.equal(withPax.run.delivery.readiness.verdict, without.run.delivery.readiness.verdict);
  // The drift finding is visible, and does not downgrade or upgrade anything.
  assert.equal(withPax.run.pax.steps.find((s) => s.id === 'drift').outcome, 'drift-detected');
  assert.equal(withPax.run.delivery.readiness.ready, true);
  // Evidence files live beside the run, outside the project workspace.
  assert.ok(fs.existsSync(path.join(withPax.store.paxDir(withPax.run.id), 'manifest.json')));
  assert.ok(!fs.existsSync(path.join(withPax.store.workspaceDir(withPax.run.id), 'pax')));
  const report = fs.readFileSync(path.join(withPax.store.deliveryDir(withPax.run.id), 'FACTORY_REPORT.md'), 'utf8');
  assert.match(report, /## PAX observation \(separate from verification\)/);
  assert.match(report, /not the factory's verification/);
  assert.match(report, /Project diagnostics.*→ observed/);
  const results = JSON.parse(fs.readFileSync(path.join(withPax.store.deliveryDir(withPax.run.id), 'test-results.json'), 'utf8'));
  assert.equal(results.pax.state, 'collected');
  assert.ok(results.verdict, 'verification keeps its own key');
});

test('agent claims, factory verification and PAX observations stay distinguishable — and disagreements are shown, not resolved', async () => {
  // The agent claims success; the factory's final check fails; PAX says its test run passed.
  const { file } = fakePax({ test: 'passed' });
  const { cfg: rootCfg } = projectRoot();
  const prov = new Scripted({
    plan: () => plan([task('t')], { finalVerify: ['npm test', 'test -s never-created.txt'] }),
    task: ({ turn }) => (turn === 0 ? [toolUse('write_file', { path: 'a.txt', content: 'a' })] : [done('Everything works perfectly, all verified.')]),
  });
  const env = setup({ provider: prov, cfg: { ...rootCfg, paxPath: file } });
  const run = await env.factory.start((await env.factory.createRun({ idea: 'add a', provider: 'offline', source: { mode: 'local', directoryId: dirId(env.cfg, 'app') }, settings: { pax: true, paxSteps: ['info', 'test'] } })).id);
  const ev = buildEvidence(run);
  assert.equal(run.status, 'needs_attention');
  assert.match(ev.agent.claims[0].summary, /Everything works perfectly/);
  assert.match(ev.agent.note, /not evidence/);
  assert.equal(ev.factory.verdict, 'failed');
  assert.ok(ev.factory.final.some((f) => f.command === 'test -s never-created.txt' && f.ok === false && f.state === 'new-failure'));
  assert.equal(ev.pax.steps.find((s) => s.id === 'test').outcome, 'passed');
  assert.ok(ev.notes.some((n) => /PAX reported its test run as passed while the factory's verification did not/.test(n)));
  assert.ok(ev.notes.some((n) => /Every task was reported complete by its agent, but the factory's own verification is "failed"/.test(n)));
  // Nothing the PAX step said made the run verified.
  assert.notEqual(run.delivery.readiness.verdict, 'verified');
  assert.equal(run.checklist.find((c) => c.id === 'tests').ok, false);
});

test('a missing PAX executable does not fail the run; its absence is recorded and listed as missing evidence', async () => {
  const { cfg: rootCfg } = projectRoot();
  const env = setup({ provider: writer(), cfg: { ...rootCfg, paxPath: '/no/such/pax' } });
  const run = await env.factory.start((await env.factory.createRun({ idea: 'add a', provider: 'offline', source: { mode: 'local', directoryId: dirId(env.cfg, 'app') }, settings: { pax: true } })).id);
  assert.equal(run.status, 'completed', JSON.stringify(run.checklist));
  assert.equal(run.pax.state, 'unavailable');
  const ev = buildEvidence(run);
  assert.ok(ev.missing.some((m) => /PAX evidence could not be collected \(unavailable/.test(m)));
  assert.equal(ev.pax.state, 'unavailable');
  assert.equal(ev.factory.verdict, 'verified', 'the verdict comes from the project\'s own checks');
  // A run that never asked for PAX says "not requested", not "success".
  const plain = setup({ provider: writer(), cfg: rootCfg });
  const r2 = await plain.factory.start((await plain.factory.createRun({ idea: 'add a', provider: 'offline', source: { mode: 'local', directoryId: dirId(plain.cfg, 'app') } })).id);
  assert.equal(buildEvidence(r2).pax.state, 'not-requested');
});

test('PAX settings drive new runs: auto-run default, steps are validated, and an explicit run option wins', async () => {
  const { cfg: rootCfg } = projectRoot();
  const env = setup({ provider: writer(), cfg: rootCfg });
  const off = await env.factory.createRun({ idea: 'x', provider: 'offline', start: false });
  assert.deepEqual([off.settings.pax, off.settings.paxSteps], [false, ['info', 'doctor', 'reality', 'drift']]);
  env.cfg.settings.update({ paxAutoRun: true, paxSteps: ['info', 'drift'] }, { admin: true });
  const on = await env.factory.createRun({ idea: 'x', provider: 'offline', start: false });
  assert.deepEqual([on.settings.pax, on.settings.paxSteps], [true, ['info', 'drift']]);
  const explicit = await env.factory.createRun({ idea: 'x', provider: 'offline', start: false, settings: { pax: false, paxSteps: ['graph', 'rm -rf'] } });
  assert.deepEqual([explicit.settings.pax, explicit.settings.paxSteps], [false, ['graph']]);
});

// ── over HTTP ───────────────────────────────────────────────────────────────────────────────────
let app;
let base;
let pax;
let roots;
before(async () => {
  pax = fakePax({ drift: 0, test: 'passed' });
  roots = projectRoot();
  app = await createServer({ dataDir: tmpDir(), defaultProvider: 'offline', ...roots.cfg, paxPath: pax.file, providerFactory: () => new OfflineProvider({ faults: false, delayMs: 0 }) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());
const call = async (method, p, body, headers = {}) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
};
const RELAYED = { 'x-forwarded-for': '203.0.113.9' };

test('PAX API: status, capability catalog, local-vs-container note, and candidate probing needs host authority', async () => {
  const { status, data } = await call('GET', '/api/pax');
  assert.equal(status, 200);
  assert.deepEqual([data.status.state, data.status.version, data.status.source], ['ok', '0.5.0', 'configured']);
  assert.deepEqual(data.catalog.map((c) => c.id), ALL);
  assert.ok(data.catalog.every((c) => c.available && c.about && ['observation', 'plan', 'execution'].includes(c.class)));
  assert.equal(data.catalog.find((c) => c.id === 'test').class, 'execution');
  assert.match(data.semantics, /not the factory's verification/);
  assert.ok(['host', 'container'].includes(data.environment.kind));

  const other = fakePax({ version: '0.4.0', name: 'pax-other' });
  const probed = await call('POST', '/api/pax/probe', { path: other.file });
  assert.equal(probed.data.status.version, '0.4.0');
  assert.equal((await call('POST', '/api/pax/probe', { path: other.file }, RELAYED)).status, 403);
  assert.equal((await call('POST', '/api/pax/probe', { path: '/bin/sh; rm -rf /' })).status, 400);
  assert.equal((await call('POST', '/api/pax/probe', {}, RELAYED)).status, 200, 'probing the configured executable is not privileged');
});

test('run-level PAX over HTTP: explicit collection, confirmation for the test step, evidence and artifact downloads', async () => {
  const created = await call('POST', '/api/runs', { idea: 'Add a note', provider: 'offline', source: { mode: 'local', directoryId: `${roots.cfg.projectRoots && (await call('GET', '/api/projects/directories')).data.directories[0].id}` } });
  assert.equal(created.status, 201);
  const id = created.data.run.id;
  const run = await waitFor(async () => {
    const r = (await call('GET', `/api/runs/${id}`)).data.run;
    return ['completed', 'needs_attention', 'failed'].includes(r.status) && !r.executing ? r : null;
  });
  assert.equal(run.pax, undefined, 'PAX was not requested');
  const ev0 = (await call('GET', `/api/runs/${id}/evidence`)).data.evidence;
  assert.equal(ev0.pax.state, 'not-requested');

  assert.equal((await call('POST', `/api/runs/${id}/pax`, { steps: [] })).status, 200, 'empty = the configured steps');
  const collected = (await call('GET', `/api/runs/${id}`)).data.run;
  assert.equal(collected.pax.state, 'collected');
  assert.deepEqual(collected.pax.steps.map((s) => s.id), ['info', 'doctor', 'reality', 'drift']);

  const needConfirm = await call('POST', `/api/runs/${id}/pax`, { steps: ['info', 'test'] });
  assert.equal(needConfirm.status, 400);
  assert.match(needConfirm.data.error, /confirm it explicitly/);
  assert.equal((await call('POST', `/api/runs/${id}/pax`, { steps: ['info', 'test'], confirmTests: true })).status, 200);
  assert.equal((await call('GET', `/api/runs/${id}`)).data.run.pax.steps.find((s) => s.id === 'test').outcome, 'passed');

  const arts = (await call('GET', `/api/runs/${id}/artifacts`)).data;
  assert.ok(arts.pax.some((a) => a.name === 'info.stdout.json' && a.sha256 && a.bytes > 0));
  assert.ok(arts.delivery.some((a) => a.name === 'FACTORY_REPORT.md'));
  const dl = await call('GET', `/api/runs/${id}/download/pax/info.stdout.json`);
  assert.equal(dl.status, 200);
  assert.equal(dl.data.command, 'info');
  assert.ok(!JSON.stringify(dl.data).includes(app.store.workspaceDir(id)));
  for (const bad of ['../../run.json', '..%2F..%2Frun.json', 'run.json', 'nope.json']) assert.equal((await call('GET', `/api/runs/${id}/download/pax/${bad}`)).status, 404, bad);
  assert.equal((await call('POST', `/api/runs/${id}/pax`, { steps: ['rm'] })).status, 400);
  const report = (await call('GET', `/api/runs/${id}/report`)).data;
  assert.match(report, /## PAX observation/);
});

// ── real PAX, only where one exists ─────────────────────────────────────────────────────────────
test('real PAX smoke test (skipped unless DA_PROMPT_PAX_BIN or a real `pax` on PATH is available)', async (t) => {
  const bin = process.env.DA_PROMPT_PAX_BIN || '';
  const cfg = cfgFor(bin ? { paxPath: bin } : {});
  const p = await probePax(cfg);
  if (p.state !== 'ok') return t.skip(`no real PAX available (${p.state}); host-side smoke test: see "Validating the real PAX install" in the README`);
  const ws = tmpDir('da-prompt-realpax-');
  fs.writeFileSync(path.join(ws, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n');
  fs.mkdirSync(path.join(ws, 'src'));
  fs.writeFileSync(path.join(ws, 'src/lib.rs'), '#[test]\nfn t() { assert_eq!(1, 1); }\n');
  const hasCargo = (() => { try { execFileSync('cargo', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  const steps = hasCargo ? ALL : ['info', 'doctor', 'reality', 'drift', 'graph', 'test-plan'];
  const evidenceDir = path.join(tmpDir(), 'e');
  const rec = await collectPaxEvidence(cfg, { wsRoot: ws, evidenceDir, steps });
  assert.equal(rec.state, 'collected');
  for (const f of fs.readdirSync(evidenceDir)) assert.ok(!fs.readFileSync(path.join(evidenceDir, f), 'utf8').includes(ws), `${f} must not contain the host path`);
  for (const s of rec.steps) assert.ok(['observed', 'no-drift', 'planned', 'passed'].includes(s.outcome), `${s.id}: ${s.outcome} — ${s.detail}`);
  assert.ok(rec.steps.every((s) => s.artifacts.length > 0), 'every step left evidence files');
  if (hasCargo) assert.equal(rec.steps.find((s) => s.id === 'test').result.tests.passed, 1);
  assert.deepEqual(Object.keys(STEPS), ALL);
});
