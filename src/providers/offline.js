// A deterministic, network-free provider that speaks the same tool-use protocol as Claude.
// It plans and builds a small but real full-stack app from templates, so the entire factory
// (planning, parallel agents, verification, feedback, deployment, delivery) can run end-to-end
// with no API key — in demos, in CI and in this repo's own tests.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'offline-app');

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

const TASK_FILES = {
  prd: [['PRD.md', 'PRD.md.tpl']],
  core: [
    ['package.json', 'package.json.tpl'],
    ['.gitignore', 'gitignore.tpl'],
    ['src/store.js', 'src/store.js.tpl'],
    ['src/app.js', 'src/app.js.tpl'],
  ],
  ui: [
    ['public/index.html', 'public/index.html.tpl'],
    ['public/style.css', 'public/style.css.tpl'],
    ['public/app.js', 'public/app.js.tpl'],
  ],
  tests: [['test/app.test.js', 'test/app.test.js.tpl']],
  deploy: [
    ['Dockerfile', 'Dockerfile.tpl'],
    ['DEPLOY.md', 'DEPLOY.md.tpl'],
  ],
  docs: [['README.md', 'README.md.tpl']],
};

const SUMMARIES = {
  prd: 'Wrote PRD.md: users, four core flows, success criteria, scope and risks.',
  core: 'Implemented the in-memory ItemStore with validation and a zero-dependency HTTP API (health, list, create, get, update, delete) that also serves the UI.',
  ui: 'Built an accessible, responsive web UI (add, complete, filter, delete) with light/dark themes using relative API URLs.',
  tests: 'Added a node:test suite covering every endpoint, validation errors, 404/405 handling and static path safety; npm test passes.',
  deploy: 'Added a non-root Dockerfile with a HEALTHCHECK and DEPLOY.md covering local, Docker and PaaS deployment.',
  docs: 'Wrote README.md with quick start, features, API reference, layout and next steps.',
};

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
    if (meta.kind === 'plan') content = [toolUse('submit_plan', meta.project?.inspection ? buildExistingPlan(meta.inputs, meta.project.inspection) : buildPlan(meta.inputs))];
    else if (meta.kind === 'task') content = this.taskTurn(messages, meta);
    else if (meta.kind === 'summary') content = [{ type: 'text', text: summaryText(meta) }];
    else content = [{ type: 'text', text: 'OK' }];
    const chars = JSON.stringify(messages).length + JSON.stringify(content).length;
    return { content, stop_reason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: Math.ceil(chars / 4), output_tokens: Math.ceil(JSON.stringify(content).length / 4) } };
  }

  taskTurn(messages, { task, attempt = 1, totalAttempts = attempt, inputs, existing }) {
    const turn = messages.filter((m) => m.role === 'assistant').length;
    if (existing) return existingTaskTurn(turn, task, inputs);
    const files = TASK_FILES[task.id];
    if (!files) {
      // Unknown task (e.g. a plan edited by a human): do nothing harmful, just report.
      return [toolUse('complete_task', { summary: `No offline template for task "${task.id}".`, files: [], commands: [], nextSteps: ['Run with the Anthropic provider for custom tasks.'] })];
    }
    if (turn === 0) {
      const faulty = task.id === 'core' && ((this.faults === 'on' && attempt === 1) || (this.faults === 'persistent' && totalAttempts <= 3));
      const vars = templateVars(inputs, { faulty });
      const calls = [
        { type: 'text', text: attempt > 1 ? `Reading the verifier output and fixing the root cause (attempt ${attempt}).` : `Working on "${task.title}".` },
        ...files.map(([dest, tpl]) => toolUse('write_file', { path: dest, content: render(tpl, vars) })),
      ];
      if (task.verify?.[0]) calls.push(toolUse('run_command', { command: task.verify[0] }));
      return calls;
    }
    return [
      toolUse('complete_task', {
        summary: attempt > 1 || totalAttempts > 1 ? `${SUMMARIES[task.id]} Fixed: closed the unterminated object literal in ItemStore.stats().` : SUMMARIES[task.id],
        files: files.map(([dest]) => dest),
        commands: task.verify || [],
        nextSteps: [],
      }),
    ];
  }
}

