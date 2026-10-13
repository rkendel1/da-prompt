// The backlog: ONE persistent, ordered list of tasks across all products and projects. A task is a unit of planned work —
// not a chat message and not a run. The order of `order` (an array of task ids) IS the priority; there is no other
// ordering anywhere. Filters in the UI are views over this list and never create another order.
//
// <data dir>/tasks.json: { version, rev, order: [taskId…], tasks: { taskId: Task } }. `rev` increases on every change to
// the order or to a task, which lets a client detect that it moved something based on a stale view (409 with the
// authoritative list) instead of silently clobbering another session's order.
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonStore } from './jsonstore.js';
import { redact } from './security.js';
import { ProjectError } from './project.js';

export const STATUSES = ['backlog', 'ready', 'in_progress', 'blocked', 'completed', 'cancelled'];
export const OPEN = new Set(['backlog', 'ready', 'in_progress', 'blocked']);
export const STARTABLE = new Set(['backlog', 'ready', 'blocked']);
// Allowed manual transitions (Start moves a task to in_progress itself). Nothing ever completes a task automatically.
const TRANSITIONS = {
  backlog: ['ready', 'blocked', 'cancelled', 'in_progress'],
  ready: ['backlog', 'blocked', 'cancelled', 'in_progress'],
  in_progress: ['ready', 'blocked', 'completed', 'cancelled', 'backlog'],
  blocked: ['backlog', 'ready', 'in_progress', 'cancelled'],
  completed: ['backlog', 'ready'], // reopen
  cancelled: ['backlog', 'ready'], // reopen
};
export const TASK_ID_RE = /^tsk_[\w-]{12,}$/;
const newId = () => `tsk_${crypto.randomBytes(9).toString('base64url')}`;
const now = () => new Date().toISOString();
const MAX_TITLE = 160;
const MAX_DESC = 20_000;

