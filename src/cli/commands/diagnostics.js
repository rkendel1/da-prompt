// diagnostics            offline preflight of the inference configuration (no provider is contacted, no model is called)
// runs diagnostics <id>  what one run's model calls and phases measured
import { CliError, EXIT, table } from '../core.js';

const ENGINE_MARK = { supported: '✓', fixed: '=', unsupported: '✗', 'not-applicable': '–' };

async function preflight(ctx) {
  const { out, opts } = ctx;
  const client = await ctx.api();
  const qs = new URLSearchParams();
  for (const [flag, key] of [['provider', 'provider'], ['model', 'model'], ['engine', 'engine'], ['num-ctx', 'numCtx'], ['temperature', 'temperature'], ['tool-mode', 'toolMode']]) if (opts[flag] != null) qs.set(key, String(opts[flag]));
  const { inference: d } = await client.get(`/api/diagnostics/inference${qs.size ? `?${qs}` : ''}`);
  out.data({ inference: d });
  const sel = d.selection;
  out.print(out.bold('Inference configuration (offline: nothing was contacted and no model was called)'));
  out.print(`  provider  ${sel.provider.id || out.yellow('(not resolved offline)')}${d.provider ? `  [${d.provider.mode}]` : ''}`);
  out.print(`            ${out.dim(sel.provider.reason)}`);
  out.print(`  model     ${sel.model.id || out.yellow('(chosen at run time)')}`);
  out.print(`            ${out.dim(sel.model.reason)}`);
  out.print(`  engine    ${sel.engine.id}${sel.engine.installed === false ? out.red('  (not installed)') : ''}`);
  out.print(`            ${out.dim(sel.engine.reason)}`);
  if (d.provider) out.print(`  endpoint  ${d.provider.baseUrl || '—'} ${out.dim(`(${d.provider.baseUrlSource || 'default'})`)}   key: ${d.provider.keyRequired ? (d.provider.keyPresent ? `present (${d.provider.keySource})` : out.red('missing')) : 'not needed'}`);
  if (d.candidates) out.print(`  ${out.dim(`candidates with a key configured: ${d.candidates.filter((c) => c.keyPresent).map((c) => c.id).join(', ') || 'none'}; local providers cannot be found without contacting them`)}`);
  out.print('');
  out.print(out.bold(`Settings and how engine "${sel.engine.id}" treats them`));
  const eng = sel.engine.id === 'fx' ? 'fx' : 'builtin';
  out.print(table(d.settings, [
    { title: 'setting', key: 'key' },
    { title: 'value', get: (s) => (s.value == null ? '—' : String(s.value)), max: 22 },
    { title: 'source', get: (s) => s.source || '—' },
    { title: eng, get: (s) => `${ENGINE_MARK[s[eng].status] || '?'} ${s[eng].status}` },
    { title: 'detail', get: (s) => s[eng].how || s.note || '', max: 64 },
  ], out));
  out.print(out.dim('✓ supported  = fixed, not configurable  ✗ unsupported  – not applicable. Precedence for numbers: run option > startup > saved > environment > default.'));
  out.print('');
  for (const p of d.problems) out.print(`${p.level === 'error' ? out.red('✗') : out.yellow('!')} ${p.message}${p.fix ? `\n    ${out.dim('→')} ${p.fix}` : ''}`);
  if (!d.problems.length) out.print(`${out.green('✓')} no configuration problems found`);
  out.print('');
  out.print(out.bold('Not checked here (needs a live provider)'));
  for (const n of d.notPerformed) out.print(`  – ${n.check}   ${out.dim(`→ ${n.run}`)}`);
  if (opts.verbose) {
    out.print('');
    for (const l of d.limitations) out.print(`  · ${l}`);
  }
  return d.ok ? EXIT.OK : EXIT.FAILED;
}

