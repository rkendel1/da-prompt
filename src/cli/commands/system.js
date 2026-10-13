// setup, doctor, status and server lifecycle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { CliError, EXIT, readStdin, usageError, ago } from '../core.js';
import { connect, startServer, stopServer, logTail } from '../backend.js';
import { liveServer, logPath, readRecord, pidAlive } from '../../runtime.js';
import { getSettings, saveSettings, checkProvider, listProviders, providerFix } from '../ops.js';
import { Client } from '../client.js';

const MARK = { ok: '✓', warn: '!', fail: '✗', na: '–' };

function localChecks(cfg) {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ id: 'node', label: 'Node.js', status: major >= 20 ? 'ok' : 'fail', summary: `Node ${process.versions.node}${major >= 20 ? '' : ' — da-prompt needs 20 or newer'}`, fix: major >= 20 ? undefined : 'Install Node.js 20+ (host-level).' });
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  checks.push({ id: 'git', label: 'Git', status: git.status === 0 ? 'ok' : 'fail', summary: git.status === 0 ? git.stdout.trim() : 'git was not found on this PATH', fix: git.status === 0 ? undefined : 'Install git (host-level); existing projects cannot be used without it.' });
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  checks.push({ id: 'npm', label: 'npm', status: npm.status === 0 ? 'ok' : 'warn', summary: npm.status === 0 ? `npm ${npm.stdout.trim()}` : 'npm was not found (only needed for the repository\'s own test/build scripts)', fix: npm.status === 0 ? undefined : 'Install npm with Node.js.' });
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const probe = path.join(cfg.dataDir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    checks.push({ id: 'data', label: 'Data folder', status: 'ok', summary: `writable (${cfg.dataDir})` });
  } catch (e) {
    checks.push({ id: 'data', label: 'Data folder', status: 'fail', summary: `cannot write to ${cfg.dataDir}: ${e.code || e.message}`, fix: 'Make it writable for your user, or choose another with FACTORY_DATA_DIR (host-level).' });
  }
  const sf = path.join(cfg.dataDir, 'settings.json');
  if (fs.existsSync(sf)) {
    const mode = (fs.statSync(sf).mode & 0o777).toString(8);
    checks.push({ id: 'settings', label: 'Saved settings', status: mode === '600' ? 'ok' : 'warn', summary: `${sf} (permissions ${mode})`, fix: mode === '600' ? undefined : `chmod 600 ${sf}` });
  } else checks.push({ id: 'settings', label: 'Saved settings', status: 'na', summary: 'nothing saved yet (da-prompt setup or da-prompt config set …)' });
  return checks;
}

function renderChecks(checks, out, { verbose = false } = {}) {
  for (const c of checks) {
    const color = { ok: out.green, warn: out.yellow, fail: out.red, na: out.dim }[c.status] || ((s) => s);
    out.print(`${color(MARK[c.status] || '?')} ${out.bold(c.label)} — ${c.summary}`);
    const fix = c.fix || c.remediation?.text;
    if (c.status !== 'ok' && c.status !== 'na' && fix) out.print(`    ${out.dim('→')} ${fix}${c.remediation?.host || /host-level/.test(fix) ? out.dim('  [needs access to the host]') : ''}`);
    if (c.note && verbose) out.print(`    ${out.dim(c.note)}`);
    if (verbose && c.details?.length) for (const d of c.details) out.print(`    ${out.dim(`${d.k}:`)} ${d.v}`);
    if (c.providers) for (const p of c.providers.filter((x) => x.fix)) out.print(`      ${out.dim('·')} ${p.label}: ${p.status.replace('_', ' ')}${verbose ? ` — ${p.fix.text}` : ''}`);
  }
}

