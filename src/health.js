// System health: every check performs a real probe (a write to the data folder, a request to the provider,
// `git --version`, a call to the GitHub API, running `pax --version`) and reports what it observed.
// Nothing is inferred from the existence of a setting. Each result says what failed, what was observed,
// and what the user can do next — directly in the UI where the backend can do it, or as a host-level
// instruction where only the machine's owner can.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runGit } from './gitutil.js';
import { probePax } from './pax.js';
import { authorizedRoots } from './project.js';
import { apiBase } from './publish.js';
import { redact } from './security.js';

const STARTED = Date.now();
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const ui = (label, href) => ({ label, href });
const check = (id, group, label, status, summary, extra = {}) => ({ id, group, label, status, summary, ...extra });
const kv = (obj) => Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => ({ k, v: String(v) }));

/** Is this server running on a machine, or inside a container? (Affects what "localhost" and "PATH" mean.) */
export function describeEnvironment() {
  let container = null;
  if (fs.existsSync('/.dockerenv')) container = 'docker';
  else if (process.env.KUBERNETES_SERVICE_HOST) container = 'kubernetes';
  else {
    try {
      const cg = fs.readFileSync('/proc/1/cgroup', 'utf8');
      if (/docker|kubepods|containerd|lxc/.test(cg)) container = 'container';
    } catch {
      /* not linux */
    }
  }
  return { kind: container ? 'container' : 'host', container, platform: `${process.platform}/${process.arch}`, node: process.version, hostname: os.hostname(), user: os.userInfo().username, pid: process.pid, uptimeSeconds: Math.round((Date.now() - STARTED) / 1000), version: VERSION };
}

const writable = async (dir) => {
  const probe = path.join(dir, `.da-prompt-write-test-${crypto.randomBytes(3).toString('hex')}`);
  await fsp.writeFile(probe, 'ok');
  await fsp.rm(probe, { force: true });
};

async function checkBackend(ctx) {
  const env = describeEnvironment();
  const where = env.container ? `inside a ${env.container} container` : 'directly on a host';
  return check('backend', 'system', 'Factory backend', 'ok', `Running ${where} (da-prompt ${env.version}, Node ${env.node}).`, {
    details: kv({ 'Runs': where, Host: env.hostname, User: env.user, Platform: env.platform, 'Listening on': `${ctx.cfg.host}:${ctx.cfg.port}`, Uptime: `${env.uptimeSeconds}s`, 'Active runs': ctx.factory.active.size }),
    note: env.container ? 'Because the server runs in a container, "localhost", the PATH and every folder below refer to the container, not to your computer.' : 'Folders, the PATH and "localhost" below refer to the machine this server runs on.',
  });
}

async function checkData(ctx) {
  const dir = ctx.cfg.dataDir;
  try {
    await fsp.mkdir(dir, { recursive: true });
    await writable(dir);
  } catch (e) {
    return check('data', 'system', 'Data folder', 'fail', `Cannot write to the data folder (${e.code || e.message}).`, {
      details: kv({ Observed: `write test failed: ${redact(e.message)}`, Folder: dir }),
      remediation: { text: `Make ${dir} writable for the user that runs da-prompt (${os.userInfo().username}). In Docker, mount a volume at /data. The browser cannot change host permissions.`, host: true },
    });
  }
  let free = null;
  try {
    const s = await fsp.statfs(dir);
    free = s.bavail * s.bsize;
  } catch {
    /* statfs unavailable */
  }
  const low = free !== null && free < 500 * 1024 * 1024;
  const settingsFile = ctx.cfg.settings?.file;
  let mode = null;
  try {
    mode = (fs.statSync(settingsFile).mode & 0o777).toString(8);
  } catch {
    /* no saved settings yet */
  }
  return check('data', 'system', 'Data folder', low ? 'warn' : 'ok', low ? `Writable, but only ${(free / 1048576).toFixed(0)} MB free.` : 'Writable. Runs, workspaces and saved settings are stored here.', {
    details: kv({ Folder: dir, 'Free space': free === null ? 'unknown' : `${(free / 1073741824).toFixed(1)} GB`, 'Saved settings file': mode ? `present (permissions ${mode})` : 'not created yet (nothing saved from the UI)' }),
    remediation: low ? { text: 'Free disk space or move the data volume; runs keep a full copy of the project they work on.', host: true } : undefined,
  });
}

