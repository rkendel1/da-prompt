// projects list|show|add|rename|archive|restore|remove|repair|validate|use|current|clear|inspect|connect|init — the persistent
// registry (see src/registry.js) through the same backend the browser uses. Paths are mapped to opaque ids by the backend.
import readline from 'node:readline/promises';
import path from 'node:path';
import { CliError, EXIT, table, usageError, ago } from '../core.js';
import { resolveProject } from '../ops.js';
import { readState, writeState } from '../state.js';
import { startRun, RUN_OPTIONS } from './runs.js';

const label = (p) => p.label || p.name || p.directoryId || p.repoUrl;
const STATUS_HINT = { available: '', missing: 'the folder moved or was deleted', inaccessible: 'not readable or no longer inside an authorized folder', attention: 'identity or remote changed' };
const paint = (out, status) => (status === 'available' ? out.green(status) : status === 'attention' ? out.yellow(status) : out.red(status));

const getProject = async (ctx, spec) => {
  const client = await ctx.api();
  const target = await resolveProject(client, spec || readState(ctx.env).project?.projectId || readState(ctx.env).project?.label);
  if (target.mode !== 'registered') throw new CliError(`"${spec}" is not a registered project.`, { code: EXIT.NOT_FOUND, hint: `Register it: da-prompt projects add ${spec || '<path|owner/repo>'}` });
  return { client, id: target.projectId };
};

const conflictError = (e) => {
  const c = e.details?.conflicts?.[0];
  if (!c) return e;
  const hint = [c.resolution, c.projectId ? `Existing project: ${c.projectId}${c.name ? ` ("${c.name}")` : ''}` : ''].filter(Boolean).join(' ');
  return new CliError(e.message, { code: EXIT.DENIED, hint, details: e.details });
};

async function list(ctx) {
  const { out, opts } = ctx;
  const client = await ctx.api();
  const q = new URLSearchParams();
  if (opts.status) q.set('status', opts.status);
  if (opts.all) q.set('archived', 'all');
  if (opts.archived) q.set('archived', 'only');
  if (opts.search) q.set('q', opts.search);
  if (opts.refresh) q.set('refresh', '1');
  const { projects } = await client.get(`/api/projects?${q}`, { timeoutMs: 60_000 });
  const folders = opts.folders || !projects.length ? (await client.get('/api/projects/directories', { timeoutMs: 60_000 })).directories : [];
  const current = readState(ctx.env).project;
  out.data({ projects, ...(folders.length || opts.folders ? { authorizedFolders: folders.map((d) => ({ id: d.id, name: d.name, root: d.root, readOnly: d.readOnly, git: d.git })) } : {}) });
  if (projects.length) {
    out.print(table(projects.map((p) => ({ ...p, current: current?.projectId === p.id })), [
      { title: '', get: (p) => (p.current ? '*' : '') },
      { title: 'name', key: 'name', max: 28 },
      { title: 'id', key: 'id', max: 24 },
      { title: 'status', get: (p) => (p.archived ? 'archived' : paint(out, p.status)) },
      { title: 'type', get: (p) => (p.kind === 'remote' ? 'remote' : p.repo.isGit ? 'git' : 'folder') },
      { title: 'where', get: (p) => (p.kind === 'remote' ? `${p.location.host}/${p.location.owner}/${p.location.repo}` : p.location.path || p.location.label), max: 44 },
      { title: 'used', get: (p) => (p.lastUsedAt ? ago(p.lastUsedAt) : '—') },
    ], out));
    for (const p of projects.filter((x) => x.status !== 'available' && !x.archived)) out.print(out.yellow(`! ${p.name}: ${p.errors?.[0]?.message || STATUS_HINT[p.status]}  → da-prompt projects show ${p.id}`));
    out.print(out.dim('* = selected by "projects use". Projects are durable: renaming or moving a folder keeps the id (repair with "projects repair").'));
  } else out.print('No registered projects yet. Register one once: da-prompt projects add <path|owner/repo>');
  if (folders.length) {
    out.print('');
    out.print(out.bold('Authorized folders') + out.dim('  (register with: da-prompt projects add <path>)'));
    out.print(table(folders, [{ title: 'name', key: 'name', max: 30 }, { title: 'access', get: (d) => (d.readOnly ? 'read-only' : 'writable') }, { title: 'git', get: (d) => (d.git?.isGit ? `${d.git.branch || 'detached'}${d.git.dirty ? ' (uncommitted changes)' : ''}` : 'not a repository'), max: 40 }], out));
  }
  return EXIT.OK;
}

