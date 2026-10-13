// Shared CLI plumbing: exit codes, errors, output (human and --json), redaction and small formatters.
import { redact } from '../security.js';
import { redactUrl } from '../gitutil.js';

/**
 * Stable exit codes (documented in the README):
 *  0 ok · 1 the operation ran but the outcome failed · 2 usage or invalid input · 3 backend/provider unreachable
 *  4 refused (authentication, authorization, review/approval required, conflict) · 5 not found
 *  6 run finished but needs attention · 7 timed out · 8 run cancelled · 130 interrupted (Ctrl-C)
 */
export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, UNAVAILABLE: 3, DENIED: 4, NOT_FOUND: 5, ATTENTION: 6, TIMEOUT: 7, CANCELLED: 8, INTERRUPTED: 130 };
export const EXIT_NAMES = Object.fromEntries(Object.entries(EXIT).map(([k, v]) => [v, k.toLowerCase()]));

export class CliError extends Error {
  constructor(message, { code = EXIT.FAILED, hint, details } = {}) {
    super(message);
    this.exitCode = code;
    this.hint = hint;
    this.details = details;
  }
}
export const usageError = (message, hint) => new CliError(message, { code: EXIT.USAGE, hint });

/** Strip anything secret-shaped from text before it reaches a terminal, a file or JSON output. */
export const clean = (text) => redactUrl(redact(String(text ?? '')));

export function makeOutput({ json = false, quiet = false, color = false, stream = process.stdout, errStream = process.stderr } = {}) {
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return {
    json,
    quiet,
    color,
    paint,
    dim: (s) => paint(2, s),
    bold: (s) => paint(1, s),
    red: (s) => paint(31, s),
    green: (s) => paint(32, s),
    yellow: (s) => paint(33, s),
    cyan: (s) => paint(36, s),
    /** Normal output. Suppressed by --quiet; in --json mode human text goes nowhere (use out.data). */
    print(text = '') {
      if (!json && !quiet) stream.write(`${clean(text)}\n`);
    },
    /** Always-printed human output (even with --quiet), never in --json mode. */
    always(text = '') {
      if (!json) stream.write(`${clean(text)}\n`);
    },
    /** Diagnostics and progress: stderr, so stdout stays machine-readable. */
    info(text = '') {
      if (!quiet) errStream.write(`${clean(text)}\n`);
    },
    /** The machine-readable result of a command. */
    data(obj) {
      if (json) stream.write(`${clean(JSON.stringify(obj, null, 2))}\n`);
    },
    /** One JSON document per line (event streams). */
    line(obj) {
      stream.write(`${clean(JSON.stringify(obj))}\n`);
    },
    error(err) {
      const e = err instanceof CliError ? err : new CliError(err?.message || String(err));
      if (json) stream.write(`${clean(JSON.stringify({ error: { code: EXIT_NAMES[e.exitCode] || 'failed', exitCode: e.exitCode, message: e.message, hint: e.hint || undefined, details: e.details || undefined } }, null, 2))}\n`);
      else {
        errStream.write(`${clean(`${paint(31, 'error:')} ${e.message}`)}\n`);
        if (e.hint) errStream.write(`${clean(`${paint(2, 'hint:')}  ${e.hint}`)}\n`);
      }
    },
  };
}

export function table(rows, cols, out) {
  if (!rows.length) return '';
  const cell = (r, c) => String(typeof c.get === 'function' ? c.get(r) : r[c.key] ?? '');
  const widths = cols.map((c) => Math.min(c.max || 60, Math.max(c.title.length, ...rows.map((r) => cell(r, c).replace(/\x1b\[[0-9;]*m/g, '').length))));
  const clip = (s, w) => (s.replace(/\x1b\[[0-9;]*m/g, '').length > w ? `${s.slice(0, w - 1)}…` : s);
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.replace(/\x1b\[[0-9;]*m/g, '').length));
  const head = cols.map((c, i) => pad(c.title.toUpperCase(), widths[i])).join('  ');
  const body = rows.map((r) => cols.map((c, i) => pad(clip(cell(r, c), widths[i]), widths[i])).join('  ').trimEnd());
  return [out ? out.dim(head.trimEnd()) : head.trimEnd(), ...body].join('\n');
}

export const kvList = (pairs, out) => {
  const w = Math.max(...pairs.map(([k]) => k.length));
  return pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${out ? out.dim(k.padEnd(w)) : k.padEnd(w)}  ${v}`).join('\n');
};

export const ago = (iso) => {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${Math.floor(s)}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
export const dur = (a, b) => {
  if (!a) return '—';
  const s = Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};
export const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

export const TERMINAL = new Set(['completed', 'needs_attention', 'failed', 'cancelled']);
export const RESUMABLE = new Set(['needs_attention', 'interrupted', 'failed', 'cancelled']);

/** Map the final state of a run to an exit code. "completed" is the factory's own verdict, not an agent's message. */
export function exitForRun(run) {
  if (run.status === 'completed') return EXIT.OK;
  if (run.status === 'needs_attention') return EXIT.ATTENTION;
  if (run.status === 'cancelled') return EXIT.CANCELLED;
  return EXIT.FAILED;
}

/** Read all of stdin (for secrets: never accepted as an argument, so they stay out of process listings). */
export async function readStdin(stream = process.stdin) {
  if (stream.isTTY) throw usageError('--stdin needs input piped to the command (for example: printf %s "$TOKEN" | da-prompt config set githubToken --stdin).');
  let data = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) data += chunk;
  return data.replace(/\r?\n$/, '');
}
