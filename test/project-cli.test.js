import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers.js';
import { makeRepo, makeRoot, git, writeFiles } from './project-helpers.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function cli(args, { roots = '', readOnlyRoots = '', env = {} } = {}) {
  const data = tmpDir('da-prompt-clidata-');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      FACTORY_DATA_DIR: data,
      FACTORY_OFFLINE_DELAY_MS: '0',
      FACTORY_PROJECT_ROOTS: roots,
      FACTORY_PROJECT_ROOTS_READONLY: readOnlyRoots,
      FACTORY_OUTPUT_ROOT: '',
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, data };
}

const project = () => makeRoot({ widgets: (d) => fs.cpSync(makeRepo(), d, { recursive: true }) });

test('--directory runs the factory against an authorized project and leaves the original alone', () => {
  const { root, dirs } = project();
  const head = git(dirs.widgets, 'rev-parse', 'HEAD');
  const r = cli(['Add password reset to this application', '--directory', dirs.widgets, '--provider', 'offline'], { roots: root });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Source local directory widgets · the original is never edited/);
  assert.match(r.out, /connect: done/);
  assert.match(r.out, /inspect: done — node · \d+ files · tests: npm test/);
  assert.match(r.out, /baseline ✓ npm test → passed/);
  assert.match(r.out, /Patch:\s+\S+changes\.patch  \(1 file\(s\) changed\)/);
  assert.match(r.out, /Checks:  verified · delivery ready for review/);
  assert.match(r.out, /Local run: nothing is pushed/);
  assert.equal(git(dirs.widgets, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dirs.widgets, 'status', '--porcelain'), '');
  const patch = fs.readdirSync(path.join(r.data, 'runs')).map((id) => path.join(r.data, 'runs', id, 'delivery', 'changes.patch'))[0];
  assert.match(fs.readFileSync(patch, 'utf8'), /password reset/i);
});

test('--directory outside the configured roots (or with none configured) is refused', () => {
  const { root, dirs } = project();
  const other = makeRepo();
  const outside = cli(['x', '--directory', other, '--provider', 'offline'], { roots: root });
  assert.equal(outside.code, 1);
  assert.match(outside.out, /not inside an authorized root/);
  const none = cli(['x', '--directory', dirs.widgets, '--provider', 'offline']);
  assert.equal(none.code, 1);
  assert.match(none.out, /FACTORY_PROJECT_ROOTS/);
  const trav = cli(['x', '--directory', `${dirs.widgets}/../../..`, '--provider', 'offline'], { roots: root });
  assert.equal(trav.code, 1);
  assert.match(trav.out, /not inside an authorized root/);
  assert.equal(fs.readdirSync(path.join(none.data, 'runs')).length, 0);
});

test('source flags are validated: one source at a time, github needs an https repo, modifiers need a source', () => {
  const { root, dirs } = project();
  assert.match(cli(['x', '--directory', dirs.widgets, '--repo', 'a/b'], { roots: root }).out, /Choose one source/);
  const badRepo = cli(['x', '--repo', 'http://github.com/a/b', '--provider', 'offline']);
  assert.equal(badRepo.code, 1);
  assert.match(badRepo.out, /only https/);
  for (const flag of [['--ref', 'main'], ['--publish'], ['--allow-install'], ['--working-mode', 'clone']]) {
    const r = cli(['x', ...flag, '--provider', 'offline']);
    assert.equal(r.code, 1, flag.join(' '));
    assert.match(r.out, /need --directory or --repo/);
  }
  const wm = cli(['x', '--directory', dirs.widgets, '--working-mode', 'worktree', '--provider', 'offline'], { roots: root });
  assert.equal(wm.code, 1);
  assert.match(wm.out, /workingMode must be one of clone, snapshot/);
});

test('--working-mode snapshot includes uncommitted work; --list-directories shows what is authorized', () => {
  const { root, dirs } = project();
  writeFiles(dirs.widgets, { 'wip.txt': 'half-done' });
  const list = cli(['--list-directories'], { roots: root });
  assert.equal(list.code, 0);
  assert.match(list.out, /[0-9a-f]{10}:widgets\s+widgets\s+git main · uncommitted changes/);
  assert.ok(!list.out.includes(root));
  const r = cli(['Add a note', '--directory', dirs.widgets, '--working-mode', 'snapshot', '--provider', 'offline'], { roots: root });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /includes the source's uncommitted changes as the baseline|snapshot/);
  assert.equal(fs.readFileSync(path.join(dirs.widgets, 'wip.txt'), 'utf8'), 'half-done');
  assert.equal(cli(['--list-directories']).out.includes('No project roots configured'), true);
});

test('--output with a project source exports the full result to a NEW folder; it never lands in the source, and FACTORY_OUTPUT_ROOT still confines it', () => {
  const { root, dirs } = project();
  const out = path.join(tmpDir('da-prompt-out-'), 'result');
  const ok = cli(['Add a note', '--directory', dirs.widgets, '--output', out, '--provider', 'offline'], { roots: root });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /delivered to /);
  for (const f of ['package.json', 'src/greet.js', 'docs/da-prompt-change-request.md']) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.ok(!fs.existsSync(path.join(out, '.git')) && !fs.existsSync(path.join(out, 'node_modules')));
  assert.ok(!fs.existsSync(path.join(dirs.widgets, 'docs')));

  const inside = cli(['x', '--directory', dirs.widgets, '--output', path.join(dirs.widgets, 'out'), '--provider', 'offline'], { roots: root });
  assert.equal(inside.code, 1);
  assert.match(inside.out, /outputDir must be outside the source project/);
  const rootOut = tmpDir('da-prompt-outroot-');
  const confined = cli(['x', '--directory', dirs.widgets, '--output', '../escape', '--provider', 'offline'], { roots: root, env: { FACTORY_OUTPUT_ROOT: rootOut } });
  assert.equal(confined.code, 1);
  assert.match(confined.out, /outputDir must be inside/);
  const rel = cli(['x', '--directory', dirs.widgets, '--output', 'mine', '--provider', 'offline'], { roots: root, env: { FACTORY_OUTPUT_ROOT: rootOut } });
  assert.equal(rel.code, 0, rel.out);
  assert.ok(fs.existsSync(path.join(rootOut, 'mine', 'package.json')));
});

test('existing CLI behaviour is unchanged: a plain idea still builds a new app', () => {
  const r = cli(['A packing checklist for trips', '--provider', 'offline', '--no-deploy']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Archive: .*project\.tar\.gz/);
  assert.doesNotMatch(r.out, /Source |Patch:/);
  const help = cli(['--help']);
  assert.equal(help.code, 0);
  for (const flag of ['--output', '--directory', '--repo', '--ref', '--working-mode', '--publish', '--allow-install', '--deploy']) assert.ok(help.out.includes(flag), flag);
});
