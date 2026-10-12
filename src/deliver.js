// <deliver>: package the working application, test results and a factory report.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { safeEnv } from './sandbox.js';

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('error', (e) => resolve({ code: 1, out: e.message }));
    child.on('close', (code) => resolve({ code, out: out.slice(-4000) }));
  });
}

export function buildReport(run) {
  const p = run.plan;
  const L = [];
  L.push(`# ${p?.product?.name || run.title} — Factory Report`, '');
  L.push(`- Run: \`${run.id}\``, `- Status: **${run.status}**`, `- Provider: ${run.provider}${run.model ? ` (${run.model})` : ''}`);
  L.push(`- Tokens: ${(run.usage?.input || 0) + (run.usage?.output || 0)} (${run.usage?.input || 0} in / ${run.usage?.output || 0} out), ${run.usage?.calls || 0} model calls`);
  if (run.startedAt && run.finishedAt) L.push(`- Duration: ${Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000)}s`);
  L.push('', '## Idea', run.inputs.idea, '');
  if (run.summary) L.push('## Summary', run.summary, '');
  if (p) {
    L.push('## Product', p.product.summary, '', '**Success criteria**', ...p.product.successCriteria.map((c) => `- ${c}`), '');
    L.push('## Tasks', '| Task | Role | Status | Attempts | Result |', '| --- | --- | --- | --- | --- |');
    for (const t of p.tasks) {
      L.push(`| ${t.id} — ${t.title} | ${t.role} | ${t.status} | ${t.attempts?.length || 0} | ${(t.result?.summary || t.error || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220)} |`);
    }
    L.push('');
  }
  if (run.checklist?.length) {
    L.push('## Completion checklist');
    for (const c of run.checklist) L.push(`- [${c.ok ? 'x' : ' '}] ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    L.push('');
  }
  if (run.finalVerification?.length) {
    L.push('## Test results');
    for (const v of run.finalVerification) L.push(`- \`${v.command}\` → exit ${v.exitCode} (${v.durationMs}ms)`);
    L.push('');
  }
  if (run.deployment) {
    L.push('## Deployment');
    if (run.deployment.ok) L.push(`Live preview: ${run.deployment.url} (health ${run.deployment.healthPath} → ${run.deployment.status})`);
    else L.push(`Live preview failed: ${run.deployment.error}`);
    L.push(`Start command: \`${run.deployment.start}\`. See DEPLOY.md for production deployment.`, '');
  }
  if (run.lessons?.length) {
    L.push('## Lessons recorded (CLAUDE.md)', ...run.lessons.map((l) => `- ${l.text}`), '');
  }
  const left = [];
  for (const t of p?.tasks || []) if (t.status !== 'completed') left.push(`${t.id}: ${t.status}${t.error ? ` (${t.error})` : ''}`);
  for (const c of run.checklist || []) if (!c.ok) left.push(`Checklist: ${c.label}`);
  L.push("## What's left", ...(left.length ? left.map((x) => `- ${x}`) : ['- Nothing blocking. See recommendations in the summary.']), '');
  if (p?.risks?.length) L.push('## Risks', ...p.risks.map((r) => `- ${r}`), '');
  if (p?.openQuestions?.length) L.push('## Open questions', ...p.openQuestions.map((r) => `- ${r}`), '');
  return L.join('\n');
}

export async function packageDelivery(run, ws, deliveryDir) {
  await fsp.mkdir(deliveryDir, { recursive: true });
  const report = buildReport(run);
  await fsp.writeFile(path.join(deliveryDir, 'FACTORY_REPORT.md'), report);
  await ws.writeFile('FACTORY_REPORT.md', report);
  const tests = {
    final: run.finalVerification || [],
    tasks: (run.plan?.tasks || []).map((t) => ({ id: t.id, status: t.status, verification: t.attempts?.at(-1)?.verification || [] })),
    security: run.security || null,
  };
  await fsp.writeFile(path.join(deliveryDir, 'test-results.json'), JSON.stringify(tests, null, 2));
  const archive = path.join(deliveryDir, 'project.tar.gz');
  const name = (run.plan?.product?.name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
  const r = await sh('tar', ['-czf', archive, '--exclude=node_modules', '--exclude=.home', '--exclude=.git', `--transform=s,^\\.,${name},`, '.'], { cwd: ws.root });
  return { report: 'FACTORY_REPORT.md', tests: 'test-results.json', archive: r.code === 0 ? 'project.tar.gz' : null, archiveError: r.code === 0 ? null : r.out };
}

/** Optional: push the generated project to a git remote (e.g. a GitHub repo) with a token. */
export async function pushToGit(ws, { repoUrl, token, branch = 'main', message, author = { name: 'da-prompt factory', email: 'factory@da-prompt.local' } }) {
  if (!/^https:\/\//.test(repoUrl)) return { ok: false, error: 'only https:// remotes are supported' };
  const env = { ...safeEnv(), GIT_TERMINAL_PROMPT: '0', HOME: path.join(ws.root, '.home') };
  const opts = { cwd: ws.root, env };
  const steps = [
    ['git', ['init', '-q', '-b', branch]],
    ['git', ['add', '-A']],
    ['git', ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '--allow-empty', '-m', message]],
  ];
  await fsp.writeFile(path.join(ws.root, '.gitignore'), await fsp.readFile(path.join(ws.root, '.gitignore'), 'utf8').catch(() => 'node_modules/\n') + '\n.home/\n');
  for (const [c, a] of steps) {
    const r = await sh(c, a, opts);
    if (r.code !== 0) return { ok: false, error: r.out };
  }
  const auth = token ? ['-c', `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : [];
  const r = await sh('git', [...auth, 'push', '-q', repoUrl, `HEAD:${branch}`], opts);
  return r.code === 0 ? { ok: true, repoUrl, branch } : { ok: false, error: r.out.replace(/basic [A-Za-z0-9+/=]+/g, 'basic ***') };
}
