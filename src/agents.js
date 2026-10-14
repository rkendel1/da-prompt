// Layer 2 (specialized agents) and Layer 3 (execution): each agent works on one task with only
// the context it needs, using real tools against the shared workspace.

import { renderRunPrompt } from './prompt.js';
import { plannerContext, agentContext, isExisting } from './project.js';
import { ROLES, validatePlan } from './graph.js';
import { redact } from './security.js';
import crypto from 'node:crypto';
import { OPTIONAL_TOOLS, optionalTools, validateArgs, validateArtifact, renderScreenshot, generateImage, checkTaskContracts, repairPlan, CapabilityError } from './capabilities.js';
import { fitContext, outputReserve, ContextOverflowError } from './inference.js';

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

const rulesFor = (run) => (isExisting(run) ? EXISTING_WORKSPACE_RULES : WORKSPACE_RULES);

export const AGENT_TOOLS = [
  {
    name: 'list_files',
    description: 'List files in the project workspace with sizes (dependency and VCS folders are skipped). Returns one "path (size)" line per file, or "(empty)".',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Sub-directory, default "."' } } },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace. Returns its text (long files are cut) or "[binary file, N bytes]". Errors if the file does not exist.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a TEXT file with the full content (both path and content are required; binary files such as PNG cannot be written this way). Parent folders are created. Returns the path and the byte size confirmed on disk, or an error: nothing was written if you get an error.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: 'Full file content' } }, required: ['path', 'content'] },
  },
  {
    name: 'save_reply_code',
    description: 'Save a fenced code block from YOUR EARLIER reply into a file (use it when you already wrote the file\'s content in a reply: only the path is needed). Returns the path and confirmed size, or an error. Equivalent to write_file with that code block as content.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, block: { type: 'integer', minimum: 1, description: 'Which code block of that reply (1 = first); required when it has several' } }, required: ['path'] },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace root (sh -c, non-interactive). Returns exit code, stdout and stderr; a non-zero exit is reported as an error. Use it to install, build, run and test.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 600 } },
      required: ['command'],
    },
  },
  {
    name: 'complete_task',
    description: 'Finish the task. List every file you produced: the factory checks that each exists and is not empty, runs the task\'s own verification, and only then marks the task complete. Claims are not evidence.',
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

/** The tools one agent is actually given: the core set plus whichever optional tools this machine can really run. */
export const toolsFor = (caps) => [...AGENT_TOOLS, ...optionalTools(caps).map((n) => OPTIONAL_TOOLS[n])];
const toolSchema = (name) => [...AGENT_TOOLS, ...Object.values(OPTIONAL_TOOLS)].find((t) => t.name === name)?.input_schema;
export const KNOWN_TOOLS = new Set([...AGENT_TOOLS.map((t) => t.name), ...Object.keys(OPTIONAL_TOOLS)]);

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
            capabilities: { type: 'array', items: { type: 'string' }, description: 'Tools the task needs beyond write_file/run_command, e.g. render_screenshot, generate_image (only if listed as available)' },
            maxAttempts: { type: 'integer', minimum: 1, maximum: 5, description: 'Optional: attempts this task deserves (default: the run setting)' },
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

/** What the agents can really do on this machine; planners and agents both see it, so nobody plans around a tool that is not there. */
export function capabilityBrief(caps) {
  const line = (name, c, what) => `- ${name}: ${c?.available ? `available (${what})` : `NOT available: ${c?.reason || 'not configured'}`}`;
  return `Tools agents really have: list_files, read_file, write_file (text only), run_command (shell), complete_task.
${line('render_screenshot', caps?.browser_render, 'renders an HTML file you wrote to a PNG with a headless browser')}
${line('generate_image', caps?.image_generation, 'calls the configured image provider')}
A tool that is not listed does not exist. Describing an image, a screenshot or a file in text never produces it.`;
}

const CONTRACT_RULES = `Task rules (the factory rejects plans that break them):
- Every task must be checkable by the factory, not by the agent's say-so: list the files it must produce in outputs AND/OR commands in verify that exit 0 only when it is really done.
- A UI deliverable is a working UI (HTML/CSS/JS files checked by commands). A screenshot or image is a SEPARATE output with its own criterion, and only if render_screenshot or generate_image is available. Never require a PNG that no available tool can produce; pick a supported equivalent (for example an HTML wireframe) instead.
- Two tasks that are not ordered by dependsOn must not write the same file. A task whose verify reads another task's output must depend on that task.
- Do not invent product requirements to fill the task list. Put what the request does not settle in openQuestions, and mark assumptions as assumptions in risks.`;

function existingPlannerSystem(run, caps) {
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
${CONTRACT_RULES}
${capabilityBrief(caps)}
${EXISTING_WORKSPACE_RULES}`;
}

function plannerSystem(run, caps) {
  if (isExisting(run)) return existingPlannerSystem(run, caps);
  return `${renderRunPrompt(run)}

You are acting in LAYER 1 (plan). Produce the plan by calling submit_plan exactly once.
Planning rules:
- 4–12 small tasks. Each has one owner role, a precise description, acceptance criteria and verify commands that exit 0 only when the task truly works.
- Maximise parallelism: only add a dependency when a task needs another task's output.
- Include: a product/PRD task, implementation tasks, a UI task if the product has a UI, a QA task that runs the full test suite, a devops task (start command, Dockerfile, DEPLOY.md), and a README task last.
- finalVerify must run the full test suite. deploy.start must start the app honouring PORT; deploy.healthPath must return 2xx once it is up.
- Agents only have a local shell and the workspace; do not plan for external services unless the inputs provide access.
${CONTRACT_RULES}
${capabilityBrief(caps)}
${WORKSPACE_RULES}`;
}

export async function runPlanner({ provider, run, signal, track, log, caps }) {
  const existing = isExisting(run);
  const messages = [
    {
      role: 'user',
      content: `${existing ? 'Plan this change to the existing project.' : 'Plan the build for this idea.'}\n\n${existing ? 'Request' : 'Idea'}: ${run.inputs.idea}\nRequirements: ${run.inputs.requirements}\nStack / constraints: ${run.inputs.stack}\nBudget / limits: ${run.inputs.limits}\nAccess: ${run.inputs.tools}${existing ? `\n\n${plannerContext(run)}` : ''}`,
    },
  ];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await call(provider, { system: plannerSystem(run, caps), messages, tools: [planToolFor(run)], signal, meta: { kind: 'plan', inputs: run.inputs, forceTool: 'submit_plan', project: existing ? run.project : null, source: run.source } }, track);
    const use = res.content.find((c) => c.type === 'tool_use' && c.name === 'submit_plan');
    messages.push({ role: 'assistant', content: res.content });
    if (!use) {
      messages.push({ role: 'user', content: 'Call submit_plan with the plan.' });
      continue;
    }
    const plan = normalizePlan(use.input);
    const problems = validatePlan(plan);
    let gaps = [];
    let warnings = [];
    let adjustments = [];
    if (problems.length === 0) {
      adjustments = repairPlan(plan); // intent-preserving repairs only, each reported; see capabilities.js
      const contract = checkTaskContracts(plan, caps);
      for (const t of plan.tasks) for (const c of t.capabilities || []) if (!KNOWN_TOOLS.has(c)) contract.problems.push(`task "${t.id}" lists unknown capability "${c}" (known: ${[...KNOWN_TOOLS].join(', ')})`);
      for (const t of plan.tasks) for (const c of t.capabilities || []) {
        const cap = c === 'render_screenshot' ? caps?.browser_render : c === 'generate_image' ? caps?.image_generation : null;
        if (cap && !cap.available) contract.gaps.push({ taskId: t.id, capability: c, output: null, reason: `${c} is required by "${t.id}" but is not available: ${cap.reason}` });
      }
      problems.push(...contract.problems);
      gaps = contract.gaps;
      warnings = contract.warnings;
      // A capability gap goes back to the planner twice so it can pick a supported equivalent; if the plan still needs the
      // missing tool the task is kept as written and blocked with the reason, never quietly weakened.
      if (attempt < 3) problems.push(...gaps.map((g) => `${g.reason}. Choose a supported equivalent that still delivers the outcome, or state the gap in risks.`));
    }
    if (problems.length === 0) return { ...plan, capabilityGaps: gaps, ...(warnings.length ? { warnings } : {}), ...(adjustments.length ? { adjustments } : {}) };
    log?.(`Plan attempt ${attempt} rejected: ${problems.join('; ')}`);
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `The plan is invalid:\n- ${problems.join('\n- ')}\nFix these and call submit_plan again.` }] });
  }
  throw new Error('planner could not produce a valid plan after 3 attempts');
}

export function normalizePlan(p = {}) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  return {
    product: {
      name: String(p.product?.name || 'App').slice(0, 80),
      summary: String(p.product?.summary || ''),
      users: arr(p.product?.users),
      successCriteria: arr(p.product?.successCriteria),
    },
    tasks: (Array.isArray(p.tasks) ? p.tasks : []).map((t) => ({
      id: String(t?.id || '').trim(),
      role: String(t?.role || '').trim().toLowerCase(),
      title: String(t?.title || '').trim(),
      description: String(t?.description || '').trim(),
      dependsOn: arr(t?.dependsOn),
      acceptance: arr(t?.acceptance),
      outputs: arr(t?.outputs),
      files: arr(t?.files),
      verify: arr(t?.verify),
      ...(arr(t?.capabilities).length ? { capabilities: arr(t.capabilities) } : {}),
      ...(Number.isInteger(t?.maxAttempts) && t.maxAttempts >= 1 && t.maxAttempts <= 5 ? { maxAttempts: t.maxAttempts } : {}),
    })),
    architecture: typeof p.architecture === 'string' ? p.architecture.slice(0, 2000) : '',
    affectedFiles: arr(p.affectedFiles).slice(0, 60),
    risks: arr(p.risks),
    openQuestions: arr(p.openQuestions),
    finalVerify: arr(p.finalVerify),
    deploy: p.deploy && typeof p.deploy.start === 'string' ? { start: p.deploy.start, healthPath: p.deploy.healthPath || '/' } : null,
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
    claimed: [...new Set(strings(c.files))],
    commands: strings(c.commands),
    nextSteps: strings(c.nextSteps),
  };
}

export function agentSystem(run, task, lessons, caps) {
  const project = isExisting(run) ? agentContext(run, task) : '';
  return `${renderRunPrompt(run)}

${ROLE_BRIEFS[task.role] || ROLE_BRIEFS.engineer}
You are executing ONE task from the plan (LAYER 3). Other agents may be working on other files in parallel; stay within your task.
${rulesFor(run)}${project ? `\n\n${project}` : ''}
${capabilityBrief(caps)}
How completion works: only executed tool calls change anything. The factory checks your outputs on disk and runs the task's verification itself; what you say you did is not evidence. If a tool returns an error, the operation did NOT happen: fix the cause or report the blocker honestly.
${lessons ? `\nLessons recorded in CLAUDE.md from earlier failures — follow them:\n${lessons}\n` : ''}`;
}

export function taskBrief(run, task, { attempt, maxAttempts, feedback, upstream, reuse = [] }) {
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
  if (task.outputs?.length) lines.push('', `## Required outputs (each must exist, be non-empty and be a valid file of its type)\n${task.outputs.map((o) => `- ${o}`).join('\n')}`);
  if (task.verify?.length) lines.push('', `## Verification (the factory runs these after you finish; they must exit 0)\n${task.verify.map((v) => `- \`${v}\``).join('\n')}`);
  if (upstream.length) {
    lines.push('', '## Verified upstream outputs you can build on (checked on disk by the factory)');
    for (const u of upstream) lines.push(`- ${u.id} (${u.role}): ${u.files?.length ? u.files.join(', ') : 'no files'}${u.summary ? `\n  agent note: ${u.summary}` : ''}`);
  }
  if (feedback) {
    lines.push('', '## Previous attempt failed verification — read this first', feedback);
    if (reuse.length) lines.push('', `Already valid, keep and reuse (do not recreate): ${reuse.join(', ')}`);
    lines.push('', 'Fix exactly the failed criteria above with a different approach if the previous one did not work, re-run the check yourself, then call complete_task.');
  }
  lines.push('', 'Start by inspecting the workspace if you need context. End with complete_task.');
  return lines.join('\n');
}

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex').slice(0, 16);
const MAX_TEXT_ONLY_TURNS = 4;

/**
 * Run one agent on one task attempt. Returns { ok, result?, error?, failure?, tools, ops }.
 * `emit(type, data)` records events; `track(usage)` charges the token budget. Provider errors propagate to the caller,
 * which classifies them (transient or not) and decides about a retry; this loop only reports what its own tools did.
 *
 * Invocation, execution and success are different facts: every tool event says it was invoked, and `status` says what
 * actually happened (executed | failed | rejected | unavailable). A tool_use id is executed at most once.
 */
export async function runAgent({ provider, ws, run, task, attempt, maxAttempts, feedback, upstream, lessons, settings, signal, emit, track, caps, cfg, reuse }) {
  const system = agentSystem(run, task, lessons, caps);
  const tools = toolsFor(caps);
  const messages = [{ role: 'user', content: taskBrief(run, task, { attempt, maxAttempts, feedback, upstream, reuse }) }];
  const filesTouched = new Set();
  const commandsRun = [];
  const stats = { invoked: 0, executed: 0, failed: 0, rejected: 0, unavailable: 0, duplicates: 0, writes: 0, commandsOk: 0, claimRejections: 0, contextTrimmed: 0 };
  const ops = [];
  const byId = new Map(); // tool_use id -> result already produced
  const written = new Map(); // path -> content hash written during this attempt
  const digest = () => sha([...written].sort().map(([p, h]) => `${p}:${h}`).join('|'));
  const fail = (error, failure) => ({ ok: false, error, failure, tools: stats, ops: ops.slice(-60), workDigest: digest() });
  const ctx = provider.contextLimit?.() ?? null;
  const reserve = ctx ? outputReserve(ctx, provider.maxTokens) : 0;
  // JSON tool mode makes the adapter append its tool instructions to the system prompt; leave room for them.
  const jsonOverhead = ctx && provider.toolMode && provider.toolMode !== 'native' ? 500 : 0;
  const resultCap = ctx ? Math.max(1500, Math.min(12_000, Math.floor(((ctx - reserve) * 3.5) / 6))) : 12_000;
  let textOnly = 0;

  for (let turn = 1; turn <= settings.maxAgentTurns; turn++) {
    if (signal?.aborted) return fail('cancelled', { category: 'cancelled' });
    let sendMessages = messages;
    if (ctx) {
      try {
        const fit = fitContext({ system, messages, tools, budgetTokens: ctx - reserve - jsonOverhead });
        sendMessages = fit.messages;
        stats.contextTrimmed += fit.trimmed;
      } catch (err) {
        if (err instanceof ContextOverflowError) return fail(err.message, { category: 'execution', kind: 'context_overflow', transient: false });
        throw err;
      }
    }
    const res = await call(provider, { system, messages: sendMessages, tools, signal, meta: { kind: 'task', task, attempt, totalAttempts: task.attempts?.length || attempt, inputs: run.inputs, existing: isExisting(run) } }, track);
    // Ollama silently drops the start of a prompt that does not fit. A prompt that filled the window is reported, not trusted.
    if (ctx && res.usage?.reported && res.usage.input_tokens >= ctx - 16) {
      return fail(`the prompt filled the whole ${ctx}-token context window (${res.usage.input_tokens} tokens), so the server may have discarded part of it; raise the context window (numCtx) or split the task`, { category: 'execution', kind: 'context_overflow', transient: false });
    }
    messages.push({ role: 'assistant', content: res.content });

    for (const block of res.content) {
      if (block.type === 'text' && block.text.trim()) emit('agent.message', { taskId: task.id, role: task.role, text: redact(block.text.trim()).slice(0, 2000) });
    }
    const uses = res.content.filter((c) => c.type === 'tool_use');
    if (uses.length === 0) {
      textOnly += 1;
      // Tell the model what is actually still missing, from the disk, so the nudge is about facts rather than another request to "continue".
      const missingOutputs = [];
      for (const o of (task.outputs || []).filter((x) => !/[*?]/.test(x) && !x.endsWith('/'))) if (!(await validateArtifact(ws, o)).ok) missingOutputs.push(o);
      const progress = (task.outputs || []).length ? (missingOutputs.length ? ` Required outputs still missing or invalid: ${missingOutputs.join(', ')}.` : ` Every required output now exists on disk. ${(task.verify || [])[0] ? `To check it, call run_command {"command": ${JSON.stringify(task.verify[0])}}. ` : ''}If the task is done, call complete_task {"summary": "<what you did>", "files": ${JSON.stringify((task.outputs || []).filter((x) => !/[*?]/.test(x)))}}.`) : '';
      if (textOnly >= MAX_TEXT_ONLY_TURNS && (stats.writes > 0 || stats.commandsOk > 0)) {
        // The agent did real work and then only talks. Its silence is not a claim either way: hand the workspace to verification, which
        // decides from the files and commands. If the checks fail the task fails exactly as it would after a complete_task.
        return { ok: true, result: { ...completionFields({ summary: 'The agent stopped calling tools after doing work; the factory verified the workspace without a completion report.' }, filesTouched), commandsRun, turns: turn, implicitCompletion: true }, tools: stats, ops: ops.slice(-60), workDigest: digest() };
      }
      if (textOnly >= MAX_TEXT_ONLY_TURNS) return fail(`the model answered with text ${textOnly} times in a row without calling any tool; nothing was created by describing it`, { category: 'execution', kind: 'no_tool_calls', transient: false });
      if (res.stop_reason === 'max_tokens') {
        messages.push({ role: 'user', content: 'Your reply was cut off. Continue, writing large files in smaller pieces if needed.' });
      } else if (!res.content.some((b) => b.type === 'text' && b.text.trim())) {
        messages.push({ role: 'user', content: `Continue the task using the tools, and call complete_task when it is done and verified.${progress}` });
      } else if (replyCodeBlocks([{ role: 'assistant', content: res.content }]).length) {
        const blocks = replyCodeBlocks([{ role: 'assistant', content: res.content }]);
        // Each block's own first-line comment ("// test/a.test.js") says where it belongs; otherwise fall back to what is missing.
        const hints = blocks.map((bl) => /^\s*(?:\/\/|#|<!--|\/\*)\s*([\w./@-]+\.\w+)/.exec(bl)?.[1] || null);
        const fallback = pastedFile(res.content, task) || missingOutputs[0] || (task.outputs || []).find((o) => !/[*?/]$/.test(o)) || 'the file';
        const calls = blocks.map((_, i) => `save_reply_code {"path": "${hints[i] || fallback}"${blocks.length > 1 ? `, "block": ${i + 1}` : ''}}`);
        messages.push({ role: 'user', content: `You wrote code in your reply, but a reply is not a file: nothing was saved. Call ${calls.length > 1 ? 'these tools, one per code block' : 'this tool'} now: ${calls.join(' ; ')} (or write_file with the content). Do not explain; call the tool.${progress}` });
      } else {
        messages.push({ role: 'user', content: 'You did not call any tool, so nothing happened. Describing a file or a result does not create it. Call write_file / run_command / another tool to do the work, or complete_task if it is done and verified.' + progress });
      }
      continue;
    }
    textOnly = 0;

    const results = [];
    let completion = null;
    for (const use of uses) {
      stats.invoked += 1;
      if (use.name === 'complete_task') {
        // A file named in the completion must exist and be valid right now; otherwise the claim is refused here, where it is cheap to fix.
        const missing = [];
        for (const f of completionFields(use.input).claimed.filter((x) => !x.endsWith('/'))) {
          const v = await validateArtifact(ws, f);
          if (!v.ok) missing.push(v.detail);
        }
        if (missing.length && stats.claimRejections < 3) {
          stats.claimRejections += 1;
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `complete_task rejected: ${missing.join('; ')}. Create the file with a tool, or remove it from "files", then call complete_task again. The task is NOT complete.` });
          emit('tool', { taskId: task.id, role: task.role, tool: 'complete_task', input: { files: completionFields(use.input).claimed.length }, ok: false, status: 'rejected', invoked: true, output: redact(missing.join('; ')).slice(0, 1000) });
          continue;
        }
        completion = use.input;
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Recorded. The factory will now verify your work; it is not complete until the checks pass.' });
        continue;
      }
      let out;
      let dup = false;
      if (byId.has(use.id)) {
        dup = true;
        out = { ...byId.get(use.id), text: `(this tool call id was already executed; not run again) ${byId.get(use.id).text}` };
      } else if (use.name === 'write_file' && typeof use.input?.path === 'string' && typeof use.input?.content === 'string' && written.get(use.input.path) === sha(use.input.content) && (await ws.stat(use.input.path))?.size === Buffer.byteLength(use.input.content)) {
        dup = true;
        out = { text: `unchanged: ${use.input.path} already contains exactly this content (written earlier in this attempt); nothing was re-executed. Writing it again will not change the result — do something different.`, preview: 'unchanged', status: 'executed', path: use.input.path };
      } else {
        out = await execTool(ws, use, { settings, signal, caps, cfg, codeBlocks: use.name === 'save_reply_code' ? replyCodeBlocks(messages) : undefined });
        byId.set(use.id, out);
      }
      if (dup) stats.duplicates += 1;
      else if (out.status === 'executed') stats.executed += 1;
      else if (out.status === 'unavailable') stats.unavailable += 1;
      else if (out.status === 'rejected') stats.rejected += 1;
      else stats.failed += 1;
      if (!out.isError && out.path && !dup && ['write_file', 'save_reply_code', 'render_screenshot', 'generate_image'].includes(use.name)) {
        filesTouched.add(out.path);
        stats.writes += 1;
        written.set(out.path, use.name === 'write_file' ? sha(String(use.input.content)) : sha(`${out.path}:${out.bytes}:${out.digest || ''}`));
      }
      if (use.name === 'run_command' && !dup) {
        commandsRun.push({ command: use.input?.command, exitCode: out.exitCode });
        if (out.exitCode === 0) stats.commandsOk += 1;
      }
      ops.push({ tool: use.name, status: dup ? 'duplicate' : out.status, ...(out.path ? { path: out.path } : {}), ...(out.exitCode != null ? { exitCode: out.exitCode } : {}), ...(out.capability ? { capability: out.capability } : {}) });
      emit('tool', {
        taskId: task.id,
        role: task.role,
        tool: use.name,
        input: summarizeInput(use),
        ok: !out.isError,
        invoked: true,
        status: dup ? 'duplicate' : out.status,
        ...(out.capability ? { capability: out.capability } : {}),
        output: redact(out.preview || '').slice(0, 4000),
        exitCode: out.exitCode,
        durationMs: out.durationMs,
      });
      results.push({ type: 'tool_result', tool_use_id: use.id, content: clipText(out.text, resultCap), ...(out.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
    if (completion) {
      return { ok: true, result: { ...completionFields(completion, filesTouched), commandsRun, turns: turn }, tools: stats, ops: ops.slice(-60), workDigest: digest() };
    }
  }
  return fail(`agent did not finish within ${settings.maxAgentTurns} turns`, { category: 'execution', kind: 'turn_limit', transient: false });
}

/** Fenced code blocks of the most recent assistant message that has any, in order. */
export function replyCodeBlocks(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content : (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const blocks = [...text.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)].map((x) => x[1]);
    if (blocks.length) return blocks;
  }
  return [];
}

/** The declared output a reply pasted as a code block instead of writing it (so the next prompt can say exactly what to do). */
function pastedFile(content, task) {
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (!text.includes('```')) return null;
  return (task.outputs || []).find((o) => !/[*?/]$/.test(o) && text.includes(o)) || null;
}

