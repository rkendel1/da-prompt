// Layer 2 (specialized agents) and Layer 3 (execution): each agent works on one task with only
// the context it needs, using real tools against the shared workspace.

import { renderRunPrompt } from './prompt.js';
import { plannerContext, agentContext, isExisting } from './project.js';
import { ROLES, validatePlan } from './graph.js';
import { redact } from './security.js';
import { extractJsonValues } from './providers/tooltext.js';
import { compactHistory, historyBudget } from './providers/history.js';
import { APPPORT_RULES, appportException } from './appport.js';
import { stackRules, stackLabel } from './stack.js';

export const ROLE_BRIEFS = {
  product: 'You are the Product agent. Refine requirements, user flows and the PRD. Write crisp, testable acceptance criteria and keep docs accurate to what was actually built.',
  engineer: 'You are the Engineer agent. Implement features with clean, working, well-structured code and tests. Run the code before you finish.',
  design: 'You are the Design agent. Build the UI/UX, copy and assets: accessible (labels, focus, contrast), responsive down to 360px wide, with light and dark themes.',
  qa: 'You are the QA agent. Write and run tests that prove the success criteria, hunt edge cases and fix real defects you find (in code or tests). Never weaken a test just to make it pass.',
  devops: 'You are the DevOps agent. Make the app deployable: start command, Dockerfile, environment config, health checks and clear deployment docs.',
  research: 'You are the Research agent. Investigate external APIs, libraries and best practices and record concrete, sourced findings in a markdown file in the workspace.',
};

export const BudgetError = class BudgetError extends Error {};

const WORKSPACE_RULES = `Workspace rules:
- All paths are relative to the project root. Never write outside it.
- The app must start with a single command and read its port from the PORT environment variable.
- Browser code must call the API with relative URLs (e.g. fetch('api/items'), not '/api/items') so it works behind a path prefix.
- Prefer the standard library. If you add dependencies, add them to the manifest and install them with the package manager.
- Commands run non-interactively with a timeout; never start long-running servers in the foreground (start them in tests on port 0 instead).
- Never hardcode secrets; read them from environment variables.
- Finish by calling complete_task with an honest summary. Only claim what you have verified.`;

const EXISTING_WORKSPACE_RULES = `Workspace rules (existing project):
- All paths are relative to the project root, which is an isolated copy of the user's project. Never write outside it, and never write inside .git.
- Read the relevant code first. Change only what the task needs, in the project's own style and structure.
- Verify with the project's own test/lint/build commands. Dependencies are not installed unless the run authorizes it; if a command fails because tooling is missing, say so instead of working around it.
- Never run deploy, publish, migration or privileged commands, and do not use git to switch branches or rewrite history; the factory commits and delivers.
- Commands run non-interactively with a timeout; never start long-running servers in the foreground.
- Never hardcode secrets; read them from environment variables.
- Finish by calling complete_task with an honest summary. Only claim what you have verified.`;

// New apps are AppPort-native unless the run carries an explicit exception (src/appport.js).
// …and are built on the run's selected stack (src/stack.js): its packages and rules, and none of the unselected packages.
const newAppRules = (run) => [WORKSPACE_RULES, appportException(run) ? '' : APPPORT_RULES, run.settings?.stack ? stackRules(run.settings.stack) : ''].filter(Boolean).join('\n\n');
const rulesFor = (run) => (isExisting(run) ? EXISTING_WORKSPACE_RULES : newAppRules(run));

export const AGENT_TOOLS = [
  {
    name: 'list_files',
    description: 'List files in the project workspace (dependency and VCS folders are skipped).',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Sub-directory, default "."' } } },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the workspace with the full content. Parent folders are created.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace root (sh -c). Returns exit code, stdout and stderr. Use it to install, build, run and test.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 600 } },
      required: ['command'],
    },
  },
  {
    name: 'complete_task',
    description: 'Finish the task. Report what you built, the files you produced, the commands that prove it works, and next steps.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        commands: { type: 'array', items: { type: 'string' } },
        nextSteps: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'files'],
    },
  },
];

export const PLAN_TOOL = {
  name: 'submit_plan',
  description: 'Submit the build plan as a graph of tasks.',
  input_schema: {
    type: 'object',
    properties: {
      product: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short product name' },
          summary: { type: 'string' },
          users: { type: 'array', items: { type: 'string' } },
          successCriteria: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'summary', 'users', 'successCriteria'],
      },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short slug, e.g. "api"' },
            role: { type: 'string', enum: ROLES },
            title: { type: 'string' },
            description: { type: 'string', description: 'Precise spec for the agent' },
            dependsOn: { type: 'array', items: { type: 'string' } },
            acceptance: { type: 'array', items: { type: 'string' } },
            outputs: { type: 'array', items: { type: 'string' }, description: 'Files this task produces' },
            files: { type: 'array', items: { type: 'string' }, description: 'Existing projects: existing files this task is likely to read or change' },
            verify: { type: 'array', items: { type: 'string' }, description: 'Shell commands that must exit 0 when the task is done' },
          },
          required: ['id', 'role', 'title', 'description', 'dependsOn', 'acceptance', 'verify'],
        },
      },
      architecture: { type: 'string', description: 'Existing projects: how the relevant part of the codebase is structured today' },
      affectedFiles: { type: 'array', items: { type: 'string' }, description: 'Existing projects: files likely to change' },
      risks: { type: 'array', items: { type: 'string' } },
      openQuestions: { type: 'array', items: { type: 'string' } },
      finalVerify: { type: 'array', items: { type: 'string' }, description: 'Commands that prove the whole app works, e.g. "npm test"' },
      deploy: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'Command that starts the app; it must honour PORT' },
          healthPath: { type: 'string', description: 'HTTP path that returns 2xx when healthy, e.g. "/api/health" or "/"' },
        },
        required: ['start', 'healthPath'],
      },
    },
    required: ['product', 'tasks', 'finalVerify', 'deploy'],
  },
};