async function doctor(ctx) {
  const { out, opts } = ctx;
  const local = localChecks(ctx.cfg);
  let health = null;
  let backendError = null;
  let backend = null;
  try {
    const client = await ctx.api();
    backend = { url: client.url };
    health = await client.get('/api/system/health?refresh=1', { timeoutMs: Math.max((opts.timeout ? Number(opts.timeout) : 30) * 1000, 60_000) });
  } catch (e) {
    backendError = e;
  }
  const checks = [...local, ...(health?.checks || [])];
  const failing = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  const ok = !backendError && failing.length === 0 && (!opts.strict || warns.length === 0);
  if (out.json) {
    out.data({ ok, backend: backend ? { ...backend, environment: health?.environment || null } : null, backendError: backendError ? { message: backendError.message, hint: backendError.hint } : null, local, health: health && { ready: health.ready, needsSetup: health.needsSetup, counts: health.counts, checks: health.checks.map(({ id, group, label, status, summary, remediation, note, details }) => ({ id, group, label, status, summary, remediation, note, details })) } });
  } else {
    out.print(out.bold('This machine'));
    renderChecks(local, out, { verbose: opts.verbose });
    out.print('');
    if (backendError) {
      out.print(out.bold('Backend'));
      out.print(`${out.red('✗')} ${out.bold('da-prompt backend')} — ${backendError.message}`);
      if (backendError.hint) out.print(`    ${out.dim('→')} ${backendError.hint}`);
    } else {
      const env = health.environment;
      out.print(`${out.bold('Backend')}  ${client_url(backend.url)} · ${env.kind === 'container' ? `${env.container} container` : 'host'} ${env.hostname} · da-prompt ${env.version}`);
      renderChecks(health.checks, out, { verbose: opts.verbose });
    }
    out.print('');
    out.print(ok ? out.green(`Ready. ${warns.length ? `${warns.length} item(s) could be improved (run with --verbose).` : 'Everything checked out.'}`) : out.red(`Not ready: ${failing.length + (backendError ? 1 : 0)} problem(s). Fix the lines marked ✗ (each shows the next step), then run da-prompt doctor again.`));
  }
  return ok ? EXIT.OK : EXIT.FAILED;
}
const client_url = (u) => u;

async function status(ctx) {
  const { out, opts, cfg } = ctx;
  let client;
  let rec = null;
  try {
    if (opts.url || ctx.env.DA_PROMPT_URL) client = (await connect({ cfg, opts, env: ctx.env, noStart: true })).client;
    else {
      rec = await liveServer(cfg);
      if (rec) client = new Client({ url: rec.url, password: ctx.env.DA_PROMPT_PASSWORD || ctx.env.FACTORY_PASSWORD || cfg.password, timeoutMs: (opts.timeout ? Number(opts.timeout) : 30) * 1000 });
    }
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    out.data({ running: false, error: e.message });
    out.error(e);
    return e.exitCode;
  }
  if (!client) {
    out.data({ running: false, dataDir: cfg.dataDir });
    out.print(`${out.yellow('○')} The da-prompt backend is not running (data: ${cfg.dataDir}).`);
    out.print(`  Start it with: da-prompt server start   (other commands start it automatically)`);
    return EXIT.UNAVAILABLE;
  }
  const [st, runs, health] = await Promise.all([client.get('/api/system/status'), client.get('/api/runs'), client.get('/api/system/health').catch(() => null)]);
  const active = runs.runs.filter((r) => r.executing);
  const recent = runs.runs.slice(0, 5);
  out.data({ running: true, url: client.url, backend: st, activeRuns: active.map((r) => ({ id: r.id, status: r.status, title: r.title })), recentRuns: recent.map((r) => ({ id: r.id, status: r.status, title: r.title })), health: health && { ready: health.ready, counts: health.counts } });
  out.print(`${out.green('●')} Backend running at ${client.url}  (pid ${st.pid}, up ${Math.round(st.uptimeSeconds)}s, da-prompt ${st.version})`);
  out.print(`  ${st.environment.kind === 'container' ? `${st.environment.container} container` : 'host'} ${st.environment.hostname} · Node ${st.environment.node} · ${st.auth ? 'password protected' : 'no password'} · browser UI: ${client.url}/`);
  if (health) out.print(`  Health: ${health.counts.ok} ready · ${health.counts.warn} need attention · ${health.counts.fail} problem(s)${health.ready ? '' : out.red('  — not ready, run da-prompt doctor')}`);
  out.print(`  Runs: ${active.length} active${active.length ? ` (${active.map((r) => r.id).join(', ')})` : ''}`);
  for (const r of recent) out.print(`    ${r.id}  ${r.status.padEnd(15)} ${ago(r.createdAt).padEnd(9)} ${r.title}`);
  return EXIT.OK;
}

