// The CLI driving real runs on a real backend: start/follow/reconnect, cancel/resume/retry, logs/files/diffs/reports,
// approval-gated apply and publish, and PAX evidence. The only stand-in is the model (a scripted provider).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanMachineEnv, startBackend, cli } from './cli-helpers.js';
import { makeRoot, makeRemote, startMockApi, git, writeFiles, Scripted, task, plan, toolUse, done, NODE_FILES } from './project-helpers.js';
import { fakePax, withPath } from './pax-helpers.js';
import { tmpDir, waitFor } from './helpers.js';
import { EXIT } from '../src/cli/core.js';

cleanMachineEnv();

const NEW_FILE = { 'src/farewell.js': "export const farewell = (n) => `Bye ${n}`;\n" };
const gitProject = (d) => {
  git(d, 'init', '-q', '-b', 'main');
  writeFiles(d, NODE_FILES);
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'initial');
};

/** A model that writes the given files; `gate` (a promise) holds it back so runs can be observed mid-flight. */
class Writer extends Scripted {
  constructor({ files = NEW_FILE, verify = [], gate = null, failFirst = false } = {}) {
    super({
      plan: () => plan([task('t', { verify })], { finalVerify: ['npm test'] }),
      task: ({ turn }) => (turn === 0 ? Object.entries(files).map(([p, content]) => toolUse('write_file', { path: p, content })) : [done('wrote the files', Object.keys(files))]),
    });
    this.gate = gate;
    void failFirst;
  }

  async chat(req) {
    if (this.gate) await this.gate.promise;
    return super.chat(req);
  }
}
const gate = () => {
  const g = {};
  g.promise = new Promise((r) => (g.open = r));
  return g;
};

const backends = [];
after(() => Promise.all(backends.map((b) => b.close())));
async function backend({ files, verify, gated = false, projects = { app: gitProject }, extra = {} } = {}) {
  const roots = makeRoot(projects);
  const g = gated ? gate() : null;
  const provider = new Writer({ files, verify, gate: g });
  const be = await startBackend({ ...roots.cfg, providerFactory: () => provider, ...extra });
  be.requests = [];
  be.server.prependListener('request', (req) => be.requests.push(req.url));
  be.roots = roots;
  be.gate = g;
  be.provider = provider;
  backends.push(be);
  return be;
}
const runId = (r) => r.json?.id || r.out.trim().split('\n').pop().trim();
const startDetached = async (be, args = []) => {
  const r = await cli(['run', 'Add a farewell helper', '--project', 'app', '--detach', '--json', ...args], { backend: be });
  assert.equal(r.code, 0, r.err + r.out);
  return r.json.id;
};
const idle = (be, id) => waitFor(async () => !(await cli(['runs', 'show', id, '--json'], { backend: be })).json.executing, { timeoutMs: 60_000 });

