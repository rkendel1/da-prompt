// Browser tests for chat and the backlog as a person uses them: streaming, copy (response / code block / selection /
// excerpt, with honest failure), message → task, drag-and-drop persistence, keyboard moves, stale and failed saves, Start.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cleanMachineEnv } from './cli-helpers.js';
import { startWorkBackend, ChatFake, initRepo } from './work-helpers.js';

cleanMachineEnv();
async function loadPlaywright() {
  for (const t of [() => import('playwright'), () => import(pathToFileURL(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright', 'index.mjs')).href)]) {
    try { return await t(); } catch { /* next */ }
  }
  return null;
}
let browser;
let skip = '';
const backends = [];
const contexts = [];
before(async () => {
  const pw = await loadPlaywright();
  if (!pw) return void (skip = 'Playwright is not installed');
  try { browser = await pw.chromium.launch(); } catch (e) { skip = `no browser available: ${e.message.split('\n')[0]}`; }
});
after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  for (const b of backends) await b.close().catch(() => {});
});
const T = (name, fn) => test(name, async (t) => (skip ? t.skip(skip) : fn(t)));
const repoA = (d) => initRepo(d, { files: { 'README.md': '# Alpha\n', 'package.json': '{"name":"alpha","scripts":{"test":"node -e 0"}}' } });
const repoB = (d) => initRepo(d, { message: 'beta start', files: { 'README.md': '# Beta\n' } });
const REPLY = 'First answer line.\n```js\nconst one = 1;\n```\nMiddle text.\n```sh\necho two\n```\nEnd.';

async function boot(opts = {}) {
  const be = await startWorkBackend({ roots: { alpha: repoA, beta: repoB }, fake: new ChatFake({ reply: () => REPLY, delayMs: 5 }), ...opts });
  backends.push(be);
  be.a = await be.register('alpha', { name: 'Alpha', product: 'Payments' });
  be.b = await be.register('beta', { name: 'Beta', product: 'Payroll' });
  return be;
}
async function open(be, hash, { clipboard = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: clipboard ? ['clipboard-read', 'clipboard-write'] : [] });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${be.url}/${hash}`);
  return page;
}
const order = async (be) => (await be.call('GET', '/api/tasks')).body.tasks.map((t) => t.title);
const rowTitles = (page) => page.$$eval('.bl-row .bl-title', (els) => els.map((e) => e.textContent));
async function seedTasks(be) {
  for (const [k, p] of [['one', be.a], ['two', be.b], ['three', be.a], ['four', be.b]]) await be.newTask({ title: k, projectId: p.id });
}

T('chat: a conversation is bound to its project, streams a response, and shows what was retrieved vs inferred', async () => {
  const be = await boot();
  const c = await be.newConvo(be.a.id);
  const page = await open(be, `#/chat/${c.id}`);
  await page.waitForSelector('#chat-form');
  assert.match(await page.textContent('#chat-project-bar'), /Alpha · Payments/);
  assert.equal(await page.locator('#chat-project-bar select').count(), 0, 'the project cannot be switched inside a conversation');
  await page.fill('#chat-input', 'What is in README.md?');
  await page.press('#chat-input', 'Enter');
  await page.waitForSelector('.msg.assistant.complete');
  assert.match(await page.textContent('.msg.assistant .msg-body'), /First answer line/);
  assert.match(await page.textContent('.msg.assistant header'), /fake/);
  const ctx = await page.textContent('.msg.assistant .ctx summary');
  assert.match(ctx, /Retrieved from the project: \d+ item/);
  await page.click('.msg.assistant .ctx summary');
  assert.match(await page.textContent('.msg.assistant .ctx'), /README\.md/);
  assert.match(await page.textContent('.msg.assistant .ctx'), /inference/);
  // Refresh: everything comes back from the backend.
  await page.reload();
  await page.waitForSelector('.msg.assistant.complete');
  assert.equal(await page.locator('.msg').count(), 2);
  assert.deepEqual(page.errors, []);
});