function ask(rl, q, def = '') {
  return rl.question(`${q}${def ? ` [${def}]` : ''}: `).then((a) => a.trim() || def);
}

async function setup(ctx) {
  const { out, opts, io } = ctx;
  const client = await ctx.api();
  const actions = [];
  const values = {};
  const interactive = Boolean(io.stdin.isTTY && process.stdout.isTTY) && !opts['non-interactive'] && !opts.yes && !out.json;
  const flagged = ['provider', 'model', 'planner-provider', 'planner-model', 'project-root', 'readonly-root', 'output-root', 'pax-path', 'github-token-stdin'].some((k) => opts[k] !== undefined);
  out.info(`Backend: ${client.url}`);

  const settings = await getSettings(client);
  const get = (k) => settings.settings.find((s) => s.key === k);
  const merge = (key, add) => [...new Set([...(get(key)?.value || []), ...add])];

  if (opts['project-root']) values.projectRoots = merge('projectRoots', opts['project-root']);
  if (opts['readonly-root']) values.projectRootsReadOnly = merge('projectRootsReadOnly', opts['readonly-root']);
  if (opts['output-root'] !== undefined) values.outputRoot = opts['output-root'];
  if (opts['pax-path'] !== undefined) values.paxPath = opts['pax-path'];
  if (opts['github-token-stdin']) values.githubToken = await readStdin(io.stdin);

  // Provider/model: validated against what the provider really offers (and, unless skipped, with a real request).
  const pick = async (kind, provider, model) => {
    const r = await checkProvider(client, provider, model, { inference: !opts['skip-test'] });
    for (const s of r.stages) out.info(`${s.ok ? '✓' : '✗'} ${kind} ${s.stage}: ${s.message}`);
    if (!r.ok) throw new CliError(`${kind} provider ${provider}${model ? ` / ${model}` : ''} is not usable, so it was not saved.`, { code: EXIT.FAILED, hint: r.stages.find((s) => !s.ok)?.hint });
    return r;
  };
  if (opts.provider) {
    const r = await pick('default', opts.provider, opts.model);
    values.defaultProvider = opts.provider;
    values.defaultModel = r.model || '';
  }
  if (opts['planner-provider']) {
    const r = await pick('planner', opts['planner-provider'], opts['planner-model']);
    values.defaultPlannerProvider = opts['planner-provider'];
    values.defaultPlannerModel = r.model || '';
  }

  if (interactive && !flagged) {
    const rl = readline.createInterface({ input: io.stdin, output: process.stderr });
    try {
      const { providers } = await listProviders(client, { refresh: true });
      const ready = providers.filter((p) => p.status === 'ready' && p.type !== 'offline');
      if (ready.length) {
        out.info(`Providers ready now: ${ready.map((p) => `${p.id} (${p.models.length} models)`).join(', ')}`);
        const id = await ask(rl, 'Default provider', get('defaultProvider')?.value || ready[0].id);
        const p = providers.find((x) => x.id === id);
        if (!p || p.status !== 'ready') out.info(`  "${id}" is not ready; skipped. (${p ? providerFix(p) || p.status : 'unknown provider'})`);
        else {
          const model = await ask(rl, `Model (${p.models.slice(0, 5).map((m) => m.id).join(', ')}…)`, p.defaultModel || '');
          const r = await pick('default', id, model);
          values.defaultProvider = id;
          values.defaultModel = r.model || '';
        }
      } else out.info('No real model provider is ready. Add a key (printf %s "$KEY" | da-prompt providers set-key <id> --stdin) or start Ollama, then run setup again.');
      if (!get('projectRoots')?.value?.length) {
        const root = await ask(rl, 'Folder that contains your projects (blank to skip)');
        if (root) values.projectRoots = [path.resolve(root.replace(/^~/, os.homedir()))];
      }
    } finally {
      rl.close();
    }
  }

  if (Object.keys(values).length) {
    const saved = await saveSettings(client, values);
    for (const k of Object.keys(values)) actions.push({ setting: k, saved: true, restartRequired: saved.restartRequired.includes(k) });
    out.info(`Saved: ${Object.keys(values).join(', ')}${saved.restartRequired.length ? ` (restart required for: ${saved.restartRequired.join(', ')})` : ''}`);
  }
  const health = await client.get('/api/system/health?refresh=1', { timeoutMs: 90_000 });
  const todo = health.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
  out.data({ ok: health.ready, actions, ready: health.ready, remaining: todo.map((c) => ({ id: c.id, status: c.status, summary: c.summary, next: c.remediation?.text })) });
  out.print(health.ready ? out.green('Setup complete: the factory can run.') : out.red('Setup is not finished.'));
  renderChecks(todo, out);
  if (!todo.length) out.print('Everything checked out. Try: da-prompt projects list && da-prompt run "describe the change" --project <project>');
  else out.print(`\nFlags for non-interactive setup: --provider --model --planner-provider --planner-model --project-root --readonly-root --output-root --pax-path --github-token-stdin`);
  return health.ready ? EXIT.OK : EXIT.FAILED;
}

