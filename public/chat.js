// Project-scoped chat. Advisory only: it never runs commands, edits files or publishes. Everything here is rendered from
// the backend's persisted conversation; the browser keeps no authoritative history. Model output is untrusted text.
import { esc, loadProviders } from './providers.js';

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

const renderBody = (text) => parseBlocks(text).map((b) => (b.type === 'code'
  ? `<div class="code-block"><div class="code-head"><span class="mono">${esc(b.lang || 'code')}</span><button type="button" class="btn small" data-copy-code aria-label="Copy this code block">Copy code</button></div><pre><code>${esc(b.text)}</code></pre></div>`
  : `<div class="prose">${esc(b.text.replace(/^\n+|\n+$/g, ''))}</div>`)).join('');

const KIND = { readme: 'doc', doc: 'doc', file: 'file', listing: 'file list', git: 'git', tasks: 'tasks', runs: 'runs', meta: 'project record', project: 'project record' };

function contextBlock(m) {
  if (m.role !== 'assistant' || !m.context) return '';
  const c = m.context;
  const items = c.items || [];
  const lim = c.limitations || [];
  return `<details class="ctx"><summary>${items.length ? `Retrieved from the project: ${items.length} item${items.length === 1 ? '' : 's'}` : 'Nothing was retrieved from the project'}${lim.length ? ` · ${lim.length} limitation${lim.length === 1 ? '' : 's'}` : ''}</summary>
    ${items.length ? `<ul class="ctx-items">${items.map((i) => `<li><span class="pill skipped">${esc(KIND[i.kind] || i.kind)}</span> <span class="mono">${esc(i.label)}</span>${i.truncated ? ' <em>(truncated)</em>' : ''}</li>`).join('')}</ul>` : ''}
    ${lim.length ? `<ul class="ctx-lim">${lim.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    <p class="muted">Anything in the answer that is not in the list above comes from the model's own knowledge or inference — verify it before acting on it.</p></details>`;
}

/** Mount chat. `id` empty → the conversation list / "new conversation" page. */
export async function renderChatPage(main, api, { toast, id = '', project = '' }) {
  let alive = true;
  let es = null;
  const disposers = [];
  const cleanup = () => { alive = false; es?.close(); disposers.forEach((d) => d()); };
  document.title = 'Chat · da-prompt';
  main.innerHTML = '<section class="page chat-page"><p class="muted">Loading…</p></section>';
  try {
    if (id) await thread(id);
    else await home();
  } catch (e) {
    main.innerHTML = `<section class="page chat-page"><h1>Chat</h1><div class="card callout fail" role="alert">${esc(e.message)}</div><p><a href="#/chat">Back to conversations</a></p></section>`;
  }
  return cleanup;

  // ── list + new conversation ────────────────────────────────────────────────────────────────
  async function home() {
    const [{ projects }, provs] = await Promise.all([api('api/projects?archived=false'), loadProviders(api).catch(() => null)]);
    const usable = projects.filter((p) => !p.archived);
    let filter = project && usable.some((p) => p.id === project) ? project : '';
    main.innerHTML = `<section class="page chat-page">
      <p class="eyebrow">advisory · it reads, it never acts</p>
      <h1>Chat about a project</h1>
      <p class="lede">Every conversation belongs to one registered project. The assistant sees only what the server retrieves from that project, and never runs commands, edits files or publishes. Turn a good answer into a task; execution only starts when you start a task.</p>
      <div class="card chat-new">
        ${usable.length ? `<form id="chat-new" class="proj-bar">
          <label class="field grow"><span>Project</span><select name="projectId" id="chat-project">${usable.map((p) => `<option value="${esc(p.id)}" ${p.id === filter ? 'selected' : ''}>${esc(p.name)}${p.product ? ` · ${esc(p.product)}` : ''}${p.status !== 'available' ? ` (${esc(p.status)})` : ''}</option>`).join('')}</select></label>
          <button class="btn accent" type="submit">New conversation</button></form>`
          : '<p>Register a project first — a conversation is always about one project. <a href="#/projects">Open Projects</a></p>'}
      </div>
      <h2>Conversations</h2><div id="chat-list" aria-live="polite"></div></section>`;
    const draw = async () => {
      const q = filter ? `?projectId=${encodeURIComponent(filter)}` : '';
      const { conversations } = await api(`api/chat/conversations${q}`);
      const byId = new Map(projects.map((p) => [p.id, p]));
      $('#chat-list').innerHTML = conversations.length
        ? `<ul class="proj-rows">${conversations.map((c) => `<li class="proj-row"><a class="proj-main" href="#/chat/${esc(c.id)}"><strong>${esc(c.title)}</strong> <span class="pill skipped">${esc(byId.get(c.projectId)?.name || c.projectName || 'removed project')}</span>
          <span class="muted">${esc(c.preview)}</span></a><span class="muted">${esc(c.messageCount)} msg · ${esc(ago(c.updatedAt))}</span></li>`).join('')}</ul>`
        : '<div class="card empty-term"><h3>No conversations yet</h3><p>Pick a project above and start one.</p></div>';
    };
    await draw();
    $('#chat-project')?.addEventListener('change', (e) => { filter = e.target.value; draw(); });
    $('#chat-new')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const { conversation } = await api('api/chat/conversations', post({ projectId: $('#chat-project').value, ...(provs ? defaultSel(provs) : {}) }));
        location.hash = `#/chat/${conversation.id}`;
      } catch (err) { toast(err.message); }
    });
  }

  // ── a conversation ─────────────────────────────────────────────────────────────────────────
  async function thread(cid) {
    let convo = (await api(`api/chat/conversations/${encodeURIComponent(cid)}`)).conversation;
    const provs = await loadProviders(api).catch(() => null);
    const live = new Map(); // messageId -> streamed text (until the final message arrives)
    const picked = new Set();
    document.title = `${convo.title} · Chat · da-prompt`;
    main.innerHTML = `<section class="page chat-page chat-thread">
      <p class="eyebrow"><a href="#/chat">conversations</a> · advisory only</p>
      <div class="chat-head">
        <h1 id="chat-title" tabindex="-1">${esc(convo.title)}</h1>
        <div id="chat-project-bar"></div>
      </div>
      <div id="chat-banner"></div>
      <div class="chat-tools" role="toolbar" aria-label="Conversation actions">
        <label class="field"><span>Provider</span><select id="chat-provider" aria-label="Provider"></select></label>
        <label class="field"><span>Model</span><span id="chat-model-slot"></span></label>
        <span class="spacer"></span>
        <button class="btn" id="copy-all" type="button">Copy conversation</button>
        <button class="btn" id="copy-picked" type="button" disabled>Copy selected (0)</button>
        <button class="btn" id="task-picked" type="button" disabled>Task from selected (0)</button>
        <button class="btn accent" id="task-all" type="button">Create task from conversation</button>
      </div>
      <div id="chat-log" class="chat-log" role="log" aria-live="polite" aria-label="Conversation"></div>
      <div id="sel-bar" class="sel-bar" hidden><span>Selection:</span> <button class="btn small" id="sel-copy" type="button">Copy</button> <button class="btn small" id="sel-task" type="button">Create task</button></div>
      <form id="chat-form" class="chat-form" autocomplete="off">
        <label class="sr-only" for="chat-input">Message</label>
        <textarea id="chat-input" rows="3" maxlength="32000" placeholder="Ask about this project… (Enter to send, Shift+Enter for a new line)"></textarea>
        <div class="actions"><span class="muted" id="chat-hint"></span><button class="btn" type="button" id="chat-stop" hidden>Stop</button><button class="btn accent" type="submit" id="chat-send">Send</button></div>
      </form></section>`;

    const unavailable = () => convo.projectRemoved || convo.project?.archived || (convo.project && convo.project.status !== 'available');
    const drawHead = () => {
      const p = convo.project;
      $('#chat-project-bar').innerHTML = p
        ? `<span class="pill ${p.status === 'available' && !p.archived ? 'completed' : 'needs_attention'}" title="This conversation is bound to this project and never moves">${esc(p.name)}${p.product ? ` · ${esc(p.product)}` : ''}</span> <a class="muted" href="#/projects/${esc(p.id)}">project</a> <a class="muted" href="#/chat?project=${esc(p.id)}">new conversation</a>`
        : `<span class="pill failed">${esc(convo.projectName)} · removed</span>`;
      $('#chat-banner').innerHTML = unavailable()
        ? `<div class="card callout fail" role="status"><strong>${convo.projectRemoved ? 'This project is no longer registered.' : convo.project.archived ? 'This project is archived.' : `This project is ${esc(convo.project.status)}.`}</strong> The history below is kept. New answers cannot use the project's files, so anything they say about the code is the model's inference. ${convo.project && !convo.project.archived ? `<a href="#/projects/${esc(convo.project.id)}">Open the project to fix it</a>` : ''} To talk about another project, <a href="#/chat">start a new conversation</a> — this one is never moved.</div>` : '';
      $('#chat-title').textContent = convo.title;
    };

    const drawMessage = (m) => {
      const text = live.has(m.id) ? live.get(m.id) : m.content;
      const streaming = m.status === 'streaming';
      const who = m.role === 'user' ? 'You' : `${esc(m.providerLabel || m.provider)} · ${esc(m.model)}`;
      const state = streaming ? '<span class="pill running">writing…</span>' : m.status === 'error' ? '<span class="pill failed">failed</span>' : m.status === 'cancelled' ? '<span class="pill skipped">stopped</span>' : '';
      return `<article class="msg ${m.role} ${esc(m.status)}" data-id="${esc(m.id)}" data-role="${esc(m.role)}" aria-label="${m.role === 'user' ? 'Your message' : 'Assistant response'}">
        <header><label class="pick"><input type="checkbox" class="pick-box" ${picked.has(m.id) ? 'checked' : ''} aria-label="Select this message"></label><strong>${who}</strong> ${state} <span class="muted">${esc(ago(m.createdAt))}${m.attempts > 1 ? ` · attempt ${esc(m.attempts)}` : ''}</span></header>
        <div class="msg-body">${text ? renderBody(text) : streaming ? '<p class="muted">Waiting for the model…</p>' : '<p class="muted">(no text)</p>'}</div>
        ${m.error ? `<div class="msg-error" role="alert">${esc(m.error)} </div>` : ''}
        ${contextBlock(m)}
        <footer>
          ${text ? '<button type="button" class="btn small" data-act="copy">Copy response</button>' : ''}
          ${m.role === 'assistant' && !streaming && text ? '<button type="button" class="btn small" data-act="task">Create task</button>' : ''}
          ${m.role === 'user' ? '<button type="button" class="btn small" data-act="task">Create task</button>' : ''}
          ${['error', 'cancelled'].includes(m.status) && m.id === convo.messages.at(-1)?.id ? '<button type="button" class="btn small accent" data-act="retry">Retry</button>' : ''}
        </footer></article>`;
    };

    const drawLog = () => {
      const log = $('#chat-log');
      const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80 || !log.dataset.drawn;
      log.dataset.drawn = '1';
      log.innerHTML = convo.messages.length ? convo.messages.map(drawMessage).join('') : `<div class="card empty-term"><h3>Ask about ${esc(convo.project?.name || convo.projectName)}</h3><p>For example: “What does this project do?”, “Where is billing handled? (src/billing.js)”, “What would it take to add retries?” Mention a file path to bring that file into the context.</p></div>`;
      if (stick) log.scrollTop = log.scrollHeight;
      const n = picked.size;
      $('#copy-picked').disabled = $('#task-picked').disabled = !n;
      $('#copy-picked').textContent = `Copy selected (${n})`;
      $('#task-picked').textContent = `Task from selected (${n})`;
      const gen = convo.generating || convo.messages.some((m) => m.status === 'streaming');
      $('#chat-send').disabled = gen;
      $('#chat-stop').hidden = !gen;
      $('#chat-hint').textContent = gen ? 'A response is being generated…' : `${convo.provider ? `${convo.providerLabel || convo.provider} · ${convo.model}` : ''}`;
    };

    const drawPicker = () => {
      const ready = (provs?.providers || []).filter((p) => p.status === 'ready' && p.enabled);
      const cur = ready.find((p) => p.id === convo.provider);
      const sel = $('#chat-provider');
      sel.innerHTML = `${cur ? '' : `<option value="${esc(convo.provider)}" selected>${esc(convo.providerLabel || convo.provider)} (unavailable)</option>`}${ready.map((p) => `<option value="${esc(p.id)}" ${p.id === convo.provider ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}`;
      const models = cur?.models || [];
      $('#chat-model-slot').innerHTML = models.length
        ? `<select id="chat-model" aria-label="Model">${models.some((m) => m.id === convo.model) ? '' : `<option selected value="${esc(convo.model)}">${esc(convo.model)}</option>`}${models.map((m) => `<option value="${esc(m.id)}" ${m.id === convo.model ? 'selected' : ''}>${esc(m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id)}</option>`).join('')}</select>`
        : `<input id="chat-model" aria-label="Model" value="${esc(convo.model)}" maxlength="200">`;
    };
    const savePick = async (body) => {
      try {
        convo = (await api(`api/chat/conversations/${encodeURIComponent(cid)}`, patch(body))).conversation;
        toast('Applies to your next message; earlier responses keep their model');
      } catch (e) { toast(e.message); }
      drawPicker(); drawLog();
    };

    drawHead(); drawPicker(); drawLog();
    $('#chat-provider').addEventListener('change', (e) => savePick({ provider: e.target.value }));
    $('#chat-model-slot').addEventListener('change', (e) => { if (e.target.id === 'chat-model') savePick({ model: e.target.value.trim() }); });

    const refresh = async () => {
      if (!alive) return;
      try { convo = (await api(`api/chat/conversations/${encodeURIComponent(cid)}`)).conversation; live.clear(); drawHead(); drawLog(); } catch { /* keep what is shown */ }
    };

    // Live updates. After a reconnect the server re-sends `sync` with the full text so nothing is lost or doubled.
    es = new EventSource(`api/chat/conversations/${encodeURIComponent(cid)}/stream`);
    const onEvt = (type, fn) => es.addEventListener(type, (ev) => { if (alive) fn(JSON.parse(ev.data)); });
    const patchBody = (mid) => {
      const el = $(`.msg[data-id="${CSS.escape(mid)}"] .msg-body`);
      const m = convo.messages.find((x) => x.id === mid);
      if (el && m) { el.innerHTML = renderBody(live.get(mid) || ''); const log = $('#chat-log'); if (log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight; }
    };
    onEvt('sync', (d) => { if (d.active) { live.set(d.active.messageId, d.active.text); refresh().then(() => patchBody(d.active.messageId)); } else refresh(); });
    onEvt('delta', (d) => { live.set(d.messageId, (live.get(d.messageId) || '') + d.delta); patchBody(d.messageId); });
    onEvt('context', (d) => { const m = convo.messages.find((x) => x.id === d.messageId); if (m) m.context = d.context; });
    onEvt('message', (d) => { const i = convo.messages.findIndex((x) => x.id === d.message.id); if (i >= 0) convo.messages[i] = d.message; live.delete(d.message.id); drawLog(); });
    onEvt('messages', () => refresh());
    onEvt('idle', () => refresh());

    // Compose / send / stop / retry
    const input = $('#chat-input');
    const send = async () => {
      const content = input.value;
      if (!content.trim() || $('#chat-send').disabled) return;
      $('#chat-send').disabled = true;
      try {
        const r = await api(`api/chat/conversations/${encodeURIComponent(cid)}/messages`, post({ content }));
        input.value = '';
        convo.messages.push(r.user, r.assistant);
        convo.generating = true;
        drawLog();
      } catch (e) { toast(e.message); $('#chat-send').disabled = false; }
    };
    $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    $('#chat-stop').addEventListener('click', async () => { try { await api(`api/chat/conversations/${encodeURIComponent(cid)}/stop`, post()); } catch (e) { toast(e.message); } });

    // Copy + task actions
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
        try { await api(`api/chat/conversations/${encodeURIComponent(cid)}/messages/${encodeURIComponent(m.id)}/retry`, post({})); await refresh(); } catch (err) { toast(err.message); }
      }
    });
    $('#chat-log').addEventListener('change', (e) => {
      if (!e.target.classList.contains('pick-box')) return;
      const mid = e.target.closest('.msg').dataset.id;
      if (e.target.checked) picked.add(mid); else picked.delete(mid);
      const n = picked.size;
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
    document.addEventListener('selectionchange', onSelection);
    es.addEventListener('error', () => { /* EventSource reconnects by itself; `sync` brings us up to date */ });
    function onSelection() {
      const s = getSelection();
      const t = s && !s.isCollapsed ? s.toString() : '';
      const anchor = s?.anchorNode?.parentElement?.closest?.('.msg');
      if (t.trim() && anchor && $('#chat-log').contains(anchor)) { selText = t; selMsg = anchor.dataset.id; selBar.hidden = false; } else if (!selBar.contains(document.activeElement)) { selBar.hidden = true; }
    }
    $('#sel-copy').addEventListener('click', () => copyWithFeedback(selText, toast, 'Selection copied'));
    $('#sel-task').addEventListener('click', () => openTaskDialog({ api, toast, convo, messageIds: [selMsg], excerpt: selText }));
    disposers.push(() => document.removeEventListener('selectionchange', onSelection));
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
      <label class="field"><span>Project</span><select name="projectId">${choices.map((p) => `<option value="${esc(p.id)}" ${p.id === convo.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
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
