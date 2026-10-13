#!/usr/bin/env node
// da-prompt command line entry point.
//   da-prompt <command> ...        the terminal-first CLI (src/cli/): a client of the local backend
//   da-prompt "<idea>" [--flags]   the original in-process headless runner, kept for compatibility (src/cli/legacy.js)
const COMMAND_WORDS = new Set(['setup', 'doctor', 'status', 'config', 'providers', 'projects', 'run', 'runs', 'pax', 'server', 'help', 'version']);
const argv = process.argv.slice(2);
const first = argv[0];
// A single bare word that is not a command is a mistyped command, not an idea: never start a build for a typo.
// (The compatibility runner takes an idea with spaces, or any --flag form.)
const typo = first !== undefined && !first.startsWith('-') && !/\s/.test(first) && !COMMAND_WORDS.has(first) && argv.length === 1;
const modern = first === undefined || COMMAND_WORDS.has(first) || typo || ['--help', '-h', '--version', '-V'].includes(first);
if (modern) {
  const { main } = await import('./cli/index.js');
  process.exitCode = await main(argv);
  // The backend (if we started one) is detached, so nothing keeps this process alive; exit explicitly in case a
  // stream or timer is still open.
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
} else {
  await import('./cli/legacy.js');
}
