// A deterministic, network-free provider that speaks the same tool-use protocol as Claude.
// It plans and builds a small but real full-stack app from templates, so the entire factory
// (planning, parallel agents, verification, feedback, deployment, delivery) can run end-to-end
// with no API key — in demos, in CI and in this repo's own tests.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'offline-app');
// The product stack (templates/stack.json, the same file src/stack.js reads): which packages a selected stack resolves to.
const STACK = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, '..', 'stack.json'), 'utf8'));

/**
 * The kinds of app the offline agents can build, from the run's stack and idea:
 * - releases: signed artifact releases, when Distribution Protocol is selected (stored in FeltDB when FeltDB is selected);
 * - tracker: items with a create/update workflow (stored in FeltDB when FeltDB is selected);
 * - catalog: a read-only, searchable reference, for catalog-like ideas on the default stack.
 * The model-backed agents are not limited to these; the offline templates cover exactly these profiles.
 */
export function appKind(inputs = {}, stack = STACK.default) {
  if (stack.includes('distribution')) return 'releases';
  if (stack.includes('feltdb')) return 'tracker';
  return /\b(catalog(ue)?|directory|glossary|reference|lookup|encyclop(a)?edia|knowledge ?base|handbook)\b/i.test(`${inputs.idea || ''}`) ? 'catalog' : 'tracker';
}

/** Template layers, most specific first: files under templates/offline-app/variants/<layer>/ replace the shared ones. */
const layersOf = (kind, stack) => {
  if (!stack.includes('feltdb')) return [kind];
  return kind === 'releases' ? ['releases-feltdb', 'releases', 'feltdb'] : kind === 'tracker' ? ['feltdb', 'tracker'] : [kind];
};

/** The files each task writes, for this kind and stack. */
function filesFor(taskId, kind, stack) {
  const files = [...(TASK_FILES[taskId] || [])];
  if (taskId === 'core' && kind === 'releases') files.splice(files.length - 1, 0, ['src/signing.js', 'src/signing.js.tpl']);
  // A FeltDB store's data model: feltdb.flow, deployed and enforced by src/flow.js (written before the store that uses it).
  if (taskId === 'core' && stack.includes('feltdb') && kind !== 'catalog') files.splice(2, 0, ['feltdb.flow', 'feltdb.flow.tpl'], ['src/flow.js', 'src/flow.js.tpl']);
  if (taskId === 'tests') {
    files.unshift(['test/helpers.js', 'test/helpers.js.tpl']);
    if (stack.includes('feltdb') && kind !== 'catalog') files.push(['test/feltdb.test.js', 'test/feltdb.test.js.tpl']);
    if (kind === 'releases') files.push(['test/keys.js', 'test/keys.js.tpl'], ['test/distribution.test.js', 'test/distribution.test.js.tpl']);
  }
  return files;
}

