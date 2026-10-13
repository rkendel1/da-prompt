// Chat, optionally about one project. Advisory only: it never runs commands, edits files or publishes. Everything here is rendered from
// the backend's persisted conversation; the browser keeps no authoritative history. Model output is untrusted text.
import { esc, loadProviders } from './providers.js';
import { renderMarkdown } from './markdown.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(iso).toLocaleDateString();
};
const post = (body) => ({ method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = (body) => ({ method: 'PATCH', body: JSON.stringify(body) });

/** Copy text. Returns true on success; on failure the caller must say so (no silent "copied"). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** Copy with honest feedback; when the clipboard is unavailable show the text selected in a dialog. */
export async function copyWithFeedback(text, toast, what = 'Copied') {
  if (await copyText(text)) { toast(`${what} to the clipboard`); return true; }
  const dlg = document.createElement('dialog');
  dlg.className = 'copy-fallback';
  dlg.innerHTML = '<form method="dialog"><p><strong>Could not copy automatically.</strong> Your browser blocked clipboard access. The text is selected below: press Ctrl/Cmd+C.</p><textarea readonly rows="8" aria-label="Text to copy"></textarea><div class="actions"><button class="btn">Close</button></div></form>';
  $('textarea', dlg).value = text;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  $('textarea', dlg).select();
  return false;
}

/** Split text into prose and fenced code blocks. Never interprets anything as HTML or as a command. */
export function parseBlocks(text) {
  const out = [];
  const re = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)(```|$)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push({ type: 'code', lang: m[1], text: m[2].replace(/\n$/, '') });
    last = re.lastIndex;
    if (m[3] === '') break;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

const typing = '<div class="typing" role="status" aria-label="The assistant is writing"><i></i><i></i><i></i></div>';
const renderBody = (text, streaming = false) => {
  const html = parseBlocks(text).map((b) => (b.type === 'code'
    ? `<div class="code-block"><div class="code-head"><span class="mono">${esc(b.lang || 'code')}</span><button type="button" class="btn small" data-copy-code aria-label="Copy this code block">Copy code</button></div><pre><code>${esc(b.text)}</code></pre></div>`
    : `<div class="prose">${renderMarkdown(b.text.replace(/^\n+|\n+$/g, ''))}</div>`)).join('');
  return streaming ? `${html}<span class="caret" aria-hidden="true"></span>` : html;
};

const KIND = { readme: 'doc', doc: 'doc', file: 'file', listing: 'file list', files: 'file list', git: 'git', tasks: 'tasks', runs: 'runs', meta: 'project record', metadata: 'project record', project: 'project record', note: 'pinned note' };
const fmtBytes = (n) => (n == null ? 'per message' : n === 0 ? '—' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);
const PREF_SEL = 'da-prompt:chat-selection';
const readSel = () => { try { return JSON.parse(localStorage.getItem(PREF_SEL) || 'null') || {}; } catch { return {}; } };
const writeSel = (v) => { try { localStorage.setItem(PREF_SEL, JSON.stringify(v)); } catch { /* storage unavailable */ } };

function contextBlock(m) {
  if (m.role !== 'assistant' || !m.context) return '';
  const c = m.context;
  const items = c.items || [];
  const lim = c.limitations || [];
  const notes = items.filter((i) => i.kind === 'note');
  const project = items.filter((i) => i.kind !== 'note');
  if (!items.length && !lim.length && m.projectless) return '';
  const head = project.length ? `Retrieved from the project: ${project.length} item${project.length === 1 ? '' : 's'}` : notes.length ? 'No project files were sent' : 'Nothing was retrieved from the project';
  return `<details class="ctx"><summary>${head}${notes.length ? ` · ${notes.length} pinned note${notes.length === 1 ? '' : 's'}` : ''}${c.history && !c.history.sent ? ' · earlier messages not sent' : ''}${lim.length ? ` · ${lim.length} limitation${lim.length === 1 ? '' : 's'}` : ''}</summary>
    ${items.length ? `<ul class="ctx-items">${items.map((i) => `<li><span class="pill skipped">${esc(KIND[i.kind] || i.kind)}</span> <span class="mono">${esc(i.label)}</span>${i.truncated ? ' <em>(truncated)</em>' : ''}</li>`).join('')}</ul>` : ''}
    ${lim.length ? `<ul class="ctx-lim">${lim.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    <p class="muted">Anything in the answer that is not in the list above comes from the model's own knowledge or inference — verify it before acting on it.</p></details>`;
}

const SUGGEST_GENERAL = ['Help me plan a new feature', 'Explain a design trade-off I am weighing', 'Draft acceptance criteria for an idea'];
const SUGGEST_PROJECT = ['What does this project do, and what is its current state?', 'What is missing or risky here?', 'Suggest the next three tasks for the backlog'];

/** Mount chat. `id` empty → a new chat (nothing is created until you send). */
export async function renderChatPage(main, api, { toast, id = '', project = '' }) {
  let alive = true;
  let es = null;
  const disposers = [];
  const cleanup = () => { alive = false; es?.close(); disposers.forEach((d) => d()); };
  document.title = 'Chat · da-prompt';
  main.innerHTML = '<section class="page chat-page chat-app"><p class="muted">Loading…</p></section>';
  try {
    await shell();
  } catch (e) {
    main.innerHTML = `<section class="page chat-page"><h1>Chat</h1><div class="card callout fail" role="alert">${esc(e.message)}</div><p><a href="#/chat">Back to chats</a></p></section>`;
  }
  return cleanup;

  async function shell() {
    const [projRes, provs, listRes, catalog, first] = await Promise.all([
      api('api/projects?archived=false').catch(() => ({ projects: [] })),
      loadProviders(api).catch(() => null),
      api('api/chat/conversations').catch(() => ({ conversations: [] })),
      api('api/chat/sources').catch(() => ({ sources: [] })),
      id ? api(`api/chat/conversations/${encodeURIComponent(id)}`) : Promise.resolve(null),
    ]);
    const projects = projRes.projects.filter((p) => !p.archived);
    let convos = listRes.conversations;
    let convo = first?.conversation || null;
    const thread = Boolean(convo);
    const pref = readSel();
    const dflt = provs ? defaultSel(provs) : {};
    const usable = (pid) => (provs?.providers || []).some((p) => p.id === pid && p.status === 'ready' && p.enabled);
    // A new chat (not created yet): its choices live here until the first message.
    const draft = {
      projectId: project && projects.some((p) => p.id === project) ? project : '',
      provider: usable(pref.provider) ? pref.provider : dflt.provider || '',
      model: usable(pref.provider) ? pref.model : dflt.model || '',
      context: { sources: {}, notes: [] },
    };
    const live = new Map();
    const picked = new Set();
    const seen = new Set(); // messages already shown once: only new ones animate in
    let pv = null; // last context preview

    if (thread) document.title = `${convo.title} · Chat · da-prompt`;
    main.innerHTML = `<section class="page chat-page chat-app" id="chat-app">
      <aside class="chat-side" id="chat-side" aria-label="Chats">
        <a class="btn accent new-chat" href="#/chat">+ New chat</a>
        <input type="search" id="chat-search" placeholder="Search chats" aria-label="Search chats" autocomplete="off">
        <nav id="chat-convos" aria-label="Conversations"></nav>
      </aside>
      <div class="chat-main">
        <header class="chat-top">
          <button type="button" class="btn small side-toggle" id="side-toggle" aria-expanded="false" aria-controls="chat-side">Chats</button>
          <h1 id="chat-title" tabindex="-1">${thread ? esc(convo.title) : 'New chat'}</h1>
          <div id="chat-project-bar" class="chat-project"></div>
          <span class="spacer"></span>
          <div class="chat-actions" role="toolbar" aria-label="Conversation actions">
            <span id="pick-actions" hidden><button class="btn small" id="copy-picked" type="button" disabled>Copy selected (0)</button> <button class="btn small" id="task-picked" type="button" disabled>Task from selected (0)</button></span>
            <button class="btn small" id="copy-all" type="button" ${thread ? '' : 'hidden'}>Copy conversation</button>
            <button class="btn small" id="task-all" type="button" ${thread ? '' : 'hidden'}>Create task</button>
          </div>
        </header>
        <div id="chat-banner"></div>
        <div class="chat-scroll" id="chat-log" role="log" aria-live="polite" aria-label="Conversation"></div>
        <button type="button" class="jump" id="jump" hidden aria-label="Scroll to the latest message">↓</button>
        <div id="sel-bar" class="sel-bar" hidden><span>Selection:</span> <button class="btn small" id="sel-copy" type="button">Copy</button> <button class="btn small" id="sel-task" type="button">Create task</button></div>
        <form id="chat-form" class="composer" autocomplete="off">
          <label class="sr-only" for="chat-input">Message</label>
          <textarea id="chat-input" rows="1" maxlength="32000" placeholder="Message da-prompt…" aria-describedby="chat-hint"></textarea>
          <div class="composer-bar">
            <div class="chips">
              <span id="chat-project-slot"></span>
              <label class="chip-select" title="Provider"><span class="sr-only">Provider</span><select id="chat-provider" aria-label="Provider"></select></label>
              <label class="chip-select" title="Model"><span class="sr-only">Model</span><span id="chat-model-slot"></span></label>
              <button type="button" class="chip-btn" id="ctx-btn" aria-haspopup="dialog" aria-expanded="false">Context <b id="ctx-count">0</b></button>
            </div>
            <span class="muted hint" id="chat-hint"></span>
            <button class="icon-btn stop" type="button" id="chat-stop" hidden aria-label="Stop generating" title="Stop generating"><span></span></button>
            <button class="icon-btn send" type="submit" id="chat-send" aria-label="Send" title="Send (Enter)" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          </div>
          <div class="ctx-panel" id="ctx-panel" role="dialog" aria-label="Context sent to the model" hidden></div>
        </form>
      </div></section>`;

    const sel = () => (thread ? { provider: convo.provider, model: convo.model, providerLabel: convo.providerLabel } : { provider: draft.provider, model: draft.model });
    const ctxOf = () => (thread ? convo.context : draft.context) || { sources: {}, notes: [] };
    const hasProject = () => (thread ? Boolean(convo.projectId) : Boolean(draft.projectId));
    const unavailable = () => thread && (convo.projectRemoved || convo.project?.archived || (convo.project && convo.project.status !== 'available'));
    const generating = () => thread && (convo.generating || convo.messages.some((m) => m.status === 'streaming'));

    // ── conversation list (left) ────────────────────────────────────────────────────────────
    const drawList = () => {
      const q = $('#chat-search').value.trim().toLowerCase();
      const rows = convos.filter((c) => !q || `${c.title} ${c.projectName || ''} ${c.preview}`.toLowerCase().includes(q));
      $('#chat-convos').innerHTML = rows.length
        ? rows.map((c) => `<a class="convo ${thread && c.id === convo.id ? 'current' : ''}" href="#/chat/${esc(c.id)}" ${thread && c.id === convo.id ? 'aria-current="page"' : ''}><span class="convo-title">${esc(c.title)}</span><span class="convo-meta">${esc(c.projectName || 'No project')} · ${esc(ago(c.updatedAt))}</span></a>`).join('')
        : `<p class="muted convo-empty">${q ? 'No chats match.' : 'No chats yet.'}</p>`;
    };
    const reloadList = async () => { try { convos = (await api('api/chat/conversations')).conversations; drawList(); } catch { /* keep */ } };
    $('#chat-search').addEventListener('input', drawList);
    $('#side-toggle').addEventListener('click', () => { const open = $('#chat-app').classList.toggle('side-open'); $('#side-toggle').setAttribute('aria-expanded', String(open)); });
    drawList();

    // ── header ─────────────────────────────────────────────────────────────────────────────
    const drawHead = () => {
      if (!thread) { $('#chat-project-bar').innerHTML = ''; return; }
      const p = convo.project;
      $('#chat-project-bar').innerHTML = convo.projectless
        ? '<span class="pill skipped" title="This chat has no project; it never reads your files">No project</span>'
        : p
          ? `<span class="pill ${p.status === 'available' && !p.archived ? 'completed' : 'needs_attention'}" title="This conversation is bound to this project and never moves">${esc(p.name)}${p.product ? ` · ${esc(p.product)}` : ''}</span> <a class="muted" href="#/projects/${esc(p.id)}">project</a> <a class="muted" href="#/chat?project=${esc(p.id)}">new conversation</a>`
          : `<span class="pill failed">${esc(convo.projectName)} · removed</span>`;
      $('#chat-banner').innerHTML = unavailable()
        ? `<div class="card callout fail" role="status"><strong>${convo.projectRemoved ? 'This project is no longer registered.' : convo.project.archived ? 'This project is archived.' : `This project is ${esc(convo.project.status)}.`}</strong> The history below is kept. New answers cannot use the project's files, so anything they say about the code is the model's inference. ${convo.project && !convo.project.archived ? `<a href="#/projects/${esc(convo.project.id)}">Open the project to fix it</a>` : ''} To talk about another project, <a href="#/chat">start a new chat</a> — this one is never moved.</div>` : '';
      $('#chat-title').textContent = convo.title;
    };

    // ── messages ───────────────────────────────────────────────────────────────────────────
    const drawMessage = (m) => {
      const text = live.has(m.id) ? live.get(m.id) : m.content;
      const streaming = m.status === 'streaming';
      const mine = m.role === 'user';
      const who = mine ? 'You' : `${esc(m.providerLabel || m.provider)} · ${esc(m.model)}`;
      const state = streaming ? '<span class="pill running">writing…</span>' : m.status === 'error' ? '<span class="pill failed">failed</span>' : m.status === 'cancelled' ? '<span class="pill skipped">stopped</span>' : '';
      const fresh = !seen.has(m.id);
      seen.add(m.id);
      return `<article class="msg ${m.role} ${esc(m.status)} ${fresh ? 'enter' : ''}" data-id="${esc(m.id)}" data-role="${esc(m.role)}" aria-label="${mine ? 'Your message' : 'Assistant response'}">
        ${mine ? '' : '<div class="avatar" aria-hidden="true">dp</div>'}
        <div class="msg-col">
          <header><label class="pick"><input type="checkbox" class="pick-box" ${picked.has(m.id) ? 'checked' : ''} aria-label="Select this message"></label><strong>${who}</strong> ${state} <span class="muted">${esc(ago(m.createdAt))}${m.attempts > 1 ? ` · attempt ${esc(m.attempts)}` : ''}</span></header>
          <div class="msg-body">${text ? renderBody(text, streaming) : streaming ? typing : '<p class="muted">(no text)</p>'}</div>
          ${m.error ? `<div class="msg-error" role="alert">${esc(m.error)} </div>` : ''}
          ${contextBlock({ ...m, projectless: !hasProject() })}
          <footer>
            ${text ? '<button type="button" class="btn small ghost" data-act="copy">Copy response</button>' : ''}
            ${m.role === 'assistant' && !streaming && text ? '<button type="button" class="btn small ghost" data-act="task">Create task</button>' : ''}
            ${mine ? '<button type="button" class="btn small ghost" data-act="task">Create task</button>' : ''}
            ${['error', 'cancelled'].includes(m.status) && m.id === convo.messages.at(-1)?.id ? '<button type="button" class="btn small accent" data-act="retry">Retry</button>' : ''}
          </footer>
        </div></article>`;
    };
    const greeting = () => {
      const p = thread ? convo.project : projects.find((x) => x.id === draft.projectId);
      const ideas = p ? SUGGEST_PROJECT : SUGGEST_GENERAL;
      return `<div class="hello"><div class="hello-mark" aria-hidden="true">dp</div>
        <h2>${p ? `What would you like to know about ${esc(p.name)}?` : 'How can I help?'}</h2>
        <p class="muted">${p ? 'The assistant can see what you choose under Context — the project’s docs, files you mention, tasks and git status. It never runs anything.' : 'A general chat with no project attached, so nothing from your files is shared. Pick a project below any time you start a new chat.'}</p>
        <div class="suggest">${ideas.map((t) => `<button type="button" class="chip" data-suggest="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>`;
    };
    const nearBottom = () => { const l = $('#chat-log'); return l.scrollHeight - l.scrollTop - l.clientHeight < 90; };
    const toBottom = (smooth = false) => { const l = $('#chat-log'); l.scrollTo({ top: l.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); };
    const drawLog = () => {
      const log = $('#chat-log');
      const stick = nearBottom() || !log.dataset.drawn;
      log.dataset.drawn = '1';
      log.innerHTML = thread && convo.messages.length ? `<div class="chat-col">${convo.messages.map(drawMessage).join('')}</div>` : greeting();
      if (stick) toBottom();
      const n = picked.size;
      $('#pick-actions').hidden = !n;
      $('#copy-picked').disabled = $('#task-picked').disabled = !n;
      $('#copy-picked').textContent = `Copy selected (${n})`;
      $('#task-picked').textContent = `Task from selected (${n})`;
      syncComposer();
    };
    const syncComposer = () => {
      const gen = generating();
      const empty = !$('#chat-input').value.trim();
      $('#chat-send').disabled = gen || empty;
      $('#chat-send').hidden = gen;
      $('#chat-stop').hidden = !gen;
      $('#chat-input').disabled = false;
      const s = sel();
      $('#chat-hint').textContent = gen ? 'Writing…' : s.provider ? '' : 'Choose a provider';
    };

    // ── composer: provider / model / project chips ─────────────────────────────────────────
    const drawChips = () => {
      const ready = (provs?.providers || []).filter((p) => p.status === 'ready' && p.enabled);
      const s = sel();
      const cur = ready.find((p) => p.id === s.provider);
      $('#chat-provider').innerHTML = `${cur || !s.provider ? '' : `<option value="${esc(s.provider)}" selected>${esc(s.providerLabel || s.provider)} (unavailable)</option>`}${ready.map((p) => `<option value="${esc(p.id)}" ${p.id === s.provider ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}`;
      const models = cur?.models || [];
      $('#chat-model-slot').innerHTML = models.length
        ? `<select id="chat-model" aria-label="Model">${models.some((m) => m.id === s.model) ? '' : `<option selected value="${esc(s.model)}">${esc(s.model)}</option>`}${models.map((m) => `<option value="${esc(m.id)}" ${m.id === s.model ? 'selected' : ''}>${esc(m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id)}</option>`).join('')}</select>`
        : `<input id="chat-model" class="chip-input" aria-label="Model" value="${esc(s.model || '')}" maxlength="200" placeholder="model">`;
      $('#chat-project-slot').innerHTML = thread ? '' : `<label class="chip-select" title="Attach a project (optional)"><span class="sr-only">Project</span><select id="chat-project" aria-label="Project">
        <option value="">No project</option>${projects.map((p) => `<option value="${esc(p.id)}" ${p.id === draft.projectId ? 'selected' : ''}>${esc(p.name)}${p.product ? ` · ${esc(p.product)}` : ''}${p.status !== 'available' ? ` (${esc(p.status)})` : ''}</option>`).join('')}</select></label>`;
      drawCtxCount();
    };
    const savePick = async (body) => {
      if (!thread) {
        if (body.provider !== undefined) { draft.provider = body.provider; draft.model = ''; const p = provs.providers.find((x) => x.id === body.provider); draft.model = p?.defaultModel || p?.models?.[0]?.id || ''; }
        if (body.model !== undefined) draft.model = body.model;
        writeSel({ provider: draft.provider, model: draft.model });
        drawChips();
        return;
      }
      try {
        convo = (await api(`api/chat/conversations/${encodeURIComponent(convo.id)}`, patch(body))).conversation;
        toast('Applies to your next message; earlier responses keep their model');
      } catch (e) { toast(e.message); }
      drawChips(); drawLog();
    };
    $('#chat-provider').addEventListener('change', (e) => savePick({ provider: e.target.value }));
    $('#chat-model-slot').addEventListener('change', (e) => { if (e.target.id === 'chat-model') savePick({ model: e.target.value.trim() }); });
    $('#chat-project-slot').addEventListener('change', (e) => { if (e.target.id === 'chat-project') { draft.projectId = e.target.value; drawLog(); drawCtxCount(); if (!$('#ctx-panel').hidden) openCtx(); } });

    // ── context panel: what is sent to the model, switchable ──────────────────────────────
    const relevantSources = () => (catalog.sources || []).filter((x) => !x.project || hasProject());
    function drawCtxCount() {
      const c = ctxOf();
      const n = relevantSources().filter((x) => c.sources?.[x.key] !== false).length + (c.notes || []).filter((x) => x.enabled).length;
      $('#ctx-count').textContent = String(n);
    }
    async function loadPreview() {
      if (thread) { try { pv = (await api(`api/chat/conversations/${encodeURIComponent(convo.id)}/context`)).context; return; } catch { /* fall back */ } }
      const c = ctxOf();
      pv = { projectless: !hasProject(), sources: relevantSources().map((x) => ({ ...x, enabled: c.sources?.[x.key] !== false, bytes: null, items: [] })), notes: c.notes || [], limitations: [] };
    }
    const total = () => {
      const on = (pv?.sources || []).filter((x) => x.enabled && typeof x.bytes === 'number' && x.key !== 'history');
      const bytes = on.reduce((n, x) => n + x.bytes, 0) + (pv?.notes || []).filter((x) => x.enabled).reduce((n, x) => n + x.text.length, 0);
      return bytes;
    };
    function drawCtx(editing = '') {
      const panel = $('#ctx-panel');
      const noteEdit = (pv.notes || []).find((n) => n.id === editing);
      const bytes = total();
      panel.innerHTML = `<header><div><strong>Context</strong><span class="muted"> · choose what is sent with your next message</span></div><button type="button" class="btn small ghost" data-ctx-close aria-label="Close">✕</button></header>
        <ul class="ctx-list">${pv.sources.map((x) => `<li><label><input type="checkbox" data-src="${esc(x.key)}" ${x.enabled ? 'checked' : ''}><span class="ctx-name">${esc(x.label)}<small>${esc(x.help)}${x.items?.length ? ` · ${esc(x.items.slice(0, 3).join(', '))}${x.items.length > 3 ? '…' : ''}` : ''}</small></span></label><span class="ctx-size">${x.key === 'history' ? `${fmtBytes(x.bytes)}` : fmtBytes(x.bytes)}</span></li>`).join('')}</ul>
        ${pv.projectless ? '<p class="hint">This chat has no project. Start a new chat and pick a project to also share its docs, files, tasks and git status.</p>' : ''}
        ${(pv.limitations || []).length ? `<ul class="ctx-lim">${pv.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
        <h4>Pinned notes <small class="muted">kept in this chat, sent while ticked</small></h4>
        <ul class="ctx-list notes">${(pv.notes || []).map((n) => `<li><label><input type="checkbox" data-note-toggle="${esc(n.id)}" ${n.enabled ? 'checked' : ''}><span class="ctx-name">${esc(n.title)}<small>${esc(n.text.slice(0, 90))}${n.text.length > 90 ? '…' : ''}</small></span></label><span class="ctx-actions"><button type="button" class="btn small ghost" data-note-edit="${esc(n.id)}">Edit</button><button type="button" class="btn small ghost" data-note-del="${esc(n.id)}" aria-label="Remove note ${esc(n.title)}">✕</button></span></li>`).join('') || '<li class="muted">No notes yet.</li>'}</ul>
        <div class="note-form" data-editing="${esc(editing)}"><input id="note-title" placeholder="Title (optional)" maxlength="80" value="${esc(noteEdit?.title || '')}" aria-label="Note title"><textarea id="note-text" rows="3" maxlength="8000" placeholder="Background to share with the model, e.g. “We target Node 20; prefer small modules.”" aria-label="Note text">${esc(noteEdit?.text || '')}</textarea>
          <div class="actions"><span class="muted" id="note-err" role="alert"></span>${noteEdit ? '<button type="button" class="btn small" data-note-cancel>Cancel</button>' : ''}<button type="button" class="btn small accent" data-note-save>${noteEdit ? 'Save note' : 'Pin note'}</button></div></div>
        <footer><span>${bytes ? `≈ ${fmtBytes(bytes)} (~${Math.ceil(bytes / 4).toLocaleString()} tokens) of context plus files you mention` : 'Only your messages and files you mention will be sent'}</span></footer>`;
    }
    async function openCtx(editing = '') {
      await loadPreview();
      drawCtx(editing);
      $('#ctx-panel').hidden = false;
      $('#ctx-btn').setAttribute('aria-expanded', 'true');
    }
    const closeCtx = () => { $('#ctx-panel').hidden = true; $('#ctx-btn').setAttribute('aria-expanded', 'false'); };
    const setContext = async (patchCtx) => {
      if (thread) {
        convo = (await api(`api/chat/conversations/${encodeURIComponent(convo.id)}`, patch({ context: patchCtx }))).conversation;
      } else {
        const c = draft.context;
        if (patchCtx.sources) c.sources = { ...c.sources, ...patchCtx.sources };
        if (patchCtx.notes) c.notes = patchCtx.notes.map((n) => ({ id: n.id || `note_${Math.random().toString(36).slice(2, 9)}`, title: (n.title || '').trim().slice(0, 80) || n.text.trim().split('\n')[0].slice(0, 60), text: n.text, enabled: n.enabled !== false }));
      }
      drawCtxCount();
    };
    const panelAct = async (fn, editing = '') => { try { await fn(); await loadPreview(); drawCtx(editing); } catch (e) { const el = $('#note-err'); if (el) el.textContent = e.message; else toast(e.message); } };
    $('#ctx-btn').addEventListener('click', () => ($('#ctx-panel').hidden ? openCtx() : closeCtx()));
    $('#ctx-panel').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const notes = () => (ctxOf().notes || []).map((n) => ({ ...n }));
      if (b.hasAttribute('data-ctx-close')) closeCtx();
      else if (b.dataset.noteEdit) drawCtx(b.dataset.noteEdit);
      else if (b.hasAttribute('data-note-cancel')) drawCtx();
      else if (b.dataset.noteDel) panelAct(() => setContext({ notes: notes().filter((n) => n.id !== b.dataset.noteDel) }));
      else if (b.hasAttribute('data-note-save')) {
        const text = $('#note-text').value;
        const editing = $('.note-form').dataset.editing;
        if (!text.trim()) { $('#note-err').textContent = 'Write something to pin first.'; return; }
        const title = $('#note-title').value;
        panelAct(() => setContext({ notes: editing ? notes().map((n) => (n.id === editing ? { ...n, title, text } : n)) : [...notes(), { title, text, enabled: true }] }));
      }
    });
    $('#ctx-panel').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); });
    $('#ctx-panel').addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.src) panelAct(() => setContext({ sources: { [t.dataset.src]: t.checked } }));
      else if (t.dataset.noteToggle) panelAct(() => setContext({ notes: (ctxOf().notes || []).map((n) => (n.id === t.dataset.noteToggle ? { ...n, enabled: t.checked } : n)) }));
    });
    // composedPath keeps the original ancestors even when the panel re-rendered (and detached) the clicked button.
    const onDocClick = (e) => { const path = e.composedPath(); if (!$('#ctx-panel').hidden && !path.includes($('#ctx-panel')) && !path.includes($('#ctx-btn'))) closeCtx(); };
    const onKey = (e) => { if (e.key === 'Escape' && !$('#ctx-panel').hidden) { closeCtx(); $('#ctx-btn').focus(); } };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    disposers.push(() => { document.removeEventListener('click', onDocClick); document.removeEventListener('keydown', onKey); });

    // ── sending ────────────────────────────────────────────────────────────────────────────
    const input = $('#chat-input');
    const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 220)}px`; };
    input.addEventListener('input', () => { grow(); syncComposer(); });
    const send = async () => {
      const content = input.value;
      if (!content.trim() || $('#chat-send').disabled) return;
      $('#chat-send').disabled = true;
      try {
        if (!thread) {
          if (!draft.provider) throw new Error('Choose a provider first (see Models & keys).');
          const { conversation } = await api('api/chat/conversations', post({ ...(draft.projectId ? { projectId: draft.projectId } : {}), provider: draft.provider, model: draft.model || undefined, context: draft.context }));
          await api(`api/chat/conversations/${encodeURIComponent(conversation.id)}/messages`, post({ content }));
          location.hash = `#/chat/${conversation.id}`;
          return;
        }
        const r = await api(`api/chat/conversations/${encodeURIComponent(convo.id)}/messages`, post({ content }));
        input.value = '';
        grow();
        convo.messages.push(r.user, r.assistant);
        convo.generating = true;
        drawLog();
        toBottom(true);
      } catch (e) { toast(e.message); syncComposer(); }
    };
    $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    $('#chat-stop').addEventListener('click', async () => { try { await api(`api/chat/conversations/${encodeURIComponent(convo.id)}/stop`, post()); } catch (e) { toast(e.message); } });
    $('#chat-log').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-suggest]');
      if (chip) { input.value = chip.dataset.suggest; grow(); syncComposer(); input.focus(); }
    });
    const log = $('#chat-log');
    log.addEventListener('scroll', () => { $('#jump').hidden = nearBottom(); }, { passive: true });
    $('#jump').addEventListener('click', () => toBottom(true));

    drawHead(); drawChips(); drawLog();
    if (!thread) { input.focus(); return; }

    // ── live updates (thread) ──────────────────────────────────────────────────────────────
    const refresh = async () => {
      if (!alive) return;
      try { convo = (await api(`api/chat/conversations/${encodeURIComponent(convo.id)}`)).conversation; live.clear(); drawHead(); drawLog(); } catch { /* keep what is shown */ }
    };
    es = new EventSource(`api/chat/conversations/${encodeURIComponent(convo.id)}/stream`);
    const onEvt = (type, fn) => es.addEventListener(type, (ev) => { if (alive) fn(JSON.parse(ev.data)); });
    let raf = 0;
    const patchBody = (mid) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = $(`.msg[data-id="${CSS.escape(mid)}"] .msg-body`);
        if (!el || !live.has(mid) || !convo.messages.some((x) => x.id === mid)) return;
        const stick = nearBottom();
        el.innerHTML = renderBody(live.get(mid) || '', true) || typing;
        if (stick) toBottom();
      });
    };
    onEvt('sync', (d) => { if (d.active) { live.set(d.active.messageId, d.active.text); refresh().then(() => { live.set(d.active.messageId, d.active.text); patchBody(d.active.messageId); }); } else refresh(); });
    onEvt('delta', (d) => { live.set(d.messageId, (live.get(d.messageId) || '') + d.delta); patchBody(d.messageId); });
    onEvt('context', (d) => { const m = convo.messages.find((x) => x.id === d.messageId); if (m) m.context = d.context; });
    onEvt('message', (d) => { const i = convo.messages.findIndex((x) => x.id === d.message.id); if (i >= 0) convo.messages[i] = d.message; live.delete(d.message.id); drawLog(); });
    onEvt('messages', () => refresh());
    onEvt('idle', () => { refresh().then(reloadList); });
    es.addEventListener('error', () => { /* EventSource reconnects by itself; `sync` brings us up to date */ });

    // ── copy + task actions ────────────────────────────────────────────────────────────────
    const transcript = (msgs) => msgs.map((m) => `${m.role === 'user' ? 'You' : `Assistant (${m.providerLabel || m.provider} · ${m.model})`}:\n${m.content}`).join('\n\n');
    const find = (el) => convo.messages.find((m) => m.id === el.closest('.msg')?.dataset.id);
    $('#chat-log').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const m = find(btn);
      if (btn.hasAttribute('data-copy-code')) {
        const code = btn.closest('.code-block').querySelector('code').textContent;
        const ok = await copyWithFeedback(code, toast, 'Code copied');
        if (ok) { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy code'; }, 1500); }
        return;
      }
      if (!m) return;
      if (btn.dataset.act === 'copy') copyWithFeedback(live.get(m.id) ?? m.content, toast, 'Response copied');
      if (btn.dataset.act === 'task') openTaskDialog({ api, toast, convo, messageIds: [m.id] });
      if (btn.dataset.act === 'retry') {
        try { await api(`api/chat/conversations/${encodeURIComponent(convo.id)}/messages/${encodeURIComponent(m.id)}/retry`, post({})); await refresh(); } catch (err) { toast(err.message); }
      }
    });
    $('#chat-log').addEventListener('change', (e) => {
      if (!e.target.classList.contains('pick-box')) return;
      const mid = e.target.closest('.msg').dataset.id;
      if (e.target.checked) picked.add(mid); else picked.delete(mid);
      const n = picked.size;
      $('#pick-actions').hidden = !n;
      $('#copy-picked').disabled = $('#task-picked').disabled = !n;
      $('#copy-picked').textContent = `Copy selected (${n})`;
      $('#task-picked').textContent = `Task from selected (${n})`;
    });
    const pickedMsgs = () => convo.messages.filter((m) => picked.has(m.id));
    $('#copy-all').addEventListener('click', () => (convo.messages.length ? copyWithFeedback(transcript(convo.messages), toast, 'Conversation copied') : toast('Nothing to copy yet')));
    $('#copy-picked').addEventListener('click', () => copyWithFeedback(transcript(pickedMsgs()), toast, 'Excerpt copied'));
    $('#task-picked').addEventListener('click', () => openTaskDialog({ api, toast, convo, messageIds: [...picked] }));
    $('#task-all').addEventListener('click', () => (convo.messages.length ? openTaskDialog({ api, toast, convo, messageIds: [] }) : toast('Say something first — there is nothing to turn into a task yet')));

    // Text selection inside the thread: copy it or turn it into a task (the excerpt is kept as the task's origin).
    const selBar = $('#sel-bar');
    let selText = '';
    let selMsg = null;
    function onSelection() {
      const s = getSelection();
      const t = s && !s.isCollapsed ? s.toString() : '';
      const anchor = s?.anchorNode?.parentElement?.closest?.('.msg');
      if (t.trim() && anchor && $('#chat-log').contains(anchor)) { selText = t; selMsg = anchor.dataset.id; selBar.hidden = false; } else if (!selBar.contains(document.activeElement)) { selBar.hidden = true; }
    }
    document.addEventListener('selectionchange', onSelection);
    $('#sel-copy').addEventListener('click', () => copyWithFeedback(selText, toast, 'Selection copied'));
    $('#sel-task').addEventListener('click', () => openTaskDialog({ api, toast, convo, messageIds: [selMsg], excerpt: selText }));
    disposers.push(() => document.removeEventListener('selectionchange', onSelection));
    syncComposer();
  }
}