const secs = (ms) => (ms == null ? '—' : ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

async function runDiagnostics(ctx) {
  const { out, opts } = ctx;
  const client = await ctx.api();
  const id = ctx.args[0];
  let r;
  try {
    r = await client.get(`/api/runs/${encodeURIComponent(id)}/diagnostics${opts.calls ? `?calls=${encodeURIComponent(opts.calls)}` : ''}`);
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw e;
  }
  const d = r.diagnostics;
  out.data(r);
  out.print(out.bold(`Run ${d.run.id} · ${d.run.status} · ${d.run.provider}${d.run.model ? ` / ${d.run.model}` : ''} · engine ${d.run.engine}`));
  out.print(`  duration  ${secs(d.run.durationMs)}   tasks ${d.outcome.tasks.completed}/${d.outcome.tasks.total} (${d.outcome.tasks.attempts} attempts)   checklist ${d.outcome.verification.checklistPassed}/${d.outcome.verification.checklistTotal}   delivery ${d.outcome.delivery.produced ? 'produced' : 'none'}`);
  out.print(`  phases    ${Object.entries(d.phases.durationMs).map(([k, v]) => `${k} ${secs(v)}`).join(' · ') || '—'}   ${out.dim('(factory-measured)')}`);
  const t = d.calls.tokens;
  out.print(`  calls     ${d.calls.count} · total ${secs(d.calls.durationMs.total)} · median ${secs(d.calls.durationMs.median)} · retries ${d.calls.retries}   ${out.dim('(factory-measured)')}`);
  out.print(`  tokens    in ${t.input} / out ${t.output}   ${out.dim(`provider-reported by ${t.callsReporting} call(s); ${t.callsUnavailable} call(s) reported nothing`)}`);
  out.print(`  request   median ${d.calls.request.medianChars ?? '—'} chars, largest ${d.calls.request.maxChars} chars / ${d.calls.request.maxMessages} messages   ${out.dim('(characters, not tokens)')}`);
  out.print(`  tools     ${d.tools.calls} calls, ${d.tools.failed} failed`);
  out.print('');
  out.print(table(Object.entries(d.calls.byPurpose).map(([k, v]) => ({ purpose: k, ...v })), [{ title: 'purpose', key: 'purpose' }, { title: 'calls', key: 'count' }, { title: 'ok', key: 'ok' }, { title: 'failed', key: 'failed' }, { title: 'time', get: (v) => secs(v.durationMs) }, { title: 'in tok', key: 'inputTokens' }, { title: 'out tok', key: 'outputTokens' }, { title: 'no usage', key: 'usageUnavailable' }, { title: 'retries', key: 'retries' }], out));
  const fails = Object.entries(d.calls.failuresByKind);
  if (fails.length) out.print(`\nFailures: ${fails.map(([k, n]) => `${k} ×${n}`).join(', ')}`);
  for (const x of d.repeatedToolFailures) out.print(`${out.yellow('!')} ${x.tool} failed ${x.count}× with identical input in task ${x.taskId}`);
  if (d.truncated) out.print(out.dim('Records beyond the per-run limit were counted, not stored.'));
  return EXIT.OK;
}

export default [
  {
    path: ['diagnostics'],
    summary: 'Offline preflight of provider, model, engine and tuning settings (never contacts a provider).',
    description: 'Shows what a run would use and why, which options each engine honours, what is misconfigured, and which checks need a live provider (and the explicit command for each). It makes no network request and no model call. Use "providers test" for the live checks.',
    options: {
      provider: { type: 'string', valueName: 'ID', description: 'Check this provider instead of the configured default.' },
      model: { type: 'string', valueName: 'NAME', description: 'Check this model.' },
      engine: { type: 'string', valueName: 'ENGINE', description: 'Check this engine (builtin or fx).' },
      'num-ctx': { type: 'string', valueName: 'N', description: 'Check how a context-window option would be treated.' },
      temperature: { type: 'string', valueName: 'T', description: 'Check how a temperature option would be treated.' },
      'tool-mode': { type: 'string', valueName: 'MODE', description: 'Check how a tool-mode option would be treated.' },
      verbose: { type: 'boolean', short: 'v', description: 'Also list the known engine/provider limitations.' },
    },
    examples: ['da-prompt diagnostics', 'da-prompt diagnostics --provider ollama --engine fx --num-ctx 32768 --json'],
    run: preflight,
  },
  {
    path: ['runs', 'diagnostics'],
    summary: 'Timings, token usage, retries and failures of a run\'s model calls (no prompts or replies).',
    args: '<run-id>',
    minArgs: 1,
    options: { calls: { type: 'string', valueName: 'N', description: 'With --json: include up to N individual call records (default 200).' } },
    run: runDiagnostics,
  },
];
