// The CI contract, checked offline: the workflow must run the repository's own scripts, must not be able to hide a failing check,
// and the summary script must flag tests that disappeared. These read the workflow file and run the same shell pattern the workflow
// uses on a throwaway failing test; they do not need GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const summary = (log, ...args) => {
  const file = path.join(tmpDir(), 'test.log');
  fs.writeFileSync(file, log);
  return spawnSync(process.execPath, ['scripts/ci-summary.mjs', file, ...args], { cwd: ROOT, encoding: 'utf8' });
};

test('the workflow runs the repository\'s own scripts and can not mask a failure', () => {
  for (const cmd of ['npm ci', 'npm run check', 'npm run build', 'npm run test:contracts', 'npm test']) assert.ok(new RegExp(`run: ${cmd}( |$)`, 'm').test(wf), `a step runs "${cmd}"`);
  assert.ok(!/continue-on-error/i.test(wf), 'no step is allowed to fail quietly');
  assert.ok(!/\|\|\s*(true|:|exit 0)/.test(wf.replace(/2>\/dev\/null \|\| true/g, '')), 'no "|| true" on a validation step (only the best-effort log trim may have one)');
  assert.match(wf, /fail-fast: false/, 'one Node version failing must not cancel the other');
  assert.match(wf, /npm test 2>&1 \| tee/, 'the full suite output is kept');
  const step = wf.slice(wf.indexOf('[test] full suite'), wf.indexOf('[test] summary'));
  assert.match(step, /shell: bash/, 'an explicit bash shell turns pipefail on, so tee cannot turn a failing suite into a success');
  assert.ok(!/(secrets\.|API_KEY|TOKEN|PASSWORD)/.test(wf), 'no credential is referenced by the workflow');
  assert.match(wf, /permissions:\s*\n\s+contents: read/);
  assert.ok(pkg.engines.node === '>=20' && /node: \[20, 22\]/.test(wf), 'CI covers the lowest supported Node and a current one');
});

test('the scripts the workflow calls exist, and the contract script runs every offline suite it names', () => {
  for (const s of ['check', 'build', 'test', 'test:contracts']) assert.ok(pkg.scripts[s], s);
  for (const f of pkg.scripts['test:contracts'].match(/test\/[\w-]+\.test\.js/g)) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  for (const f of ['diagnostics', 'replay', 'provider-contract', 'architecture', 'security-contract', 'engines', 'bench']) assert.ok(pkg.scripts['test:contracts'].includes(`test/${f}.test.js`), `${f} is in test:contracts`);
  // The full suite is a glob, so a new test file is picked up automatically (nothing is listed twice by hand).
  assert.match(pkg.scripts.test, /test\/\*\.test\.js$/);
});

test('a failing required test fails the pipeline the way the workflow runs it, and the summary names it', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'broken.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('deliberately failing check', () => assert.equal(1, 2));\ntest('a passing one', () => assert.ok(true));\n");
  const log = path.join(dir, 'test.log');
  const env = { PATH: process.env.PATH };
  // The exact shape of the workflow step: bash with pipefail, output through tee.
  const piped = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', `node --test broken.test.js 2>&1 | tee "${log}"`], { cwd: dir, encoding: 'utf8', env });
  assert.notEqual(piped.status, 0, 'tee must not hide the failing exit status');
  // …and the same pipe WITHOUT pipefail would have hidden it, which is why the step sets the shell explicitly.
  const naive = spawnSync('bash', ['--noprofile', '--norc', '-c', `node --test broken.test.js 2>&1 | tee "${log}.naive"`], { cwd: dir, encoding: 'utf8', env });
  assert.equal(naive.status, 0, 'the hazard is real');
  const s = spawnSync(process.execPath, ['scripts/ci-summary.mjs', log], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(s.status, 0, 'the summary reports; the suite step is what fails the job');
  assert.match(s.stdout, /2 tests · 1 passed · 1 failed/);
  assert.match(s.stdout, /- deliberately failing check/);
});

test('the summary fails a job whose tests were skipped because the environment is missing something, and says why', () => {
  const tap = 'TAP version 13\nok 1 - ui works # SKIP Playwright is not installed\nok 2 - ui again # SKIP Playwright is not installed\nok 3 - other # SKIP no real PAX available\nok 4 - plain\n1..4\n# tests 4\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 3\n# todo 0\n';
  const lenient = summary(tap);
  assert.equal(lenient.status, 0);
  assert.match(lenient.stdout, /2 × Playwright is not installed/);
  assert.match(lenient.stdout, /1 × no real PAX available/);
  const strict = summary(tap, '--forbid-skip', 'Playwright is not installed');
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /Not acceptable on this runner:\*\* 2 test\(s\) skipped with "Playwright is not installed"/);
  assert.equal(summary(tap, '--forbid-skip', 'something never skipped').status, 0, 'only the named reasons are forbidden: an unrelated opt-in skip is allowed');
  const crashed = summary('TAP version 13\nnot ok 1 - boom\n');
  assert.match(crashed.stdout, /did not reach the end/);
  assert.match(crashed.stdout, /- boom/);
  assert.equal(spawnSync(process.execPath, ['scripts/ci-summary.mjs', path.join(tmpDir(), 'missing.log')], { cwd: ROOT, encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, ['scripts/ci-summary.mjs'], { cwd: ROOT, encoding: 'utf8' }).status, 2);
});