export function buildPlan(inputs = {}) {
  const title = appTitle(inputs.idea || 'New app');
  const check = (f) => `node --check ${f}`;
  return {
    product: {
      name: title,
      summary: `A small, fast web app with a JSON API and a browser UI for capturing, tracking and completing items for: ${inputs.idea}`,
      users: ['Individuals who want a no-signup tracker for this idea', 'Small teams sharing one internal deployment'],
      successCriteria: [
        'Users can add, complete, filter and delete items in the browser',
        'Every API endpoint is covered by passing automated tests',
        'Invalid input is rejected with clear 400 errors',
        'The app deploys as one process and passes a health check',
      ],
    },
    tasks: [
      { id: 'prd', role: 'product', title: 'Write the product requirements', description: 'Turn the idea and requirements into PRD.md: users, flows, success criteria, scope, risks.', dependsOn: [], acceptance: ['PRD.md exists', 'Lists success criteria and out-of-scope items'], outputs: ['PRD.md'], verify: ['test -s PRD.md && grep -q "Success criteria" PRD.md'] },
      { id: 'core', role: 'engineer', title: 'Implement the store and HTTP API', description: 'Zero-dependency Node HTTP server with validated CRUD over items, health endpoint, static file serving. Reads PORT.', dependsOn: ['prd'], acceptance: ['src/app.js exports createApp()', 'All routes return JSON with correct status codes'], outputs: ['package.json', 'src/app.js', 'src/store.js'], verify: [`${check('src/store.js')} && ${check('src/app.js')} && node -e "import('./src/app.js').then(m => { if (typeof m.createApp !== 'function') process.exit(1) })"`] },
      { id: 'ui', role: 'design', title: 'Design and build the web UI', description: 'Accessible, responsive single-page UI for add / complete / filter / delete using relative API URLs.', dependsOn: ['prd'], acceptance: ['Works at any mount path', 'Keyboard accessible, light and dark themes'], outputs: ['public/index.html', 'public/style.css', 'public/app.js'], verify: [`test -s public/index.html && ${check('public/app.js')}`] },
      { id: 'tests', role: 'qa', title: 'Write and run the test suite', description: 'node:test suite covering every endpoint, validation, 404/405 and static path safety.', dependsOn: ['core', 'ui'], acceptance: ['npm test passes', 'Covers create/read/update/delete and error paths'], outputs: ['test/app.test.js'], verify: ['npm test'] },
      { id: 'deploy', role: 'devops', title: 'Containerise and document deployment', description: 'Dockerfile (non-root, health check) and DEPLOY.md for local, Docker and PaaS hosts.', dependsOn: ['core'], acceptance: ['Dockerfile runs as non-root', 'DEPLOY.md gives start command and health path'], outputs: ['Dockerfile', 'DEPLOY.md'], verify: ['test -s Dockerfile && grep -q HEALTHCHECK Dockerfile && test -s DEPLOY.md'] },
      { id: 'docs', role: 'product', title: 'Write the README', description: 'README with quick start, features, API reference, layout and next steps.', dependsOn: ['tests', 'deploy'], acceptance: ['README documents every endpoint'], outputs: ['README.md'], verify: ['grep -q "## API" README.md'] },
    ],
    risks: ['In-memory storage resets on restart (acceptable for v1)', 'No authentication — deploy on trusted networks only'],
    openQuestions: ['Which database should back v2?', 'Is multi-user access needed?'],
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
  lines.push('', '**What is left:** items are stored in memory and there is no authentication yet.');
  lines.push('', '**Recommendations:**', '- Add a SQLite or Postgres adapter behind ItemStore', '- Add accounts and per-user data', '- Ship the Docker image to a host and add uptime monitoring', '- Add due dates and sorting based on user feedback');
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

function templateVars(inputs = {}, { faulty }) {
  const title = appTitle(inputs.idea || 'New app');
  return {
    APP_TITLE: title,
    APP_TITLE_HTML: esc(title),
    APP_TITLE_JSON: JSON.stringify(title),
    IDEA: inputs.idea || '',
    IDEA_HTML: esc(inputs.idea || ''),
    IDEA_JSON: JSON.stringify(inputs.idea || ''),
    REQUIREMENTS: inputs.requirements || '',
    SLUG: slugify(title),
    STATS_METHOD: faulty ? STATS_FAULTY : STATS_OK,
  };
}

function render(tpl, vars) {
  const raw = fs.readFileSync(path.join(TEMPLATE_DIR, tpl), 'utf8');
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
