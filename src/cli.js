#!/usr/bin/env node
// Headless runner: `npm run factory -- "a habit tracker" --requirements "..." --provider offline`
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { RunStore } from './store.js';
import { Factory } from './factory.js';
import { PreviewManager } from './deploy.js';

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
    'num-ctx': { type: 'string' },
    'tool-mode': { type: 'string' },
    providers: { type: 'boolean' },
    parallel: { type: 'string' },
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

if (values.help || positionals.length === 0) {
  console.log(`Usage: da-prompt "<idea>" [--requirements ..] [--stack ..] [--limits ..] [--tools ..]
                 [--provider ID] [--model NAME] [--planner-model NAME] [--num-ctx N] [--tool-mode auto|native|json]
                 [--parallel N] [--no-deploy] [--keep-alive]
       da-prompt --providers        list providers and models that are available right now`);
  process.exit(values.help ? 0 : 1);
}

const run = await factory.createRun({
  idea: positionals.join(' '),
  requirements: values.requirements,
  stack: values.stack,
  limits: values.limits,
  tools: values.tools,
  provider: values.provider,
  model: values.model,
  plannerModel: values['planner-model'],
  providerOptions: { numCtx: values['num-ctx'], toolMode: values['tool-mode'] },
  settings: { maxParallel: values.parallel, deploy: !values['no-deploy'] },
});

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
    case 'error': return console.log(c(31, `  error: ${e.message}`));
    default: return undefined;
  }
});

console.log(`Run ${run.id} · ${run.providerLabel || run.provider} · ${run.model}${run.plannerModel !== run.model ? ` (planner ${run.plannerModel})` : ''}`);
console.log(`Workspace ${store.workspaceDir(run.id)}`);
const final = await factory.start(run.id);
console.log(`\n${final.summary || ''}\n`);
console.log(`Report:  ${store.deliveryDir(run.id)}/FACTORY_REPORT.md`);
console.log(`Archive: ${store.deliveryDir(run.id)}/project.tar.gz`);
const p = previews.get(run.id);
if (p && values['keep-alive']) {
  console.log(`App running at http://127.0.0.1:${p.port}/ — Ctrl+C to stop`);
  process.on('SIGINT', () => {
    previews.stopAll();
    process.exit(0);
  });
} else {
  previews.stopAll();
  process.exit(final.status === 'completed' ? 0 : 2);
}
