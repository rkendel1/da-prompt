// The unified backlog on a real backend: one persistent global order, optimistic-concurrency moves, filters that never
// reorder, manual lifecycle, explicit Start (links a run, never auto-completes), chat-origin tasks and authorization.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMachineEnv } from './cli-helpers.js';
import { startWorkBackend, ChatFake, initRepo, fs } from './work-helpers.js';

cleanMachineEnv();
const backends = [];
after(async () => { for (const b of backends) await b.close().catch(() => {}); });
const boot = async (opts = {}) => {
  const be = await startWorkBackend(opts);
  backends.push(be);
  return be;
};
const repoA = (d) => initRepo(d, { files: { 'README.md': '# Alpha\n', 'package.json': '{"name":"alpha","scripts":{"test":"node -e 0"}}' } });
const repoB = (d) => initRepo(d, { message: 'beta start', files: { 'README.md': '# Beta\n' } });
const titles = async (be, q = '') => (await be.call('GET', `/api/tasks${q}`)).body.tasks.map((t) => t.title);

async function seeded() {
  const be = await boot({ roots: { alpha: repoA, beta: repoB } });
  const a = await be.register('alpha', { name: 'Alpha', product: 'Payments' });
  const b = await be.register('beta', { name: 'Beta', product: 'Payroll' });
  const t = {};
  for (const [k, p] of [['one', a], ['two', b], ['three', a], ['four', b]]) t[k] = await be.newTask({ title: k, project: p.id, projectId: p.id });
  return { be, a, b, t };
}

test('one global order across projects: new tasks go to the bottom, position is the priority, rows show project and product', async () => {
  const { be, a, b, t } = await seeded();
  assert.deepEqual(await titles(be), ['one', 'two', 'three', 'four']);
  const list = (await be.call('GET', '/api/tasks')).body.tasks;
  assert.deepEqual(list.map((x) => x.position), [1, 2, 3, 4]);
  assert.equal(list[0].project.name, 'Alpha');
  assert.equal(list[0].project.product, 'Payments');
  assert.equal(list[1].project.product, 'Payroll');
  assert.deepEqual(list[0].origin, { type: 'manual' });
  const top = await be.newTask({ title: 'urgent', projectId: b.id, position: 'top' });
  assert.equal(top.position, 1);
  const mid = await be.newTask({ title: 'mid', projectId: a.id, position: { afterId: t.two.id } });
  assert.deepEqual(await titles(be), ['urgent', 'one', 'two', 'mid', 'three', 'four']);
  const bad = await be.call('POST', '/api/tasks', { title: '', projectId: a.id });
  assert.equal(bad.status, 400);
  assert.equal((await be.call('POST', '/api/tasks', { title: 'x' })).status, 400, 'a project is required');
  assert.equal((await be.call('POST', '/api/tasks', { title: 'x', projectId: 'prj_nonexistent0000' })).status, 404);
  assert.ok(mid.id);
});