async function show(ctx) {
  const { out } = ctx;
  const { client, id } = await getProject(ctx, ctx.args[0]);
  const r = await client.get(`/api/projects/${id}`, { timeoutMs: 60_000 });
  const p = r.project;
  out.data(r);
  out.print(`${out.bold(p.name)}  ${p.archived ? 'archived' : paint(out, p.status)}   ${out.dim(p.id)}`);
  out.print(`  type       ${p.kind === 'remote' ? 'remote repository' : p.repo.isGit ? 'local git repository' : 'local folder'}`);
  out.print(`  location   ${p.kind === 'remote' ? p.location.url : p.location.path || p.location.label}${p.location.readOnly ? '  (read-only)' : ''}`);
  if (r.git?.isGit) out.print(`  branch     ${r.git.branch || 'detached'} · ${r.git.dirty ? `${r.git.counts.staged} staged, ${r.git.counts.unstaged} modified, ${r.git.counts.untracked} untracked` : 'clean'}`);
  out.print(`  remote     ${p.repo.remoteUrl || '—'}`);
  out.print(`  settings   working mode ${p.settings.workingMode || '—'}${p.settings.defaultRef ? `, ref ${p.settings.defaultRef}` : ''}`);
  out.print(`  runs       ${r.runs}   (da-prompt runs list --project ${p.name})`);
  for (const e of p.errors) out.print(`${out.yellow('!')} ${e.message}`);
  for (const w of p.warnings) out.print(out.dim(`  ${w.message}`));
  if (p.status === 'missing' || p.status === 'attention') out.print(out.dim(`Repair: da-prompt projects repair ${p.id} <path>`));
  return p.status === 'available' || p.archived ? EXIT.OK : EXIT.ATTENTION;
}

async function add(ctx) {
  const { out, opts } = ctx;
  const client = await ctx.api();
  const spec = ctx.args[0];
  const remote = /^(https:\/\/|[\w.-]+\/[\w.-]+$)/.test(spec) && !/^(\.|\/|~)/.test(spec);
  const body = remote ? { kind: 'remote', repoUrl: spec } : { kind: 'local', path: path.resolve(spec.startsWith('~') ? spec.replace(/^~/, ctx.env.HOME || '') : spec) };
  if (opts.name) body.name = opts.name;
  if (opts['working-mode']) body.workingMode = opts['working-mode'];
  if (opts.ref) body.defaultRef = opts.ref;
  if (opts['same-repository']) body.acknowledgeSameRepository = true;
  if (remote && opts['no-check']) body.check = false;
  let r;
  try {
    r = await client.post('/api/projects', body, { timeoutMs: 120_000 });
  } catch (e) {
    throw conflictError(e);
  }
  const p = r.project;
  out.data(r);
  out.print(`${out.green('✓')} Registered ${out.bold(p.name)}  ${out.dim(p.id)}  (${p.kind === 'remote' ? 'remote repository' : p.repo.isGit ? 'git repository' : 'folder'}, ${p.status})`);
  for (const e of p.errors) out.print(`${out.yellow('!')} ${e.message}`);
  if (opts.use) {
    writeState({ project: { mode: 'registered', projectId: p.id, label: p.name, kind: p.kind } }, ctx.env);
    out.print('Selected it for later commands.');
  } else out.print(out.dim(`Select it with: da-prompt projects use ${p.name}   ·  nothing was cloned, changed or deleted.`));
  return EXIT.OK;
}

