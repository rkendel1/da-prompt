// Regression tests for the "reliable, resource-aware factory" change. Each one is a failure mode seen in a real run:
// a model that describes a file instead of creating it, an empty or fake artifact, a required PNG nothing can produce, the
// same failure retried for minutes, parallel generations fighting over one local model.
// They run the REAL factory with scripted model replies (see test/replay-helpers.js): no model, no network, no browser.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { blockNetwork, blocked } from './offline-guard.js';
import { runReplay, runInvariants } from './replay-helpers.js';
import { w, finish, tool } from './replay/fixtures.js';
import { Workspace } from '../src/sandbox.js';
import { validateArtifact, validateArgs, checkTaskContracts, repairOrdering, detectCapabilities, checkOutput } from '../src/capabilities.js';
import { AGENT_TOOLS, execTool, toolsFor } from '../src/agents.js';
import { InferenceLimiter, fitContext, ContextOverflowError, outputReserve } from '../src/inference.js';
import { failureFingerprint, normalizeFailureText, buildFeedback } from '../src/recovery.js';
import { OpenAICompatProvider } from '../src/providers/openai.js';

const restoreNet = blockNetwork();
after(() => {
  restoreNet();
  assert.deepEqual(blocked, [], 'nothing left this machine');
});

const tmp = (p = 'reliable-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A real (tiny) PNG, built here so no binary fixture is committed.
const crc = (() => {
  const t = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};
function makePng(w = 64, h = 48) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A stand-in browser: a script that honours --screenshot=<path>. `lie` makes it exit 0 without writing anything. */
function fakeBrowser({ lie = false } = {}) {
  const dir = tmp('fake-browser-');
  const png = path.join(dir, 'fixture.png');
  fs.writeFileSync(png, makePng());
  const bin = path.join(dir, 'fake-chrome');
  fs.writeFileSync(bin, `#!/bin/sh\n${lie ? 'exit 0' : `for a in "$@"; do case "$a" in --screenshot=*) cp "${png}" "\${a#--screenshot=}";; esac; done`}\n`, { mode: 0o755 });
  return bin;
}

const planOf = (t) => ({ tasks: Array.isArray(t) ? t : [t], finalVerify: ['npm test'] });
const HTML = '<!doctype html><html><body><main><h1>Reading list</h1><p>Add books you want to read and tick them off.</p></main></body></html>';
const noBrowser = { browserPath: '/nonexistent/browser' }; // explicit and missing: "no renderer", whatever this machine has installed
const attemptsOf = (r, id = 't') => r.run.plan.tasks.find((t) => t.id === id).attempts;
const taskOf = (r, id = 't') => r.run.plan.tasks.find((t) => t.id === id);

// ── truthful completion ───────────────────────────────────────────────────────────────────────────

test('an agent that says it wrote a file but did not is never completed: the file is checked on disk', async () => {
  const r = await runReplay({
    idea: 'claim without doing',
    planResponses: [{ plan: planOf({ id: 't', outputs: ['docs/design.md'] }) }],
    attempts: [[{ text: 'I created docs/design.md with the full design.' }, [finish('created docs/design.md', [])]]],
    maxAttempts: 3,
  });
  runInvariants(r.run, r.store);
  assert.equal(taskOf(r).status, 'escalated');
  assert.notEqual(r.run.status, 'completed');
  const a = attemptsOf(r)[0];
  assert.equal(a.ok, false);
  assert.equal(a.failure.category, 'acceptance', 'a failed check is an acceptance failure, not an execution failure');
  assert.match(a.verification[0].output, /does not exist/);
  assert.equal(taskOf(r).result, undefined, 'only verified work becomes a task result');
});

test('a complete_task naming a file that does not exist is refused inside the agent loop, and the agent is told so', async () => {
  const r = await runReplay({
    idea: 'claim then fix',
    planResponses: [{ plan: planOf({ id: 't', outputs: ['docs/a.md'] }) }],
    attempts: [[[finish('done', ['docs/a.md'])], [w('docs/a.md', '# A\n\nReal content for the design document.\n')], [finish('now really done', ['docs/a.md'])]]],
  });
  assert.equal(r.run.status, 'completed', JSON.stringify(r.run.checklist));
  const rejected = r.tools.find((e) => e.tool === 'complete_task');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 'rejected');
  const reply = r.provider.requests.find((q) => q.kind === 'task' && q.messages.length > 2).messages.at(-1).content[0];
  assert.equal(reply.is_error, true);
  assert.match(reply.content, /does not exist.*NOT complete/s);
});

test('a tool error is reported as an error, and nothing downstream treats the operation as done', async () => {
  const r = await runReplay({
    idea: 'write without content',
    planResponses: [{ plan: planOf({ id: 't', outputs: ['docs/x.md'] }) }],
    // write_file without "content" used to create an EMPTY file and report success.
    attempts: [[[tool('write_file', { path: 'docs/x.md' })], [finish('written', ['docs/x.md'])]]],
    maxAttempts: 1,
  });
  const e = r.tools[0];
  assert.deepEqual([e.tool, e.ok, e.status, e.invoked], ['write_file', false, 'rejected', true]);
  assert.match(e.output, /content is required|Nothing was executed/);
  assert.equal(fs.existsSync(path.join(r.store.workspaceDir(r.id), 'docs/x.md')), false, 'no file was created by the rejected call');
  assert.equal(taskOf(r).status, 'escalated');
});

test('an empty or invalid required artifact fails verification; a valid one completes', async () => {
  const empty = await runReplay({
    idea: 'empty report', planResponses: [{ plan: planOf({ id: 't', outputs: ['REPORT.md'] }) }],
    attempts: [[[w('REPORT.md', '')], [finish('done', [])]]], maxAttempts: 1,
  });
  assert.equal(taskOf(empty).status, 'escalated');
  assert.match(attemptsOf(empty)[0].verification[0].output, /is empty/);

  const badJson = await runReplay({
    idea: 'bad json', planResponses: [{ plan: planOf({ id: 't', outputs: ['data.json'] }) }],
    attempts: [[[w('data.json', '{not json')], [finish('done', [])]]], maxAttempts: 1,
  });
  assert.match(attemptsOf(badJson)[0].verification[0].output, /not valid JSON/);

  const good = await runReplay({
    idea: 'good report', planResponses: [{ plan: planOf({ id: 't', outputs: ['REPORT.md'] }) }],
    attempts: [[[w('REPORT.md', '# Report\n\nThe findings, in full.\n')], [finish('done', ['REPORT.md'])]]],
  });
  runInvariants(good.run, good.store);
  assert.equal(good.run.status, 'completed');
  assert.deepEqual(taskOf(good).verified.outputs.map((o) => [o.path, o.kind]), [['REPORT.md', 'file']]);
});