/** The dependencies a stack resolves to (the same merge as src/stack.js stackDependencies). */
function stackDeps(stack) {
  const dependencies = {};
  const devDependencies = {};
  for (const id of stack) {
    Object.assign(dependencies, STACK.components[id]?.dependencies || {});
    Object.assign(devDependencies, STACK.components[id]?.devDependencies || {});
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return { dependencies: sorted(dependencies), devDependencies: sorted(devDependencies) };
}

const STATS_OK = `
  stats() {
    const all = [...this.items.values()];
    return { total: all.length, done: all.filter((i) => i.done).length };
  }
`;
// A realistic slip: an object literal that is never closed. The verifier catches it and the
// feedback loop sends the SyntaxError back to the engineer, who fixes it on the next attempt.
const STATS_FAULTY = `
  stats() {
    const all = [...this.items.values()];
    return { total: all.length, done: all.filter((i) => i.done).length ;
  }
`;
const FELTDB_STATS_OK = `
  async stats() {
    const all = await this.list();
    return { total: all.length, done: all.filter((i) => i.done).length };
  }
`;
const FELTDB_STATS_FAULTY = `
  async stats() {
    const all = await this.list();
    return { total: all.length, done: all.filter((i) => i.done).length ;
  }
`;
const RELEASES_STATS_OK = `
  stats() {
    return { total: this.items.size, products: new Set([...this.items.values()].map((r) => r.name)).size };
  }
`;
const RELEASES_STATS_FAULTY = `
  stats() {
    return { total: this.items.size, products: new Set([...this.items.values()].map((r) => r.name)).size ;
  }
`;
const RELEASES_FELTDB_STATS_OK = `
  async stats() {
    const all = await this.list();
    return { total: all.length, products: new Set(all.map((r) => r.name)).size };
  }
`;
const RELEASES_FELTDB_STATS_FAULTY = `
  async stats() {
    const all = await this.list();
    return { total: all.length, products: new Set(all.map((r) => r.name)).size ;
  }
`;
const CATALOG_STATS_OK = `
  stats() {
    const all = [...this.items.values()];
    return { total: all.length, categories: new Set(all.map((e) => e.category)).size };
  }
`;
const CATALOG_STATS_FAULTY = `
  stats() {
    const all = [...this.items.values()];
    return { total: all.length, categories: new Set(all.map((e) => e.category)).size ;
  }
`;

const TASK_FILES = {
  prd: [['PRD.md', 'PRD.md.tpl']],
  core: [
    ['package.json', 'package.json.tpl'],
    ['.gitignore', 'gitignore.tpl'],
    ['src/store.js', 'src/store.js.tpl'],
    ['src/auth.js', 'src/auth.js.tpl'],
    ['src/appport.js', 'src/appport.js.tpl'],
    ['src/app.js', 'src/app.js.tpl'],
  ],
  ui: [
    ['public/index.html', 'public/index.html.tpl'],
    ['public/style.css', 'public/style.css.tpl'],
    ['public/app.js', 'public/app.js.tpl'],
  ],
  tests: [
    ['test/app.test.js', 'test/app.test.js.tpl'],
    ['test/appport.test.js', 'test/appport.test.js.tpl'],
  ],
  deploy: [
    ['Dockerfile', 'Dockerfile.tpl'],
    ['DEPLOY.md', 'DEPLOY.md.tpl'],
  ],
  docs: [['README.md', 'README.md.tpl']],
};

const SUMMARIES = {
  tracker: {
    prd: 'Wrote PRD.md: users, four core flows, success criteria, scope and risks.',
    core: 'Implemented the in-memory ItemStore with validation, an HTTP API (health, list, create, get, update, delete) that also serves the UI, and the AppPort capability boundary (items.list/get/create/update, token-authorized) over the same store; installed the pinned @appport packages.',
    ui: 'Built an accessible, responsive web UI (add, complete, filter, delete) with light/dark themes using relative API URLs.',
    tests: 'Added node:test suites for every endpoint, validation errors, 404/405 handling and static path safety, and for the AppPort boundary (discovery, invocation, authorization, state checked against the store); npm test passes.',
    deploy: 'Added a non-root Dockerfile with a HEALTHCHECK and DEPLOY.md covering local, Docker and PaaS deployment.',
    docs: 'Wrote README.md with quick start, features, API reference, AppPort capabilities, layout and next steps.',
    fix: 'Fixed: closed the unterminated object literal in ItemStore.stats().',
  },
  catalog: {
    prd: 'Wrote PRD.md: users, browse/search/filter flows, success criteria, scope and risks.',
    core: 'Implemented the read-only EntryStore with search rules, a GET-only HTTP API (health, entries, entry, categories) that also serves the UI, and the AppPort capability boundary (entries.search/get/categories, token-authorized reads, no writes) over the same store; installed the pinned @appport packages.',
    ui: 'Built an accessible, responsive search UI (text and category filter) with light/dark themes using relative API URLs.',
    tests: 'Added node:test suites for every endpoint, read-only enforcement and static path safety, and for the AppPort boundary (discovery, invocation, authorization, results checked against the store); npm test passes.',
    deploy: 'Added a non-root Dockerfile with a HEALTHCHECK and DEPLOY.md covering local, Docker and PaaS deployment.',
    docs: 'Wrote README.md with quick start, features, API reference, AppPort capabilities, layout and next steps.',
    fix: 'Fixed: closed the unterminated object literal in EntryStore.stats().',
  },
  releases: {
    prd: 'Wrote PRD.md: publishers, consumers, publish/verify flows, success criteria, scope and risks.',
    core: 'Implemented the ReleaseStore, release signing and verification with @distribution-protocol/protocol (publisher key from the environment, trust anchored to the app\'s own key), a read-only HTTP API plus public verification, and the AppPort capability boundary (releases.publish/list/get/verify, token-authorized) over the same store; installed the pinned packages.',
    ui: 'Built an accessible, responsive release list with per-release verification using relative API URLs.',
    tests: 'Added node:test suites for the HTTP API, the AppPort boundary, and signing: publish, verify, tampered manifests, wrong artifact bytes and foreign keys are rejected; npm test passes.',
    deploy: 'Added a non-root Dockerfile with a HEALTHCHECK and DEPLOY.md covering the publisher key and token variables.',
    docs: 'Wrote README.md with quick start, API, AppPort capabilities, signing and verification, layout and next steps.',
    fix: 'Fixed: closed the unterminated object literal in ReleaseStore.stats().',
  },
};
const FELTDB_SUMMARY = ' State is stored durably in FeltDB (@feltdb/core) under the model in feltdb.flow (deployed at startup, every record checked against it), with the app as the sole writer of its DATA_DIR.';

export class OfflineProvider {
  constructor({ faults = 'on', delayMs = Number(process.env.FACTORY_OFFLINE_DELAY_MS ?? 350) } = {}) {
    this.name = 'offline';
    this.faults = faults === true ? 'on' : faults === false ? 'off' : faults;
    this.delayMs = delayMs;
  }

  describe() {
    return { name: this.name, model: 'offline-template-agent', faults: this.faults };
  }

  async chat({ messages, signal, meta = {} }) {
    if (this.delayMs) await sleep(this.delayMs, signal);
    if (signal?.aborted) throw new Error('cancelled');
    let content;
    if (meta.kind === 'plan') content = [toolUse('submit_plan', meta.project?.inspection ? buildExistingPlan(meta.inputs, meta.project.inspection) : buildPlan(meta.inputs, meta.stack || STACK.default))];
    else if (meta.kind === 'task') content = this.taskTurn(messages, meta);
    else if (meta.kind === 'chat') content = [{ type: 'text', text: 'This is the built-in offline demo provider: it cannot discuss your project. Pick a real provider and model (Providers page) to chat about it. Your message was saved, and you can still turn it into a task.' }];
    else if (meta.kind === 'summary') content = [{ type: 'text', text: summaryText(meta) }];
    else content = [{ type: 'text', text: 'OK' }];
    const chars = JSON.stringify(messages).length + JSON.stringify(content).length;
    return { content, stop_reason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: Math.ceil(chars / 4), output_tokens: Math.ceil(JSON.stringify(content).length / 4) } };
  }

  taskTurn(messages, { task, attempt = 1, totalAttempts = attempt, inputs, existing, stack = STACK.default }) {
    const turn = messages.filter((m) => m.role === 'assistant').length;
    if (existing) return existingTaskTurn(turn, task, inputs);
    const kind = appKind(inputs, stack);
    const files = TASK_FILES[task.id] ? filesFor(task.id, kind, stack) : null;
    if (!files) {
      // Unknown task (e.g. a plan edited by a human): do nothing harmful, just report.
      return [toolUse('complete_task', { summary: `No offline template for task "${task.id}".`, files: [], commands: [], nextSteps: ['Run with the Anthropic provider for custom tasks.'] })];
    }
    if (turn === 0) {
      const faulty = task.id === 'core' && ((this.faults === 'on' && attempt === 1) || (this.faults === 'persistent' && totalAttempts <= 3));
      const vars = templateVars(inputs, { faulty, kind, stack });
      const calls = [
        { type: 'text', text: attempt > 1 ? `Reading the verifier output and fixing the root cause (attempt ${attempt}).` : `Working on "${task.title}".` },
        ...files.map(([dest, tpl]) => toolUse('write_file', { path: dest, content: render(tpl, vars, layersOf(kind, stack)) })),
      ];
      // The package manifest lists the selected stack's pinned packages: install them like any agent would.
      if (task.id === 'core') calls.push(toolUse('run_command', { command: STACK.install }));
      if (task.verify?.[0]) calls.push(toolUse('run_command', { command: task.verify[0] }));
      return calls;
    }
    return [
      toolUse('complete_task', {
        summary: `${SUMMARIES[kind][task.id]}${task.id === 'core' && stack.includes('feltdb') ? FELTDB_SUMMARY : ''}${attempt > 1 || totalAttempts > 1 ? ` ${SUMMARIES[kind].fix}` : ''}`,
        files: files.map(([dest]) => dest),
        commands: task.verify || [],
        nextSteps: [],
      }),
    ];
  }
}

