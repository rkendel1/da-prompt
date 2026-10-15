// The built-in agent loop with the reply shapes small local models really send (seen with qwen2.5-coder:7b): files written as
// code blocks under their path instead of write_file calls, and "now I'll call complete_task" narration that never calls it.
// Scripted replies drive the real runAgent and a real Workspace; only the model is fake.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers.js';
import { blockNetwork } from './offline-guard.js';
import { Workspace } from '../src/sandbox.js';
import { runAgent, filesFromReply } from '../src/agents.js';

blockNetwork();

const text = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: {} });
const tool = (name, input) => ({ content: [{ type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2)}`, name, input }], stop_reason: 'tool_use', usage: {} });

function agent(replies, task = {}) {
  const dir = tmpDir();
  const ws = new Workspace(dir);
  const seen = [];
  const events = [];
  const provider = {
    describe: () => ({ name: 'fake', model: 'fake' }),
    async chat(req) {
      seen.push(structuredClone(req.messages));
      return replies.shift() || text('Now I will call complete_task.\n```bash\n\n```');
    },
  };
  const run = { inputs: { idea: 'x', requirements: '', stack: '', limits: '', tools: '' }, settings: {}, plan: { product: { name: 'X', summary: 'x' } } };
  const t = { id: 't', role: 'design', title: 'UI', description: 'Build the UI', acceptance: ['works'], verify: ['test -s public/index.html'], outputs: [], dependsOn: [], ...task };
  const promise = runAgent({ provider, ws, run, task: t, attempt: 1, maxAttempts: 3, feedback: null, upstream: [], lessons: '', settings: { maxAgentTurns: 40, commandTimeoutMs: 10_000 }, emit: (type, data) => events.push({ type, ...data }) });
  return { dir, seen, events, promise };
}

test('a file written as a code block under its path is saved through write_file, and the model is told so', async () => {
  const a = agent([
    text('Here is the page.\n\n### public/index.html\n```html\n<!doctype html>\n<title>Books</title>\n```\n\nAnd to test:\n```bash\nnpm test\n```'),
    tool('complete_task', { summary: 'Built the page', files: ['public/index.html'] }),
  ]);
  const out = await a.promise;
  assert.equal(out.ok, true);
  assert.equal(fs.readFileSync(path.join(a.dir, 'public/index.html'), 'utf8'), '<!doctype html>\n<title>Books</title>\n');
  assert.deepEqual(out.result.files, ['public/index.html']);
  assert.ok(a.events.some((e) => e.type === 'tool' && e.tool === 'write_file' && e.input.path === 'public/index.html' && e.ok), 'recorded as an ordinary write_file');
  assert.ok(a.events.some((e) => e.type === 'log' && /instead of calling write_file/.test(e.text)));
  assert.ok(!fs.existsSync(path.join(a.dir, 'package.json')), 'the shell block was not executed or saved');
  // The model's next request shows the write as its own tool call with a result that says where it came from.
  const last = a.seen[1].at(-1).content[0];
  assert.equal(last.type, 'tool_result');
  assert.match(last.content, /saved from the code block in your reply/);
});

test('a model that narrates instead of calling tools: after doing work, its attempt goes to verification, marked as not formally completed', async () => {
  const a = agent([
    tool('write_file', { path: 'public/index.html', content: '<p>hi</p>\n' }),
    text('The file is written. Now I will call complete_task with the summary.\n```bash\n\n```'),
    text('Now I will call complete_task with the summary.\n```bash\n\n```'),
    text('Now I will call complete_task with the summary.\n```bash\n\n```'),
  ]);
  const out = await a.promise;
  assert.equal(out.ok, true);
  assert.equal(out.result.implicit, true);
  assert.match(out.result.summary, /Not formally completed/);
  assert.deepEqual(out.result.files, ['public/index.html']);
  assert.equal(a.seen.length, 4, 'three idle replies, not forty');
  assert.match(JSON.stringify(a.seen[3].at(-1)), /You described an action but did not call a tool/, 'the second idle reply gets the concrete nudge');
});

test('narration with no work done, or on a task with no checks, fails fast instead of being accepted', async () => {
  const none = agent([], {});
  const out = await none.promise;
  assert.equal(out.ok, false);
  assert.match(out.error, /6 times in a row without calling a tool/);
  assert.equal(none.seen.length, 6);

  const unchecked = agent([tool('write_file', { path: 'notes.md', content: 'x\n' })], { verify: [], outputs: [] });
  const out2 = await unchecked.promise;
  assert.equal(out2.ok, false, 'nothing could verify it, so the agent\'s silence is not a completion');
});

test('filesFromReply takes only path-headed code blocks, never commands, empty blocks or paths outside the project', () => {
  const t = [
    '**src/store.js**', '```javascript', 'export const s = 1;', '```',
    'File: `test/store.test.js`', '```js', 'import "node:test";', '```',
    '### setup', '```bash', 'npm install', '```',
    '### run.sh', '```bash', 'echo hi', '```',
    '### /etc/hosts', '```', 'x', '```',
    '### ../outside.js', '```js', 'x', '```',
    '### empty.js', '```js', '', '```',
    'See `README.md` for details:', '```js', 'console.log(1)', '```',
  ].join('\n');
  assert.deepEqual(filesFromReply(t).map((f) => f.path), ['src/store.js', 'test/store.test.js', 'run.sh']);
});