test('a task with nothing to check is flagged in the plan and cannot be completed by a claim alone', async () => {
  const claim = await runReplay({
    idea: 'only words', planResponses: [{ plan: planOf({ id: 't' }) }],
    attempts: [[[finish('everything is finished and verified', [])]]], maxAttempts: 1,
  });
  assert.match(claim.run.plan.warnings[0], /task "t" has no outputs and no verify command/);
  assert.equal(taskOf(claim).status, 'escalated');
  assert.equal(attemptsOf(claim)[0].verification[0].check, 'work');
  assert.match(attemptsOf(claim)[0].verification[0].output, /the agent only described the work/);
  const real = await runReplay({
    idea: 'some work', planResponses: [{ plan: planOf({ id: 't' }) }],
    attempts: [[[w('notes.md', '# notes\n\nwork was done\n')], [finish('wrote notes', ['notes.md'])]]],
  });
  assert.equal(taskOf(real).status, 'completed', 'executed work (a file really written) satisfies the minimum check');
});

// ── validation primitives ─────────────────────────────────────────────────────────────────────────

test('validateArtifact: missing, empty, fake PNG, real PNG, html, json', async () => {
  const dir = tmp();
  const ws = new Workspace(dir);
  await ws.writeFile('empty.txt', '');
  await ws.writeFile('fake.png', 'This is a screenshot of the reading list UI.');
  await ws.writeBytes('real.png', makePng());
  await ws.writeFile('page.html', HTML);
  await ws.writeFile('blank.html', '<html></html>');
  await ws.writeFile('ok.json', '{"a":1}');
  fs.mkdirSync(path.join(dir, 'sub'));
  const v = async (p) => (await validateArtifact(ws, p));
  assert.equal((await v('nope.txt')).reason, 'missing');
  assert.equal((await v('empty.txt')).reason, 'empty');
  assert.equal((await v('fake.png')).reason, 'invalid-image');
  assert.match((await v('fake.png')).detail, /prose or HTML saved under this name does not count/);
  const png = await v('real.png');
  assert.deepEqual([png.ok, png.width, png.height], [true, 64, 48]);
  assert.equal((await v('page.html')).ok, true);
  assert.equal((await v('blank.html')).ok, false);
  assert.equal((await v('ok.json')).ok, true);
  assert.equal((await v('sub')).reason, 'not-a-file');
  const g = await checkOutput(ws, '*.png');
  assert.equal(g.ok, true, 'a glob needs at least one VALID match');
  await fs.promises.rm(path.join(dir, 'real.png'));
  assert.equal((await checkOutput(ws, '*.png')).ok, false, 'the invalid fake.png does not satisfy the glob');
});

test('write_file confirms the bytes on disk and refuses bad arguments with an actionable message', async () => {
  const ws = new Workspace(tmp());
  const ok = await execTool(ws, { name: 'write_file', input: { path: 'a/b.txt', content: 'hello' } }, { settings: {} });
  assert.deepEqual([ok.status, ok.isError, ok.bytes], ['executed', undefined, 5]);
  assert.match(ok.text, /confirmed on disk/);
  for (const [input, re] of [[{ path: 'a.txt' }, /content is required/], [{ content: 'x' }, /path is required/], [{ path: 'a.txt', content: { not: 'text' } }, /content must be string/]]) {
    const bad = await execTool(ws, { name: 'write_file', input }, { settings: {} });
    assert.deepEqual([bad.status, bad.isError], ['rejected', true]);
    assert.match(bad.text, re);
  }
  const outside = await execTool(ws, { name: 'write_file', input: { path: '../x', content: 'x' } }, { settings: {} });
  assert.deepEqual([outside.status, outside.isError], ['failed', true]);
  const cmdFail = await execTool(ws, { name: 'run_command', input: { command: 'exit 3' } }, { settings: { commandTimeoutMs: 5000 } });
  assert.deepEqual([cmdFail.status, cmdFail.isError, cmdFail.exitCode], ['failed', true, 3]);
  const unavailable = await execTool(ws, { name: 'render_screenshot', input: { html_path: 'a.html', output_path: 'a.png' } }, { settings: {}, caps: detectCapabilities({ browserPath: '/nonexistent/browser' }, { env: {} }) });
  assert.deepEqual([unavailable.status, unavailable.capability], ['unavailable', 'browser_render']);
});

test('validateArgs follows the tool schemas', () => {
  const run = AGENT_TOOLS.find((t) => t.name === 'run_command').input_schema;
  assert.deepEqual(validateArgs(run, { command: 'ls' }), []);
  assert.match(validateArgs(run, {})[0], /command is required/);
  assert.match(validateArgs(run, { command: 'ls', timeout_seconds: 9999 })[0], /<= 600/);
  assert.match(validateArgs(run, { command: 5 })[0], /must be string/);
  assert.match(validateArgs(run, 'ls')[0], /must be a JSON object/);
});

test('agents are offered exactly the tools that exist: optional tools only with a real capability', () => {
  const none = detectCapabilities({ browserPath: '/nonexistent/browser' }, { env: {} });
  assert.deepEqual(toolsFor(none).map((t) => t.name), AGENT_TOOLS.map((t) => t.name));
  const withBrowser = detectCapabilities({ browserPath: fakeBrowser() }, { env: {} });
  assert.ok(toolsFor(withBrowser).some((t) => t.name === 'render_screenshot'));
  assert.ok(!toolsFor(withBrowser).some((t) => t.name === 'generate_image'), 'no image provider configured, so no image tool');
  const withImage = detectCapabilities({ browserPath: '/nonexistent/browser', image: { url: 'http://127.0.0.1:1', model: 'm' } }, { env: {} });
  assert.ok(toolsFor(withImage).some((t) => t.name === 'generate_image'));
  assert.equal(detectCapabilities({ image: { url: 'http://x' }, browserPath: '/nonexistent/browser' }, { env: {} }).image_generation.available, false);
  assert.equal(detectCapabilities({ browserPath: fakeBrowser() }, { env: {}, engine: 'fx' }).browser_render.available, false, 'the fx engine is not given tools it cannot call');
});

