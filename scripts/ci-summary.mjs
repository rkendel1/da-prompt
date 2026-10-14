#!/usr/bin/env node
// Summarise a `node --test` TAP log for a CI step summary, and refuse to let tests disappear silently.
//   node scripts/ci-summary.mjs <test.log> [--forbid-skip "<reason>"]...      exit 0 ok · 1 a forbidden skip reason was seen · 2 bad usage
// It reads the log only (no network, no environment). The test run's own exit status is what fails a job; this adds the list of
// failing tests, the skipped tests grouped by reason, and — with --forbid-skip — a failure when tests were skipped for a reason
// that means the environment, not the test, is wrong (for example "Playwright is not installed" on a runner that should have it).
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--forbid-skip');
if (!file) {
  console.error('Usage: ci-summary.mjs <test.log> [--forbid-skip "<reason>"]...');
  process.exit(2);
}
const forbid = args.flatMap((a, i) => (a === '--forbid-skip' && args[i + 1] ? [args[i + 1]] : []));
let text = '';
try {
  text = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.log(`### Test summary\n\nNo test log was produced (${e.code || e.message}). The step that should have written it failed before running any test.`);
  process.exit(0);
}
const lines = text.split('\n');
const totals = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((k) => [k, lines.map((l) => l.match(new RegExp(`^# ${k} (\\d+)`))).filter(Boolean).map((m) => Number(m[1])).at(-1)]));
const failed = lines.filter((l) => /^not ok \d+ /.test(l)).map((l) => l.replace(/^not ok \d+ - /, '').slice(0, 200));
const skips = new Map();
for (const l of lines) {
  const m = l.match(/^ok \d+ - .*? # SKIP\s*(.*)$/);
  if (m) skips.set(m[1] || '(no reason given)', (skips.get(m[1] || '(no reason given)') || 0) + 1);
}
const out = ['### Test summary', ''];
out.push(totals.tests == null ? 'The log has no TAP totals: the run did not reach the end (setup or build error, crash or timeout).' : `${totals.tests} tests · ${totals.pass} passed · ${totals.fail} failed · ${totals.cancelled} cancelled · ${totals.skipped} skipped`);
if (failed.length) out.push('', '**Failing tests**', ...failed.map((f) => `- ${f}`));
if (skips.size) out.push('', '**Skipped tests, by reason**', ...[...skips].map(([r, n]) => `- ${n} × ${r}`));
const bad = forbid.filter((r) => skips.has(r));
if (bad.length) out.push('', `**Not acceptable on this runner:** ${bad.map((r) => `${skips.get(r)} test(s) skipped with "${r}"`).join('; ')}. The environment is missing something the tests need; they must run, not be skipped.`);
console.log(out.join('\n'));
process.exit(bad.length ? 1 : 0);
