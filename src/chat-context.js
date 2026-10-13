// What a project chat may know about the project: retrieved by the backend through the authorized registry, bounded,
// secret-filtered, and RECORDED so the UI can distinguish "retrieved" from "the model's inference". Nothing here writes,
// runs commands from model output, or reads outside the project's own directory.
import { Workspace } from './sandbox.js';
import { runGit } from './gitutil.js';
import { gitState } from './project.js';
import { redact } from './security.js';

const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.keystore|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|secrets?(\.[\w]+)?|\.npmrc|\.netrc|\.pypirc|.*\.tfstate)$/i;
const DOC_FILE = /^(README|CLAUDE|AGENTS|CONTRIBUTING|ARCHITECTURE)(\.[\w]+)?$/i;
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'what', 'how', 'why', 'does', 'can', 'you', 'are', 'not', 'from', 'into', 'about', 'should', 'would', 'could', 'have', 'there', 'where', 'which', 'when', 'will', 'our', 'any', 'all', 'file', 'files', 'code', 'project', 'please', 'make', 'need', 'want', 'like', 'just', 'also', 'but', 'its', 'let', 'use', 'using']);
export const LIMITS = { fileCount: 6, fileBytes: 12_000, docBytes: 6_000, totalBytes: 40_000, listing: 300, commits: 8, tasks: 15, runs: 5 };

const fence = (label, body) => `### ${label}\n${body}\n`;
const words = (text) => [...new Set(String(text).toLowerCase().match(/[a-z0-9_][a-z0-9_.-]{2,}/g) || [])].filter((w) => !STOP.has(w));

/**
 * Build the retrieved-context block for one user message.
 * Returns { text, items: [{kind,label,bytes?,truncated?}], limitations: [string], status }.
 */
