// Deterministic stand-ins for the `pax` executable. They speak the documented interface (--version, --help,
// --json --dir <d> <command>, --dry-run, pax.execution-result.v1) so the adapter can be tested without PAX.
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers.js';

export const HELP = `PAX is a universal, read-only project-tooling boundary.

Usage: pax [OPTIONS] COMMAND [ARGS...]

Inspection:
  info, doctor, deps, scripts, workspaces, lock
  graph, reality, drift
  observe            bounded deterministic project-structure observation
Project operations (delegated to native tools):
  build, test, lint, typecheck
Execution (delegated to native tools):
  run, x, install, add, remove, exec, deploy

Options:
  --dir <path>       select the project root
  --tool <tool>      explicitly select the native tool
  --dry-run          preview a delegated command without executing it
  --json             emit machine-readable output for automation
  --live             allow runtime observations for reality/drift
  -h, --help         show this help
  -V, --version      show the package version
`;

const doc = (command, extra = {}) => ({ schemaVersion: '1', command, project: { root: '@DIR@', name: 'demo' }, manager: { name: 'npm', selectedBy: 'lockfile' }, result: { summary: 'Detected npm project demo' }, diagnostics: [{ level: 'ok', check: 'package.json', message: 'found' }, { level: 'warn', check: 'lockfile', message: 'none' }], ...extra });

/**
 * Create a fake pax. `mode` tweaks behaviour:
 *   version, help ('real'|'posix'|'other'), exit (map step→code), json (map step→string to print instead),
 *   sleep (map step→seconds), drift (0|1|2), test ('passed'|'failed'|'unsupported'|'other-schema'|'plain'), stderr
 */
export function fakePax({ version = '0.5.0', help = 'real', exits = {}, outputs = {}, sleeps = {}, drift = 0, test = 'passed', stderr = '', dir = tmpDir('da-prompt-fakepax-'), name = 'pax', mode = 0o755, versionOut } = {}) {
  const docs = {
    info: JSON.stringify(doc('info')),
    doctor: JSON.stringify(doc('doctor')),
    reality: JSON.stringify({ schema_version: '1', command: 'reality', declared: { observations: [{ subject: '.', status: 'present', evidence: ['package.json'] }] }, installed: { observations: [{ subject: '.', status: 'absent' }] } }),
    graph: JSON.stringify({ schema_version: '1', command: 'graph', nodes: [], edges: [] }),
    drift: JSON.stringify({ schema_version: '1', command: 'drift', status: drift === 0 ? 'match' : drift === 1 ? 'drift' : 'ambiguous', issues: drift === 1 ? [{ subject: '.', expected: 'installed dependencies', actual: 'node_modules/ absent' }] : [] }),
    'test-plan': JSON.stringify({ operation: 'test', tool: 'npm', command: ['npm', 'test'] }),
    test: test === 'plain' ? 'running tests...' : JSON.stringify({ schema: test === 'other-schema' ? 'pax.execution-result.v9' : 'pax.execution-result.v1', operation: 'test', status: test === 'other-schema' ? 'passed' : test, reason: test === 'passed' ? 'tests-passed' : test === 'failed' ? 'tests-failed' : 'interpretation-unsupported', tool: 'npm', exit_code: test === 'failed' ? 1 : 0 }),
  };
  const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const helpText = help === 'real' ? HELP : help === 'other' ? 'Some other tool\nUsage: thing [options]\n' : '';
  const versionLine = versionOut ?? (help === 'posix' ? '' : `pax ${version}`);
  const cases = Object.entries(docs).map(([id, body]) => {
    const key = id === 'test-plan' ? 'dry' : id;
    return `  ${id}) ${sleeps[id] ? `sleep ${sleeps[id]};` : ''} ${stderr ? `echo ${sh(stderr)} >&2;` : ''} printf '%s\\n' ${sh(outputs[id] ?? body)} | sed "s#@DIR@#$DIR#g"; exit ${exits[id] ?? (id === 'drift' ? drift : 0)} ;;`;
  });
  const script = `#!/bin/sh
case "$1" in
  --version|-V) ${help === 'posix' ? 'echo "pax: illegal option -- -" >&2; exit 2' : versionLine ? `echo ${sh(versionLine)}; exit 0` : 'exit 0'} ;;
  --help|-h) ${help === 'posix' ? 'echo "usage: pax [-cdnvKOz] [-f archive]" >&2; exit 2' : `printf '%s\\n' ${sh(helpText)}; exit 0`} ;;
esac
DRY=0; DIR=.; CMD=
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --json) ;;
    --dir) shift; DIR="$1" ;;
    *) CMD="$1" ;;
  esac
  shift
done
[ "$DRY" = 1 ] && [ "$CMD" = test ] && CMD=dry
case "$CMD" in
${cases.join('\n').replace('  test-plan)', '  dry)')}
  *) echo "unknown command" >&2; exit 2 ;;
esac
`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, script, { mode });
  fs.chmodSync(file, mode);
  return { file, dir };
}

/** Put a directory first on the backend process's PATH for the duration of `fn`. */
export async function withPath(dir, fn) {
  const saved = process.env.PATH;
  process.env.PATH = dir ? `${dir}${path.delimiter}${saved}` : saved;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}