test('moves are relative and persisted; a stale revision is refused with the authoritative list; failures change nothing', async () => {
  const { be, t } = await seeded();
  const rev0 = (await be.call('GET', '/api/tasks')).body.rev;
  const m1 = await be.call('POST', `/api/tasks/${t.four.id}/move`, { beforeId: t.one.id, rev: rev0 });
  assert.equal(m1.status, 200);
  assert.deepEqual(m1.body.tasks.map((x) => x.title), ['four', 'one', 'two', 'three']);
  assert.ok(m1.body.rev > rev0);
  // A second client that still holds rev0 is refused and given the current order.
  const stale = await be.call('POST', `/api/tasks/${t.two.id}/move`, { top: true, rev: rev0 });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.backlog.tasks.map((x) => x.title), ['four', 'one', 'two', 'three']);
  assert.equal(stale.body.backlog.rev, m1.body.rev);
  assert.deepEqual(await titles(be), ['four', 'one', 'two', 'three'], 'nothing moved');
  // Retrying with the fresh revision works; top/bottom/afterId are supported.
  assert.equal((await be.call('POST', `/api/tasks/${t.two.id}/move`, { top: true, rev: stale.body.backlog.rev })).status, 200);
  assert.equal((await be.call('POST', `/api/tasks/${t.two.id}/move`, { bottom: true })).status, 200);
  assert.equal((await be.call('POST', `/api/tasks/${t.three.id}/move`, { afterId: t.four.id })).status, 200);
  assert.deepEqual(await titles(be), ['four', 'three', 'one', 'two']);
  // Invalid requests.
  assert.equal((await be.call('POST', `/api/tasks/${t.one.id}/move`, {})).status, 400);
  assert.equal((await be.call('POST', `/api/tasks/${t.one.id}/move`, { beforeId: t.one.id })).status, 400);
  assert.equal((await be.call('POST', `/api/tasks/${t.one.id}/move`, { beforeId: 'tsk_doesnotexist12345' })).status, 404);
  assert.equal((await be.call('POST', `/api/tasks/${t.one.id}/move`, { beforeId: '../etc' })).status, 404);
  assert.equal((await be.call('POST', '/api/tasks/tsk_doesnotexist12345/move', { top: true })).status, 404);
  assert.deepEqual(await titles(be), ['four', 'three', 'one', 'two']);
  // A no-op move is reported as such and keeps the revision.
  const same = await be.call('POST', `/api/tasks/${t.four.id}/move`, { top: true });
  assert.equal(same.body.moved, false);
});

test('concurrent moves never lose or duplicate a task: the order stays a permutation of all tasks', async () => {
  const { be, t } = await seeded();
  const ids = Object.values(t).map((x) => x.id);
  await Promise.all(ids.flatMap((id, i) => [be.call('POST', `/api/tasks/${id}/move`, i % 2 ? { top: true } : { bottom: true })]));
  const after = (await be.call('GET', '/api/tasks')).body.tasks.map((x) => x.id);
  assert.deepEqual([...after].sort(), [...ids].sort());
  assert.equal(new Set(after).size, ids.length);
});

test('the order survives a restart; filters are views over the same order and never create another one', async () => {
  const { be, a, b, t } = await seeded();
  await be.call('POST', `/api/tasks/${t.three.id}/move`, { top: true });
  const full = await titles(be);
  assert.deepEqual(full, ['three', 'one', 'two', 'four']);
  assert.deepEqual(await titles(be, `?projectId=${b.id}`), ['two', 'four']);
  assert.deepEqual(await titles(be, `?product=${encodeURIComponent('Payments')}`), ['three', 'one']);
  assert.deepEqual(await titles(be, '?q=FOUR'), ['four']);
  const filtered = (await be.call('GET', `/api/tasks?projectId=${a.id}`)).body;
  assert.equal(filtered.filtered, true);
  assert.equal(filtered.total, 4);
  assert.deepEqual(filtered.tasks.map((x) => x.position), [1, 2], 'a filtered view reports the position in the global order');
  // Moving inside a filtered view is a move in the global order.
  await be.call('POST', `/api/tasks/${t.four.id}/move`, { beforeId: t.two.id });
  assert.deepEqual(await titles(be), ['three', 'one', 'four', 'two']);
  await be.restart();
  assert.deepEqual(await titles(be), ['three', 'one', 'four', 'two']);
  const raw = JSON.parse(fs.readFileSync(`${be.dataDir}/tasks.json`, 'utf8'));
  assert.equal(raw.order.length, 4, 'one authoritative order array');
  assert.ok(!('priority' in raw.tasks[raw.order[0]]), 'no second priority field');
});

