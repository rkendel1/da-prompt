#!/usr/bin/env node
// Static checks with no dependencies and no network: syntax (node --check), relative imports resolve, named imports
// are used, no stray debugger/.only, and the public JS parses. Does not need da-prompt, a backend or an LLM.
//   node scripts/check.mjs [--json]      exit 0 clean · 1 problems · 2 could not run
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = process.argv.includes('--json');
const DIRS = ['src', 'public', 'test', 'scripts', 'templates'];
const problems = [];
const skipped = [];
const add = (file, line, rule, message) => problems.push({ file: path.relative(root, file), line, rule, message });

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'vendor' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(path.join(root, d)));
if (!files.length) {
  console.error('check: no source files found; run this from a da-prompt checkout.');
  process.exit(2);
}

for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) add(f, Number((r.stderr.match(/:(\d+)\n/) || [])[1]) || 0, 'syntax', r.stderr.split('\n').find((l) => /Error/.test(l)) || 'syntax error');
}

const IMPORT_RE = /^import\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/gm;
const SIDE_RE = /^import\s+['"]([^'"]+)['"]/gm;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[2];
    if (spec.startsWith('.')) {
      const target = path.resolve(path.dirname(f), spec);
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) add(f, lineOf(m.index), 'import-missing', `"${spec}" does not exist`);
    }
    const names = [];
    const clause = m[1].trim();
    const named = clause.match(/\{([^}]*)\}/);
    if (named) for (const part of named[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop(); if (n) names.push(n); }
    const rest = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    if (rest) names.push(rest.replace(/^\*\s+as\s+/, ''));
    const body = src.replace(m[0], '');
    for (const n of names) if (!new RegExp(`(^|[^\\w$.]|\\.\\.\\.)${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(body)) add(f, lineOf(m.index), 'unused-import', `"${n}" is imported but never used`);
  }
  for (const m of src.matchAll(SIDE_RE)) if (m[1].startsWith('.') && !fs.existsSync(path.resolve(path.dirname(f), m[1]))) add(f, lineOf(m.index), 'import-missing', `"${m[1]}" does not exist`);
  if (f.includes(`${path.sep}test${path.sep}`) && /\b(?:test|describe|it)\.only\(/.test(src)) add(f, 0, 'only', 'a focused test (.only) would hide the rest of the suite');
  if (/^\s*debugger;?\s*$/m.test(src)) add(f, 0, 'debugger', 'debugger statement');
}

// An optional real linter, if the repository's checkout happens to have one installed. Never required.
const eslint = path.join(root, 'node_modules', '.bin', 'eslint');
if (fs.existsSync(eslint)) {
  const r = spawnSync(eslint, ['.'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) add(root, 0, 'eslint', (r.stdout || r.stderr).split('\n').slice(0, 5).join(' | '));
} else skipped.push('eslint (not installed; this repository has no runtime or dev dependencies)');

const result = { ok: problems.length === 0, checked: files.length, problems, skipped };
if (json) console.log(JSON.stringify(result, null, 2));
else {
  for (const p of problems) console.error(`${p.file}${p.line ? `:${p.line}` : ''}  ${p.rule}  ${p.message}`);
  console.log(`${result.ok ? 'check: ok' : `check: ${problems.length} problem(s)`} — ${files.length} files (syntax, imports, unused imports, focused tests)`);
  for (const s of skipped) console.log(`check: skipped ${s}`);
}
process.exit(result.ok ? 0 : 1);
