// Projects page: the persistent registry. A project is a durable identity associated with a workspace location; terminals
// and runs are activities that point at it. Everything shown here comes from backend validation (status, git state).
import { esc } from './providers.js';

const $ = (sel, root = document) => root.querySelector(sel);
const STATUS_TEXT = { available: 'Available', missing: 'Missing', inaccessible: 'Inaccessible', attention: 'Needs attention' };
const pill = (p) => (p.archived ? '<span class="pill skipped">archived</span>' : `<span class="pill ${p.status === 'available' ? 'completed' : p.status === 'attention' ? 'needs_attention' : 'failed'}" data-status="${esc(p.status)}">${esc(STATUS_TEXT[p.status] || p.status)}</span>`);
const ago = (iso) => {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(iso).toLocaleDateString();
};
const where = (p) => (p.location.type === 'remote' ? `${p.location.host}/${p.location.owner}/${p.location.repo}` : p.location.path || p.location.label);

/** Mount the Projects page (list at #/projects, one project at #/projects/<id>). Returns a cleanup function. */
export async function renderProjectsPage(main, api, { toast, id }) {
  let alive = true;
  const call = (path, opts) => api(`api/projects${path}`, opts?.body ? { ...opts, body: JSON.stringify(opts.body) } : opts);
  const timer = [];
  main.innerHTML = '<section class="page projects-page"><p class="muted">Loading projects…</p></section>';
  if (id) await detail(id);
  else await list();
  return () => { alive = false; timer.forEach(clearInterval); };

  // ── list ──────────────────────────────────────────────────────────────────────────────────────
  async function list() {
    document.title = 'Projects · da-prompt';
    main.innerHTML = `<section class="page projects-page">
      <p class="eyebrow">workspaces · registered once, remembered</p>
      <h1>Projects</h1>
      <p class="lede">A project is a durable record of a repository or folder. Register it once; terminals, tasks and run history attach to it by id, so renaming or moving the folder never loses them.</p>
      <div class="proj-bar">
        <input type="search" id="proj-q" placeholder="Search name, folder or remote" aria-label="Search projects">
        <select id="proj-status" aria-label="Filter by status"><option value="">All statuses</option><option value="available">Available</option><option value="missing">Missing</option><option value="inaccessible">Inaccessible</option><option value="attention">Needs attention</option></select>
        <label class="check inline"><input type="checkbox" id="proj-archived"> Show archived</label>
        <span class="spacer"></span>
        <button class="btn accent" id="proj-register">+ Register project</button>
      </div>
      <div id="proj-form"></div>
      <div id="proj-list" aria-live="polite"></div></section>`;
    const q = $('#proj-q');
    const st = $('#proj-status');
    const arch = $('#proj-archived');
    let rows = [];
    const draw = () => {
      const needle = q.value.trim().toLowerCase();
      const shown = rows.filter((p) => (!st.value || p.status === st.value) && (!needle || `${p.name} ${where(p)} ${p.repo.remoteUrl || ''}`.toLowerCase().includes(needle)));
      $('#proj-list').innerHTML = !rows.length
        ? '<div class="card empty-term"><h3>No projects yet</h3><p>Register a folder or Git repository once and it stays here. Pick it whenever you want a terminal, a task, or its run history.</p><button class="btn accent" data-act="register">Register your first project</button></div>'
        : !shown.length ? '<p class="muted">No project matches that search or filter.</p>'
          : `<ul class="proj-rows">${shown.map((p) => `<li class="proj-row ${p.archived ? 'archived' : ''}" data-id="${esc(p.id)}">
              <a class="proj-main" href="#/projects/${esc(p.id)}"><strong>${esc(p.name)}</strong> ${pill(p)}
                <span class="muted mono">${esc(p.location.type === 'remote' ? `remote · ${where(p)}` : `${p.repo.isGit ? 'git' : 'folder'} · ${where(p)}`)}</span>
                ${p.status !== 'available' ? `<span class="proj-why">${esc(p.errors?.[0]?.message || '')}</span>` : ''}</a>
              <span class="muted">used ${esc(ago(p.lastUsedAt))}</span>
              <span class="proj-acts">${p.kind === 'local' && p.status === 'available' && !p.archived ? `<a class="btn" href="#/terminal?project=${esc(p.id)}">Open terminal</a>` : ''}${p.status === 'available' && !p.archived ? `<a class="btn accent" href="#/?project=${esc(p.id)}">Start a task</a>` : `<a class="btn" href="#/projects/${esc(p.id)}">${p.status === 'available' ? 'Open' : 'Fix'}</a>`}</span></li>`).join('')}</ul>`;
    };
    const load = async (refresh = false) => {
      try {
        rows = (await call(`?archived=${arch.checked ? 'all' : 'false'}${refresh ? '&refresh=1' : ''}`)).projects;
        if (alive) draw();
      } catch (e) {
        $('#proj-list').innerHTML = `<div class="card callout fail" role="alert"><p>${esc(e.message)}</p></div>`;
      }
    };
    q.addEventListener('input', draw);
    st.addEventListener('change', draw);
    arch.addEventListener('change', () => load(true));
    main.addEventListener('click', (e) => e.target.closest('[data-act=register]') && $('#proj-register').click());
    $('#proj-register').addEventListener('click', () => registerForm(() => {}));
    await load(true); // opening the page re-checks every project against the host
    timer.push(setInterval(() => document.visibilityState === 'visible' && !$('#proj-form form') && load(), 15000));
  }

  async function registerForm(onDone) {
    const box = $('#proj-form');
    if (box.innerHTML) { box.innerHTML = ''; return; }
    let dirs = [];
    let registered = [];
    let admin = false;
    try {
      [dirs, registered, admin] = await Promise.all([api('api/projects/directories').then((d) => d.directories), call('?archived=all').then((d) => d.projects), api('api/system/status').then((s) => s.admin).catch(() => false)]);
    } catch (e) {
      box.innerHTML = `<div class="card callout fail" role="alert">${esc(e.message)}</div>`;
      return;
    }
    const taken = new Set(registered.filter((p) => p.kind === 'local').map((p) => p.location.label));
    box.innerHTML = `<form class="card proj-form" id="reg-form" autocomplete="off">
      <h3>Register a project</h3>
      <div class="seg" role="radiogroup" aria-label="Project type"><label><input type="radio" name="kind" value="local" checked><span>Local folder or repository</span></label><label><input type="radio" name="kind" value="remote"><span>Git repository (remote)</span></label></div>
      <div id="reg-local">
        <label class="field"><span>Folder <em>from the folders da-prompt is allowed to use</em></span>
          <select name="directoryId" id="reg-dir">${dirs.length ? dirs.map((d) => `<option value="${esc(d.id)}" ${taken.has(d.name) ? 'data-taken="1"' : ''}>${esc(d.name)}${d.git?.isGit ? ` — git · ${esc(d.git.branch || 'detached')}` : ' — folder'}${d.readOnly ? ' · read-only' : ''}${taken.has(d.name) ? ' · already registered' : ''}</option>`).join('') : '<option value="">(no authorized folders)</option>'}</select></label>
        ${dirs.length ? '' : '<p class="muted">Authorize a parent folder first under <a href="#/settings?group=folders">Settings → Folders</a>.</p>'}
        ${admin ? '<label class="field"><span>…or a path on this machine <em>must be inside an authorized folder</em></span><input name="path" placeholder="/Users/me/code/my-repo"></label>' : ''}
      </div>
      <div id="reg-remote" hidden>
        <label class="field"><span>Repository</span><input name="repoUrl" placeholder="owner/repo  or  https://github.com/owner/repo"></label>
        <label class="field"><span>Default branch or tag <em>optional</em></span><input name="defaultRef" placeholder="main"></label>
      </div>
      <label class="field"><span>Display name <em>optional; you can rename it any time</em></span><input name="name" maxlength="80"></label>
      <p class="muted">Registering only records where the project is. It does not clone, change or delete anything, and it stores no credentials.</p>
      <div id="reg-msg" role="alert" hidden></div>
      <div class="actions"><button class="btn accent" type="submit">Register</button> <button class="btn" type="button" id="reg-cancel">Cancel</button></div></form>`;
    const f = $('#reg-form');
    const kindOf = () => f.querySelector('[name=kind]:checked').value;
    f.addEventListener('change', () => { $('#reg-local').hidden = kindOf() !== 'local'; $('#reg-remote').hidden = kindOf() !== 'remote'; });
    $('#reg-cancel').addEventListener('click', () => { box.innerHTML = ''; });
    const submit = async (extra = {}) => {
      const fd = new FormData(f);
      const body = kindOf() === 'remote' ? { kind: 'remote', repoUrl: fd.get('repoUrl'), defaultRef: fd.get('defaultRef') || undefined } : { kind: 'local', ...(String(fd.get('path') || '').trim() ? { path: String(fd.get('path')).trim() } : { directoryId: fd.get('directoryId') }) };
      if (String(fd.get('name') || '').trim()) body.name = String(fd.get('name')).trim();
      const msg = $('#reg-msg');
      msg.hidden = true;
      try {
        const { project } = await call('', { method: 'POST', body: { ...body, ...extra } });
        toast(`Registered ${project.name}`);
        location.hash = `#/projects/${project.id}`;
      } catch (e) {
        const conflicts = e.body?.conflicts || [];
        msg.hidden = false;
        msg.className = 'card callout warn';
        msg.innerHTML = `<p><strong>${esc(e.message)}</strong></p>${conflicts.map((c) => `<p>${esc(c.resolution || '')} ${c.projectId ? `<a href="#/projects/${esc(c.projectId)}">Open “${esc(c.name || 'existing project')}”</a>` : ''} ${c.type === 'same_repository' ? '<button type="button" class="btn" data-ack>Register this checkout as a separate project</button>' : ''}</p>`).join('')}`;
        msg.querySelector('[data-ack]')?.addEventListener('click', () => submit({ acknowledgeSameRepository: true }));
      }
    };
    f.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    onDone?.();
  }

  // ── detail ────────────────────────────────────────────────────────────────────────────────────
  async function detail(pid) {
    let data;
    try {
      data = await call(`/${encodeURIComponent(pid)}`);
    } catch (e) {
      main.innerHTML = `<section class="page empty-state"><h2>Project not found</h2><p>${esc(e.message)}</p><a class="btn" href="#/projects">All projects</a></section>`;
      return;
    }
    const p = data.project;
    document.title = `${p.name} · da-prompt`;
    const g = data.git || { isGit: false };
    let runs = [];
    try { runs = (await call(`/${encodeURIComponent(pid)}/runs`)).runs; } catch { /* history is optional here */ }
    const usable = p.status === 'available' && !p.archived;
    main.innerHTML = `<section class="page projects-page">
      <p class="eyebrow"><a href="#/projects">← all projects</a></p>
      <div class="proj-head"><h1 id="proj-name">${esc(p.name)}</h1> ${pill(p)}
        <button class="btn" id="proj-rename">Rename</button></div>
      <p class="muted mono">${esc(p.id)}</p>
      <div class="proj-primary">
        ${p.kind === 'local' ? `<a class="btn accent ${usable ? '' : 'disabled'}" id="open-terminal" ${usable ? `href="#/terminal?project=${esc(p.id)}"` : 'aria-disabled="true"'}>Open terminal</a>` : ''}
        <a class="btn ${usable ? 'accent' : 'disabled'}" id="start-task" ${usable ? `href="#/?project=${esc(p.id)}"` : 'aria-disabled="true"'}>Start a task</a>
        <button class="btn" id="proj-validate">Re-check</button>
        ${p.archived ? '<button class="btn" id="proj-restore">Restore</button>' : '<button class="btn" id="proj-archive">Archive</button>'}
      </div>
      ${p.errors.length ? `<div class="card callout ${p.status === 'attention' ? 'warn' : 'fail'}" role="alert" id="proj-problems"><h3>${esc(STATUS_TEXT[p.status])}</h3>${p.errors.map((x) => `<p>${esc(x.message)}</p>`).join('')}<div id="proj-fix"></div></div>` : ''}
      ${p.warnings.length ? `<div class="card callout">${p.warnings.map((x) => `<p>${esc(x.message)}</p>`).join('')}</div>` : ''}
      <div class="grid2">
        <div class="card"><h3>Workspace</h3><dl class="kv">
          <dt>Type</dt><dd>${p.kind === 'remote' ? 'Remote repository (no local folder; each run gets its own isolated clone)' : p.repo.isGit ? 'Local Git repository' : 'Local folder (not a Git repository)'}</dd>
          <dt>Location</dt><dd class="mono" id="proj-location">${esc(where(p))}</dd>
          ${p.location.readOnly ? '<dt>Access</dt><dd>read-only folder: tasks can read it; results are never applied back</dd>' : ''}
          <dt>Working mode</dt><dd>${esc(p.settings.workingMode || '—')}${p.settings.defaultRef ? ` · ref ${esc(p.settings.defaultRef)}` : ''}</dd>
          <dt>Created</dt><dd>${esc(ago(p.createdAt))}${p.migratedFrom ? ' · created from earlier runs' : ''}</dd><dt>Last used</dt><dd>${esc(ago(p.lastUsedAt))}</dd></dl></div>
        <div class="card"><h3>Repository</h3>${g.isGit || p.kind === 'remote' ? `<dl class="kv" id="proj-git">
          ${g.isGit ? `<dt>Branch</dt><dd>${esc(g.branch || 'detached')}</dd><dt>Working tree</dt><dd>${g.dirty ? `${g.counts.staged} staged · ${g.counts.unstaged} modified · ${g.counts.untracked} untracked` : 'clean'}</dd>` : ''}
          <dt>Remote</dt><dd class="mono">${esc((g.remotes?.[0]?.url) || p.repo.remoteUrl || (p.kind === 'remote' ? p.location.url : '— none'))}</dd>
          <dt>Default branch</dt><dd>${esc(p.repo.defaultBranch || '—')}</dd>
          ${p.repo.firstCommit ? `<dt>Identity</dt><dd class="mono" title="First commit: how da-prompt knows it is the same repository">${esc(p.repo.firstCommit)}</dd>` : ''}</dl>` : '<p class="muted">Not a Git repository.</p>'}</div></div>
      <div class="card"><h3>Run history <span class="muted">(${runs.length})</span></h3>${runs.length ? `<ul class="plain" id="proj-runs">${runs.slice(0, 20).map((r) => `<li><a href="#/runs/${esc(r.id)}">${esc(r.title)}</a> <span class="pill ${esc(r.status)}">${esc(String(r.status).replace(/_/g, ' '))}</span> <span class="muted">${esc(ago(r.createdAt))}</span></li>`).join('')}</ul>` : '<p class="muted">No runs yet. Start a task to begin the history.</p>'}</div>
      <div class="card danger-zone"><h3>Remove this registration</h3><p>Forgets the project in da-prompt. <strong>Your folder or repository, its runs and artifacts are not deleted.</strong> Past runs keep their project id.</p>
        <form id="proj-remove"><label class="field"><span>Type the project name to confirm</span><input name="confirm" autocomplete="off"></label><button class="btn danger" type="submit" disabled>Remove registration</button></form></div></section>`;

    const act = async (fn, okMsg) => {
      try {
        await fn();
        if (okMsg) toast(okMsg);
        await detail(pid);
      } catch (e) {
        toast(e.message);
      }
    };
    $('#proj-rename').addEventListener('click', () => {
      const h = $('#proj-name');
      h.outerHTML = `<form id="rename-form" class="inline"><input id="rename-input" value="${esc(p.name)}" maxlength="80" aria-label="Project name"><button class="btn accent" type="submit">Save</button><button class="btn" type="button" id="rename-cancel">Cancel</button></form>`;
      $('#proj-rename').hidden = true;
      $('#rename-input').focus();
      $('#rename-cancel').addEventListener('click', () => detail(pid));
      $('#rename-form').addEventListener('submit', (e) => { e.preventDefault(); act(() => call(`/${encodeURIComponent(pid)}`, { method: 'PATCH', body: { name: $('#rename-input').value } }), 'Renamed'); });
    });
    $('#proj-validate').addEventListener('click', () => act(() => call(`/${encodeURIComponent(pid)}/validate`, { method: 'POST', body: {} }), 'Checked'));
    $('#proj-archive')?.addEventListener('click', () => act(() => call(`/${encodeURIComponent(pid)}/archive`, { method: 'POST', body: {} }), 'Archived: history is kept; no new work starts until you restore it'));
    $('#proj-restore')?.addEventListener('click', () => act(() => call(`/${encodeURIComponent(pid)}/restore`, { method: 'POST', body: {} }), 'Restored'));
    const rm = $('#proj-remove');
    rm.confirm.addEventListener('input', () => { rm.querySelector('button').disabled = rm.confirm.value !== p.name; });
    rm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await call(`/${encodeURIComponent(pid)}`, { method: 'DELETE', body: { confirm: rm.confirm.value } });
        toast('Registration removed; nothing was deleted');
        location.hash = '#/projects';
      } catch (er) {
        toast(er.message);
      }
    });
    if ($('#proj-fix')) await fixPanel(p, pid, act);
  }

  /** Repair controls: choose another folder (or accept a changed remote), with explicit confirmation of identity changes. */
  async function fixPanel(p, pid, act) {
    const box = $('#proj-fix');
    const codes = new Set(p.errors.map((e) => e.code));
    if (p.kind === 'remote') {
      box.innerHTML = '<p class="muted">Check the repository URL or the GitHub token in Settings, then Re-check.</p>';
      return;
    }
    let dirs = [];
    let admin = false;
    try { [dirs, admin] = await Promise.all([api('api/projects/directories').then((d) => d.directories), api('api/system/status').then((s) => s.admin).catch(() => false)]); } catch { /* shown below */ }
    box.innerHTML = `${codes.has('remote_changed') ? '<button class="btn" id="accept-remote">Accept the new remote</button> ' : ''}
      <form id="repair-form" class="proj-form"><h4>Point this project at another folder</h4>
        <label class="field"><span>Authorized folder</span><select name="directoryId">${dirs.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}${d.git?.isGit ? ` — git · ${esc(d.git.branch || 'detached')}` : ''}</option>`).join('')}</select></label>
        ${admin ? '<label class="field"><span>…or a path inside an authorized folder</span><input name="path" placeholder="/Users/me/code/moved-repo"></label>' : ''}
        <div id="repair-msg" role="alert" hidden></div>
        <button class="btn accent" type="submit">Repair location</button></form>`;
    $('#accept-remote')?.addEventListener('click', () => act(() => call(`/${encodeURIComponent(pid)}`, { method: 'PATCH', body: { acceptRemoteChange: true } }), 'Remote accepted'));
    const form = $('#repair-form');
    const submit = async (extra = {}) => {
      const fd = new FormData(form);
      const body = String(fd.get('path') || '').trim() ? { path: String(fd.get('path')).trim() } : { directoryId: fd.get('directoryId') };
      const msg = $('#repair-msg');
      try {
        await call(`/${encodeURIComponent(pid)}/repair`, { method: 'POST', body: { ...body, ...extra } });
        await act(async () => {}, 'Location repaired');
      } catch (e) {
        const c = e.body?.conflicts?.[0];
        msg.hidden = false;
        msg.className = 'card callout warn';
        msg.innerHTML = `<p><strong>${esc(e.message)}</strong></p>${c ? `<p>${esc(c.resolution || '')}</p>` : ''}${c?.type === 'identity_mismatch' ? '<button type="button" class="btn danger" data-accept>Use this folder anyway (replaces the recorded identity)</button>' : ''}`;
        msg.querySelector('[data-accept]')?.addEventListener('click', () => submit({ acceptDifferentRepository: true }));
      }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }
}