export function buildPlan(inputs = {}, stack = STACK.default) {
  const title = appTitle(inputs.idea || 'New app');
  const check = (f) => `node --check ${f}`;
  const kind = appKind(inputs, stack);
  const felt = stack.includes('feltdb');
  const k = kind === 'releases'
    ? {
        summary: `A small service that publishes signed, verifiable artifact releases (Distribution Protocol), with a JSON API, a browser view and AppPort capabilities for agents, for: ${inputs.idea}`,
        users: ['Publishers releasing artifacts', 'Consumers and agents verifying what they download'],
        criteria: ['Releases are signed with the publisher key and verifiable by anyone', 'Tampered manifests, wrong artifact bytes and foreign keys are rejected', 'Every API endpoint and AppPort capability is covered by passing automated tests', 'The app deploys as one process and passes a health check'],
        core: `ReleaseStore, release signing and verification with @distribution-protocol/protocol (publisher key from PUBLISHER_PRIVATE_KEY, trust anchored to the app's own key), a read-only HTTP API with public verification, static file serving, and the AppPort boundary in src/appport.js (releases.publish write, list/get/verify reads, token-authorized).${felt ? ' Releases are stored durably in FeltDB (@feltdb/core) under DATA_DIR, immutable (putIfAbsent), with the app as the sole writer (its own lock file).' : ''} Install the pinned packages. Reads PORT.`,
        ui: 'Accessible, responsive release list showing each release\'s verification, using relative API URLs.',
        tests: `node:test suites for the HTTP API and the AppPort boundary through @appport/client, and test/distribution.test.js: publish, verify, tampered manifest, wrong artifact bytes and foreign keys rejected.${felt ? ' test/feltdb.test.js reads releases back from FeltDB independently and through a restarted app, still verifiable and immutable, and shows a second writer is refused.' : ''}`,
        risks: [felt ? 'FeltDB data lives in DATA_DIR on one machine; plan backups' : 'Releases are kept in memory (select FeltDB for durability)', 'Publishing needs PUBLISHER_PRIVATE_KEY; its custody is the operator\'s', 'The HTTP API is read-only and public; publishing goes through AppPort with APP_API_TOKEN'],
        open: ['Who holds the publisher key in production?', 'Should consumers pin the publisher key or discover it?'],
      }
    : kind === 'catalog'
    ? {
        summary: `A small, fast, read-only catalog with a search UI, a JSON API and AppPort capabilities for agents, for: ${inputs.idea}`,
        users: ['People who need to look things up quickly', 'Agents answering questions from the catalog through AppPort'],
        criteria: ['Users can search and filter entries in the browser', 'Every API endpoint and AppPort capability is covered by passing automated tests', 'The catalog is read-only: writes are refused and no write capability exists', 'The app deploys as one process and passes a health check'],
        core: 'Read-only EntryStore with search rules, a GET-only HTTP API (health, entries, entry, categories), static file serving, and the AppPort boundary in src/appport.js (token-authorized read capabilities over the same store). Install the pinned @appport packages. Reads PORT.',
        ui: 'Accessible, responsive search UI (text query and category filter) using relative API URLs.',
        tests: 'node:test suites covering every endpoint, read-only enforcement and static path safety, plus the AppPort boundary through @appport/client: discovery, invocation, authorization and results checked against the store.',
        risks: ['The catalog content is a seed in code; plan a data source before relying on it', 'The HTTP API and UI are public and read-only; AppPort capabilities require APP_API_TOKEN'],
        open: ['Where should entries come from in production?', 'Should editors be able to change entries?'],
      }
    : {
        summary: `A small, fast web app with a JSON API, a browser UI and AppPort capabilities for agents, for capturing, tracking and completing items for: ${inputs.idea}`,
        users: ['Individuals who want a no-signup tracker for this idea', 'Small teams sharing one internal deployment', 'Agents operating the tracker through AppPort'],
        criteria: ['Users can add, complete, filter and delete items in the browser', 'Every API endpoint and AppPort capability is covered by passing automated tests', 'Invalid input is rejected with clear 400 errors (INVALID_INPUT through AppPort)', 'The app deploys as one process and passes a health check'],
        core: `Node HTTP server with validated CRUD over items, health endpoint, static file serving, and the AppPort boundary in src/appport.js (token-authorized read and write capabilities over the same store, delete not exposed).${felt ? ' Items are stored durably in FeltDB (@feltdb/core) under DATA_DIR, with the app as the sole writer (its own lock file).' : ''} Install the pinned packages. Reads PORT.`,
        ui: 'Accessible, responsive single-page UI for add / complete / filter / delete using relative API URLs.',
        tests: `node:test suites covering every endpoint, validation, 404/405 and static path safety, plus the AppPort boundary through @appport/client: discovery, invocation, authorization and state checked against the store.${felt ? ' test/feltdb.test.js reads the state back from FeltDB independently and through a restarted app, and shows a second writer is refused.' : ''}`,
        risks: [felt ? 'FeltDB data lives in DATA_DIR on one machine; plan backups' : 'In-memory storage resets on restart (acceptable for v1)', 'The HTTP API and UI have no authentication (deploy on trusted networks only); AppPort capabilities require APP_API_TOKEN'],
        open: ['Which database should back v2?', 'Is multi-user access needed?'],
      };
  return {
    product: { name: title, summary: k.summary, users: k.users, successCriteria: k.criteria },
    tasks: [
      { id: 'prd', role: 'product', title: 'Write the product requirements', description: 'Turn the idea and requirements into PRD.md: users, flows, success criteria, scope, risks.', dependsOn: [], acceptance: ['PRD.md exists', 'Lists success criteria and out-of-scope items'], outputs: ['PRD.md'], verify: ['test -s PRD.md && grep -q "Success criteria" PRD.md'] },
      { id: 'core', role: 'engineer', title: 'Implement the store, HTTP API and AppPort boundary', description: k.core, dependsOn: ['prd'], acceptance: ['src/app.js exports createApp()', 'All routes return JSON with correct status codes', 'src/appport.js exposes only the opted-in capabilities, each with an effect and a permission'], outputs: ['package.json', 'src/app.js', 'src/store.js', 'src/auth.js', 'src/appport.js', ...(kind === 'releases' ? ['src/signing.js'] : [])], verify: [`${check('src/store.js')} && ${check('src/app.js')} && ${check('src/appport.js')} && node -e "import('./src/app.js').then(m => { if (typeof m.createApp !== 'function') process.exit(1) })"`] },
      { id: 'ui', role: 'design', title: 'Design and build the web UI', description: k.ui, dependsOn: ['prd'], acceptance: ['Works at any mount path', 'Keyboard accessible, light and dark themes', 'No credentials in browser code'], outputs: ['public/index.html', 'public/style.css', 'public/app.js'], verify: [`test -s public/index.html && ${check('public/app.js')}`] },
      { id: 'tests', role: 'qa', title: 'Write and run the test suite', description: k.tests, dependsOn: ['core', 'ui'], acceptance: ['npm test passes', 'Covers the HTTP API and every AppPort capability, including refused callers'], outputs: ['test/app.test.js', 'test/appport.test.js', ...(felt && kind !== 'catalog' ? ['test/feltdb.test.js'] : []), ...(kind === 'releases' ? ['test/distribution.test.js'] : [])], verify: ['npm test'] },
      { id: 'deploy', role: 'devops', title: 'Containerise and document deployment', description: 'Dockerfile (non-root, health check, installs the pinned packages) and DEPLOY.md for local, Docker and PaaS hosts.', dependsOn: ['core'], acceptance: ['Dockerfile runs as non-root', 'DEPLOY.md gives start command, health path and the AppPort token variable'], outputs: ['Dockerfile', 'DEPLOY.md'], verify: ['test -s Dockerfile && grep -q HEALTHCHECK Dockerfile && test -s DEPLOY.md'] },
      { id: 'docs', role: 'product', title: 'Write the README', description: 'README with quick start, features, API reference, AppPort capabilities (discovery, invocation, permissions), layout and next steps.', dependsOn: ['tests', 'deploy'], acceptance: ['README documents every endpoint and capability'], outputs: ['README.md'], verify: ['grep -q "## API" README.md && grep -q "## AppPort capabilities" README.md'] },
    ],
    risks: k.risks,
    openQuestions: k.open,
    finalVerify: ['npm test'],
    deploy: { start: 'node src/app.js', healthPath: '/api/health' },
  };
}

