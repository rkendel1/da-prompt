#!/usr/bin/env node
// Headless runner: `npm run factory -- "a habit tracker" --requirements "..." --provider offline`
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { RunStore } from './store.js';
import { Factory } from './factory.js';
import { PreviewManager } from './deploy.js';
import { listDirectories, directoryIdForPath, ProjectError } from './project.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    requirements: { type: 'string' },
    stack: { type: 'string' },
    limits: { type: 'string' },
    tools: { type: 'string' },
    provider: { type: 'string', short: 'p' },
    model: { type: 'string', short: 'm' },
    'planner-model': { type: 'string' },
    'planner-provider': { type: 'string' },
    output: { type: 'string', short: 'o' },
    'num-ctx': { type: 'string' },
    'tool-mode': { type: 'string' },
    providers: { type: 'boolean' },
    parallel: { type: 'string' },
    directory: { type: 'string', short: 'd' },
    repo: { type: 'string' },
    ref: { type: 'string' },
    'working-mode': { type: 'string' },
    publish: { type: 'boolean' },
    'allow-install': { type: 'boolean' },
    deploy: { type: 'boolean' },
    'list-directories': { type: 'boolean' },
    'no-deploy': { type: 'boolean' },
    'keep-alive': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const cfg = loadConfig();
const store = new RunStore(cfg.dataDir);
const previews = new PreviewManager({ max: cfg.maxPreviews });
const factory = new Factory({ cfg, store, previews });

if (values.providers) {
  const { providers, defaultProvider } = await factory.providers.discover({ refresh: true });
  for (const p of providers) {
    const mark = p.status === 'ready' ? '✓' : '·';
    console.log(`${mark} ${p.id.padEnd(11)} ${p.label.padEnd(22)} ${p.status}${p.message ? ` — ${p.message}` : ''}${p.id === defaultProvider ? '  (default)' : ''}`);
    for (const m of (p.models || []).slice(0, 25)) console.log(`      ${m.id === p.defaultModel ? '*' : ' '} ${m.id}${m.params ? ` (${m.params})` : ''}${m.tools === false ? '  [no native tools → JSON mode]' : ''}`);
  }
  process.exit(0);
}

if (values['list-directories']) {
  const { roots, directories } = await listDirectories(cfg);
  if (!roots.length) console.log('No project roots configured. Set FACTORY_PROJECT_ROOTS (and optionally FACTORY_PROJECT_ROOTS_READONLY).');
  for (const d of directories) {
    const g = d.git.isGit ? `git ${d.git.branch || 'detached'}${d.git.dirty ? ' · uncommitted changes' : ' · clean'}` : 'not a git repository';
    console.log(`${d.id}  ${d.name.padEnd(24)} ${d.readOnly ? '[read-only] ' : ''}${g}`);
  }
  process.exit(0);
}

if (values.help || positionals.length === 0) {
  console.log(`Usage: da-prompt "<idea>" [--requirements ..] [--stack ..] [--limits ..] [--tools ..]
                 [--provider ID] [--model NAME] [--planner-provider ID] [--planner-model NAME] [--num-ctx N] [--tool-mode auto|native|json]
                 [--output DIR]  copy the finished project to DIR (must be new or empty)
                 [--parallel N] [--no-deploy] [--keep-alive]
  Existing projects (instead of a new app; the idea becomes "what do you want to change?"):
                 [--directory PATH|ID]   a local project inside FACTORY_PROJECT_ROOTS (the original is never edited)
                 [--repo URL|owner/repo] [--ref BRANCH|TAG|SHA]   a GitHub repository, cloned into an isolated workspace
                 [--working-mode clone|snapshot]   local only: clone = committed state, snapshot = working tree incl. uncommitted
                 [--publish]             GitHub only: push the run branch and open a pull request (needs GITHUB_TOKEN)
                 [--allow-install]       permit dependency installs (they execute project scripts)
                 [--deploy]              authorize a local preview of the result (existing projects are not deployed by default)
                 --output DIR            with a project source, exports the resulting project tree to a NEW folder (not into the source)
       da-prompt --providers        list providers and models that are available right now
       da-prompt --list-directories list the directories da-prompt is authorized to work on`);
  process.exit(values.help ? 0 : 1);
}

