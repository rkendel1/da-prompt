// The only client-side state: which project `da-prompt run` uses when you do not name one.
// It holds an opaque project reference (a directoryId or a public repository URL + ref), never a path,
// in $DA_PROMPT_CONFIG_DIR, or $XDG_CONFIG_HOME/da-prompt, or ~/.config/da-prompt (file mode 0600).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const stateDir = (env = process.env) => env.DA_PROMPT_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'da-prompt');
export const stateFile = (env) => path.join(stateDir(env), 'cli.json');

export function readState(env = process.env) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(env), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

export function writeState(patch, env = process.env) {
  const next = { ...readState(env), ...patch };
  fs.mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  const tmp = `${stateFile(env)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stateFile(env));
  return next;
}