async function checkProviders(ctx) {
  const { providers, defaultProvider } = await ctx.factory.providers.discover({ refresh: true });
  const real = providers.filter((p) => p.type !== 'offline');
  const ready = real.filter((p) => p.status === 'ready' && p.enabled);
  const rows = providers.map((p) => `${p.label}: ${p.status}${p.message ? ` — ${p.message}` : ''}`);
  const out = [];
  const fixHint = (p) => {
    if (p.status === 'no_key') return { text: `Add an API key for ${p.label} on the Providers page. It is stored on the server and never shown again.`, ui: ui('Open Providers', '#/providers') };
    if (p.status === 'auth_error') return { text: `${p.label} rejected the key. Replace it on the Providers page.`, ui: ui('Open Providers', '#/providers') };
    if (p.status === 'unreachable' && p.local) return { text: `${p.label} is not answering at ${p.baseUrl}. Start it on the machine that runs da-prompt${ctx.env.container ? ' — you are in a container, so "127.0.0.1" is the container itself; use host.docker.internal or the host\'s address' : ''}, or change the address on the Providers page.`, ui: ui('Open Providers', '#/providers') };
    if (p.status === 'unreachable') return { text: `Cannot reach ${p.baseUrl} from the server. Check its network access and the URL.`, ui: ui('Open Providers', '#/providers') };
    if (p.status === 'empty') return { text: p.message || `${p.label} has no models yet.`, host: true };
    return { text: p.message || 'See the Providers page for details.', ui: ui('Open Providers', '#/providers') };
  };
  out.push(check('providers', 'models', 'Model providers', ready.length ? 'ok' : 'fail', ready.length ? `${ready.length} provider${ready.length === 1 ? '' : 's'} ready: ${ready.map((p) => p.label).join(', ')}.` : 'No real model provider is usable. Only the offline demo agents are available.', {
    details: kv(Object.fromEntries(providers.map((p) => [p.label, `${p.status}${p.models?.length ? ` (${p.models.length} model${p.models.length === 1 ? '' : 's'})` : ''}${p.message ? ` — ${p.message}` : ''}`]))),
    remediation: ready.length ? undefined : { text: 'Configure a provider: add an API key for a hosted one, or start a local one (Ollama, LM Studio, …). The Providers page tests each connection.', ui: ui('Open Providers', '#/providers') },
    providers: providers.map((p) => ({ id: p.id, label: p.label, status: p.status, message: p.message || null, models: p.models?.length || 0, local: p.local, fix: ['ready', 'disabled'].includes(p.status) ? undefined : fixHint(p) })),
  }));
  void rows;

  // Is the effective default usable, and does the chosen model actually exist on it?
  const dp = providers.find((p) => p.id === defaultProvider);
  const wantModel = (ctx.cfg.defaultProvider === defaultProvider ? ctx.cfg.defaultModel : '') || '';
  const models = (dp?.models || []).map((m) => m.id);
  if (!dp || dp.status !== 'ready') {
    out.push(check('default-model', 'models', 'Default provider and model', 'fail', `The default provider (${dp?.label || defaultProvider}) is not usable${dp?.message ? `: ${dp.message}` : ''}.`, { remediation: dp ? fixHint(dp) : { text: 'Choose a default provider in Settings.', ui: ui('Open Settings', '#/settings?group=models') } }));
  } else if (wantModel && !models.includes(wantModel)) {
    out.push(check('default-model', 'models', 'Default provider and model', 'fail', `The configured default model "${wantModel}" is not offered by ${dp.label}.`, {
      details: kv({ Provider: dp.label, 'Configured model': wantModel, 'Models offered': models.slice(0, 12).join(', ') }),
      remediation: { text: `Pick one of the ${models.length} models ${dp.label} actually offers.`, ui: ui('Choose a model', '#/settings?group=models') },
    }));
  } else {
    out.push(check('default-model', 'models', 'Default provider and model', dp.type === 'offline' ? 'warn' : 'ok', dp.type === 'offline' ? 'The default is the offline demo agents, which only produce a template app and cannot change real code.' : `${dp.label} will use ${wantModel || dp.defaultModel || 'its best available model'}.`, {
      details: kv({ Provider: dp.label, Model: wantModel || dp.defaultModel, 'Where the default comes from': ctx.cfg.settings?.source('defaultProvider') === 'default' ? 'automatic (last used, else the first ready provider)' : ctx.cfg.settings?.source('defaultProvider') }),
      remediation: dp.type === 'offline' ? { text: 'Add a real provider to do real work.', ui: ui('Open Providers', '#/providers') } : undefined,
    }));
  }
  return out;
}