const defaultSel = (provs) => {
  const p = provs.providers?.find((x) => x.id === provs.defaultProvider && x.status === 'ready') || provs.providers?.find((x) => x.status === 'ready' && x.type !== 'offline') || provs.providers?.find((x) => x.status === 'ready');
  return p ? { provider: p.id, model: p.defaultModel || p.models?.[0]?.id } : {};
};

/**
 * Review dialog for a task made from chat. The model's summary (or a plain extract) is only a DRAFT: nothing is saved until
 * the person edits it and presses Save, and saving never runs anything.
 */
export async function openTaskDialog({ api, toast, convo, messageIds, excerpt = '' }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'task-dialog';
  dlg.setAttribute('aria-label', 'Create task from chat');
  dlg.innerHTML = '<form method="dialog" class="task-form"><h2>Create task</h2><p class="muted" id="td-status" role="status">Drafting a task from the conversation…</p></form>';
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  let projects = [];
  try { projects = (await api('api/projects?archived=false')).projects; } catch { /* the select falls back to the conversation project */ }
  let draft;
  if (excerpt) draft = { title: excerpt.split('\n')[0].slice(0, 100), description: excerpt.slice(0, 8000), source: 'selection', warning: null };
  else {
    try { draft = (await api(`api/chat/conversations/${encodeURIComponent(convo.id)}/task-draft`, post({ messageIds }))).draft; } catch (e) {
      dlg.close(); toast(e.message); return;
    }
  }
  const choices = projects.filter((p) => !p.archived);
  if (!choices.length && !convo.projectId) { dlg.close(); toast('Register a project first — tasks always belong to a project'); return; }
  if (!choices.some((p) => p.id === convo.projectId) && convo.project && !convo.project.archived && !convo.projectRemoved) choices.unshift({ id: convo.project.id, name: convo.project.name });
  const origin = { type: 'chat', conversationId: convo.id, messageIds: draft.messageIds || messageIds, ...(excerpt ? { excerpt } : {}) };
  const sourceNote = draft.source === 'model' ? `Drafted by ${esc(draft.model)} (${esc(draft.provider)}) — review before saving.` : draft.source === 'selection' ? 'Your selection, as written — edit freely.' : 'A plain extract of the conversation — edit freely.';
  dlg.innerHTML = `<form class="task-form" id="td-form">
    <h2>Create task</h2>
    <p class="muted">${sourceNote} Saving puts it in the backlog; <strong>nothing is run</strong> until you start the task.</p>
    ${draft.warning ? `<p class="callout warn">${esc(draft.warning)}</p>` : ''}
    <label class="field"><span>Title</span><input name="title" required maxlength="160" value="${esc(draft.title)}"></label>
    <label class="field"><span>Description <em>this exact text is what the factory receives when you start the task</em></span><textarea name="description" rows="10" maxlength="20000">${esc(draft.description)}</textarea></label>
    <div class="picker-grid">
      <label class="field"><span>Project</span><select name="projectId" required>${convo.projectId ? '' : '<option value="" disabled selected>Choose a project…</option>'}${choices.map((p) => `<option value="${esc(p.id)}" ${p.id === convo.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Position</span><select name="position"><option value="bottom">Bottom of the backlog</option><option value="top">Top of the backlog</option></select></label>
      <label class="field"><span>Status</span><select name="status"><option value="backlog">Backlog</option><option value="ready">Ready</option></select></label>
    </div>
    <p class="muted">Origin: this conversation${origin.messageIds?.length ? ` · ${origin.messageIds.length} message${origin.messageIds.length === 1 ? '' : 's'}` : ''}${excerpt ? ' · selected excerpt' : ''}.</p>
    <p class="error" id="td-error" role="alert" hidden></p>
    <div class="actions"><button type="button" class="btn" id="td-cancel">Cancel</button><button class="btn accent" type="submit">Save to backlog</button></div></form>`;
  $('#td-cancel', dlg).addEventListener('click', () => dlg.close());
  $('#td-form', dlg).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const { task } = await api('api/tasks', post({ title: f.title.value, description: f.description.value, projectId: f.projectId.value, status: f.status.value, position: f.position.value, origin }));
      dlg.close();
      toast(`Task saved at position ${task.position}. Open the backlog to start it.`);
    } catch (err) {
      const box = $('#td-error', dlg);
      box.textContent = err.message;
      box.hidden = false;
    }
  });
  $('input[name=title]', dlg).focus();
}
