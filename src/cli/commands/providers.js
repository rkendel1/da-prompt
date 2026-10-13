// providers list|show|models|test|use|planner|set-key|set-url|add
import { CliError, EXIT, readStdin, table, usageError } from '../core.js';
import { listProviders, checkProvider, providerFix, saveSettings, getSettings } from '../ops.js';

const STATUS = { ready: 'ready', no_key: 'needs key', unreachable: 'unreachable', auth_error: 'key rejected', error: 'error', empty: 'no models', disabled: 'disabled' };

async function find(client, id) {
  const { providers, defaultProvider } = await listProviders(client, { refresh: true });
  const p = providers.find((x) => x.id === id);
  if (!p) throw new CliError(`Unknown provider "${id}".`, { code: EXIT.NOT_FOUND, hint: `Known: ${providers.map((x) => x.id).join(', ')}` });
  return { p, providers, defaultProvider };
}

async function list(ctx) {
  const { out } = ctx;
  const client = await ctx.api();
  const [{ providers, defaultProvider, defaultModel: autoModel, defaultSource }, settings] = await Promise.all([listProviders(client, { refresh: true }), getSettings(client)]);
  const dp = settings.settings.find((s) => s.key === 'defaultProvider');
  const dm = settings.settings.find((s) => s.key === 'defaultModel');
  const pp = settings.settings.find((s) => s.key === 'defaultPlannerProvider');
  const pm = settings.settings.find((s) => s.key === 'defaultPlannerModel');
  out.data({ defaultProvider, defaultModel: autoModel || null, defaultSource: defaultSource || null, default: { provider: dp?.value || null, model: dm?.value || null, source: dp?.source }, planner: { provider: pp?.value || null, model: pm?.value || null, source: pp?.source }, providers: providers.map((p) => ({ id: p.id, label: p.label, type: p.type, status: p.status, message: p.message || null, models: (p.models || []).length, local: p.local, baseUrl: p.baseUrl, baseUrlSource: p.baseUrlSource, hasKey: p.hasKey, keySource: p.keySource, enabled: p.enabled })) });
  out.print(table(providers, [{ title: 'id', key: 'id' }, { title: 'provider', key: 'label', max: 24 }, { title: 'status', get: (p) => (p.status === 'ready' ? out.green(STATUS.ready) : out.yellow(STATUS[p.status] || p.status)) }, { title: 'models', get: (p) => (p.models || []).length }, { title: 'url / key from', get: (p) => `${p.baseUrl ? `${p.baseUrlSource || ''}` : ''}${p.needsKey || p.hasKey ? ` · key ${p.keySource || 'none'}` : ''}`.trim() || '—', max: 26 }, { title: 'note', get: (p) => p.message || '', max: 50 }], out));
  out.print('');
  out.print(`Default: ${dp?.value || `(automatic → ${defaultProvider}${autoModel ? ` / ${autoModel}` : ''})`}${dm?.value ? ` / ${dm.value}` : ''}   ${out.dim(dp?.value ? `source: ${dp.source}` : `chosen by: ${defaultSource || 'automatic'}`)}`);
  out.print(`Planner: ${pp?.value ? `${pp.value}${pm?.value ? ` / ${pm.value}` : ''}` : '(same as the default)'}`);
  return EXIT.OK;
}

async function show(ctx) {
  const { out } = ctx;
  const { p } = await find(await ctx.api(), ctx.args[0]);
  out.data({ provider: { id: p.id, label: p.label, type: p.type, status: p.status, message: p.message, baseUrl: p.baseUrl, baseUrlSource: p.baseUrlSource, hasKey: p.hasKey, keySource: p.keySource, keyEnv: p.keyEnv, local: p.local, enabled: p.enabled, defaultModel: p.defaultModel, numCtx: p.numCtx, toolMode: p.toolMode, models: (p.models || []).length, checkedAt: p.checkedAt } });
  out.print(`${out.bold(p.label)} (${p.id}, ${p.type}${p.local ? ', local' : ''})`);
  out.print(`  status   ${p.status === 'ready' ? out.green('ready') : out.yellow(STATUS[p.status] || p.status)}${p.message ? ` — ${p.message}` : ''}`);
  out.print(`  url      ${p.baseUrl || '—'}  ${out.dim(`(${p.baseUrlSource || 'default'})`)}`);
  out.print(`  key      ${p.hasKey ? `configured (${p.keySource})` : p.needsKey ? 'missing' : 'not needed'}${p.keyEnv ? out.dim(`  env: ${p.keyEnv}`) : ''}`);
  out.print(`  models   ${(p.models || []).length}${p.defaultModel ? `, best default: ${p.defaultModel}` : ''}   tool mode: ${p.toolMode}${p.numCtx ? `   context: ${p.numCtx}` : ''}`);
  const fix = providerFix(p);
  if (fix && p.status !== 'ready') out.print(`  ${out.dim('→')} ${fix}`);
  return p.status === 'ready' ? EXIT.OK : EXIT.FAILED;
}

