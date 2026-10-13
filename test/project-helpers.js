// Fixtures for existing-project tests: temp git repositories, a mock GitHub (bare repos reached through
// url.insteadOf, plus a tiny REST server for pull requests) and a scripted agent provider.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers.js';
import { OfflineProvider } from '../src/providers/offline.js';
import { loadConfig } from '../src/config.js';
import { RunStore } from '../src/store.js';
import { Factory } from '../src/factory.js';
import { authorizedRoots } from '../src/project.js';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
export const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

export const NODE_FILES = {
  'package.json': JSON.stringify({ name: 'widgets', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2),
  'src/greet.js': "export const greet = (name) => `Hello, ${name}!`;\n",
  'test/greet.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greet.js';\ntest('greet', () => assert.equal(greet('Ada'), 'Hello, Ada!'));\n",
  'AGENTS.md': '# Agents\n\nUse two-space indentation. Run `npm test` before finishing.\n',
  'README.md': '# widgets\n',
  '.gitignore': 'node_modules/\n',
};

export const PY_FILES = {
  'calc.py': 'def add(a, b):\n    return a + b\n',
  'test_calc.py': 'import unittest\nfrom calc import add\n\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n\n\nif __name__ == "__main__":\n    unittest.main()\n',
  'README.md': '# calc\n',
};

/** A committed git repository in a fresh temp folder. */
export function makeRepo(files = NODE_FILES, { branch = 'main' } = {}) {
  const dir = fs.realpathSync(tmpDir('da-prompt-repo-'));
  git(dir, 'init', '-q', '-b', branch);
  writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

/** A projects root containing the given project folders; returns { root, dirs } and config for it. */
export function makeRoot(projects, { readOnly = false } = {}) {
  const root = fs.realpathSync(tmpDir('da-prompt-root-'));
  const dirs = {};
  for (const [name, fn] of Object.entries(projects)) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fn(dir);
    dirs[name] = dir;
  }
  return { root, dirs, cfg: readOnly ? { projectRootsReadOnly: [root] } : { projectRoots: [root] } };
}

export const dirId = (cfg, name) => {
  const r = authorizedRoots(cfg)[0];
  return `${r.key}:${name}`;
};

/** A bare "GitHub" repository reachable as https://github.com/<owner>/<repo>.git through insteadOf. */
export function makeRemote(files = NODE_FILES, { owner = 'acme', repo = 'widgets', branches = [] } = {}) {
  const base = fs.realpathSync(tmpDir('da-prompt-remote-'));
  const bare = path.join(base, owner, `${repo}.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const seed = makeRepo(files);
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-q', 'origin', 'main');
  for (const b of branches) {
    git(seed, 'checkout', '-q', '-b', b);
    writeFiles(seed, { [`${b}.txt`]: b });
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', b);
    git(seed, 'push', '-q', 'origin', b);
    git(seed, 'checkout', '-q', 'main');
  }
  return { base, bare, seed, url: `https://github.com/${owner}/${repo}.git`, insteadOf: [[`url.file://${base}/.insteadOf`, 'https://github.com/']] };
}

/** A minimal GitHub REST API: lists and creates pull requests. */
export async function startMockApi() {
  const prs = [];
  const calls = [];
  let failWith = null;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (failWith) return send(failWith.status, { message: failWith.message });
    const m = req.url.match(/^\/repos\/([^/]+)\/([^/?]+)\/pulls(\?.*)?$/);
    if (!m) return send(404, { message: 'Not Found' });
    if (req.method === 'GET') {
      const head = new URL(req.url, 'http://x').searchParams.get('head');
      return send(200, prs.filter((p) => `${m[1]}:${p.head.ref}` === head && p.state === 'open'));
    }
    if (req.method === 'POST') {
      const b = JSON.parse(body);
      const pr = { number: prs.length + 1, html_url: `https://github.com/${m[1]}/${m[2]}/pull/${prs.length + 1}`, state: 'open', draft: b.draft, head: { ref: b.head }, base: { ref: b.base }, title: b.title, body: b.body };
      prs.push(pr);
      return send(201, pr);
    }
    send(405, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    prs,
    calls,
    failWith: (v) => (failWith = v),
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))),
  };
}

let n = 0;
export const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_t_${++n}`, name, input });

/**
 * A scripted model: `plan(meta)` returns the plan; `task({ task, attempt, turn, messages, meta })` returns the
 * content blocks for one agent turn. Everything else (verification, feedback, retries) is the real factory.
 */
export class Scripted extends OfflineProvider {
  constructor({ plan, task }) {
    super({ faults: false, delayMs: 0 });
    this.planFn = plan;
    this.taskFn = task;
    this.seen = [];
  }

  async chat(req) {
    const { meta = {}, messages } = req;
    this.seen.push({ kind: meta.kind, system: req.system, messages });
    if (meta.kind === 'plan') {
      const content = [toolUse('submit_plan', this.planFn(meta, req))];
      return { content, stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50 } };
    }
    if (meta.kind === 'task') {
      const turn = messages.filter((m) => m.role === 'assistant').length;
      const content = this.taskFn({ task: meta.task, attempt: meta.attempt, turn, messages, meta });
      return { content, stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50 } };
    }
    return super.chat(req);
  }
}

export const task = (id, extra = {}) => ({ id, role: 'engineer', title: id, description: `do ${id}`, dependsOn: [], acceptance: ['works'], outputs: [], files: [], verify: [], ...extra });
export const plan = (tasks, extra = {}) => ({
  product: { name: 'Change', summary: 'A change to the project', users: ['maintainers'], successCriteria: ['it works'] },
  tasks,
  risks: [],
  openQuestions: [],
  finalVerify: ['npm test'],
  deploy: null,
  ...extra,
});
export const done = (summary = 'done', files = []) => toolUse('complete_task', { summary, files, commands: [], nextSteps: [] });

/** A factory wired to a temp data dir, with the given extra config and an optional injected provider. */
export function setup({ provider, cfg: extra = {}, previews } = {}) {
  const cfg = loadConfig({ dataDir: tmpDir(), providerFactory: provider ? () => provider : undefined, ...extra });
  const store = new RunStore(cfg.dataDir);
  const factory = new Factory({ cfg, store, previews: previews || { get: () => null, stop: () => {}, stopAll: () => {}, start: async () => ({ ok: false, error: 'previews disabled in test' }) } });
  return { cfg, store, factory };
}

export const finish = async (factory, run) => factory.start(run.id);

export const authorizedKey = (cfg) => authorizedRoots(cfg)[0].key;
