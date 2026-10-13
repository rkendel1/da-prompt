// Operations shared by several commands. Each one calls the backend API; none holds its own state.
import path from 'node:path';
import { CliError, EXIT, usageError } from './core.js';
import { readState } from './state.js';

const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
export const settingKey = (k) => camel(String(k));

export async function getSettings(client) {
  return client.get('/api/settings');
}

/** PUT settings; turns the backend's per-field validation errors into one readable CliError. */
export async function saveSettings(client, values) {
  try {
    return await client.put('/api/settings', { values });
  } catch (e) {
    if (e.details?.errors) {
      const lines = Object.entries(e.details.errors).map(([k, m]) => `  ${k}: ${m}`).join('\n');
      throw new CliError(`${e.message}\n${lines}`, { code: e.exitCode === EXIT.DENIED ? EXIT.DENIED : EXIT.USAGE, hint: e.hint });
    }
    throw e;
  }
}

/** Turn command-line text into the value a setting expects, using the setting's declared kind. */
export function parseSettingValue(def, raw) {
  const one = raw.length === 1 ? raw[0] : undefined;
  switch (def.kind) {
    case 'int':
      if (one === undefined || !/^-?\d+$/.test(one.trim())) throw usageError(`${def.key} needs a whole number${def.min !== undefined ? ` from ${def.min} to ${def.max}` : ''}.`);
      return Number(one);
    case 'bool':
      if (one === undefined || !/^(true|false|on|off|1|0|yes|no)$/i.test(one)) throw usageError(`${def.key} is on/off: use true, false, on, off, yes or no.`);
      return /^(true|on|1|yes)$/i.test(one);
    case 'paths':
    case 'hosts':
    case 'steps':
      return raw.flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
    case 'secret':
      throw usageError(`${def.key} is a secret and is never accepted as an argument (it would show up in process listings and shell history).`, `Pipe it in: printf %s "$VALUE" | da-prompt config set ${def.key} --stdin   (or --from-env NAME)`);
    default:
      if (one === undefined) throw usageError(`${def.key} takes a single value.`);
      return one;
  }
}

export async function listProviders(client, { refresh = false } = {}) {
  return client.get(`/api/providers${refresh ? '?refresh=1' : ''}`, { timeoutMs: 60_000 });
}

/**
 * Validate a provider (+ model) the way the factory will use it, in three distinct stages:
 *   discovery  — does the provider list this model?   connectivity — is the provider reachable and authenticated?
 *   inference  — does the model actually answer a request (with a tool call)?
 * A configured name proves none of these.
 */
export async function checkProvider(client, id, model, { inference = true } = {}) {
  const stages = [];
  const { providers } = await listProviders(client, { refresh: true });
  const p = providers.find((x) => x.id === id);
  if (!p) throw new CliError(`Unknown provider "${id}".`, { code: EXIT.NOT_FOUND, hint: `Known providers: ${providers.map((x) => x.id).join(', ')}` });
  const ready = p.status === 'ready';
  stages.push({ stage: 'connectivity', ok: ready, message: ready ? `${p.label} is reachable${p.type === 'offline' ? ' (built in)' : ''}.` : `${p.label}: ${p.status.replace('_', ' ')}${p.message ? ` — ${p.message}` : ''}`, hint: ready ? undefined : providerFix(p) });
  const ids = (p.models || []).map((m) => m.id);
  const chosen = model || p.defaultModel || null;
  if (ready) {
    const found = chosen && ids.includes(chosen);
    stages.push({ stage: 'discovery', ok: Boolean(found), model: chosen, message: found ? `${p.label} lists ${chosen} (${ids.length} model${ids.length === 1 ? '' : 's'} available).` : chosen ? `${p.label} does not list "${chosen}". Available: ${ids.slice(0, 15).join(', ') || '(none)'}` : `${p.label} lists no models.`, hint: found ? undefined : `Pick one of: da-prompt providers models ${id}` });
  }
  if (inference && ready && stages.every((s) => s.ok)) {
    const t = await client.post(`/api/providers/${encodeURIComponent(id)}/test`, { model: chosen }, { timeoutMs: 180_000 });
    stages.push({ stage: 'inference', ok: Boolean(t.ok), model: chosen, latencyMs: t.latencyMs, toolCalling: t.toolCalling, message: `${t.ok ? 'Answered a real request' : 'Did not complete a request'}: ${t.message || ''}${t.latencyMs ? ` (${t.latencyMs}ms)` : ''}` });
  }
  return { provider: p, model: chosen, stages, ok: stages.length >= 2 && stages.every((s) => s.ok) && (!inference || stages.some((s) => s.stage === 'inference')) };
}