test('editing: title, description and project; text is redacted; statuses follow the documented transitions', async () => {
  const { be, b, t } = await seeded();
  const edited = await be.call('PATCH', `/api/tasks/${t.one.id}`, { title: 'renamed', description: 'use key sk-ant-SECRETSECRETSECRET12345678 carefully', projectId: b.id });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.task.project.name, 'Beta');
  assert.equal(edited.body.task.position, 1, 'editing never reorders');
  assert.ok(!edited.body.task.description.includes('SECRETSECRET'));
  assert.equal((await be.call('PATCH', `/api/tasks/${t.one.id}`, { title: '  ' })).status, 400);
  const set = (s) => be.call('POST', `/api/tasks/${t.one.id}/status`, { status: s });
  assert.equal((await set('ready')).body.task.status, 'ready');
  assert.equal((await set('blocked')).body.task.status, 'blocked');
  assert.equal((await set('completed')).status, 409, 'blocked → completed is not allowed');
  assert.equal((await set('in_progress')).status, 409, 'a task becomes in progress only by being started');
  assert.equal((await set('nonsense')).status, 400);
  assert.equal((await set('cancelled')).body.task.status, 'cancelled');
  assert.equal((await set('backlog')).body.task.status, 'backlog', 'reopen');
  assert.equal((await be.call('GET', '/api/tasks')).body.tasks[0].id, t.one.id, 'status changes never change the order');
  // Finished tasks stay in the list unless a filter hides them (explicit "open" view).
  await set('cancelled');
  assert.equal((await titles(be)).length, 4);
  assert.equal((await titles(be, '?status=open')).length, 3);
  assert.equal((await titles(be, '?status=finished')).length, 1);
});

test('chat-origin tasks keep their conversation and messages, default to its project, and are never executed', async () => {
  const be = await boot({ roots: { alpha: repoA, beta: repoB }, fake: new ChatFake({ reply: () => 'Plan: add retries.\n```sh\nrm -rf /\n```' }) });
  const a = await be.register('alpha', { name: 'Alpha' });
  const b = await be.register('beta', { name: 'Beta' });
  const c = await be.newConvo(a.id);
  const r = await be.ask(c.id, 'how to add retries?');
  const [u, asst] = r.conversation.messages;
  const runsBefore = (await be.call('GET', '/api/runs')).body.runs.length;
  const made = await be.call('POST', '/api/tasks', { title: 'Add retries', description: asst.content, origin: { type: 'chat', conversationId: c.id, messageIds: [asst.id], excerpt: 'Plan: add retries.' } });
  assert.equal(made.status, 201);
  assert.equal(made.body.task.projectId, a.id, 'defaults to the conversation project');
  assert.equal(made.body.task.origin.conversationId, c.id);
  assert.deepEqual(made.body.task.origin.messageIds, [asst.id]);
  assert.equal(made.body.task.origin.conversationTitle, r.conversation.title);
  assert.equal(made.body.task.status, 'backlog');
  assert.equal(made.body.task.run, null);
  assert.equal((await be.call('GET', '/api/runs')).body.runs.length, runsBefore, 'creating a task starts nothing');
  // The user may choose a different project explicitly; the conversation stays where it is.
  const other = await be.call('POST', '/api/tasks', { title: 'Elsewhere', projectId: b.id, origin: { type: 'chat', conversationId: c.id, messageIds: [u.id] } });
  assert.equal(other.body.task.projectId, b.id);
  assert.equal((await be.call('GET', `/api/chat/conversations/${c.id}`)).body.conversation.projectId, a.id);
  // References are validated.
  assert.equal((await be.call('POST', '/api/tasks', { title: 'x', origin: { type: 'chat', conversationId: c.id, messageIds: ['msg_nope'] } })).status, 400);
  assert.equal((await be.call('POST', '/api/tasks', { title: 'x', origin: { type: 'chat', conversationId: 'cnv_doesnotexist123' } })).status, 404);
  // The origin survives a restart and stays inspectable.
  await be.restart();
  const again = (await be.call('GET', `/api/tasks/${made.body.task.id}`)).body.task;
  assert.equal(again.origin.conversationExists, true);
});

