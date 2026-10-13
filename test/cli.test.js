import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanMachineEnv, startBackend, cli, spawnCli } from './cli-helpers.js';
import { startMockLLM, } from './mock-llm.js';
import { makeRoot, makeRepo } from './project-helpers.js';
import { tmpDir } from './helpers.js';
import { EXIT } from '../src/cli/core.js';

cleanMachineEnv();

let be;
let roots;
before(async () => {
  roots = makeRoot({ app: (d) => fs.writeFileSync(path.join(d, 'README.md'), '# app\n') });
  be = await startBackend({ ...roots.cfg });
});
after(() => be.close());

// ── help, parsing, exit codes ────────────────────────────────────────────────────────────────

test('top-level and per-command --help work without a backend, and list the documented exit codes', async () => {
  const top = await cli(['--help']);
  assert.equal(top.code, 0);
  for (const w of ['setup', 'doctor', 'status', 'config', 'providers', 'projects', 'run ', 'runs', 'pax', 'server']) assert.ok(top.out.includes(w), `top help mentions ${w}`);
  assert.match(top.out, /Exit codes: 0 ok · 1 failed · 2 usage · 3 unreachable · 4 refused · 5 not found/);
  for (const c of [['run', '--help'], ['runs', 'apply', '--help'], ['config', 'set', '--help'], ['pax', 'verify', '--help'], ['providers', 'use', '--help'], ['server', 'start', '--help']]) {
    const r = await cli(c);
    assert.equal(r.code, 0, c.join(' '));
    assert.match(r.out, /^da-prompt \w+/m, c.join(' '));
  }
  assert.equal((await cli(['runs', '--help'])).code, 0);
  assert.equal((await cli(['--version'])).out.trim(), 'da-prompt 1.0.0');
  assert.deepEqual((await cli(['--version', '--json'])).json, { version: '1.0.0' });
});

test('usage errors exit 2 with a hint, in human and JSON form; typos never start a run', async () => {
  const bad = await cli(['frobnicate', 'now']);
  assert.equal(bad.code, EXIT.USAGE);
  assert.match(bad.err, /Unknown command "frobnicate"/);
  const near = await cli(['runs', 'lst']);
  assert.equal(near.code, EXIT.USAGE);
  assert.match(near.err, /Did you mean "da-prompt runs list"/);
  const opt = await cli(['runs', 'list', '--nope']);
  assert.equal(opt.code, EXIT.USAGE);
  assert.match(opt.err, /Unknown option '--nope'/);
  const missing = await cli(['runs', 'show']);
  assert.equal(missing.code, EXIT.USAGE);
  assert.match(missing.err, /Missing argument/);
  const json = await cli(['runs', 'list', '--bogus', '--json']);
  assert.equal(json.code, EXIT.USAGE);
  assert.equal(json.json.error.code, 'usage');
  assert.equal(json.json.error.exitCode, 2);
  assert.ok(json.json.error.hint);
  // A single mistyped word is a command typo, not an idea for a build.
  const spawned = await spawnCli(['setpu'], { env: { DA_PROMPT_CONFIG_DIR: tmpDir(), FACTORY_DATA_DIR: tmpDir() } });
  assert.equal(spawned.code, 2);
  assert.match(spawned.err, /Did you mean "da-prompt setup"/);
});

test('an unreachable backend is exit 3 with a way forward, and --no-start never launches one', async () => {
  const dead = await cli(['runs', 'list', '--url', 'http://127.0.0.1:9', '--timeout', '3']);
  assert.equal(dead.code, EXIT.UNAVAILABLE);
  assert.match(dead.err, /No da-prompt backend answered/);
  const none = await cli(['runs', 'list', '--no-start'], { env: {} });
  assert.equal(none.code, EXIT.UNAVAILABLE);
  assert.match(none.err, /not running/i);
  const bad = await cli(['runs', 'list', '--timeout', 'zero', '--url', be.url]);
  assert.equal(bad.code, EXIT.USAGE);
});

// ── config ──────────────────────────────────────────────────────────────────────────────────────

