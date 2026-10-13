// Browser tests for the Terminal page: real Chromium, real xterm.js, real PTY sessions on a real backend.
// Needs Playwright (skipped, loudly, when it is missing).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cleanMachineEnv } from './cli-helpers.js';
import { startTerminalBackend, pidsFrom } from './terminal-helpers.js';
import { alive } from '../src/terminal.js';
import { waitFor } from './helpers.js';

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
const pages = [];
before(async () => {
  const pw = await loadPlaywright();
  if (!pw) return void (skip = 'Playwright is not installed');
  try { browser = await pw.chromium.launch(); } catch (e) { skip = `no browser available: ${e.message.split('\n')[0]}`; }
});
after(async () => {
  for (const p of pages) await p.close().catch(() => {});
  await browser?.close();
  for (const b of backends) await b.close().catch(() => {});
});

const boot = async (opts) => {
  const be = await startTerminalBackend({ ...opts, extra: { terminalShell: '/bin/bash', ...(opts?.extra || {}) } }); // what developers use: readline history/editing, job control
  backends.push(be);
  return be;
};
async function newPage(be, hash = '#/terminal') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  pages.push(page);
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${be.url}/${hash}`);
  return page;
}
const buffer = (page) => page.evaluate(() => {
  const t = window.__daTerminal?.().active?.term;
  if (!t) return '';
  const b = t.buffer.active;
  const out = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true));
  return out.join('\n');
});
const waitBuf = (page, re, timeout = 20000) => waitFor(async () => (re instanceof RegExp ? re.test(await buffer(page)) : (await buffer(page)).includes(re)), { timeoutMs: timeout, intervalMs: 50 });
const connState = (page) => page.evaluate(() => document.querySelector('#term-meta [data-state]')?.dataset.state || '');
const open = async (page) => {
  await page.waitForSelector('#term-new:not([disabled])');
  await page.click('#term-new');
  await page.waitForSelector('.xterm-screen');
  await waitFor(async () => (await connState(page)) === 'live', { timeoutMs: 20000, intervalMs: 50 });
};
const run = async (page, line) => {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
};
const T = (name, fn) => test(name, async (t) => (skip ? t.skip(skip) : fn(t)));

T('the main navigation has a Terminal entry; opening it shows the host-shell warning and the project picker, and never needs an agent', async () => {
  const be = await boot();
  const page = await newPage(be, '#/');
  await page.click('a[href="#/terminal"]');
  await page.waitForSelector('#term-new');
  assert.match(await page.textContent('.term-trust'), /Host shell.*not confined/s);
  assert.match(await page.textContent('#term-project'), /app/);
  await page.click('#term-policy-toggle');
  assert.match(await page.textContent('#term-policy'), /opaque id, never a path/);
  assert.deepEqual(page.errors, []);
});

T('workflow: select the repository, run pwd and git status, the repo\'s test command, inspect a diff — with real keyboard input', async () => {
  const be = await boot();
  const page = await newPage(be);
  await open(page);
  assert.match(await page.textContent('#term-meta'), /project\s*app/);
  assert.ok((await page.textContent('#term-cwd')).endsWith('/app'));
  await run(page, 'pwd');
  await waitBuf(page, /\n\/.*\/app\n/);
  await run(page, 'git status');
  await waitBuf(page, /On branch main[\s\S]*nothing to commit/);
  await run(page, 'npm test 2>&1 | tail -3; echo TESTS_DONE=$?');
  await waitBuf(page, /\nTESTS_DONE=0/, 60000);
  await run(page, 'echo "export const y = 2;" >> src/greet.js; git diff --stat; git diff | head -12');
  await waitBuf(page, /src\/greet\.js\s+\|\s+1 \+/);
  await waitBuf(page, /\+export const y = 2;/);
  await run(page, 'git --version; node --version');
  await waitBuf(page, /git version [\d.]+/);
  assert.deepEqual(page.errors, []);
});

T('keyboard: history with the up arrow, line editing, paste, copy of a selection, Ctrl-C only interrupts when nothing is selected', async () => {
  const be = await boot(); // history/editing are the shell's (readline): dash has none
  const page = await newPage(be);
  await open(page);
  await run(page, 'echo first-command');
  await waitBuf(page, /\nfirst-command\n/);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await waitFor(async () => ((await buffer(page)).match(/\nfirst-command\n/g) || []).length >= 2, { timeoutMs: 15000, intervalMs: 50 });
  // Paste goes through the terminal as one block (bracketed-paste aware).
  await page.evaluate(() => window.__daTerminal().active.term.paste('echo pasted-text'));
  await page.keyboard.press('Enter'); // bracketed paste: the shell waits for Enter, like a real terminal
  await waitBuf(page, /\npasted-text\n/);
  // Editing: type, Backspace, finish.
  await page.keyboard.type('echo abcX');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('d');
  await page.keyboard.press('Enter');
  await waitBuf(page, /\nabcd\n/);
  // Selection and copy.
  await page.evaluate(() => window.__daTerminal().active.term.selectAll());
  const selected = await page.evaluate(() => window.__daTerminal().active.term.getSelection());
  assert.match(selected, /first-command/);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.keyboard.press('Control+C'); // with a selection: copy, not interrupt
  await waitFor(async () => (await page.evaluate(() => navigator.clipboard.readText())).includes('first-command'), { timeoutMs: 5000, intervalMs: 100 });
  await page.evaluate(() => window.__daTerminal().active.term.clearSelection());
  await run(page, 'sleep 300');
  await new Promise((r) => setTimeout(r, 500));
  await page.keyboard.press('Control+C'); // no selection: the shell gets it
  await run(page, 'echo CODE=$?');
  await waitBuf(page, /\nCODE=130\n/);
});

T('scrolling: long output builds scrollback and the viewport can be scrolled with the wheel and back to the bottom', async () => {
  const be = await boot();
  const page = await newPage(be);
  await open(page);
  await run(page, 'seq 1 400; echo SEQ_END');
  await waitBuf(page, /\nSEQ_END\n/);
  const atBottom = await page.evaluate(() => { const b = window.__daTerminal().active.term.buffer.active; return { y: b.viewportY, base: b.baseY }; });
  assert.ok(atBottom.base > 100, 'there is scrollback');
  assert.equal(atBottom.y, atBottom.base, 'follows the output');
  await page.mouse.move(600, 500);
  await page.mouse.wheel(0, -1500);
  await waitFor(async () => (await page.evaluate(() => { const b = window.__daTerminal().active.term.buffer.active; return b.viewportY < b.baseY; })), { timeoutMs: 5000, intervalMs: 50 });
  await page.evaluate(() => window.__daTerminal().active.term.scrollToBottom());
  assert.equal(await page.evaluate(() => { const b = window.__daTerminal().active.term.buffer.active; return b.viewportY === b.baseY; }), true);
});

T('interrupt button and resize: Interrupt stops the foreground process; resizing the window reaches the PTY', async () => {
  const be = await boot();
  const page = await newPage(be);
  await open(page);
  await run(page, 'sleep 500');
  await waitFor(() => { try { return execFileSync('pgrep', ['-f', '^sleep 500$'], { encoding: 'utf8' }).trim().length > 0; } catch { return false; } }, { timeoutMs: 15000, intervalMs: 50 }); // interrupt only once it really runs
  await page.click('#term-int');
  await run(page, 'echo INT=$?');
  await waitBuf(page, /\nINT=130\n/);
  const size = () => page.evaluate(() => { const t = window.__daTerminal().active.term; return [t.cols, t.rows]; });
  const before = await size();
  await page.setViewportSize({ width: 900, height: 600 });
  await waitFor(async () => { const [c, r] = await size(); return c !== before[0] || r !== before[1]; }, { timeoutMs: 8000, intervalMs: 100 });
  // The browser's new size reaches the backend's session (debounced POST).
  await waitFor(async () => { const s = (await be.call('GET', '/api/terminal')).body.sessions[0]; const [c, r] = await size(); return s.cols === c && s.rows === r; }, { timeoutMs: 8000, intervalMs: 100 });
  const now = await page.evaluate(() => { const t = window.__daTerminal().active.term; return [t.cols, t.rows]; });
  await run(page, 'stty size');
  await waitBuf(page, new RegExp(`\\n${now[1]} ${now[0]}\\n`));
});

T('refresh keeps the session: the page reattaches to the running shell, replays its output, and the process is the same one', async () => {
  const be = await boot();
  const page = await newPage(be);
  await open(page);
  await run(page, 'echo BEFORE_REFRESH $$; sleep 900 & echo BGPID=$!');
  await waitBuf(page, /BGPID=\d+/);
  const txt = await buffer(page);
  const shellPid = Number(/BEFORE_REFRESH (\d+)/.exec(txt)[1]);
  const bg = pidsFrom(txt, 'BGPID')[0];
  const id = (await be.call('GET', '/api/terminal')).body.sessions[0].id;
  await page.reload();
  await page.waitForSelector('.xterm-screen');
  await waitFor(async () => (await connState(page)) === 'live', { timeoutMs: 20000, intervalMs: 50 });
  await waitBuf(page, /BEFORE_REFRESH \d+/);
  assert.equal((await be.call('GET', '/api/terminal')).body.sessions.length, 1, 'no second session was created');
  assert.equal((await be.call('GET', '/api/terminal')).body.sessions[0].id, id);
  await run(page, 'echo SAME=$$');
  await waitBuf(page, new RegExp(`\\nSAME=${shellPid}\\n`));
  assert.ok(alive(bg), 'the background job survived the refresh');
  assert.deepEqual(page.errors, []);
});

T('connection states: reconnecting after a dropped stream (and resumes without duplicating output), disconnected with a Reconnect button, and closed on the server', async () => {
  const be = await boot();
  const page = await newPage(be);
  await open(page);
  await run(page, 'seq 1 30; echo MARK_ONE');
  await waitBuf(page, /\nMARK_ONE\n/);
  // 1. The server drops every connection: the browser reconnects from the last offset.
  const states = [];
  await page.exposeFunction('__seen', (s) => states.push(s));
  await page.evaluate(() => { window.__poll = setInterval(() => window.__seen(document.querySelector('#term-meta [data-state]')?.dataset.state || ''), 40); });
  be.server.closeAllConnections();
  await waitFor(() => states.includes('reconnecting'), { timeoutMs: 10000, intervalMs: 50 });
  await waitFor(async () => (await connState(page)) === 'live', { timeoutMs: 20000, intervalMs: 50 });
  await run(page, 'echo MARK_TWO');
  await waitBuf(page, /\nMARK_TWO\n/);
  assert.equal(((await buffer(page)).match(/\nMARK_ONE\n/g) || []).length, 1, 'no replay duplicated what was already drawn');
  // 2. The stream is refused but the session is fine: "disconnected" plus a Reconnect button.
  await page.route('**/api/terminal/sessions/*/stream*', (r) => r.fulfill({ status: 503, body: 'down' }));
  be.server.closeAllConnections();
  await waitFor(async () => (await connState(page)) === 'disconnected', { timeoutMs: 20000, intervalMs: 50 });
  assert.match(await page.textContent('#term-meta'), /disconnected/);
  await page.unroute('**/api/terminal/sessions/*/stream*');
  await page.click('#term-reconnect');
  await waitFor(async () => (await connState(page)) === 'live', { timeoutMs: 20000, intervalMs: 50 });
  // 3. The session is closed behind the page's back: the page says so instead of hanging.
  const id = (await be.call('GET', '/api/terminal')).body.sessions[0].id;
  await be.call('DELETE', `/api/terminal/sessions/${id}`);
  await waitFor(async () => (await connState(page)) === 'closed', { timeoutMs: 20000, intervalMs: 100 });
  assert.match(await page.textContent('#term-meta'), /closed on the server|no longer exists|not found/i);
  await page.evaluate(() => clearInterval(window.__poll));
});

T('exit and errors are visible: exit status in the header, input after exit does nothing, and a failed create explains why', async () => {
  const be = await boot();
  const page = await newPage(be);
  await open(page);
  await run(page, 'exit 5');
  await waitFor(async () => (await connState(page)) === 'exited', { timeoutMs: 15000, intervalMs: 50 });
  assert.match(await page.textContent('#term-meta'), /exit 5/);
  await waitBuf(page, /process exited with code 5/);
  assert.equal(await page.isDisabled('#term-int'), true);
  await page.route('**/api/terminal/sessions', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The terminal needs Python 3 on this host.' }) }) : r.continue()));
  await page.click('#term-new');
  await page.waitForSelector('#term-tools-out[role=alert]');
  assert.match(await page.textContent('#term-tools-out'), /needs Python 3/);
});

T('several sessions: create, switch, each keeps its own screen and directory; closing one kills its processes and leaves the other', async () => {
  const be = await boot({ projects: { app: (await import('./terminal-helpers.js')).gitProject, other: (await import('./terminal-helpers.js')).gitProject } });
  const page = await newPage(be);
  await open(page);
  await run(page, 'echo SESSION_A; sleep 800 & echo ABG=$!');
  await waitBuf(page, /ABG=\d+/);
  const aPid = pidsFrom(await buffer(page), 'ABG')[0];
  const opts = await page.$$eval('#term-project option', (o) => o.map((x) => [x.value, x.textContent]));
  const other = opts.find(([, t]) => /other/.test(t));
  await page.selectOption('#term-project', other[0]);
  await page.click('#term-new');
  await waitFor(async () => (await page.$$('.term-tab')).length === 2, { timeoutMs: 10000, intervalMs: 50 });
  await waitFor(async () => (await connState(page)) === 'live', { timeoutMs: 20000, intervalMs: 50 });
  assert.ok((await page.textContent('#term-cwd')).endsWith('/other'));
  await run(page, 'echo SESSION_B');
  await waitBuf(page, /\nSESSION_B\n/);
  assert.ok(!/SESSION_A/.test(await buffer(page).then((t) => t.replace(/echo SESSION_A/g, ''))), 'B does not show A\'s output');
  await page.click('.term-tab:first-child');
  assert.ok((await page.textContent('#term-cwd')).endsWith('/app'));
  await waitBuf(page, /\nSESSION_A\n/);
  // Close A (the active one): its background job dies, B stays.
  await page.click('#term-close');
  await waitFor(async () => (await page.$$('.term-tab')).length === 1, { timeoutMs: 10000, intervalMs: 50 });
  await waitFor(() => !alive(aPid), { timeoutMs: 10000, intervalMs: 100 });
  assert.equal((await be.call('GET', '/api/terminal')).body.sessions.length, 1);
  assert.ok((await page.textContent('#term-cwd')).endsWith('/other'));
});

T('close verifies cleanup: after Close nothing the session started is still running', async () => {
  const be = await boot();
  const page = await newPage(be);
  await open(page);
  await run(page, 'sleep 600 & echo P1=$!; (sleep 601 & echo P2=$!; wait) & sleep 1');
  await waitBuf(page, /P2=\d+/);
  const pids = [...pidsFrom(await buffer(page), 'P1'), ...pidsFrom(await buffer(page), 'P2')];
  assert.ok(pids.length === 2 && pids.every(alive));
  await page.click('#term-close');
  await waitFor(async () => (await page.$$('.term-tab')).length === 0, { timeoutMs: 10000, intervalMs: 50 });
  await waitFor(() => pids.every((p) => !alive(p)), { timeoutMs: 10000, intervalMs: 100 });
  assert.equal((await be.call('GET', '/api/terminal')).body.sessions.length, 0);
});

T('independent of the AI workflow: with every provider/health/run endpoint failing the terminal still opens and works', async () => {
  const be = await boot({ extra: { defaultProvider: 'ollama', paxPath: '/nonexistent/pax' } });
  const page = await newPage(be, '#/');
  await page.route(/\/api\/(providers|runs|system\/health|pax|config)/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"model server is down"}' }));
  await page.click('a[href="#/terminal"]');
  await open(page);
  await run(page, 'echo STILL_HERE; git log --oneline | head -1');
  await waitBuf(page, /\nSTILL_HERE\n/);
  await waitBuf(page, /initial/);
  // And the same without any routing tricks: a server with no provider configured at all.
  const bare = await boot();
  const page2 = await newPage(bare);
  await open(page2);
  await run(page2, 'echo NO_PROVIDER');
  await waitBuf(page2, /\nNO_PROVIDER\n/);
});

T('an unprotected server reached through a non-local address, or a host without PTY support, shows an actionable explanation', async () => {
  const noPy = await boot({ extra: { terminalPython: '/nonexistent/python3' } });
  const page = await newPage(noPy);
  await page.waitForSelector('.callout.fail');
  assert.match(await page.textContent('.callout.fail'), /Python 3/);
  assert.match(await page.textContent('.callout.fail'), /xcode-select --install/);
  const off = await boot({ extra: { terminalEnabled: false } });
  const page2 = await newPage(off);
  await page2.waitForSelector('.callout.fail');
  assert.match(await page2.textContent('.callout.fail'), /turned off|not available/i);
  const empty = await boot({ projects: {} });
  const page3 = await newPage(empty);
  await page3.waitForSelector('.empty-term');
  assert.match(await page3.textContent('.empty-term'), /Register a project first/);
});

T('check tools shows what a login shell finds (and flags what is missing) without exposing the environment', async () => {
  const be = await boot();
  const page = await newPage(be);
  await page.waitForSelector('#term-tools');
  await page.click('#term-tools');
  await page.waitForSelector('#term-tools-out table', { timeout: 30000 });
  const text = await page.textContent('#term-tools-out');
  assert.match(text, /git[\s\S]*\/git/);
  assert.match(text, /cargo/);
  assert.match(text, /login shell/);
  assert.ok(!/FACTORY_|PASSWORD|TOKEN/i.test(text));
});
