// Persistent project registry: a project is a durable identity (opaque id) associated with a workspace location.
// It is not a terminal session, a run, a checkout or a folder name. Records live in <dataDir>/projects.json (mode 0600,
// atomic writes) and survive restarts. Runs and terminals only store the project id.
//
// Authority: a record grants nothing. Every use re-resolves the stored location against the *current* authorized roots
// (resolveDirectory/directoryIdForPath) and re-checks the repository identity, so a path that was authorized when it was
// registered but is not any more, or a folder that now holds a different repository, is blocked until repaired.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { runGit } from './gitutil.js';
import { redact } from './security.js';
import { ProjectError, resolveDirectory, directoryIdForPath, authorizedRoots, gitState, publicGit, parseRepoUrl, inspectRemote, validateRef, WORKING_MODES } from './project.js';

const VERSION = 1;
const MAX_NAME = 80;
export const STATUSES = ['available', 'missing', 'inaccessible', 'attention'];
const FRESH_MS = 5000; // a validation younger than this is reused by list/get (every *use* re-validates)

const newId = () => `prj_${crypto.randomBytes(12).toString('base64url')}`;
const now = () => new Date().toISOString();

/** Comparable identity of a remote URL: host/owner/repo, lowercase, no credentials, no .git, https or scp-like ssh. */
export function remoteKey(url) {
  if (!url) return '';
  let s = String(url).trim();
  const scp = s.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (scp) s = `https://${scp[1]}/${scp[2]}`;
  try {
    const u = new URL(s);
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase()}`;
  } catch {
    return s.toLowerCase().replace(/\.git$/, '');
  }
}

const cleanName = (n, fallback) => {
  const s = String(n ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_NAME);
  return s || fallback;
};

const conflict = (message, conflicts) => Object.assign(new ProjectError(409, message), { conflicts });

/** Repository identity of a directory, from git itself (never from names): root commits + remote + branch. */
export async function repoIdentity(cfg, real) {
  const gs = await gitState(cfg, real).catch(() => ({ isGit: false }));
  if (!gs.isGit) return { isGit: false, rootCommits: [], remoteKey: '', remoteUrl: null, remoteName: null };
  let rootCommits = [];
  if (!gs.empty) {
    const r = await runGit(['rev-list', '--max-parents=0', 'HEAD'], { cwd: real, cfg, timeoutMs: 30_000 });
    if (r.code === 0) rootCommits = r.stdout.split('\n').map((x) => x.trim()).filter(Boolean).sort().slice(0, 3);
  }
  const remote = gs.remotes.find((r) => r.name === 'origin') || gs.remotes[0] || null;
  let defaultBranch = null;
  const sym = await runGit(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { cwd: real, cfg, timeoutMs: 10_000 });
  if (sym.code === 0) defaultBranch = sym.stdout.trim().replace(/^origin\//, '');
  return { isGit: true, rootCommits, remoteName: remote?.name || null, remoteUrl: remote?.url || null, remoteKey: remote ? remoteKey(remote.url) : '', branch: gs.branch, defaultBranch: defaultBranch || gs.branch, empty: gs.empty, git: gs };
}

export class ProjectRegistry {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = path.join(cfg.dataDir, 'projects.json');
    this.queue = Promise.resolve();
    this.cache = null;
  }

  // ── persistence ──────────────────────────────────────────────────────────────────────────────

  async load() {
    if (this.cache) return this.cache;
    let data = { version: VERSION, projects: [] };
    try {
      const parsed = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      if (parsed && Array.isArray(parsed.projects)) data = { version: VERSION, ...parsed };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // A corrupt registry must not be silently replaced: keep the bad file and start a new one beside it.
        try { await fsp.rename(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
    }
    this.cache = data;
    return data;
  }

  /** Run `fn(data)` exclusively, then write atomically if it returns without throwing. */
  mutate(fn) {
    const run = this.queue.then(async () => {
      const data = await this.load();
      const draft = JSON.parse(JSON.stringify(data));
      const result = await fn(draft);
      await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(draft, null, 2), { mode: 0o600 });
      await fsp.rename(tmp, this.file);
      this.cache = draft;
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async find(id) {
    const data = await this.load();
    const p = data.projects.find((x) => x.id === String(id));
    if (!p) throw new ProjectError(404, 'project not found (it may have been removed)');
    return p;
  }

  // ── validation: statuses come from looking at the host, never from stored flags ─────────────────

  /** Inspect the current state of a project's location. Returns { status, errors, warnings, identity?, dir? }. */
  async inspect(p) {
    const errors = [];
    const warnings = [];
    const out = (status, extra = {}) => ({ status, errors, warnings, checkedAt: now(), ...extra });
    if (p.kind === 'remote') {
      try {
        parseRepoUrl(this.cfg, p.remote.url);
      } catch (e) {
        errors.push({ code: 'remote_not_allowed', message: e.message });
        return out('attention');
      }
      return out('available');
    }
    const stored = p.location.path;
    if (!stored || !fs.existsSync(stored)) {
      errors.push({ code: 'missing', message: 'The folder no longer exists at its registered location (moved, renamed or deleted). The project and its history are kept; repair the location to continue.' });
      return out('missing');
    }
    let dir;
    try {
      const id = directoryIdForPath(this.cfg, stored);
      dir = resolveDirectory(this.cfg, id);
    } catch (e) {
      const outside = e instanceof ProjectError && (e.status === 403 || e.status === 400);
      errors.push({ code: outside ? 'outside_roots' : 'inaccessible', message: outside ? 'The folder is not inside an authorized project folder any more (Settings → Folders). Authorize its parent again or repair the location.' : `The folder cannot be read (${e.message}).` });
      return out('inaccessible');
    }
    let identity;
    try {
      identity = await repoIdentity(this.cfg, dir.real);
    } catch (e) {
      errors.push({ code: 'inaccessible', message: `Git could not inspect the folder (${redact(e.message)}).` });
      return out('inaccessible', { dir });
    }
    const exp = p.repo || { isGit: false };
    if (exp.isGit && !identity.isGit) errors.push({ code: 'repository_missing', message: 'This project was a Git repository, but the folder is no longer one (its .git is gone or it is now inside another repository). Nothing is touched; repair to accept a different folder or restore the repository.' });
    else if (exp.isGit && exp.rootCommits?.length && identity.rootCommits.length && !exp.rootCommits.some((c) => identity.rootCommits.includes(c))) errors.push({ code: 'repository_replaced', message: 'The folder now contains a different repository (its first commit differs from the one registered). It is not used until you repair the association and explicitly accept the change.' });
    else if (exp.isGit && exp.remoteKey && identity.remoteKey && exp.remoteKey !== identity.remoteKey) errors.push({ code: 'remote_changed', message: `The remote changed from ${exp.remoteUrl} to ${identity.remoteUrl}. Accept the new remote in the project settings if that is intended.` });
    else if (exp.isGit && exp.remoteKey && !identity.remoteKey) warnings.push({ code: 'remote_removed', message: `The remote ${exp.remoteUrl} is no longer configured.` });
    if (!exp.isGit && identity.isGit) warnings.push({ code: 'became_git', message: 'The folder is now a Git repository.' });
    return out(errors.length ? 'attention' : 'available', { identity, dir });
  }

  async validate(id, { persist = true } = {}) {
    const p = await this.find(id);
    const v = await this.inspect(p);
    const record = { status: v.status, errors: v.errors, warnings: v.warnings, checkedAt: v.checkedAt };
    if (persist) {
      await this.mutate((d) => {
        const q = d.projects.find((x) => x.id === p.id);
        if (!q) return;
        q.validation = record;
        // Trust on first use: the first successful look at a repository records its identity.
        if (v.identity && v.status === 'available' && p.kind === 'local') {
          const i = v.identity;
          q.repo = { ...(q.repo || {}), isGit: i.isGit, ...(i.isGit ? { rootCommits: i.rootCommits.length ? i.rootCommits : q.repo?.rootCommits || [], remoteName: i.remoteName, remoteUrl: i.remoteUrl, remoteKey: i.remoteKey, defaultBranch: i.defaultBranch } : {}) };
        }
      });
    }
    return { project: await this.find(id), validation: record, identity: v.identity, dir: v.dir };
  }

  // ── views ────────────────────────────────────────────────────────────────────────────────────

  view(p, { admin = false } = {}) {
    const v = p.validation || { status: 'attention', errors: [], warnings: [], checkedAt: null };
    const roots = authorizedRoots(this.cfg);
    const root = p.kind === 'local' ? roots.find((r) => r.key === p.location.rootKey) : null;
    return {
      id: p.id, name: p.name, kind: p.kind, archived: Boolean(p.archived), archivedAt: p.archivedAt || null,
      status: v.status, errors: v.errors || [], warnings: v.warnings || [], checkedAt: v.checkedAt,
      createdAt: p.createdAt, updatedAt: p.updatedAt, lastUsedAt: p.lastUsedAt || null, migratedFrom: p.migratedFrom || null,
      settings: p.settings || {},
      location: p.kind === 'local'
        ? { type: 'local', root: root?.label || null, rel: p.location.rel, label: `${root?.label || '…'}${p.location.rel ? `/${p.location.rel}` : ''}`, readOnly: Boolean(root?.readOnly), ...(admin ? { path: p.location.path } : {}) }
        : { type: 'remote', url: p.remote.url, webUrl: p.remote.webUrl, host: p.remote.host, owner: p.remote.owner, repo: p.remote.repo },
      repo: p.kind === 'local'
        ? { isGit: Boolean(p.repo?.isGit), remoteUrl: p.repo?.remoteUrl || null, remoteName: p.repo?.remoteName || null, defaultBranch: p.repo?.defaultBranch || null, firstCommit: p.repo?.rootCommits?.[0]?.slice(0, 12) || null }
        : { isGit: true, remoteUrl: p.remote.url, defaultBranch: p.remote.defaultBranch || null },
    };
  }

  /** Detailed git state of the current working tree (branch, dirty, remotes). Local projects only. */
  async status(id) {
    const { project, validation, identity } = await this.validate(id);
    return { project, validation, git: identity?.git ? publicGit(identity.git) : { isGit: false } };
  }

  // ── operations ───────────────────────────────────────────────────────────────────────────────

  async list({ q = '', status = '', archived = 'false', refresh = false } = {}) {
    const data = await this.load();
    const rows = [];
    for (const p of data.projects) {
      const fresh = p.validation?.checkedAt && Date.now() - Date.parse(p.validation.checkedAt) < FRESH_MS;
      if (refresh || !fresh) await this.validate(p.id).catch(() => {});
    }
    for (const p of (await this.load()).projects) {
      if (archived === 'false' && p.archived) continue;
      if (archived === 'only' && !p.archived) continue;
      if (status && p.validation?.status !== status) continue;
      if (q) {
        const hay = `${p.name} ${p.location?.rel || ''} ${p.location?.path || ''} ${p.remote?.url || ''} ${p.repo?.remoteUrl || ''}`.toLowerCase();
        if (!hay.includes(String(q).toLowerCase())) continue;
      }
      rows.push(p);
    }
    return rows.sort((a, b) => (b.lastUsedAt || b.createdAt).localeCompare(a.lastUsedAt || a.createdAt));
  }

  /** Resolve what a registration request points at, enforcing the authorized-roots policy. */
  resolveLocation(input, { admin }) {
    if (input.directoryId) return resolveDirectory(this.cfg, input.directoryId);
    if (input.path) {
      if (!admin) throw new ProjectError(403, 'Registering by path needs an authenticated session (set an access password) or a browser on the server machine. Pick the folder from the authorized list instead.');
      return resolveDirectory(this.cfg, directoryIdForPath(this.cfg, String(input.path)));
    }
    throw new ProjectError(400, 'give a directoryId (from the authorized folders) or, as an administrator, a path');
  }

  settingsFrom(input, defaults = {}) {
    const s = { ...defaults };
    if (input.workingMode !== undefined && input.workingMode !== '') {
      if (!WORKING_MODES.includes(input.workingMode)) throw new ProjectError(400, `workingMode must be one of ${WORKING_MODES.join(', ')}`);
      s.workingMode = input.workingMode;
    }
    if (input.defaultRef !== undefined) s.defaultRef = validateRef(input.defaultRef);
    return s;
  }

  async register(input = {}, { admin = false } = {}) {
    const kind = input.kind === 'remote' || (!input.kind && input.repoUrl) ? 'remote' : 'local';
    if (kind === 'remote') {
      const repo = parseRepoUrl(this.cfg, input.repoUrl); // credentials in the URL are rejected here
      const key = remoteKey(repo.url);
      const check = (list) => {
        const dup = list.filter((p) => (p.kind === 'remote' ? remoteKey(p.remote.url) : p.repo?.remoteKey) === key);
        const sameRemote = dup.filter((p) => p.kind === 'remote');
        if (sameRemote.length) throw conflict(`${repo.owner}/${repo.repo} is already registered as "${sameRemote[0].name}".`, sameRemote.map((p) => ({ type: 'remote_conflict', projectId: p.id, name: p.name, archived: Boolean(p.archived), resolution: 'Use the existing project, or remove its registration first.' })));
        const locals = dup.filter((p) => p.kind === 'local');
        if (locals.length && input.acknowledgeSameRepository !== true) throw conflict(`A local checkout of ${repo.owner}/${repo.repo} is already registered ("${locals[0].name}"). A remote project is a separate identity from a local checkout.`, locals.map((p) => ({ type: 'same_repository', projectId: p.id, name: p.name, resolution: 'Register it anyway with acknowledgeSameRepository: true, or use the existing local project.' })));
      };
      check((await this.load()).projects);
      let defaultBranch = null;
      let warning = null;
      if (input.check !== false) {
        try {
          defaultBranch = (await inspectRemote(this.cfg, { repoUrl: repo.url, ref: input.defaultRef })).defaultBranch;
        } catch (e) {
          if (input.check === true) throw e;
          warning = { code: 'unreachable', message: `The repository could not be reached to confirm it (${redact(e.message)}). It is registered; validate again when the network or token is fixed.` };
        }
      }
      const t = now();
      const rec = { id: newId(), name: cleanName(input.name, `${repo.owner}/${repo.repo}`), kind: 'remote', createdAt: t, updatedAt: t, archived: false, remote: { url: repo.url, webUrl: repo.webUrl, host: repo.host, owner: repo.owner, repo: repo.repo, defaultBranch }, settings: this.settingsFrom(input, { workingMode: 'clone' }), validation: { status: warning ? 'attention' : 'available', errors: warning ? [warning] : [], warnings: [], checkedAt: t } };
      await this.mutate((d) => { check(d.projects); d.projects.push(rec); });
      return rec;
    }

    const dir = this.resolveLocation(input, { admin });
    const ident = await repoIdentity(this.cfg, dir.real);
    if (!ident.isGit && input.workingMode === 'clone') throw new ProjectError(400, 'a folder that is not a Git repository can only use the "snapshot" working mode');
    const check = (list) => {
      const conflicts = [];
      for (const p of list) {
        if (p.kind !== 'local') continue;
        if (p.location.path === dir.real) conflicts.push({ type: 'path_conflict', projectId: p.id, name: p.name, archived: Boolean(p.archived), hard: true, resolution: p.archived ? 'Restore the archived project instead of registering this folder again.' : 'Open the existing project, or remove its registration first.' });
        else if ((ident.rootCommits.length && p.repo?.rootCommits?.some((c) => ident.rootCommits.includes(c))) || (ident.remoteKey && p.repo?.remoteKey === ident.remoteKey)) conflicts.push({ type: 'same_repository', projectId: p.id, name: p.name, archived: Boolean(p.archived), location: `${p.location.rel || path.basename(p.location.path)}`, resolution: 'This repository is already registered from another checkout. Register this checkout too with acknowledgeSameRepository: true (they stay separate projects), or use the existing one.' });
      }
      if (conflicts.some((c) => c.hard)) throw conflict(`This folder is already registered as "${conflicts.find((c) => c.hard).name}".`, conflicts);
      if (conflicts.length && input.acknowledgeSameRepository !== true) throw conflict(`This repository is already registered from another checkout ("${conflicts[0].name}").`, conflicts);
    };
    check((await this.load()).projects);
    const t = now();
    const rec = {
      id: newId(),
      name: cleanName(input.name, path.basename(dir.real) || dir.name),
      kind: 'local', createdAt: t, updatedAt: t, archived: false,
      location: { path: dir.real, rootKey: dir.root.key, rel: dir.rel },
      repo: ident.isGit ? { isGit: true, rootCommits: ident.rootCommits, remoteName: ident.remoteName, remoteUrl: ident.remoteUrl, remoteKey: ident.remoteKey, defaultBranch: ident.defaultBranch } : { isGit: false },
      settings: this.settingsFrom(input, { workingMode: ident.isGit ? 'clone' : 'snapshot' }),
      validation: { status: 'available', errors: [], warnings: [], checkedAt: t },
    };
    await this.mutate((d) => { check(d.projects); d.projects.push(rec); });
    return rec;
  }

  async update(id, patch = {}) {
    const p = await this.find(id);
    const next = {};
    if (patch.name !== undefined) next.name = cleanName(patch.name, p.name);
    const settings = this.settingsFrom(patch, p.settings || {});
    if (p.kind === 'local' && settings.workingMode === 'clone' && !p.repo?.isGit) throw new ProjectError(400, 'a folder that is not a Git repository can only use the "snapshot" working mode');
    if (p.kind === 'remote' && settings.workingMode !== 'clone') throw new ProjectError(400, 'remote projects always use an isolated clone');
    let remote;
    let repoPatch;
    if (patch.remoteUrl !== undefined && p.kind === 'remote') {
      if (patch.acceptNewRemote !== true) throw conflict('Changing the repository URL changes what this project is. Confirm with acceptNewRemote: true.', [{ type: 'identity_change', projectId: p.id, resolution: 'Send acceptNewRemote: true with the new URL (the project id and its history stay).' }]);
      const repo = parseRepoUrl(this.cfg, patch.remoteUrl);
      const key = remoteKey(repo.url);
      const dup = (await this.load()).projects.find((x) => x.id !== p.id && x.kind === 'remote' && remoteKey(x.remote.url) === key);
      if (dup) throw conflict(`${repo.owner}/${repo.repo} is already registered as "${dup.name}".`, [{ type: 'remote_conflict', projectId: dup.id, name: dup.name, resolution: 'Use that project or remove its registration first.' }]);
      remote = { ...p.remote, url: repo.url, webUrl: repo.webUrl, host: repo.host, owner: repo.owner, repo: repo.repo, defaultBranch: null };
    }
    if (patch.acceptRemoteChange === true && p.kind === 'local') {
      const { identity } = await this.validate(p.id, { persist: false });
      if (identity?.isGit) repoPatch = { ...p.repo, remoteName: identity.remoteName, remoteUrl: identity.remoteUrl, remoteKey: identity.remoteKey };
    }
    await this.mutate((d) => {
      const q = d.projects.find((x) => x.id === p.id);
      Object.assign(q, next, { settings, updatedAt: now() });
      if (remote) q.remote = remote;
      if (repoPatch) q.repo = repoPatch;
    });
    return (await this.validate(id)).project;
  }

  /** Point an existing project at another folder. A different repository needs an explicit acknowledgement. */
  async repair(id, input = {}, { admin = false } = {}) {
    const p = await this.find(id);
    if (p.kind !== 'local') throw new ProjectError(400, 'only local projects have a folder to repair; change a remote project\'s URL with an update');
    const dir = this.resolveLocation(input, { admin });
    const ident = await repoIdentity(this.cfg, dir.real);
    const other = (await this.load()).projects.find((x) => x.id !== p.id && x.kind === 'local' && x.location.path === dir.real);
    if (other) throw conflict(`That folder is already registered as "${other.name}".`, [{ type: 'path_conflict', projectId: other.id, name: other.name, hard: true, resolution: 'Repair to a different folder, or remove the other registration first.' }]);
    const exp = p.repo || { isGit: false };
    const problems = [];
    if (exp.isGit && !ident.isGit) problems.push('the folder is not a Git repository');
    else if (exp.isGit && exp.rootCommits?.length && ident.rootCommits.length && !exp.rootCommits.some((c) => ident.rootCommits.includes(c))) problems.push('its first commit differs: it is a different repository');
    else if (exp.isGit && exp.remoteKey && ident.remoteKey && exp.remoteKey !== ident.remoteKey) problems.push(`its remote is ${ident.remoteUrl}, not ${exp.remoteUrl}`);
    if (problems.length && input.acceptDifferentRepository !== true) throw conflict(`That folder does not look like "${p.name}": ${problems.join('; ')}.`, [{ type: 'identity_mismatch', projectId: p.id, resolution: 'If this folder really is the project now, repeat with acceptDifferentRepository: true. Its recorded identity is then replaced; the project id and history stay.' }]);
    await this.mutate((d) => {
      const q = d.projects.find((x) => x.id === p.id);
      q.location = { path: dir.real, rootKey: dir.root.key, rel: dir.rel };
      q.repo = ident.isGit ? { isGit: true, rootCommits: ident.rootCommits.length ? ident.rootCommits : problems.length ? [] : exp.rootCommits || [], remoteName: ident.remoteName, remoteUrl: ident.remoteUrl, remoteKey: ident.remoteKey, defaultBranch: ident.defaultBranch } : { isGit: false };
      if (!ident.isGit) q.settings = { ...q.settings, workingMode: 'snapshot' };
      q.updatedAt = now();
    });
    return (await this.validate(id)).project;
  }

  async setArchived(id, archived) {
    await this.find(id);
    await this.mutate((d) => {
      const q = d.projects.find((x) => x.id === id);
      q.archived = Boolean(archived);
      q.archivedAt = archived ? now() : null;
      q.updatedAt = now();
    });
    return this.find(id);
  }

  /** Remove the registration only. Files, repositories, runs, artifacts and terminals are untouched. */
  async remove(id, { confirm } = {}) {
    const p = await this.find(id);
    if (confirm !== p.name) throw new ProjectError(400, `Removing a registration needs confirmation: send confirm equal to the project name ("${p.name}"). Your folder, repository, runs and artifacts are not deleted.`);
    await this.mutate((d) => { d.projects = d.projects.filter((x) => x.id !== id); });
    return p;
  }

  async touch(id) {
    await this.mutate((d) => {
      const q = d.projects.find((x) => x.id === id);
      if (q) q.lastUsedAt = now();
    }).catch(() => {});
  }

  // ── use by other features ────────────────────────────────────────────────────────────────────

  /**
   * The one way features obtain a workspace from a project id. Re-validates on every call and refuses when the project is
   * archived, missing, inaccessible, or needs attention. Returns the project plus the canonical directory (local) or repo (remote).
   */
  async locate(id, { purpose = 'use', writable = false } = {}) {
    const { project, validation, dir } = await this.validate(id);
    if (project.archived) throw new ProjectError(409, `Project "${project.name}" is archived. Restore it to ${purpose}.`);
    if (validation.status !== 'available') {
      const why = validation.errors.map((e) => e.message).join(' ') || `status ${validation.status}`;
      throw new ProjectError(409, `Project "${project.name}" is ${validation.status}: ${why}`);
    }
    if (project.kind === 'local') {
      if (writable && dir.readOnly) throw new ProjectError(403, `Project "${project.name}" is in a read-only folder; ${purpose} needs a writable one.`);
      return { project, dir };
    }
    return { project, repo: parseRepoUrl(this.cfg, project.remote.url) };
  }

  // ── lazy migration of earlier runs ───────────────────────────────────────────────────────────

  /**
   * Give every earlier run that worked on an existing project a project id, creating a registration for each distinct
   * location or repository exactly once. Idempotent; runs are only changed by adding projectId/projectName.
   */
  async adoptRuns(store) {
    const rows = await store.list();
    let adopted = 0;
    for (const row of rows) {
      if (row.projectId || !row.source) continue;
      let run;
      try { run = await store.load(row.id); } catch { continue; }
      if (run.projectId || !run.source || run.source.mode === 'new') continue;
      const id = await this.adopt(run.source, run.createdAt);
      if (!id) continue;
      run.projectId = id;
      run.projectName = (await this.find(id)).name;
      run.source.projectId = id;
      await store.save(run);
      adopted++;
    }
    return adopted;
  }

  async adopt(source, createdAt) {
    const data = await this.load();
    if (source.mode === 'github') {
      let key;
      try { key = remoteKey(parseRepoUrl(this.cfg, source.repoUrl).url); } catch { return null; }
      const hit = data.projects.find((p) => p.kind === 'remote' && remoteKey(p.remote.url) === key);
      if (hit) return hit.id;
      const rec = await this.register({ kind: 'remote', repoUrl: source.repoUrl, name: source.label, check: false });
      await this.mutate((d) => { const q = d.projects.find((x) => x.id === rec.id); q.migratedFrom = 'runs'; if (createdAt) q.createdAt = createdAt; });
      return rec.id;
    }
    let dir;
    try { dir = resolveDirectory(this.cfg, source.directoryId); } catch { return null; } // no longer authorized: the run keeps its own label
    const hit = data.projects.find((p) => p.kind === 'local' && p.location.path === dir.real);
    if (hit) return hit.id;
    const rec = await this.register({ directoryId: source.directoryId, name: source.label || dir.name, acknowledgeSameRepository: true });
    await this.mutate((d) => { const q = d.projects.find((x) => x.id === rec.id); q.migratedFrom = 'runs'; if (createdAt) q.createdAt = createdAt; });
    return rec.id;
  }
}