export async function buildContext({ cfg, registry, tasks, runs, projectId, userText }) {
  const items = [];
  const limitations = [];
  const parts = [];
  let used = 0;
  const add = (kind, label, body, { truncated = false } = {}) => {
    const text = String(body);
    items.push({ kind, label, bytes: Buffer.byteLength(text), ...(truncated ? { truncated: true } : {}) });
    parts.push(fence(label, text));
    used += text.length;
  };

  let project;
  try {
    project = await registry.find(projectId);
  } catch {
    return { text: '', items, limitations: ['The project registration no longer exists, so no project context could be retrieved. The conversation is kept.'], status: 'unavailable' };
  }
  add('metadata', 'Project (recorded in da-prompt)', [
    `name: ${project.name}`,
    ...(project.product ? [`product: ${project.product}`] : []),
    `type: ${project.kind === 'remote' ? 'remote repository' : project.repo?.isGit ? 'local git repository' : 'local folder'}`,
    ...(project.repo?.remoteUrl || project.remote?.url ? [`remote: ${project.repo?.remoteUrl || project.remote.url}`] : []),
    ...(project.repo?.defaultBranch || project.remote?.defaultBranch ? [`default branch: ${project.repo?.defaultBranch || project.remote.defaultBranch}`] : []),
  ].join('\n'));

  // Backlog and run history are da-prompt's own records: available even when the folder is not.
  try {
    const open = (await tasks.forProject(projectId)).slice(0, LIMITS.tasks);
    if (open.length) add('tasks', `Open backlog tasks for this project (${open.length})`, open.map((t) => `- [${t.status}] ${t.title}`).join('\n'));
  } catch { /* optional */ }
  try {
    const recent = (await runs.list()).filter((r) => r.projectId === projectId).slice(0, LIMITS.runs);
    if (recent.length) add('runs', `Recent runs on this project (${recent.length})`, recent.map((r) => `- ${r.title} — ${r.status}${r.verdict ? `, ${r.verdict}` : ''}`).join('\n'));
  } catch { /* optional */ }

  if (project.kind === 'remote') {
    limitations.push('This project is a remote repository; chat does not fetch its files. Only recorded metadata, tasks and runs are available — anything about its code is the model\'s inference.');
    return { text: parts.join('\n'), items, limitations, status: 'partial' };
  }
  let dir;
  try {
    ({ dir } = await registry.locate(projectId, { purpose: 'read project context' }));
  } catch (e) {
    limitations.push(`The project folder could not be read now (${redact(e.message)}). No files were retrieved; anything the model says about the code is inference.`);
    return { text: parts.join('\n'), items, limitations, status: 'unavailable' };
  }

  let files = [];
  let gs = null;
  try {
    gs = await gitState(cfg, dir.real);
  } catch { /* not git */ }
  if (gs?.isGit) {
    add('git', 'Git state (live)', [`branch: ${gs.branch || '(detached)'}`, `working tree: ${gs.dirty ? `${gs.counts.staged} staged, ${gs.counts.unstaged} modified, ${gs.counts.untracked} untracked` : 'clean'}`, ...(gs.changedFiles.length ? ['changed:', ...gs.changedFiles.slice(0, 15).map((f) => `  ${f.xy} ${f.path}`)] : [])].join('\n'));
    const log = await runGit(['log', `-n${LIMITS.commits}`, '--format=%h %s'], { cwd: dir.real, cfg, timeoutMs: 15_000 });
    if (log.code === 0 && log.stdout.trim()) add('git', `Recent commits (${log.stdout.trim().split('\n').length})`, log.stdout.trim());
    const ls = await runGit(['ls-files', '-z'], { cwd: dir.real, cfg, timeoutMs: 15_000 });
    if (ls.code === 0) files = ls.stdout.split('\0').filter(Boolean);
  }
  const ws = new Workspace(dir.real);
  if (!files.length) {
    try { files = (await ws.listFiles('.', { limit: 2000 })).map((f) => f.path); } catch (e) { limitations.push(`The file list could not be read (${redact(e.message)}).`); }
  }
  files = files.filter((f) => !SECRET_FILE.test(f));
  if (files.length) {
    const shown = files.slice(0, LIMITS.listing);
    add('files', `File list (${shown.length}${files.length > shown.length ? ` of ${files.length}` : ''} files)`, shown.join('\n'), { truncated: files.length > shown.length });
    if (files.length > shown.length) limitations.push(`Only the first ${shown.length} of ${files.length} file paths were listed.`);
  } else limitations.push('No files were found in the project folder.');

  // Documentation first, then files the question points at (explicit paths, then name matches).
  const read = new Map();
  const want = [];
  for (const f of files.filter((f) => !f.includes('/') && DOC_FILE.test(f)).slice(0, 3)) want.push([f, LIMITS.docBytes, 'doc']);
  const mentioned = (String(userText).match(/[\w@./-]+\.[A-Za-z0-9]{1,8}/g) || []).map((m) => m.replace(/^@/, ''));
  for (const m of mentioned) {
    const hit = files.find((f) => f === m || f.endsWith(`/${m}`));
    if (hit) want.push([hit, LIMITS.fileBytes, 'file']);
  }
  const tokens = words(userText);
  if (tokens.length) {
    const scored = files.map((f) => ({ f, s: tokens.filter((t) => f.toLowerCase().includes(t)).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.f.length - b.f.length);
    for (const x of scored.slice(0, 4)) want.push([x.f, LIMITS.fileBytes, 'file']);
  }
  let count = 0;
  for (const [f, cap, kind] of want) {
    if (read.has(f) || count >= LIMITS.fileCount || used >= LIMITS.totalBytes) continue;
    try {
      const text = await ws.readFile(f, { maxBytes: cap });
      if (text.startsWith('[binary file')) continue;
      read.set(f, true);
      count++;
      add(kind === 'doc' ? 'doc' : 'file', `${f}`, redact(text), { truncated: text.includes('…[truncated') });
    } catch { /* unreadable: skip, never guess */ }
  }
  if (!count && files.length) limitations.push('No file contents were matched to your question, so none were retrieved — only the file list. Mention a path (for example src/server.js) to bring a file into context.');
  return { text: parts.join('\n'), items, limitations, status: limitations.length ? 'partial' : 'ok' };
}

export const contextSummary = (c) => ({ status: c.status, items: c.items, limitations: c.limitations, retrievedAt: new Date().toISOString() });