async function serverStart(ctx) {
  const { out, opts, cfg } = ctx;
  const port = opts.port ? Number(opts.port) : undefined;
  if (opts.port && !(port > 0 && port < 65536)) throw usageError('--port must be 1–65535.');
  const { record, started } = await startServer(cfg, { port });
  out.data({ running: true, started, pid: record.pid, url: record.url, dataDir: record.dataDir });
  out.print(started ? `${out.green('●')} Started the da-prompt backend: ${record.url}  (pid ${record.pid}, log ${logPath(cfg)})` : `${out.green('●')} Already running: ${record.url}  (pid ${record.pid})`);
  out.print(`  Browser UI: ${record.url}/   ·   Stop it with: da-prompt server stop`);
  return EXIT.OK;
}

async function serverStop(ctx) {
  const { out, opts, cfg } = ctx;
  const rec = await liveServer(cfg);
  if (rec) {
    try {
      const client = new Client({ url: rec.url, password: ctx.env.DA_PROMPT_PASSWORD || ctx.env.FACTORY_PASSWORD || cfg.password, timeoutMs: 5000 });
      const st = await client.get('/api/system/status');
      if (st.active.length && !opts.yes) throw new CliError(`${st.active.length} run(s) are executing (${st.active.join(', ')}). Stopping the backend interrupts them (they can be resumed).`, { code: EXIT.DENIED, hint: 'Cancel or wait for them, or pass --yes to stop anyway.' });
    } catch (e) {
      if (e instanceof CliError && e.exitCode === EXIT.DENIED && !/needs a password|password/.test(e.hint || '')) throw e;
    }
  }
  const r = await stopServer(cfg, { force: opts.force });
  out.data(r);
  out.print(r.stopped ? `${out.yellow('○')} Stopped the backend (pid ${r.pid}).` : 'The backend was not running.');
  return EXIT.OK;
}

async function serverStatus(ctx) {
  const rec = readRecord(ctx.cfg);
  const live = await liveServer(ctx.cfg);
  ctx.out.data({ running: Boolean(live), record: rec, stale: Boolean(rec && !live) });
  if (live) ctx.out.print(`${ctx.out.green('●')} running  ${live.url}  pid ${live.pid}  since ${live.startedAt} ${live.managed ? '(started by the CLI)' : '(started manually)'}`);
  else ctx.out.print(`${ctx.out.yellow('○')} not running${rec ? ` (a stale record for pid ${rec.pid}${pidAlive(rec.pid) ? ' that is not answering' : ''} was found)` : ''}`);
  return live ? EXIT.OK : EXIT.UNAVAILABLE;
}

async function serverLogs(ctx) {
  const n = ctx.opts.lines ? Number(ctx.opts.lines) : 40;
  const text = logTail(ctx.cfg, n);
  if (ctx.out.json) ctx.out.data({ log: logPath(ctx.cfg), lines: text.split('\n') });
  else ctx.out.print(text || `(no log yet: ${logPath(ctx.cfg)})`);
  if (ctx.opts.follow && !ctx.out.json) {
    let pos = fs.existsSync(logPath(ctx.cfg)) ? fs.statSync(logPath(ctx.cfg)).size : 0;
    await new Promise((resolve) => {
      const t = setInterval(() => {
        try {
          const size = fs.statSync(logPath(ctx.cfg)).size;
          if (size > pos) {
            const fd = fs.openSync(logPath(ctx.cfg), 'r');
            const b = Buffer.alloc(size - pos);
            fs.readSync(fd, b, 0, b.length, pos);
            fs.closeSync(fd);
            pos = size;
            process.stdout.write(b.toString('utf8'));
          }
        } catch {
          /* log not there yet */
        }
      }, 500);
      process.once('SIGINT', () => (clearInterval(t), resolve()));
    });
    return EXIT.INTERRUPTED;
  }
  return EXIT.OK;
}

