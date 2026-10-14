// Architecture guards: the boundaries that keep model output from becoming a decision. Each rule reads the real source, strips
// comments and string contents first (so a comment or a fixture cannot satisfy or trip it) and checks module-level facts:
// who imports whom, who may call the tools, who may set a run's status. These are narrow on purpose; they are not a policy engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from './project-helpers.js';
import { runReplay } from './replay-helpers.js';
import { FIXTURES } from './replay/fixtures.js';
import { RunDiagnostics } from '../src/diagnostics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const list = (dir, re = /\.js$/) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));

/**
 * Tokenise a source file just enough to tell code from comments and strings: returns the code with comments removed and every
 * string/template literal replaced by a numbered marker, plus the literals themselves. Template expressions (${…}) stay code.
 */
function tokens(file) {
  const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const strings = [];
  let out = '';
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    const n = s[i + 1];
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = s.indexOf('*/', i + 2); i = i < 0 ? s.length : i + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let text = '';
      let exprs = '';
      for (i++; i < s.length && s[i] !== q; i++) {
        if (s[i] === '\\') { text += s[i + 1]; i++; }
        else if (q === '`' && s[i] === '$' && s[i + 1] === '{') {
          let depth = 1;
          for (i += 2; i < s.length && depth; i++) { if (s[i] === '{') depth++; else if (s[i] === '}') depth--; if (depth) exprs += s[i]; }
          i--;
          exprs += ' ';
        } else text += s[i];
      }
      strings.push(text);
      out += `${q}\u00a7${strings.length - 1}\u00a7${q}${exprs ? ` ${exprs} ` : ''}`;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return { code: out, strings };
}

/** Source with comments removed and string/template contents blanked, so only code is left to inspect. */
export function code(file) {
  return tokens(file).code.replace(/\u00a7\d+\u00a7/g, '');
}