T('chat: provider/model selection applies to future messages; the earlier response keeps its model', async () => {
  const be = await boot();
  const c = await be.newConvo(be.a.id);
  await be.ask(c.id, 'first');
  const page = await open(be, `#/chat/${c.id}`);
  await page.waitForSelector('.msg.assistant.complete');
  await page.selectOption('#chat-provider', 'offline');
  await page.waitForFunction(() => document.querySelector('#chat-provider').value === 'offline');
  await page.fill('#chat-input', 'second');
  await page.press('#chat-input', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.msg.assistant.complete').length === 2);
  const heads = await page.$$eval('.msg.assistant header strong', (els) => els.map((e) => e.textContent));
  assert.match(heads[0], /fake/);
  assert.doesNotMatch(heads[1], /fake/);
  const dump = await page.content();
  assert.ok(!/apiKey|sk-ant/i.test(dump));
});

T('chat: copy response, each code block independently, a selection and an excerpt; clipboard failure is reported honestly', async () => {
  const be = await boot();
  const c = await be.newConvo(be.a.id);
  await be.ask(c.id, 'show code');
  const page = await open(be, `#/chat/${c.id}`);
  await page.waitForSelector('.msg.assistant.complete');
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  await page.click('.msg.assistant [data-act=copy]');
  assert.equal(await clip(), REPLY);
  const codeBtns = page.locator('[data-copy-code]');
  assert.equal(await codeBtns.count(), 2);
  await codeBtns.nth(1).click();
  assert.equal(await clip(), 'echo two', 'only that block');
  await codeBtns.nth(0).click();
  assert.equal(await clip(), 'const one = 1;');
  // Excerpt: tick both messages.
  await page.locator('.pick-box').nth(0).check();
  await page.locator('.pick-box').nth(1).check();
  await page.click('#copy-picked');
  const excerpt = await clip();
  assert.match(excerpt, /^You:\nshow code\n\nAssistant \(.*fake-model\):\nFirst answer line/);
  // Selection
  await page.evaluate(() => { const el = document.querySelector('.msg.assistant .prose'); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.waitForSelector('#sel-bar:not([hidden])');
  await page.click('#sel-copy');
  assert.equal((await clip()).trim(), 'First answer line.');
  // Failure: no clipboard API and execCommand refuses → a dialog, never a false "Copied".
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true }); document.execCommand = () => false; });
  await page.click('.msg.assistant [data-act=copy]');
  await page.waitForSelector('dialog.copy-fallback[open]');
  assert.match(await page.textContent('dialog.copy-fallback'), /Could not copy automatically/);
  assert.equal(await page.locator('.toast').filter({ hasText: /to the clipboard/ }).count(), 0);
});