test('run → follow → evidence → diff → approve → apply: the whole local workflow in the terminal, with no browser route touched', async () => {
  const be = await backend();
  const app = be.roots.dirs.app;
  fs.writeFileSync(path.join(app, 'scratch.txt'), 'uncommitted work\n');
  const headBefore = git(app, 'rev-parse', 'HEAD');

  const r = await cli(['run', 'Add a farewell helper', '--project', 'app'], { backend: be });
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /status\s+completed/);
  assert.match(r.out, /Factory verification\s+verified/);
  assert.match(r.out, /runs diff/);
  const id = (r.out.match(/\b(\d{12}-[0-9a-f]{6})\b/) || [])[1];
  assert.ok(id, 'the run id is printed');

  // Nothing was written to the user's directory by running.
  assert.equal(git(app, 'status', '--porcelain'), '?? scratch.txt');

  const list = await cli(['runs', 'list', '--json'], { backend: be });
  assert.equal(list.json.runs[0].id, id);
  const tasks = await cli(['runs', 'tasks', id], { backend: be });
  assert.match(tasks.out, /t\s+engineer\s+completed/);
  const files = await cli(['runs', 'files', id, '--json'], { backend: be });
  assert.deepEqual(files.json.files.map((f) => f.path), ['src/farewell.js']);
  const diff = await cli(['runs', 'diff', id], { backend: be });
  assert.match(diff.out, /\+export const farewell/);
  const patchFile = path.join(tmpDir(), 'out.patch');
  assert.equal((await cli(['runs', 'diff', id, '--out', patchFile], { backend: be })).code, 0);
  assert.match(fs.readFileSync(patchFile, 'utf8'), /diff --git a\/src\/farewell.js/);
  const logs = await cli(['runs', 'logs', id, '--tail', '5', '--json'], { backend: be });
  assert.ok(logs.json.events.length >= 1);
  const tests = await cli(['runs', 'tests', id, '--json'], { backend: be });
  assert.equal(tests.json.verdict, 'verified');
  assert.ok(tests.json.baseline.every((c) => c.status === 'passed') && tests.json.final.every((c) => c.ok));
  const ver = await cli(['runs', 'verify', id, '--json'], { backend: be });
  assert.equal(ver.code, 0, ver.err);
  assert.ok(ver.json.ok && ver.json.results.every((x) => x.state === 'passed'));
  const rep = await cli(['runs', 'report', id], { backend: be });
  assert.match(rep.out, /Factory Report/);
  const arts = await cli(['runs', 'artifacts', id, '--json'], { backend: be });
  assert.ok(arts.json.delivery.some((a) => a.name === 'changes.patch'));
  const ev = await cli(['runs', 'evidence', id, '--json'], { backend: be });
  assert.equal(ev.json.evidence.factory.verdict, 'verified');
  assert.deepEqual(ev.json.evidence.pax.state, 'not-requested');
  const human = await cli(['runs', 'evidence', id], { backend: be });
  assert.ok(human.out.indexOf('AGENT CLAIMS') < human.out.indexOf('FACTORY VERIFICATION') && human.out.indexOf('FACTORY VERIFICATION') < human.out.indexOf('PAX OBSERVATION'));

  // Apply needs an approval of these exact changes, then explicit confirmation.
  const denied = await cli(['runs', 'apply', id, '--yes'], { backend: be });
  assert.equal(denied.code, EXIT.DENIED);
  assert.ok(!fs.existsSync(path.join(app, 'src/farewell.js')));
  assert.equal((await cli(['runs', 'review', id, 'approve', '--note', 'ok'], { backend: be })).code, 0);
  const noYes = await cli(['runs', 'apply', id], { backend: be });
  assert.equal(noYes.code, EXIT.USAGE, 'a non-interactive session must pass --yes');
  assert.ok(!fs.existsSync(path.join(app, 'src/farewell.js')));
  const applied = await cli(['runs', 'apply', id, '--yes', '--json'], { backend: be });
  assert.equal(applied.code, 0, applied.err);
  assert.equal(fs.readFileSync(path.join(app, 'src/farewell.js'), 'utf8'), NEW_FILE['src/farewell.js']);
  assert.equal(fs.readFileSync(path.join(app, 'scratch.txt'), 'utf8'), 'uncommitted work\n', 'pre-existing uncommitted work is preserved');
  assert.equal(git(app, 'rev-parse', 'HEAD'), headBefore, 'nothing was committed');
  assert.equal(git(app, 'diff', '--cached', '--name-only'), '', 'nothing was staged');

  assert.ok(be.requests.every((u) => u.startsWith('/api/')), `the CLI used only /api routes: ${[...new Set(be.requests.filter((u) => !u.startsWith('/api/')))].join(', ')}`);
});

test('apply --approve reviews and applies in one step', async () => {
  const be = await backend();
  const id = await startDetached(be);
  await idle(be, id);
  const r = await cli(['runs', 'apply', id, '--approve', '--yes', '--json'], { backend: be });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.applied, true);
  const shown = await cli(['runs', 'show', id, '--json'], { backend: be });
  assert.equal(shown.json.run?.review?.decision ?? shown.json.review?.decision, 'approved');
});

test('a rejected review blocks apply; changes after approval invalidate it', async () => {
  const be = await backend();
  const id = await startDetached(be);
  await idle(be, id);
  assert.equal((await cli(['runs', 'review', id, 'reject', '--note', 'no'], { backend: be })).code, 0);
  const r = await cli(['runs', 'apply', id, '--yes'], { backend: be });
  assert.equal(r.code, EXIT.DENIED);
  assert.equal((await cli(['runs', 'review', id, 'approve'], { backend: be })).code, 0);
  assert.equal((await cli(['runs', 'review', id, 'clear'], { backend: be })).code, 0);
  assert.equal((await cli(['runs', 'apply', id, '--yes'], { backend: be })).code, EXIT.DENIED);
});