async function checkOutput(ctx) {
  const root = ctx.cfg.outputRoot;
  if (!root) return check('output', 'folders', 'Delivery folder', 'na', 'No restriction: a run may export a finished project to any new folder you name. Downloads always work.', { remediation: { text: 'Optionally confine exports to one folder.', ui: ui('Open Settings', '#/settings?group=folders') } });
  try {
    await fsp.mkdir(root, { recursive: true });
    await writable(root);
    return check('output', 'folders', 'Delivery folder', 'ok', 'Writable. Finished projects can be exported inside it.', { details: kv({ Folder: root }) });
  } catch (e) {
    return check('output', 'folders', 'Delivery folder', 'fail', `Cannot write to the delivery folder (${e.code || e.message}).`, { details: kv({ Folder: root, Observed: redact(e.message) }), remediation: { text: 'Choose a different delivery folder here, or fix its permissions on the host.', ui: ui('Open Settings', '#/settings?group=folders'), host: true } });
  }
}

async function checkRoots(ctx) {
  const roots = authorizedRoots(ctx.cfg);
  const configured = [...(ctx.cfg.projectRoots || []), ...(ctx.cfg.projectRootsReadOnly || [])];
  if (!configured.length) return check('roots', 'folders', 'Project folders', 'warn', 'No project folders are authorized, so existing local projects cannot be used. GitHub repositories and new projects still work.', { remediation: { text: 'Add the folder that contains your projects.', ui: ui('Authorize a folder', '#/settings?group=folders') } });
  const rows = [];
  let worst = 'ok';
  for (const r of roots) {
    let canRead = false;
    let canWrite = false;
    let dirs = 0;
    let repos = 0;
    try {
      const ents = (await fsp.readdir(r.real, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
      canRead = true;
      dirs = ents.length;
      repos = ents.filter((e) => fs.existsSync(path.join(r.real, e.name, '.git'))).length;
    } catch {
      /* unreadable */
    }
    try {
      fs.accessSync(r.real, fs.constants.W_OK);
      canWrite = true;
    } catch {
      /* read-only for this user */
    }
    const problem = !canRead ? 'cannot be read by the server' : !r.readOnly && !canWrite ? 'is marked read/write but the server user cannot write to it, so results could not be applied' : null;
    if (problem) worst = 'fail';
    rows.push({ label: r.label, readOnly: r.readOnly, canRead, canWrite, dirs, repos, problem });
  }
  const missing = configured.length - roots.length;
  if (missing > 0 && worst === 'ok') worst = 'warn';
  return check('roots', 'folders', 'Project folders', worst, worst === 'ok' ? `${roots.length} authorized folder${roots.length === 1 ? '' : 's'} readable${roots.some((r) => !r.readOnly) ? ' and writable' : ''}.` : missing > 0 && !rows.some((r) => r.problem) ? `${missing} configured folder${missing === 1 ? ' does' : 's do'} not exist on the server.` : 'A project folder has an access problem.', {
    details: rows.map((r) => ({ k: r.label, v: `${r.readOnly ? 'read-only' : 'read/write'} · ${r.canRead ? `${r.dirs} folders, ${r.repos} git repositories` : 'unreadable'}${r.problem ? ` — ${r.problem}` : ''}` })),
    remediation: worst === 'ok' ? undefined : { text: 'Fix the folder list, or grant the server user access to it. Permissions on the host can only be changed by the machine\'s owner.', ui: ui('Edit project folders', '#/settings?group=folders'), host: true },
    roots: rows.map(({ label, readOnly, canRead, canWrite, dirs, repos, problem }) => ({ label, readOnly, canRead, canWrite, dirs, repos, problem })),
  });
}

async function checkGit(ctx) {
  try {
    const r = await runGit(['--version'], { cfg: ctx.cfg, timeoutMs: 5000 });
    if (r.code !== 0) throw new Error(r.stderr || 'git exited with an error');
    return check('git', 'git', 'Git', 'ok', r.stdout.trim(), { details: kv({ Version: r.stdout.trim() }) });
  } catch (e) {
    return check('git', 'git', 'Git', 'fail', 'Git is not installed or not on the server\'s PATH, so existing projects cannot be used.', {
      details: kv({ Observed: redact(e.message), PATH: `${(process.env.PATH || '').split(path.delimiter).length} folders searched` }),
      remediation: { text: `Install git on ${ctx.env.container ? 'the container image (the da-prompt Docker image includes it)' : 'the machine that runs da-prompt'}. A browser cannot install software on a host.`, host: true },
    });
  }
}

async function checkGithub(ctx) {
  const { cfg } = ctx;
  const hosts = cfg.gitHosts || ['github.com'];
  if (!cfg.githubToken) {
    return check('github', 'git', 'GitHub publishing', 'warn', 'No GitHub token is configured: public repositories can be read, but nothing can be pushed and no pull request can be opened.', {
      details: kv({ 'Allowed hosts': hosts.join(', '), Token: 'not configured' }),
      remediation: { text: 'Add a token with read access to clone private repositories and write access (Contents and Pull requests) to publish.', ui: ui('Add a token', '#/settings?group=github') },
    });
  }
  const host = hosts[0];
  const base = apiBase(cfg, host);
  try {
    const res = await ctx.fetch(`${base}/user`, { headers: { authorization: `Bearer ${cfg.githubToken}`, accept: 'application/vnd.github+json', 'user-agent': 'da-prompt-factory' }, signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) return check('github', 'git', 'GitHub publishing', 'fail', 'GitHub rejected the token (401): it is wrong, revoked or expired.', { details: kv({ 'API checked': base, Token: `configured (${cfg.settings?.source('githubToken')})` }), remediation: { text: 'Create a new token and replace it here.', ui: ui('Replace the token', '#/settings?group=github') } });
    if (!res.ok) return check('github', 'git', 'GitHub publishing', 'fail', `GitHub answered ${res.status} when the token was checked.`, { details: kv({ 'API checked': base, Observed: redact(String(body.message || '')) }), remediation: { text: 'Check the API URL and that the token is allowed to call it.', ui: ui('Open GitHub settings', '#/settings?group=github') } });
    const scopes = res.headers.get('x-oauth-scopes');
    const note = scopes === null ? 'This is a fine-grained token, so GitHub does not report what it may do. Write access is only confirmed when you publish.' : scopes.split(',').map((s) => s.trim()).includes('repo') || scopes.includes('public_repo') ? 'Classic token with repository scope.' : 'The token has no repository scope: pushing will fail.';
    const lacks = scopes !== null && !/(^|,\s*)(repo|public_repo)(,|$)/.test(scopes);
    return check('github', 'git', 'GitHub publishing', lacks ? 'warn' : 'ok', lacks ? `Authenticated as ${body.login}, but the token has no repository scope.` : `Authenticated as ${body.login}. Publishing is available once you approve a run.`, {
      details: kv({ Account: body.login, 'API checked': base, 'Allowed hosts': hosts.join(', '), Scopes: scopes === null ? 'not reported (fine-grained token)' : scopes || '(none)', 'Token source': cfg.settings?.source('githubToken') }),
      note,
    });
  } catch (e) {
    return check('github', 'git', 'GitHub publishing', 'fail', 'Could not reach the GitHub API from the server.', { details: kv({ 'API checked': base, Observed: redact(e.cause?.code || e.message) }), remediation: { text: 'The server needs outbound HTTPS access to GitHub. Check its network, proxy and firewall settings on the host.', host: true } });
  }
}

async function checkPax(ctx) {
  const p = await probePax(ctx.cfg);
  const env = ctx.env;
  const where = env.container ? `the PATH of the da-prompt ${env.container} container` : 'the PATH of the da-prompt server process';
  const note = `PAX is looked up in ${where}, not in your browser's or terminal's PATH${env.container ? ' — a PAX installed on your computer is invisible from inside a container' : ''}.`;
  if (p.state === 'ok') {
    const missing = Object.entries(p.steps).filter(([, s]) => !s.available);
    return check('pax', 'pax', 'PAX', missing.length ? 'warn' : 'ok', `PAX ${p.version} found at ${p.path}.`, {
      details: kv({ Path: p.path, Found: p.source === 'configured' ? 'configured path' : 'on the PATH', Version: p.version, Commands: p.commands.join(' '), Unsupported: missing.map(([id, s]) => `${id} (${s.reason})`).join('; ') }),
      note,
      pax: p,
    });
  }
  const fixes = {
    unavailable: { text: `Install PAX on ${env.container ? 'the container image' : 'the machine that runs da-prompt'} (release archives: github.com/rkendel1/pax/releases) so that "pax" is on the server's PATH, or enter the executable's full path in Settings. A browser cannot install a program on a host.`, ui: ui('Set the PAX path', '#/settings?group=pax'), host: true },
    permission: { text: `Make the file executable for the user the server runs as (${os.userInfo().username}): this needs host access.`, ui: ui('Set the PAX path', '#/settings?group=pax'), host: true },
    incompatible: { text: 'The program found is not PAX (or an unrecognisable version). Point da-prompt at the right executable.', ui: ui('Set the PAX path', '#/settings?group=pax') },
    timeout: { text: 'The executable did not answer --version in time; check it runs from a terminal on the server.', host: true },
    error: { text: 'The executable could not be started; see the observed message.', ui: ui('Set the PAX path', '#/settings?group=pax'), host: true },
  };
  return check('pax', 'pax', 'PAX', p.state === 'unavailable' ? 'warn' : 'fail', p.message, { details: kv({ State: p.state, Configured: p.configured || '(none — using the PATH)', 'Resolved path': p.path }), note, remediation: fixes[p.state], pax: p });
}

async function checkSecurity(ctx) {
  const { cfg } = ctx;
  const loop = ['127.0.0.1', 'localhost', '::1'].includes(cfg.host);
  if (cfg.password) return check('security', 'system', 'Access protection', 'ok', 'A password protects this server.', { details: kv({ 'Password source': cfg.settings?.source('password'), 'Listening on': `${cfg.host}:${cfg.port}` }) });
  if (loop) return check('security', 'system', 'Access protection', 'ok', 'No password, but the server only listens on this machine.', { details: kv({ 'Listening on': `${cfg.host}:${cfg.port}` }) });
  return check('security', 'system', 'Access protection', 'warn', `No password is set and the server listens on ${cfg.host}, so anyone who can reach this port can run agents that execute shell commands.`, {
    remediation: { text: 'Set an access password. Settings that grant host access (folders, tokens, the PAX path) stay locked until you do or open the UI from the server machine.', ui: ui('Set a password', '#/settings?group=server') },
  });
}

const CHECKS = [checkBackend, checkData, checkProviders, checkOutput, checkRoots, checkGit, checkGithub, checkPax, checkSecurity];
const ORDER = ['backend', 'data', 'security', 'providers', 'default-model', 'output', 'roots', 'git', 'github', 'pax'];

/** Run every check (in parallel, each bounded). A check that throws is reported as failed, not hidden. */
export async function runHealth({ cfg, factory, fetchImpl = fetch }) {
  const ctx = { cfg, factory, fetch: fetchImpl, env: describeEnvironment() };
  const settled = await Promise.all(CHECKS.map((fn) => Promise.race([fn(ctx), new Promise((_, rej) => setTimeout(() => rej(new Error('the check timed out after 20s')), 20_000))]).catch((e) => [check(fn.name.replace(/^check/, '').toLowerCase(), 'system', fn.name.replace(/^check/, ''), 'fail', `The check itself failed: ${redact(e.message)}`)])));
  const checks = settled.flat().sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const critical = ['backend', 'data', 'providers', 'default-model'];
  const failing = checks.filter((c) => c.status === 'fail');
  const providers = checks.find((c) => c.id === 'providers');
  return {
    checkedAt: new Date().toISOString(),
    environment: ctx.env,
    ready: !checks.some((c) => critical.includes(c.id) && c.status === 'fail'),
    needsSetup: Boolean(providers && providers.status === 'fail') || failing.some((c) => critical.includes(c.id)),
    counts: { ok: checks.filter((c) => c.status === 'ok').length, warn: checks.filter((c) => c.status === 'warn').length, fail: failing.length, na: checks.filter((c) => c.status === 'na').length },
    checks,
  };
}