const conflict = (message, extra = {}) => Object.assign(new ProjectError(409, message), extra);
const clean = (s, max) => redact(String(s ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')).slice(0, max);

export class TaskStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.store = new JsonStore(path.join(cfg.dataDir, 'tasks.json'), () => ({ version: 1, rev: 0, order: [], tasks: {} }));
  }

  /** Tasks in priority order (the one list) plus the revision a client must quote when it reorders. */
  async list() {
    const d = await this.store.read();
    return { rev: d.rev, tasks: d.order.map((id, i) => ({ ...d.tasks[id], position: i + 1 })) };
  }

  async get(id) {
    const d = await this.store.read();
    const t = d.tasks[String(id)];
    if (!t) throw new ProjectError(404, 'task not found');
    return { ...t, position: d.order.indexOf(t.id) + 1, rev: d.rev };
  }

  /** Where a new task goes: `top`, `bottom` (default), or relative to another task. */
  static place(order, position, id) {
    const at = (idx) => order.splice(Math.max(0, Math.min(order.length, idx)), 0, id);
    if (position === 'top') return at(0);
    if (position && typeof position === 'object') {
      const ref = position.beforeId || position.afterId;
      const i = order.indexOf(ref);
      if (i < 0) throw new ProjectError(404, 'the task to place it next to does not exist');
      return at(position.beforeId ? i : i + 1);
    }
    return at(order.length);
  }

  async create({ title, description = '', project, origin = null, status = 'backlog', position = 'bottom' }) {
    const t = clean(title, MAX_TITLE).trim();
    if (!t) throw new ProjectError(400, 'a task needs a title');
    if (!STATUSES.includes(status) || !['backlog', 'ready'].includes(status)) throw new ProjectError(400, 'a new task starts as backlog or ready');
    const task = {
      id: newId(), title: t, description: clean(description, MAX_DESC),
      projectId: project.id, projectName: project.name, status,
      origin: origin || { type: 'manual' },
      createdAt: now(), updatedAt: now(), startedAt: null, completedAt: null,
      runIds: [], currentRunId: null,
      history: [{ at: now(), event: 'created', to: status, ...(origin?.type === 'chat' ? { note: 'from chat' } : {}) }],
    };
    await this.store.mutate((d) => {
      TaskStore.place(d.order, position, task.id);
      d.tasks[task.id] = task;
      d.rev += 1;
    });
    return this.get(task.id);
  }

  async update(id, patch, { project } = {}) {
    await this.store.mutate((d) => {
      const t = d.tasks[String(id)];
      if (!t) throw new ProjectError(404, 'task not found');
      if (patch.title !== undefined) {
        const v = clean(patch.title, MAX_TITLE).trim();
        if (!v) throw new ProjectError(400, 'a task needs a title');
        t.title = v;
      }
      if (patch.description !== undefined) t.description = clean(patch.description, MAX_DESC);
      if (project) { t.projectId = project.id; t.projectName = project.name; }
      t.updatedAt = now();
      d.rev += 1;
    });
    return this.get(id);
  }

  async setStatus(id, status, note = '') {
    if (!STATUSES.includes(status)) throw new ProjectError(400, `status must be one of ${STATUSES.join(', ')}`);
    await this.store.mutate((d) => {
      const t = d.tasks[String(id)];
      if (!t) throw new ProjectError(404, 'task not found');
      if (t.status === status) return;
      if (!TRANSITIONS[t.status].includes(status)) throw conflict(`a ${t.status.replace('_', ' ')} task cannot become ${status.replace('_', ' ')} directly (allowed: ${TRANSITIONS[t.status].join(', ')})`);
      if (status === 'in_progress' && !t.currentRunId) throw conflict('a task becomes in progress by starting it (that creates its run)');
      t.history.push({ at: now(), event: 'status', from: t.status, to: status, ...(note ? { note: clean(note, 500) } : {}) });
      t.status = status;
      t.updatedAt = now();
      t.completedAt = status === 'completed' ? now() : null;
      d.rev += 1;
    });
    return this.get(id);
  }

  /**
   * Reorder: move `id` to the top/bottom or next to another task. `rev` (optional but sent by the UI) must equal the
   * current revision, otherwise the caller moved something based on a stale view: 409 with the authoritative list.
   */
  async move(id, { beforeId, afterId, top, bottom, rev } = {}) {
    let stale = null;
    const result = await this.store.mutate((d) => {
      if (rev !== undefined && Number(rev) !== d.rev) {
        stale = { rev: d.rev, tasks: d.order.map((x, i) => ({ ...d.tasks[x], position: i + 1 })) };
        return null; // nothing changes (the write is a no-op rewrite of the same document)
      }
      if (!d.tasks[String(id)]) throw new ProjectError(404, 'task not found');
      const ref = beforeId || afterId;
      if (ref && !d.tasks[ref]) throw new ProjectError(404, 'the task to move it next to does not exist');
      if (ref === id) throw new ProjectError(400, 'a task cannot be placed next to itself');
      if (!ref && !top && !bottom) throw new ProjectError(400, 'say where: beforeId, afterId, top or bottom');
      const before = d.order.slice();
      d.order = d.order.filter((x) => x !== id);
      if (top) d.order.unshift(id);
      else if (bottom) d.order.push(id);
      else d.order.splice(d.order.indexOf(ref) + (afterId ? 1 : 0), 0, id);
      if (d.order.join() === before.join()) return { moved: false };
      d.tasks[id].history.push({ at: now(), event: 'moved', note: `position ${before.indexOf(id) + 1} → ${d.order.indexOf(id) + 1}` });
      d.tasks[id].updatedAt = now();
      d.rev += 1;
      return { moved: true };
    });
    if (stale) throw conflict('The backlog changed since you loaded it (another tab or device reordered it). Nothing was moved; here is the current order.', { backlog: stale });
    return { ...result, ...(await this.list()) };
  }

  /** Link a started run to the task and mark it in progress (called by the start flow only). */
  async attachRun(id, runId) {
    await this.store.mutate((d) => {
      const t = d.tasks[String(id)];
      if (!t) throw new ProjectError(404, 'task not found');
      if (!STARTABLE.has(t.status)) throw conflict(`a ${t.status.replace('_', ' ')} task cannot be started`);
      t.runIds.push(runId);
      t.currentRunId = runId;
      t.history.push({ at: now(), event: 'started', from: t.status, to: 'in_progress', runId });
      t.status = 'in_progress';
      t.startedAt ||= now();
      t.updatedAt = now();
      d.rev += 1;
    });
    return this.get(id);
  }

  /** Forget the current run (e.g. the run could not be created); the task goes back to where it was. */
  async detachRun(id, runId, back = 'ready') {
    await this.store.mutate((d) => {
      const t = d.tasks[String(id)];
      if (!t || t.currentRunId !== runId) return;
      t.runIds = t.runIds.filter((r) => r !== runId);
      t.currentRunId = t.runIds.at(-1) || null;
      if (t.status === 'in_progress') t.status = back;
      t.history.push({ at: now(), event: 'start-failed', to: t.status, runId });
      d.rev += 1;
    });
  }

  async forProject(projectId, { open = true } = {}) {
    const { tasks } = await this.list();
    return tasks.filter((t) => t.projectId === projectId && (!open || OPEN.has(t.status)));
  }
}
