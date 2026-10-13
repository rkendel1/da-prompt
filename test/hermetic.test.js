import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './cli-helpers.js';
import { tmpDir } from './helpers.js';

test('npm test is hermetic: variables a developer (or a da-prompt backend) has exported cannot change a test result', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /--require \.\/test\/setup-env\.cjs/);
  const env = { ...process.env, FACTORY_DATA_DIR: tmpDir(), DA_PROMPT_CONFIG_DIR: tmpDir(), PORT: '39987', HOST: '127.0.0.1', FACTORY_PROVIDER: 'ollama', ANTHROPIC_API_KEY: 'sk-ant-test-leak-aaaaaaaaaaaaaaaaaaaa', GITHUB_TOKEN: 'ghp_leakleakleakleakleakleakleakleakleak' };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--require', './test/setup-env.cjs', '--test', '--test-concurrency=1', 'test/health.test.js', 'test/settings.test.js'], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-2000));
  assert.match(r.stdout, /# fail 0/);
});

test('npm test is also independent of a `pax` that happens to be on the developer\'s PATH (the real one, or /usr/bin/pax the POSIX archiver)', () => {
  const dir = tmpDir('da-prompt-leakpax-');
  fs.writeFileSync(path.join(dir, 'pax'), '#!/bin/sh\necho "pax: illegal option -- -" >&2\nexit 2\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  delete env.DA_PROMPT_PAX_BIN;
  const r = spawnSync(process.execPath, ['--require', './test/setup-env.cjs', '--test', '--test-concurrency=1', 'test/health.test.js'], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-2000));
});