test('config list shows every setting with its source, never a secret; set validates before saving', async () => {
  const list = await cli(['config', 'list', '--json'], { backend: be });
  assert.equal(list.code, 0);
  const keys = list.json.settings.map((s) => s.key);
  for (const k of ['defaultProvider', 'projectRoots', 'githubToken', 'paxPath', 'maxParallel']) assert.ok(keys.includes(k), k);
  const token = list.json.settings.find((s) => s.key === 'githubToken');
  assert.equal(token.value, undefined);
  assert.equal(token.configured, false);

  const bad = await cli(['config', 'set', 'maxParallel', '99'], { backend: be });
  assert.equal(bad.code, EXIT.USAGE);
  assert.match(bad.err, /maxParallel/);
  const unchanged = await cli(['config', 'get', 'maxParallel', '--json'], { backend: be });
  assert.notEqual(unchanged.json.value, 99);

  const ok = await cli(['config', 'set', 'maxParallel', '5', '--json'], { backend: be });
  assert.equal(ok.code, 0);
  assert.equal(ok.json.changed, true);
  const after = await cli(['config', 'get', 'maxParallel', '--json'], { backend: be });
  assert.deepEqual([after.json.value, after.json.source], [5, 'saved']);
  assert.ok(fs.existsSync(path.join(be.dataDir, 'settings.json')), 'persisted in the backend settings file');

  const unset = await cli(['config', 'unset', 'maxParallel', '--json'], { backend: be });
  assert.equal(unset.code, 0);
  assert.notEqual(unset.json.source, 'saved');
  const unknown = await cli(['config', 'get', 'nope'], { backend: be });
  assert.equal(unknown.code, EXIT.NOT_FOUND);
});

test('precedence: a saved value beats the environment, the environment beats the default, and --help says so', async () => {
  process.env.FACTORY_MAX_PARALLEL = '3';
  const be2 = await startBackend({});
  try {
    const fromEnv = await cli(['config', 'get', 'maxParallel', '--json'], { backend: be2 });
    assert.equal(fromEnv.json.source, 'environment');
    await cli(['config', 'set', 'maxParallel', '4'], { backend: be2 });
    const saved = await cli(['config', 'get', 'maxParallel', '--json'], { backend: be2 });
    assert.deepEqual([saved.json.value, saved.json.source], [4, 'saved']);
    const human = await cli(['config', 'list'], { backend: be2 });
    assert.match(human.out, /Precedence: run option > startup option > saved > environment > default/);
  } finally {
    delete process.env.FACTORY_MAX_PARALLEL;
    await be2.close();
  }
});

test('secrets are never accepted as arguments, never echoed, and never reach output, JSON, settings.json permissions or errors', async () => {
  const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD';
  const asArg = await cli(['config', 'set', 'githubToken', SECRET], { backend: be });
  assert.equal(asArg.code, EXIT.USAGE);
  assert.ok(!asArg.out.includes(SECRET) && !asArg.err.includes(SECRET));
  assert.match(asArg.err, /--stdin|--from-env/);

  const viaStdin = await cli(['config', 'set', 'githubToken', '--stdin', '--json'], { backend: be, input: `${SECRET}\n` });
  assert.equal(viaStdin.code, 0, viaStdin.err);
  assert.ok(!viaStdin.out.includes(SECRET));
  assert.equal(viaStdin.json.configured, true);
  for (const args of [['config', 'list', '--json'], ['config', 'get', 'githubToken', '--json'], ['doctor', '--json'], ['status', '--json']]) {
    const r = await cli(args, { backend: be });
    assert.ok(!r.out.includes(SECRET) && !r.err.includes(SECRET), args.join(' '));
  }
  const file = path.join(be.dataDir, 'settings.json');
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'settings.json is private to the user');

  const viaEnv = await cli(['config', 'set', 'githubToken', '--from-env', 'MY_TOKEN', '--json'], { backend: be, env: { MY_TOKEN: `${SECRET}x` } });
  assert.equal(viaEnv.code, 0);
  assert.ok(!viaEnv.out.includes(SECRET) && !viaEnv.err.includes(SECRET));
  const missing = await cli(['config', 'set', 'githubToken', '--from-env', 'NOT_SET_ANYWHERE'], { backend: be });
  assert.equal(missing.code, EXIT.USAGE);
  const clear = await cli(['config', 'unset', 'githubToken'], { backend: be });
  assert.equal(clear.code, 0);
});

