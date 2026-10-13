// projects list|inspect|connect|use|current|init — project selection by opaque id, never by arbitrary path authority.
import { EXIT, table, usageError } from '../core.js';
import { resolveProject } from '../ops.js';
import { readState, writeState } from '../state.js';
import { startRun, RUN_OPTIONS } from './runs.js';

const label = (p) => p.label || p.directoryId || p.repoUrl;

async function list(ctx) {
  const { out } = ctx;
  const client = await ctx.api();
  const { directories, roots } = await client.get('/api/projects/directories', { timeoutMs: 60_000 });
  const current = readState(ctx.env).project;
  const rows = directories.map((d) => ({ ...d, current: current?.directoryId === d.id }));
  out.data({ projects: rows.map((d) => ({ id: d.id, name: d.name, root: d.root, readOnly: d.readOnly, git: d.git, current: d.current })), roots });
  if (!rows.length) {
    out.print('No authorized projects.');
    out.print(out.dim('Authorize a folder (the backend can then read it): da-prompt config set projectRoots /path/to/projects'));
    out.print(out.dim('Or work on GitHub directly: da-prompt run "task" --project owner/repo'));
    return EXIT.OK;
  }
  out.print(table(rows, [
    { title: '', get: (d) => (d.current ? '*' : '') },
    { title: 'name', key: 'name', max: 30 },
    { title: 'id', key: 'id', max: 40 },
    { title: 'access', get: (d) => (d.readOnly ? 'read-only' : 'writable') },
    { title: 'git', get: (d) => (d.git?.isGit ? `${d.git.branch || 'detached'}${d.git.dirty ? ' (uncommitted changes)' : ''}` : 'not a repository'), max: 40 },
  ], out));
  out.print(out.dim('Ids are opaque: the backend maps them to folders inside its authorized roots. * = selected by "projects use".'));
  return EXIT.OK;
}

async function inspect(ctx) {
  const { out, opts } = ctx;
  const client = await ctx.api();
  const spec = ctx.args[0] || opts.project;
  const saved = readState(ctx.env).project;
  const source = spec ? await resolveProject(client, spec, { ref: opts.ref, workingMode: opts['working-mode'] }) : saved;
  if (!source) throw usageError('Which project?', 'da-prompt projects inspect <project>, or select one with "projects use".');
  const body = { source: { mode: source.mode, directoryId: source.directoryId, repoUrl: source.repoUrl, ref: source.ref, workingMode: source.workingMode } };
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
  const project = { mode: source.mode, label: source.label, ...(source.directoryId ? { directoryId: source.directoryId } : {}), ...(source.repoUrl ? { repoUrl: source.repoUrl } : {}), ...(source.ref ? { ref: source.ref } : {}), ...(source.workingMode ? { workingMode: source.workingMode } : {}), ...(source.readOnly ? { readOnly: true } : {}) };
  writeState({ project }, ctx.env);
  out.data({ selected: project });
  out.print(`${out.green('✓')} Selected ${label(project)}${project.readOnly ? ' (read-only: changes can be reviewed but not applied here)' : ''}`);
  out.info('Only the project id is remembered; nothing is granted by selecting it.');
  return EXIT.OK;
}

async function connect(ctx) {
  const { out, opts } = ctx;
  const spec = ctx.args[0];
  if (!/^(https:\/\/|[\w.-]+\/[\w.-]+$)/.test(spec)) throw usageError('Give a GitHub repository as owner/repo or an https URL.', 'Example: da-prompt projects connect acme/api --ref develop');
  const client = await ctx.api();
  const source = await resolveProject(client, spec, { ref: opts.ref });
  const r = await client.post('/api/projects/inspect', { source: { mode: 'github', repoUrl: source.repoUrl, ref: source.ref } }, { timeoutMs: 120_000 });
  writeState({ project: { mode: 'github', label: r.repo, repoUrl: source.repoUrl, ...(r.ref?.name ? { ref: r.ref.name } : {}) } }, ctx.env);
  out.data({ connected: r.repo, ref: r.ref, defaultBranch: r.defaultBranch, canPublish: r.canPublish });
  out.print(`${out.green('✓')} Connected ${r.repo} @ ${r.ref?.name || r.defaultBranch} and selected it.`);
  out.print(r.summary);
  for (const w of r.warnings || []) out.print(`${out.yellow('!')} ${w}`);
  if (!r.canPublish) out.print(out.dim('To open pull requests later: printf %s "$GITHUB_TOKEN" | da-prompt config set githubToken --stdin'));
  return EXIT.OK;
}

async function current(ctx) {
  const p = readState(ctx.env).project;
  ctx.out.data({ project: p || null });
  if (!p) {
    ctx.out.print('No project selected.');
    return EXIT.OK;
  }
  ctx.out.print(`${label(p)}${p.ref ? ` @ ${p.ref}` : ''}${p.readOnly ? '  (read-only)' : ''}`);
  return EXIT.OK;
}

async function clear(ctx) {
  writeState({ project: undefined }, ctx.env);
  ctx.out.data({ selected: null });
  ctx.out.print('Project selection cleared.');
  return EXIT.OK;
}

export default [
  { path: ['projects', 'list'], summary: 'Projects the backend is authorized to read (opaque ids, read-only vs writable).', run: list, examples: ['da-prompt projects list --json'] },
  { path: ['projects', 'inspect'], summary: 'Stack, git state and isolation for a project.', args: '[project]', maxArgs: 1, options: { project: { type: 'string', valueName: 'PROJECT', description: 'Same as the argument.' }, ref: { type: 'string', valueName: 'REF', description: 'GitHub ref.' }, 'working-mode': { type: 'string', valueName: 'MODE', description: 'clone or snapshot.' } }, run: inspect },
  { path: ['projects', 'connect'], summary: 'Connect a GitHub repository (and ref) and select it.', args: '<owner/repo|https-url>', minArgs: 1, maxArgs: 1, options: { ref: { type: 'string', valueName: 'REF', description: 'Branch, tag or commit.' } }, run: connect },
  { path: ['projects', 'use'], summary: 'Select the project later commands use by default.', description: 'Accepts an id, a name from "projects list", a path inside an authorized folder (the backend maps it to an id and refuses anything outside), or owner/repo.', args: '<project>', minArgs: 1, maxArgs: 1, options: { ref: { type: 'string', valueName: 'REF', description: 'GitHub ref.' }, 'working-mode': { type: 'string', valueName: 'MODE', description: 'clone (committed state) or snapshot (working tree).' } }, examples: ['da-prompt projects use my-app', 'da-prompt projects use .', 'da-prompt projects use acme/api --ref develop'], run: use },
  { path: ['projects', 'current'], summary: 'Show the selected project.', run: current },
  { path: ['projects', 'clear'], summary: 'Forget the selected project.', run: clear },
  { path: ['projects', 'init'], summary: 'Start a new application from an idea (the output goes to the configured output folder).', description: 'Equivalent to: da-prompt run "<idea>" --new', args: '"<idea>"', minArgs: 1, maxArgs: 200, options: Object.fromEntries(Object.entries(RUN_OPTIONS).filter(([k]) => !['project', 'ref', 'working-mode', 'new', 'publish'].includes(k))), run: (c) => startRun(c, { forceNew: true }) },
];
