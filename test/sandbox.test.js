import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Workspace } from '../src/sandbox.js';
import { scanWorkspace, redact } from '../src/security.js';
import { tmpDir } from './helpers.js';

test('workspace confines paths to its root', async () => {
  const ws = new Workspace(tmpDir());
  await ws.writeFile('src/a.js', 'x');
  assert.equal(await ws.readFile('src/a.js'), 'x');
  await assert.rejects(ws.writeFile('../escape.txt', 'no'), /escapes workspace/);
  await assert.rejects(ws.writeFile('/etc/passwd', 'no'), /absolute/);
  fs.symlinkSync('/tmp', path.join(ws.root, 'link'));
  await assert.rejects(ws.writeFile('link/evil.txt', 'no'), /escapes workspace/);
  assert.deepEqual((await ws.listFiles()).map((f) => f.path), ['src/a.js']);
});

test('commands run in the workspace with secrets scrubbed and a timeout', async () => {
  const ws = new Workspace(tmpDir());
  process.env.SOME_API_KEY = 'super-secret';
  const r = await ws.runCommand('pwd; echo "key=${SOME_API_KEY}"');
  delete process.env.SOME_API_KEY;
  assert.equal(r.exitCode, 0);
  assert.ok([ws.root, fs.realpathSync(ws.root)].includes(r.stdout.split('\n')[0]));
  assert.match(r.stdout, /key=$/m);
  const slow = await ws.runCommand('sleep 5', { timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.exitCode, 124);
  const blocked = await ws.runCommand('sudo rm -rf /');
  assert.equal(blocked.exitCode, 126);
});

test('security scan flags hardcoded credentials and redact masks them', async () => {
  const ws = new Workspace(tmpDir());
  await ws.writeFile('src/config.js', `export const key = "sk-ant-${'a'.repeat(30)}";\n`);
  await ws.writeFile('src/ok.js', 'export const port = process.env.PORT;\n');
  const r = await scanWorkspace(ws);
  assert.equal(r.ok, false);
  assert.equal(r.findings[0].file, 'src/config.js');
  assert.ok(!r.findings[0].excerpt.includes('aaaaaaaaaa'));
  assert.equal(redact(`token ghp_${'b'.repeat(30)}`), 'token ghp_***');
});