if (values.directory && values.repo) {
  console.error('Choose one source: --directory or --repo.');
  process.exit(1);
}
let source;
try {
  if (values.directory) source = { mode: 'local', directoryId: directoryIdForPath(cfg, values.directory), workingMode: values['working-mode'], allowInstall: values['allow-install'] };
  else if (values.repo) source = { mode: 'github', repoUrl: values.repo, ref: values.ref, publish: values.publish, allowInstall: values['allow-install'] };
  else if (values.ref || values.publish || values['working-mode'] || values['allow-install']) throw new ProjectError(400, '--ref, --publish, --working-mode and --allow-install need --directory or --repo');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

let run;
try {
run = await factory.createRun({
  source,
  idea: positionals.join(' '),
  requirements: values.requirements,
  stack: values.stack,
  limits: values.limits,
  tools: values.tools,
  provider: values.provider,
  model: values.model,
  planner: { provider: values['planner-provider'], model: values['planner-model'] },
  outputDir: values.output,
  providerOptions: { numCtx: values['num-ctx'], toolMode: values['tool-mode'] },
  settings: { maxParallel: values.parallel, deploy: source ? Boolean(values.deploy) && !values['no-deploy'] : !values['no-deploy'] },
});
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const c = (n, s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
store.subscribe(run.id, (e) => {
  switch (e.type) {
    case 'run.status': return console.log(c(1, `● ${e.status}`));
    case 'layer': return console.log(c(36, `  layer ${e.layer}: ${e.state}`));
    case 'plan': return console.log(`  plan: ${e.tasks} tasks in ${e.levels} levels`);
    case 'task': return console.log(`  [${e.taskId}] ${e.status}${e.attempt ? ` (attempt ${e.attempt})` : ''}${e.summary ? ` — ${e.summary}` : ''}`);
    case 'tool': return console.log(c(2, `    ${e.taskId} › ${e.tool} ${e.input?.path || e.input?.command || ''}${e.ok ? '' : ' ✗'}`));
    case 'verify': return console.log(`  verify ${e.taskId}: ${e.results.map((r) => (r.ok ? '✓' : '✗') + ' ' + r.command).join(' | ')}`);
    case 'feedback': return console.log(c(33, `  feedback ${e.taskId}: ${e.headline}${e.willRetry ? ' → retrying' : ''}`));
    case 'lesson': return console.log(c(35, `  lesson: ${e.text}`));
    case 'escalation': return console.log(c(31, `  ESCALATED ${e.taskId}: ${e.reason}`));
    case 'checklist': return e.items.forEach((i) => console.log(`  ${i.ok ? c(32, '✓') : c(31, '✗')} ${i.label} — ${i.detail}`));
    case 'deploy': return console.log(e.ok ? c(32, `  deployed (preview port running)`) : c(31, `  deploy failed: ${e.error}`));
    case 'output': return console.log(e.ok ? c(32, `  delivered to ${e.dir}`) : c(31, `  delivery to ${e.dir} failed: ${e.error}`));
    case 'stage': return console.log(c(36, `  ${e.stage}: ${e.state}${e.detail ? ` — ${e.detail}` : ''}`));
    case 'baseline': return console.log(`  baseline ${e.status === 'passed' ? c(32, '✓') : c(33, '!')} ${e.command} → ${e.status}${e.limitation ? ` (${e.limitation})` : ''}`);
    case 'publish': return console.log(e.state === 'failed' ? c(31, `  publish failed (${e.step}): ${e.error}`) : e.pr ? c(32, `  pull request: ${e.pr.url}${e.pr.draft ? ' (draft)' : ''}`) : c(e.prError ? 33 : 32, `  ${e.state}${e.branch ? ` ${e.branch}` : ''}${e.prError ? ` — ${e.prError}` : ''}`));
    case 'error': return console.log(c(31, `  error: ${e.message}`));
    default: return undefined;
  }
});

const plannerDiffers = run.plannerProvider !== run.provider || run.plannerModel !== run.model;
console.log(`Run ${run.id} · agents ${run.providerLabel || run.provider} · ${run.model}${plannerDiffers ? ` · planner ${run.plannerProviderLabel || run.plannerProvider} · ${run.plannerModel}` : ''}`);
if (run.source) console.log(`Source ${run.source.mode === 'github' ? `GitHub ${run.source.label}${run.source.ref ? ` @ ${run.source.ref}` : ''}` : `local directory ${run.source.label}`} · the original is never edited${run.source.publish ? ' · will push the run branch and open a pull request' : ''}`);
console.log(`Workspace ${store.workspaceDir(run.id)}`);
const final = await factory.start(run.id);
console.log(`\n${final.summary || ''}\n`);
console.log(`Report:  ${store.deliveryDir(run.id)}/FACTORY_REPORT.md`);
if (final.source) {
  const d = final.delivery;
  console.log(`Patch:   ${store.deliveryDir(run.id)}/changes.patch  (${final.changes?.files.length ?? 0} file(s) changed)`);
  if (d?.archive) console.log(`Changed files archive: ${store.deliveryDir(run.id)}/project.tar.gz`);
  console.log(`Checks:  ${d?.readiness?.verdict?.replace(/-/g, ' ') || 'n/a'} · delivery ${d?.readiness?.ready ? 'ready for review' : `not ready${d?.readiness?.reasons?.length ? ` (${d.readiness.reasons[0]})` : ''}`}`);
  if (d?.integrity && !d.integrity.ok) console.log(`SOURCE PROTECTION VIOLATED: ${d.integrity.problems.join('; ')}`);
  if (final.source.mode === 'github') console.log(`Branch:  ${final.source.branch} (from ${final.source.baseBranch || final.source.ref || 'source'}) · publication: ${d?.publication ? d.publication.state : 'not requested'}${d?.publication?.pr ? ` · ${d.publication.pr.url}` : ''}`);
  else console.log('Local run: nothing is pushed. Apply the patch yourself, or use the web UI to apply it with conflict checks.');
} else console.log(`Archive: ${store.deliveryDir(run.id)}/project.tar.gz`);
if (final.delivery?.output) console.log(final.delivery.output.ok ? `Project:  ${final.delivery.output.dir}` : `Project NOT delivered to ${final.delivery.output.dir}: ${final.delivery.output.error}`);
const p = previews.get(run.id);
if (p && values['keep-alive']) {
  console.log(`App running at http://127.0.0.1:${p.port}/ — Ctrl+C to stop`);
  process.on('SIGINT', () => {
    previews.stopAll();
    process.exit(0);
  });
} else {
  previews.stopAll();
  const publishFailed = final.source?.publish && (final.delivery?.publication?.state === 'failed' || Boolean(final.delivery?.publication?.prError));
  process.exit(final.status === 'completed' && !publishFailed ? 0 : 2);
}
