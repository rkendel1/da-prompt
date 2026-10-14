// Agent engines: who runs one task attempt. The factory (plan, verification, feedback, delivery) is the same for all of
// them; only the per-task coding agent differs. "builtin" is da-prompt's own loop and stays the default; the others are
// optional experiments that live OUTSIDE this repository's (empty) dependency list and are loaded on demand.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ENGINES = [
  { id: 'builtin', label: 'Built-in agents', description: 'da-prompt\'s own tool loop. Works with every provider.', package: null },
  { id: 'fx', label: 'FX (@appport/fx)', description: 'The fx agent kernel drives the task with da-prompt\'s sandboxed tools. Its model requests go through da-prompt\'s own provider adapter (a loopback bridge), so every provider works, Ollama with its context window, retries and text tool-call recovery.', package: '@appport/fx', experimental: true },
];
export const ENGINE_IDS = ENGINES.map((e) => e.id);

export class EngineError extends Error {}

export const enginesDir = (cfg) => path.join(cfg.dataDir, 'engines');

/** Resolve a package's ESM entry from an install directory, honouring the `exports` map's node/import conditions. */
async function entryOf(dir) {
  const pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
  let e = pkg.exports?.['.'] ?? pkg.exports ?? pkg.module ?? pkg.main;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) e = e.node ?? e.import ?? e.default ?? Object.values(e)[0];
  if (typeof e !== 'string') throw new EngineError(`cannot find the entry point of ${pkg.name}`);
  return { file: path.join(dir, e), version: pkg.version };
}

/**
 * Load an engine's package: injected for tests (`cfg.engineModules`), then a normal import (a project-level install),
 * then the private install under <data dir>/engines (see `npm run engine:install`).
 */
export async function loadEngineModule(cfg, id) {
  const spec = ENGINES.find((e) => e.id === id)?.package;
  if (!spec) throw new EngineError(`engine "${id}" has no package to load`);
  if (cfg.engineModules?.[id]) return cfg.engineModules[id];
  try {
    return await import(spec);
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND' || !String(e.message).includes(spec)) throw new EngineError(`${spec} failed to load: ${e.message.split('\n')[0]}`);
  }
  const dir = path.join(enginesDir(cfg), 'node_modules', ...spec.split('/'));
  try {
    const { file } = await entryOf(dir);
    return await import(pathToFileURL(file).href);
  } catch (e) {
    if (e.code === 'ENOENT') throw new EngineError(`${spec} is not installed. Install it with: npm run engine:install -- ${id}`);
    throw new EngineError(`${spec} failed to load: ${String(e.message).split('\n')[0]}`);
  }
}

/** What each engine needs from the chosen provider, checked before a run starts. */
export function checkProvider(id, provider) {
  if (id === 'fx') return fxEndpoint(provider);
  return null;
}

/**
 * What FX needs from a provider: a real model. fx never contacts the provider itself; it talks to a loopback bridge that
 * answers through the provider's own adapter (src/providers/bridge.js), so every provider type works, Anthropic included.
 */
export function fxEndpoint(provider) {
  if (typeof provider?.chat !== 'function' || !provider?.model || (provider.describe?.() || provider).name === 'offline') throw new EngineError('The FX engine needs a model provider (the offline demo agents have no model). Pick a provider and model, or use the built-in engine.');
  return { model: provider.model };
}

/** For the UI and `GET /api/engines`: which engines can be used right now, and why not. */
export async function engineStatus(cfg) {
  const out = [];
  for (const e of ENGINES) {
    const row = { id: e.id, label: e.label, description: e.description, experimental: Boolean(e.experimental), available: true, reason: null, version: null, default: (cfg.defaultEngine || 'builtin') === e.id };
    if (e.package) {
      try {
        await loadEngineModule(cfg, e.id);
        row.version = await entryOf(path.join(enginesDir(cfg), 'node_modules', ...e.package.split('/'))).then((x) => x.version, () => null);
      } catch (err) {
        row.available = false;
        row.reason = err.message;
      }
    }
    out.push(row);
  }
  return out;
}
