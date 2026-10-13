// Layer 2 (specialized agents) and Layer 3 (execution): each agent works on one task with only
// the context it needs, using real tools against the shared workspace.

import { renderRunPrompt } from './prompt.js';
import { plannerContext, agentContext, isExisting } from './project.js';
import { ROLES, validatePlan } from './graph.js';
import { redact } from './security.js';

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
${WORKSPACE_RULES}`;
}

export async function runPlanner({ provider, run, signal, track, log }) {
  const existing = isExisting(run);
  const messages = [
    {
      role: 'user',
      content: `${existing ? 'Plan this change to the existing project.' : 'Plan the build for this idea.'}\n\n${existing ? 'Request' : 'Idea'}: ${run.inputs.idea}\nRequirements: ${run.inputs.requirements}\nStack / constraints: ${run.inputs.stack}\nBudget / limits: ${run.inputs.limits}\nAccess: ${run.inputs.tools}${existing ? `\n\n${plannerContext(run)}` : ''}`,
    },
  ];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await call(provider, { system: plannerSystem(run), messages, tools: [planToolFor(run)], signal, meta: { kind: 'plan', inputs: run.inputs, forceTool: 'submit_plan', project: existing ? run.project : null, source: run.source } }, track);
    const use = res.content.find((c) => c.type === 'tool_use' && c.name === 'submit_plan');
    messages.push({ role: 'assistant', content: res.content });
    if (!use) {
      messages.push({ role: 'user', content: 'Call submit_plan with the plan.' });
      continue;
    }
    const plan = normalizePlan(use.input);
    const problems = validatePlan(plan);
    if (problems.length === 0) return plan;
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
    })),
    architecture: typeof p.architecture === 'string' ? p.architecture.slice(0, 2000) : '',
    affectedFiles: arr(p.affectedFiles).slice(0, 60),
    risks: arr(p.risks),
    openQuestions: arr(p.openQuestions),
    finalVerify: arr(p.finalVerify),
    deploy: p.deploy && typeof p.deploy.start === 'string' ? { start: p.deploy.start, healthPath: p.deploy.healthPath || '/' } : null,
  };
}

function agentSystem(run, task, lessons) {
  const project = isExisting(run) ? agentContext(run, task) : '';
  return `${renderRunPrompt(run)}

${ROLE_BRIEFS[task.role] || ROLE_BRIEFS.engineer}
You are executing ONE task from the plan (LAYER 3). Other agents may be working on other files in parallel; stay within your task.
${rulesFor(run)}${project ? `\n\n${project}` : ''}
${lessons ? `\nLessons recorded in CLAUDE.md from earlier failures — follow them:\n${lessons}\n` : ''}`;
}

function taskBrief(run, task, { attempt, maxAttempts, feedback, upstream }) {
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

  for (let turn = 1; turn <= settings.maxAgentTurns; turn++) {
    if (signal?.aborted) return { ok: false, error: 'cancelled' };
    const res = await call(provider, { system, messages, tools: AGENT_TOOLS, signal, meta: { kind: 'task', task, attempt, totalAttempts: task.attempts?.length || attempt, inputs: run.inputs, existing: isExisting(run) } }, track);
    messages.push({ role: 'assistant', content: res.content });

    for (const block of res.content) {
      if (block.type === 'text' && block.text.trim()) emit('agent.message', { taskId: task.id, role: task.role, text: redact(block.text.trim()).slice(0, 2000) });
    }
    const uses = res.content.filter((c) => c.type === 'tool_use');
    if (uses.length === 0) {
      if (res.stop_reason === 'max_tokens') {
        messages.push({ role: 'user', content: 'Your reply was cut off. Continue, writing large files in smaller pieces if needed.' });
      } else {
        messages.push({ role: 'user', content: 'Continue the task using the tools, and call complete_task when it is done and verified.' });
      }
      continue;
    }

    const results = [];
    let completion = null;
    for (const use of uses) {
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
      results.push({ type: 'tool_result', tool_use_id: use.id, content: out.text.slice(0, 12_000), ...(out.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
    if (completion) {
      const files = [...new Set([...(completion.files || []), ...filesTouched])].filter((f) => typeof f === 'string');
      return {
        ok: true,
        result: {
          summary: redact(String(completion.summary || '').slice(0, 4000)),
          files,
          commands: (completion.commands || []).filter((c) => typeof c === 'string'),
          nextSteps: (completion.nextSteps || []).filter((c) => typeof c === 'string'),
          commandsRun,
          turns: turn,
        },
      };
    }
  }
  return { ok: false, error: `agent did not finish within ${settings.maxAgentTurns} turns` };
}

async function execTool(ws, use, { settings, signal }) {
  const input = use.input || {};
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

function summarizeInput(use) {
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
