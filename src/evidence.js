// What the backend actually has on record for a run, grouped by who said it. The three sources never mix:
//   agent    — what an agent claimed in complete_task (a claim, not evidence)
//   factory  — commands the factory itself ran and their exit status (baseline, task checks, final checks)
//   pax      — what PAX observed (see src/pax.js); never part of the verdict
// Missing or inconclusive evidence is listed explicitly instead of being left out.

import { isExisting, verificationSummary } from './project.js';
import { verdictOf } from './deliver.js';
import { redact } from './security.js';

const trim = (s, n = 1500) => redact(String(s || '')).slice(-n);

export function buildEvidence(run) {
  const existing = isExisting(run);
  const tasks = run.plan?.tasks || [];
  const missing = [];

  const claims = tasks.filter((t) => t.result).map((t) => ({ taskId: t.id, role: t.role, title: t.title, summary: t.result.summary, files: t.result.files || [], attempts: t.attempts?.length || 0 }));
  const taskChecks = tasks.map((t) => {
    const last = t.attempts?.at(-1);
    return { taskId: t.id, status: t.status, attempts: t.attempts?.length || 0, checks: (last?.verification || []).map((v) => ({ command: v.command, exitCode: v.exitCode, ok: v.ok, state: v.state || (v.ok ? 'passed' : 'failed'), output: v.ok ? '' : trim(v.output, 1200) })) };
  });
  const final = (run.finalVerification || []).map((v) => ({ command: v.command, exitCode: v.exitCode, ok: v.ok, state: v.state || (v.ok ? 'passed' : 'failed'), required: v.required, durationMs: v.durationMs, newFailures: v.newFailures, output: v.ok ? '' : trim(v.output, 2000) }));

  if (!run.plan) missing.push('No plan was produced, so there is no task history.');
  for (const w of run.plan?.warnings || []) missing.push(w[0].toUpperCase() + w.slice(1) + '.');
  for (const t of tasks.filter((x) => x.status === 'blocked' && x.blockedReason)) missing.push(`Task ${t.id} was not attempted: ${t.blockedReason.reason}`);
  if (run.plan && !final.length) missing.push(existing ? 'No project check ran at the end of the run, so nothing here is claimed as verified.' : 'The final test suite did not run.');
  if (tasks.some((t) => t.status === 'completed') && taskChecks.every((t) => !t.checks.length)) missing.push('Tasks were reported complete but no task-level check results are on record.');
  if (existing && run.project && !run.project.baseline?.length) missing.push('There is no baseline, so regressions cannot be told apart from failures that already existed.');
  if (existing && run.project?.baseline?.some((b) => b.status === 'unavailable')) missing.push('At least one baseline check could not run (tool unavailable).');
  if (!run.delivery) missing.push('The run has not been delivered yet.');
  if (run.settings?.pax && !run.pax) missing.push('PAX evidence was requested for this run but has not been collected.');
  if (run.pax && run.pax.state !== 'collected') missing.push(`PAX evidence could not be collected (${run.pax.state}${run.pax.message ? `: ${run.pax.message}` : ''}).`);

  const out = {
    runId: run.id,
    status: run.status,
    agent: { note: 'Claims made by the agents. They are not evidence that anything works.', claims },
    factory: {
      note: 'Commands the factory ran itself, with their real exit status.',
      verdict: existing ? verdictOf(run) : null,
      summary: existing ? verificationSummary(run) : null,
      baseline: existing ? (run.project?.baseline || []).map((b) => ({ command: b.command, status: b.status, exitCode: b.exitCode, limitation: b.limitation, failing: (b.signature || []).slice(0, 5) })) : [],
      final,
      tasks: taskChecks,
      checklist: run.checklist || [],
      security: run.security ? { blocking: run.security.blocking, findings: run.security.findings.length } : null,
    },
    pax: run.pax
      ? { note: run.pax.semantics, state: run.pax.state, message: run.pax.message || null, binary: run.pax.binary, collectedAt: run.pax.finishedAt, steps: run.pax.steps, summary: run.pax.summary }
      : { note: 'PAX evidence is separate from verification.', state: run.settings?.pax ? 'pending' : 'not-requested', steps: [] },
    missing,
    notes: [],
  };

  // Where sources disagree, say so; never resolve it silently.
  const claimedDone = tasks.filter((t) => t.status === 'completed').length;
  if (existing && out.factory.verdict && ['failed', 'unverified', 'partially-verified'].includes(out.factory.verdict) && claimedDone === tasks.length && tasks.length) out.notes.push(`Every task was reported complete by its agent, but the factory's own verification is "${out.factory.verdict.replace(/-/g, ' ')}".`);
  const paxTest = run.pax?.steps?.find((s) => s.id === 'test');
  if (paxTest && out.factory.verdict) {
    const fOk = ['verified', 'verified-with-preexisting-failures'].includes(out.factory.verdict);
    if (fOk && paxTest.outcome !== 'passed') out.notes.push(`The factory's checks passed, but PAX did not independently confirm the tests (PAX reported "${paxTest.outcome}").`);
    if (!fOk && paxTest.outcome === 'passed') out.notes.push('PAX reported its test run as passed while the factory\'s verification did not; the factory verdict stands and the difference should be reviewed.');
  }
  return out;
}