test('--json run output is parseable NDJSON ending in a result record; failures and partial results have distinct exit codes', async () => {
  const be = await backend();
  const r = await cli(['run', 'Add a farewell helper', '--project', 'app', '--json'], { backend: be });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.lines.length > 3);
  assert.ok(r.lines.every((l) => typeof l === 'object'), 'every line is a JSON document');
  const last = r.lines.at(-1);
  assert.equal(last.type, 'result');
  assert.equal(last.run.status, 'completed');
  assert.equal(last.exitCode, 0);

  // A task whose own check never passes: the run needs attention (exit 6), with the reason on the record.
  const bad = await backend({ verify: ['test -s never-created.txt'] });
  const f = await cli(['run', 'Add a farewell helper', '--project', 'app', '--attempts', '1', '--json'], { backend: bad });
  assert.equal(f.code, EXIT.ATTENTION, f.err);
  assert.equal(f.lines.at(-1).run.status, 'needs_attention');
  const human = await cli(['runs', 'show', f.lines.at(-1).run.id], { backend: bad });
  assert.match(human.out, /escalated|needs attention/i);
  assert.match(human.out, /runs retry|runs skip/);
});

test('detach, wait-timeout and reconnect: the run lives on the backend, not in the terminal', async () => {
  const be = await backend({ gated: true });
  const id = await startDetached(be);
  const timeout = await cli(['runs', 'follow', id, '--wait-timeout', '1'], { backend: be });
  assert.equal(timeout.code, EXIT.TIMEOUT);
  assert.match(timeout.out + timeout.err, /still running|keeps going|runs follow/);
  assert.equal((await cli(['runs', 'show', id, '--json'], { backend: be })).json.executing, true, 'the run kept going');

  // Cut every connection mid-follow; the CLI resumes from the last event it saw and finishes.
  const following = cli(['runs', 'follow', id, '--json'], { backend: be });
  await waitFor(() => be.requests.filter((u) => u.includes('/events')).length >= 2, { timeoutMs: 15_000 });
  be.server.closeAllConnections();
  await new Promise((r) => setTimeout(r, 300));
  be.gate.open();
  const done1 = await following;
  assert.equal(done1.code, 0, done1.err + done1.out);
  assert.equal(done1.lines.at(-1).run.status, 'completed');
  const seqs = done1.lines.filter((l) => l.type === 'event' || l.seq).map((l) => l.seq ?? l.event?.seq).filter(Number.isFinite);
  assert.equal(new Set(seqs).size, seqs.length, 'no event is delivered twice after reconnecting');
});

test('cancel stops a run; follow reports it with exit 8; resume finishes it', async () => {
  const be = await backend({ gated: true });
  const id = await startDetached(be);
  await waitFor(async () => (await cli(['runs', 'logs', id, '--json'], { backend: be })).json.events.length > 2);
  const c = await cli(['runs', 'cancel', id, '--json'], { backend: be });
  assert.equal(c.code, 0, c.err);
  be.gate.open();
  await idle(be, id);
  assert.equal((await cli(['runs', 'show', id, '--json'], { backend: be })).json.status, 'cancelled');
  const f = await cli(['runs', 'follow', id], { backend: be });
  assert.equal(f.code, EXIT.CANCELLED);
  const again = await cli(['runs', 'cancel', id], { backend: be });
  assert.match(again.out + again.err, /not executing/);
  const resumed = await cli(['runs', 'resume', id, '--json'], { backend: be });
  assert.equal(resumed.code, 0, resumed.err + resumed.out);
  assert.equal(resumed.lines.at(-1).run.status, 'completed');
  const done2 = await cli(['runs', 'resume', id], { backend: be });
  assert.notEqual(done2.code, 0, 'a completed run cannot be resumed');
});

