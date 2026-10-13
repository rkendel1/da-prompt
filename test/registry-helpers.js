// Fixtures for the persistent project registry: real temp git repositories, a backend that can be restarted on the same
// data directory, and a scripted model for runs.
import fs from 'node:fs';
import path from 'node:path';
import { startBackend } from './cli-helpers.js';
import { makeRoot, git, writeFiles, NODE_FILES, Scripted, task, plan, toolUse, done } from './project-helpers.js';
import { tmpDir } from './helpers.js';

export { git, writeFiles, NODE_FILES, makeRoot };

/** A committed repo in `dir` (created if needed), optionally with an origin remote URL. */
export function initRepo(dir, { remote, files = NODE_FILES, branch = 'main', message = 'initial' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

export const NEW_FILE = { 'src/farewell.js': "export const farewell = (n) => `Bye ${n}`;\n" };

/** A model that writes NEW_FILE-like files. */
export const writer = (files = NEW_FILE) => new Scripted({
  plan: () => plan([task('t', { verify: [] })], { finalVerify: ['npm test'] }),
  task: ({ turn }) => (turn === 0 ? Object.entries(files).map(([p, content]) => toolUse('write_file', { path: p, content })) : [done('ok', Object.keys(files))]),
});

/**
 * A real backend over a fixed data directory that can be restarted (`restart()`), with a JSON client.
 * `roots` is { name: (dir) => void } as for makeRoot; extra config goes to createServer.
 */
export async function startRegistryBackend({ roots, readOnlyRoots, password, extra = {}, dataDir, rootInfo } = {}) {
  const r = rootInfo || (roots ? makeRoot(roots) : { root: tmpDir('da-prompt-root-'), dirs: {}, cfg: { projectRoots: [] } });
  const ro = readOnlyRoots ? makeRoot(readOnlyRoots, { readOnly: true }) : null;
  const dd = dataDir || tmpDir('da-prompt-reg-data-');
  const cfgBase = { ...r.cfg, ...(ro ? { projectRootsReadOnly: ro.cfg.projectRootsReadOnly } : {}), terminalShell: '/bin/sh', ...(password ? { password } : {}), ...extra };
  const be = { roots: r, ro, dataDir: dd, password, cfgBase };
  const headers = (h = {}) => ({ 'content-type': 'application/json', ...(password ? { authorization: `Basic ${Buffer.from(`u:${password}`).toString('base64')}` } : {}), ...h });
  const boot = async () => {
    const b = await startBackend({ ...cfgBase, dataDir: dd });
    Object.assign(be, { app: b, url: b.url, server: b.server, registry: b.registry, factory: b.factory, store: b.store, terminals: b.terminals, close: b.close });
  };
  await boot();
  be.call = async (method, p, body, h) => {
    const res = await fetch(be.url + p, { method, headers: headers(h), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, body: data };
  };
  be.restart = async (newExtra = {}) => {
    await be.close();
    Object.assign(cfgBase, newExtra);
    await boot();
  };
  be.dirId = async (name) => (await be.call('GET', '/api/projects/directories')).body.directories.find((d) => d.name === name).id;
  /** Register a folder from the authorized list by its name. */
  be.register = async (name, extraBody = {}) => {
    const r2 = await be.call('POST', '/api/projects', { kind: 'local', directoryId: await be.dirId(name), ...extraBody });
    if (r2.status !== 201) throw new Error(`register failed ${r2.status}: ${JSON.stringify(r2.body)}`);
    return r2.body.project;
  };
  return be;
}
export { path };