// ── plan validation ───────────────────────────────────────────────────────────────────────────────

test('checkTaskContracts: unverifiable tasks, concurrent writers, unordered reads and unproducible images', () => {
  const caps = detectCapabilities({ browserPath: '/nonexistent/browser' }, { env: {} });
  const t = (id, extra = {}) => ({ id, dependsOn: [], outputs: [], verify: [], acceptance: ['ok'], ...extra });
  const c = checkTaskContracts({ tasks: [t('a'), t('b', { outputs: ['x.txt'] }), t('c', { outputs: ['x.txt'] }), t('d', { outputs: ['../escape'] }), t('e', { verify: ['cat x.txt'], outputs: ['e.txt'] })] }, caps);
  const text = c.problems.join('\n');
  assert.match(c.warnings.join(), /task "a" has no outputs and no verify command/);
  assert.match(text, /"b" and "c" both write x\.txt/);
  assert.match(text, /output "\.\.\/escape" must be a relative path/);
  assert.match(checkTaskContracts({ tasks: [t('s', { outputs: ['s.png'], verify: ['render_screenshot a.html s.png'] })] }, caps).problems.join(), /starts with the tool name render_screenshot/);
  assert.match(text, /task "e" verifies x\.txt.*does not depend on it/);
  const ordered = checkTaskContracts({ tasks: [t('b', { outputs: ['x.txt'] }), t('c', { outputs: ['x.txt'], dependsOn: ['b'] })] }, caps);
  assert.deepEqual(ordered.problems, [], 'ordered writers are fine');
  const png = checkTaskContracts({ tasks: [t('ui', { outputs: ['public/images/reading-list.png'] })] }, caps);
  assert.equal(png.gaps.length, 1);
  assert.match(png.gaps[0].reason, /neither render a screenshot.*nor generate images/s);
  const rendered = checkTaskContracts({ tasks: [t('ui', { outputs: ['shot.png'] })] }, detectCapabilities({ browserPath: fakeBrowser() }, { env: {} }));
  assert.deepEqual(rendered.gaps, []);
  const accept = checkTaskContracts({ tasks: [t('ui', { outputs: ['ui.html'], acceptance: ['a screenshot of the UI is saved'] })] }, detectCapabilities({ browserPath: fakeBrowser() }, { env: {} }));
  assert.match(accept.problems.join(), /image\/screenshot acceptance criterion but no image in outputs/);
});

test('missing ordering is repaired (only edges are added); an unsafe plan is sent back to the planner', async () => {
  const t = (id, extra = {}) => ({ id, dependsOn: [], outputs: [], verify: [], acceptance: ['ok'], ...extra });
  const plan = { tasks: [t('code', { outputs: ['src/a.js'], verify: ['node --test test/a.test.js'] }), t('tests', { outputs: ['test/a.test.js'] }), t('x', { outputs: ['same.md'] }), t('y', { outputs: ['same.md'] })] };
  const notes = repairOrdering(plan);
  assert.deepEqual(plan.tasks.map((x) => x.dependsOn), [['tests'], [], [], ['x']]);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /task "code" now depends on "tests".*reads test\/a\.test\.js/);
  assert.deepEqual(checkTaskContracts(plan, detectCapabilities({ browserPath: '/nonexistent/browser' }, { env: {} })).problems, []);
  // An edge that would close a cycle is not added; the contradiction is reported instead.
  const cyc = { tasks: [t('a', { outputs: ['a.md'], dependsOn: ['b'] }), t('b', { outputs: ['b.md'], verify: ['cat a.md'] })] };
  assert.deepEqual(repairOrdering(cyc), []);
  assert.match(checkTaskContracts(cyc, {}).problems.join(), /task "b" verifies a\.md/);

  const r = await runReplay({
    idea: 'repair and reject',
    planResponses: [
      { plan: { tasks: [{ id: 'a', outputs: ['../escape.md'] }], finalVerify: ['npm test'] } },
      { plan: { tasks: [{ id: 'a', outputs: ['a.md'] }, { id: 'b', outputs: ['a.md'] }], finalVerify: ['npm test'] } },
    ],
    taskAttempts: { a: [[[w('a.md', '# a\n\nreal text for a\n')], [finish('a')]]], b: [[[w('a.md', '# a again\n\nreal text for b\n')], [finish('b')]]] },
    settings: { maxParallel: 3 },
  });
  assert.equal(r.provider.planCalls, 2, 'the unsafe output path was sent back; the ordering problem was not');
  assert.match(r.provider.requests.filter((q) => q.kind === 'plan')[1].messages.at(-1).content[0].content, /output "\.\.\/escape\.md" must be a relative path/);
  assert.deepEqual(r.run.plan.tasks.map((x) => x.dependsOn), [[], ['a']]);
  assert.match(r.run.plan.adjustments[0], /both write a\.md/);
  assert.ok(r.events.some((e) => e.type === 'log' && /Plan adjusted: task "b" now depends on "a"/.test(e.text)));
  const order = r.events.filter((e) => e.type === 'task').map((e) => `${e.taskId}:${e.status}`);
  assert.ok(order.indexOf('a:completed') < order.indexOf('b:running'), 'the two writers never overlapped');
});