async function models(ctx) {
  const { out } = ctx;
  const { p } = await find(await ctx.api(), ctx.args[0]);
  if (p.status !== 'ready') throw new CliError(`${p.label} is ${STATUS[p.status] || p.status}${p.message ? `: ${p.message}` : ''}; no models can be listed.`, { code: EXIT.FAILED, hint: providerFix(p) });
  const ms = (p.models || []).map((m) => ({ id: m.id, label: m.label, params: m.params, size: m.size, ctx: m.ctx, tools: m.tools !== false, default: m.id === p.defaultModel }));
  out.data({ provider: p.id, models: ms });
  out.print(table(ms, [{ title: 'model', get: (m) => `${m.default ? '* ' : '  '}${m.id}`, max: 60 }, { title: 'params', get: (m) => m.params || '' }, { title: 'size', get: (m) => (m.size ? `${(m.size / 1e9).toFixed(1)} GB` : '') }, { title: 'ctx', get: (m) => (m.ctx ? `${Math.round(m.ctx / 1024)}k` : '') }, { title: 'tools', get: (m) => (m.tools ? 'native' : 'json mode') }], out));
  out.print(out.dim('Listed means "the provider reports it". Prove it works with: da-prompt providers test <id> --model <name>'));
  return EXIT.OK;
}

async function test(ctx) {
  const { out, opts } = ctx;
  const client = await ctx.api();
  const r = await checkProvider(client, ctx.args[0], opts.model, { inference: true });
  out.data({ ok: r.ok, provider: r.provider.id, model: r.model, stages: r.stages });
  const order = ['connectivity', 'discovery', 'inference'];
  for (const name of order) {
    const s = r.stages.find((x) => x.stage === name);
    if (!s) out.print(`${out.dim('–')} ${name.padEnd(12)} skipped (an earlier stage failed)`);
    else out.print(`${s.ok ? out.green('✓') : out.red('✗')} ${name.padEnd(12)} ${s.message}${s.hint ? `\n    ${out.dim('→')} ${s.hint}` : ''}`);
  }
  out.print(r.ok ? out.green(`\n${r.provider.label} / ${r.model} can run requests.`) : out.red('\nNot usable yet — see the first ✗ above.'));
  return r.ok ? EXIT.OK : EXIT.FAILED;
}

async function use(ctx, planner) {
  const { out, opts, args } = ctx;
  const client = await ctx.api();
  const id = args[0];
  const [pk, mk, label] = planner ? ['defaultPlannerProvider', 'defaultPlannerModel', 'planner'] : ['defaultProvider', 'defaultModel', 'default'];
  if (planner && opts.clear) {
    await saveSettings(client, { [pk]: null, [mk]: null });
    out.data({ saved: true, planner: null });
    out.print(`${out.green('✓')} Planner reset: the planner now uses the default provider.`);
    return EXIT.OK;
  }
  if (!id) throw usageError(`Usage: da-prompt providers ${planner ? 'planner' : 'use'} <provider> [--model <name>]${planner ? ' | --clear' : ''}`);
  const r = await checkProvider(client, id, opts.model, { inference: !opts['skip-test'] });
  for (const s of r.stages) out.info(`${s.ok ? '✓' : '✗'} ${s.stage}: ${s.message}`);
  if (!r.ok) throw new CliError(`${id}${opts.model ? ` / ${opts.model}` : ''} is not usable, so the ${label} was not changed.`, { code: EXIT.FAILED, hint: r.stages.find((s) => !s.ok)?.hint || (opts['skip-test'] ? undefined : 'Use --skip-test to save without sending a test request.') });
  await saveSettings(client, { [pk]: id, [mk]: r.model || '' });
  out.data({ saved: true, [label]: { provider: id, model: r.model }, stages: r.stages });
  out.print(`${out.green('✓')} ${label} provider set to ${id}${r.model ? ` / ${r.model}` : ''}. New runs use it unless they pass --provider/--model.`);
  return EXIT.OK;
}

async function secretFrom(ctx) {
  const { opts, io, env } = ctx;
  if (opts.stdin && opts['from-env']) throw usageError('Use either --stdin or --from-env.');
  if (opts.stdin) return readStdin(io.stdin);
  if (opts['from-env']) {
    if (!env[opts['from-env']]) throw new CliError(`The environment variable ${opts['from-env']} is not set in this shell.`, { code: EXIT.USAGE });
    return env[opts['from-env']];
  }
  throw usageError('Keys are never accepted as arguments (they would appear in process listings).', 'printf %s "$KEY" | da-prompt providers set-key <id> --stdin   or   --from-env NAME');
}

