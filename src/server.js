import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { RunStore } from './store.js';
import { Factory, LAYERS } from './factory.js';
import { PreviewManager } from './deploy.js';
import { Workspace } from './sandbox.js';
import { renderPrompt, PROMPT_TEMPLATE, INPUT_FIELDS } from './prompt.js';
import { buildReport, verdictOf } from './deliver.js';
import { SettingsError } from './settings.js';
import { runHealth, describeEnvironment } from './health.js';
import { probePax, listEvidence, STEPS as PAX_STEPS, SEMANTICS as PAX_SEMANTICS } from './pax.js';
import { buildEvidence } from './evidence.js';
import { redact } from './security.js';
import { redactUrl } from './gitutil.js';
import { ProjectRegistry } from './registry.js';
import { TaskStore, TASK_ID_RE, STARTABLE, OPEN } from './tasks.js';
import { ChatService, CONVERSATION_ID_RE, MESSAGE_ID_RE } from './chat.js';
import { SOURCES } from './chat-context.js';
import { engineStatus } from './engines/index.js';
import { describeStack } from './stack.js';
import { describeInference } from './contract.js';
import { readRecords, summarizeRun } from './diagnostics.js';
import { TerminalManager, TerminalError, SIGNALS as TERM_SIGNALS } from './terminal.js';
import { writeRecord, removeRecord, liveServer } from './runtime.js';
import { ProjectError, browseDirectory, pickDirectory, directoryIdForPath, authorizedRoots, listDirectories, resolveDirectory, gitState, publicGit, inspectProject, describeInspection, inspectRemote, isExisting } from './project.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };

const TERMINAL_POLICY = {
  trust: 'A terminal runs your login shell with the permissions of the user running the da-prompt server. It can read and change anything that user can.',
  startDirectory: 'A terminal can only be started in a writable project folder that you authorized; the browser sends an opaque id, never a path.',
  navigation: 'After it starts the shell is NOT confined to the project: cd, absolute paths and child processes can reach the rest of the filesystem. The header shows when the shell has left the project.',
  access: 'Only an authenticated session (access password) or a browser on the server machine can create or use terminals; every request is re-checked and cross-origin requests are refused.',
  cleanup: 'Closing a terminal, stopping the server, or abandoning a session (no browser attached for the idle limit) terminates the shell and its process tree.',
};

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** ProjectError carries its own HTTP status (403 unauthorized directory, 404 missing ref, ...). */
const asHttp = (err) => (err instanceof HttpError ? err : new HttpError(err.status || 400, err.message, err.extra ? err.extra : err.conflicts ? { conflicts: err.conflicts } : err.errors ? { errors: err.errors } : undefined));

/**
 * Settings that grant host authority (folders, tokens, the PAX path, the password) may only be read or
 * changed by an authenticated server, or by a browser on the host itself. A request relayed by a proxy is
 * not "on the host", whatever address it arrives from.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isAdmin(req, cfg) {
  if (cfg.password) return true; // checkAuth has already accepted this request
  if (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip']) return false;
  return LOOPBACK.has(req.socket.remoteAddress);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 256 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body must be valid JSON');
  }
}

function checkAuth(req, password) {
  if (!password) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass = ''] = Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s);
  const a = Buffer.from(pass);
  const b = Buffer.from(password);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Public view of a run (no huge tool outputs). */
function publicRun(run, factory, previews) {
  return {
    ...run,
    executing: factory.isActive(run.id),
    previewLive: Boolean(previews.get(run.id)),
    plan: run.plan && {
      ...run.plan,
      tasks: run.plan.tasks.map((t) => ({
        ...t,
        attempts: (t.attempts || []).map((a) => ({
          ...a,
          verification: (a.verification || []).map((v) => ({ ...v, output: (v.output || '').slice(-4000) })),
        })),
      })),
    },
  };
}

