#!/usr/bin/env node
// Manual acceptance workflow for the embedded terminal, driven through the real UI with Playwright (real Chromium,
// real keyboard events, the real da-prompt repository as the project). Writes docs/terminal/screens/*.png and prints a
// markdown transcript with a PASS/FAIL line per step — a step is only PASS if its observable outcome was checked.
//   NODE_PATH=$(npm root -g) node docs/terminal/acceptance.mjs <repo-parent-dir> [path-to-a-dir-containing-pax]
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import http from 'node:http';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const parent = path.resolve(process.argv[2] || path.dirname(repoRoot));
const paxDir = process.argv[3] ? path.resolve(process.argv[3]) : '';
const shots = path.join(here, 'screens');
fs.mkdirSync(shots, { recursive: true });

// A clean environment, so the result does not depend on what this machine has exported.
for (const k of Object.keys(process.env)) if (/^(FACTORY_|DA_PROMPT_|ANTHROPIC_|OPENAI_|GITHUB_|GH_|HOST$|PORT$)/.test(k)) delete process.env[k];
process.env.FACTORY_DATA_DIR = fs.mkdtempSync('/tmp/da-term-acc-data-');
if (paxDir) process.env.PATH = `${paxDir}${path.delimiter}${process.env.PATH}`;

const { createServer } = await import(pathToFileURL(path.join(repoRoot, 'src', 'server.js')).href);
const { alive } = await import(pathToFileURL(path.join(repoRoot, 'src', 'terminal.js')).href);
const pw = await (async () => {
  for (const t of [() => import('playwright'), () => import(pathToFileURL(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright', 'index.mjs')).href)]) { try { return await t(); } catch { /* next */ } }
  throw new Error('Playwright is required for the UI acceptance run');
})();

// A stand-in "AI provider" the UI can show as ready and that we then stop (an Ollama-shaped HTTP server).
const llm = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(req.url.startsWith('/api/tags') ? JSON.stringify({ models: [{ name: 'demo-coder:7b', details: { parameter_size: '7B' } }] }) : req.url.startsWith('/api/show') ? JSON.stringify({ capabilities: ['completion', 'tools'], model_info: {} }) : '{}');
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
process.env.OLLAMA_HOST = `http://127.0.0.1:${llm.address().port}`;

const app = await createServer({ projectRoots: [parent], host: '127.0.0.1' });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const out = [];
const log = (s = '') => { out.push(s); console.log(s); };
const wait = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); } };
const buf = () => page.evaluate(() => { const t = window.__daTerminal?.().active?.term; if (!t) return ''; const b = t.buffer.active; const o = []; for (let i = 0; i < b.length; i++) o.push(b.getLine(i).translateToString(true)); return o.join('\n'); });
const has = async (re) => (re instanceof RegExp ? re : new RegExp(re.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).test(await buf());
const waitBuf = (re, ms) => wait(() => has(re), ms);
const state = () => page.evaluate(() => document.querySelector('#term-meta [data-state]')?.dataset.state || '');
const line = async (s) => { await page.keyboard.type(s); await page.keyboard.press('Enter'); };
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const apiGet = async (p) => (await fetch(base + p)).json();
let n = 0;
const step = async (title, fn) => {
  n += 1;
  log(`\n### ${n}. ${title}`);
  try {
    const note = await fn();
    log(`**PASS**${note ? ` — ${note}` : ''}`);
    return true;
  } catch (e) {
    log(`**FAIL** — ${e.message}\n\nlast screen lines:\n\`\`\`\n${(await buf().catch(() => '')).trim().split('\n').slice(-12).join('\n')}\n\`\`\``);
    return false;
  }
};
const results = [];
const running = (pattern) => { try { return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().length > 0; } catch { return false; } };

log(`# Terminal acceptance run\n\n- date: ${new Date().toISOString()}\n- host: ${process.platform}/${process.arch}, node ${process.version}, shell \`${process.env.SHELL || '(none; account shell)'}\`\n- repository under test: \`${repoRoot}\` (project root authorized: \`${parent}\`)`);

results.push(await step('Open the Terminal panel', async () => {
  await page.goto(`${base}/#/`);
  await page.click('a[href="#/terminal"]');
  await page.waitForSelector('#term-new');
  const warn = await page.textContent('.term-trust');
  if (!/not confined/.test(warn)) throw new Error('host-shell warning missing');
  await shot('01-terminal-panel');
  return 'sidebar link → #/terminal; the host-shell warning and project picker are shown';
}));

results.push(await step('Select the da-prompt repository and open a terminal in it', async () => {
  const opts = await page.$$eval('#term-project option', (o) => o.map((x) => [x.value, x.textContent]));
  const mine = opts.find(([, t]) => t.startsWith(path.basename(repoRoot)));
  if (!mine) throw new Error(`"${path.basename(repoRoot)}" is not in the picker: ${JSON.stringify(opts.map((o) => o[1]).slice(0, 8))}`);
  await page.selectOption('#term-project', mine[0]);
  await page.click('#term-new');
  await page.waitForSelector('.xterm-screen');
  await wait(async () => (await state()) === 'live');
  const cwd = await page.textContent('#term-cwd');
  if (cwd !== fs.realpathSync(repoRoot)) throw new Error(`cwd is ${cwd}`);
  return `header shows project "${path.basename(repoRoot)}" and cwd ${cwd}`;
}));

results.push(await step('Run `pwd` and `git status`', async () => {
  await line('pwd');
  await waitBuf(new RegExp(`\\n${fs.realpathSync(repoRoot).replace(/[/]/g, '\\/')}\\n`));
  await line('git status -sb | head -5');
  await waitBuf(/## claude\/[\w-]+/);
  await shot('02-pwd-git-status');
  return 'pwd printed the repository path; git status -sb printed the branch line';
}));

results.push(await step('Run the repository\'s actual test command (`npm test`, the full suite)', async () => {
  const t0 = Date.now();
  await line('npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped|cancelled)"; echo "NPM_TEST_EXIT=${PIPESTATUS[0]}"');
  await waitBuf(/\nNPM_TEST_EXIT=\d+/, 25 * 60_000);
  const text = await buf();
  const code = /\nNPM_TEST_EXIT=(\d+)/.exec(text)[1];
  const counts = [...text.matchAll(/\n# (tests|pass|fail|skipped|cancelled) (\d+)/g)].map((m) => `${m[1]} ${m[2]}`).join(', ');
  await shot('03-npm-test');
  if (code !== '0') throw new Error(`npm test exited ${code}: ${counts}`);
  return `exit 0 after ${Math.round((Date.now() - t0) / 1000)}s (${counts})`;
}));

results.push(await step('Inspect a Git diff', async () => {
  await line('clear; git diff HEAD~1 --stat | tail -4; git show --stat --format=%s -1 HEAD | head -4; git diff HEAD~1 -- src/security.js | head -12');
  await waitBuf(/files? changed/);
  await shot('04-git-diff');
  return 'diff --stat and a file diff were rendered in the terminal';
}));

results.push(await step('Run a real development command with an installed local tool (cargo, node, pax)', async () => {
  await line('clear; command -v cargo && cargo --version; node --version; node scripts/build.mjs 2>&1 | tail -3');
  await waitBuf(/cargo \d+\.\d+\.\d+/);
  await waitBuf(/build: ok/, 90000);
  let note = 'cargo, node and `node scripts/build.mjs` ran from the login shell';
  if (paxDir) {
    await line('command -v pax && pax --version');
    await waitBuf(/pax \d+\.\d+\.\d+/);
    note += '; the real `pax` binary is on the terminal\'s PATH and answered --version';
  }
  await shot('05-dev-tools');
  return note;
}));

results.push(await step('Interrupt a running process (Ctrl-C from the keyboard, then the Interrupt button)', async () => {
  await line('clear; sleep 300');
  await wait(() => running('^sleep 300$')); // interrupt only once the process really exists
  await page.keyboard.press('Control+C');
  await line('echo AFTER_CTRL_C=$?');
  await waitBuf(/\nAFTER_CTRL_C=130\n/);
  await line('yes > /dev/null');
  await wait(() => running('^yes$'));
  await page.click('#term-int');
  await line('echo AFTER_BUTTON=$?');
  await waitBuf(/\nAFTER_BUTTON=130\n/);
  await shot('06-interrupt');
  return '`sleep 300` stopped by Ctrl-C (exit 130); `yes` stopped by the Interrupt button (exit 130)';
}));

let loopShell;
results.push(await step('Refresh the browser and reconnect to a running session', async () => {
  await line('clear; echo SHELL_PID=$$; i=0; while true; do i=$((i+1)); echo tick-$i; sleep 1; done');
  await waitBuf(/\ntick-3\n/);
  loopShell = Number(/SHELL_PID=(\d+)/.exec(await buf())[1]);
  const sid = (await apiGet('/api/terminal')).sessions[0].id;
  await page.reload();
  await page.waitForSelector('.xterm-screen');
  await wait(async () => (await state()) === 'live');
  await waitBuf(/SHELL_PID=\d+/); // the earlier output was replayed
  const before = Number(/tick-(\d+)\n?$/m.exec((await buf()).trim().split('\n').filter((l) => /^tick-/.test(l)).at(-1))[1]);
  await wait(async () => { const ls = (await buf()).split('\n').filter((l) => /^tick-/.test(l)); return Number(ls.at(-1).split('-')[1]) > before; });
  const after = await apiGet('/api/terminal');
  if (after.sessions.length !== 1 || after.sessions[0].id !== sid) throw new Error('a different or an extra session appeared');
  if (!alive(loopShell)) throw new Error('the shell died');
  await shot('07-after-refresh');
  return `same session id, same shell pid ${loopShell}; the loop kept counting while the page was gone and continued after reattach`;
}));

results.push(await step('Close the session and verify its processes are cleaned up', async () => {
  await page.keyboard.press('Control+C');
  await line('clear; sleep 901 & echo BG1=$!; (sleep 902 & echo BG2=$!; wait) & sleep 1');
  await waitBuf(/BG2=\d+/);
  const t = await buf();
  const pids = [Number(/BG1=(\d+)/.exec(t)[1]), Number(/BG2=(\d+)/.exec(t)[1]), loopShell];
  if (!pids.every(alive)) throw new Error('expected processes were not running before close');
  await page.click('#term-close');
  await wait(async () => (await page.$$('.term-tab')).length === 0);
  await wait(() => pids.every((p) => !alive(p)), 12000);
  const list = await apiGet('/api/terminal');
  if (list.sessions.length !== 0) throw new Error('session still listed');
  const leftovers = execFileSync('sh', ['-c', 'ps -eo pid,cmd | grep -E "sleep 90[12]" | grep -v grep || true'], { encoding: 'utf8' }).trim();
  if (leftovers) throw new Error(`leftover processes: ${leftovers}`);
  await shot('08-closed');
  return `pids ${pids.join(', ')} were running before Close and are gone after; \`ps\` shows no \`sleep 901/902\`; the session list is empty`;
}));

results.push(await step('Stop the AI provider; the terminal still works', async () => {
  await page.goto(`${base}/#/providers`);
  await page.waitForSelector('text=Ollama');
  const readyBefore = (await apiGet('/api/providers')).providers.find((p) => p.id === 'ollama')?.status;
  if (readyBefore !== 'ready') throw new Error(`the stand-in provider was not ready before stopping it (${readyBefore})`);
  await shot('09-provider-ready');
  await new Promise((r) => { llm.closeAllConnections?.(); llm.close(r); });
  const down = await wait(async () => { const p = (await (await fetch(`${base}/api/providers?refresh=1`)).json()).providers.find((x) => x.id === 'ollama'); return p && p.status !== 'ready' ? p.status : null; }, 20000);
  await page.reload();
  await page.waitForTimeout(800);
  await shot('10-provider-stopped');
  await page.goto(`${base}/#/terminal`);
  await page.waitForSelector('#term-new');
  await page.click('#term-new');
  await page.waitForSelector('.xterm-screen');
  await wait(async () => (await state()) === 'live');
  await line('echo NO_AI_NEEDED; git log --oneline | head -2; ls src | head -5');
  await waitBuf(/\nNO_AI_NEEDED\n/);
  await shot('11-terminal-without-provider');
  return `provider status went ready → ${down}; a new terminal opened and ran git/ls normally`;
}));

results.push(await step('Check tools (login-shell PATH diagnostics)', async () => {
  await page.click('#term-tools');
  await page.waitForSelector('#term-tools-out table', { timeout: 30000 });
  const txt = await page.textContent('#term-tools-out');
  await shot('12-check-tools');
  const found = [...txt.matchAll(/(git|node|npm|python3|cargo|rustc|ollama|pax|make)(\/\S+|not found)/g)].length;
  return `table rendered (${found} tool rows)`;
}));

if (errors.length) log(`\nBrowser page errors: ${JSON.stringify(errors)}`);
const failed = results.filter((r) => !r).length;
log(`\n**${results.length - failed}/${results.length} steps passed**`);
fs.writeFileSync(path.join(here, 'acceptance-transcript.md'), `${out.join('\n')}\n`);
await page.close();
await browser.close();
await app.close().catch(() => {});
process.exit(failed ? 1 : 0);