const clipText = (t, n) => (String(t).length <= n ? String(t) : `${String(t).slice(0, Math.ceil(n * 0.6))}\n…[${String(t).length - n} chars cut]…\n${String(t).slice(-Math.floor(n * 0.4))}`);

/**
 * Execute one tool call against the workspace. The result says what actually happened:
 *   status 'executed'    the operation ran and succeeded (isError false)
 *   status 'failed'      the operation ran (or was attempted) and did not succeed (isError true)
 *   status 'rejected'    the call never ran: unknown tool or arguments that do not satisfy the tool's schema
 *   status 'unavailable' the tool needs a capability this machine does not have (`capability` names it)
 */
export async function execTool(ws, use, { settings, signal, caps, cfg, codeBlocks } = {}) {
  const input = use.input ?? {};
  const schema = toolSchema(use.name);
  const reject = (text, status = 'rejected', extra = {}) => ({ text, preview: text.slice(0, 200), isError: true, status, ...extra });
  if (!schema) return reject(`unknown tool ${use.name}`);
  const bad = validateArgs(schema, input, `${use.name} arguments`);
  if (bad.length) return reject(`error: invalid arguments for ${use.name}: ${bad.join('; ')}. Nothing was executed.`);
  try {
    switch (use.name) {
      case 'list_files': {
        const files = await ws.listFiles(input.path || '.');
        const text = files.length ? files.map((f) => `${f.path} (${f.size}b)`).join('\n') : '(empty)';
        return { text, preview: `${files.length} files`, status: 'executed' };
      }
      case 'read_file': {
        const text = await ws.readFile(input.path);
        return { text, preview: `${text.length} chars`, status: 'executed' };
      }
      case 'write_file': {
        const r = await ws.writeFile(input.path, input.content);
        return { text: `wrote ${r.path} (${r.bytes} bytes, confirmed on disk)${r.bytes === 0 ? ' — WARNING: the file is empty' : ''}`, preview: `${r.bytes} bytes`, path: r.path, bytes: r.bytes, status: 'executed' };
      }
      case 'save_reply_code': {
        const blocks = codeBlocks || [];
        if (!blocks.length) return reject('error: none of your earlier replies contains a fenced code block, so there is nothing to save. Use write_file with the content.', 'failed');
        if (input.block == null && blocks.length > 1) return reject(`error: your reply has ${blocks.length} code blocks; pass block (1-${blocks.length}) to say which one belongs in ${input.path}. Nothing was saved.`);
        const idx = (input.block ?? 1) - 1;
        if (!blocks[idx]) return reject(`error: block ${input.block} does not exist (the reply has ${blocks.length}). Nothing was saved.`);
        const r = await ws.writeFile(input.path, blocks[idx]);
        return { text: `saved code block ${idx + 1} of your reply to ${r.path} (${r.bytes} bytes, confirmed on disk)${r.bytes === 0 ? ' — WARNING: the file is empty' : ''}`, preview: `${r.bytes} bytes`, path: r.path, bytes: r.bytes, digest: sha(blocks[idx]), status: 'executed' };
      }
      case 'run_command': {
        const timeoutMs = Math.min((input.timeout_seconds || settings.commandTimeoutMs / 1000) * 1000, 600_000);
        const r = await ws.runCommand(String(input.command || ''), { timeoutMs, signal });
        const text = `exit code: ${r.exitCode}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
        return { text, preview: `${r.stdout}\n${r.stderr}`.trim(), exitCode: r.exitCode, durationMs: r.durationMs, isError: r.exitCode !== 0, status: r.exitCode === 0 ? 'executed' : 'failed' };
      }
      case 'render_screenshot': {
        const t0 = Date.now();
        const r = await renderScreenshot(ws, caps, input, { signal, timeoutMs: Math.min(settings?.commandTimeoutMs || 60_000, 120_000) });
        return { text: `rendered ${input.html_path} to ${r.path} (${r.bytes} bytes, ${r.width}x${r.height}); verified as a valid PNG`, preview: `${r.bytes} bytes`, path: r.path, bytes: r.bytes, durationMs: Date.now() - t0, status: 'executed' };
      }
      case 'generate_image': {
        const t0 = Date.now();
        const r = await generateImage(ws, caps, cfg || {}, input, { signal });
        return { text: `generated ${r.path} (${r.bytes} bytes, ${r.width || '?'}x${r.height || '?'}); verified as a valid image`, preview: `${r.bytes} bytes`, path: r.path, bytes: r.bytes, durationMs: Date.now() - t0, status: 'executed' };
      }
      default:
        return reject(`unknown tool ${use.name}`);
    }
  } catch (err) {
    if (err instanceof CapabilityError) return reject(`error: ${err.message}`, 'unavailable', { capability: err.capability });
    return { text: `error: ${err.message}. The operation did not succeed.`, preview: err.message, isError: true, status: 'failed' };
  }
}

export function summarizeInput(use) {
  const i = use.input || {};
  if (use.name === 'write_file') return { path: i.path, bytes: Buffer.byteLength(String(i.content ?? '')) };
  if (use.name === 'save_reply_code') return { path: i.path, block: i.block };
  if (use.name === 'run_command') return { command: redact(String(i.command || '')).slice(0, 500) };
  if (use.name === 'render_screenshot') return { path: i.output_path, html: i.html_path };
  if (use.name === 'generate_image') return { path: i.output_path };
  return { path: i.path };
}

export async function writeSummary({ provider, run, signal, track }) {
  // Only what the factory itself verified goes in. An agent's own summary is a claim and is left out.
  const facts = {
    product: run.plan.product,
    tasks: run.plan.tasks.map((t) => ({ id: t.id, role: t.role, title: t.title, status: t.status, attempts: t.attempts?.length, verifiedOutputs: (t.verified?.outputs || []).map((o) => o.path), failure: t.failure ? { category: t.failure.category, reason: String(t.failure.reason || '').slice(0, 200) } : undefined })),
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
