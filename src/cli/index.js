// The da-prompt command line. A thin client of the same backend the browser uses: every command here calls the
// documented HTTP API (or manages the backend process). There is no orchestration code in the CLI.
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { loadConfig } from '../config.js';
import { CliError, EXIT, makeOutput, usageError } from './core.js';
import { connect } from './backend.js';
import { commands } from './commands/index.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
export const GLOBAL_OPTIONS = {
  json: { type: 'boolean', description: 'Machine-readable output (one JSON document; errors too).' },
  url: { type: 'string', valueName: 'URL', description: 'Use this backend instead of the local one (env: DA_PROMPT_URL).' },
  timeout: { type: 'string', valueName: 'SECONDS', description: 'Per-request timeout (default 30).' },
  'no-start': { type: 'boolean', description: 'Never start the local backend; fail if it is not running.' },
  'no-color': { type: 'boolean', description: 'Plain output (also honours NO_COLOR).' },
  quiet: { type: 'boolean', short: 'q', description: 'Only essential output.' },
  help: { type: 'boolean', short: 'h', description: 'Show help for this command.' },
};

const GROUPS = [
  ['Setup & health', ['setup', 'doctor', 'status', 'config', 'server']],
  ['Models', ['providers']],
  ['Projects', ['projects']],
  ['Work', ['run', 'runs']],
  ['Evidence', ['pax']],
];

function optionLines(opts) {
  return Object.entries(opts).map(([name, o]) => {
    const flag = `${o.short ? `-${o.short}, ` : '    '}--${name}${o.type === 'string' ? ` <${o.valueName || 'VALUE'}>` : ''}`;
    return `  ${flag.padEnd(34)}${o.description || ''}${o.multiple ? ' (repeatable)' : ''}`;
  });
}

export function topHelp() {
  const lines = [`da-prompt ${VERSION} — a software factory you can drive from the terminal`, '', 'Usage: da-prompt <command> [arguments] [options]', ''];
  for (const [title, firsts] of GROUPS) {
    lines.push(`${title}:`);
    for (const first of firsts) {
      const cmds = commands.filter((c) => c.path[0] === first);
      const sub = cmds.filter((c) => c.path.length > 1);
      if (sub.length) lines.push(`  ${first.padEnd(12)} ${sub.map((c) => c.path[1]).join(' | ')}`);
      else lines.push(`  ${first.padEnd(12)} ${cmds[0].summary}`);
    }
    lines.push('');
  }
  lines.push('Global options (after the command): --json  --url URL  --timeout S  --no-start  --no-color  --quiet  --help', '', 'Run "da-prompt <command> --help" for details, for example "da-prompt runs --help".', 'Start a first run: da-prompt setup && da-prompt run "describe the change" --project .', '', 'Compatibility: da-prompt "<idea>" [--provider P] [--model M] [--output DIR] [--directory ID] [--repo URL] [--ref REF] [--working-mode MODE] [--publish] [--allow-install] [--deploy] runs the original in-process headless runner (no backend); prefer "run" above.', '', 'Exit codes: 0 ok · 1 failed · 2 usage · 3 unreachable · 4 refused · 5 not found · 6 needs attention · 7 timeout · 8 cancelled · 130 interrupted');
  return lines.join('\n');
}

export function commandHelp(cmd) {
  const lines = [`da-prompt ${cmd.path.join(' ')}${cmd.args ? ` ${cmd.args}` : ''}`, '', cmd.summary];
  if (cmd.description) lines.push('', cmd.description);
  if (Object.keys(cmd.options || {}).length) lines.push('', 'Options:', ...optionLines(cmd.options));
  lines.push('', 'Global options:', ...optionLines(GLOBAL_OPTIONS));
  if (cmd.examples?.length) lines.push('', 'Examples:', ...cmd.examples.map((e) => `  ${e}`));
  return lines.join('\n');
}

function groupHelp(first) {
  const cmds = commands.filter((c) => c.path[0] === first);
  return [`da-prompt ${first}`, '', ...cmds.map((c) => `  ${c.path.join(' ').padEnd(24)} ${c.summary}`), '', `Run "da-prompt ${first} <command> --help" for details.`].join('\n');
}

export function findCommand(argv) {
  const words = [];
  for (const t of argv) {
    if (t.startsWith('-')) break;
    words.push(t);
  }
  for (let k = Math.min(words.length, 3); k >= 1; k--) {
    const cmd = commands.find((c) => c.path.join(' ') === words.slice(0, k).join(' '));
    if (cmd) return { cmd, rest: argv.slice(k) };
  }
  if (words.length && commands.some((c) => c.path[0] === words[0])) return { group: words[0] };
  return { unknown: words[0] };
}