/** For existing projects deploy is optional: it only applies when the run authorizes a preview. */
export const planToolFor = (run) => {
  if (!isExisting(run)) return PLAN_TOOL;
  return { ...PLAN_TOOL, input_schema: { ...PLAN_TOOL.input_schema, required: ['product', 'tasks', 'finalVerify'] } };
};

function existingPlannerSystem(run) {
  return `${renderRunPrompt(run)}

You are acting in LAYER 1 (plan) for a change to an EXISTING project. Produce the plan by calling submit_plan exactly once.
Planning rules:
- Ground everything in the inventory in the user message: the real stack, modules, conventions and commands. Do not assume Node.js, npm or any framework that the inventory does not show.
- 2–8 small tasks, each with one owner role, a precise spec, acceptance criteria, the existing files it will read or change (files), and verify commands that exit 0 only when it truly works.
- Verify and finalVerify commands MUST come from the detected commands (or be narrower runs of them, e.g. a single test file). Include the project's full test command in finalVerify. If nothing was detected, say so in risks.
- Do not plan greenfield work: no PRD task, no Dockerfile/DEPLOY.md, no README rewrite unless the request needs it. Add tests next to the project's existing tests.
- Baseline failures are pre-existing: never make a task's success depend on them passing.
- Fill architecture (how the relevant code is organised today) and affectedFiles. Put risks and open questions honestly.
- Omit deploy unless the inventory says deployment is authorized for this run.
- Maximise parallelism: only add a dependency when a task needs another task's output.
${EXISTING_WORKSPACE_RULES}`;
}

function plannerSystem(run) {
  if (isExisting(run)) return existingPlannerSystem(run);
  return `${renderRunPrompt(run)}

You are acting in LAYER 1 (plan). Produce the plan by calling submit_plan exactly once.
Planning rules:
- 4–12 small tasks. Each has one owner role, a precise description, acceptance criteria and verify commands that exit 0 only when the task truly works.
- Maximise parallelism: only add a dependency when a task needs another task's output.
- Include: a product/PRD task, implementation tasks, a UI task if the product has a UI, a QA task that runs the full test suite, a devops task (start command, Dockerfile, DEPLOY.md), and a README task last.
- finalVerify must run the full test suite. deploy.start must start the app honouring PORT; deploy.healthPath must return 2xx once it is up.
- Agents only have a local shell and the workspace; do not plan for external services unless the inputs provide access.
${appportException(run) ? '' : '- The app is AppPort-native (rules below): the implementation task installs the pinned @appport packages and builds src/appport.js over the app\'s own store; the QA task tests it in test/appport.test.js; the README documents the capabilities.\n'}${run.settings?.stack?.some((id) => id !== 'appport') ? `- The selected stack is ${stackLabel(run.settings.stack)}: the implementation task builds on every selected component as its rules below say, the QA task writes the tests those rules name, and the README documents the stack.\n` : ''}${newAppRules(run)}`;
}

/**
 * Produce the plan. `stats` (optional) is filled in as planning goes: attempts made, the problems each rejected attempt had,
 * and the repairs applied, so the run can show how well the planner model did. Throws an error with code `invalid_plan`
 * when the model answered but never produced a usable plan.
 */
export async function runPlanner({ provider, run, signal, track, log, stats = {} }) {
  const existing = isExisting(run);
  stats.attempts = 0;
  stats.rejections = [];
  stats.repairs = [];
  const messages = [
    {
      role: 'user',
      content: `${existing ? 'Plan this change to the existing project.' : 'Plan the build for this idea.'}\n\n${existing ? 'Request' : 'Idea'}: ${run.inputs.idea}\nRequirements: ${run.inputs.requirements}\nStack / constraints: ${run.inputs.stack}\nBudget / limits: ${run.inputs.limits}\nAccess: ${run.inputs.tools}${existing ? `\n\n${plannerContext(run)}` : ''}`,
    },
  ];
  for (let attempt = 1; attempt <= 3; attempt++) {
    stats.attempts = attempt;
    const res = await call(provider, { system: plannerSystem(run), messages, tools: [planToolFor(run)], signal, meta: { kind: 'plan', inputs: run.inputs, forceTool: 'submit_plan', project: existing ? run.project : null, source: run.source, stack: run.settings?.stack } }, track);
    const use = res.content.find((c) => c.type === 'tool_use' && c.name === 'submit_plan');
    messages.push({ role: 'assistant', content: res.content });
    // Local models often write the plan as JSON in their reply instead of calling the tool; take it from there.
    const input = use ? use.input : planFromText(res.content);
    if (!input) {
      stats.rejections.push(['no plan in the reply']);
      messages.push({ role: 'user', content: 'Call submit_plan with the plan (one JSON object with product, tasks, finalVerify and deploy).' });
      continue;
    }
    const { plan, repairs } = repairPlan(normalizePlan(input, { idea: run.inputs.idea }), { existing });
    const problems = validatePlan(plan);
    if (problems.length === 0) {
      stats.repairs = repairs;
      for (const r of repairs) log?.(`Plan repaired: ${r}`);
      return plan;
    }
    stats.rejections.push(problems.slice(0, 10));
    log?.(`Plan attempt ${attempt} rejected: ${problems.join('; ')}`);
    const fix = `The plan is invalid:\n- ${problems.join('\n- ')}\nFix these and call submit_plan again.`;
    messages.push({ role: 'user', content: use ? [{ type: 'tool_result', tool_use_id: use.id, is_error: true, content: fix }] : fix });
  }
  throw Object.assign(new Error('planner could not produce a valid plan after 3 attempts'), { code: 'invalid_plan' });
}

const TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name));
// Files a text-only agent has no way to produce: no image, audio, video or document tool exists.
const BINARY_OUTPUT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|psd|pdf|mp3|wav|ogg|mp4|mov|webm|zip)$/i;
// Commands that start something long-running in the foreground. As a check they never exit, so they can only time out.
const FOREGROUND = [
  /^docker\s+run\b(?!.*\s(-d|--detach)\b)/,
  /^docker(-|\s+)compose\s+up\b(?!.*\s(-d|--detach)\b)/,
  /^(npm|pnpm|yarn)\s+(run\s+)?(start|dev|serve|preview)\b/,
  /^node\s+(\S*\/)?(server|app|index|main)\.[cm]?js\s*$/,
  /^python3?\s+-m\s+http\.server\b/,
  /^(npx\s+)?(serve|http-server|nodemon)\b/,
  /^(flask\s+run|uvicorn|gunicorn)\b/,
];
const backgrounded = (seg) => /(^|[^&])&\s*($|[^&])/.test(seg);
const isForeground = (seg) => !backgrounded(seg) && FOREGROUND.some((re) => re.test(seg.trim()));
// A request to a local server. Nothing is running while checks run, unless the same command started it in the background
// (the factory's own deploy check starts the app and probes its health path).
const needsServer = (seg) => /^(curl|wget|http)\b.*\b(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/.test(seg.trim());

/**
 * Repair one verify command. Returns { cmd } (possibly changed) or { cmd: null } to drop it, with `why` when it changed.
 * - a tool name used as a command (`run_command npm test`, `write_file PRD.md`) becomes the shell command it meant;
 * - in a `&&` chain, a foreground server and everything after it (which needs that server) is cut; the rest is kept.
 */
export function repairCommand(command) {
  let cmd = String(command || '').trim();
  const tool = cmd.match(/^([a-z_]+)\b\s*(.*)$/s);
  if (tool && TOOL_NAMES.has(tool[1])) {
    const rest = tool[2].trim().replace(/^[:(]\s*/, '').replace(/\)\s*$/, '').replace(/^(\x22|\x27|\x60)(.*)\1$/s, '$2').trim();
    if (tool[1] === 'run_command' && rest) cmd = rest;
    else if ((tool[1] === 'read_file' || tool[1] === 'write_file') && /^[\w./@-]+$/.test(rest)) return { cmd: `test -s ${rest}`, why: `"${command}" is a tool name, not a shell command; checking the file instead` };
    else return { cmd: null, why: `"${command}" is a tool name, not a shell command` };
  }
  if (/;|\|\|/.test(cmd)) return isForeground(cmd.split(/;|\|\|/)[0]) ? { cmd: null, why: `"${command}" starts a server in the foreground, so it could only time out` } : { cmd, ...(cmd !== command ? { why: `"${command}" → "${cmd}"` } : {}) };
  const segs = cmd.split('&&').map((s) => s.trim());
  const server = segs.findIndex((s) => needsServer(s));
  if (server !== -1 && !segs.slice(0, server).some(backgrounded)) {
    const kept = segs.slice(0, server).filter((x) => !isForeground(x)).join(' && ');
    return { cmd: kept || null, why: `"${command}" needs a running server, and none runs while checks run (the deploy check starts the app and probes it)${kept ? `; kept "${kept}"` : ''}` };
  }
  const cut = segs.findIndex(isForeground);
  if (cut === -1) return cmd === String(command).trim() ? { cmd } : { cmd, why: `"${command}" is a tool name; running "${cmd}"` };
  const kept = segs.slice(0, cut).join(' && ');
  return { cmd: kept || null, why: `"${command}" starts a server in the foreground, so it could only time out${kept ? `; kept "${kept}"` : ''}` };
}

/**
 * Repair plan defects that make a task impossible to verify, whatever model does the work. Every one of these was seen in
 * real local-model plans: verify commands that are tool names, foreground servers as checks (`docker run -p …`), image
 * outputs no agent can produce, a "final verification" pseudo-task, and (new apps) no final checks or no start command.
 * Returns { plan, repairs } with one line per change; validatePlan still decides afterwards.
 */
export function repairPlan(plan, { existing = false } = {}) {
  const repairs = [];
  const fixList = (list, where) => {
    const out = [];
    for (const c of list || []) {
      const r = repairCommand(c);
      if (r.why) repairs.push(`${where}: ${r.why}`);
      if (r.cmd && !out.includes(r.cmd)) out.push(r.cmd);
    }
    return out;
  };
  let tasks = plan.tasks.map((t) => ({ ...t }));
  for (const t of tasks) {
    const dropped = (t.outputs || []).filter((o) => BINARY_OUTPUT.test(o));
    if (dropped.length) {
      t.outputs = t.outputs.filter((o) => !dropped.includes(o));
      t.verify = (t.verify || []).filter((v) => !dropped.some((o) => v.includes(o)));
      repairs.push(`task "${t.id}": agents cannot produce ${dropped.join(', ')} (no image or media tool); removed from its outputs and checks`);
    }
    t.verify = fixList(t.verify, `task "${t.id}"`);
  }
  let finalVerify = fixList(plan.finalVerify, 'finalVerify');
  // A task that only re-runs the final checks belongs in finalVerify; as a task it blocks on everything and proves nothing new.
  const pseudo = tasks.filter((t) => (/^final[\s_-]*(verif|check|test)/i.test(t.id) || /^(run\s+)?(the\s+)?final\s+(verification|checks?)$/i.test(t.title)) && !(t.outputs || []).length);
  for (const p of pseudo) {
    tasks = tasks.filter((t) => t !== p);
    for (const t of tasks) if (t.dependsOn.includes(p.id)) t.dependsOn = [...new Set([...t.dependsOn.filter((d) => d !== p.id), ...p.dependsOn])];
    for (const v of p.verify) if (!finalVerify.includes(v)) finalVerify.push(v);
    repairs.push(`task "${p.id}" only re-ran the final checks; its commands were moved to finalVerify`);
  }
  let deploy = plan.deploy;
  if (!existing) {
    if (!finalVerify.length) {
      finalVerify = ['npm test'];
      repairs.push('finalVerify was empty; using "npm test"');
    }
    if (!deploy?.start || /^docker\b/.test(deploy.start)) {
      repairs.push(deploy?.start ? `deploy.start "${deploy.start}" does not honour PORT; using "npm start"` : 'deploy.start was missing; using "npm start"');
      deploy = { start: 'npm start', healthPath: deploy?.healthPath || '/' };
    }
  }
  return { plan: { ...plan, tasks, finalVerify, deploy }, repairs };
}

/**
 * The factory's own plan for a new app, used when the planner model cannot produce a valid one. It is the shape every good
 * plan for a new app has (PRD → app → UI/QA/DevOps → README) with checks the factory knows are runnable; the agents still
 * get the run's rules (AppPort, stack) and the user's idea, so only the decomposition is fixed, not the product.
 */
export function standardPlan(run) {
  const idea = String(run.inputs?.idea || '').trim();
  const name = idea.split('\n')[0].replace(/^(an?|the)\s+/i, '').slice(0, 60) || 'App';
  const task = (id, role, title, description, dependsOn, acceptance, verify, outputs = []) => ({ id, role, title, description, dependsOn, acceptance, verify, outputs, files: [] });
  return {
    product: {
      name: name.charAt(0).toUpperCase() + name.slice(1),
      summary: idea,
      users: [],
      successCriteria: ['The core flows in the request work through the UI and the HTTP API', 'npm test passes and covers those flows', 'The app starts with npm start and honours PORT'],
    },
    tasks: [
      task('prd', 'product', 'Write the PRD', `Write PRD.md for this request: users, the core flows, the data model, the HTTP API, and testable acceptance criteria. Keep it short and concrete.\n\nRequest: ${idea}`, [], ['PRD.md lists the users, core flows, data model, API and acceptance criteria'], ['test -s PRD.md'], ['PRD.md']),
      task('app', 'engineer', 'Build the server, store and API', 'Implement the app from PRD.md: package.json (scripts "start" honouring PORT and "test"), the data store, the HTTP API and the tests for it (node:test). Follow the workspace and stack rules. Run npm test before finishing.', ['prd'], ['npm test passes', 'npm start serves the API on PORT'], ['npm test']),
      task('ui', 'design', 'Build the web UI', 'Build the browser UI as static files in public/ served by the app: every core flow from PRD.md, accessible and responsive. Call the API with relative URLs. Keep npm test passing.', ['app'], ['public/index.html implements the core flows', 'npm test still passes'], ['test -s public/index.html', 'npm test'], ['public/index.html']),
      task('qa', 'qa', 'Test the success criteria', 'Add tests that prove each acceptance criterion in PRD.md, including edge cases; fix real defects you find. Never weaken a test to make it pass.', ['app'], ['npm test passes and covers every acceptance criterion'], ['npm test']),
      task('devops', 'devops', 'Make it deployable', 'Add a Dockerfile that runs npm start and honours PORT, and DEPLOY.md with how to configure, run and health-check the app.', ['app'], ['Dockerfile and DEPLOY.md exist and match the app'], ['test -s Dockerfile', 'test -s DEPLOY.md'], ['Dockerfile', 'DEPLOY.md']),
      task('readme', 'product', 'Write the README', 'Write README.md: what the app does, how to install, run (PORT), test and deploy it, and its API. Describe only what was actually built.', ['ui', 'qa', 'devops'], ['README.md documents running, testing and the API'], ['test -s README.md'], ['README.md']),
    ],
    architecture: '',
    affectedFiles: [],
    risks: ['This is the factory\'s standard plan: the planner model did not produce a valid plan for this request.'],
    openQuestions: [],
    finalVerify: ['npm test'],
    deploy: { start: 'npm start', healthPath: '/' },
  };
}

/** A plan object written as JSON in the model's text (bare, or wrapped as {"plan": …} / {"input": …}), or null. */
export function planFromText(content = []) {
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  for (const { value } of extractJsonValues(text)) {
    const p = unwrapPlan(value);
    if (p) return p;
  }
  return null;
}

function unwrapPlan(v) {
  for (let i = 0; i < 3 && v && typeof v === 'object' && !Array.isArray(v); i++) {
    if (Array.isArray(v.tasks)) return v;
    v = v.plan ?? v.input ?? v.arguments ?? v.parameters;
  }
  return null;
}

// Roles small models invent, mapped to the factory's six.
const ROLE_ALIASES = {
  engineer: ['engineering', 'engineers', 'developer', 'dev', 'backend', 'frontend_engineer', 'fullstack', 'full_stack', 'coder', 'programmer', 'implementation', 'implementer', 'software_engineer', 'architect', 'data'],
  design: ['designer', 'ui', 'ux', 'ui_ux', 'uiux', 'frontend', 'front_end', 'web', 'copy'],
  qa: ['test', 'tests', 'tester', 'testing', 'quality', 'quality_assurance', 'qa_engineer', 'verification'],
  devops: ['ops', 'deploy', 'deployment', 'infra', 'infrastructure', 'sre', 'release', 'ci'],
  product: ['pm', 'product_manager', 'product_owner', 'docs', 'documentation', 'writer', 'technical_writer', 'requirements', 'prd', 'readme'],
  research: ['researcher', 'analysis', 'analyst', 'investigation'],
};

export function normalizeRole(r) {
  const key = String(r || '').trim().toLowerCase().replace(/[\s/-]+/g, '_');
  if (ROLES.includes(key)) return key;
  for (const [role, aliases] of Object.entries(ROLE_ALIASES)) if (aliases.includes(key)) return role;
  return 'engineer'; // missing or unknown: the generalist
}

const slugId = (v) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/**
 * Coerce a plan into the factory's shape. Models (local ones especially) are loose with it: a string where a list is expected,
 * "Task 1" ids, dependencies by title, roles like "backend". Only the shape is repaired; validatePlan still decides.
 */
export function normalizePlan(p = {}, { idea = '' } = {}) {
  p = unwrapPlan(p) || (p && typeof p === 'object' ? p : {});
  const arr = (v) => strings(v).map((x) => x.trim());
  const product = p.product && typeof p.product === 'object' ? p.product : {};
  const raw = (Array.isArray(p.tasks) ? p.tasks : []).filter((t) => t && typeof t === 'object');
  // ids: slugs, unique; remember what each task could be referred to by (its raw id, slug, title, 1-based index).
  const refs = new Map();
  const seen = new Set();
  const tasks = raw.map((t, i) => {
    const given = String(t.id ?? '').trim();
    let id = /^[a-z0-9][a-z0-9_-]{0,30}$/i.test(given) ? given : slugId(t.id ?? t.name).slice(0, 30) || `t${i + 1}`;
    if (!/^[a-z0-9]/i.test(id)) id = `t${id}`;
    while (seen.has(id)) id = `${id.slice(0, 30)}-${i + 1}`;
    seen.add(id);
    for (const k of [t.id, slugId(t.id), t.title, slugId(t.title), String(i + 1)]) if (k != null && k !== '' && !refs.has(String(k).toLowerCase())) refs.set(String(k).toLowerCase(), id);
    const title = String(t.title || t.name || '').trim();
    const description = String(t.description || t.spec || t.details || '').trim();
    const verify = arr(t.verify ?? t.verification ?? t.commands);
    return {
      id,
      role: normalizeRole(t.role ?? t.owner ?? t.agent),
      title: title || description.split('\n')[0].slice(0, 80),
      description: description || title,
      dependsOn: arr(t.dependsOn ?? t.depends_on ?? t.dependencies ?? t.deps),
      acceptance: arr(t.acceptance ?? t.acceptanceCriteria ?? t.acceptance_criteria ?? t.criteria),
      outputs: arr(t.outputs),
      files: arr(t.files),
      verify,
    };
  });
  for (const t of tasks) {
    // A dependency on something that is not a task (or on itself) carries no ordering; drop it rather than fail the plan.
    t.dependsOn = [...new Set(t.dependsOn.map((d) => refs.get(d.toLowerCase()) || refs.get(slugId(d))).filter((d) => d && d !== t.id))];
    if (!t.acceptance.length) t.acceptance = t.verify.length ? t.verify.map((v) => `\`${v}\` exits 0`) : t.title ? [t.title] : [];
  }
  const deploy = typeof p.deploy === 'string' ? { start: p.deploy } : p.deploy;
  const successCriteria = arr(product.successCriteria ?? product.success_criteria ?? p.successCriteria);
  return {
    product: {
      name: String(product.name || p.name || 'App').slice(0, 80),
      summary: String(product.summary || product.description || p.summary || idea || ''),
      users: arr(product.users),
      successCriteria: successCriteria.length ? successCriteria : tasks.flatMap((t) => t.acceptance.slice(0, 1)).slice(0, 6),
    },
    tasks,
    architecture: typeof p.architecture === 'string' ? p.architecture.slice(0, 2000) : '',
    affectedFiles: arr(p.affectedFiles).slice(0, 60),
    risks: arr(p.risks),
    openQuestions: arr(p.openQuestions),
    finalVerify: arr(p.finalVerify ?? p.final_verify),
    deploy: deploy && typeof deploy.start === 'string' && deploy.start.trim() ? { start: deploy.start, healthPath: deploy.healthPath || deploy.health_path || '/' } : null,
  };
}

/** A list of strings from whatever the model sent: an array, a single string, or nothing. Models are loose with these. */
const strings = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []).filter((x) => typeof x === 'string' && x.trim());

