// Hardened git runner shared by project sources, delivery and publishing.
//
// Every git call the factory makes goes through runGit():
//  - hooks, fsmonitor and external diff/textconv are disabled, because repository contents
//    (including .git/config inside an agent workspace) are untrusted data;
//  - the parent environment is scrubbed of credentials (safeEnv) and no global git config is read;
//  - GIT_OPTIONAL_LOCKS=0 keeps read-only inspection from rewriting the index of a user's repository;
//  - credentials are injected through GIT_CONFIG_* environment variables scoped to one https URL
//    prefix, so they never appear in argv, in a remote URL or in any .git/config.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { safeEnv } from './sandbox.js';
import { redact } from './security.js';

export class GitError extends Error {
  constructor(message, { code = 'git', stderr = '', exitCode = null } = {}) {
    super(message);
    this.code = code; // no-git | network | auth | not-found | ref | git
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

const HARDEN = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.quotepath', 'false'],
  ['protocol.ext.allow', 'never'],
  ['diff.external', ''],
  ['gc.auto', '0'],
];

export const BOT = { name: 'da-prompt factory', email: 'factory@da-prompt.local' };

/**
 * Run git. Resolves { code, stdout, stderr } and never rejects on a non-zero exit; it throws
 * GitError('no-git') only when the git binary itself is missing.
 *   cfg.gitConfig: extra [key, value] pairs (tests use url.<x>.insteadOf to point https at a local repo)
 *   auth: { token, urlPrefix } adds an Authorization header for requests under urlPrefix only
 */
export function runGit(args, { cwd, cfg = {}, auth, env = {}, signal, timeoutMs = 120_000, input, binary = false } = {}) {
  const pairs = [...HARDEN, ...(cfg.gitConfig || [])];
  if (auth?.token && auth.urlPrefix) {
    pairs.push([`http.${auth.urlPrefix}.extraheader`, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${auth.token}`).toString('base64')}`]);
  }
  const gitEnv = {
    ...safeEnv(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ASKPASS: 'true',
    LC_ALL: 'C',
    GIT_CONFIG_COUNT: String(pairs.length),
    ...env,
  };
  pairs.forEach(([k, v], i) => {
    gitEnv[`GIT_CONFIG_KEY_${i}`] = k;
    gitEnv[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve({ code: 130, stdout: '', stderr: 'cancelled' });
    if (cwd && !fs.existsSync(cwd)) return resolve({ code: 128, stdout: '', stderr: 'working directory does not exist' });
    let child;
    try {
      child = spawn('git', args, { cwd, env: gitEnv, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      return reject(noGit(err));
    }
    const out = [];
    const err = [];
    let size = 0;
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size < 64 * 1024 * 1024) out.push(c);
    });
    child.stderr.on('data', (c) => err.push(c));
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT') reject(noGit(e));
      else resolve({ code: 1, stdout: '', stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      const so = Buffer.concat(out);
      resolve({ code: code ?? 1, stdout: binary ? so : so.toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    if (input != null) child.stdin.end(input);
  });
}

const noGit = () => new GitError('git is not installed or not on the server PATH; install git to work with existing projects', { code: 'no-git' });

/** runGit that throws a GitError (with an actionable message) on a non-zero exit. */
export async function git(args, opts = {}) {
  const r = await runGit(args, opts);
  if (r.code !== 0) throw explainGitError(r, opts.what);
  return opts.binary ? r.stdout : r.stdout.trim();
}

export function explainGitError(r, what = 'git') {
  const text = redact(String(r.stderr || r.stdout || '')).trim();
  const tail = text.split('\n').slice(-4).join(' ').slice(0, 400);
  if (/Could not resolve host|Failed to connect|timed out|Connection (refused|reset)|unable to access .*(SSL|certificate)|Network is unreachable|early EOF|RPC failed/i.test(text)) {
    return new GitError(`${what} failed: network error reaching the git host (${tail}). Check connectivity and try again.`, { code: 'network', stderr: text, exitCode: r.code });
  }
  if (/Authentication failed|could not read Username|terminal prompts disabled|Invalid username or password|HTTP Basic: Access denied|The requested URL returned error: (401|403)/i.test(text)) {
    return new GitError(`${what} failed: authentication was rejected, or the repository is private or does not exist (GitHub reports both the same way). For a private repository set GITHUB_TOKEN on the factory server with read access (and write access to publish).`, { code: 'auth', stderr: text, exitCode: r.code });
  }
  if (/Repository not found|does not appear to be a git repository|returned error: 404|not found/i.test(text) && !/pathspec|ref/i.test(text)) {
    return new GitError(`${what} failed: repository not found. Check the URL; private repositories also need GITHUB_TOKEN with access to them.`, { code: 'not-found', stderr: text, exitCode: r.code });
  }
  if (/couldn't find remote ref|Remote branch .* not found|invalid reference|unknown revision/i.test(text)) {
    return new GitError(`${what} failed: the requested ref does not exist in the repository.`, { code: 'ref', stderr: text, exitCode: r.code });
  }
  return new GitError(`${what} failed: ${tail || `exit code ${r.code}`}`, { code: 'git', stderr: text, exitCode: r.code });
}

/** Strip userinfo from any URL-looking value before it is stored or shown. */
export function redactUrl(url) {
  return String(url || '').replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@');
}

/** Replace server-side absolute paths in text that may reach the browser or the persisted run. */
export function scrubPaths(text, paths = []) {
  let out = String(text ?? '');
  for (const p of paths.filter((x) => x && x.length > 3).sort((a, b) => b.length - a.length)) out = out.split(p).join('<project>');
  return redact(redactUrl(out));
}