test('retry and skip work only on escalated tasks and say so otherwise', async () => {
  const be = await backend({ verify: ['test -s never-created.txt'] });
  const r = await cli(['run', 'Add a farewell helper', '--project', 'app', '--attempts', '1', '--json'], { backend: be });
  assert.equal(r.code, EXIT.ATTENTION);
  const id = r.lines.at(-1).run.id;
  const ok = await cli(['runs', 'retry', id, 'nope'], { backend: be });
  assert.equal(ok.code, EXIT.NOT_FOUND, 'unknown task');
  const retried = await cli(['runs', 'retry', id, 't', '--verify', 'test -s src/farewell.js', '--json'], { backend: be });
  assert.equal(retried.code, 0, retried.err + retried.out);
  assert.equal(retried.lines.at(-1).run.status, 'completed');
  const notEscalated = await cli(['runs', 'skip', id, 't'], { backend: be });
  assert.notEqual(notEscalated.code, 0);
  assert.match(notEscalated.err, /already completed/);
});

test('delete refuses without --yes and removes the run with it', async () => {
  const be = await backend();
  const id = await startDetached(be);
  await idle(be, id);
  assert.equal((await cli(['runs', 'delete', id], { backend: be })).code, EXIT.USAGE);
  assert.equal((await cli(['runs', 'delete', id, '--yes'], { backend: be })).code, 0);
  assert.equal((await cli(['runs', 'show', id], { backend: be })).code, EXIT.NOT_FOUND);
});

// ── GitHub delivery ────────────────────────────────────────────────────────────────────────────

test('publish is explicit: needs approval, a token held by the backend and --yes; opens a PR; never merges', async () => {
  const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const remote = makeRemote();
  const api = await startMockApi();
  const be = await backend({ projects: {}, extra: { gitConfig: remote.insteadOf, githubApiUrl: api.url } });
  try {
    const mainBefore = git(remote.bare, 'rev-parse', 'main');
    const conn = await cli(['projects', 'connect', 'acme/widgets', '--json'], { backend: be });
    assert.equal(conn.code, 0, conn.err);
    assert.equal(conn.json.project.kind, 'remote');
    assert.equal((await cli(['projects', 'inspect', 'acme/widgets', '--json'], { backend: be })).json.canPublish, false);
    const r = await cli(['run', 'Add a farewell helper', '--project', 'acme/widgets', '--json'], { backend: be });
    assert.equal(r.code, 0, r.err);
    const id = r.lines.at(-1).run.id;
    assert.equal(api.calls.length, 0, 'running never talks to the GitHub API');
    assert.equal((await cli(['runs', 'publish', id, '--yes'], { backend: be })).code, EXIT.DENIED, 'needs approval');
    await cli(['runs', 'review', id, 'approve'], { backend: be });
    const noToken = await cli(['runs', 'publish', id, '--yes'], { backend: be });
    assert.notEqual(noToken.code, 0);
    assert.match(noToken.err, /token/i);
    assert.equal(git(remote.bare, 'rev-parse', 'main'), mainBefore);

    assert.equal((await cli(['config', 'set', 'githubToken', '--stdin'], { backend: be, input: `${TOKEN}\n` })).code, 0);
    assert.equal((await cli(['runs', 'publish', id], { backend: be })).code, EXIT.USAGE, 'no --yes in a non-interactive session');
    const pub = await cli(['runs', 'publish', id, '--yes', '--json'], { backend: be });
    assert.equal(pub.code, 0, pub.err + pub.out);
    assert.equal(pub.json.publication.state, 'pr-created');
    assert.match(pub.json.publication.pr.url, /\/pull\/1$/);
    assert.ok(!pub.out.includes(TOKEN) && !pub.err.includes(TOKEN));
    assert.equal(git(remote.bare, 'rev-parse', 'main'), mainBefore, 'the default branch never moves');
    assert.equal(git(remote.bare, 'rev-parse', `da-prompt/${id}`), pub.json.publication.sha);
    assert.equal(api.calls.filter((c) => c.method === 'POST').length, 1);
    const human = await cli(['runs', 'show', id], { backend: be });
    assert.match(human.out, /pull\/1/);
    assert.equal((await cli(['runs', 'merge', id], { backend: be })).code, EXIT.USAGE, 'there is no merge command');
    assert.equal((await cli(['runs', 'deploy', id], { backend: be })).code, EXIT.USAGE, 'there is no deploy command');
    const everything = JSON.stringify(await fs.promises.readFile(path.join(be.dataDir, 'runs', id, 'run.json'), 'utf8'));
    assert.ok(!everything.includes(TOKEN));
  } finally {
    await api.close();
  }
});

// ── PAX ────────────────────────────────────────────────────────────────────────────────────────

