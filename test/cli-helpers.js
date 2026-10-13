// Harness for CLI tests: an in-process backend (the real server, real factory) and a way to run the real CLI
// dispatcher against it (`cli`) or as a subprocess with its own data dir (`spawnCli`).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { main } from '../src/cli/index.js';
import { tmpDir } from './helpers.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Forget anything this machine has configured, so a test never depends on (or leaks) real credentials. */
export function cleanMachineEnv() {
  for (const k of Object.keys(process.env)) {
    if (/^(ANTHROPIC|OPENAI|OPENROUTER|GEMINI|GROQ|MISTRAL|DEEPSEEK|XAI|TOGETHER|OLLAMA|LMSTUDIO|LLAMACPP|VLLM|FACTORY_|DA_PROMPT_|GITHUB_|GH_)/.test(k)) delete process.env[k];
  }
  process.env.FACTORY_OFFLINE_DELAY_MS = '0';
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** The real server on an ephemeral port. */
export async function startBackend(overrides = {}) {
  const dataDir = overrides.dataDir || tmpDir('da-prompt-cli-data-');
  const app = await createServer({ dataDir, ...overrides });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, url, dataDir, close: async () => { app.server.closeAllConnections?.(); await app.close(); } };
}

const sink = () => ({ text: '', isTTY: false, write(s) { this.text += s; return true; } });

/**
 * Run the real CLI in this process against `backend`. Never touches a TTY or the network beyond the backend.
 * Returns { code, out, err, json } where `json` is the parsed stdout when it is a single JSON document.
 */
export async function cli(argv, { backend, env = {}, input = '', configDir } = {}) {
  const stdout = sink();
  const stderr = sink();
  const stdin = Readable.from(input ? [input] : []);
  stdin.isTTY = false;
  const cfgDir = configDir || tmpDir('da-prompt-cli-cfg-');
  const full = backend && !argv.includes('--url') ? [...argv, '--url', backend.url] : argv;
  const code = await main(full, { env: { PATH: process.env.PATH, HOME: cfgDir, DA_PROMPT_CONFIG_DIR: cfgDir, NO_COLOR: '1', ...env }, stdout, stderr, stdin, cfg: backend?.cfg || loadConfig({ dataDir: tmpDir('da-prompt-cli-none-') }) });
  let json;
  try { json = JSON.parse(stdout.text); } catch { /* not a single document */ }
  return { code, out: stdout.text, err: stderr.text, json, configDir: cfgDir, lines: stdout.text.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } }) };
}

/** Run `node src/cli.js` as a real process with its own config and data dirs. */
export function spawnCli(argv, { env = {}, input, timeoutMs = 60_000, cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.js'), ...argv], { cwd, env: { PATH: process.env.PATH, NO_COLOR: '1', FACTORY_OFFLINE_DELAY_MS: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`cli ${argv.join(' ')} did not exit within ${timeoutMs}ms\n${out}\n${err}`)); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let json;
      try { json = JSON.parse(out); } catch { /* ignore */ }
      resolve({ code, signal, out, err, json });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** A private environment for subprocess tests: own config dir, data dir and port. */
export async function privateEnv(extra = {}) {
  const base = fs.realpathSync(tmpDir('da-prompt-cli-env-'));
  const port = await freePort();
  return { base, port, configDir: path.join(base, 'cfg'), dataDir: path.join(base, 'data'), env: { HOME: base, DA_PROMPT_CONFIG_DIR: path.join(base, 'cfg'), FACTORY_DATA_DIR: path.join(base, 'data'), PORT: String(port), HOST: '127.0.0.1', ...extra } };
}

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