// ── Existing projects ──────────────────────────────────────────────────────────────────────────
// The offline agents cannot write real application code for an arbitrary codebase. For an existing
// project they plan from the inspected stack, record the change request in the workspace, and run the
// project's own checks — enough to exercise connect/inspect/baseline/verify/deliver end to end.

export const OFFLINE_CHANGE_FILE = 'docs/da-prompt-change-request.md';

export function buildExistingPlan(inputs = {}, inspection = {}) {
  const tests = (inspection.commands?.test || []).map((c) => c.command);
  const checks = tests.length ? tests : (inspection.baselineCommands || []).map((c) => c.command);
  const stack = (inspection.ecosystems || []).join(', ') || 'unknown stack';
  return {
    product: {
      name: appTitle(inputs.idea || 'Change'),
      summary: `Apply the requested change to the existing ${stack} project: ${inputs.idea}`,
      users: ['Maintainers of this project'],
      successCriteria: ['The requested change is recorded and reviewable as a diff', `The project's own checks still pass${checks.length ? ` (${checks.join(', ')})` : ''}`],
    },
    architecture: `Detected ${stack} with ${inspection.files ?? '?'} files; manifests: ${(inspection.manifests || []).map((m) => m.path).join(', ') || 'none'}.`,
    affectedFiles: [OFFLINE_CHANGE_FILE],
    tasks: [
      { id: 'change', role: 'engineer', title: 'Record and scope the requested change', description: `Write ${OFFLINE_CHANGE_FILE} describing the request, the detected stack and the checks to run.`, dependsOn: [], acceptance: [`${OFFLINE_CHANGE_FILE} exists`], outputs: [OFFLINE_CHANGE_FILE], files: [], verify: [`test -s ${OFFLINE_CHANGE_FILE}`] },
      { id: 'check', role: 'qa', title: "Run the project's own checks", description: `Run ${checks.map((c) => `\`${c}\``).join(', ') || 'the available checks'} and confirm nothing regressed.`, dependsOn: ['change'], acceptance: ['No new failures compared with the baseline'], outputs: [], files: [], verify: checks.slice(0, 2) },
    ],
    risks: ['The offline provider does not write application code; use a model provider for real changes.', ...(checks.length ? [] : ['No test, lint or build command was detected, so the change cannot be verified automatically.'])],
    openQuestions: [],
    finalVerify: checks,
    deploy: null,
  };
}

function existingTaskTurn(turn, task, inputs = {}) {
  if (turn === 0) {
    if (task.id === 'change') {
      return [
        { type: 'text', text: 'Recording the change request in the isolated workspace.' },
        toolUse('write_file', { path: OFFLINE_CHANGE_FILE, content: `# Change request\n\n${inputs.idea || ''}\n\n_Recorded by the da-prompt offline provider. Use a model provider to implement the change itself._\n` }),
      ];
    }
    const calls = [{ type: 'text', text: 'Running the project checks.' }];
    if (task.verify?.[0]) calls.push(toolUse('run_command', { command: task.verify[0] }));
    return calls;
  }
  return [toolUse('complete_task', { summary: task.id === 'change' ? `Recorded the change request in ${OFFLINE_CHANGE_FILE}.` : 'Ran the existing project checks.', files: task.id === 'change' ? [OFFLINE_CHANGE_FILE] : [], commands: task.verify || [], nextSteps: [] })];
}

