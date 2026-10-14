#!/usr/bin/env node
// Benchmark harness CLI (see src/bench.js and README "Local tuning").
//   node scripts/bench.mjs list [--task-dir bench/reliability]
//   node scripts/bench.mjs run --mock [--tasks a,b] [--repeat N] [--out report.json]        deterministic; no model, no network
//   node scripts/bench.mjs run --live --provider ID --model NAME [--engine builtin|fx] [--parallel N] [--num-ctx N] [--repeat N] [--out report.json]
//   node scripts/bench.mjs run … --dry-run      print what would run (and the offline preflight); runs nothing
//   node scripts/bench.mjs compare a.json b.json
// A live run calls a real provider and is never started unless --live is given.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadTasks, runBenchmark, compareReports, BENCH_SCHEMA } from '../src/bench.js';
import { loadConfig } from '../src/config.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { describeInference } from '../src/contract.js';

const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
const [cmd, ...rest] = process.argv.slice(2);
const { values: v, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: { mock: { type: 'boolean' }, live: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' }, engine: { type: 'string' }, tasks: { type: 'string' }, repeat: { type: 'string' }, parallel: { type: 'string' }, attempts: { type: 'string' }, turns: { type: 'string' }, 'num-ctx': { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' }, timeout: { type: 'string' }, 'task-dir': { type: 'string' }, temperature: { type: 'string' }, seed: { type: 'string' }, 'keep-alive': { type: 'string' }, 'max-local': { type: 'string' } },
});
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

if (cmd === 'list') {
  for (const t of loadTasks(v['task-dir'])) console.log(`${t.id.padEnd(28)} ${t.kind.padEnd(40)} ${t.acceptance.length} acceptance check(s)`);
} else if (cmd === 'run') {
  if (!v.mock && !v.live) die('Choose a mode: --mock (deterministic, no model) or --live (calls a real provider; needs --provider and --model).');
  if (v.mock && v.live) die('Use either --mock or --live.');
  const all = loadTasks(v['task-dir']);
  const tasks = v.tasks ? v.tasks.split(',').map((id) => all.find((t) => t.id === id) || die(`Unknown task "${id}". Tasks: ${all.map((t) => t.id).join(', ')}`)) : all;
  const settings = {};
  if (v.parallel) settings.maxParallel = Number(v.parallel);
  if (v.attempts) settings.maxAttempts = Number(v.attempts);
  if (v.turns) settings.maxAgentTurns = Number(v.turns);
  const providerOptions = { ...(v['num-ctx'] ? { numCtx: Number(v['num-ctx']) } : {}), ...(v.temperature ? { temperature: Number(v.temperature) } : {}), ...(v.seed ? { seed: Number(v.seed) } : {}), ...(v['keep-alive'] ? { keepAlive: v['keep-alive'] } : {}) };
  const cfgOverrides = v['max-local'] ? { defaults: { maxLocalInference: Number(v['max-local']) } } : {};
  if (v.live && (!v.provider || !v.model)) die('A live run needs an explicit --provider and --model (nothing is chosen automatically, so the report says what was measured).');
  if (v.live || v['dry-run']) {
    const cfg = loadConfig();
    const pre = await describeInference(cfg, new ProviderRegistry(cfg), { provider: v.provider, model: v.model, engine: v.engine, providerOptions });
    for (const p of pre.problems) console.error(`${p.level === 'error' ? '✗' : '!'} ${p.message}${p.fix ? `\n    → ${p.fix}` : ''}`);
    if (!pre.ok) die('The offline preflight found configuration errors (above); nothing was run.', 1);
  }
  if (v['dry-run']) {
    console.log(JSON.stringify({ mode: v.live ? 'live' : 'mock', provider: v.provider || 'mock', model: v.model || 'reference-solution', engine: v.engine || 'builtin', tasks: tasks.map((t) => t.id), repeat: Number(v.repeat || 1), settings, providerOptions: providerOptions || {} }, null, 2));
    process.exit(0);
  }
  const report = await runBenchmark({ tasks, mode: v.live ? 'live' : 'mock', provider: v.provider, model: v.model, engine: v.engine || 'builtin', settings, providerOptions, cfg: cfgOverrides, repeat: Number(v.repeat || 1), runTimeoutMs: v.timeout ? Number(v.timeout) * 1000 : undefined, log: (m) => !v.json && console.error(m) });
  const text = JSON.stringify(report, null, 2);
  if (v.out) fs.writeFileSync(v.out, `${text}\n`);
  if (v.json) console.log(text);
  else {
    console.log(`\n${report.notice}\n`);
    console.log(`config ${report.configId}: ${report.config.provider} / ${report.config.model} · engine ${report.config.engine} · maxParallel ${report.config.settings.maxParallel ?? '—'}`);
    for (const r of report.results) console.log(`  ${r.status.padEnd(10)} ${r.taskId} #${r.repetition}  ${r.wallMs} ms  calls ${r.calls?.count ?? '—'}  tools ${r.toolCalls ?? '—'}${r.error ? `  — ${r.error}` : ''}`);
    const s = report.summary;
    console.log(`\n${s.passed}/${s.attempted} passed (${pct(s.passRate)}); failed ${s.failed}, incomplete ${s.incomplete}, error ${s.error}. Every attempt is counted.`);
    if (v.out) console.log(`Report written to ${v.out}`);
  }
  process.exit(report.summary.passed === report.summary.attempted ? 0 : 1);
} else if (cmd === 'compare') {
  if (positionals.length !== 2) die('Usage: node scripts/bench.mjs compare <a.json> <b.json>');
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const c = compareReports(read(positionals[0]), read(positionals[1]));
  if (v.json) console.log(JSON.stringify(c, null, 2));
  else {
    console.log(`A ${c.a.configId} (${c.a.mode}) vs B ${c.b.configId} (${c.b.mode})${c.sameConfig ? ' — same configuration' : ''}`);
    for (const d of c.configDiff) console.log(`  config ${d.key}: ${JSON.stringify(d.a)} → ${JSON.stringify(d.b)}`);
    for (const t of c.tasks) console.log(`  ${t.id}: A ${t.a ? `${t.a.passed}/${t.a.attempted} passed, ${t.a.medianWallMs} ms, ${t.a.modelCalls} calls` : '—'} | B ${t.b ? `${t.b.passed}/${t.b.attempted} passed, ${t.b.medianWallMs} ms, ${t.b.modelCalls} calls` : '—'}`);
    for (const n of c.notes) console.log(`  note: ${n}`);
  }
} else {
  die(`Usage: node scripts/bench.mjs <list | run | compare> …   (schema ${BENCH_SCHEMA})`);
}