async function setKey(ctx) {
  const client = await ctx.api();
  const { p } = await find(client, ctx.args[0]);
  const key = await secretFrom(ctx);
  if (!key) throw usageError('The key is empty.');
  const r = await client.patch(`/api/providers/${encodeURIComponent(p.id)}`, { apiKey: key });
  ctx.out.data({ saved: true, provider: p.id, status: r.provider.status, hasKey: r.provider.hasKey });
  ctx.out.print(`${r.provider.status === 'ready' ? ctx.out.green('✓') : ctx.out.yellow('!')} Key saved for ${p.label} (stored on the backend, never shown again). Provider is now: ${STATUS[r.provider.status] || r.provider.status}${r.provider.message ? ` — ${r.provider.message}` : ''}`);
  return r.provider.status === 'ready' ? EXIT.OK : EXIT.FAILED;
}

async function setUrl(ctx) {
  const client = await ctx.api();
  const { p } = await find(client, ctx.args[0]);
  const r = await client.patch(`/api/providers/${encodeURIComponent(p.id)}`, { baseUrl: ctx.args[1] });
  ctx.out.data({ saved: true, provider: p.id, baseUrl: r.provider.baseUrl, status: r.provider.status });
  ctx.out.print(`${r.provider.status === 'ready' ? ctx.out.green('✓') : ctx.out.yellow('!')} ${p.label} now points at ${r.provider.baseUrl}: ${STATUS[r.provider.status] || r.provider.status}${r.provider.message ? ` — ${r.provider.message}` : ''}`);
  return r.provider.status === 'ready' ? EXIT.OK : EXIT.FAILED;
}

async function add(ctx) {
  const { opts } = ctx;
  if (!opts.label || !opts['provider-url']) throw usageError('Usage: da-prompt providers add --label <name> --provider-url <url> [--type openai|ollama|anthropic] [--stdin]');
  const client = await ctx.api();
  const body = { label: opts.label, type: opts.type || 'openai', baseUrl: opts['provider-url'] };
  if (opts.stdin || opts['from-env']) body.apiKey = await secretFrom(ctx);
  const r = await client.post('/api/providers', body);
  ctx.out.data({ saved: true, provider: { id: r.provider.id, status: r.provider.status } });
  ctx.out.print(`${ctx.out.green('✓')} Added ${r.provider.label} (${r.provider.id}): ${STATUS[r.provider.status] || r.provider.status}`);
  return EXIT.OK;
}

const secretOpts = { stdin: { type: 'boolean', description: 'Read the key from stdin.' }, 'from-env': { type: 'string', valueName: 'NAME', description: 'Read the key from this environment variable.' } };
const modelOpt = { model: { type: 'string', valueName: 'NAME', description: 'Model name (must be offered by the provider).' }, 'skip-test': { type: 'boolean', description: 'Do not send a test request before saving.' } };

export default [
  { path: ['providers', 'list'], summary: 'List providers, their health and the current default.', examples: ['da-prompt providers list', 'da-prompt providers list --json'], run: list },
  { path: ['providers', 'show'], summary: 'One provider: URL, key source, status, models.', args: '<provider>', minArgs: 1, run: show },
  { path: ['providers', 'models'], summary: 'Models the provider reports (discovery only).', args: '<provider>', minArgs: 1, run: models },
  { path: ['providers', 'test'], summary: 'Prove a provider/model works: connectivity, discovery, then a real request.', args: '<provider>', minArgs: 1, options: { model: modelOpt.model }, examples: ['da-prompt providers test ollama --model qwen2.5-coder:7b'], run: test },
  { path: ['providers', 'use'], summary: 'Make a provider/model the default (validated first).', args: '<provider>', minArgs: 0, options: modelOpt, examples: ['da-prompt providers use ollama --model qwen2.5-coder:7b'], run: (c) => use(c, false) },
  { path: ['providers', 'planner'], summary: 'Use a different provider/model for planning.', args: '<provider>', minArgs: 0, options: { ...modelOpt, clear: { type: 'boolean', description: 'Go back to planning with the default provider.' } }, run: (c) => use(c, true) },
  { path: ['providers', 'set-key'], summary: 'Save a provider API key (read from stdin or an environment variable).', args: '<provider>', minArgs: 1, options: secretOpts, examples: ['printf %s "$ANTHROPIC_API_KEY" | da-prompt providers set-key anthropic --stdin'], run: setKey },
  { path: ['providers', 'set-url'], summary: 'Change a provider\'s base URL.', args: '<provider> <url>', minArgs: 2, run: setUrl },
  { path: ['providers', 'add'], summary: 'Add a custom OpenAI-compatible (or other) provider.', options: { label: { type: 'string', valueName: 'NAME', description: 'Display name.' }, 'provider-url': { type: 'string', valueName: 'URL', description: 'The provider\'s base URL.' }, type: { type: 'string', valueName: 'TYPE', description: 'openai (default), ollama or anthropic.' }, ...secretOpts }, run: add },
];