function summaryText({ run }) {
  const tasks = run.plan.tasks;
  if (run.source && run.source.mode !== 'new') {
    const done = tasks.filter((t) => t.status === 'completed').length;
    const failing = (run.checklist || []).filter((c) => !c.ok);
    return [
      `${done} of ${tasks.length} planned tasks completed against the existing project.`,
      '',
      failing.length ? `Not done: ${failing.map((c) => `${c.label.toLowerCase()} (${c.detail})`).join('; ')}.` : 'The project checks showed no regressions. Review the diff before merging.',
      '',
      '**Recommendations:**',
      '- Review the changed files and diff in the Files tab',
      '- Use a model provider for real implementation work (the offline provider only records the request)',
    ].join('\n');
  }
  const done = tasks.filter((t) => t.status === 'completed').length;
  const failing = (run.checklist || []).filter((c) => !c.ok);
  const roles = [...new Set(tasks.map((t) => t.role))].join(', ');
  const fixed = tasks.filter((t) => t.status === 'completed' && t.attempts?.length > 1).map((t) => t.id);
  const lines = [];
  if (failing.length === 0) {
    lines.push(`${run.plan.product.name} is built, tested and deployed.`, '');
    lines.push(`All ${done} planned tasks completed and verified by ${roles} agents. The full test suite passes, the security review found no blocking issues, and the app is live on the preview URL with a passing health check.`);
  } else {
    lines.push(`${run.plan.product.name} is partially built: ${done} of ${tasks.length} tasks completed and verified.`, '');
    lines.push(`Not done yet: ${failing.map((c) => `${c.label.toLowerCase()} (${c.detail})`).join('; ')}.`);
  }
  if (fixed.length) lines.push('', `The feedback loop caught and fixed failures in: ${fixed.join(', ')} (see Lessons in CLAUDE.md).`);
  if (appKind(run.inputs, run.settings?.stack || STACK.default) === 'releases') {
    lines.push('', `**What is left:** ${(run.settings?.stack || []).includes('feltdb') ? 'releases are stored durably in FeltDB;' : 'releases are kept in memory, and'} publishing needs PUBLISHER_PRIVATE_KEY. Agents can publish and verify through its AppPort capabilities with APP_API_TOKEN.`);
    lines.push('', '**Recommendations:**', '- Select FeltDB to keep releases durably', '- Decide who holds the publisher key and how consumers pin it', '- Ship the Docker image to a host and add uptime monitoring');
  } else if (appKind(run.inputs, run.settings?.stack || STACK.default) === 'catalog') {
    lines.push('', '**What is left:** the catalog content is a seed in code. Agents can query it through its AppPort capabilities with APP_API_TOKEN.');
    lines.push('', '**Recommendations:**', '- Load entries from a data file or database behind EntryStore', '- Add an editor role, and write capabilities only once there are write operations', '- Ship the Docker image to a host and add uptime monitoring', '- Add ranking to search');
  } else {
    lines.push('', `**What is left:** ${(run.settings?.stack || []).includes('feltdb') ? 'items are stored durably in FeltDB, but' : 'items are stored in memory and'} the HTTP API and UI have no authentication yet (AppPort capabilities require APP_API_TOKEN).`);
    lines.push('', '**Recommendations:**', '- Add a SQLite or Postgres adapter behind ItemStore', '- Add accounts and per-user data', '- Ship the Docker image to a host and add uptime monitoring', '- Add due dates and sorting based on user feedback');
  }
  return lines.join('\n');
}

