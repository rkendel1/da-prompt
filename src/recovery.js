// The recovery policy: what a failed attempt is, whether trying again can help, and what the next attempt is told.
//
// Everything here works from facts the factory measured (exit codes, artifact checks, tool outcomes, error kinds). Nothing
// reads an agent's narration: prose cannot make a failure look new, and it never counts as progress.
import crypto from 'node:crypto';
import { redact } from './security.js';

/** Failures that retrying cannot fix: the same request would fail the same way. */
export const STOP_KINDS = new Set(['authentication', 'model_not_found', 'context_overflow']);
/** Failures that are about the environment, not the work: worth another attempt, bounded like any other. */
export const TRANSIENT_KINDS = new Set(['timeout', 'first_response_timeout', 'connection', 'rate_limited', 'provider_error', 'malformed_tool_call', 'malformed_response']);

export const isTransient = (kind) => TRANSIENT_KINDS.has(kind);

/** Strip what changes between identical failures (numbers, durations, temp paths, ids) so the same failure compares equal. */
export function normalizeFailureText(text) {
  return String(text ?? '')
    .replace(/\/(?:private\/)?(?:var|tmp)\/[^\s'"`)]+/g, '<tmp>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds)\b/gi, '<t>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-400);
}

/** One comparable string for an attempt's failure: its failed criteria and what each said, or its execution error. */
export function failureFingerprint(attempt) {
  const f = attempt.failure || {};
  const body = f.category === 'acceptance' || f.category === 'capability'
    ? (attempt.verification || []).filter((c) => !c.ok).map((c) => `${c.criterion || c.command}|${c.exitCode}|${normalizeFailureText(c.output)}`).join('||')
    : `${f.kind || 'agent'}|${normalizeFailureText(attempt.error)}`;
  return crypto.createHash('sha1').update(`${f.category || 'unknown'}:${body}`).digest('hex').slice(0, 16);
}

const tail = (s, n) => redact(String(s || '')).slice(-n);

/**
 * The structured message the next attempt starts from: exactly which criteria failed, the check that ran and its result, and
 * what the last attempt actually did (from tool outcomes, not from what the agent said it did).
 */
export function buildFeedback({ attemptNo, maxAttempts, failed = [], error, reuse = [], tools, hints = [], repeats = 1 }) {
  const out = [`Attempt ${attemptNo} of ${maxAttempts} did not pass. Address these specific failures; do not repeat the same approach.`];
  if (error) out.push('', `Failure: the agent did not complete the task: ${error}`);
  failed.forEach((c, i) => {
    out.push('', `${i + 1}. Failed criterion: ${c.criterion || c.command}`);
    out.push(`   Check: ${c.check === 'command' || !c.check ? `$ ${c.command}` : c.command}`);
    out.push(`   Result: ${c.exitCode == null ? 'failed' : `exit code ${c.exitCode}`}${c.state === 'regression' ? ' (REGRESSION: this command passed or had different failures before your change)' : ''}`);
    if (c.newFailures?.length) out.push(`   New failures:\n${c.newFailures.map((x) => `     - ${x}`).join('\n')}`);
    if (c.output) out.push(`   Evidence:\n${tail(c.output, 1500).split('\n').map((l) => `     ${l}`).join('\n')}`);
  });
  if (tools) {
    const bits = [`${tools.invoked ?? 0} tool call(s)`, `${tools.executed ?? 0} succeeded`];
    if (tools.failed) bits.push(`${tools.failed} failed`);
    if (tools.rejected) bits.push(`${tools.rejected} rejected (bad arguments)`);
    if (tools.unavailable) bits.push(`${tools.unavailable} used an unavailable tool`);
    if (tools.duplicates) bits.push(`${tools.duplicates} repeated`);
    out.push('', `What the last attempt actually did: ${bits.join(', ')}; ${tools.writes ? `${tools.writes} file(s) written` : 'no file was written'}.`);
  }
  if (repeats > 1) out.push('', `This is the same failure as the previous attempt (${repeats} in a row). Changing wording does not change the result; the check must pass.`);
  for (const h of hints) out.push('', `Hint: ${h}`);
  if (reuse.length) out.push('', `Already valid and kept (reuse, do not recreate): ${reuse.join(', ')}`);
  return out.join('\n');
}

/** Run-level accounting from what the stored tasks recorded; observation only. */
export function taskOutcomes(tasks) {
  const count = (s) => tasks.filter((t) => t.status === s).length;
  return {
    total: tasks.length,
    completed: count('completed'),
    skipped: count('skipped'),
    escalated: count('escalated'),
    blocked: count('blocked'),
    cancelled: count('cancelled'),
    pending: count('pending'),
    retries: tasks.reduce((a, t) => a + Math.max(0, (t.attempts?.length || 0) - 1), 0),
    failed: tasks.filter((t) => t.failure).map((t) => ({ id: t.id, status: t.status, category: t.failure.category, kind: t.failure.kind || null, reason: String(t.failure.reason || '').slice(0, 300) })),
  };
}