test('Start hands the project and reviewed description to the factory, links the run, and never completes the task by itself', async () => {
  const { be, a, t } = await seeded();
  await be.call('PATCH', `/api/tasks/${t.one.id}`, { description: 'Reviewed description: add a changelog' });
  assert.equal((await be.call('GET', '/api/runs')).body.runs.length, 0, 'creating and editing tasks starts nothing');
  const started = await be.call('POST', `/api/tasks/${t.one.id}/start`, { provider: 'offline' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.task.status, 'in_progress');
  assert.equal(started.body.task.currentRunId, started.body.run.id);
  assert.deepEqual(started.body.task.runIds, [started.body.run.id]);
  const run = (await be.call('GET', `/api/runs/${started.body.run.id}`)).body.run ?? started.body.run;
  assert.match(run.inputs?.idea ?? run.title, /Reviewed description: add a changelog/);
  assert.equal(run.projectId, a.id);
  assert.equal(run.taskId, t.one.id);
  // Starting again is refused while it is in progress; position is unchanged.
  assert.equal((await be.call('POST', `/api/tasks/${t.one.id}/start`, {})).status, 409);
  assert.equal((await be.call('GET', '/api/tasks')).body.tasks[0].id, t.one.id);
  // Let the run reach a final state; the task must stay in progress until a person completes it.
  const end = Date.now() + 120000;
  let row;
  for (;;) {
    row = (await be.call('GET', `/api/tasks/${t.one.id}`)).body.task;
    if (row.run && !row.run.executing) break;
    if (Date.now() > end) throw new Error('run did not finish');
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(row.status, 'in_progress', 'a finished run does not complete the task');
  assert.ok(['completed', 'failed', 'stopped', 'done', 'awaiting_review', 'needs_review'].includes(row.run.status) || row.run.status, 'the actual run status is shown');
  assert.equal((await be.call('POST', `/api/tasks/${t.one.id}/status`, { status: 'completed' })).body.task.status, 'completed');
});

test('authorization: archived or unknown projects cannot receive or start tasks; their tasks stay inspectable; the password is required', async () => {
  const { be, a, b, t } = await seeded();
  await be.call('POST', `/api/projects/${b.id}/archive`, {});
  assert.equal((await be.call('POST', '/api/tasks', { title: 'x', projectId: b.id })).status, 409);
  assert.equal((await be.call('POST', `/api/tasks/${t.two.id}/start`, {})).status, 409);
  const row = (await be.call('GET', `/api/tasks/${t.two.id}`)).body.task;
  assert.equal(row.project.archived, true);
  assert.equal(row.startable, false);
  assert.equal((await be.call('PATCH', `/api/tasks/${t.one.id}`, { projectId: b.id })).status, 409);
  assert.equal((await be.call('GET', '/api/runs')).body.runs.length, 0);
  // Removed project: the task remains, labelled as such.
  await be.call('DELETE', `/api/projects/${a.id}`, { confirm: 'Alpha' });
  const gone = (await be.call('GET', `/api/tasks/${t.one.id}`)).body.task;
  assert.equal(gone.project.removed, true);
  assert.equal(gone.project.name, 'Alpha');
  assert.equal((await be.call('POST', `/api/tasks/${t.one.id}/start`, {})).status, 404);
  const locked = await boot({ roots: { alpha: repoA }, password: 'pw' });
  assert.equal((await fetch(`${locked.url}/api/tasks`)).status, 401);
});

test('the product label is a minimal optional field on the project: set, changed and cleared; never derived from the repo name', async () => {
  const be = await boot({ roots: { alpha: repoA } });
  const a = await be.register('alpha', { name: 'Alpha' });
  assert.equal(a.product, null);
  const set = await be.call('PATCH', `/api/projects/${a.id}`, { product: '  Payments  ' });
  assert.equal(set.body.project.product, 'Payments');
  const task = await be.newTask({ title: 't', projectId: a.id });
  assert.equal(task.project.product, 'Payments');
  const cleared = await be.call('PATCH', `/api/projects/${a.id}`, { product: '' });
  assert.equal(cleared.body.project.product, null);
  await be.restart();
  assert.equal((await be.call('GET', `/api/tasks/${task.id}`)).body.task.project.product, null);
});