test('design example: a plan that needs a PNG nothing can produce is told so, may pick an HTML wireframe, and is never silently weakened', async () => {
  const pngPlan = { tasks: [{ id: 'design', role: 'design', outputs: ['public/images/reading-list.png'] }], finalVerify: ['npm test'] };
  const htmlPlan = { tasks: [{ id: 'design', role: 'design', outputs: ['docs/wireframe.html'] }], finalVerify: ['npm test'] };
  // 1. The planner switches to the supported equivalent after being told about the gap.
  const fixed = await runReplay({
    idea: 'design a reading list', planResponses: [{ plan: pngPlan }, { plan: htmlPlan }],
    attempts: [[[w('docs/wireframe.html', HTML)], [finish('wireframe written', ['docs/wireframe.html'])]]],
  }, { cfg: noBrowser });
  assert.equal(fixed.provider.planCalls, 2);
  assert.match(fixed.provider.requests.filter((q) => q.kind === 'plan')[1].messages.at(-1).content[0].content, /neither render a screenshot.*nor generate images/s);
  assert.equal(fixed.run.status, 'completed', JSON.stringify(fixed.run.checklist));
  // 2. A planner that insists keeps its PNG requirement: the task is BLOCKED with the capability reason, no agent ever runs, nothing is retried.
  const insists = await runReplay({ idea: 'design a reading list', planResponses: [{ plan: pngPlan }, { plan: pngPlan }, { plan: pngPlan }], attempts: [[[w('public/images/reading-list.png', 'a screenshot of the UI')]]] }, { cfg: noBrowser });
  runInvariants(insists.run, insists.store);
  const t = taskOf(insists, 'design');
  assert.equal(t.status, 'blocked');
  assert.equal(t.attempts.length, 0, 'no attempt was spent on an impossible task');
  assert.equal(t.failure.category, 'capability');
  assert.match(t.blockedReason.reason, /neither render a screenshot.*nor generate images/s);
  assert.equal(insists.provider.requests.filter((q) => q.kind === 'task').length, 0);
  assert.notEqual(insists.run.status, 'completed');
  assert.deepEqual(t.outputs, ['public/images/reading-list.png'], 'the acceptance requirement was not weakened');
});

// ── artifact workflow ─────────────────────────────────────────────────────────────────────────────

test('screenshot: HTML written, rendered by a real renderer, and the PNG is verified as a valid image', async () => {
  const plan = { tasks: [{ id: 'ui', role: 'design', outputs: ['docs/wireframe.html', 'docs/wireframe.png'] }], finalVerify: ['npm test'] };
  const r = await runReplay({
    idea: 'wireframe and screenshot', planResponses: [{ plan }],
    attempts: [[[w('docs/wireframe.html', HTML)], [tool('render_screenshot', { html_path: 'docs/wireframe.html', output_path: 'docs/wireframe.png' })], [finish('done', ['docs/wireframe.html', 'docs/wireframe.png'])]]],
  }, { cfg: { browserPath: fakeBrowser() } });
  runInvariants(r.run, r.store);
  assert.equal(r.run.status, 'completed', JSON.stringify(r.run.checklist));
  assert.deepEqual(r.tools.slice(0, 2).map((e) => [e.tool, e.ok, e.status]), [['write_file', true, 'executed'], ['render_screenshot', true, 'executed']]);
  const png = taskOf(r, 'ui').verified.outputs.find((o) => o.path === 'docs/wireframe.png');
  assert.deepEqual([png.kind, png.width, png.height], ['image', 64, 48]);
  assert.ok(r.provider.requests.find((q) => q.kind === 'task').tools.includes('render_screenshot'));
});

test('screenshot: a renderer that exits 0 without producing an image is an explicit failure, not a success', async () => {
  const plan = { tasks: [{ id: 'ui', role: 'design', outputs: ['docs/wireframe.png'] }], finalVerify: ['npm test'] };
  const r = await runReplay({
    idea: 'lying renderer', planResponses: [{ plan }],
    attempts: [[[w('docs/wireframe.html', HTML)], [tool('render_screenshot', { html_path: 'docs/wireframe.html', output_path: 'docs/wireframe.png' })], [finish('rendered', ['docs/wireframe.png'])]]],
    maxAttempts: 1,
  }, { cfg: { browserPath: fakeBrowser({ lie: true }) } });
  const render = r.tools.find((e) => e.tool === 'render_screenshot');
  assert.deepEqual([render.ok, render.status], [false, 'failed']);
  assert.match(render.output, /does not exist|did not succeed/);
  assert.equal(taskOf(r, 'ui').status, 'escalated');
});

test('a PNG requirement is not satisfied by prose, by HTML saved as .png, or by describing a screenshot', async () => {
  const plan = { tasks: [{ id: 'ui', role: 'design', outputs: ['shot.png'] }], finalVerify: ['npm test'] };
  const r = await runReplay({
    idea: 'fake png', planResponses: [{ plan }],
    attempts: [[[w('shot.png', HTML)], [finish('screenshot saved to shot.png', [])]]], maxAttempts: 1,
  }, { cfg: { browserPath: fakeBrowser() } });
  assert.match(attemptsOf(r, 'ui')[0].verification[0].output, /not a valid png image/);
  assert.equal(taskOf(r, 'ui').status, 'escalated');
});

