// `da-prompt catalog` and `da-prompt spec check`: the technology catalog and profiles (GET /api/catalog), and validation of an
// application specification (POST /api/spec/validate, the same checks run creation applies). Both only read.
import { EXIT, CliError, table, usageError } from '../core.js';
import { readSpecOption } from './runs.js';

async function catalog(ctx) {
  const client = await ctx.api();
  const d = await client.get('/api/catalog');
  ctx.out.data(d);
  const { out } = ctx;
  const only = ctx.opts.category;
  if (only && !d.categories.some((c) => c.id === only)) throw usageError(`Unknown category "${only}". Categories: ${d.categories.map((c) => c.id).join(', ')}.`);
  for (const c of d.categories.filter((x) => !only || x.id === only)) {
    out.print(`\n${c.label} (${c.select === 'one' ? 'choose one' : 'choose any'}, field "${c.field}")`);
    out.print(table(d.entries.filter((e) => e.category === c.id && (ctx.opts.all || e.status !== 'planned')), [
      { title: 'id', key: 'id' },
      { title: 'name', key: 'name' },
      { title: 'status', key: 'status' },
      { title: 'note', get: (e) => e.constraint || e.description, max: 70 },
    ], out));
    const hidden = d.entries.filter((e) => e.category === c.id && e.status === 'planned');
    if (hidden.length && !ctx.opts.all) out.print(out.dim(`  not yet supported: ${hidden.map((e) => e.id).join(', ')} (--all shows their blockers)`));
  }
  out.print(`\nProfiles: ${d.profiles.map((p) => `${p.id} (${p.lifecycle})`).join(', ')}`);
  out.print(out.dim('Check a selection: da-prompt spec check --profile production-web   ·   use it: da-prompt run "…" --new --spec app.json'));
  return EXIT.OK;
}

async function check(ctx) {
  const spec = readSpecOption(ctx.opts);
  if (!spec) throw usageError('Give a specification: da-prompt spec check --spec app.json (and/or --profile <id>).');
  const client = await ctx.api();
  const source = ctx.opts.project ? { projectId: ctx.opts.project } : undefined;
  const r = await client.post('/api/spec/validate', { spec, source, provider: ctx.opts.provider });
  ctx.out.data(r);
  const { out } = ctx;
  if (r.summary) out.print(`${r.ok ? out.green('valid') : out.red('not valid')}  ${r.summary}`);
  for (const d of r.diagnostics || []) out.print(`${d.level === 'error' ? out.red('✗') : out.yellow('!')} ${d.message}\n    ${out.dim('→')} ${d.resolution}`);
  for (const i of r.plan?.items || []) out.print(out.dim(`  ${i.action}: ${i.detail}`));
  if (!r.ok) throw new CliError('The application specification is not valid.', { code: EXIT.USAGE, hint: 'Fix the problems above (da-prompt catalog lists the options).' });
  return EXIT.OK;
}

const specOptions = {
  spec: { type: 'string', valueName: 'FILE', description: 'The application specification (JSON).' },
  profile: { type: 'string', valueName: 'ID', description: 'Start from a catalog profile.' },
  project: { type: 'string', valueName: 'ID', description: 'Check it as an enhancement of this registered project (detects what the project has).' },
  provider: { type: 'string', valueName: 'ID', description: 'The provider the run would use (the offline agents can build fewer options).' },
};

export default [
  { path: ['catalog'], summary: 'List the technology catalog: what each option is, whether it is supported, and the profiles.', options: { category: { type: 'string', valueName: 'ID', description: 'Only this category.' }, all: { type: 'boolean', description: 'Include options that are not supported yet, with their blockers.' } }, examples: ['da-prompt catalog', 'da-prompt catalog --category frontend --all', 'da-prompt catalog --json'], run: catalog },
  { path: ['spec', 'check'], summary: 'Validate an application specification without starting anything.', options: specOptions, examples: ['da-prompt spec check --profile production-web', 'da-prompt spec check --spec app.json --project prj_abc'], run: check },
];