T('chat: a new chat needs no project; the first message creates it, and the context panel switches what is sent', async () => {
  const be = await boot();
  const page = await open(be, '#/chat');
  await page.waitForSelector('#chat-form');
  assert.equal(await page.inputValue('#chat-project'), '', 'no project is selected by default');
  assert.match(await page.textContent('.hello'), /How can I help/);
  assert.equal(await page.isDisabled('#chat-send'), true, 'nothing to send yet');
  assert.equal((await be.call('GET', '/api/chat/conversations')).body.conversations.length, 0, 'nothing is created until you send');
  // Pin a note and switch history off BEFORE the chat exists: both travel with the first message.
  await page.click('#ctx-btn');
  await page.waitForSelector('#ctx-panel:not([hidden])');
  assert.deepEqual(await page.$$eval('#ctx-panel [data-src]', (els) => els.map((e) => e.dataset.src)), ['history'], 'without a project only history is a source');
  await page.fill('#note-text', 'We target Node 20.');
  await page.click('[data-note-save]');
  await page.waitForSelector('#ctx-panel [data-note-toggle]');
  await page.uncheck('#ctx-panel [data-src=history]');
  await page.keyboard.press('Escape');
  await page.fill('#chat-input', 'Hello there');
  await page.press('#chat-input', 'Enter');
  await page.waitForURL(/#\/chat\/cnv_/);
  await page.waitForSelector('.msg.assistant.complete');
  const convo = (await be.call('GET', '/api/chat/conversations')).body.conversations[0];
  assert.equal(convo.projectId, null);
  const full = (await be.call('GET', `/api/chat/conversations/${convo.id}`)).body.conversation;
  assert.equal(full.context.sources.history, false);
  assert.equal(full.context.notes[0].text, 'We target Node 20.');
  assert.match(be.fake.calls.at(-1).system, /We target Node 20\./);
  assert.match(await page.textContent('#chat-project-bar'), /No project/);
  assert.match(await page.textContent('.msg.assistant .ctx summary'), /1 pinned note/);
  // Untick the note in the thread: the next message no longer carries it.
  await page.click('#ctx-btn');
  await page.uncheck('#ctx-panel [data-note-toggle]');
  await page.waitForFunction(async (id) => !(await (await fetch(`api/chat/conversations/${id}`)).json()).conversation.context.notes[0].enabled, convo.id);
  await page.keyboard.press('Escape');
  await page.fill('#chat-input', 'Again');
  await page.press('#chat-input', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.msg.assistant.complete').length === 2);
  assert.ok(!/We target Node 20/.test(be.fake.calls.at(-1).system));
  assert.deepEqual(page.errors, []);
});

T('chat: with a project the panel lists every source with its size, and switching one off stops it being sent', async () => {
  const be = await boot();
  const c = await be.newConvo(be.a.id);
  const page = await open(be, `#/chat/${c.id}`);
  await page.waitForSelector('#chat-form');
  await page.click('#ctx-btn');
  await page.waitForSelector('#ctx-panel [data-src=docs]');
  assert.deepEqual(await page.$$eval('#ctx-panel [data-src]', (els) => els.map((e) => e.dataset.src)), ['history', 'project', 'backlog', 'runs', 'git', 'files', 'docs', 'mentioned']);
  assert.match(await page.textContent('#ctx-panel'), /README\.md/);
  await page.uncheck('#ctx-panel [data-src=docs]');
  await page.waitForFunction(async (id) => (await (await fetch(`api/chat/conversations/${id}`)).json()).conversation.context.sources.docs === false, c.id);
  await page.keyboard.press('Escape');
  await page.fill('#chat-input', 'Any thoughts?');
  await page.press('#chat-input', 'Enter');
  await page.waitForSelector('.msg.assistant.complete');
  assert.ok(!/# Alpha/.test(be.fake.calls.at(-1).system), 'the README was not sent');
  assert.match(be.fake.calls.at(-1).system, /name: Alpha/, 'other sources still are');
});

T('chat → task: review a draft, edit it, save with origin and project; nothing runs', async () => {
  const be = await boot();
  const c = await be.newConvo(be.a.id);
  await be.ask(c.id, 'how do we add retries?');
  const page = await open(be, `#/chat/${c.id}`);
  await page.waitForSelector('.msg.assistant.complete');
  await page.locator('.msg.assistant [data-act=task]').click();
  await page.waitForSelector('#td-form');
  assert.match(await page.textContent('dialog.task-dialog'), /nothing is run/i);
  assert.equal(await page.inputValue('#td-form [name=projectId]'), be.a.id, 'defaults to the conversation project');
  assert.equal((await be.call('GET', '/api/tasks')).body.tasks.length, 0, 'a draft is not saved');
  await page.fill('#td-form [name=title]', 'Add retries to billing');
  await page.selectOption('#td-form [name=position]', 'top');
  await page.click('#td-form button[type=submit]');
  await page.waitForSelector('dialog.task-dialog', { state: 'detached' });
  const tasks = (await be.call('GET', '/api/tasks')).body.tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Add retries to billing');
  assert.equal(tasks[0].origin.type, 'chat');
  assert.equal(tasks[0].origin.conversationId, c.id);
  assert.equal(tasks[0].projectId, be.a.id);
  assert.equal((await be.call('GET', '/api/runs')).body.runs.length, 0);
  // The backlog row links back to the conversation.
  await page.goto(`${be.url}/#/backlog`);
  await page.waitForSelector('.bl-row');
  assert.match(await page.textContent('.bl-row .bl-meta'), /from chat/);
  assert.match(await page.textContent('.bl-row .bl-meta'), /Alpha/);
  assert.match(await page.textContent('.bl-row .bl-meta'), /Payments/);
});

T('backlog: drag by the handle reorders immediately, is saved on the server, and survives a reload; a plain click never reorders', async () => {
  const be = await boot();
  await seedTasks(be);
  const page = await open(be, '#/backlog');
  await page.waitForSelector('.bl-row');
  assert.deepEqual(await rowTitles(page), ['one', 'two', 'three', 'four']);
  // Clicking title/row does not move anything (it opens details).
  await page.locator('.bl-row').nth(1).locator('.bl-title').click();
  await page.waitForSelector('dialog.task-dialog');
  await page.click('dialog.task-dialog [data-close]');
  assert.deepEqual(await order(be), ['one', 'two', 'three', 'four']);
  // Drag "four" above "one".
  await page.locator('.bl-row').nth(3).locator('.bl-handle').dragTo(page.locator('.bl-row').nth(0), { targetPosition: { x: 60, y: 4 } });
  await page.waitForFunction(() => document.querySelector('.bl-row .bl-title').textContent === 'four');
  await page.waitForFunction(() => [...document.querySelectorAll('.bl-pos')].map((e) => e.textContent).join() === '1,2,3,4');
  assert.deepEqual(await order(be), ['four', 'one', 'two', 'three']);
  await page.reload();
  await page.waitForSelector('.bl-row');
  assert.deepEqual(await rowTitles(page), ['four', 'one', 'two', 'three']);
  assert.deepEqual(page.errors, []);
});

T('backlog: keyboard move up/down keeps focus on the moved row; project and product filters are views over the same order', async () => {
  const be = await boot();
  await seedTasks(be);
  const page = await open(be, '#/backlog');
  await page.waitForSelector('.bl-row');
  const down = page.locator('.bl-row').nth(0).locator('[data-act=down]');
  await down.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.bl-row .bl-title').textContent === 'two');
  assert.deepEqual(await order(be), ['two', 'one', 'three', 'four']);
  assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /Move down: one/);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.bl-row .bl-title')[2]?.textContent === 'one');
  assert.deepEqual(await order(be), ['two', 'three', 'one', 'four']);
  // Filters.
  await page.selectOption('#bl-product', 'Payroll');
  assert.deepEqual(await rowTitles(page), ['two', 'four']);
  assert.deepEqual(await page.$$eval('.bl-pos', (e) => e.map((x) => x.textContent)), ['1', '4'], 'positions are from the full backlog');
  assert.match(await page.textContent('#bl-note'), /Showing 2 of 4/);
  // Moving inside a filtered view changes the one global order.
  await page.locator('.bl-row').nth(1).locator('[data-act=up]').click();
  await page.waitForFunction(() => document.querySelector('.bl-row .bl-title').textContent === 'four');
  assert.deepEqual(await order(be), ['four', 'two', 'three', 'one']);
  await page.selectOption('#bl-product', '');
  assert.deepEqual(await rowTitles(page), ['four', 'two', 'three', 'one']);
});

T('backlog: a stale view is reconciled (nothing clobbered) and a failed save is reverted with a visible error', async () => {
  const be = await boot();
  await seedTasks(be);
  const page = await open(be, '#/backlog');
  await page.waitForSelector('.bl-row');
  // Another client reorders behind the page's back.
  const t = (await be.call('GET', '/api/tasks')).body.tasks;
  await be.call('POST', `/api/tasks/${t[3].id}/move`, { top: true });
  await page.locator('.bl-row').nth(0).locator('[data-act=down]').click();
  await page.waitForSelector('#bl-error:not([hidden])');
  assert.match(await page.textContent('#bl-error'), /changed somewhere else/);
  assert.deepEqual(await rowTitles(page), ['four', 'one', 'two', 'three'], 'the server order is shown');
  assert.deepEqual(await order(be), ['four', 'one', 'two', 'three'], 'the stale move was not applied');
  // A failed save.
  await page.route('**/api/tasks/*/move', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk full' }) }));
  await page.locator('.bl-row').nth(0).locator('[data-act=down]').click();
  await page.waitForFunction(() => /could not be saved/.test(document.querySelector('#bl-error').textContent));
  assert.deepEqual(await rowTitles(page), ['four', 'one', 'two', 'three'], 'reverted');
  assert.deepEqual(await order(be), ['four', 'one', 'two', 'three']);
});

T('backlog: add a task manually; Start asks first, creates and links a run, and the task is not auto-completed', async () => {
  const be = await boot();
  const page = await open(be, '#/backlog');
  await page.waitForSelector('.empty-term');
  await page.click('#bl-add');
  await page.fill('#add-form [name=title]', 'Write changelog');
  await page.fill('#add-form [name=description]', 'Add CHANGELOG.md');
  await page.selectOption('#add-form [name=projectId]', be.b.id);
  await page.click('#add-form button[type=submit]');
  await page.waitForSelector('.bl-row');
  assert.match(await page.textContent('.bl-row .bl-meta'), /Beta/);
  assert.equal((await be.call('GET', '/api/runs')).body.runs.length, 0);
  await page.click('.bl-row [data-act=start]');
  assert.match(await page.textContent('dialog.task-dialog'), /explicit approval/);
  assert.equal((await be.call('GET', '/api/runs')).body.runs.length, 0, 'the confirmation alone starts nothing');
  await page.click('#start-go');
  await page.waitForFunction(() => location.hash.startsWith('#/runs/'));
  const task = (await be.call('GET', '/api/tasks')).body.tasks[0];
  assert.equal(task.status, 'in_progress');
  assert.ok(task.currentRunId);
  await page.goto(`${be.url}/#/backlog`);
  await page.waitForSelector('.bl-row');
  assert.match(await page.textContent('.bl-row .bl-meta'), /run /);
  assert.match(await page.textContent('.bl-row'), /In progress/);
});
