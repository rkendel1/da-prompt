// Compute execution: commands are launched through the configured Compute exec template. A fake `compute` script stands
// in for the real CLI (it records its arguments, then runs the inner argv), so this runs offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Workspace } from '../src/sandbox.js';
import { computeLauncher, computeConfig } from '../src/compute.js';
import { tmpDir } from './helpers.js';

function fakeCompute(dir) {
  const bin = path.join(dir, 'fake-compute');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args.txt"\nenv_name="$1"; shift; shift\nexec "$@"\n`, { mode: 0o755 });
  return bin;
}

test('computeConfig reads the environment; off by default', () => {
  assert.equal(computeConfig({}).enabled, false);
  const c = computeConfig({ FACTORY_COMPUTE: '1', FACTORY_COMPUTE_ENV: 'ws', FACTORY_COMPUTE_EXEC: '["compute","exec","{environment}","--","{inner}"]' });
  assert.deepEqual([c.enabled, c.environment, c.exec.length], [true, 'ws', 5]);
  assert.equal(computeConfig({ FACTORY_COMPUTE_EXEC: 'not json' }).exec, null);
});

test('enabled without a usable template is a clear error; disabled gives no launcher', () => {
  assert.equal(computeLauncher({ compute: { enabled: false } }), null);
  assert.throws(() => computeLauncher({ compute: { enabled: true, exec: null } }), /FACTORY_COMPUTE_EXEC/);
  assert.throws(() => computeLauncher({ compute: { enabled: true, exec: ['compute', 'exec'] } }), /\{inner\}/);
});

test('Workspace runs commands through the Compute launcher, keeping deny list and scrubbed env', async () => {
  const dir = tmpDir();
  const bin = fakeCompute(dir);
  const cfg = { compute: { enabled: true, environment: 'workstation', exec: [bin, '{environment}', '--', '{inner}'] } };
  const ws = new Workspace(path.join(dir, 'ws'), { launcher: computeLauncher(cfg) });
  process.env.SOME_SECRET_TOKEN = 'sentinel-should-not-leak';
  try {
    const r = await ws.runCommand('echo hello-$CI && pwd && env');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /hello-1/);
    assert.ok(r.stdout.includes(ws.root));
    assert.ok(!r.stdout.includes('sentinel-should-not-leak'));
    assert.match(fs.readFileSync(path.join(dir, 'args.txt'), 'utf8'), /^workstation -- env -i /);
    const denied = await ws.runCommand('sudo ls');
    assert.equal(denied.exitCode, 126);
  } finally {
    delete process.env.SOME_SECRET_TOKEN;
  }
});