async function rename(ctx) {
  const { client, id } = await getProject(ctx, ctx.args[0]);
  const r = await client.patch(`/api/projects/${id}`, { name: ctx.args.slice(1).join(' ') });
  ctx.out.data(r);
  ctx.out.print(`${ctx.out.green('✓')} Renamed to "${r.project.name}" (id ${r.project.id} unchanged)`);
  return EXIT.OK;
}

const setArchived = (archive) => async (ctx) => {
  const { client, id } = await getProject(ctx, ctx.args[0]);
  const r = await client.post(`/api/projects/${id}/${archive ? 'archive' : 'restore'}`, {});
  ctx.out.data(r);
  ctx.out.print(`${ctx.out.green('✓')} ${archive ? 'Archived' : 'Restored'} "${r.project.name}". ${archive ? 'History is kept; no new work starts until you restore it.' : ''}`);
  return EXIT.OK;
};

async function remove(ctx) {
  const { out, opts } = ctx;
  const { client, id } = await getProject(ctx, ctx.args[0]);
  const p = (await client.get(`/api/projects/${id}`)).project;
  let confirm = opts['confirm-name'];
  if (!confirm) {
    if (!opts.yes && !(ctx.io.stdin.isTTY && process.stdout.isTTY)) throw new CliError(`Removing "${p.name}" needs explicit confirmation in a non-interactive session.`, { code: EXIT.USAGE, hint: `Pass --yes (confirms the name "${p.name}") or --confirm-name "${p.name}". Your files, runs and artifacts are not deleted.` });
    if (opts.yes) confirm = p.name;
    else {
      const rl = readline.createInterface({ input: ctx.io.stdin, output: process.stderr });
      try { confirm = (await rl.question(`Remove the registration of "${p.name}"? Files, runs and artifacts are NOT deleted. Type its name to confirm: `)).trim(); } finally { rl.close(); }
    }
  }
  const r = await client.del(`/api/projects/${id}`, { body: { confirm } });
  out.data(r);
  out.print(`${out.green('✓')} Removed the registration of "${r.name}". ${r.note}`);
  if (readState(ctx.env).project?.projectId === id) writeState({ project: undefined }, ctx.env);
  return EXIT.OK;
}

async function repair(ctx) {
  const { out, opts } = ctx;
  const { client, id } = await getProject(ctx, ctx.args[0]);
  const body = { path: path.resolve(ctx.args[1].startsWith('~') ? ctx.args[1].replace(/^~/, ctx.env.HOME || '') : ctx.args[1]) };
  if (opts['accept-different-repository']) body.acceptDifferentRepository = true;
  let r;
  try {
    r = await client.post(`/api/projects/${id}/repair`, body, { timeoutMs: 120_000 });
  } catch (e) {
    throw conflictError(e);
  }
  out.data(r);
  out.print(`${out.green('✓')} "${r.project.name}" now points at ${r.project.location.path || r.project.location.label} (${r.project.status}). The id ${r.project.id} and its history are unchanged.`);
  return r.project.status === 'available' ? EXIT.OK : EXIT.ATTENTION;
}

async function validate(ctx) {
  const { out } = ctx;
  const { client, id } = await getProject(ctx, ctx.args[0]);
  const r = await client.post(`/api/projects/${id}/validate`, {});
  out.data(r);
  out.print(`${r.project.name}: ${paint(out, r.project.status)}`);
  for (const e of r.project.errors) out.print(`${out.yellow('!')} ${e.message}`);
  return r.project.status === 'available' ? EXIT.OK : EXIT.ATTENTION;
}

