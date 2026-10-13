// config list|get|set|unset — the same persistent settings the browser edits (<data dir>/settings.json).
import { CliError, EXIT, readStdin, table, usageError } from '../core.js';
import { getSettings, saveSettings, parseSettingValue, settingKey } from '../ops.js';
import { stateFile, readState } from '../state.js';

const SOURCE = { saved: 'saved', environment: 'environment', default: 'default', startup: 'startup' };
const show = (s) => (s.kind === 'secret' ? (s.configured ? '(set)' : '(not set)') : s.hidden ? '(hidden: needs an authenticated session)' : Array.isArray(s.value) ? s.value.join(', ') || '(empty)' : s.value === '' || s.value === undefined ? '(empty)' : String(s.value));

const find = (view, key) => {
  const k = settingKey(key);
  const s = view.settings.find((x) => x.key === k);
  if (!s) throw new CliError(`"${key}" is not a setting this server supports.`, { code: EXIT.NOT_FOUND, hint: `See them with: da-prompt config list   (${view.settings.slice(0, 6).map((x) => x.key).join(', ')}, …)` });
  return s;
};

const describe = (s) => ({ key: s.key, group: s.group, label: s.label, value: s.kind === 'secret' || s.hidden ? undefined : s.value, configured: s.kind === 'secret' ? s.configured : undefined, hidden: s.hidden || undefined, source: s.source, env: s.env || undefined, applies: s.apply, restartPending: s.restartPending || undefined, editable: s.editable });

async function list(ctx) {
  const { out, opts } = ctx;
  const view = await getSettings(await ctx.api());
  const rows = view.settings.filter((s) => !opts.group || s.group === opts.group);
  if (opts.group && !rows.length) throw new CliError(`No settings group "${opts.group}".`, { code: EXIT.NOT_FOUND, hint: `Groups: ${view.groups.map((g) => g.id).join(', ')}` });
  out.data({ admin: view.admin, file: view.file, settings: rows.map(describe) });
  out.print(table(rows, [{ title: 'key', key: 'key' }, { title: 'value', get: show, max: 48 }, { title: 'source', get: (s) => `${SOURCE[s.source]}${s.source === 'environment' && s.env ? `:${s.env}` : ''}`, max: 34 }, { title: 'applies', get: (s) => (s.apply === 'restart' ? `restart${s.restartPending ? ' (pending)' : ''}` : 'now') }], out));
  out.print('');
  out.print(out.dim(`Precedence: run option > startup option > saved > environment > default. Saved to ${view.file.persisted ? 'settings.json' : 'settings.json (nothing saved yet)'} on the backend; secrets are never shown.`));
  if (!view.admin) out.print(out.dim('Settings that grant host access are hidden from this session (set an access password, or run on the server machine).'));
  return EXIT.OK;
}

async function get(ctx) {
  const s = find(await getSettings(await ctx.api()), ctx.args[0]);
  ctx.out.data(describe(s));
  ctx.out.print(show(s));
  ctx.out.info(`source: ${s.source}${s.env ? ` (${s.env})` : ''} · applies ${s.apply === 'restart' ? 'after a restart' : 'immediately'}`);
  return EXIT.OK;
}

async function set(ctx) {
  const { out, opts, args, io } = ctx;
  const client = await ctx.api();
  const def = find(await getSettings(client), args[0]);
  let value;
  if (def.kind === 'secret') {
    if (opts.stdin && opts['from-env']) throw usageError('Use either --stdin or --from-env, not both.');
    if (opts.stdin) value = await readStdin(io.stdin);
    else if (opts['from-env']) {
      value = ctx.env[opts['from-env']];
      if (!value) throw new CliError(`The environment variable ${opts['from-env']} is not set in this shell.`, { code: EXIT.USAGE });
    } else value = parseSettingValue(def, args.slice(1));
    if (!value) throw usageError('The value is empty.');
  } else {
    if (opts.stdin || opts['from-env']) throw usageError(`${def.key} is not a secret; pass its value as an argument.`);
    if (args.length < 2) throw usageError(`Usage: da-prompt config set ${def.key} <value>.`);
    value = parseSettingValue(def, args.slice(1));
  }
  const r = await saveSettings(client, { [def.key]: value });
  const after = find(await getSettings(client), def.key);
  out.data({ saved: r.saved, key: def.key, changed: r.changed.includes(def.key), source: after.source, restartRequired: r.restartRequired.includes(def.key), value: def.kind === 'secret' ? undefined : after.value, configured: def.kind === 'secret' ? after.configured : undefined });
  out.print(`${out.green('✓')} Saved ${def.key} = ${show(after)}  (${def.apply === 'restart' ? 'takes effect after a restart: da-prompt server restart' : 'applies immediately'})`);
  if (after.envAlsoSet) out.print(out.dim(`  ${def.env} is also set in the environment; the saved value wins. Remove it with: da-prompt config unset ${def.key}`));
  return EXIT.OK;
}

async function unset(ctx) {
  const client = await ctx.api();
  const def = find(await getSettings(client), ctx.args[0]);
  const r = await saveSettings(client, { [def.key]: null });
  const after = find(await getSettings(client), def.key);
  ctx.out.data({ saved: r.saved, key: def.key, source: after.source });
  ctx.out.print(`${ctx.out.green('✓')} Reset ${def.key}; it now comes from the ${after.source}${after.env && after.source === 'environment' ? ` (${after.env})` : ''}: ${show(after)}`);
  return EXIT.OK;
}

async function where(ctx) {
  const st = readState(ctx.env);
  ctx.out.data({ dataDir: ctx.cfg.dataDir, settingsFile: `${ctx.cfg.dataDir}/settings.json`, cliState: stateFile(ctx.env), currentProject: st.project || null });
  ctx.out.print(`settings (backend)  ${ctx.cfg.dataDir}/settings.json\nCLI state           ${stateFile(ctx.env)}  (only the selected project)\ncurrent project     ${st.project ? st.project.label || st.project.directoryId || st.project.repoUrl : '(none)'}`);
  return EXIT.OK;
}

export default [
  { path: ['config', 'list'], summary: 'Show every setting with its effective value and where it came from.', options: { group: { type: 'string', valueName: 'GROUP', description: 'models, execution, folders, github, pax or server.' } }, examples: ['da-prompt config list', 'da-prompt config list --group github --json'], run: list },
  { path: ['config', 'get'], summary: 'Show one setting.', args: '<key>', minArgs: 1, examples: ['da-prompt config get defaultProvider'], run: get },
  { path: ['config', 'set'], summary: 'Validate and save a setting.', description: 'Values are validated by the backend before anything is saved. Secrets (githubToken, password) are never accepted as arguments: use --stdin or --from-env.', args: '<key> <value...>', minArgs: 1, maxArgs: 50, options: { stdin: { type: 'boolean', description: 'Read a secret value from stdin.' }, 'from-env': { type: 'string', valueName: 'NAME', description: 'Read a secret value from this environment variable.' } }, examples: ['da-prompt config set maxParallel 5', 'da-prompt config set projectRoots ~/projects ~/work', 'printf %s "$TOKEN" | da-prompt config set githubToken --stdin'], run: set },
  { path: ['config', 'unset'], summary: 'Remove a saved value (falls back to the environment, then the default).', args: '<key>', minArgs: 1, run: unset },
  { path: ['config', 'path'], summary: 'Where settings and CLI state are stored.', run: where },
];
