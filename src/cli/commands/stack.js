// `da-prompt stack`: the product stack components a new app can be built on (GET /api/stack, templates/stack.json).
import { EXIT, table } from '../core.js';

async function stack(ctx) {
  const client = await ctx.api();
  const d = await client.get('/api/stack');
  ctx.out.data(d);
  const { out } = ctx;
  out.print(table(d.components, [
    { title: 'id', key: 'id' },
    { title: 'component', key: 'label' },
    { title: 'status', get: (c) => (c.status === 'supported' ? (c.required ? 'required' : 'supported') : 'unsupported') },
    { title: 'packages', get: (c) => Object.entries(c.packages || {}).map(([k, v]) => `${k}@${v}`).join(' '), max: 70 },
  ], out));
  for (const c of d.components.filter((x) => x.status !== 'supported')) out.print(`\n${out.yellow('!')} ${c.label} (${c.id}): ${c.blocker}\n    ${out.dim('→')} ${c.next}`);
  out.print(`\n${out.dim(`Default: ${d.default.join(', ')}. Select with: da-prompt run "…" --new --stack feltdb`)}`);
  return EXIT.OK;
}

export default [
  { path: ['stack'], summary: 'List the product stack components a new app can use: status, pinned packages, blockers.', examples: ['da-prompt stack', 'da-prompt stack --json', 'da-prompt run "A habit tracker" --new --stack feltdb'], run: stack },
];