export function providerFix(p) {
  if (p.status === 'no_key') return `Add a key: printf %s "$KEY" | da-prompt providers set-key ${p.id} --stdin${p.keyEnv ? `   (or export ${p.keyEnv})` : ''}`;
  if (p.status === 'auth_error') return `The key was rejected. Replace it: printf %s "$KEY" | da-prompt providers set-key ${p.id} --stdin`;
  if (p.status === 'unreachable') return p.local ? `Start ${p.label} on the machine that runs the backend, or change its address: da-prompt providers set-url ${p.id} <url>` : `Check the network and URL: da-prompt providers set-url ${p.id} <url>`;
  if (p.status === 'empty') return p.message || 'The server has no models; pull one first.';
  if (p.status === 'disabled') return 'The provider is disabled.';
  return p.message || undefined;
}

const REPO_RE = /^(https:\/\/[^\s/]+\/[\w.-]+\/[\w.-]+?(\.git)?|[\w.-]+\/[\w.-]+)$/;

/**
 * Turn "which project?" into a source descriptor. Accepts an opaque id, a project name from the authorized list,
 * a path (mapped to an id by the server, and only inside an authorized root) or owner/repo / an https repo URL.
 */
export async function resolveProject(client, spec, { ref, workingMode } = {}) {
  if (!spec) throw usageError('No project selected.', 'Name one with --project, select one with "da-prompt projects use <project>", or use --new for a new application.');
  if (/^[0-9a-f]{10}:/.test(spec)) return { mode: 'local', directoryId: spec, ...(workingMode ? { workingMode } : {}), label: spec };
  const { directories } = await client.get('/api/projects/directories', { timeoutMs: 60_000 });
  const byName = directories.filter((d) => d.name === spec || d.name.replace(/ \(root\)$/, '') === spec);
  if (byName.length === 1) return { mode: 'local', directoryId: byName[0].id, ...(workingMode ? { workingMode } : {}), label: byName[0].name, readOnly: byName[0].readOnly };
  if (byName.length > 1) throw usageError(`"${spec}" matches ${byName.length} authorized projects (${byName.map((d) => d.id).join(', ')}).`, 'Use the project id from "da-prompt projects list".');
  if (/^(\.|\/|~|\.\.)/.test(spec) || spec.includes('\\')) {
    const r = await client.post('/api/projects/resolve', { path: path.resolve(spec.startsWith('~') ? spec.replace(/^~/, process.env.HOME || '') : spec) });
    return { mode: 'local', directoryId: r.id, ...(workingMode ? { workingMode } : {}), label: r.name, readOnly: r.readOnly };
  }
  if (REPO_RE.test(spec)) return { mode: 'github', repoUrl: spec, ...(ref ? { ref } : {}), label: spec };
  throw new CliError(`No authorized project named "${spec}".`, { code: EXIT.NOT_FOUND, hint: 'List what is authorized: da-prompt projects list. To authorize a folder: da-prompt config set projectRoots /path/to/projects' });
}

/** The project to use: --project, else the one selected with `projects use`. */
export async function projectFor(ctx, client, { requireOne = true } = {}) {
  const spec = ctx.opts.project;
  if (spec) return resolveProject(client, spec, { ref: ctx.opts.ref, workingMode: ctx.opts['working-mode'] });
  const saved = readState(ctx.env).project;
  if (saved) return { ...saved, ...(ctx.opts.ref ? { ref: ctx.opts.ref } : {}), ...(ctx.opts['working-mode'] ? { workingMode: ctx.opts['working-mode'] } : {}) };
  if (requireOne) throw usageError('No project selected.', 'Pass --project <project>, run "da-prompt projects use <project>" once, or use --new for a new application.');
  return null;
}