export function appTitle(idea) {
  const words = String(idea)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w, i) => !(i === 0 && /^(a|an|the|build|make|create)$/i.test(w)));
  const stop = words.findIndex((w, i) => i >= 2 && /^(for|that|with|to|which|where|so|and|of|in|on)$/i.test(w));
  words.splice(stop === -1 ? 5 : Math.min(stop, 5));
  const t = words.slice(0, 5).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return t || 'New App';
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'app';
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const deps = (o) => JSON.stringify(o, null, 2).replace(/\n/g, '\n  ');

function templateVars(inputs = {}, { faulty, stack = STACK.default, kind = appKind(inputs, stack) }) {
  const title = appTitle(inputs.idea || 'New app');
  const pick = { catalog: [CATALOG_STATS_OK, CATALOG_STATS_FAULTY], releases: stack.includes('feltdb') ? [RELEASES_FELTDB_STATS_OK, RELEASES_FELTDB_STATS_FAULTY] : [RELEASES_STATS_OK, RELEASES_STATS_FAULTY], tracker: stack.includes('feltdb') ? [FELTDB_STATS_OK, FELTDB_STATS_FAULTY] : [STATS_OK, STATS_FAULTY] }[kind];
  const stats = faulty ? pick[1] : pick[0];
  const { dependencies, devDependencies } = stackDeps(stack);
  return {
    APP_TITLE: title,
    APP_TITLE_HTML: esc(title),
    APP_TITLE_JSON: JSON.stringify(title),
    IDEA: inputs.idea || '',
    IDEA_HTML: esc(inputs.idea || ''),
    IDEA_JSON: JSON.stringify(inputs.idea || ''),
    REQUIREMENTS: inputs.requirements || '',
    SLUG: slugify(title),
    SLUG_ID: slugify(title),
    STATS_METHOD: stats,
    STACK_DEPENDENCIES: deps(dependencies),
    STACK_DEV_DEPENDENCIES: deps(devDependencies),
    STACK_LABEL: stack.map((id) => STACK.components[id]?.label || id).join(' + '),
    ...(stack.includes('feltdb')
      ? {
          STACK_NOTES: '\nState is stored durably in [FeltDB](https://www.npmjs.com/package/@feltdb/core) (`@feltdb/core`) under `DATA_DIR`\n(default `./data`). This process is the only writer of that folder: it holds `DATA_DIR/.writer.lock` and a second instance\nrefuses to start. Back the folder up; do not open it for writing from another process.\n\nWhat the store may hold is declared in `feltdb.flow` (FeltDB FlowSpec; check it with `npx feltdb validate feltdb.flow`). At startup the\napp validates it, deploys it as the store\'s active model and requires the active contract to be exactly this file; every record is\nchecked against it before it is written (`src/flow.js`; FeltDB 0.11.9\'s local runtime does not check records itself). Change the\nmodel in `feltdb.flow`: an additive change (a new collection or optional field) becomes the next model version, a destructive one\n(removing a collection or field) is refused and the app does not start.\n\n@feltdb/core sends anonymous usage events (event type, random install id, version, runtime, OS) to feltdb.com by default;\nset `FELTDB_TELEMETRY=0` to turn that off.\n',
          STORE_LINE: 'FeltDB-backed store with validation (the single source of truth)',
          STORE_NEXT: '',
          RELEASE_STORE_LINE: 'Releases in FeltDB (durable, immutable) and their rules',
          RELEASE_NEXT: '- Rotate the publisher key on a schedule and publish the new public key',
          DEPLOY_DATA: '- Data: set `DATA_DIR` to a persistent volume (FeltDB keeps the app\'s state there; one instance per folder). FeltDB sends\n  anonymous usage telemetry to feltdb.com unless `FELTDB_TELEMETRY=0`.\n',
        }
      : { STACK_NOTES: '', RELEASE_STORE_LINE: 'Releases (in memory) and their rules', RELEASE_NEXT: '- Keep releases durably (select FeltDB in the stack)', STORE_LINE: 'In-memory store with validation (the single source of truth)', STORE_NEXT: '- Persist items durably (select FeltDB in the factory\'s stack, or implement the `ItemStore` methods)\n', DEPLOY_DATA: '' }),
  };
}

function render(tpl, vars, layers = ['tracker']) {
  const file = [...layers.map((l) => path.join(TEMPLATE_DIR, 'variants', l, tpl)), path.join(TEMPLATE_DIR, tpl)].find((f) => fs.existsSync(f));
  const raw = fs.readFileSync(file, 'utf8');
  return raw.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

let n = 0;
function toolUse(name, input) {
  n += 1;
  return { type: 'tool_use', id: `toolu_offline_${Date.now().toString(36)}_${n}`, name, input };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