test('generate_image calls the configured provider, saves the bytes, and verifies the format', async () => {
  const png = makePng(32, 32);
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits += 1;
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b);
      res.setHeader('content-type', 'application/json');
      if (body.prompt === 'boom') return res.writeHead(500).end(JSON.stringify({ error: { message: 'model exploded' } }));
      res.end(JSON.stringify({ data: [{ b64_json: (body.prompt === 'text' ? Buffer.from('not an image at all, just text bytes') : png).toString('base64') }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/v1`;
    const cfg = { image: { url, model: 'img-1', apiKey: 'sk-secret-image-key-123456' } };
    const caps = detectCapabilities(cfg, { env: {} });
    const ws = new Workspace(tmp());
    const ok = await execTool(ws, { name: 'generate_image', input: { prompt: 'a bookshelf', output_path: 'img/logo.png' } }, { settings: {}, caps, cfg });
    assert.deepEqual([ok.status, ok.isError], ['executed', undefined]);
    assert.equal((await validateArtifact(ws, 'img/logo.png')).ok, true);
    const wrongFormat = await execTool(ws, { name: 'generate_image', input: { prompt: 'a bookshelf', output_path: 'img/logo.gif' } }, { settings: {}, caps, cfg });
    assert.match(wrongFormat.text, /unsupported output format/);
    const notImage = await execTool(ws, { name: 'generate_image', input: { prompt: 'text', output_path: 'img/bad.png' } }, { settings: {}, caps, cfg });
    assert.equal(notImage.isError, true);
    assert.match(notImage.text, /not a valid png/i);
    assert.equal(fs.existsSync(path.join(ws.root, 'img/bad.png')), false, 'an invalid image is not left behind as an artifact');
    const err = await execTool(ws, { name: 'generate_image', input: { prompt: 'boom', output_path: 'img/x.png' } }, { settings: {}, caps, cfg });
    assert.match(err.text, /image provider error/);
    assert.ok(!err.text.includes('sk-secret-image-key-123456'));
    assert.ok(hits >= 3);
    const unconfigured = await execTool(ws, { name: 'generate_image', input: { prompt: 'x', output_path: 'a.png' } }, { settings: {}, caps: detectCapabilities({ browserPath: '/nonexistent/browser' }, { env: {} }), cfg: {} });
    assert.deepEqual([unconfigured.status, unconfigured.capability], ['unavailable', 'image_generation']);
    assert.match(unconfigured.text, /no image provider configured/);
  } finally {
    srv.close();
  }
});

// ── feedback and recovery ─────────────────────────────────────────────────────────────────────────

test('verification failures go back to the agent as a structured message, the retry fixes that failure, and valid artifacts are reused', async () => {
  const plan = { tasks: [{ id: 't', outputs: ['a.md', 'b.md'], verify: ['grep -q DONE b.md'] }], finalVerify: ['npm test'] };
  const r = await runReplay({
    idea: 'structured feedback', planResponses: [{ plan }],
    attempts: [
      [[w('a.md', '# a\n\nfirst file, valid\n')], [w('b.md', '# b\n\nno marker yet\n')], [finish('done', ['a.md', 'b.md'])]],
      [[w('b.md', '# b\n\nDONE marker present\n')], [finish('fixed b', ['b.md'])]],
    ],
    maxAttempts: 3,
  });
  runInvariants(r.run, r.store);
  assert.equal(r.run.status, 'completed', JSON.stringify(r.run.checklist));
  const [a1, a2] = attemptsOf(r);
  assert.equal(a1.failure.category, 'acceptance');
  assert.match(a1.feedback, /Failed criterion: command exits 0: grep -q DONE b\.md/);
  assert.match(a1.feedback, /Check: \$ grep -q DONE b\.md/);
  assert.match(a1.feedback, /Result: exit code 1/);
  assert.match(a1.feedback, /Already valid and kept.*a\.md/);
  assert.match(a1.feedback, /3 tool call\(s\)/, 'what the attempt actually did comes from tool outcomes');
  const brief = r.provider.requests.filter((q) => q.kind === 'task' && q.attempt === 2)[0].messages[0].content;
  assert.match(brief, /Previous attempt failed verification/);
  assert.match(brief, /grep -q DONE b\.md/);
  assert.equal(a2.ok, true);
  assert.equal(a2.tools.writes, 1, 'the retry re-wrote only the file that was wrong');
  assert.ok(a2.verification.length >= 3, 'the full set ran once the failing check passed');
});

test('a retry re-runs only the checks that failed first; the full set is required only once they pass', async () => {
  const plan = { tasks: [{ id: 't', verify: ['test -s a.txt', 'test -s b.txt'] }], finalVerify: ['npm test'] };
  const r = await runReplay({
    idea: 'targeted recheck', planResponses: [{ plan }],
    attempts: [
      [[w('a.txt', 'a\n')], [finish('a only')]],
      [[w('c.txt', 'unrelated\n')], [finish('wrong file')]],
      [[w('b.txt', 'b\n')], [finish('b')]],
    ],
    maxAttempts: 4, settings: { maxRepeatedFailures: 4 },
  });
  const [a1, a2, a3] = attemptsOf(r);
  assert.equal(a1.verification.length, 2);
  assert.equal(a2.partial, true, 'only the failed check was re-run');
  assert.deepEqual(a2.verification.map((v) => v.command), ['test -s b.txt']);
  assert.equal(a3.ok, true);
  assert.equal(a3.verification.length, 2, 'the full set ran after the targeted check passed');
});

test('the same failure repeating stops the task within budget, as no_progress, with the evidence kept', async () => {
  const plan = { tasks: [{ id: 't', role: 'design', outputs: ['docs/design.md'] }], finalVerify: ['npm test'] };
  const r = await runReplay({
    idea: 'same failure forever', planResponses: [{ plan }],
    // The 7B-model behaviour from the real run: prose every time, different words, same missing file.
    attempts: [[{ text: 'I generated the design document.' }, [finish('generated docs/design.md')]], [{ text: 'The document is now saved at docs/design.md.' }, [finish('saved docs/design.md')]]],
    maxAttempts: 5,
  });
  runInvariants(r.run, r.store);
  const t = taskOf(r);
  assert.equal(attemptsOf(r).length, 2, 'stopped after 2 of 5 attempts: narration is not progress');
  assert.equal(t.status, 'escalated');
  assert.equal(t.failure.category, 'no_progress');
  assert.match(t.failure.reason, /same failure repeated 2 times/);
  assert.equal(attemptsOf(r)[0].fingerprint, attemptsOf(r)[1].fingerprint);
  assert.match(attemptsOf(r)[1].feedback, /same failure as the previous attempt/);
  assert.ok(t.attempts.every((a) => a.verification.some((v) => !v.ok && v.output)), 'failure evidence preserved for every attempt');
  assert.equal(r.run.metrics.tasks.failed[0].category, 'no_progress');
});

test('different failures are different progress: the budget is spent only while the failure repeats', async () => {
  const plan = { tasks: [{ id: 't', verify: ['test -s a.txt', 'test -s b.txt', 'test -s c.txt'] }], finalVerify: ['npm test'] };
  const r = await runReplay({
    idea: 'steady progress', planResponses: [{ plan }],
    attempts: [[[w('a.txt', 'a')], [finish('a')]], [[w('b.txt', 'b')], [finish('b')]], [[w('c.txt', 'c')], [finish('c')]]],
    maxAttempts: 4,
  });
  assert.equal(r.run.status, 'completed');
  assert.equal(attemptsOf(r).length, 3);
});

test('provider errors are classified: ones retrying cannot fix say so, transient ones are marked transient', async () => {
  const plan = { tasks: [{ id: 't', outputs: ['o.md'] }], finalVerify: ['npm test'] };
  const auth = await runReplay({ idea: 'bad key', planResponses: [{ plan }], attempts: [[{ fail: 'provider: authentication failed (HTTP 401)' }]], maxAttempts: 4 });
  assert.equal(attemptsOf(auth).length, 1);
  assert.equal(taskOf(auth).failure.kind, 'authentication');
  assert.match(taskOf(auth).failure.reason, /retrying cannot help/);

  // A provider exception is classified; the HTTP layer already retried transient errors, so the task stops and says so.
  const flaky = await runReplay({ idea: 'flaky server', planResponses: [{ plan }], attempts: [[{ fail: 'connection refused ECONNREFUSED' }]], maxAttempts: 3 });
  assert.equal(attemptsOf(flaky).length, 1);
  assert.deepEqual([taskOf(flaky).failure.category, taskOf(flaky).failure.kind, attemptsOf(flaky)[0].failure.transient], ['execution', 'connection', true]);
  assert.equal(taskOf(flaky).status, 'escalated');
});

test('context overflow is an explicit, immediate outcome, not a silent truncation', async () => {
  const plan = { tasks: [{ id: 't', outputs: ['o.md'] }], finalVerify: ['npm test'] };
  const r = await runReplay({ idea: 'does not fit', planResponses: [{ plan }], attempts: [[[w('o.md', 'x')]]], maxAttempts: 3 }, {
    beforeStart: ({ env }) => {
      // The scripted model advertises a tiny 512-token window, as a small Ollama num_ctx would.
      const p = env.cfg.providerFactory();
      p.contextLimit = () => 512;
      p.maxTokens = 128;
    },
  });
  assert.equal(attemptsOf(r).length, 1, 'retrying a request that cannot fit would fail identically');
  assert.equal(taskOf(r).failure.kind, 'context_overflow');
  assert.match(taskOf(r).failure.reason, /context window/);
  assert.equal(r.provider.requests.filter((q) => q.kind === 'task').length, 0, 'no model call was made with a prompt that would be cut');
});

test('a tool call id is executed once; an identical rewrite is reported, not repeated', async () => {
  const count = { type: 'tool_use', id: 'call-fixed', name: 'run_command', input: { command: 'echo x >> count.txt' } };
  const r = await runReplay({
    idea: 'duplicates', planResponses: [{ plan: { tasks: [{ id: 't', outputs: ['o.md'] }], finalVerify: ['npm test'] } }],
    attempts: [[[count], [count], [w('o.md', '# o\n\ncontent here\n')], [w('o.md', '# o\n\ncontent here\n')], [finish('done', ['o.md'])]]],
    maxTurns: 8,
  });
  const ws = r.store.workspaceDir(r.id);
  assert.equal(fs.readFileSync(path.join(ws, 'count.txt'), 'utf8'), 'x\n', 'the command ran exactly once');
  assert.deepEqual(r.tools.map((e) => e.status).slice(0, 4), ['executed', 'duplicate', 'executed', 'duplicate']);
  assert.equal(attemptsOf(r)[0].tools.duplicates, 2);
});

test('a model that only narrates is cut off, with the failure recorded as execution (no tool calls)', async () => {
  const r = await runReplay({
    idea: 'narrator', planResponses: [{ plan: { tasks: [{ id: 't', outputs: ['o.md'] }], finalVerify: ['npm test'] } }],
    attempts: [Array.from({ length: 10 }, () => ({ text: 'Here is what the file would contain…' }))], maxAttempts: 1, maxTurns: 10,
  });
  const a = attemptsOf(r)[0];
  assert.equal(a.failure.kind, 'no_tool_calls');
  assert.equal(r.provider.requests.filter((q) => q.kind === 'task').length, 4, 'four prose replies, not all ten turns');
  assert.match(r.provider.requests.filter((q) => q.kind === 'task')[1].messages.at(-1).content, /nothing happened/);
});

// ── scheduling and inference ──────────────────────────────────────────────────────────────────────

import { ReplayProvider } from './replay-helpers.js';
class SlowProvider extends ReplayProvider {
  constructor(fixture, ms = 25) {
    super(fixture);
    this.local = true;
    this.inFlight = 0;
    this.peak = 0;
    this.ms = ms;
  }

  async chat(req) {
    if (req.meta?.kind !== 'task') return super.chat(req);
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      await new Promise((r) => setTimeout(r, this.ms));
      return await super.chat(req);
    } finally {
      this.inFlight -= 1;
    }
  }
}

async function runSlow(maxLocal, { signalAfter } = {}) {
  const { makeRepo, makeRoot, dirId, setup, NODE_FILES } = await import('./project-helpers.js');
  const origin = makeRepo(NODE_FILES);
  const { cfg: rootCfg } = makeRoot({ app: (d) => fs.cpSync(origin, d, { recursive: true }) });
  const own = (id) => [[[w(`${id}.md`, `${id} content here`)], [finish(`done ${id}`, [`${id}.md`])]]];
  const provider = new SlowProvider({
    planResponses: [{ plan: { tasks: [{ id: 'a', outputs: ['a.md'] }, { id: 'b', outputs: ['b.md'] }, { id: 'c', outputs: ['c.md'] }], finalVerify: ['npm test'] } }],
    taskAttempts: { a: own('a'), b: own('b'), c: own('c') },
  });
  const env = setup({ provider, cfg: { ...rootCfg, defaults: { maxLocalInference: maxLocal } } });
  const run = await env.factory.createRun({ idea: 'three independent tasks', provider: 'offline', source: { mode: 'local', directoryId: dirId(env.cfg, 'app') }, settings: { deploy: false, maxParallel: 3 } });
  const done = env.factory.start(run.id);
  if (signalAfter) {
    await new Promise((r) => setTimeout(r, signalAfter));
    await env.factory.cancel(run.id);
  }
  await done;
  return { provider, env, run: await env.store.load(run.id), limiter: [...env.factory.limiters.values()][0] };
}

test('local inference concurrency obeys its limit while independent tasks stay scheduled in parallel', async () => {
  const one = await runSlow(1);
  assert.equal(one.run.plan.tasks.every((t) => t.status === 'completed'), true, JSON.stringify(one.run.plan.tasks.map((t) => [t.id, t.status, t.error])));
  assert.equal(one.provider.peak, 1, 'never more than one generation at a time');
  assert.equal(one.limiter.snapshot().peakActive, 1);
  assert.ok(one.limiter.snapshot().peakQueued >= 1, 'the other tasks were waiting for a slot, not failing');
  const two = await runSlow(2);
  assert.equal(two.provider.peak, 2);
  assert.equal(two.run.plan.tasks.every((t) => t.status === 'completed'), true);
  assert.equal(two.run.metrics.inference.limiters[0].max, 2);
});

test('cancelling a run leaves no queued generation and no request in flight', async () => {
  const r = await runSlow(1, { signalAfter: 30 });
  assert.equal(r.run.status, 'cancelled');
  const s = r.limiter.snapshot();
  assert.deepEqual([s.active, s.queued], [0, 0]);
  assert.equal(r.provider.inFlight, 0);
});

test('InferenceLimiter: FIFO slots, abort leaves the queue, release is idempotent', async () => {
  const l = new InferenceLimiter(1);
  const a = await l.acquire();
  const ac = new AbortController();
  const waiting = l.acquire(ac.signal);
  const second = l.acquire();
  assert.equal(l.snapshot().queued, 2);
  ac.abort();
  await assert.rejects(waiting, /cancelled/);
  assert.equal(l.snapshot().queued, 1, 'the aborted waiter left the queue');
  a.release();
  a.release();
  const b = await second;
  assert.equal(l.snapshot().active, 1);
  b.release();
  assert.equal(l.snapshot().active, 0);
  await assert.rejects(l.acquire(AbortSignal.abort()), /cancelled/);
});

test('fitContext trims old tool results first and never the brief or the newest turn; an impossible fit is an explicit overflow', () => {
  const big = 'x'.repeat(6000);
  const messages = [
    { role: 'user', content: 'BRIEF acceptance criteria and verification commands' },
    { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'read_file', input: { path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: big }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: '2', name: 'write_file', input: { path: 'f', content: big } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '2', content: big }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: '3', name: 'read_file', input: { path: 'b' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '3', content: 'NEWEST ' + big.slice(0, 1000) }] },
  ];
  const fit = fitContext({ system: 'sys', messages, tools: [], budgetTokens: 1800 });
  assert.ok(fit.trimmed >= 2);
  assert.equal(fit.messages[0].content, messages[0].content);
  assert.match(fit.messages.at(-1).content[0].content, /^NEWEST/);
  assert.match(fit.messages[2].content[0].content, /trimmed to fit the context window/);
  assert.ok(fit.tokens <= 1800);
  assert.throws(() => fitContext({ system: 'sys', messages, tools: [], budgetTokens: 100 }), ContextOverflowError);
  assert.equal(outputReserve(8192, 8192), 2048);
  assert.equal(outputReserve(32768, 8192), 8192);
  assert.equal(outputReserve(16384, 8192), 4096);
});

test('Ollama requests carry the intended settings: context, reply cap, keep-alive, seed, and separate load/generation timings', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b);
      seen.push(body);
      res.setHeader('content-type', 'application/json');
      if (body.messages.some((m) => m.content === 'TOO BIG')) return res.writeHead(400).end(JSON.stringify({ error: 'the prompt is too long for the context length' }));
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'hi' }, done: true, done_reason: 'stop', prompt_eval_count: 50, eval_count: 10, load_duration: 2_000_000_000, prompt_eval_duration: 100_000_000, eval_duration: 500_000_000, total_duration: 2_700_000_000 }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const p = new OpenAICompatProvider({ id: 'ollama', baseUrl: `http://127.0.0.1:${srv.address().port}`, model: 'qwen2.5-coder:7b', dialect: 'ollama', numCtx: 8192, temperature: 0, seed: 7, topP: 0.9, keepAlive: '30m', maxTokens: 8192 });
    const res = await p.chat({ system: 's', messages: [{ role: 'user', content: 'hello' }], tools: [] });
    assert.deepEqual(seen[0].options, { num_predict: 2048, num_ctx: 8192, temperature: 0, seed: 7, top_p: 0.9 });
    assert.equal(seen[0].keep_alive, '30m');
    assert.deepEqual(res.timings, { loadMs: 2000, promptEvalMs: 100, evalMs: 500, serverTotalMs: 2700, contextLimit: 8192 });
    assert.deepEqual(p.effectiveOptions(), { dialect: 'ollama', numCtx: 8192, numPredict: 2048, temperature: 0, seed: 7, topP: 0.9, keepAlive: '30m', timeoutMs: p.timeoutMs, retries: 2 });
    const unset = new OpenAICompatProvider({ id: 'ollama', baseUrl: `http://127.0.0.1:${srv.address().port}`, model: 'm', dialect: 'ollama', numCtx: 32768 });
    await unset.chat({ system: 's', messages: [{ role: 'user', content: 'hello' }], tools: [] });
    assert.equal('keep_alive' in seen[1], false, 'nothing is forced when keep-alive is not configured');
    await assert.rejects(p.chat({ system: 's', messages: [{ role: 'user', content: 'TOO BIG' }], tools: [] }), (e) => e.kind === 'context_overflow');
  } finally {
    srv.close();
  }
});

// ── dependencies and evidence ─────────────────────────────────────────────────────────────────────

test('dependencies consume verified outputs, and a task whose prerequisite failed never starts', async () => {
  const plan = { tasks: [{ id: 'a', outputs: ['a.md'] }, { id: 'b', outputs: ['b.md'], dependsOn: ['a'] }], finalVerify: ['npm test'] };
  const bad = await runReplay({
    idea: 'chain broken', planResponses: [{ plan }],
    // "a" never creates a.md (it only says it did), so "b" must never start.
    taskAttempts: { a: [[{ text: 'a.md is done' }, [finish('A is perfect and complete')]]], b: [[[w('b.md', '# b\n\nmore\n')], [finish('b', ['b.md'])]]] },
    maxAttempts: 2,
  });
  assert.equal(taskOf(bad, 'a').status, 'escalated');
  assert.equal(taskOf(bad, 'b').status, 'blocked');
  assert.equal(taskOf(bad, 'b').attempts.length, 0, 'the dependent never ran on an unverified prerequisite');
  assert.equal(taskOf(bad, 'b').blockedBy, 'a');

  const good = await runReplay({
    idea: 'chain ok', planResponses: [{ plan }],
    taskAttempts: { a: [[[w('a.md', '# a\n\nreal content\n')], [finish('A is perfect and complete', ['a.md'])]]], b: [[[w('b.md', '# b\n\nmore\n')], [finish('b', ['b.md'])]]] },
  });
  assert.equal(taskOf(good, 'a').status, 'completed');
  const bBrief = good.provider.requests.find((q) => q.kind === 'task' && /Task b/.test(q.messages[0].content)).messages[0].content;
  assert.match(bBrief, /Verified upstream outputs.*checked on disk/s);
  assert.match(bBrief, /a \(engineer\): a\.md/);
  const events = good.events.filter((e) => e.type === 'task').map((e) => `${e.taskId}:${e.status}`);
  assert.ok(events.indexOf('a:completed') < events.indexOf('b:running'), 'b started only after a was verified');
});

test('run evidence separates agent claims from verified results and carries per-task and run-level metrics', async () => {
  const plan = { tasks: [{ id: 't', outputs: ['o.md'], verify: ['grep -q ok o.md'] }], finalVerify: ['npm test'] };
  const r = await runReplay({
    idea: 'metrics', planResponses: [{ plan }],
    attempts: [[[w('o.md', 'nothing yet\n')], [finish('all good', ['o.md'])]], [[w('o.md', 'ok done\n')], [finish('fixed', ['o.md'])]]],
    maxAttempts: 3,
  });
  const m = r.run.metrics;
  assert.equal(m.schema, 'da-prompt.run-metrics/1');
  assert.equal(m.tasks.completed, 1);
  assert.equal(m.tasks.retries, 1);
  assert.ok(m.planningMs >= 0 && m.wallClockMs >= 0);
  assert.deepEqual([m.artifacts.checked >= 1, m.artifacts.invalid], [true, 0]);
  assert.equal(m.tools.invoked, 4);
  assert.equal(m.model.model, 'offline-template-agent');
  assert.equal(m.inference.calls > 0, true);
  assert.ok(r.events.some((e) => e.type === 'capabilities'));
  const t = r.evidence.factory.tasks[0];
  assert.equal(t.checks.every((c) => c.ok), true);
  const tool = r.events.find((e) => e.type === 'verify' && e.results.some((x) => !x.ok));
  assert.equal(tool.results.find((x) => !x.ok).criterion, 'command exits 0: grep -q ok o.md');
});

test('failure fingerprints ignore numbers, durations and temp paths but not the failing criterion', () => {
  const a = { failure: { category: 'acceptance' }, verification: [{ ok: false, criterion: 'c1', exitCode: 1, output: 'expected 5 got 3 in 120ms at /tmp/x1/f.js' }] };
  const b = { failure: { category: 'acceptance' }, verification: [{ ok: false, criterion: 'c1', exitCode: 1, output: 'expected 9 got 2 in 340ms at /var/folders/zz/y/f.js' }] };
  const c = { failure: { category: 'acceptance' }, verification: [{ ok: false, criterion: 'c2', exitCode: 1, output: 'expected 5 got 3 in 120ms' }] };
  assert.equal(failureFingerprint(a), failureFingerprint(b));
  assert.notEqual(failureFingerprint(a), failureFingerprint(c));
  assert.equal(normalizeFailureText('took 12ms, id deadbeef01'), 'took <t>, id <id>');
  const fb = buildFeedback({ attemptNo: 1, maxAttempts: 3, failed: [{ criterion: 'output x.png', command: 'artifact x.png', check: 'artifact', exitCode: 1, output: 'x.png does not exist' }], tools: { invoked: 2, executed: 0, failed: 1, writes: 0 } });
  assert.match(fb, /Failed criterion: output x\.png/);
  assert.match(fb, /no file was written/);
});

// ── benchmark ─────────────────────────────────────────────────────────────────────────────────────

test('the reliability benchmark scenarios run through the real harness with reference solutions (mock: measures nothing about a model)', async () => {
  const { loadTasks, runBenchmark } = await import('../src/bench.js');
  const dir = new URL('../bench/reliability/', import.meta.url).pathname;
  const tasks = loadTasks(dir);
  assert.deepEqual(tasks.map((t) => t.id), ['r1-write-file-and-test', 'r2-design-artifact', 'r3-recover-after-failure', 'r4-multi-agent-shared']);
  assert.ok(tasks.find((t) => t.id === 'r2-design-artifact').acceptance.some((a) => a.liveOnly), 'the screenshot check needs a real renderer, so it is live-only');
  const report = await runBenchmark({ tasks, mode: 'mock', settings: { maxParallel: 1 } });
  assert.deepEqual(report.results.map((r) => [r.taskId, r.status]), tasks.map((t) => [t.id, 'passed']));
  assert.equal(report.summary.falseSuccesses, 0);
  assert.equal(report.summary.verificationAccuracy, 1);
  assert.equal(report.results[0].falseSuccess, false);
  assert.ok(report.results[0].metrics.tools.invoked > 0);
});

test('bench-report restates two reports side by side and counts a "completed" run that fails acceptance as a false success', async () => {
  const { figures, table } = await import('../scripts/bench-report.mjs');
  const mk = (runStatus, ok, status, extra = {}) => ({ taskId: 't', status, runStatus, wallMs: 1000, calls: { count: 4, durationMs: { median: 50 } }, toolCalls: 3, retries: { taskAttempts: 1 }, acceptance: { ok }, ...extra });
  const before = { configId: 'a', mode: 'live', results: [mk('completed', false, 'failed')] };
  const after = { configId: 'b', mode: 'live', results: [mk('needs_attention', false, 'failed', { metrics: { inference: { limiters: [{ peakActive: 1 }], queuedMs: 120, modelLoadMs: 0, tokensPerSecond: 70 } } })] };
  assert.equal(figures(before).total.falseSuccesses, 1);
  assert.equal(figures(after).total.falseSuccesses, 0);
  assert.equal(figures(before).total.verificationAccuracy, 0);
  assert.equal(figures(after).total.verificationAccuracy, 1);
  const text = table(before, after);
  assert.match(text, /False successes.*1 → 0/);
  assert.match(text, /peak simultaneous generations 1/);
});