/** The result recorded when an agent calls complete_task; shared by every engine so they cannot drift apart. */
export function completionFields(completion, filesTouched = []) {
  const c = completion && typeof completion === 'object' ? completion : {};
  return {
    summary: redact(String(c.summary || '').slice(0, 4000)),
    files: [...new Set([...strings(c.files), ...filesTouched])].filter((f) => typeof f === 'string'),
    commands: strings(c.commands),
    nextSteps: strings(c.nextSteps),
  };
}

export function agentSystem(run, task, lessons) {
  const project = isExisting(run) ? agentContext(run, task) : '';
  return `${renderRunPrompt(run)}

${ROLE_BRIEFS[task.role] || ROLE_BRIEFS.engineer}
You are executing ONE task from the plan (LAYER 3). Other agents may be working on other files in parallel; stay within your task.
${rulesFor(run)}${project ? `\n\n${project}` : ''}
${lessons ? `\nLessons recorded in CLAUDE.md from earlier failures — follow them:\n${lessons}\n` : ''}`;
}

export function taskBrief(run, task, { attempt, maxAttempts, feedback, upstream }) {
  const lines = [
    `# Task ${task.id}: ${task.title}  (role: ${task.role}, attempt ${attempt} of ${maxAttempts})`,
    '',
    `## Product\n${run.plan.product.name} — ${run.plan.product.summary}`,
    '',
    `## Spec\n${task.description}`,
    ...(task.files?.length ? ['', `## Existing files likely involved\n${task.files.map((f) => `- ${f}`).join('\n')}`] : []),
    '',
    `## Acceptance criteria\n${task.acceptance.map((a) => `- ${a}`).join('\n')}`,
  ];
  if (task.outputs?.length) lines.push('', `## Expected outputs\n${task.outputs.map((o) => `- ${o}`).join('\n')}`);
  if (task.verify?.length) lines.push('', `## Verification (the factory runs these after you finish; they must exit 0)\n${task.verify.map((v) => `- \`${v}\``).join('\n')}`);
  if (upstream.length) {
    lines.push('', '## Upstream results you can build on');
    for (const u of upstream) lines.push(`- ${u.id} (${u.role}): ${u.summary}${u.files?.length ? `\n  files: ${u.files.join(', ')}` : ''}`);
  }
  if (feedback) {
    lines.push('', '## Previous attempt failed verification — read this first', feedback, '', 'Find the real root cause, make a focused fix, re-run the checks yourself, then call complete_task.');
  }
  lines.push('', 'Start by inspecting the workspace if you need context. End with complete_task.');
  return lines.join('\n');
}

/**
 * Run one agent on one task attempt. Returns { ok, result?, error? }.
 * `emit(type, data)` records events; `track(usage)` charges the token budget.
 */
export async function runAgent({ provider, ws, run, task, attempt, maxAttempts, feedback, upstream, lessons, settings, signal, emit, track }) {
  const system = agentSystem(run, task, lessons);
  const messages = [{ role: 'user', content: taskBrief(run, task, { attempt, maxAttempts, feedback, upstream }) }];
  const filesTouched = new Set();
  const commandsRun = [];

  const budget = historyBudget(provider, system, AGENT_TOOLS);
  let idle = 0; // consecutive replies that neither called a tool nor wrote a file
  let fromReply = false; // the last tool calls were taken from files written in the reply

  for (let turn = 1; turn <= settings.maxAgentTurns; turn++) {
    if (signal?.aborted) return { ok: false, error: 'cancelled' };
    const res = await call(provider, { system, messages: compactHistory(messages, budget), tools: AGENT_TOOLS, signal, meta: { kind: 'task', task, attempt, totalAttempts: task.attempts?.length || attempt, inputs: run.inputs, existing: isExisting(run), stack: run.settings?.stack } }, track);
    const content = [...res.content];
    messages.push({ role: 'assistant', content });

    for (const block of res.content) {
      if (block.type === 'text' && block.text.trim()) emit('agent.message', { taskId: task.id, role: task.role, text: redact(block.text.trim()).slice(0, 2000) });
    }
    let uses = content.filter((c) => c.type === 'tool_use');
    fromReply = false;
    if (uses.length === 0 && res.stop_reason !== 'max_tokens') {
      // Small models often write a file as a code block under its path instead of calling write_file. Those blocks become
      // write_file calls (the same tool, through execTool and the Workspace); nothing else in a reply is ever executed.
      const files = filesFromReply(content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
      if (files.length) {
        uses = files.map((f, i) => ({ type: 'tool_use', id: `reply_${turn}_${i}`, name: 'write_file', input: f }));
        content.push(...uses);
        fromReply = true;
        emit('log', { level: 'warn', text: `${task.id}: the model wrote ${files.map((f) => f.path).join(', ')} in its reply instead of calling write_file; saved through write_file.` });
      }
    }
    if (uses.length === 0) {
      if (res.stop_reason === 'max_tokens') {
        messages.push({ role: 'user', content: 'Your reply was cut off. Continue, writing large files in smaller pieces if needed.' });
        continue;
      }
      idle += 1;
      // A model that keeps describing actions without taking them. If it already did work and the task has checks, hand the
      // attempt to the factory's verification (which decides, as for any attempt); otherwise stop early instead of looping.
      const worked = filesTouched.size > 0 || commandsRun.some((c) => c.exitCode === 0);
      if (idle >= 3 && worked && (task.verify?.length || task.outputs?.length)) {
        const said = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim().slice(0, 600);
        emit('log', { level: 'warn', text: `${task.id}: the model stopped calling tools after doing work and never called complete_task; the factory is verifying what it produced.` });
        return { ok: true, result: { ...completionFields({ summary: `[Not formally completed: the model stopped calling tools after ${turn} turns without calling complete_task. The factory's checks decide.] ${said}` }, filesTouched), commandsRun, turns: turn, implicit: true } };
      }
      if (idle >= 6) return { ok: false, error: `the model replied ${idle} times in a row without calling a tool (it described actions instead of taking them)` };
      messages.push({
        role: 'user',
        content: idle === 1
          ? 'Continue the task using the tools, and call complete_task when it is done and verified.'
          : 'You described an action but did not call a tool, so nothing happened. Writing about a tool, or a code block, does nothing. Call the tool itself now: write_file with {"path": "…", "content": "…"} to save a file, run_command to run something, or complete_task with {"summary": "…", "files": […]} if the task is done.',
      });
      continue;
    }
    idle = 0;

    const results = [];
    let completion = null;
    for (const use of uses) {
      use.input = normalizeToolInput(use.name, use.input);
      if (use.name === 'complete_task') {
        completion = use.input || {};
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Recorded. The factory will now verify your work.' });
        continue;
      }
      const out = await execTool(ws, use, { settings, signal });
      if (use.name === 'write_file' && !out.isError) filesTouched.add(out.path);
      if (use.name === 'run_command') commandsRun.push({ command: use.input?.command, exitCode: out.exitCode });
      emit('tool', {
        taskId: task.id,
        role: task.role,
        tool: use.name,
        input: summarizeInput(use),
        ok: !out.isError,
        output: redact(out.preview || '').slice(0, 4000),
        exitCode: out.exitCode,
        durationMs: out.durationMs,
      });
      const note = fromReply && !out.isError ? ' (saved from the code block in your reply; call write_file yourself next time, then complete_task when the task is done)' : '';
      results.push({ type: 'tool_result', tool_use_id: use.id, content: `${out.text.slice(0, 12_000)}${note}`, ...(out.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
    if (completion) {
      return { ok: true, result: { ...completionFields(completion, filesTouched), commandsRun, turns: turn } };
    }
  }
  return { ok: false, error: `agent did not finish within ${settings.maxAgentTurns} turns` };
}

const SHELL_FENCE = /^(bash|sh|shell|zsh|console|terminal|cmd|powershell|text|plaintext|output)$/i;
// A line that names exactly one relative file path: `### public/index.html`, `**src/app.js**`, `File: test/a.test.js`, `` `x.css`: ``.
const PATH_LINE = /^(?:#{1,6}\s*|[-*]\s+)?(?:\*\*|__)?\s*(?:(?:file(?:name)?|path)\s*:\s*)?[\x60\x27\x22]?([\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,10})[\x60\x27\x22]?\s*(?:\*\*|__)?\s*:?\s*$/i;

/**
 * Files a model wrote in a text reply instead of calling write_file: each fenced code block directly under a line that names
 * one relative path. Shell-command blocks, empty blocks, absolute paths and `..` are ignored; a path named twice keeps the last
 * block. Returns [{ path, content }] for write_file, which (through the Workspace) still decides whether the path is allowed.
 */
export function filesFromReply(text = '') {
  const lines = String(text).split('\n');
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^\s*(\x60{3,}|~{3,})\s*([\w+#.-]*)/);
    if (!open) continue;
    let end = i + 1;
    while (end < lines.length && !lines[end].trim().startsWith(open[1])) end++;
    let j = i - 1;
    while (j >= 0 && !lines[j].trim()) j--;
    const named = j >= 0 && lines[j].trim().match(PATH_LINE);
    const body = lines.slice(i + 1, end).join('\n');
    const filePath = named?.[1];
    if (filePath && body.trim() && !filePath.startsWith('/') && !filePath.split('/').includes('..') && (!SHELL_FENCE.test(open[2]) || /\.(sh|bash)$/.test(filePath))) out.set(filePath, `${body.replace(/\s+$/, '')}\n`);
    i = end;
  }
  return [...out].map(([path, content]) => ({ path, content }));
}

export async function execTool(ws, use, { settings, signal }) {
  const input = normalizeToolInput(use.name, use.input);
  try {
    switch (use.name) {
      case 'list_files': {
        const files = await ws.listFiles(input.path || '.');
        const text = files.length ? files.map((f) => `${f.path} (${f.size}b)`).join('\n') : '(empty)';
        return { text, preview: `${files.length} files` };
      }
      case 'read_file': {
        const text = await ws.readFile(input.path);
        return { text, preview: `${text.length} chars` };
      }
      case 'write_file': {
        const r = await ws.writeFile(input.path, input.content);
        return { text: `wrote ${r.path} (${r.bytes} bytes)`, preview: `${r.bytes} bytes`, path: r.path };
      }
      case 'run_command': {
        const timeoutMs = Math.min((input.timeout_seconds || settings.commandTimeoutMs / 1000) * 1000, 600_000);
        const r = await ws.runCommand(String(input.command || ''), { timeoutMs, signal });
        const text = `exit code: ${r.exitCode}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
        return { text, preview: `${r.stdout}\n${r.stderr}`.trim(), exitCode: r.exitCode, durationMs: r.durationMs, isError: r.exitCode !== 0 };
      }
      default:
        return { text: `unknown tool ${use.name}`, preview: 'unknown tool', isError: true };
    }
  } catch (err) {
    return { text: `error: ${err.message}`, preview: err.message, isError: true };
  }
}

const pick = (o, keys) => {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return undefined;
};

/**
 * Tool arguments under the names models actually use (file_path, contents, cmd, …), mapped to the factory's. Content given as
 * an object (a model writing package.json as JSON) is serialized. Idempotent; the tools themselves still validate.
 */
export function normalizeToolInput(name, input) {
  const i = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  const raw = typeof input === 'string' ? input : typeof i._raw === 'string' ? i._raw : undefined;
  const PATH = ['path', 'file_path', 'filepath', 'filename', 'file', 'target_file', 'file_name', 'dir', 'directory', 'relative_path'];
  if (name === 'write_file') {
    const path = pick(i, PATH);
    let content = pick(i, ['content', 'contents', 'text', 'code', 'data', 'file_text', 'body', 'file_content']);
    if (content == null && typeof i.content === 'string') content = i.content; // an empty file
    if (content != null && typeof content !== 'string') content = typeof content === 'object' ? `${JSON.stringify(content, null, 2)}\n` : String(content);
    return { ...i, ...(path != null ? { path: String(path).trim() } : {}), ...(content != null ? { content } : {}) };
  }
  if (name === 'read_file' || name === 'list_files') {
    const path = pick(i, PATH);
    return path != null ? { ...i, path: String(path).trim() } : i;
  }
  if (name === 'run_command') {
    let command = pick(i, ['command', 'cmd', 'commands', 'script', 'shell', 'bash', 'code']) ?? raw;
    if (Array.isArray(command)) command = command.filter((c) => typeof c === 'string').join(' && ');
    const timeout = Number(i.timeout_seconds ?? i.timeout);
    return { ...i, ...(command != null ? { command: String(command) } : {}), ...(Number.isFinite(timeout) && timeout > 0 ? { timeout_seconds: Math.round(timeout) } : {}) };
  }
  return i;
}

export function summarizeInput(use) {
  const i = use.input || {};
  if (use.name === 'write_file') return { path: i.path, bytes: Buffer.byteLength(String(i.content ?? '')) };
  if (use.name === 'run_command') return { command: redact(String(i.command || '')).slice(0, 500) };
  return { path: i.path };
}

export async function writeSummary({ provider, run, signal, track }) {
  const facts = {
    product: run.plan.product,
    tasks: run.plan.tasks.map((t) => ({ id: t.id, role: t.role, title: t.title, status: t.status, attempts: t.attempts?.length, summary: t.result?.summary })),
    checklist: run.checklist,
    deployment: run.deployment,
    ...(isExisting(run) ? { baseline: (run.project?.baseline || []).map((b) => ({ command: b.command, status: b.status })), verification: (run.finalVerification || []).map((v) => ({ command: v.command, state: v.state })) } : {}),
  };
  try {
    const res = await call(
      provider,
      {
        system: `${renderRunPrompt(run)}\n\nYou are writing the final <deliver> summary. Be factual: only claim what the evidence shows.`,
        messages: [{ role: 'user', content: `Write a concise final summary (under 250 words, plain markdown, no top-level heading): what was built, what works (with evidence), what is left, and 3–5 recommendations.\n\nEvidence:\n${JSON.stringify(facts, null, 2)}` }],
        tools: [],
        signal,
        meta: { kind: 'summary', run },
      },
      track,
    );
    return res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  } catch (err) {
    return `Summary unavailable (${err.message}).`;
  }
}

async function call(provider, req, track) {
  track?.check();
  const res = await provider.chat(req);
  track?.add(res.usage);
  return res;
}