function dist(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const nearest = (word, names) => names.map((n) => [n, dist(word, n)]).sort((x, y) => x[1] - y[1]).find(([, d]) => d <= 2)?.[0];
const suggest = (word) => nearest(word, [...new Set(commands.map((c) => c.path[0]))]);

/**
 * Run the CLI. Returns the exit code instead of exiting, so it can be driven from tests.
 * io: { env, stdout, stderr }
 */
export async function main(argv, io = {}) {
  const env = io.env || process.env;
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const wantsJson = argv.includes('--json');
  const color = !wantsJson && !argv.includes('--no-color') && !env.NO_COLOR && Boolean(stdout.isTTY);
  let out = makeOutput({ json: wantsJson, quiet: argv.includes('--quiet') || argv.includes('-q'), color, stream: stdout, errStream: stderr });
  try {
    if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
      if (argv[0] === 'help' && argv[1]) {
        const f = findCommand(argv.slice(1));
        stdout.write(`${f.cmd ? commandHelp(f.cmd) : f.group ? groupHelp(f.group) : topHelp()}\n`);
      } else stdout.write(`${topHelp()}\n`);
      return EXIT.OK;
    }
    if (['--version', '-V', 'version'].includes(argv[0])) {
      if (wantsJson) out.data({ version: VERSION });
      else stdout.write(`da-prompt ${VERSION}\n`);
      return EXIT.OK;
    }
    const found = findCommand(argv);
    if (found.group) {
      if (argv.includes('--help') || argv.includes('-h') || argv.length === 1) {
        stdout.write(`${groupHelp(found.group)}\n`);
        return EXIT.OK;
      }
      const sub = argv[1] && !argv[1].startsWith('-') ? argv[1] : undefined;
      const names = commands.filter((c) => c.path[0] === found.group).map((c) => c.path[1]);
      const near = sub && nearest(sub, names);
      throw usageError(sub ? `Unknown command "${found.group} ${sub}".` : `"${found.group}" needs a subcommand.`, `${near ? `Did you mean "da-prompt ${found.group} ${near}"? ` : ''}Subcommands: ${names.join(', ')}.`);
    }
    if (found.unknown !== undefined || !found.cmd) {
      const word = found.unknown || argv[0];
      const s = suggest(word);
      throw usageError(`Unknown command "${word}".`, `${s ? `Did you mean "da-prompt ${s}"? ` : ''}Run "da-prompt --help" for the list of commands.`);
    }
    const { cmd, rest } = found;
    const options = { ...(cmd.options || {}), ...GLOBAL_OPTIONS };
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: Object.fromEntries(Object.entries(options).map(([k, o]) => [k, { type: o.type, ...(o.short ? { short: o.short } : {}), ...(o.multiple ? { multiple: true } : {}) }])), allowPositionals: true, strict: true });
    } catch (e) {
      throw usageError(e.message.replace(/ To specify a positional argument starting with a '-'.*$/, ''), `Run "da-prompt ${cmd.path.join(' ')} --help" to see the options.`);
    }
    const { values: opts, positionals: args } = parsed;
    if (opts.help) {
      stdout.write(`${commandHelp(cmd)}\n`);
      return EXIT.OK;
    }
    const min = cmd.minArgs ?? 0;
    const max = cmd.maxArgs ?? Math.max(min, (cmd.args || '').match(/[<[][^>\]]+[>\]]/g)?.length || 0);
    if (args.length < min || args.length > max) throw usageError(args.length < min ? `Missing argument: usage is "da-prompt ${cmd.path.join(' ')} ${cmd.args || ''}".` : `Too many arguments: usage is "da-prompt ${cmd.path.join(' ')} ${cmd.args || ''}".`, 'Quote values that contain spaces.');
    out = makeOutput({ json: Boolean(opts.json), quiet: Boolean(opts.quiet), color: !opts.json && !opts['no-color'] && !env.NO_COLOR && Boolean(stdout.isTTY), stream: stdout, errStream: stderr });
    if (opts.timeout !== undefined && !(Number(opts.timeout) > 0)) throw usageError('--timeout must be a positive number of seconds.');
    const cfg = io.cfg || loadConfig({});
    let backend = null;
    const ctx = {
      args,
      opts,
      out,
      cfg,
      env,
      io: { stdin: io.stdin || process.stdin, stdout, stderr },
      cmd,
      /** The backend client; starts the local backend on first use unless --no-start. */
      async api() {
        backend ||= await connect({ cfg, opts, env, noStart: Boolean(opts['no-start']) });
        if (backend.started) out.info(`Started the local da-prompt backend (${backend.record.url}).`);
        backend.started = false;
        return backend.client;
      },
      get backend() {
        return backend;
      },
    };
    const code = await cmd.run(ctx);
    return Number.isInteger(code) ? code : EXIT.OK;
  } catch (e) {
    if (e instanceof CliError) {
      out.error(e);
      return e.exitCode;
    }
    out.error(new CliError(`Unexpected error: ${e?.message || e}`));
    if (env.DA_PROMPT_DEBUG) stderr.write(`${e?.stack}\n`);
    return EXIT.FAILED;
  }
}
