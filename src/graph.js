// Layer 1 support: the plan is a directed acyclic graph of tasks.

export const ROLES = ['product', 'engineer', 'design', 'qa', 'devops', 'research'];

export const DONE_STATES = new Set(['completed', 'skipped']);
export const TERMINAL_STATES = new Set(['completed', 'skipped', 'escalated', 'blocked', 'cancelled']);

/** Validate a plan and return a list of human-readable problems (empty when valid). */
export function validatePlan(plan) {
  const problems = [];
  if (!plan || typeof plan !== 'object') return ['plan must be an object'];
  if (!plan.product || typeof plan.product.summary !== 'string' || !plan.product.summary.trim()) {
    problems.push('product.summary is required');
  }
  if (!Array.isArray(plan.product?.successCriteria) || plan.product.successCriteria.length === 0) {
    problems.push('product.successCriteria must be a non-empty array');
  }
  const tasks = plan.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return [...problems, 'tasks must be a non-empty array'];
  if (tasks.length > 40) problems.push('too many tasks (max 40); merge small tasks');

  const ids = new Set();
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(t.id)) {
      problems.push(`task id ${JSON.stringify(t?.id)} is invalid (use short slugs like "t1" or "api")`);
      continue;
    }
    if (ids.has(t.id)) problems.push(`duplicate task id "${t.id}"`);
    ids.add(t.id);
    if (!ROLES.includes(t.role)) problems.push(`task "${t.id}" has unknown role "${t.role}" (use one of ${ROLES.join(', ')})`);
    if (!t.title || !t.description) problems.push(`task "${t.id}" needs a title and description`);
    if (!Array.isArray(t.acceptance) || t.acceptance.length === 0) problems.push(`task "${t.id}" needs acceptance criteria`);
    if (t.verify != null && !Array.isArray(t.verify)) problems.push(`task "${t.id}" verify must be an array of shell commands`);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn || []) {
      if (!ids.has(d)) problems.push(`task "${t.id}" depends on unknown task "${d}"`);
      if (d === t.id) problems.push(`task "${t.id}" depends on itself`);
    }
  }
  if (problems.length === 0) {
    const cycle = findCycle(tasks);
    if (cycle) problems.push(`dependency cycle: ${cycle.join(' -> ')}`);
  }
  return problems;
}

export function findCycle(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map(); // 1 = visiting, 2 = done
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.dependsOn || []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const t of tasks) {
    const c = visit(t.id);
    if (c) return c;
  }
  return null;
}

/** Depth (longest path from a root) for each task — used for layout and to show parallelism. */
export function levels(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map();
  const depth = (id) => {
    if (memo.has(id)) return memo.get(id);
    const deps = byId.get(id)?.dependsOn || [];
    const d = deps.length ? 1 + Math.max(...deps.map(depth)) : 0;
    memo.set(id, d);
    return d;
  };
  return Object.fromEntries(tasks.map((t) => [t.id, depth(t.id)]));
}

/** Tasks whose dependencies are all done and which have not started yet. */
export function readyTasks(tasks) {
  const status = new Map(tasks.map((t) => [t.id, t.status]));
  return tasks.filter(
    (t) => t.status === 'pending' && (t.dependsOn || []).every((d) => DONE_STATES.has(status.get(d))),
  );
}

/** Mark pending tasks that can never run (an upstream task escalated/blocked) as blocked. */
export function propagateBlocked(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let changed = true;
  const blocked = [];
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (t.status !== 'pending') continue;
      const bad = (t.dependsOn || []).find((d) => ['escalated', 'blocked', 'cancelled'].includes(byId.get(d)?.status));
      if (bad) {
        t.status = 'blocked';
        t.blockedBy = bad;
        blocked.push(t.id);
        changed = true;
      }
    }
  }
  return blocked;
}

/** Return all downstream tasks of `id` (transitive dependents). */
export function dependentsOf(tasks, id) {
  const out = new Set();
  let frontier = [id];
  while (frontier.length) {
    const next = [];
    for (const t of tasks) {
      if ((t.dependsOn || []).some((d) => frontier.includes(d)) && !out.has(t.id)) {
        out.add(t.id);
        next.push(t.id);
      }
    }
    frontier = next;
  }
  return [...out];
}
