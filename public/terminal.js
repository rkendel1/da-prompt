// Terminal page: a VS Code-style integrated terminal on a real host PTY (xterm.js in the browser, /api/terminal on the server).
// Independent of runs, providers and agents: it only talks to /api/terminal and /api/projects/directories.
import { esc } from './providers.js';

const $ = (sel, root = document) => root.querySelector(sel);
const STORE = 'da-prompt.terminal.active'; // the id of the last session you looked at (an opaque capability, kept per tab)
let xtermLoad = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}
async function loadXterm() {
  xtermLoad ||= (async () => {
    if (!document.querySelector('link[data-xterm]')) {
      const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'vendor/xterm/xterm.css' });
      l.dataset.xterm = '1';
      document.head.append(l);
    }
    await loadScript('vendor/xterm/xterm.js');
    await loadScript('vendor/xterm/addon-fit.js');
  })();
  return xtermLoad;
}

const b64bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const safeGet = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch { /* storage unavailable */ } };

const STATE_TEXT = { starting: 'starting…', running: 'running', exited: 'exited', failed: 'failed to start', disconnected: 'disconnected', reconnecting: 'reconnecting…', closed: 'closed on the server' };

/** Mount the page. Returns a cleanup function that detaches every stream (the shells keep running on the server). */
export async function renderTerminalPage(main, api, { toast, project: wantProject = '' }) {
  main.innerHTML = `<section class="page terminal-page">
    <p class="eyebrow">developer terminal · host shell</p>
    <h1>Terminal</h1>
    <div id="term-root"><p class="muted">Checking the terminal…</p></div></section>`;
  const root = $('#term-root', main);
  const views = new Map(); // session id -> { id, info, term, fit, el, es, offset, conn, queue... }
  let active = null;
  let disposed = false;
  let info;
  let dirs = [];

  const call = (path, opts) => api(`api/terminal/${path}`, opts?.body ? { ...opts, body: JSON.stringify(opts.body) } : opts);

  try {
    info = await call('');
  } catch (e) {
    root.innerHTML = `<div class="card callout fail" role="alert"><h3>The terminal is not available here</h3><p>${esc(e.message)}</p>
      <p class="muted">Everything else in da-prompt works without it. The terminal needs a browser on the server machine, or an access password (Settings → Server).</p></div>`;
    return () => {};
  }
  if (!info.enabled || !info.pty) {
    root.innerHTML = `<div class="card callout fail" role="alert"><h3>The terminal can't start on this host</h3><p>${esc(info.reason || 'It is turned off in Settings → Server → Terminal.')}</p></div>`;
    return () => {};
  }
  let registered = [];
  try {
    dirs = (await api('api/projects/directories')).directories.filter((d) => !d.readOnly);
  } catch { /* the picker explains below */ }
  try {
    registered = (await api('api/projects')).projects.filter((p) => p.kind === 'local');
  } catch { /* the registry is optional for the terminal */ }
  try {
    await loadXterm();
  } catch (e) {
    root.innerHTML = `<div class="card callout fail" role="alert"><h3>The terminal emulator did not load</h3><p>${esc(e.message)}</p></div>`;
    return () => {};
  }

  root.innerHTML = `
    <div class="card callout warn term-trust" role="note"><strong>Host shell.</strong> Commands run as the user who started da-prompt, with that user's permissions. A terminal starts in a project folder but is <strong>not confined</strong> to it. <a href="#" id="term-policy-toggle">Details</a>
      <ul id="term-policy" hidden>${Object.values(info.policy).map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
    <div class="term-bar">
      <label class="field inline"><span class="sr-only">Project</span><select id="term-project" aria-label="Project for the new terminal"></select></label>
      <button class="btn accent" id="term-new">+ New terminal</button>
      <button class="btn" id="term-tools" title="Which developer tools does a login shell find?">Check tools</button>
      <span class="spacer"></span>
      <button class="btn" id="term-int" title="Send Ctrl-C to the foreground process" disabled>Interrupt</button>
      <button class="btn" id="term-clear" title="Clear the screen (the shell keeps its history)" disabled>Clear</button>
      <button class="btn danger" id="term-close" title="Close this terminal and end everything it started" disabled>Close</button>
    </div>
    <div class="term-tabs" id="term-tabs" role="tablist" aria-label="Terminal sessions"></div>
    <div class="term-meta" id="term-meta" aria-live="polite"></div>
    <div id="term-tools-out" class="card" hidden></div>
    <div class="term-stage" id="term-stage"></div>`;

  const sel = $('#term-project', root);
  const usableReg = registered.filter((p) => p.status === 'available' && !p.archived && !p.location.readOnly);
  sel.innerHTML = [
    usableReg.length || registered.length ? `<optgroup label="Projects">${registered.filter((p) => !p.archived).map((p) => `<option value="${esc(p.id)}" ${usableReg.includes(p) ? '' : 'disabled'}>${esc(p.name)}${p.status !== 'available' ? ` — ${esc(p.status)}` : p.location.readOnly ? ' — read-only' : ''}</option>`).join('')}</optgroup>` : '',
    dirs.length ? `<optgroup label="Other authorized folders">${dirs.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}${d.git?.isGit ? ` · ${esc(d.git.branch || 'detached')}` : ''} (not registered)</option>`).join('')}</optgroup>` : '',
  ].join('') || '<option value="">(no projects)</option>';
  if (wantProject && usableReg.some((p) => p.id === wantProject)) sel.value = wantProject;
  else if (usableReg.length) sel.value = usableReg[0].id;
  const canOpen = Boolean(usableReg.length || dirs.length);
  $('#term-new', root).disabled = !canOpen;
  if (!canOpen) $('#term-stage', root).innerHTML = '<div class="card empty-term"><h3>Register a project first</h3><p>A terminal starts inside a project you registered, never a path typed in the browser. Register a folder or repository under <a href="#/projects">Projects</a> (it needs a parent folder authorized in <a href="#/settings?group=folders">Settings → Folders</a>), then come back.</p></div>';
  $('#term-policy-toggle', root).addEventListener('click', (e) => {
    e.preventDefault();
    const ul = $('#term-policy', root);
    ul.hidden = !ul.hidden;
  });

  // ── one view per session: an xterm, an event stream and an input queue ───────────────────────────────
  function makeView(s) {
    const T = window.Terminal;
    const term = new T({ cursorBlink: true, scrollback: 5000, fontFamily: 'IBM Plex Mono, ui-monospace, Menlo, monospace', fontSize: 13, allowProposedApi: true, convertEol: false, theme: themeFor() });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    const el = document.createElement('div');
    el.className = 'term-host';
    el.dataset.session = s.id;
    el.hidden = true;
    $('#term-stage', root).append(el);
    term.open(el);
    const v = { id: s.id, info: s, term, fit, el, es: null, offset: 0, conn: 'connecting', pending: '', sending: false, resizeTimer: null };
    term.attachCustomKeyEventHandler((ev) => {
      // Copy: Cmd/Ctrl+C (or Ctrl+Shift+C) with a selection copies; without one, Ctrl+C reaches the shell as an interrupt.
      const copyKey = ev.type === 'keydown' && (ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'c' && (ev.metaKey || ev.shiftKey || term.hasSelection());
      if (copyKey && term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      return true;
    });
    term.onData((data) => queueInput(v, data));
    term.onResize(({ cols, rows }) => {
      clearTimeout(v.resizeTimer);
      v.resizeTimer = setTimeout(() => call(`sessions/${v.id}/resize`, { method: 'POST', body: { cols, rows } }).catch(() => {}), 120);
    });
    new ResizeObserver(() => { if (!el.hidden) try { fit.fit(); } catch { /* not laid out yet */ } }).observe(el);
    views.set(s.id, v);
    connect(v);
    return v;
  }

  function themeFor() {
    const cs = getComputedStyle(document.documentElement);
    const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
    return { background: dark ? '#0f0f0e' : '#1c1b19', foreground: '#edebe4', cursor: cs.getPropertyValue('--accent').trim() || '#e5533c', selectionBackground: '#4a6fa5aa' };
  }

  // Input is sent in order, batched while a request is in flight; nothing is ever interpreted client-side.
  async function queueInput(v, data) {
    if (v.info.state !== 'running') return;
    v.pending += data;
    if (v.sending) return;
    v.sending = true;
    try {
      while (v.pending) {
        const chunk = v.pending.slice(0, 16000);
        v.pending = v.pending.slice(chunk.length);
        await call(`sessions/${v.id}/input`, { method: 'POST', body: { data: chunk } });
      }
    } catch (e) {
      v.pending = '';
      setConn(v, 'disconnected');
      toast(`Input was not delivered: ${e.message}`);
    } finally {
      v.sending = false;
    }
  }

  function connect(v) {
    v.es?.close();
    setConn(v, v.offset ? 'reconnecting' : 'connecting');
    const es = new EventSource(`api/terminal/sessions/${v.id}/stream?after=${v.offset}`);
    v.es = es;
    es.addEventListener('data', (e) => {
      const m = JSON.parse(e.data);
      if (m.off < v.offset) return; // replayed bytes we already drew
      v.offset = m.off + 0; // set below once decoded
      const bytes = b64bytes(m.b64);
      v.offset = m.off + bytes.length;
      v.term.write(bytes);
      if (v.conn !== 'live') setConn(v, 'live');
    });
    es.addEventListener('truncated', (e) => {
      const m = JSON.parse(e.data);
      v.term.write(`\r\n\x1b[33m[da-prompt: ${m.dropped} bytes of earlier output were dropped to bound memory]\x1b[0m\r\n`);
    });
    es.addEventListener('state', (e) => {
      v.info = JSON.parse(e.data);
      if (v.conn !== 'live' && v.info.state === 'running') setConn(v, 'live');
      if (v.info.state === 'exited') v.term.write(`\r\n\x1b[2m[process exited${v.info.exitCode != null ? ` with code ${v.info.exitCode}` : ''}${v.info.signal ? ` (signal ${v.info.signal})` : ''}]\x1b[0m\r\n`);
      paint();
    });
    es.onerror = async () => {
      if (disposed) return;
      if (es.readyState === EventSource.CONNECTING) return setConn(v, 'reconnecting'); // the browser retries from the last event id
      // The stream was refused or ended: find out why.
      es.close();
      try {
        const { session } = await call(`sessions/${v.id}`);
        v.info = session;
        setConn(v, session.state === 'running' ? 'disconnected' : 'live');
      } catch (err) {
        v.info = { ...v.info, state: 'closed' };
        setConn(v, 'closed', /not found/.test(err.message) ? 'The server restarted or the terminal sat unused for a long time, which closes its shell and any job running in it. The output above is what was on screen; press “New terminal” to start again.' : err.message);
      }
    };
  }

  function setConn(v, conn, note) {
    v.conn = conn;
    v.note = note;
    paint();
  }

  // ── chrome: tabs, meta line, buttons ──────────────────────────────────────────────────────────────────
  function paint() {
    if (disposed) return;
    const tabs = $('#term-tabs', root);
    tabs.innerHTML = [...views.values()].map((v) => `<button role="tab" class="term-tab ${v === active ? 'on' : ''}" data-id="${esc(v.id)}" aria-selected="${v === active}" title="${esc(v.info.cwd || '')}">
        <span class="tdot ${esc(dotClass(v))}" aria-hidden="true"></span>${esc(v.info.label || 'terminal')}</button>`).join('');
    const v = active;
    for (const b of ['#term-int', '#term-clear', '#term-close']) $(b, root).disabled = !v;
    $('#term-int', root).disabled = !v || v.info.state !== 'running';
    const meta = $('#term-meta', root);
    if (!v) { meta.innerHTML = ''; return; }
    const i = v.info;
    const stateTxt = v.conn === 'live' || i.state !== 'running' ? STATE_TEXT[i.state] || i.state : STATE_TEXT[v.conn];
    const exit = i.state === 'exited' ? ` · exit ${i.exitCode ?? '—'}${i.signal ? ` (signal ${i.signal})` : ''}` : '';
    meta.innerHTML = `<span class="tstate ${esc(dotClass(v))}" data-state="${esc(i.state === 'running' ? v.conn : i.state)}">${esc(stateTxt)}${esc(exit)}</span>
      <span class="tcwd" title="Current directory of the shell"><span class="muted">cwd</span> <code id="term-cwd">${esc(i.cwd || '—')}</code></span>
      <span class="tproj"><span class="muted">project</span> ${i.project?.projectId ? `<a href="#/projects/${esc(i.project.projectId)}">${esc(i.project.name)}</a>` : esc(i.project?.name || '—')}</span>
      ${i.insideProject === false ? '<span class="pill warn" title="The shell is outside the folder it was started in. Terminals are not confined to the project.">outside project</span>' : ''}
      <span class="muted">${esc(i.shell || '')} · ${i.cols}×${i.rows}</span>
      ${v.conn === 'disconnected' ? '<button class="btn" id="term-reconnect">Reconnect</button>' : ''}
      ${v.conn === 'closed' ? `<span class="muted">${esc(v.note || 'This terminal no longer exists.')}</span>` : ''}`;
    $('#term-reconnect', root)?.addEventListener('click', () => connect(v));
  }
  const dotClass = (v) => (v.info.state === 'running' ? (v.conn === 'live' ? 'ok' : v.conn === 'disconnected' || v.conn === 'closed' ? 'bad' : 'warn') : v.info.state === 'exited' ? 'idle' : 'bad');

  function select(v) {
    for (const o of views.values()) o.el.hidden = o !== v;
    active = v;
    safeSet(STORE, v?.id || '');
    paint();
    if (v) requestAnimationFrame(() => { try { v.fit.fit(); } catch { /* ignore */ } v.term.focus(); });
  }

  async function open(directoryId) {
    const btn = $('#term-new', root);
    btn.disabled = true;
    try {
      const target = String(directoryId).startsWith('prj_') ? { projectId: directoryId } : { directoryId };
      const { session } = await call('sessions', { method: 'POST', body: { ...target, cols: 100, rows: 30 } });
      const v = makeView(session);
      select(v);
    } catch (e) {
      toast(`Could not open a terminal: ${e.message}`);
      showError(e.message);
    } finally {
      btn.disabled = !(usableReg.length || dirs.length);
    }
  }
  function showError(msg) {
    const out = $('#term-tools-out', root);
    out.hidden = false;
    out.className = 'card callout fail';
    out.setAttribute('role', 'alert');
    out.innerHTML = `<h3>The terminal could not start</h3><p>${esc(msg)}</p>`;
  }

  $('#term-new', root).addEventListener('click', () => open(sel.value));
  $('#term-tabs', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b && views.get(b.dataset.id)) select(views.get(b.dataset.id));
  });
  $('#term-int', root).addEventListener('click', () => active && call(`sessions/${active.id}/signal`, { method: 'POST', body: { signal: 'INT' } }).catch((e) => toast(e.message)).finally(() => active?.term.focus()));
  $('#term-clear', root).addEventListener('click', () => { active?.term.clear(); active?.term.focus(); });
  $('#term-close', root).addEventListener('click', async () => {
    const v = active;
    if (!v) return;
    try {
      await call(`sessions/${v.id}`, { method: 'DELETE' });
    } catch (e) {
      if (!/not found/.test(e.message)) return toast(`Could not close the terminal: ${e.message}`);
    }
    v.es?.close();
    v.term.dispose();
    v.el.remove();
    views.delete(v.id);
    select([...views.values()].at(-1) || null);
  });
  $('#term-tools', root).addEventListener('click', async () => {
    const out = $('#term-tools-out', root);
    out.hidden = false;
    out.className = 'card';
    out.removeAttribute('role');
    out.innerHTML = '<p class="muted">Asking a login shell (this can take a few seconds)…</p>';
    try {
      const d = await call('diagnostics');
      out.innerHTML = `<h3>Developer tools a new terminal finds</h3>
        <p class="muted">${esc(d.startup)}</p>
        <table class="mini"><tbody>${d.tools.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td>${t.path ? `<code>${esc(t.path)}</code>` : '<span class="muted">not found on this PATH</span>'}</td></tr>`).join('')}</tbody></table>
        ${d.onlyInLoginShell.length ? `<p class="muted">Folders only a login shell adds to PATH (da-prompt's own process doesn't see them): ${d.onlyInLoginShell.map((p) => `<code>${esc(p)}</code>`).join(' ')}</p>` : ''}
        ${d.tools.some((t) => !t.path) ? '<p class="muted">A tool marked "not found" is not installed for this user, or is added to PATH by a file the login shell does not read (put it in ~/.zprofile, or ~/.zshrc for interactive use). da-prompt never edits those files.</p>' : ''}`;
    } catch (e) {
      out.innerHTML = `<p>${esc(e.message)}</p>`;
    }
  });
  window.addEventListener('resize', onWindowResize);
  function onWindowResize() { if (active) try { active.fit.fit(); } catch { /* ignore */ } }

  // Reattach to terminals that survived a refresh or a visit to another page.
  const existing = info.sessions || [];
  for (const s of existing) makeView(s);
  const prefer = safeGet(STORE);
  select(views.get(prefer) || [...views.values()].find((v) => v.info.state === 'running') || [...views.values()].at(-1) || null);
  // Arrived from a project ("Open terminal"): reuse its running terminal or open a new one in it.
  if (wantProject && usableReg.some((p) => p.id === wantProject)) {
    const have = [...views.values()].find((v) => v.info.project?.projectId === wantProject && v.info.state === 'running');
    if (have) select(have);
    else await open(wantProject);
  }
  if (!views.size && (dirs.length || registered.length)) {
    const hint = $('#term-meta', root);
    hint.innerHTML = '<span class="muted">No terminals yet — pick a project and press “+ New terminal”.</span>';
  }

  // Test/debug hook: the active xterm instance (read-only use).
  window.__daTerminal = () => ({ active: active && { id: active.id, term: active.term, conn: active.conn, info: active.info }, views });

  return () => {
    disposed = true;
    window.removeEventListener('resize', onWindowResize);
    for (const v of views.values()) {
      v.es?.close(); // detach only: the shell keeps running on the server and can be reattached
      v.term.dispose();
    }
    views.clear();
    delete window.__daTerminal;
  };
}