export async function createServer(overrides = {}) {
  const cfg = loadConfig(overrides);
  const store = new RunStore(cfg.dataDir);
  const previews = new PreviewManager({ max: cfg.maxPreviews });
  const registry = new ProjectRegistry(cfg);
  const factory = new Factory({ cfg, store, previews, registry });
  await factory.recover();
  // Earlier runs that worked on an existing project get a registered project (once per location/repository).
  const tasks = new TaskStore(cfg);
  const chat = new ChatService({ cfg, registry, tasks, store, factory });
  await registry.adoptRuns(store).catch((e) => console.error(`project migration skipped: ${redactUrl(redact(String(e.message)))}`));
  const publicDir = path.join(cfg.root, 'public');
  cfg.settings.onChange('maxPreviews', (v) => (previews.max = v));

  const getRun = async (id) => {
    if (!/^[0-9a-z-]{6,40}$/i.test(id) || !store.exists(id)) throw new HttpError(404, 'run not found');
    return store.load(id);
  };

  async function api(req, res, parts, url) {
    const method = req.method;
    // /api/...
    if (parts[1] === 'health') return json(res, 200, { ok: true, active: factory.active.size });
    if (parts[1] === 'config' && method === 'GET') {
      const roots = authorizedRoots(cfg);
      return json(res, 200, {
        defaults: cfg.defaults, pax: { autoRun: cfg.paxAutoRun, steps: cfg.paxSteps, catalog: Object.entries(PAX_STEPS).map(([id, s]) => ({ id, title: s.title, class: s.class })) }, layers: LAYERS, inputs: INPUT_FIELDS, gitPush: Boolean(cfg.githubToken), outputRoot: cfg.outputRoot || null,
        // Existing projects: capabilities only. Server paths are never sent to the browser.
        projects: { local: roots.length > 0, canBrowse: isAdmin(req, cfg), roots: roots.map((r) => ({ label: r.label, readOnly: r.readOnly })), github: true, githubHosts: cfg.gitHosts, canPublish: Boolean(cfg.githubToken) },
      });
    }
    if (parts[1] === 'projects') return projectsApi(req, res, parts);
    if (parts[1] === 'settings') return settingsApi(req, res, parts);
    if (parts[1] === 'system') return systemApi(req, res, parts, url);
    if (parts[1] === 'pax') return paxApi(req, res, parts);
    if (parts[1] === 'chat') return chatApi(req, res, parts, url);
    if (parts[1] === 'tasks') return tasksApi(req, res, parts, url);
    if (parts[1] === 'terminal') return terminalApi(req, res, parts, url);
    if (parts[1] === 'engines' && method === 'GET') return json(res, 200, { engines: await engineStatus(cfg), default: cfg.defaultEngine || 'builtin' });
    if (parts[1] === 'stack' && parts.length === 2 && method === 'GET') return json(res, 200, describeStack());
    if (parts[1] === 'diagnostics' && parts[2] === 'inference' && method === 'GET') {
      // Offline preflight: configuration only. It never contacts a provider or sends a model request.
      const q = (k) => url.searchParams.get(k) || undefined;
      const providerOptions = {};
      if (q('numCtx')) providerOptions.numCtx = Number(q('numCtx'));
      if (q('temperature')) providerOptions.temperature = Number(q('temperature'));
      if (q('toolMode')) providerOptions.toolMode = q('toolMode');
      return json(res, 200, { inference: await describeInference(cfg, factory.providers, { provider: q('provider'), model: q('model'), engine: q('engine'), providerOptions }) });
    }
    if (parts[1] === 'providers') return providersApi(req, res, parts, url);
    if (parts[1] === 'prompt' && method === 'GET') {
      const inputs = Object.fromEntries(INPUT_FIELDS.map(({ field }) => [field, url.searchParams.get(field) || '']));
      return json(res, 200, { template: PROMPT_TEMPLATE, rendered: renderPrompt(inputs) });
    }
    if (parts[1] !== 'runs') throw new HttpError(404, 'not found');

    if (parts.length === 2) {
      if (method === 'GET') return json(res, 200, { runs: await runRows(url) });
      if (method === 'POST') {
        const body = await readBody(req);
        let run;
        try {
          run = await factory.createRun(body);
        } catch (err) {
          throw asHttp(err);
        }
        if (body.start !== false) factory.start(run.id);
        return json(res, 201, { run: publicRun(run, factory, previews) });
      }
      throw new HttpError(405, 'method not allowed');
    }

    const id = parts[2];
    const run = await getRun(id);
    const sub = parts[3];

    if (!sub) {
      if (method === 'GET') return json(res, 200, { run: publicRun(run, factory, previews) });
      if (method === 'PATCH') {
        try {
          return json(res, 200, { run: publicRun(await factory.updateRun(id, await readBody(req, 64 * 1024)), factory, previews) });
        } catch (err) {
          throw asHttp(err);
        }
      }
      if (method === 'DELETE') {
        await factory.cancel(id);
        await factory.active.get(id)?.promise.catch(() => {});
        await store.remove(id);
        return json(res, 200, { ok: true });
      }
      throw new HttpError(405, 'method not allowed');
    }
    if (sub === 'events' && method === 'GET') return sse(req, res, id, Number(url.searchParams.get('after') || req.headers['last-event-id'] || 0));
    if (sub === 'resume' && method === 'POST') {
      try {
        return json(res, 202, { run: publicRun(await factory.resume(id), factory, previews) });
      } catch (err) {
        throw new HttpError(409, err.message);
      }
    }
    if (sub === 'rerun' && method === 'POST') {
      const body = await readBody(req);
      try {
        const fresh = await factory.rerun(id, { allowInstall: typeof body.allowInstall === 'boolean' ? body.allowInstall : undefined });
        factory.start(fresh.id);
        return json(res, 201, { run: publicRun(fresh, factory, previews) });
      } catch (err) {
        throw asHttp(err);
      }
    }
    if (sub === 'cancel' && method === 'POST') return json(res, 202, { cancelled: await factory.cancel(id) });
    if (sub === 'tasks' && parts[4] && method === 'POST' && ['retry', 'skip'].includes(parts[5])) {
      const body = await readBody(req);
      try {
        if (parts[5] === 'retry') await factory.retryTask(id, parts[4], body);
        else await factory.skipTask(id, parts[4]);
      } catch (err) {
        throw new HttpError(409, err.message);
      }
      return json(res, 202, { run: publicRun(await store.load(id), factory, previews) });
    }
    // Event history as JSON (the /events stream never ends): ?after=<seq>&limit=<n>&tail=<n>
    if (sub === 'log' && method === 'GET') {
      const all = await store.events(id, { after: Math.max(0, Number(url.searchParams.get('after')) || 0) });
      const tail = Number(url.searchParams.get('tail')) || 0;
      const limit = Math.min(5000, Number(url.searchParams.get('limit')) || 5000);
      const events = tail > 0 ? all.slice(-tail) : all.slice(0, limit);
      return json(res, 200, { events, lastSeq: all.at(-1)?.seq ?? (Number(url.searchParams.get('after')) || 0), total: all.length });
    }
    if (sub === 'evidence' && method === 'GET') return json(res, 200, { evidence: buildEvidence(run) });
    if (sub === 'diagnostics' && method === 'GET') {
      // Observations only (src/diagnostics.js): never prompts, file contents or replies; secrets are scrubbed when recorded.
      const records = readRecords(store.runDir(id));
      const limit = Math.max(0, Math.min(1000, Number(url.searchParams.get('calls') ?? 200) || 0));
      return json(res, 200, { diagnostics: summarizeRun(run, await store.events(id), records), calls: records.filter((r) => r.type === 'call').slice(-limit) });
    }
    if (sub === 'artifacts' && method === 'GET') {
      const delivery = [];
      for (const [name, label] of [['FACTORY_REPORT.md', 'Factory report'], ['test-results.json', 'Test results'], ['changes.patch', 'Patch'], ['project.tar.gz', isExisting(run) ? 'Changed files archive' : 'Project archive'], ['DELETED_FILES.txt', 'Deleted files']]) {
        const f = path.join(store.deliveryDir(id), name);
        if (fs.existsSync(f)) delivery.push({ name, label, bytes: fs.statSync(f).size, href: `api/runs/${id}/download/${name}` });
      }
      const pax = (await listEvidence(store.paxDir(id))).map((a) => ({ ...a, href: `api/runs/${id}/download/pax/${a.name}`, sha256: run.pax?.steps?.flatMap((s) => s.artifacts).find((x) => x.name === a.name)?.sha256 }));
      return json(res, 200, { delivery, pax });
    }
    if (sub === 'pax' && method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 200, { run: publicRun(await factory.runPax(id, { steps: body.steps, confirmTests: body.confirmTests === true }), factory, previews) });
      } catch (err) {
        throw asHttp(err);
      }
    }
    if (sub === 'verify' && method === 'POST') {
      try {
        return json(res, 200, { run: publicRun(await factory.reverify(id), factory, previews) });
      } catch (err) {
        throw asHttp(err);
      }
    }
    if (sub === 'review' && method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 200, { run: publicRun(await factory.review(id, { decision: body.decision, note: body.note }), factory, previews) });
      } catch (err) {
        throw asHttp(err);
      }
    }
    if (sub === 'changes' && method === 'GET') {
      try {
        return json(res, 200, await factory.changes(id, url.searchParams.get('path') || ''));
      } catch (err) {
        throw asHttp(err);
      }
    }
    if (sub === 'publish' && method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 200, { run: publicRun(await factory.publish(id, { pullRequest: body.pullRequest !== false }), factory, previews) });
      } catch (err) {
        throw asHttp(err);
      }
    }
    if (sub === 'apply' && method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 200, { run: publicRun(await factory.applyLocal(id, { mode: body.mode, approve: body.approve === true }), factory, previews) });
      } catch (err) {
        throw asHttp(err);
      }
    }
    if (sub === 'deploy' && method === 'POST') {
      if (!run.plan?.deploy) throw new HttpError(409, 'this run has no deploy command');
      if (isExisting(run) && !run.settings.deploy) {
        const body = await readBody(req);
        if (body.authorize !== true) throw new HttpError(403, 'starting a preview of an existing project needs explicit authorization ({"authorize": true})');
      }
      const d = await previews.start(id, store.workspaceDir(id), run.plan.deploy, isExisting(run) ? {} : { env: factory.appEnv(store.workspaceDir(id)) });
      run.deployment = { ...(run.deployment || {}), ...d, start: run.plan.deploy.start, healthPath: run.plan.deploy.healthPath, url: d.ok ? `/preview/${id}/` : null, at: new Date().toISOString() };
      await store.save(run);
      store.event(id, 'deploy', { ok: d.ok, url: run.deployment.url, error: d.error, logs: d.logs, restarted: true });
      return json(res, d.ok ? 200 : 502, { deployment: run.deployment });
    }
    if (sub === 'preview' && method === 'DELETE') return json(res, 200, { stopped: previews.stop(id) });
    if (sub === 'files' && method === 'GET') {
      const ws = new Workspace(store.workspaceDir(id));
      const p = url.searchParams.get('path');
      if (!p) return json(res, 200, { files: await ws.listFiles('.') });
      try {
        return json(res, 200, { path: p, content: await ws.readFile(p, { maxBytes: 400_000 }) });
      } catch (err) {
        throw new HttpError(404, err.message);
      }
    }
    if (sub === 'report' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', ...SECURITY_HEADERS });
      return res.end(buildReport(run));
    }
    if (sub === 'download' && method === 'GET') {
      if (parts[4] === 'pax' && parts[5]) {
        const n = parts[5];
        if (!/^[a-z0-9.-]+$/.test(n) || n.includes('..')) throw new HttpError(404, 'unknown file');
        const f = path.join(store.paxDir(id), n);
        if (!fs.existsSync(f)) throw new HttpError(404, 'no such evidence file');
        res.writeHead(200, { 'content-type': n.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="pax-${id}-${n}"`, ...SECURITY_HEADERS });
        return fs.createReadStream(f).pipe(res);
      }
      const name = parts[4] || 'project.tar.gz';
      if (!['project.tar.gz', 'FACTORY_REPORT.md', 'test-results.json', 'changes.patch', 'DELETED_FILES.txt'].includes(name)) throw new HttpError(404, 'unknown file');
      const file = path.join(store.deliveryDir(id), name);
      if (!fs.existsSync(file)) throw new HttpError(404, 'not delivered yet');
      const slug = (run.plan?.product?.name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const downloadName = name === 'project.tar.gz' ? `${slug}-${id}${isExisting(run) ? '-changes' : ''}.tar.gz` : name === 'changes.patch' ? `${slug}-${id}.patch` : name;
      res.writeHead(200, { 'content-type': name === 'changes.patch' || name === 'DELETED_FILES.txt' ? 'text/plain; charset=utf-8' : TYPES[path.extname(name)] || 'application/gzip', 'content-disposition': `attachment; filename="${downloadName}"`, ...SECURITY_HEADERS });
      return fs.createReadStream(file).pipe(res);
    }
    throw new HttpError(404, 'not found');
  }

  /**
   * Existing-project discovery. Everything here is read-only and constrained to the configured roots:
   * the browser picks from server-authorized ids, it can never name a path.
   */
  async function projectsApi(req, res, parts) {
    const method = req.method;
    try {
      // The persistent registry (src/registry.js): list/register here, one project at /api/projects/<prj_id>[/…].
      if (!parts[2] && method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const rows = await registry.list({ q: q.get('q') || '', status: q.get('status') || '', archived: q.get('archived') || 'false', refresh: q.get('refresh') === '1' });
        const admin = isAdmin(req, cfg);
        return json(res, 200, { projects: rows.map((p) => registry.view(p, { admin })) });
      }
      if (!parts[2] && method === 'POST') {
        const rec = await registry.register(await readBody(req, 16 * 1024), { admin: isAdmin(req, cfg) });
        return json(res, 201, { project: registry.view(rec, { admin: isAdmin(req, cfg) }) });
      }
      if (/^prj_[\w-]+$/.test(parts[2] || '')) return await registryApi(req, res, parts);
      if (parts[2] === 'directories' && method === 'GET') return json(res, 200, await listDirectories(cfg));
      // Maps a path on the server machine to an opaque id, but only inside an authorized root. It grants nothing a
      // directoryId would not, and (like other host-authority actions) only an authenticated or local client may ask.
      if (parts[2] === 'resolve' && method === 'POST') {
        if (!isAdmin(req, cfg)) throw new HttpError(403, 'Resolving a path needs an authenticated session (set an access password) or a client on the server machine.');
        const body = await readBody(req);
        const id = directoryIdForPath(cfg, String(body.path || ''));
        const dir = resolveDirectory(cfg, id);
        return json(res, 200, { id: dir.id, name: dir.name, readOnly: dir.readOnly });
      }
      // Folder picker: lists sub-folders of the server machine so a project folder can be chosen without typing a path.
      // Host authority (it reveals folder names and can authorize a folder), so administrators only.
      if ((parts[2] === 'browse' && method === 'GET') || (parts[2] === 'pick' && method === 'POST')) {
        if (!isAdmin(req, cfg)) throw new HttpError(403, 'Browsing folders needs an authenticated session (set an access password) or a browser on the server machine.');
        if (parts[2] === 'browse') {
          const q = new URL(req.url, 'http://x').searchParams;
          return json(res, 200, await browseDirectory(cfg, q.get('path') || '', { hidden: q.get('hidden') === '1' }));
        }
        const body = await readBody(req, 16 * 1024);
        const dir = pickDirectory(cfg, body.path, { authorize: body.authorize === true });
        return json(res, 200, { id: dir.id, name: dir.name, readOnly: dir.readOnly });
      }
      if (parts[2] === 'inspect' && method === 'POST') {
        const body = await readBody(req);
        let src = body.source && typeof body.source === 'object' ? body.source : body;
        if (src.projectId) {
          const located = await registry.locate(src.projectId, { purpose: 'inspect it' });
          src = located.project.kind === 'local' ? { mode: 'local', directoryId: located.dir.id } : { mode: 'github', repoUrl: located.project.remote.url, ref: src.ref || located.project.settings?.defaultRef };
        }
        if (src.mode === 'github') {
          const info = await inspectRemote(cfg, { repoUrl: src.repoUrl, ref: src.ref });
          return json(res, 200, {
            mode: 'github',
            repo: `${info.owner}/${info.repo}`,
            host: info.host,
            webUrl: info.webUrl,
            defaultBranch: info.defaultBranch,
            branches: info.branches,
            branchCount: info.branchCount,
            ref: info.selected,
            workingBranch: 'da-prompt/<run id>',
            canPublish: Boolean(cfg.githubToken),
            isolation: 'clone',
            summary: `Reads ${info.owner}/${info.repo} @ ${info.selected.name}. Edits happen in an isolated clone on a new branch; ${info.selected.kind === 'default' || info.selected.kind === 'branch' ? info.selected.name : 'the source ref'} is never modified.`,
            warnings: [
              ...(cfg.githubToken ? [] : ['GITHUB_TOKEN is not set: public repositories only, and nothing can be pushed or opened as a pull request.']),
              ...(info.selected.kind === 'tag' || info.selected.kind === 'commit' ? [`The ref is a ${info.selected.kind}; the branch can be pushed but a pull request needs a branch to target.`] : []),
            ],
          });
        }
        if (src.mode === 'local') {
          const dir = resolveDirectory(cfg, src.directoryId);
          const g = await gitState(cfg, dir.real);
          const insp = await inspectProject(new Workspace(dir.real));
          const usable = g.isGit && !g.empty;
          const warnings = [];
          if (g.isGit && g.dirty) warnings.push(`${g.counts.staged + g.counts.unstaged + g.counts.untracked} uncommitted change(s) in this working tree. "clone" starts from the last commit and ignores them; "snapshot" includes them as the baseline. Neither touches your files.`);
          if (!g.isGit) warnings.push('Not a git repository: results are delivered as a patch or archive, and git delivery is disabled.');
          if (g.isGit && g.detached) warnings.push('HEAD is detached.');
          if (dir.readOnly) warnings.push('This directory is in a read-only root: runs can read it, but results can only be downloaded, never applied back.');
          return json(res, 200, {
            mode: 'local',
            id: dir.id,
            name: dir.name,
            readOnly: dir.readOnly,
            git: publicGit(g),
            workingModes: usable ? ['clone', 'snapshot'] : ['snapshot'],
            defaultWorkingMode: usable ? 'clone' : 'snapshot',
            isolation: usable ? 'clone' : 'snapshot',
            workingBranch: usable ? 'da-prompt/<run id>' : null,
            detected: { summary: describeInspection(insp), ecosystems: insp.ecosystems, checks: insp.baselineCommands, instructions: insp.instructions.map((i) => i.path), deploy: { detected: insp.deploy.detected, proposed: insp.deploy.proposed?.command || null } },
            summary: `Reads ${dir.name}${g.branch ? ` (${g.branch})` : ''}. Edits happen in an isolated ${usable ? 'clone' : 'copy'} under the factory's data directory; your directory is only written if you apply the result afterwards.`,
            warnings,
          });
        }
        throw new ProjectError(400, 'source.mode must be local or github');
      }
    } catch (err) {
      throw asHttp(err);
    }
    throw new HttpError(404, 'not found');
  }

  // ── Settings, health and PAX (the browser-first operating surface) ──────────────────────────────

  async function settingsApi(req, res, parts) {
    const admin = isAdmin(req, cfg);
    if (parts.length === 2 && req.method === 'GET') return json(res, 200, cfg.settings.view({ admin }));
    if (parts.length === 2 && req.method === 'PUT') {
      const body = await readBody(req);
      try {
        const result = cfg.settings.update(body.values ?? body, { admin });
        // Never log values (they can be secrets): only which settings changed.
        if (result.changed.length) console.log(`settings saved: ${result.changed.join(', ')}`);
        healthCache = null;
        factory.providers.cache.clear();
        return json(res, 200, { ...result, ...cfg.settings.view({ admin }) });
      } catch (err) {
        throw asHttp(err instanceof SettingsError ? err : new SettingsError(400, err.message));
      }
    }
    throw new HttpError(405, 'method not allowed');
  }

  let healthCache = null;
  async function systemApi(req, res, parts, url) {
    if (parts[2] === 'status' && req.method === 'GET') {
      const env = describeEnvironment();
      return json(res, 200, { version: env.version, pid: process.pid, uptimeSeconds: env.uptimeSeconds, listening: { host: cfg.host, port: cfg.port }, environment: { kind: env.kind, container: env.container, hostname: env.hostname, platform: env.platform, node: env.node }, auth: Boolean(cfg.password), admin: isAdmin(req, cfg), active: [...factory.active.keys()], dataDirWritable: true });
    }
    if (parts[2] === 'health' && req.method === 'GET') {
      if (url.searchParams.get('refresh') === '1' || !healthCache || Date.now() - healthCache.at > 5000) healthCache = { at: Date.now(), result: await runHealth({ cfg, factory }) };
      return json(res, 200, { ...healthCache.result, admin: isAdmin(req, cfg), auth: Boolean(cfg.password), environment: describeEnvironment() });
    }
    throw new HttpError(404, 'not found');
  }

  async function paxApi(req, res, parts) {
    if (!parts[2] && req.method === 'GET') {
      const status = await probePax(cfg);
      return json(res, 200, {
        status,
        environment: describeEnvironment(),
        config: { path: cfg.paxPath || '', autoRun: cfg.paxAutoRun, steps: cfg.paxSteps, timeoutMs: cfg.paxTimeoutMs, pathSource: cfg.settings.source('paxPath') },
        catalog: Object.entries(PAX_STEPS).map(([id, s]) => ({ id, title: s.title, class: s.class, about: s.about, available: status.steps?.[id]?.available ?? false, reason: status.steps?.[id]?.reason ?? (status.state === 'ok' ? null : 'PAX is not usable') })),
        semantics: PAX_SEMANTICS,
      });
    }
    if (parts[2] === 'probe' && req.method === 'POST') {
      const body = await readBody(req);
      const candidate = typeof body.path === 'string' ? body.path.trim() : undefined;
      // Running an arbitrary executable to see what it is = host authority.
      if (candidate && !isAdmin(req, cfg)) throw new HttpError(403, 'Testing a different PAX executable needs an authenticated session (set an access password) or a browser on the server machine.');
      if (candidate && (/[\0\r\n;&|<>$`"'\\*?]/.test(candidate) || candidate.length > 400)) throw new HttpError(400, 'that is not a plain executable name or path');
      return json(res, 200, { status: await probePax(cfg, { candidate }) });
    }
    throw new HttpError(404, 'not found');
  }

  async function providersApi(req, res, parts, url) {
    const reg = factory.providers;
    const method = req.method;
    const refresh = url.searchParams.get('refresh') === '1';
    const id = parts[2];
    const wrap = async (fn, status = 200) => {
      try {
        return json(res, status, await fn());
      } catch (err) {
        throw new HttpError(/unknown provider/.test(err.message) ? 404 : 400, err.message);
      }
    };
    if (!id) {
      if (method === 'GET') return json(res, 200, await reg.discover({ refresh }));
      if (method === 'POST') {
        const body = await readBody(req);
        return wrap(async () => {
          const view = reg.addCustom(body);
          return { provider: { ...view, ...(await reg.probe(reg.get(view.id), { refresh: true })) } };
        }, 201);
      }
      throw new HttpError(405, 'method not allowed');
    }
    if (!parts[3]) {
      if (method === 'GET') return wrap(async () => ({ provider: { ...reg.view(reg.get(id)), ...(await reg.probe(reg.get(id), { refresh })) } }));
      if (method === 'PATCH') {
        const body = await readBody(req);
        return wrap(async () => {
          const view = reg.update(id, body);
          return { provider: { ...view, ...(await reg.probe(reg.get(id), { refresh: true })) } };
        });
      }
      if (method === 'DELETE') return wrap(async () => ({ ok: reg.remove(id) }));
      throw new HttpError(405, 'method not allowed');
    }
    if (parts[3] === 'test' && method === 'POST') {
      const body = await readBody(req);
      return wrap(() => reg.test(id, body.model));
    }
    throw new HttpError(404, 'not found');
  }

  async function sse(req, res, id, after) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    let last = after;
    const send = (e) => {
      if (e.seq <= last) return;
      last = e.seq;
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const queue = [];
    let replaying = true;
    const unsub = store.subscribe(id, (e) => (replaying ? queue.push(e) : send(e)));
    for (const e of await store.events(id, { after })) send(e);
    replaying = false;
    queue.forEach(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      unsub();
    });
  }

  function proxyPreview(req, res, parts) {
    const id = parts[1];
    const p = id && previews.get(id);
    if (!p) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>Preview stopped</title><body style="font-family:system-ui;padding:40px;max-width:560px;margin:auto"><h1>Preview is not running</h1><p>Open the run in the factory and choose <b>Restart preview</b>.</p><p><a href="/#/runs/${encodeURIComponent(id || '')}">Back to the run</a></p>`);
    }
    if (parts.length === 2 && !req.url.split('?')[0].endsWith('/')) {
      res.writeHead(308, { location: `/preview/${id}/` });
      return res.end();
    }
    const rest = req.url.replace(new RegExp(`^/preview/${id}`), '') || '/';
    const headers = { ...req.headers, host: `127.0.0.1:${p.port}` };
    delete headers.authorization;
    const upstream = http.request(
      { host: '127.0.0.1', port: p.port, method: req.method, path: rest, headers },
      (up) => {
        const out = { ...up.headers };
        if (out.location?.startsWith('/')) out.location = `/preview/${id}${out.location}`;
        res.writeHead(up.statusCode || 502, out);
        up.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) json(res, 502, { error: `preview unreachable: ${err.message}` });
      else res.destroy();
    });
    req.pipe(upstream);
  }


  // ── Embedded terminal (host shell; see src/terminal.js and the README "Embedded terminal" section) ──────────
  const terminals = new TerminalManager(cfg);
  const loopbackHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(String(h || '').replace(/:\d+$/, '').replace(/^(\[::1\]):\d+$/, '$1'));
  /** One principal per access mode; a session id alone never grants access (every call re-checks this). */
  const principal = () => (cfg.password ? `pw:${crypto.createHash('sha256').update(cfg.password).digest('hex').slice(0, 16)}` : 'local');

  function terminalGuard(req) {
    if (cfg.terminalEnabled === false) throw new HttpError(403, 'The terminal is turned off on this server (Settings → Server → Terminal).');
    if (!isAdmin(req, cfg)) throw new HttpError(403, 'The terminal runs commands as the user running this server, so it needs an authenticated session (set an access password) or a browser on the server machine. A proxied or remote request without a password is refused.');
    // A page on another origin must not be able to drive a shell on localhost (CSRF) or reach it through a rebound DNS name.
    const origin = req.headers.origin;
    if (origin) {
      let o;
      try { o = new URL(origin); } catch { throw new HttpError(403, 'bad Origin'); }
      if (o.host !== req.headers.host) throw new HttpError(403, 'Cross-origin terminal requests are refused.');
    }
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new HttpError(403, 'Cross-site terminal requests are refused.');
    if (!cfg.password && !loopbackHost(req.headers.host)) throw new HttpError(403, 'Open the terminal through http://localhost (or set an access password): an unprotected server only accepts terminal requests addressed to localhost.');
  }

  async function terminalApi(req, res, parts, url) {
    try {
      terminalGuard(req);
      const owner = principal();
      const method = req.method;
      if (!parts[2] && method === 'GET') return json(res, 200, { ...terminals.availability(), sessions: terminals.list(owner), policy: TERMINAL_POLICY });
      if (parts[2] === 'diagnostics' && method === 'GET') return json(res, 200, await terminals.diagnostics());
      if (parts[2] !== 'sessions') throw new HttpError(404, 'not found');
      if (!parts[3]) {
        if (method === 'GET') return json(res, 200, { sessions: terminals.list(owner) });
        if (method !== 'POST') throw new HttpError(405, 'method not allowed');
        const body = await readBody(req, 8 * 1024);
        // The start directory is an opaque id from the authorized list, resolved here. A path from the browser is never used.
        let dir;
        let project;
        if (body.projectId) {
          // A registered project: validated now (exists, authorized, same repository, not archived); the session only records its id.
          const located = await registry.locate(body.projectId, { purpose: 'open a terminal', writable: true });
          if (located.project.kind !== 'local') throw new HttpError(409, `"${located.project.name}" is a remote repository: it has no local folder to open. Register a local checkout as a project to use a terminal.`);
          dir = located.dir;
          project = { projectId: located.project.id, directoryId: dir.id, name: located.project.name };
          registry.touch(located.project.id);
        } else {
          dir = resolveDirectory(cfg, body.directoryId);
          project = { directoryId: dir.id, name: dir.name };
        }
        if (dir.readOnly) throw new HttpError(403, 'That folder is read-only for da-prompt, and a shell cannot honour that: terminals only open in writable project folders.');
        const s = terminals.create({ owner, dir: dir.real, project, label: body.label, cols: body.cols, rows: body.rows });
        return json(res, 201, { session: terminals.view(s) });
      }
      const s = terminals.get(parts[3], owner);
      const sub = parts[4];
      if (!sub && method === 'GET') return json(res, 200, { session: terminals.view(s) });
      if (!sub && method === 'DELETE') {
        await terminals.close(s);
        return json(res, 200, { closed: true, id: s.id, exitCode: s.exitCode, signal: s.exitSignal });
      }
      if (sub === 'stream' && method === 'GET') return terminalStream(req, res, s, url);
      if (method !== 'POST') throw new HttpError(405, 'method not allowed');
      const body = await readBody(req, 128 * 1024);
      if (sub === 'input') (terminals.write(s, typeof body.data === 'string' ? body.data : ''), json(res, 200, { ok: true }));
      else if (sub === 'resize') json(res, 200, { session: terminals.view(terminals.resize(s, body.cols, body.rows)) });
      else if (sub === 'signal') (terminals.signal(s, String(body.signal || 'INT').toUpperCase()), json(res, 200, { ok: true, signals: TERM_SIGNALS }));
      else throw new HttpError(404, 'not found');
    } catch (err) {
      if (err instanceof TerminalError) throw new HttpError(err.status, err.message);
      throw asHttp(err);
    }
  }

  /** Output as server-sent events: `data` = { off, b64 } (resumable by byte offset), `state` = session view. Slow readers cannot stall the shell. */
  function terminalStream(req, res, s, url) {
    let sent = Math.max(0, Number(url.searchParams.get('after') ?? req.headers['last-event-id']) || 0);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...SECURITY_HEADERS });
    res.write('retry: 1500\n\n');
    let waiting = false;
    let ended = false;
    const state = () => res.write(`event: state\ndata: ${JSON.stringify(terminals.view(s))}\n\n`);
    const pump = () => {
      if (ended) return;
      for (;;) {
        const r = terminals.read(s, sent, 48 * 1024);
        if (r.skipped) res.write(`event: truncated\ndata: ${JSON.stringify({ from: sent, to: r.off, dropped: r.skipped })}\n\n`);
        if (!r.buf.length) {
          sent = r.off;
          return;
        }
        sent = r.off + r.buf.length;
        if (!res.write(`id: ${sent}\nevent: data\ndata: ${JSON.stringify({ off: r.off, b64: r.buf.toString('base64') })}\n\n`)) {
          if (!waiting) (waiting = true, res.once('drain', () => ((waiting = false), pump())));
          return;
        }
      }
    };
    state();
    pump();
    const detach = terminals.attach(s, { onData: () => !waiting && pump(), onState: state, onClose: () => { pump(); state(); end(); } });
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    function end() {
      if (ended) return;
      ended = true;
      clearInterval(ping);
      detach();
      res.end();
    }
    req.on('close', end);
    res.on('close', end); // a dead socket closes the response even when the request already finished
    res.on('error', end);
  }

  /** Run rows with the project's *current* name (history stays attached to the id even after a rename or removal). */
  async function runRows(url) {
    const known = new Map((await registry.load()).projects.map((p) => [p.id, p]));
    const only = url?.searchParams.get('projectId');
    return (await store.list())
      .filter((r) => !only || r.projectId === only)
      .map((r) => {
        const p = r.projectId ? known.get(r.projectId) : null;
        return { ...r, executing: factory.isActive(r.id), ...(r.projectId ? { projectName: p?.name || r.projectName, projectRemoved: !p } : {}) };
      });
  }

  async function registryApi(req, res, parts) {
    const method = req.method;
    const admin = isAdmin(req, cfg);
    const id = parts[2];
    const sub = parts[3];
    const send = (p, extra = {}) => json(res, 200, { project: registry.view(p, { admin }), ...extra });
    if (!sub) {
      if (method === 'GET') {
        const { project, git } = await registry.status(id);
        return json(res, 200, { project: registry.view(project, { admin }), git, runs: (await runRows()).filter((r) => r.projectId === id).length });
      }
      if (method === 'PATCH') return send(await registry.update(id, await readBody(req, 16 * 1024)));
      if (method === 'DELETE') {
        const removed = await registry.remove(id, await readBody(req, 4 * 1024));
        return json(res, 200, { removed: true, id: removed.id, name: removed.name, note: 'Only the registration was removed. Your folder or repository, its runs and artifacts were not touched.' });
      }
    }
    if (sub === 'runs' && method === 'GET') {
      await registry.find(id);
      return json(res, 200, { runs: await runRows(new URL(`http://x/?projectId=${encodeURIComponent(id)}`)) });
    }
    if (method !== 'POST') throw new HttpError(405, 'method not allowed');
    if (sub === 'validate') return send((await registry.validate(id)).project);
    if (sub === 'repair') return send(await registry.repair(id, await readBody(req, 16 * 1024), { admin }));
    if (sub === 'archive') return send(await registry.setArchived(id, true));
    if (sub === 'restore') return send(await registry.setArchived(id, false));
    throw new HttpError(404, 'not found');
  }


  // ── Chat (advisory, project-scoped) and the backlog (one ordered task list) ─────────────────────
  const idOr404 = (re, v, what) => {
    if (!re.test(String(v || ''))) throw new HttpError(404, `${what} not found`);
    return v;
  };

  async function chatApi(req, res, parts, url) {
    try {
      const method = req.method;
      if (parts[2] === 'sources' && method === 'GET') return json(res, 200, { sources: SOURCES });
      if (parts[2] !== 'conversations') throw new HttpError(404, 'not found');
      if (!parts[3]) {
        if (method === 'GET') return json(res, 200, { conversations: await chat.list({ projectId: url.searchParams.get('projectId') || undefined }) });
        if (method === 'POST') return json(res, 201, { conversation: await chat.create(await readBody(req, 16 * 1024)) });
        throw new HttpError(405, 'method not allowed');
      }
      const id = idOr404(CONVERSATION_ID_RE, parts[3], 'conversation');
      const sub = parts[4];
      if (!sub) {
        if (method === 'GET') return json(res, 200, { conversation: await chat.view(id) });
        if (method === 'PATCH') return json(res, 200, { conversation: await chat.update(id, await readBody(req, 16 * 1024)) });
        throw new HttpError(405, 'method not allowed');
      }
      if (sub === 'stream' && method === 'GET') {
        await chat.load(id);
        return chatStream(req, res, id);
      }
      if (sub === 'context' && method === 'GET') return json(res, 200, { context: await chat.contextPreview(id) });
      if (method !== 'POST') throw new HttpError(405, 'method not allowed');
      if (sub === 'messages' && !parts[5]) return json(res, 202, await chat.send(id, await readBody(req, 128 * 1024)));
      if (sub === 'messages' && parts[6] === 'retry') return json(res, 202, await chat.retry(id, idOr404(MESSAGE_ID_RE, parts[5], 'message'), await readBody(req, 4 * 1024)));
      if (sub === 'stop') return json(res, 200, { stopped: chat.stop(id) });
      if (sub === 'task-draft') return json(res, 200, { draft: await chat.draftTask(id, await readBody(req, 16 * 1024)) });
      throw new HttpError(404, 'not found');
    } catch (err) {
      throw asHttp(err);
    }
  }

  /** Server-sent events for one conversation: `sync` (state of any running response), then `delta`/`message`/… events. */
  function chatStream(req, res, id) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...SECURITY_HEADERS });
    res.write('retry: 1500\n\n');
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const unsub = chat.subscribe(id, (e) => send(e.type, e));
    send('sync', { active: chat.syncState(id) });
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    const end = () => { clearInterval(ping); unsub(); res.end(); };
    req.on('close', end);
    res.on('close', end);
  }

  /** A backlog row: the stored task plus the CURRENT project/product, the run's live status and the origin conversation. */
  async function taskRow(t) {
    const p = await registry.find(t.projectId).catch(() => null);
    let run = null;
    if (t.currentRunId) {
      try {
        const r = await store.load(t.currentRunId);
        run = { id: r.id, status: r.status, executing: factory.isActive(r.id), verdict: r.source && r.finalVerification ? verdictOf(r) : null, review: r.review?.decision || null, error: r.error ? String(r.error).slice(0, 200) : null };
      } catch { run = { id: t.currentRunId, status: 'missing' }; }
    }
    let origin = t.origin;
    if (origin?.type === 'chat') {
      const c = await chat.load(origin.conversationId).catch(() => null);
      origin = { ...origin, conversationTitle: c?.title || null, conversationExists: Boolean(c) };
    }
    return {
      ...t, origin,
      project: p ? { id: p.id, name: p.name, product: p.product || null, status: p.validation?.status || 'attention', archived: Boolean(p.archived) } : { id: t.projectId, name: t.projectName, product: null, status: 'removed', archived: false, removed: true },
      run, startable: STARTABLE.has(t.status) && Boolean(p) && !p.archived,
    };
  }

  async function activeProject(projectId, purpose) {
    let p;
    try { p = await registry.find(projectId); } catch { throw new HttpError(404, 'project not found: choose a registered project'); }
    if (p.archived) throw new HttpError(409, `Project "${p.name}" is archived. Restore it to ${purpose}.`);
    return p;
  }

  async function tasksApi(req, res, parts, url) {
    try {
      const method = req.method;
      if (!parts[2]) {
        if (method === 'GET') {
          const { rev, tasks: all } = await tasks.list();
          const q = (url.searchParams.get('q') || '').toLowerCase();
          const f = { projectId: url.searchParams.get('projectId'), status: url.searchParams.get('status'), product: url.searchParams.get('product') };
          const rows = [];
          for (const t of all) rows.push(await taskRow(t));
          const view = rows.filter((r) => (!f.projectId || r.projectId === f.projectId)
            && (!f.product || r.project.product === f.product)
            && (!f.status || (f.status === 'open' ? OPEN.has(r.status) : f.status === 'finished' ? !OPEN.has(r.status) : r.status === f.status))
            && (!q || `${r.title} ${r.description} ${r.project.name}`.toLowerCase().includes(q)));
          return json(res, 200, { rev, total: all.length, tasks: view, filtered: view.length !== all.length });
        }
        if (method === 'POST') {
          const body = await readBody(req, 64 * 1024);
          let origin = null;
          let projectId = body.projectId;
          if (body.origin?.type === 'chat') {
            const cid = idOr404(CONVERSATION_ID_RE, body.origin.conversationId, 'conversation');
            const convo = await chat.load(cid).catch(() => { throw new HttpError(404, 'the originating conversation was not found'); });
            const ids = Array.isArray(body.origin.messageIds) ? body.origin.messageIds.map(String) : [];
            for (const m of ids) if (!convo.messages.some((x) => x.id === m)) throw new HttpError(400, 'a referenced message does not belong to that conversation');
            projectId ||= convo.projectId;
            origin = { type: 'chat', conversationId: cid, messageIds: ids, ...(body.origin.excerpt ? { excerpt: redact(String(body.origin.excerpt)).slice(0, 2000) } : {}) };
          }
          if (!projectId) throw new HttpError(400, 'choose the project this task belongs to');
          const project = await activeProject(projectId, 'add tasks to it');
          const t = await tasks.create({ title: body.title, description: body.description, project, origin, status: body.status || 'backlog', position: body.position === 'top' ? 'top' : body.position && typeof body.position === 'object' ? { beforeId: body.position.beforeId && idOr404(TASK_ID_RE, body.position.beforeId, 'task'), afterId: body.position.afterId && idOr404(TASK_ID_RE, body.position.afterId, 'task') } : 'bottom' });
          return json(res, 201, { task: await taskRow(t) });
        }
        throw new HttpError(405, 'method not allowed');
      }
      const id = idOr404(TASK_ID_RE, parts[2], 'task');
      const sub = parts[3];
      if (!sub) {
        if (method === 'GET') return json(res, 200, { task: await taskRow(await tasks.get(id)) });
        if (method === 'PATCH') {
          const body = await readBody(req, 64 * 1024);
          let project;
          if (body.projectId !== undefined) project = await activeProject(body.projectId, 'move tasks to it');
          return json(res, 200, { task: await taskRow(await tasks.update(id, body, { project })) });
        }
        throw new HttpError(405, 'method not allowed');
      }
      if (method !== 'POST') throw new HttpError(405, 'method not allowed');
      if (sub === 'status') {
        const body = await readBody(req, 4 * 1024);
        return json(res, 200, { task: await taskRow(await tasks.setStatus(id, body.status, body.note)) });
      }
      if (sub === 'move') {
        const body = await readBody(req, 4 * 1024);
        await tasks.get(id);
        const r = await tasks.move(id, { beforeId: body.beforeId && idOr404(TASK_ID_RE, body.beforeId, 'task'), afterId: body.afterId && idOr404(TASK_ID_RE, body.afterId, 'task'), top: body.top === true, bottom: body.bottom === true, rev: body.rev });
        const rows = [];
        for (const t of r.tasks) rows.push(await taskRow(t));
        return json(res, 200, { moved: r.moved, rev: r.rev, tasks: rows });
      }
      if (sub === 'start') return json(res, 201, await startTask(id, await readBody(req, 16 * 1024)));
      throw new HttpError(404, 'not found');
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const h = asHttp(err);
      if (err.backlog) {
        const rows = [];
        for (const t of err.backlog.tasks) rows.push(await taskRow(t));
        h.extra = { ...(h.extra || {}), backlog: { rev: err.backlog.rev, tasks: rows } };
      }
      throw h;
    }
  }

  /**
   * Hand a task to the existing factory: the task's project and its (reviewed) text become a normal run. Saving or
   * reordering a task never gets here; only this explicit action does. The task is linked to the run and stays
   * in progress until a person decides it is done (the run's own verification is shown, not assumed).
   */
  async function startTask(id, body) {
    const task = await tasks.get(id);
    if (!STARTABLE.has(task.status)) throw new HttpError(409, `A ${task.status.replace('_', ' ')} task cannot be started${task.status === 'in_progress' ? ' (it already has a run; mark it blocked or ready first to run it again)' : ''}.`);
    const project = await activeProject(task.projectId, 'start tasks on it');
    const idea = `${task.title}${task.description ? `\n\n${task.description}` : ''}`;
    let run;
    try {
      run = await factory.createRun({ idea, provider: body.provider, model: body.model, settings: body.settings, source: { projectId: project.id }, taskId: task.id });
    } catch (err) {
      throw asHttp(err);
    }
    try {
      await tasks.attachRun(task.id, run.id);
    } catch (err) {
      await store.remove(run.id).catch(() => {});
      throw asHttp(err);
    }
    factory.start(run.id);
    return { task: await taskRow(await tasks.get(id)), run: publicRun(run, factory, previews) };
  }

  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const abs = path.resolve(publicDir, rel);
    if (!abs.startsWith(publicDir + path.sep)) throw new HttpError(404, 'not found');
    try {
      const data = await fsp.readFile(abs);
      res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
      res.end(data);
    } catch {
      throw new HttpError(404, 'not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (parts[0] === 'api' && parts[1] === 'health') return json(res, 200, { ok: true });
      if (!checkAuth(req, cfg.password)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="da-prompt factory"', 'content-type': 'text/plain' });
        return res.end('authentication required');
      }
      if (parts[0] === 'api') return await api(req, res, parts, url);
      if (parts[0] === 'preview') return proxyPreview(req, res, parts);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      return await serveStatic(res, url.pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: redactUrl(redact(String(err.message || 'internal error'))), ...(err.extra || {}) });
      else res.end();
    }
  });

  const close = async () => {
    await chat.shutdown();
    for (const { controller } of factory.active.values()) controller.abort(new Error('server shutting down'));
    await Promise.allSettled([...factory.active.values()].map((a) => a.promise));
    previews.stopAll();
    await terminals.closeAll();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  };

  return { server, cfg, store, factory, previews, registry, terminals, tasks, chat, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createServer();
  // One backend per data directory: a second one would share run state with the first and fight over it.
  const running = await liveServer(app.cfg);
  if (running && running.pid !== process.pid) {
    console.error(`da-prompt is already running for ${app.cfg.dataDir} (pid ${running.pid}, ${running.url}).\nStarting a second server would share its runs. Use that one, or stop it first: da-prompt server stop`);
    process.exit(1);
  }
  app.server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${app.cfg.port} is already in use by another program. Choose another with PORT=<n> (or da-prompt server start --port <n>).` : `Server error: ${err.message}`);
    process.exit(1);
  });
  app.server.listen(app.cfg.port, app.cfg.host, () => {
    const shown = ['0.0.0.0', '::'].includes(app.cfg.host) ? 'localhost' : app.cfg.host;
    writeRecord(app.cfg, { pid: process.pid, host: app.cfg.host, port: app.cfg.port, url: `http://${shown}:${app.cfg.port}`, startedAt: new Date().toISOString(), managed: process.env.DA_PROMPT_MANAGED === '1', dataDir: app.cfg.dataDir });
    console.log(`da-prompt software factory on http://localhost:${app.cfg.port}  (data: ${app.cfg.dataDir})`);
    app.factory.providers.discover().then(({ providers, defaultProvider }) => {
      for (const p of providers.filter((x) => x.status === 'ready')) console.log(`  ✓ ${p.label}: ${p.models.length} model(s)${p.id === defaultProvider ? '  ← default' : ''}`);
      const off = providers.filter((x) => x.status !== 'ready').map((x) => x.label);
      if (off.length) console.log(`  · not available: ${off.join(', ')}`);
    });
    if (!app.cfg.password && !['127.0.0.1', 'localhost', '::1'].includes(app.cfg.host)) console.log('note: set FACTORY_PASSWORD before exposing this server; agents run shell commands.');
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    removeRecord(app.cfg);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => removeRecord(app.cfg));
}
