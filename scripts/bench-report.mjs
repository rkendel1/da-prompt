#!/usr/bin/env node
// Side-by-side table for two benchmark reports taken on the same tasks (see README "Truthful completion, recovery and local inference").
//   node scripts/bench-report.mjs before.json after.json [--md]
// It restates what each report recorded; it does not decide which is better. A shorter run is not better if it skipped work, which
// is why pass rate, false successes and verification accuracy are printed next to every time.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sum = (xs) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const secs = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);

/** Per-task and total figures from one report. Pure. */
export function figures(report) {
  const rows = (report.results || []).map((r) => ({
    id: r.taskId,
    status: r.status,
    runStatus: r.runStatus,
    wallMs: r.wallMs,
    modelCalls: r.calls?.count ?? null,
    medianCallMs: r.calls?.durationMs?.median ?? null,
    toolCalls: r.toolCalls ?? null,
    toolFailures: r.toolFailures ?? null,
    taskRetries: r.retries?.taskAttempts ?? null,
    accepted: r.acceptance?.ok ?? null,
    falseSuccess: r.runStatus === 'completed' && r.acceptance?.ok === false,
    agrees: r.acceptance && (r.status === 'passed' || r.status === 'failed') ? (r.runStatus === 'completed') === (r.acceptance.ok === true) : null,
    peakGenerations: r.metrics?.inference?.limiters?.[0]?.peakActive ?? null,
    queuedMs: r.metrics?.inference?.queuedMs ?? null,
    loadMs: r.metrics?.inference?.modelLoadMs ?? null,
    tokensPerSecond: r.metrics?.inference?.tokensPerSecond ?? null,
    outputTokens: r.tokens?.output ?? null,
  }));
  const judged = rows.filter((r) => r.agrees != null);
  return {
    rows,
    total: {
      attempted: rows.length,
      passed: rows.filter((r) => r.status === 'passed').length,
      wallMs: sum(rows.map((r) => r.wallMs)),
      modelCalls: sum(rows.map((r) => r.modelCalls)),
      toolCalls: sum(rows.map((r) => r.toolCalls)),
      taskRetries: sum(rows.map((r) => r.taskRetries)),
      falseSuccesses: rows.filter((r) => r.falseSuccess).length,
      verificationAccuracy: judged.length ? judged.filter((r) => r.agrees).length / judged.length : null,
    },
  };
}

export function table(before, after) {
  const a = figures(before);
  const b = figures(after);
  const ids = [...new Set([...a.rows, ...b.rows].map((r) => r.id))];
  const cell = (r) => (r ? `${r.status}${r.runStatus ? ` (run ${r.runStatus})` : ''}` : '—');
  const lines = [];
  lines.push('| scenario | before | after | wall before | wall after | model calls b→a | tools b→a | task retries b→a | false success b→a |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const id of ids) {
    const x = a.rows.find((r) => r.id === id);
    const y = b.rows.find((r) => r.id === id);
    lines.push(`| ${id} | ${cell(x)} | ${cell(y)} | ${secs(x?.wallMs)} | ${secs(y?.wallMs)} | ${x?.modelCalls ?? '—'} → ${y?.modelCalls ?? '—'} | ${x?.toolCalls ?? '—'} → ${y?.toolCalls ?? '—'} | ${x?.taskRetries ?? '—'} → ${y?.taskRetries ?? '—'} | ${x?.falseSuccess ? 'yes' : 'no'} → ${y?.falseSuccess ? 'yes' : 'no'} |`);
  }
  const t = (k, f = (v) => v) => `${f(a.total[k])} → ${f(b.total[k])}`;
  lines.push('');
  lines.push(`Passed (independent acceptance): ${t('passed')} of ${a.total.attempted} → ${b.total.attempted}`);
  lines.push(`Wall clock: ${t('wallMs', secs)} · model calls: ${t('modelCalls')} · tool calls: ${t('toolCalls')} · task retries: ${t('taskRetries')}`);
  lines.push(`False successes (run said "completed", acceptance disagreed): ${t('falseSuccesses')} · verification accuracy: ${t('verificationAccuracy', pct)}`);
  const conc = b.rows.filter((r) => r.peakGenerations != null);
  if (conc.length) lines.push(`After — concurrency: peak simultaneous generations ${Math.max(...conc.map((r) => r.peakGenerations))}, total queue wait ${secs(sum(conc.map((r) => r.queuedMs)))}, model-load time ${secs(sum(conc.map((r) => r.loadMs)))}; backend-reported tokens/s ${conc.map((r) => r.tokensPerSecond).filter((v) => v != null).join(', ') || '—'}`);
  lines.push(`Before config ${before.configId} (${before.repository?.revision?.slice(0, 8) || '?'}) · after config ${after.configId} (${after.repository?.revision?.slice(0, 8) || '?'}${after.repository?.dirty ? ', uncommitted changes' : ''}) · modes ${before.mode}/${after.mode}`);
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [bf, af] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  if (!bf || !af) {
    console.error('Usage: node scripts/bench-report.mjs <before.json> <after.json>');
    process.exit(2);
  }
  console.log(table(read(bf), read(af)));
}
