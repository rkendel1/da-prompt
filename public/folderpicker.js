// Folder picker: browse the server machine's folders (administrator sessions only) and choose a project folder.
// The browser still never sends a path to start a run: choosing returns an opaque directory id.

import { esc } from './providers.js';

/** Resolves to { id, name, readOnly } for the chosen folder, or null if the dialog was cancelled. */
export function chooseFolder(api, { start = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'task-dialog folder-dialog';
    dlg.setAttribute('aria-label', 'Choose a project folder');
    document.body.append(dlg);
    let result = null;
    let cur = null;
    let hidden = false;

    const crumbs = (p) => {
      const segs = p.split('/').filter(Boolean);
      return [{ name: '/', path: '/' }, ...segs.map((s, i) => ({ name: s, path: `/${segs.slice(0, i + 1).join('/')}` }))]
        .map((c) => `<button type="button" class="crumb" data-go="${esc(c.path)}">${esc(c.name)}</button>`).join('<span class="muted">›</span>');
    };

    const load = async (path) => {
      const body = dlg.querySelector('.fp-body');
      if (body) body.setAttribute('aria-busy', 'true');
      try {
        cur = await api(`api/projects/browse?path=${encodeURIComponent(path || '')}${hidden ? '&hidden=1' : ''}`);
        draw();
      } catch (e) {
        if (!cur) cur = { path: path || '', entries: [], error: e.message };
        else cur = { ...cur, error: e.message };
        draw();
      }
    };

    const draw = () => {
      const c = cur;
      dlg.innerHTML = `<div class="task-form">
        <h2>Choose a project folder</h2>
        <div class="fp-crumbs" aria-label="Current location">${crumbs(c.path || '/')}</div>
        <div class="actions" style="justify-content:flex-start;margin:6px 0">
          ${c.parent ? '<button type="button" class="btn small" data-go-parent>↑ Up</button>' : ''}
          ${c.home ? '<button type="button" class="btn small" data-go-home>Home</button>' : ''}
          <label class="field check" style="margin:0"><input type="checkbox" id="fp-hidden" ${hidden ? 'checked' : ''}> <span>Show hidden folders</span></label>
        </div>
        ${c.error ? `<p class="error" role="alert">${esc(c.error)}</p>` : ''}
        <ul class="fp-list plain" role="listbox" aria-label="Folders">
          ${(c.entries || []).map((e) => `<li><button type="button" class="fp-item" data-open="${esc(e.name)}">📁 ${esc(e.name)}${e.isGit ? ' <span class="pill completed">git</span>' : ''}</button></li>`).join('') || '<li class="muted fp-empty">No sub-folders here.</li>'}
        </ul>
        ${c.truncated ? '<p class="hint">Only the first 500 folders are shown.</p>' : ''}
        <p class="hint">${c.path ? `Selected: <code>${esc(c.path)}</code>${c.isGit ? ' · git repository' : ''}` : ''}</p>
        ${c.path && !c.authorized && !c.error ? `<p class="hint"><b>Not authorized yet.</b> Choosing this folder authorizes its parent folder (or the folder itself, if it sits directly under your home directory) as a project folder, so da-prompt can list and copy projects from there. Runs never write into your folder; results are applied only if you choose to.</p>` : ''}
        <div class="actions">
          <button type="button" class="btn" data-cancel>Cancel</button>
          <button type="button" class="primary" data-choose ${c.path && !c.error ? '' : 'disabled'}>${c.authorized ? 'Use this folder' : 'Authorize and use this folder'}</button>
        </div>
      </div>`;
    };

    const choose = async (authorize) => {
      const btn = dlg.querySelector('[data-choose]');
      btn.disabled = true;
      try {
        result = await api('api/projects/pick', { method: 'POST', body: JSON.stringify({ path: cur.path, authorize }) });
        dlg.close();
      } catch (e) {
        cur = { ...cur, error: e.message };
        draw();
      }
    };

    dlg.addEventListener('click', (ev) => {
      const t = ev.target.closest('button');
      if (!t || !dlg.contains(t)) return;
      if (t.dataset.go !== undefined) load(t.dataset.go);
      else if (t.dataset.open !== undefined) load(`${cur.path.replace(/\/$/, '')}/${t.dataset.open}`);
      else if ('goParent' in t.dataset) load(cur.parent);
      else if ('goHome' in t.dataset) load(cur.home);
      else if ('cancel' in t.dataset) dlg.close();
      else if ('choose' in t.dataset) choose(!cur.authorized);
    });
    dlg.addEventListener('change', (ev) => {
      if (ev.target.id === 'fp-hidden') {
        hidden = ev.target.checked;
        load(cur.path);
      }
    });
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });
    dlg.showModal();
    dlg.innerHTML = '<p class="muted" style="padding:12px">Loading folders…</p>';
    load(start);
  });
}