test('error output redacts anything that looks like a credential', async () => {
  const r = await cli(['providers', 'show', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'], { backend: be });
  assert.notEqual(r.code, 0);
  assert.ok(!/sk-ant-api03-A{20}/.test(r.err + r.out));
  const url = await cli(['projects', 'connect', 'https://user:hunter2secret@github.com/acme/widgets.git'], { backend: be });
  assert.ok(!/hunter2secret/.test(url.err + url.out));
});

// ── providers ───────────────────────────────────────────────────────────────────────────────────

test('providers: discovery, connectivity and inference are reported as separate stages; use/planner validate before saving', async () => {
  const llm = await startMockLLM({ flavor: 'openai', models: ['mock-coder', 'mock-small'] });
  const be3 = await startBackend({});
  try {
    const add = await cli(['providers', 'add', '--label', 'Mock', '--provider-url', llm.url, '--json'], { backend: be3 });
    assert.equal(add.code, 0, add.err);
    const id = add.json.provider.id;
    const list = await cli(['providers', 'list', '--json'], { backend: be3 });
    assert.ok(list.json.providers.some((p) => p.id === id));

    const models = await cli(['providers', 'models', id, '--json'], { backend: be3 });
    assert.equal(models.code, 0, models.err);
    assert.ok(JSON.stringify(models.json).includes('mock-coder'));

    const test1 = await cli(['providers', 'test', id, '--model', 'mock-coder', '--json'], { backend: be3 });
    assert.equal(test1.code, 0, test1.err);
    const stages = test1.json.stages.map((s) => `${s.stage}:${s.ok}`);
    assert.deepEqual(stages, ['connectivity:true', 'discovery:true', 'inference:true']);

    const use = await cli(['providers', 'use', id, '--model', 'mock-coder', '--json'], { backend: be3 });
    assert.equal(use.code, 0, use.err);
    assert.equal((await cli(['config', 'get', 'defaultProvider', '--json'], { backend: be3 })).json.value, id);
    assert.equal((await cli(['config', 'get', 'defaultModel', '--json'], { backend: be3 })).json.value, 'mock-coder');

    const planner = await cli(['providers', 'planner', id, '--model', 'mock-small'], { backend: be3 });
    assert.equal(planner.code, 0, planner.err);
    assert.equal((await cli(['config', 'get', 'defaultPlannerModel', '--json'], { backend: be3 })).json.value, 'mock-small');

    // A model the server does not list is a discovery failure and is not saved.
    const bad = await cli(['providers', 'use', id, '--model', 'does-not-exist', '--json'], { backend: be3 });
    assert.notEqual(bad.code, 0);
    assert.equal((await cli(['config', 'get', 'defaultModel', '--json'], { backend: be3 })).json.value, 'mock-coder');
  } finally {
    await be3.close();
    await llm.close();
  }
});

test('providers: unreachable, unauthorised and missing-key failures are distinguished with fixes, and nothing is saved', async () => {
  const llm = await startMockLLM({ flavor: 'openai', apiKey: 'sekret-key-for-test-1234567890' });
  const be4 = await startBackend({});
  try {
    const added = await cli(['providers', 'add', '--label', 'Locked', '--provider-url', llm.url, '--json'], { backend: be4 });
    const locked = added.json.provider.id;
    const noKey = await cli(['providers', 'test', locked, '--json'], { backend: be4 });
    assert.notEqual(noKey.code, 0);
    assert.ok(noKey.json.stages.some((s) => !s.ok));
    const wrong = await cli(['providers', 'set-key', locked, '--stdin', '--json'], { backend: be4, input: 'wrong-key-wrong-key-wrong\n' });
    assert.equal(wrong.code, 1, 'the key was saved but the provider rejects it: not a success');
    assert.equal(wrong.json.status, 'auth_error');
    const denied = await cli(['providers', 'test', locked, '--json'], { backend: be4 });
    assert.notEqual(denied.code, 0);
    assert.ok(!JSON.stringify(denied.json).includes('wrong-key-wrong-key-wrong'), 'the key is never echoed');
    const right = await cli(['providers', 'set-key', locked, '--stdin'], { backend: be4, input: 'sekret-key-for-test-1234567890\n' });
    assert.equal(right.code, 0);
    const ok = await cli(['providers', 'test', locked, '--model', 'mock-coder', '--json'], { backend: be4 });
    assert.equal(ok.code, 0, ok.err + JSON.stringify(ok.json));
    assert.ok(!ok.out.includes('sekret-key-for-test-1234567890'));
    const keyArg = await cli(['providers', 'set-key', locked, 'sekret-key-for-test-1234567890'], { backend: be4 });
    assert.equal(keyArg.code, EXIT.USAGE, 'keys are not accepted as arguments');
    // Nothing is saved when a provider fails validation.
    await llm.close();
    const down = await cli(['providers', 'use', locked, '--model', 'mock-coder', '--json'], { backend: be4 });
    assert.notEqual(down.code, 0);
    assert.notEqual((await cli(['config', 'get', 'defaultProvider', '--json'], { backend: be4 })).json.value, locked);
  } finally {
    await be4.close();
    await llm.close().catch(() => {});
  }
});

// ── projects ────────────────────────────────────────────────────────────────────────────────────

test('projects: opaque ids, read-only roots, and a path only resolves inside an authorized root', async () => {
  const list = await cli(['projects', 'list', '--json'], { backend: be });
  assert.equal(list.code, 0);
  const app = list.json.projects.find((p) => p.name === 'app');
  assert.ok(app);
  assert.match(app.id, /^[0-9a-f]{10}:app$/);
  assert.ok(!JSON.stringify(list.json).includes(roots.root), 'server paths are not sent to clients');

  const cfgDir = tmpDir('da-prompt-cli-cfg-');
  const use = await cli(['projects', 'use', 'app', '--json'], { backend: be, configDir: cfgDir });
  assert.equal(use.code, 0, use.err);
  const cur = await cli(['projects', 'current', '--json'], { backend: be, configDir: cfgDir });
  assert.equal(cur.json.project.directoryId, app.id);
  const state = JSON.parse(fs.readFileSync(path.join(cfgDir, 'cli.json'), 'utf8'));
  assert.deepEqual(Object.keys(state), ['project']);
  assert.ok(!JSON.stringify(state).includes(roots.root), 'the CLI state holds an id, not a path');
  assert.equal(fs.statSync(path.join(cfgDir, 'cli.json')).mode & 0o077, 0);

  // Authority comes from the backend's roots, not from the string the caller typed.
  const outside = makeRepo();
  const refused = await cli(['projects', 'use', outside], { backend: be, configDir: cfgDir });
  assert.equal(refused.code, EXIT.DENIED);
  assert.match(refused.err, /not inside an authorized root/);
  assert.ok(!refused.out.includes('cli.json'));
  const traversal = await cli(['projects', 'use', path.join(path.dirname(roots.dirs.app), '..', path.basename(outside))], { backend: be, configDir: cfgDir });
  assert.equal(traversal.code, EXIT.DENIED);
  const guessed = await cli(['projects', 'use', 'abcdef0123:app'], { backend: be, configDir: cfgDir });
  const run = await cli(['run', 'x', '--project', 'abcdef0123:app', '--detach'], { backend: be, configDir: cfgDir });
  assert.notEqual(run.code, 0, 'a guessed id grants nothing');
  void guessed;
  const named = await cli(['projects', 'use', roots.dirs.app, '--json'], { backend: be, configDir: cfgDir });
  assert.equal(named.code, 0, 'an absolute path inside the root maps to the same id');
  assert.equal(named.json.selected.directoryId, app.id);
});

test('projects: read-only roots are labelled, GitHub projects are connected without a path, and bad references are usage errors', async () => {
  const ro = makeRoot({ lib: (d) => fs.writeFileSync(path.join(d, 'README.md'), '# lib\n') }, { readOnly: true });
  const beRo = await startBackend({ ...ro.cfg });
  try {
    const list = await cli(['projects', 'list', '--json'], { backend: beRo });
    assert.equal(list.json.projects.find((p) => p.name === 'lib').readOnly, true);
    const use = await cli(['projects', 'use', 'lib'], { backend: beRo });
    assert.match(use.out, /read-only/);
  } finally {
    await beRo.close();
  }
  const bad = await cli(['projects', 'connect', 'not a repo'], { backend: be });
  assert.equal(bad.code, EXIT.USAGE);
  const none = await cli(['projects', 'use', 'nothing-like-this'], { backend: be });
  assert.equal(none.code, EXIT.NOT_FOUND);
  assert.match(none.err, /No authorized project named/);
});

// ── status / doctor / server records ───────────────────────────────────────────────────────────

test('status and doctor report the backend honestly in human and JSON form, and doctor exits 1 when something is unusable', async () => {
  const st = await cli(['status', '--url', be.url, '--json']);
  assert.equal(st.code, 0, st.err);
  assert.equal(st.json.running, true);
  assert.equal(st.json.backend.version, '1.0.0');
  const doc = await cli(['doctor', '--json'], { backend: be });
  assert.ok([0, 1].includes(doc.code));
  assert.ok(Array.isArray(doc.json.local) && doc.json.health && typeof doc.json.ok === 'boolean');
  const strict = await cli(['doctor', '--strict'], { backend: be });
  assert.equal(strict.code, 1, 'warnings (no real provider) fail --strict');
  assert.match(strict.out, /PAX|provider/i);
});