test('pax status/verify: found on the backend PATH, via an explicit path, missing, incompatible and failing — each distinct from the factory verdict', async () => {
  const be = await backend();
  const missing = await withPath(tmpDir('da-prompt-nopax-'), async () => {
    const saved = process.env.PATH;
    process.env.PATH = tmpDir('da-prompt-emptypath-');
    try { return await cli(['pax', 'status', '--json'], { backend: be }); } finally { process.env.PATH = saved; }
  });
  assert.equal(missing.code, EXIT.UNAVAILABLE);
  assert.equal(missing.json.state, 'unavailable');
  assert.match(missing.json.message, /not found on the PATH of the da-prompt server process/);

  const id = await startDetached(be);
  await idle(be, id);
  const none = await cli(['pax', 'verify', id], { backend: be });
  assert.equal(none.code, EXIT.UNAVAILABLE);

  const good = fakePax({ version: '0.5.0', drift: 1 });
  await withPath(good.dir, async () => {
    const st = await cli(['pax', 'status', '--json'], { backend: be });
    assert.equal(st.code, 0, st.err);
    assert.deepEqual([st.json.state, st.json.path, st.json.version, st.json.source], ['ok', good.file, '0.5.0', 'PATH']);
    assert.ok(st.json.environment.hostname && st.json.inspectedEnvironment.inspected, 'says which environment was inspected');
    const human = await cli(['pax', 'status'], { backend: be });
    assert.match(human.out, /backend PATH/);
    assert.match(human.out, /inspected\s+the backend's environment/);

    const v = await cli(['pax', 'verify', id, '--steps', 'info,drift', '--json'], { backend: be });
    assert.equal(v.code, 0, v.err);
    assert.deepEqual(v.json.pax.steps.map((s) => s.outcome), ['observed', 'drift-detected']);
    const flagged = await cli(['pax', 'verify', id, '--steps', 'drift', '--fail-on-findings'], { backend: be });
    assert.equal(flagged.code, EXIT.ATTENTION, 'drift is a finding, not a tool failure');
    // The factory verdict is untouched by PAX.
    const ev = await cli(['runs', 'evidence', id, '--json'], { backend: be });
    assert.equal(ev.json.evidence.factory.verdict, 'verified');
    assert.equal(ev.json.evidence.pax.state, 'collected');
    const text = await cli(['runs', 'evidence', id], { backend: be });
    assert.ok(text.out.indexOf('FACTORY VERIFICATION') < text.out.indexOf('PAX OBSERVATION'));
    assert.ok((await cli(['runs', 'artifacts', id, '--json'], { backend: be })).json.pax.length > 0);
  });

  // Explicit path, saved through config and probed first.
  const other = fakePax({ version: '0.6.1' });
  const probe = await cli(['pax', 'probe', other.file, '--json'], { backend: be });
  assert.equal(probe.code, 0, probe.err);
  assert.equal(probe.json.status.version, '0.6.1');
  assert.equal((await cli(['config', 'set', 'paxPath', other.file], { backend: be })).code, 0);
  const viaConfig = await cli(['pax', 'status', '--json'], { backend: be });
  assert.deepEqual([viaConfig.json.version, viaConfig.json.source], ['0.6.1', 'configured']);

  // A different program called pax is reported as incompatible, never run as PAX.
  const posix = fakePax({ help: 'posix' });
  const inc = await cli(['pax', 'probe', posix.file, '--json'], { backend: be });
  assert.equal(inc.code, EXIT.FAILED);
  assert.equal(inc.json.status.state, 'incompatible');
  const nonexec = await cli(['pax', 'probe', path.join(tmpDir(), 'pax'), '--json'], { backend: be });
  assert.notEqual(nonexec.code, 0);

  // A PAX that fails a step is a step failure, reported as such.
  const broken = fakePax({ exits: { info: 3 } });
  await cli(['config', 'set', 'paxPath', broken.file], { backend: be });
  const failing = await cli(['pax', 'verify', id, '--steps', 'info', '--json'], { backend: be });
  assert.equal(failing.code, EXIT.FAILED);
  assert.equal(failing.json.pax.steps[0].outcome, 'error');
  assert.equal((await cli(['runs', 'evidence', id, '--json'], { backend: be })).json.evidence.factory.verdict, 'verified', 'a failing PAX does not change the factory verdict');
  await cli(['config', 'unset', 'paxPath'], { backend: be });
});