async function inspect(ctx) {
  const { out, opts } = ctx;
  const client = await ctx.api();
  const spec = ctx.args[0] || opts.project;
  const saved = readState(ctx.env).project;
  const source = spec ? await resolveProject(client, spec, { ref: opts.ref, workingMode: opts['working-mode'] }) : saved;
  if (!source) throw usageError('Which project?', 'da-prompt projects inspect <project>, or select one with "projects use".');
  const body = { source: source.projectId ? { projectId: source.projectId } : { mode: source.mode, directoryId: source.directoryId, repoUrl: source.repoUrl, ref: source.ref, workingMode: source.workingMode } };
  const r = await client.post('/api/projects/inspect', body, { timeoutMs: 120_000 });
  out.data(r);
  out.print(`${out.bold(label(source))}`);
  if (r.summary) out.print(r.summary);
  for (const [k, v] of Object.entries(r).filter(([k]) => ['stack', 'branch', 'defaultBranch', 'dirty', 'isolation', 'workingMode', 'canPublish', 'readOnly'].includes(k))) out.print(`  ${k.padEnd(14)} ${Array.isArray(v) ? v.join(', ') : v}`);
  for (const w of r.warnings || []) out.print(`${out.yellow('!')} ${w}`);
  return EXIT.OK;
}

async function use(ctx) {
  const { out, opts } = ctx;
  const client = await ctx.api();
  const source = await resolveProject(client, ctx.args[0], { ref: opts.ref, workingMode: opts['working-mode'] });
  const project = { mode: source.mode, label: source.label, ...(source.projectId ? { projectId: source.projectId, kind: source.kind } : {}), ...(source.directoryId ? { directoryId: source.directoryId } : {}), ...(source.repoUrl ? { repoUrl: source.repoUrl } : {}), ...(source.ref ? { ref: source.ref } : {}), ...(source.workingMode ? { workingMode: source.workingMode } : {}), ...(source.readOnly ? { readOnly: true } : {}) };
  writeState({ project }, ctx.env);
  out.data({ selected: project });
  out.print(`${out.green('✓')} Selected ${label(project)}${project.projectId ? `  ${out.dim(project.projectId)}` : ' (not registered: register it once with "da-prompt projects add")'}${project.readOnly ? ' (read-only: changes can be reviewed but not applied here)' : ''}`);
  out.info('Only the project id is remembered; nothing is granted by selecting it.');
  return EXIT.OK;
}

async function current(ctx) {
  const p = readState(ctx.env).project;
  ctx.out.data({ project: p || null });
  if (!p) {
    ctx.out.print('No project selected.');
    return EXIT.OK;
  }
  ctx.out.print(`${label(p)}${p.projectId ? `  ${p.projectId}` : ''}${p.ref ? ` @ ${p.ref}` : ''}${p.readOnly ? '  (read-only)' : ''}`);
  return EXIT.OK;
}

async function clear(ctx) {
  writeState({ project: undefined }, ctx.env);
  ctx.out.data({ selected: null });
  ctx.out.print('Project selection cleared.');
  return EXIT.OK;
}

const ref = { type: 'string', valueName: 'REF', description: 'GitHub ref.' };
const mode = { type: 'string', valueName: 'MODE', description: 'clone (committed state) or snapshot (working tree).' };

