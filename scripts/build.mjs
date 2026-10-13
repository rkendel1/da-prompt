#!/usr/bin/env node
// "Production build" for a zero-dependency package: there is nothing to compile, so the build proves the package is
// complete and runnable: static checks, the exact file list npm would publish, the CLI entry point, and that every
// module imports. No network, no backend, no LLM.
//   node scripts/build.mjs [--json] [--out <dir>]     exit 0 ok · 1 failed
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const outIdx = argv.indexOf('--out');
const outDir = outIdx >= 0 ? path.resolve(argv[outIdx + 1] || '') : null;
const steps = [];
const step = (name, ok, detail) => steps.push({ name, ok, detail });
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
const cleanEnv = { ...process.env, DA_PROMPT_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'da-prompt-build-')), FACTORY_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'da-prompt-build-data-')) };

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const chk = run(process.execPath, ['scripts/check.mjs', '--json']);
let chkRes = null;
try { chkRes = JSON.parse(chk.stdout); } catch { /* reported below */ }
step('static checks', chk.status === 0, chkRes ? `${chkRes.checked} files, ${chkRes.problems.length} problem(s)` : (chk.stderr || '').slice(0, 200));

const pack = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']);
let files = [];
try { files = JSON.parse(pack.stdout)[0].files.map((f) => f.path); } catch { /* reported below */ }
step('package contents', pack.status === 0 && files.length > 0, pack.status === 0 ? `${files.length} files would be published` : (pack.stderr || 'npm pack failed').slice(0, 200));
const required = ['package.json', 'src/cli.js', 'src/cli/index.js', 'src/server.js', 'src/factory.js', 'public/index.html', 'templates/offline-app/package.json.tpl', 'src/terminal-pty.py', 'public/vendor/xterm/xterm.js', 'public/vendor/xterm/LICENSE', 'README.md', 'LICENSE'];
const absent = required.filter((f) => !files.includes(f));
step('required files present in package', files.length > 0 && absent.length === 0, absent.length ? `missing from the package: ${absent.join(', ')}` : `${required.length} required files included`);

const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['da-prompt'];
const binSrc = binRel ? fs.readFileSync(path.join(root, binRel), 'utf8') : '';
step('bin entry', Boolean(binRel) && binSrc.startsWith('#!/usr/bin/env node'), binRel ? `${binRel} ${binSrc.startsWith('#!/usr/bin/env node') ? 'has a node shebang' : 'is missing the node shebang'}` : 'package.json has no bin.da-prompt');

const help = run(process.execPath, [binRel || 'src/cli.js', '--help'], { env: cleanEnv, timeout: 20_000 });
step('cli --help', help.status === 0 && /Usage: da-prompt/.test(help.stdout), help.status === 0 ? 'prints usage, exit 0' : `exit ${help.status}: ${(help.stderr || '').slice(0, 160)}`);
const ver = run(process.execPath, [binRel || 'src/cli.js', '--version'], { env: cleanEnv, timeout: 20_000 });
step('cli --version', ver.status === 0 && ver.stdout.trim() === `da-prompt ${pkg.version}`, ver.stdout.trim() || ver.stderr.slice(0, 120));

const py = run('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read()); import pty, termios, fcntl, select'].concat(['src/terminal-pty.py']));
step('terminal PTY helper', py.status === 0, py.error?.code === 'ENOENT' ? 'python3 not found: the embedded terminal will report it needs Python 3 (build otherwise unaffected)' : py.status === 0 ? 'parses; pty module available' : (py.stderr || '').split('\n').filter(Boolean).pop());

const failedImports = [];
for (const f of files.filter((p) => /^src\/.*\.js$/.test(p) && p !== 'src/server.js' && p !== 'src/cli.js' && p !== 'src/cli/legacy.js')) {
  const r = run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(root, f)).href)})`], { env: cleanEnv, timeout: 20_000 });
  if (r.status !== 0) failedImports.push(`${f}: ${(r.stderr || '').split('\n').find((l) => /Error/.test(l)) || 'import failed'}`);
}
step('modules import cleanly', failedImports.length === 0, failedImports.length ? failedImports.join('; ') : 'every src module loads');

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const r = run('npm', ['pack', '--pack-destination', outDir, '--ignore-scripts', '--json']);
  step('write package tarball', r.status === 0, r.status === 0 ? JSON.parse(r.stdout)[0].filename : (r.stderr || '').slice(0, 200));
}
fs.rmSync(cleanEnv.DA_PROMPT_CONFIG_DIR, { recursive: true, force: true });
fs.rmSync(cleanEnv.FACTORY_DATA_DIR, { recursive: true, force: true });

const ok = steps.every((s) => s.ok || (s.name === 'terminal PTY helper' && /not found/.test(s.detail)));
if (json) console.log(JSON.stringify({ ok, name: pkg.name, version: pkg.version, steps }, null, 2));
else {
  for (const s of steps) console.log(`${s.ok ? '✓' : '✗'} ${s.name} — ${s.detail}`);
  console.log(ok ? `build: ok (${pkg.name}@${pkg.version})` : 'build: FAILED');
}
process.exit(ok ? 0 : 1);
