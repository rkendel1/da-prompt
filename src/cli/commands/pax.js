// pax status|verify|probe|evidence — PAX observations are evidence, never the verdict.
import os from 'node:os';
import { CliError, EXIT, table } from '../core.js';
import { renderEvidence, getEvidence } from './runs.js';

const STATE_HINT = {
  unavailable: 'PAX was not found on the backend machine\'s PATH. Install it there (this CLI never installs it), or point at it: da-prompt config set paxPath /path/to/pax',
  permission: 'The file exists but is not executable by the backend user.',
  incompatible: 'That executable is not PAX (or not a version this adapter understands). Point at the right one: da-prompt config set paxPath /path/to/pax',
  timeout: 'PAX did not answer --version in time.',
  error: 'PAX could not be started.',
};

function environmentNote(ctx, env) {
  if (!env) return null;
  const here = os.hostname();
  const same = !here || env.hostname === here;
  return { inspected: `${env.kind || 'host'} ${env.hostname || ''}`.trim(), cliHost: here, same };
}

async function status(ctx) {
  const { out } = ctx;
  const client = await ctx.api();
  const r = await client.get('/api/pax', { timeoutMs: 60_000 });
  const s = r.status;
  const note = environmentNote(ctx, r.environment);
  out.data({ state: s.state, path: s.path || null, version: s.version || null, source: s.source, configured: s.configured, searched: s.searched, message: s.message, environment: r.environment, inspectedEnvironment: note, steps: r.catalog });
  const ok = s.state === 'ok';
  out.print(`${ok ? out.green('✓') : out.red('✗')} ${s.message}`);
  out.print(`  location source  ${s.source === 'configured' ? `configured path (${s.configured})` : s.source === 'PATH' ? 'backend PATH' : s.source || '-'}`);
  out.print(`  inspected        the backend's environment: ${note?.inspected || 'unknown'}${note && !note.same ? `  (this terminal is on ${note.cliHost} — a different machine)` : ''}`);
  if (!ok) {
    out.print(`  ${STATE_HINT[s.state] || ''}`);
    return s.state === 'unavailable' || s.state === 'permission' ? EXIT.UNAVAILABLE : EXIT.FAILED;
  }
  out.print('');
  out.print(table(r.catalog, [{ title: 'step', key: 'id' }, { title: 'class', key: 'class' }, { title: 'available', get: (c) => (c.available ? 'yes' : `no — ${c.reason}`), max: 60 }], out));
  out.print(out.dim('PAX results are observations. They are shown apart from the factory\'s verification and never decide a run\'s verdict.'));
  return EXIT.OK;
}

async function probe(ctx) {
  const { out } = ctx;
  const client = await ctx.api();
  const r = await client.post('/api/pax/probe', { path: ctx.args[0] }, { timeoutMs: 60_000 });
  const s = r.status;
  out.data(r);
  out.print(`${s.state === 'ok' ? out.green('✓') : out.red('✗')} ${s.message}`);
  if (s.state !== 'ok') out.print(`  ${STATE_HINT[s.state] || ''}`);
  else out.print(out.dim(`Save it with: da-prompt config set paxPath ${ctx.args[0]}`));
  return s.state === 'ok' ? EXIT.OK : EXIT.FAILED;
}

async function verify(ctx) {
  const { out, opts, args } = ctx;
  const client = await ctx.api();
  const steps = opts.steps ? opts.steps.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
  const { run } = await client.post(`/api/runs/${encodeURIComponent(args[0])}/pax`, { steps, confirmTests: opts['confirm-tests'] === true }, { timeoutMs: 20 * 60_000 });
  const pax = run.pax;
  out.data({ id: run.id, pax });
  if (!pax) throw new CliError('The backend returned no PAX result.', { code: EXIT.FAILED });
  out.print(`${pax.state === 'collected' ? out.green('✓') : out.red('✗')} PAX ${pax.state}${pax.binary?.version ? ` ${pax.binary.version}` : ''}${pax.binary?.path ? ` (${pax.binary.path}, from ${pax.binary.source})` : ''}`);
  if (pax.message && pax.state !== 'collected') out.print(`  ${pax.message}`);
  const GOOD = ['observed', 'no-drift', 'planned', 'passed'];
  const ATTN = ['drift-detected', 'failed', 'ambiguous'];
  for (const st of pax.steps || []) out.print(`  ${GOOD.includes(st.outcome) ? out.green('✓') : ATTN.includes(st.outcome) ? out.yellow('•') : out.red('✗')} ${(st.title || st.id).padEnd(22)} ${st.outcome}${st.exitCode != null ? ` (exit ${st.exitCode})` : ''} — ${st.detail || ''}`);
  out.print(out.dim(`Evidence: da-prompt runs artifacts ${run.id}   ·   independent of the factory verdict (${run.status}).`));
  if (pax.state !== 'collected') return pax.state === 'unavailable' ? EXIT.UNAVAILABLE : EXIT.FAILED;
  const got = pax.steps || [];
  if (got.some((s) => !GOOD.includes(s.outcome) && !ATTN.includes(s.outcome) && s.outcome !== 'not-supported')) return EXIT.FAILED;
  if (opts['fail-on-findings'] && got.some((s) => ATTN.includes(s.outcome))) return EXIT.ATTENTION;
  return EXIT.OK;
}

async function evidence(ctx) {
  const ev = await getEvidence(await ctx.api(), ctx.args[0]);
  ctx.out.data({ id: ctx.args[0], verdict: ev.factory?.verdict ?? null, pax: ev.pax });
  ctx.out.always(renderEvidence(ev, ctx.out));
  return EXIT.OK;
}

export default [
  { path: ['pax', 'status'], summary: 'Is PAX available on the backend machine, where, which version, and what can it do.', description: 'PAX is resolved from the backend\'s PATH or the configured path and is never installed by da-prompt. The output says which environment was inspected.', run: status, examples: ['da-prompt pax status --json'] },
  { path: ['pax', 'probe'], summary: 'Check a specific executable without saving it.', args: '<path>', minArgs: 1, maxArgs: 1, run: probe },
  { path: ['pax', 'verify'], summary: 'Collect PAX observations for a run\'s workspace (apart from factory verification).', args: '<run-id>', minArgs: 1, maxArgs: 1, options: { steps: { type: 'string', valueName: 'LIST', description: 'Comma-separated: info,doctor,reality,drift,graph,test-plan,test (default: the configured steps).' }, 'confirm-tests': { type: 'boolean', description: 'Allow the "test" step (it runs the project\'s tests).' }, 'fail-on-findings': { type: 'boolean', description: 'Exit 6 when PAX reports drift or failures.' } }, run: verify, examples: ['da-prompt pax verify run_abc --steps info,doctor,drift'] },
  { path: ['pax', 'evidence'], summary: 'Show the evidence a run holds, with PAX separated from claims and factory checks.', args: '<run-id>', minArgs: 1, maxArgs: 1, run: evidence },
];