export default [
  { path: ['projects', 'list'], summary: 'Registered projects (durable), with live status; --folders also lists authorized folders.', options: { status: { type: 'string', valueName: 'STATUS', description: 'available, missing, inaccessible or attention.' }, search: { type: 'string', valueName: 'TEXT', description: 'Name, folder or remote contains.' }, all: { type: 'boolean', description: 'Include archived projects.' }, archived: { type: 'boolean', description: 'Only archived projects.' }, folders: { type: 'boolean', description: 'Also list authorized folders you could register.' }, refresh: { type: 'boolean', description: 'Re-validate every project now.' } }, run: list, examples: ['da-prompt projects list --json', 'da-prompt projects list --status missing'] },
  { path: ['projects', 'show'], summary: 'One project: identity, location, git state, problems.', args: '[project]', maxArgs: 1, run: show },
  { path: ['projects', 'add'], summary: 'Register a local folder/repository or a remote repository once.', description: 'A path must be inside an authorized folder (the backend refuses anything else). Nothing is cloned, changed or deleted, and no credentials are stored. A folder or repository that is already registered is a conflict, not a duplicate.', args: '<path|owner/repo|url>', minArgs: 1, maxArgs: 1, options: { name: { type: 'string', valueName: 'NAME', description: 'Display name (default: folder or repository name).' }, 'working-mode': mode, ref: { type: 'string', valueName: 'REF', description: 'Default branch/tag for tasks on this project.' }, 'same-repository': { type: 'boolean', description: 'Register another checkout of an already-registered repository as a separate project.' }, 'no-check': { type: 'boolean', description: 'Remote: do not contact the repository.' }, use: { type: 'boolean', description: 'Also select it for later commands.' } }, examples: ['da-prompt projects add ~/code/my-app --use', 'da-prompt projects add acme/api --ref develop'], run: add },
  { path: ['projects', 'rename'], summary: 'Change the display name (the id never changes).', args: '<project> <new name...>', minArgs: 2, maxArgs: 20, run: rename },
  { path: ['projects', 'archive'], summary: 'Make a project inactive without deleting anything.', args: '<project>', minArgs: 1, maxArgs: 1, run: setArchived(true) },
  { path: ['projects', 'restore'], summary: 'Reactivate an archived project.', args: '<project>', minArgs: 1, maxArgs: 1, run: setArchived(false) },
  { path: ['projects', 'remove'], summary: 'Remove the registration only (files, repository, runs and artifacts are kept).', args: '<project>', minArgs: 1, maxArgs: 1, options: { yes: { type: 'boolean', description: 'Confirm (the project\'s own name is sent as the confirmation).' }, 'confirm-name': { type: 'string', valueName: 'NAME', description: 'The exact project name.' } }, run: remove },
  { path: ['projects', 'repair'], summary: 'Point a project at its new folder (identity is checked from Git).', description: 'A folder holding a different repository is refused unless you pass --accept-different-repository.', args: '<project> <path>', minArgs: 2, maxArgs: 2, options: { 'accept-different-repository': { type: 'boolean', description: 'Accept that this folder is now the project (replaces its recorded identity).' } }, run: repair },
  { path: ['projects', 'validate'], summary: 'Re-check a project against the host now (exit 6 if it needs attention).', args: '[project]', maxArgs: 1, run: validate },
  { path: ['projects', 'inspect'], summary: 'Stack, git state and isolation for a project.', args: '[project]', maxArgs: 1, options: { project: { type: 'string', valueName: 'PROJECT', description: 'Same as the argument.' }, ref, 'working-mode': mode }, run: inspect },
  { path: ['projects', 'connect'], summary: 'Register a GitHub repository (and default ref) and select it.', args: '<owner/repo|https-url>', minArgs: 1, maxArgs: 1, options: { ref, name: { type: 'string', valueName: 'NAME', description: 'Display name.' } }, async run(ctx) {
    if (!/^(https:\/\/|[\w.-]+\/[\w.-]+$)/.test(ctx.args[0])) throw usageError('Give a GitHub repository as owner/repo or an https URL.', 'Example: da-prompt projects connect acme/api --ref develop');
    return add({ ...ctx, opts: { ...ctx.opts, use: true } });
  } },
  { path: ['projects', 'use'], summary: 'Select the project later commands use by default.', description: 'Accepts a registered project (id or name), an authorized folder name, a path inside an authorized folder, or owner/repo.', args: '<project>', minArgs: 1, maxArgs: 1, options: { ref, 'working-mode': mode }, examples: ['da-prompt projects use my-app', 'da-prompt projects use .', 'da-prompt projects use acme/api --ref develop'], run: use },
  { path: ['projects', 'current'], summary: 'Show the selected project.', run: current },
  { path: ['projects', 'clear'], summary: 'Forget the selected project.', run: clear },
  { path: ['projects', 'init'], summary: 'Start a new application from an idea (the output goes to the configured output folder).', description: 'Equivalent to: da-prompt run "<idea>" --new', args: '"<idea>"', minArgs: 1, maxArgs: 200, options: Object.fromEntries(Object.entries(RUN_OPTIONS).filter(([k]) => !['project', 'ref', 'working-mode', 'new', 'publish'].includes(k))), run: (c) => startRun(c, { forceNew: true }) },
];
