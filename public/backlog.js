// Backlog: ONE persistent ordered list of tasks across all projects. The list order IS the priority (position 1 first).
// Filters are views over that same order. Drag-and-drop and the Move buttons call the same backend move; the UI updates
// immediately, then reconciles with the server's answer (and reverts on failure or a stale-view conflict).
import { esc } from './providers.js';

const $ = (sel, root = document) => root.querySelector(sel);
const post = (body) => ({ method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = (body) => ({ method: 'PATCH', body: JSON.stringify(body) });
const STATUS_LABEL = { backlog: 'Backlog', ready: 'Ready', in_progress: 'In progress', blocked: 'Blocked', completed: 'Completed', cancelled: 'Cancelled' };
const STATUS_CLASS = { backlog: 'skipped', ready: 'running', in_progress: 'running', blocked: 'needs_attention', completed: 'completed', cancelled: 'skipped' };
const NEXT = {
  backlog: ['ready', 'blocked', 'cancelled'], ready: ['backlog', 'blocked', 'cancelled'], in_progress: ['ready', 'blocked', 'completed', 'cancelled', 'backlog'],
  blocked: ['backlog', 'ready', 'cancelled'], completed: ['backlog', 'ready'], cancelled: ['backlog', 'ready'],
};
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(iso).toLocaleDateString();
};
const runText = (r) => (!r ? '' : r.status === 'missing' ? 'run record missing' : `run ${r.status}${r.executing ? ' (executing)' : ''}${r.verdict ? ` · ${r.verdict}` : ''}`);

export async function renderBacklogPage(main, api, { toast, task = '' }) {
  let alive = true;
  let rev = 0;
  let all = []; // the authoritative order as last confirmed (or optimistically updated) — always the GLOBAL list
  let busy = false; // a move is in flight
  let dragging = null;
  const f = { projectId: '', product: '', status: '', q: '' };
  const timers = [];
  let projects = [];
  document.title = 'Backlog · da-prompt';
  main.innerHTML = `<section class="page backlog-page">
    <p class="eyebrow">one ordered list · across every product and project</p>
    <h1>Backlog</h1>
    <p class="lede">Top is most important. Drag a row by its handle (or use Move up / Move down) to change its priority; the order is saved on the server and shared by every project view. Nothing runs until you press <strong>Start</strong> on a task.</p>
    <div class="proj-bar bl-bar">
      <input type="search" id="bl-q" placeholder="Search tasks" aria-label="Search tasks">
      <select id="bl-product" aria-label="Filter by product"></select>
      <select id="bl-project" aria-label="Filter by project"></select>
      <select id="bl-status" aria-label="Filter by status"><option value="">All statuses</option><option value="open">Open only (hide completed &amp; cancelled)</option>${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <span class="spacer"></span>
      <button class="btn accent" id="bl-add">+ Add task</button>
    </div>
    <p id="bl-note" class="muted" aria-live="polite"></p>
    <div id="bl-error" class="card callout fail" role="alert" hidden></div>
    <ol id="bl-list" class="bl-list" aria-label="Backlog, highest priority first"></ol>
    <div id="bl-detail"></div></section>`;

  const showError = (msg) => { const b = $('#bl-error'); b.textContent = msg; b.hidden = !msg; };
  const visible = () => {
    const q = f.q.trim().toLowerCase();
    return all.filter((t) => (!f.projectId || t.projectId === f.projectId) && (!f.product || t.project.product === f.product)
      && (!f.status || (f.status === 'open' ? !['completed', 'cancelled'].includes(t.status) : t.status === f.status))
      && (!q || `${t.title} ${t.description} ${t.project.name}`.toLowerCase().includes(q)));
  };

  async function load() {
    const [t, p] = await Promise.all([api('api/tasks'), api('api/projects?archived=all').catch(() => ({ projects })) ]);
    rev = t.rev; all = t.tasks; projects = p.projects || projects;
    drawFilters(); draw();
  }

  function drawFilters() {
    const products = [...new Set(all.map((t) => t.project.product).filter(Boolean))].sort();
    const projs = new Map(all.map((t) => [t.projectId, t.project.name]));
    for (const p of projects) projs.set(p.id, p.name);
    $('#bl-product').innerHTML = `<option value="">All products</option>${products.map((x) => `<option ${x === f.product ? 'selected' : ''}>${esc(x)}</option>`).join('')}`;
    $('#bl-project').innerHTML = `<option value="">All projects</option>${[...projs].map(([id, n]) => `<option value="${esc(id)}" ${id === f.projectId ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
  }

  function draw(focusSel) {
    const rows = visible();
    const hidden = all.length - rows.length;
    $('#bl-note').textContent = !all.length ? '' : hidden ? `Showing ${rows.length} of ${all.length} tasks (filtered). The numbers are positions in the full backlog; filtering never changes the order.` : `${all.length} task${all.length === 1 ? '' : 's'}.`;
    $('#bl-list').innerHTML = !all.length
      ? '<li class="card empty-term"><h3>The backlog is empty</h3><p>Add a task, or turn a chat answer into one. Tasks you create stay here, in the order you put them, until you start them.</p></li>'
      : !rows.length ? '<li class="muted">No task matches this view.</li>'
        : rows.map((t, i) => row(t, i, rows)).join('');
    if (focusSel) $(focusSel)?.focus();
  }

  function row(t, i, rows) {
    const p = t.project;
    const o = t.origin || {};
    const originHtml = o.type === 'chat' ? `<a href="#/chat/${esc(o.conversationId)}" ${o.conversationExists ? '' : 'aria-disabled="true"'} title="Created from a chat conversation">from chat${o.conversationTitle ? `: ${esc(o.conversationTitle)}` : ''}</a>` : '<span>manual</span>';
    return `<li class="bl-row ${esc(t.status)}" data-id="${esc(t.id)}" aria-label="${esc(t.title)}">
      <button type="button" class="bl-handle" aria-label="Drag to reorder: ${esc(t.title)}" title="Drag to reorder" tabindex="-1">⋮⋮</button>
      <span class="bl-pos" title="Position in the full backlog (1 = highest priority)">${esc(t.position)}</span>
      <div class="bl-main"><button type="button" class="bl-title" data-act="open">${esc(t.title)}</button>
        <div class="bl-meta"><span class="pill ${p.removed ? 'failed' : p.archived ? 'skipped' : 'completed'}" title="Project">${esc(p.name)}${p.removed ? ' · removed' : p.archived ? ' · archived' : ''}</span>${p.product ? `<span class="pill skipped" title="Product">${esc(p.product)}</span>` : ''}
          <span class="muted">${originHtml}</span>${t.run ? `<span class="muted">· ${esc(runText(t.run))}</span>` : ''}</div></div>
      <span class="pill ${STATUS_CLASS[t.status]}">${esc(STATUS_LABEL[t.status])}</span>
      <span class="bl-acts">
        <button type="button" class="btn small" data-act="up" aria-label="Move up: ${esc(t.title)}" ${i === 0 || busy ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn small" data-act="down" aria-label="Move down: ${esc(t.title)}" ${i === rows.length - 1 || busy ? 'disabled' : ''}>↓</button>
        <button type="button" class="btn small" data-act="open">Details</button>
        ${t.startable ? '<button type="button" class="btn small accent" data-act="start">Start</button>' : ''}
      </span></li>`;
  }

  // ── moving: optimistic, then reconcile ─────────────────────────────────────────────────────
  async function move(id, where, focusSel) {
    if (busy) return;
    const before = all;
    const from = all.findIndex((t) => t.id === id);
    if (from < 0) return;
    const next = all.filter((t) => t.id !== id);
    const ref = where.beforeId || where.afterId;
    const at = ref ? next.findIndex((t) => t.id === ref) + (where.afterId ? 1 : 0) : where.top ? 0 : next.length;
    if (ref && next.findIndex((t) => t.id === ref) < 0) return;
    next.splice(at, 0, all[from]);
    if (next.every((t, i) => t.id === all[i].id)) return;
    all = next.map((t, i) => ({ ...t, position: i + 1 }));
    busy = true; showError('');
    draw(focusSel);
    try {
      const r = await api(`api/tasks/${encodeURIComponent(id)}/move`, post({ ...where, rev }));
      rev = r.rev; all = r.tasks;
    } catch (e) {
      if (e.body?.backlog || e.backlog) {
        const b = e.body?.backlog || e.backlog;
        rev = b.rev; all = b.tasks;
        showError('The backlog was changed somewhere else (another tab or device). Your move was not applied; the current order is shown. Try again if you still want it.');
      } else {
        all = before;
        showError(`The move could not be saved, so the order was put back. ${e.message}`);
      }
    } finally { busy = false; if (alive) { drawFilters(); draw(focusSel); } }
  }

  const list = $('#bl-list');
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    const li = e.target.closest('.bl-row');
    if (!b || !li) return;
    const id = li.dataset.id;
    const rows = visible();
    const i = rows.findIndex((t) => t.id === id);
    if (b.dataset.act === 'up' && i > 0) move(id, { beforeId: rows[i - 1].id }, `[data-id="${id}"] [data-act="up"]`);
    if (b.dataset.act === 'down' && i < rows.length - 1) move(id, { afterId: rows[i + 1].id }, `[data-id="${id}"] [data-act="down"]`);
    if (b.dataset.act === 'open') detail(id);
    if (b.dataset.act === 'start') startDialog(all.find((t) => t.id === id));
  });

  // Drag and drop. A row becomes draggable only while the pointer is on its handle, so clicking a title or button can
  // never start a reorder. The drop position is the row under the pointer (before it if the pointer is in its upper half).
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('.bl-row');
    if (!li) return;
    li.draggable = Boolean(e.target.closest('.bl-handle'));
  });
  list.addEventListener('pointerup', () => $$rows().forEach((li) => { li.draggable = false; }));
  const $$rows = () => [...list.querySelectorAll('.bl-row')];
  const clearMarks = () => $$rows().forEach((li) => li.classList.remove('drop-before', 'drop-after', 'dragging'));
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest?.('.bl-row');
    if (!li || !li.draggable || busy) { e.preventDefault(); return; }
    dragging = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging);
  });
  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    const li = e.target.closest('.bl-row');
    e.preventDefault();
    $$rows().forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    if (!li || li.dataset.id === dragging) return;
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  list.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const li = e.target.closest('.bl-row');
    const id = dragging;
    const where = li && li.dataset.id !== id ? (li.classList.contains('drop-after') ? { afterId: li.dataset.id } : { beforeId: li.dataset.id }) : null;
    dragging = null; clearMarks();
    if (where) move(id, where, `[data-id="${id}"] .bl-handle`);
  });
  list.addEventListener('dragend', () => { dragging = null; clearMarks(); $$rows().forEach((li) => { li.draggable = false; }); });

  // ── filters ────────────────────────────────────────────────────────────────────────────────
  $('#bl-q').addEventListener('input', (e) => { f.q = e.target.value; draw(); });
  $('#bl-product').addEventListener('change', (e) => { f.product = e.target.value; draw(); });
  $('#bl-project').addEventListener('change', (e) => { f.projectId = e.target.value; draw(); });
  $('#bl-status').addEventListener('change', (e) => { f.status = e.target.value; draw(); });
  $('#bl-add').addEventListener('click', () => addDialog());

  // ── dialogs ────────────────────────────────────────────────────────────────────────────────
  function dialog(html, label) {
    const dlg = document.createElement('dialog');
    dlg.className = 'task-dialog';
    dlg.setAttribute('aria-label', label);
    dlg.innerHTML = html;
    document.body.append(dlg);
    dlg.addEventListener('close', () => { dlg.remove(); });
    dlg.showModal();
    return dlg;
  }
  const projectOptions = (selected) => projects.filter((p) => !p.archived).map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}${p.product ? ` · ${esc(p.product)}` : ''}</option>`).join('');

  function addDialog() {
    if (!projects.some((p) => !p.archived)) { toast('Register a project first (Projects)'); return; }
    const dlg = dialog(`<form class="task-form" id="add-form"><h2>Add task</h2>
      <label class="field"><span>Title</span><input name="title" required maxlength="160"></label>
      <label class="field"><span>Description <em>what the factory should do when you start it</em></span><textarea name="description" rows="8" maxlength="20000"></textarea></label>
      <div class="picker-grid"><label class="field"><span>Project</span><select name="projectId">${projectOptions(f.projectId)}</select></label>
        <label class="field"><span>Position</span><select name="position"><option value="bottom">Bottom</option><option value="top">Top</option></select></label>
        <label class="field"><span>Status</span><select name="status"><option value="backlog">Backlog</option><option value="ready">Ready</option></select></label></div>
      <p class="error" role="alert" hidden></p>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn accent" type="submit">Add to backlog</button></div></form>`, 'Add task');
    $('[data-close]', dlg).addEventListener('click', () => dlg.close());
    $('input[name=title]', dlg).focus();
    $('#add-form', dlg).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fm = e.target;
      try {
        await api('api/tasks', post({ title: fm.title.value, description: fm.description.value, projectId: fm.projectId.value, status: fm.status.value, position: fm.position.value }));
        dlg.close(); await load(); toast('Task added');
      } catch (err) { const b = $('.error', dlg); b.textContent = err.message; b.hidden = false; }
    });
  }

  function startDialog(t) {
    const dlg = dialog(`<form class="task-form" method="dialog"><h2>Start this task?</h2>
      <p>This hands <strong>${esc(t.title)}</strong> to the software factory as a new run on <strong>${esc(t.project.name)}</strong>, using the task's description below. The run works in an isolated copy; applying or publishing its changes still needs your explicit approval later.</p>
      <pre class="task-preview">${esc(t.description || '(no description — only the title is sent)')}</pre>
      <p class="error" role="alert" hidden></p>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn accent" type="submit" id="start-go">Start task</button></div></form>`, 'Start task');
    $('[data-close]', dlg).addEventListener('click', () => dlg.close());
    $('#start-go', dlg).addEventListener('click', async (e) => {
      e.preventDefault();
      e.target.disabled = true;
      try {
        const r = await api(`api/tasks/${encodeURIComponent(t.id)}/start`, post({}));
        dlg.close(); await load(); toast('Run started'); location.hash = `#/runs/${r.run.id}`;
      } catch (err) { const b = $('.error', dlg); b.textContent = err.message; b.hidden = false; e.target.disabled = false; }
    });
  }

  async function detail(id) {
    let t;
    try { t = (await api(`api/tasks/${encodeURIComponent(id)}`)).task; } catch (e) { toast(e.message); return; }
    const p = t.project;
    const dlg = dialog(`<form class="task-form" id="d-form"><h2>Task <span class="muted mono">${esc(t.id)}</span></h2>
      <p><span class="pill ${STATUS_CLASS[t.status]}">${esc(STATUS_LABEL[t.status])}</span> position ${esc(t.position)} · created ${esc(ago(t.createdAt))}${t.run ? ` · <a href="#/runs/${esc(t.run.id)}">${esc(runText(t.run))}</a>` : ''}</p>
      ${p.removed ? '<p class="callout warn">Its project is no longer registered. The task is kept; it cannot be started or edited until it is moved to a registered project.</p>' : p.archived ? '<p class="callout warn">Its project is archived. Restore it to start this task.</p>' : ''}
      <label class="field"><span>Title</span><input name="title" required maxlength="160" value="${esc(t.title)}"></label>
      <label class="field"><span>Description</span><textarea name="description" rows="8" maxlength="20000">${esc(t.description)}</textarea></label>
      <label class="field"><span>Project</span><select name="projectId">${p.removed || p.archived ? `<option value="" selected>${esc(p.name)} (${p.removed ? 'removed' : 'archived'})</option>` : ''}${projectOptions(t.projectId)}</select></label>
      <p class="muted">${p.product ? `Product: ${esc(p.product)} · ` : ''}Origin: ${t.origin?.type === 'chat' ? `<a href="#/chat/${esc(t.origin.conversationId)}">chat${t.origin.conversationTitle ? ` “${esc(t.origin.conversationTitle)}”` : ''}</a>${t.origin.excerpt ? ` — excerpt: “${esc(t.origin.excerpt.slice(0, 160))}”` : ''}` : 'manual'}</p>
      <div class="field"><span>Status</span><div class="actions wrap">${NEXT[t.status].map((s) => `<button type="button" class="btn small" data-status="${s}">Mark ${esc(STATUS_LABEL[s].toLowerCase())}</button>`).join('')}</div>
        <span class="muted">${t.status === 'in_progress' ? 'A finished run does not complete the task — you decide when it is done.' : 'Statuses are changed by you; starting a task moves it to In progress.'}</span></div>
      <details><summary>History (${t.history.length})</summary><ul class="hist">${[...t.history].reverse().map((h) => `<li><span class="muted">${esc(ago(h.at))}</span> ${esc(h.event)}${h.to ? ` → ${esc(h.to)}` : ''}${h.note ? ` · ${esc(h.note)}` : ''}</li>`).join('')}</ul></details>
      <p class="error" role="alert" hidden></p>
      <div class="actions"><button type="button" class="btn" data-close>Close</button>${t.startable ? '<button type="button" class="btn" id="d-start">Start…</button>' : ''}<button class="btn accent" type="submit">Save changes</button></div></form>`, `Task: ${t.title}`);
    $('[data-close]', dlg).addEventListener('click', () => dlg.close());
    const fail = (err) => { const b = $('.error', dlg); b.textContent = err.message; b.hidden = false; };
    $('#d-form', dlg).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fm = e.target;
      try {
        await api(`api/tasks/${encodeURIComponent(id)}`, patch({ title: fm.title.value, description: fm.description.value, ...(fm.projectId.value && fm.projectId.value !== t.projectId ? { projectId: fm.projectId.value } : {}) }));
        dlg.close(); await load(); toast('Saved');
      } catch (err) { fail(err); }
    });
    for (const b of dlg.querySelectorAll('[data-status]')) b.addEventListener('click', async () => {
      try { await api(`api/tasks/${encodeURIComponent(id)}/status`, post({ status: b.dataset.status })); dlg.close(); await load(); toast('Status updated'); } catch (err) { fail(err); }
    });
    $('#d-start', dlg)?.addEventListener('click', () => { dlg.close(); startDialog(t); });
  }

  try { await load(); } catch (e) { showError(e.message); }
  if (task) detail(task);
  // Reconcile with the server every few seconds (other tabs, run progress) unless the user is mid-interaction.
  timers.push(setInterval(() => { if (alive && !busy && !dragging && !document.querySelector('dialog[open]') && !document.hidden) load().catch(() => {}); }, 5000));
  return () => { alive = false; timers.forEach(clearInterval); };
}