export default [
  { path: ['setup'], summary: 'Configure the environment once: providers, models, project folders, tokens.', description: 'Checks everything, applies any flags you pass (validating providers with a real request), and — in a terminal — asks for what is missing. Never edits shell profiles or files outside the da-prompt data folder.', options: { provider: { type: 'string', valueName: 'ID', description: 'Default provider.' }, model: { type: 'string', valueName: 'NAME', description: 'Default model (must be offered by the provider).' }, 'planner-provider': { type: 'string', valueName: 'ID', description: 'Planner provider.' }, 'planner-model': { type: 'string', valueName: 'NAME', description: 'Planner model.' }, 'project-root': { type: 'string', multiple: true, valueName: 'DIR', description: 'Authorize a folder of projects (read/write).' }, 'readonly-root': { type: 'string', multiple: true, valueName: 'DIR', description: 'Authorize a read-only folder.' }, 'output-root': { type: 'string', valueName: 'DIR', description: 'Confine exported projects to this folder.' }, 'pax-path': { type: 'string', valueName: 'PATH', description: 'Use this PAX executable.' }, 'github-token-stdin': { type: 'boolean', description: 'Read a GitHub token from stdin.' }, 'skip-test': { type: 'boolean', description: 'Do not send a test request to the provider.' }, yes: { type: 'boolean', description: 'Do not prompt.' }, 'non-interactive': { type: 'boolean', description: 'Never prompt.' } }, examples: ['da-prompt setup', 'da-prompt setup --provider ollama --model qwen2.5-coder:7b --project-root ~/projects --yes', 'printf %s "$GITHUB_TOKEN" | da-prompt setup --github-token-stdin'], run: setup },
  { path: ['doctor'], summary: 'Check prerequisites and health; say exactly what is missing and how to fix it.', options: { verbose: { type: 'boolean', short: 'v', description: 'Show what was observed for every check.' }, strict: { type: 'boolean', description: 'Treat warnings as failures (exit 1).' } }, examples: ['da-prompt doctor', 'da-prompt doctor --json', 'da-prompt doctor --strict --no-start'], run: doctor },
  { path: ['status'], summary: 'Is the backend running, and what is it doing?', description: 'Never starts the backend. Exit code 3 when it is not running.', run: status },
  { path: ['server', 'start'], summary: 'Start the local backend (detached, 127.0.0.1) or report the running one.', options: { port: { type: 'string', valueName: 'N', description: 'Port to listen on (default: PORT or 4747).' } }, run: serverStart },
  { path: ['server', 'stop'], summary: 'Stop the local backend recorded for this data folder.', options: { force: { type: 'boolean', description: 'SIGKILL if it does not exit.' }, yes: { type: 'boolean', description: 'Stop even if runs are executing (they can be resumed).' } }, run: serverStop },
  { path: ['server', 'status'], summary: 'Show the backend process record.', run: serverStatus },
  { path: ['server', 'logs'], summary: 'Show the backend log.', options: { lines: { type: 'string', short: 'n', valueName: 'N', description: 'Lines to show (default 40).' }, follow: { type: 'boolean', short: 'f', description: 'Keep printing new lines.' } }, run: serverLogs },
  { path: ['server', 'restart'], summary: 'Stop and start the local backend (applies restart-only settings).', options: { yes: { type: 'boolean', description: 'Restart even if runs are executing.' }, port: { type: 'string', valueName: 'N', description: 'Port.' } }, async run(ctx) {
    await serverStop({ ...ctx, out: { ...ctx.out, print: () => {}, data: () => {} }, opts: { ...ctx.opts } });
    return serverStart(ctx);
  } },
];