/** Module specifiers a file imports. A dynamic import whose specifier is not a literal is reported as "(dynamic)". */
export function imports(file) {
  const { code: c, strings } = tokens(file);
  const lit = (m) => strings[Number(m)];
  const specs = [];
  for (const m of c.matchAll(/(?:^|[;}\n])\s*import\s+(?:[^;'"`()]*?\s+from\s+)?['"]\u00a7(\d+)\u00a7['"]/g)) specs.push(lit(m[1]));
  for (const m of c.matchAll(/\bimport\s*\(\s*(?:['"]\u00a7(\d+)\u00a7['"])?/g)) specs.push(m[1] !== undefined ? lit(m[1]) : '(dynamic)');
  return specs;
}
const resolveLocal = (from, spec) => (spec.startsWith('.') ? path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, from)), spec)) : spec);

function only(files, allowed, why) {
  for (const f of files) {
    for (const spec of imports(f)) {
      const target = resolveLocal(f, spec);
      assert.ok(allowed.includes(target), `${f} imports ${spec} (${target}); ${why}. Allowed: ${allowed.join(', ')}`);
    }
  }
}

test('the test helper really reads code, not comments or strings', () => {
  const tmp = path.join('test', '__arch_probe.js');
  fs.writeFileSync(path.join(ROOT, tmp), "// import x from 'node:child_process'\n/* run.status = 'completed' */\nconst s = \"run.status = 'completed'\";\nimport fs from 'node:fs';\nconst t = `${run.status = 1}`;\n");
  try {
    assert.deepEqual(imports(tmp), ['node:fs']);
    const c = code(tmp);
    assert.ok(!/child_process/.test(c) && !c.includes("'completed'"));
    assert.ok(/run\.status = 1/.test(c), 'a template expression is code and is kept');
  } finally {
    fs.rmSync(path.join(ROOT, tmp));
  }
});

test('provider adapters stay adapters: no run, store, delivery, verification, sandbox or engine knowledge', () => {
  const providers = list('src/providers');
  only(providers, ['node:http', 'node:https', 'node:fs', 'node:path', 'node:url', 'src/diagnostics.js', 'src/security.js', ...providers.map((f) => f.replace(/\.js$/, '.js'))], 'a provider adapter may talk to a model and nothing else');
  for (const f of providers) {
    const c = code(f);
    assert.ok(!/\brun\.(status|delivery|checklist|finalVerification|plan|layers)\s*=[^=]|verdictOf/.test(c), `${f} must not write run state or compute a verdict`);
  }
});

test('diagnostics and the contract are observers: no store, factory, sandbox, tools, delivery, network or process access', () => {
  only(['src/diagnostics.js'], ['node:async_hooks', 'node:fs', 'node:path', 'src/security.js'], 'diagnostics only record');
  only(['src/contract.js'], ['src/engines/index.js', 'src/engines/fx.js', 'src/providers/openai.js', 'src/providers/anthropic.js', 'src/providers/http.js'], 'the preflight only reads configuration');
  for (const f of ['src/diagnostics.js', 'src/contract.js']) {
    const c = code(f);
    assert.ok(!/\bfetch\s*\(|\bXMLHttpRequest\b|\bspawn\w*\s*\(|\bexec\w*\s*\(/.test(c), `${f} must not make requests or start processes`);
    assert.ok(!/\brun\.status\s*=[^=]|\.runCommand\s*\(|\.writeFile\s*\(\s*[^)]*\)\s*;?\s*$/m.test(c) || f === 'src/diagnostics.js', `${f} must not change runs or run commands`);
    assert.ok(!/\.(status|delivery|checklist|plan)\s*=[^=]/.test(c), `${f} must not assign run state`);
  }
});

test('the fx engine reaches the world only through da-prompt\'s tools: no file system, process or network of its own', () => {
  only(['src/engines/fx.js'], ['node:crypto', 'src/security.js', 'src/agents.js', 'src/engines/index.js'], 'every effect of an fx task goes through execTool/Workspace');
  const c = code('src/engines/fx.js');
  assert.ok(/\bexecTool\s*\(/.test(c), 'the fx tools are execTool');
  assert.ok(!/\.(runCommand|writeFile|readFile)\s*\(/.test(c), 'fx.js does not call the workspace directly');
  only(['src/engines/index.js'], ['node:fs/promises', 'node:path', 'node:url', '(dynamic)'], 'the loader only locates an optional package');
});

test('model-proposed operations have exactly one door: execTool is the only code in agents.js that touches the workspace', () => {
  const c = code('src/agents.js');
  const start = c.indexOf('export async function execTool');
  assert.ok(start > 0);
  let depth = 0;
  let end = start;
  const sig = c.slice(start).match(/execTool\([^)]*\)\s*\{/);
  const open = start + sig.index + sig[0].length - 1;
  for (let i = open; i < c.length; i++) { if (c[i] === '{') depth++; else if (c[i] === '}' && --depth === 0) { end = i; break; } }
  const outside = c.slice(0, start) + c.slice(end);
  assert.ok(!/\bws\.(runCommand|writeFile|readFile|listFiles)\s*\(/.test(outside), 'the sandbox is called only from execTool');
  assert.equal((c.slice(start, end).match(/\bws\.(runCommand|writeFile|readFile|listFiles)\s*\(/g) || []).length, 5, 'one call per tool: list_files, read_file, write_file, save_reply_code, run_command');
  // No provider or engine module can call a workspace at all.
  for (const f of [...list('src/providers'), ...list('src/engines')]) assert.ok(!/\.(runCommand|writeFile)\s*\(/.test(code(f)), `${f} must not write files or run commands`);
});

test('only the factory decides a run\'s status, and only through its own verification and delivery', () => {
  const offenders = [];
  for (const f of list('src')) {
    if (f === 'src/factory.js') continue;
    if (/\brun\.status\s*=[^=]/.test(code(f))) offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'no other module assigns run.status');
  for (const f of [...list('src/providers'), ...list('src/engines'), 'src/diagnostics.js', 'src/contract.js']) {
    assert.ok(!imports(f).some((s) => /deliver|publish|project|evidence|store|factory/.test(s)), `${f} must not import delivery, publication, project, evidence, store or factory`);
  }
});

test('providers are created in one place, so there is no second route that could fall back to another one', () => {
  const callers = [...list('src'), ...list('src/providers'), ...list('src/engines'), ...list('src/cli/commands')].filter((f) => /\b(providers|registry)\.create\s*\(/.test(code(f)) || /\bthis\.create\s*\(/.test(code(f)));
  assert.deepEqual(callers, ['src/factory.js', 'src/providers/registry.js'], 'ProviderRegistry#create: the factory (makeProvider) and the registry\'s own connectivity test');
  const factory = code('src/factory.js');
  assert.equal((factory.match(/\.create\(run\.provider/g) || []).length, 1, 'makeProvider is the single construction site for a run');
  assert.ok(!/fallback/i.test(fs.readFileSync(path.join(ROOT, 'src/factory.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/no automatic fallback/gi, '')), 'no fallback logic in the factory');
});

test('browser code has no storage or file-system authority beyond the HTTP API', () => {
  const banned = /\b(indexedDB|openDatabase|showOpenFilePicker|showSaveFilePicker|showDirectoryPicker|webkitRequestFileSystem|FileSystemHandle)\b|\brequire\s*\(|from\s+['"]node:/;
  const files = list('public').filter((f) => !/vendor/.test(f));
  assert.ok(files.length >= 8);
  for (const f of files) assert.ok(!banned.test(code(f)), `${f} reaches for browser storage / file system / node APIs`);
});

test('diagnostics are observational: a recorder that fails on every write changes neither the outcome nor what the model is shown', async () => {
  const shape = (r) => ({
    status: r.run.status,
    verdict: r.evidence.factory.verdict,
    tasks: r.run.plan.tasks.map((t) => [t.status, t.attempts.map((a) => [a.ok, a.error || null])]),
    tools: r.tools.map((e) => [e.tool, e.ok, e.exitCode ?? null]),
    checklist: r.run.checklist.map((c) => [c.id, c.ok]),
    // What the model was shown on each agent turn (ids, paths and commit hashes differ between runs and are normalised).
    seen: JSON.stringify(r.provider.requests.filter((q) => q.kind === 'task').map((q) => [q.attempt, q.messages, q.tools])).replace(/toolu_t_\d+/g, 'ID').replace(/\/[^\s"'\\]*da-prompt[^\s"'\\]*/g, 'PATH').replace(/\b[0-9a-f]{10,40}\b/g, 'SHA').replace(/duration_ms:? [\d.]+/g, 'duration_ms N'),
  });
  for (const name of ['recovery', 'falseClaim']) {
    const normal = shape(await runReplay(FIXTURES[name]));
    const { write, append, phase } = RunDiagnostics.prototype;
    RunDiagnostics.prototype.write = () => { throw new Error('diagnostics are down'); };
    RunDiagnostics.prototype.append = () => { throw new Error('disk full'); };
    try {
      assert.deepEqual(shape(await runReplay(FIXTURES[name])), normal, name);
    } finally {
      Object.assign(RunDiagnostics.prototype, { write, append, phase });
    }
  }
});

test('the setup helper used by every architecture test is the production wiring, not a stand-in', () => {
  const { factory } = setup();
  assert.equal(typeof factory.agentRunner({ engine: 'builtin' }), 'function');
  assert.equal(factory.constructor.name, 'Factory');
});
