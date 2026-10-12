// da-prompt factory UI. No framework: hash routing, fetch, EventSource.
import { mountModelPicker, renderProvidersPage } from './providers.js';

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LAYER_NAMES = { plan: 'Plan', agents: 'Agents', execution: 'Execution', artifacts: 'Artifacts', verification: 'Verification', feedback: 'Feedback', completion: 'Completion' };
const ACTIVE = new Set(['queued', 'planning', 'running', 'completing']);
const EXAMPLES = [
  'A shared reading list for book clubs',
  'A habit tracker with daily check-ins',
  'An internal tool to track equipment loans',
  'A packing checklist for trips',
];

let config = null;
let current = null; // { id, run, events, es, tab, selectedTask, file }

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};
const dur = (a, b) => {
  if (!a) return '';
  const s = Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));
const statusLabel = (s) => String(s || '').replace(/_/g, ' ');

// ── Sidebar ─────────────────────────────────────────────────────────────────────────────────
async function refreshRuns() {
  try {
    const { runs } = await api('api/runs');
    const nav = $('#runs');
    nav.innerHTML = runs.length
      ? runs.map((r) => `<a href="#/runs/${esc(r.id)}" ${current?.id === r.id ? 'aria-current="page"' : ''}>
          <span class="dot ${esc(r.status)}" title="${esc(statusLabel(r.status))}"></span>
          <span class="t">${esc(r.title)}</span>
          <span class="m">${esc(statusLabel(r.status))} · ${r.tasks ? `${r.completedTasks}/${r.tasks} tasks · ` : ''}${esc(ago(r.createdAt))}</span>
        </a>`).join('')
      : '<p class="empty">No runs yet.</p>';
  } catch {
    /* ignore */
  }
}

// ── Router ──────────────────────────────────────────────────────────────────────────────────
function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  if (current?.es) current.es.close();
  const m = hash.match(/^\/runs\/([\w-]+)/);
  if (m) {
    current = { id: m[1], events: [], tab: 'overview', selectedTask: null, file: null };
    renderRunShell();
  } else if (hash === '/prompt') {
    current = null;
    renderPrompt();
  } else if (hash === '/providers') {
    current = null;
    renderProvidersPage(main, api, toast);
  } else {
    current = null;
    renderNew();
  }
  refreshRuns();
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

// ── New run ─────────────────────────────────────────────────────────────────────────────────
function renderNew() {
  main.replaceChildren($('#tpl-new').content.cloneNode(true));
  document.title = 'New run · da-prompt';
  const form = $('#new-form');
  $('#examples').innerHTML = EXAMPLES.map((e) => `<button type="button" class="chip">${esc(e)}</button>`).join('');
  $('#examples').addEventListener('click', (e) => {
    if (e.target.matches('.chip')) {
      form.idea.value = e.target.textContent;
      form.idea.focus();
    }
  });
  const picker = mountModelPicker($('#model-picker'), api);
  form.maxParallel.value = config.defaults.maxParallel;
  form.maxAttempts.value = config.defaults.maxAttempts;
  form.tokenBudget.value = config.defaults.tokenBudget;
  $('#repo-field').hidden = !config.gitPush;
  if (config.outputRoot) $('#output-dir').placeholder = `folder name inside ${config.outputRoot}`;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#form-error');
    err.hidden = true;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const fd = new FormData(form);
    const choice = (await picker).getChoice();
    const body = {
      ...choice,
      idea: fd.get('idea'),
      requirements: fd.get('requirements'),
      stack: fd.get('stack'),
      limits: fd.get('limits'),
      tools: fd.get('tools'),
      repoUrl: fd.get('repoUrl') || undefined,
      outputDir: fd.get('outputDir') || undefined,
      settings: {
        maxParallel: Number(fd.get('maxParallel')),
        maxAttempts: Number(fd.get('maxAttempts')),
        tokenBudget: Number(fd.get('tokenBudget')),
        deploy: fd.get('deploy') === 'on',
      },
    };
    try {
      const { run } = await api('api/runs', { method: 'POST', body: JSON.stringify(body) });
      location.hash = `#/runs/${run.id}`;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

// ── Prompt view ─────────────────────────────────────────────────────────────────────────────
async function renderPrompt() {
  document.title = 'Operating prompt · da-prompt';
  const { template } = await api('api/prompt');
  const html = esc(template).replace(/(&lt;\/?[a-z_0-9]+&gt;)/g, '<span class="t">$1</span>');
  main.innerHTML = `<section class="page prompt-view">
    <p class="eyebrow">operating prompt · rendered into every planner and agent call</p>
    <div class="run-head"><h1>The factory's prompt</h1><div class="actions"><button class="btn" id="copy">Copy prompt</button></div></div>
    <div class="card"><pre>${html}</pre></div></section>`;
  $('#copy').onclick = async () => {
    await navigator.clipboard.writeText(template).catch(() => {});
    toast('Prompt copied');
  };
}

// ── Run view ────────────────────────────────────────────────────────────────────────────────
async function renderRunShell() {
  main.innerHTML = '<section class="page"><p class="muted">Loading run…</p></section>';
  try {
    const { run } = await api(`api/runs/${current.id}`);
    current.run = run;
  } catch (e) {
    main.innerHTML = `<section class="page empty-state"><h2>Run not found</h2><p>${esc(e.message)}</p><a class="btn" href="#/">New run</a></section>`;
    return;
  }
  main.innerHTML = '<section class="page"><div id="run"></div><div id="tab"></div></section>';
  renderRun();
  connect();
}

function connect() {
  const id = current.id;
  const es = new EventSource(`api/runs/${id}/events`);
  current.es = es;
  let pending = null;
  es.onmessage = (msg) => {
    if (current?.id !== id) return es.close();
    const e = JSON.parse(msg.data);
    current.events.push(e);
    if (current.tab === 'activity') appendFeed(e);
    updateTabCounts();
    if (pending) return;
    pending = setTimeout(async () => {
      pending = null;
      if (current?.id !== id) return;
      try {
        current.run = (await api(`api/runs/${id}`)).run;
        renderRun({ keepTab: true });
        if (['run.status', 'plan'].includes(e.type)) refreshRuns();
      } catch {
        /* transient */
      }
    }, 250);
  };
}

function renderRun({ keepTab = false } = {}) {
  const run = current.run;
  const root = $('#run');
  if (!root) return;
  document.title = `${run.title} · da-prompt`;
  const tasks = run.plan?.tasks || [];
  const done = tasks.filter((t) => t.status === 'completed').length;
  const escalated = tasks.filter((t) => t.status === 'escalated');
  const canResume = !run.executing && ['needs_attention', 'interrupted', 'failed', 'cancelled'].includes(run.status);
  const tokens = (run.usage?.input || 0) + (run.usage?.output || 0);

  root.innerHTML = `
    <div class="run-head">
      <div>
        <p class="eyebrow">run ${esc(run.id)} · ${esc(run.providerLabel || run.provider)} · ${esc(run.model)}${plannerLabel(run)}</p>
        <h1>${esc(run.title)} <span class="pill ${esc(run.status)}">${esc(statusLabel(run.status))}</span></h1>
        <div class="meta">
          <span>${tasks.length ? `${done}/${tasks.length} tasks` : 'planning'}</span>
          <span>${fmtNum(tokens)} tokens · ${run.usage?.calls || 0} calls</span>
          <span>${esc(dur(run.startedAt || run.createdAt, run.finishedAt))}</span>
          <span>${esc(run.settings.maxParallel)} parallel · ${esc(run.settings.maxAttempts)} attempts</span>
        </div>
      </div>
      <div class="actions">
        ${run.previewLive ? `<a class="btn accent" href="preview/${esc(run.id)}/" target="_blank" rel="noopener">Open app ↗</a>` : ''}
        ${!run.previewLive && run.deployment?.ok && !run.executing ? '<button class="btn" data-act="deploy">Restart preview</button>' : ''}
        ${run.executing ? '<button class="btn danger" data-act="cancel">Cancel</button>' : ''}
        ${canResume ? '<button class="btn" data-act="resume">Resume</button>' : ''}
        ${run.delivery?.archive ? `<a class="btn" href="api/runs/${esc(run.id)}/download/project.tar.gz">Download code</a>` : ''}
        ${!run.executing ? '<button class="btn danger" data-act="delete" title="Delete run">Delete</button>' : ''}
      </div>
    </div>
    <div class="rail" role="list" aria-label="Factory layers">
      ${Object.entries(LAYER_NAMES).map(([k, name], i) => {
        const st = run.layers?.[k] || 'pending';
        const label = st === 'pending' && k === 'feedback' && run.layers.completion !== 'pending' ? 'not needed' : st;
        return `<div class="layer ${esc(st)}" role="listitem"><span class="n">0${i + 1}</span><span class="name">${name}</span><span class="st">${esc(label)}</span></div>`;
      }).join('')}
    </div>
    ${run.error ? `<div class="card escalation" style="margin-bottom:16px"><h3>Run stopped</h3><p>${esc(run.error)}</p>${canResume ? '<p class="muted">Resume to continue from where it stopped.</p>' : ''}</div>` : ''}
    <div class="tabs" role="tablist">
      ${[['overview', 'Overview'], ['graph', 'Task graph'], ['activity', 'Activity'], ['files', 'Files'], ['delivery', 'Delivery']]
        .map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${current.tab === k}">${l}<span class="count" data-count="${k}"></span></button>`).join('')}
    </div>`;

  root.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => {
    current.tab = b.dataset.tab;
    renderRun();
  }));
  root.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => act(b.dataset.act, b)));
  updateTabCounts();
  const tab = $('#tab');
  // Live updates re-render the overview and graph; files/activity/delivery keep their state.
  const live = ['overview', 'graph'].includes(current.tab) || (current.tab === 'delivery' && !tab.dataset.delivered && run.delivery);
  if (keepTab && !live && tab.dataset.tab === current.tab) return;
  tab.dataset.tab = current.tab;
  tab.dataset.delivered = run.delivery ? '1' : '';
  ({ overview: renderOverview, graph: renderGraph, activity: renderActivity, files: renderFiles, delivery: renderDelivery })[current.tab](tab, run, escalated);
}

function updateTabCounts() {
  const run = current?.run;
  if (!run) return;
  const set = (k, v) => {
    const el = document.querySelector(`[data-count="${k}"]`);
    if (el) el.textContent = v ? String(v) : '';
  };
  set('graph', run.plan?.tasks.length);
  set('activity', current.events.length);
}

async function act(action, btn) {
  const id = current.id;
  btn.disabled = true;
  try {
    if (action === 'cancel') await api(`api/runs/${id}/cancel`, { method: 'POST' });
    if (action === 'resume') await api(`api/runs/${id}/resume`, { method: 'POST' });
    if (action === 'deploy') {
      toast('Starting preview…');
      await api(`api/runs/${id}/deploy`, { method: 'POST' });
      toast('Preview is live');
    }
    if (action === 'delete') {
      if (!confirm('Delete this run, its workspace and its delivery files?')) return void (btn.disabled = false);
      await api(`api/runs/${id}`, { method: 'DELETE' });
      location.hash = '#/';
      return;
    }
    current.run = (await api(`api/runs/${id}`)).run;
    renderRun();
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
}

async function taskAction(taskId, action, body = {}) {
  try {
    await api(`api/runs/${current.id}/tasks/${encodeURIComponent(taskId)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
    toast(action === 'skip' ? `Skipped ${taskId}; continuing` : `Retrying ${taskId}`);
    current.run = (await api(`api/runs/${current.id}`)).run;
    renderRun();
  } catch (e) {
    toast(e.message);
  }
}

// Overview ---------------------------------------------------------------------------------
function renderOverview(el, run, escalated) {
  const p = run.plan;
  const tasks = p?.tasks || [];
  const checklist = run.checklist?.length
    ? run.checklist
    : ['All core features work and are tested', 'Full test suite passes', 'No critical errors or security issues', 'Deployment is successful (URL or clear instructions)', 'Documentation is updated', 'Final summary and next steps provided'].map((label) => ({ label, pending: true }));
  el.innerHTML = `
    ${escalated.map((t) => `
      <div class="card escalation" style="margin-bottom:16px">
        <h3>Escalated: ${esc(t.id)} — ${esc(t.title)}</h3>
        <p>Failed verification ${t.attempts.length} time(s). Latest error:</p>
        <pre class="out">${esc(t.escalation?.reason || t.error || '')}</pre>
        <div class="opts">
          ${run.executing ? '<span class="muted">Waiting for in-flight tasks to finish…</span>' : `
          <button class="btn" data-task="${esc(t.id)}" data-do="retry">Retry with fresh attempts</button>
          <button class="btn" data-task="${esc(t.id)}" data-do="edit">Edit spec &amp; retry</button>
          <button class="btn" data-task="${esc(t.id)}" data-do="skip">Skip and continue</button>`}
        </div>
      </div>`).join('')}
    <div class="stats" style="margin-bottom:16px">
      <div class="stat"><b>${tasks.filter((t) => t.status === 'completed').length}/${tasks.length || '–'}</b><span>tasks verified</span></div>
      <div class="stat"><b>${tasks.reduce((n, t) => n + (t.attempts?.length || 0), 0)}</b><span>agent attempts</span></div>
      <div class="stat"><b>${run.lessons?.length || 0}</b><span>lessons recorded</span></div>
      <div class="stat"><b>${run.agents?.length || '–'}</b><span>agent roles</span></div>
    </div>
    <div class="grid-2">
      <div class="stack">
        <div class="card">
          <h2>${p ? esc(p.product.name) : 'Planning…'}</h2>
          <p>${p ? esc(p.product.summary) : esc(run.inputs.idea)}</p>
          ${p ? `<h3>Success criteria</h3><ul class="plain">${p.product.successCriteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
          ${p?.product.users?.length ? `<h3 style="margin-top:14px">Users</h3><ul class="plain">${p.product.users.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
        </div>
        ${run.summary ? `<div class="card md"><h2>Final summary</h2>${md(run.summary)}</div>` : ''}
        ${run.lessons?.length ? `<div class="card"><h2>Lessons (CLAUDE.md)</h2><ul class="plain">${run.lessons.map((l) => `<li>${esc(l.text)}</li>`).join('')}</ul></div>` : ''}
      </div>
      <div class="stack">
        <div class="card">
          <h2>Completion checklist</h2>
          <ul class="checklist">${checklist.map((c) => `<li><span class="ic ${c.pending ? 'pending' : c.ok ? 'ok' : 'no'}">${c.pending ? '○' : c.ok ? '✓' : '✗'}</span><span>${esc(c.label)}</span>${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</li>`).join('')}</ul>
        </div>
        ${run.deployment ? `<div class="card"><h2>Deployment</h2>
          ${run.deployment.ok && run.previewLive ? `<p><a class="btn accent" href="preview/${esc(run.id)}/" target="_blank" rel="noopener">Open the running app ↗</a></p>` : ''}
          <p class="mono">$ ${esc(run.deployment.start)}<br>health ${esc(run.deployment.healthPath)} → ${run.deployment.ok ? esc(run.deployment.status) : esc(run.deployment.error || 'not running')}</p>
          ${run.deployment.ok && !run.previewLive ? '<p class="muted">The preview process has stopped. Use Restart preview.</p>' : ''}
        </div>` : ''}
        ${p?.risks?.length || p?.openQuestions?.length ? `<div class="card">
          ${p.risks.length ? `<h3>Risks</h3><ul class="plain">${p.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
          ${p.openQuestions.length ? `<h3 style="margin-top:12px">Open questions</h3><ul class="plain">${p.openQuestions.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        </div>` : ''}
      </div>
    </div>`;
  el.querySelectorAll('[data-do]').forEach((b) => (b.onclick = () => {
    const t = tasks.find((x) => x.id === b.dataset.task);
    if (b.dataset.do === 'edit') {
      const description = prompt(`Edit the spec for ${t.id}:`, t.description);
      if (description == null) return;
      const verify = prompt('Verify commands (separate with ;; ):', (t.verify || []).join(' ;; '));
      if (verify == null) return;
      taskAction(t.id, 'retry', { description, verify: verify.split(';;').map((v) => v.trim()).filter(Boolean) });
    } else taskAction(t.id, b.dataset.do);
  }));
}

// Graph --------------------------------------------------------------------------------------
function renderGraph(el, run) {
  const tasks = run.plan?.tasks || [];
  if (!tasks.length) {
    el.innerHTML = '<div class="card empty-state">The planner is drawing the task graph…</div>';
    return;
  }
  const W = 236, H = 64, GX = 70, GY = 18, PAD = 20;
  const byLevel = {};
  for (const t of tasks) (byLevel[t.level || 0] ||= []).push(t);
  const nLevels = Math.max(...Object.keys(byLevel).map(Number)) + 1;
  const maxRows = Math.max(...Object.values(byLevel).map((a) => a.length));
  const width = PAD * 2 + nLevels * W + (nLevels - 1) * GX;
  const height = PAD * 2 + 22 + maxRows * H + (maxRows - 1) * GY;
  const pos = {};
  for (const [lvl, arr] of Object.entries(byLevel)) {
    const colH = arr.length * H + (arr.length - 1) * GY;
    const y0 = PAD + 22 + (maxRows * H + (maxRows - 1) * GY - colH) / 2;
    arr.forEach((t, i) => (pos[t.id] = { x: PAD + Number(lvl) * (W + GX), y: y0 + i * (H + GY) }));
  }
  const edges = tasks.flatMap((t) => (t.dependsOn || []).map((d) => {
    const a = pos[d], b = pos[t.id];
    if (!a || !b) return '';
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
    const live = tasks.find((x) => x.id === d)?.status === 'completed';
    return `<path class="edge ${live ? 'live' : ''}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 6},${y2}" marker-end="url(#arr)"/>`;
  })).join('');
  const levelsLbl = Array.from({ length: nLevels }, (_, i) => `<text class="lvl" x="${PAD + i * (W + GX)}" y="${PAD + 8}">LEVEL ${i}${byLevel[i]?.length > 1 ? ` · ${byLevel[i].length} PARALLEL` : ''}</text>`).join('');
  const nodes = tasks.map((t) => {
    const { x, y } = pos[t.id];
    const att = t.attempts?.length ? ` · ${t.attempts.length} ${t.attempts.length === 1 ? 'try' : 'tries'}` : '';
    const title = t.title.length > 28 ? `${t.title.slice(0, 27)}…` : t.title;
    return `<g class="node ${esc(t.status)} ${current.selectedTask === t.id ? 'sel' : ''}" data-id="${esc(t.id)}" tabindex="0" role="button" aria-label="${esc(t.id)}: ${esc(t.title)}, ${esc(t.status)}">
      <rect x="${x}" y="${y}" width="${W}" height="${H}" rx="10"/>
      <rect class="bar" x="${x}" y="${y + 10}" width="3" height="${H - 20}" rx="1.5"/>
      <text class="nt" x="${x + 14}" y="${y + 26}">${esc(title)}</text>
      <text class="nr" x="${x + 14}" y="${y + 46}">${esc(t.id)} · ${esc(t.role)}${att}</text>
    </g>`;
  }).join('');
  el.innerHTML = `<div class="graph-wrap"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Task dependency graph">
      <defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--line-2)"/></marker></defs>
      ${levelsLbl}${edges}${nodes}</svg></div>
    <div id="task-detail"></div>`;
  el.querySelectorAll('.node').forEach((n) => {
    const pick = () => {
      current.selectedTask = n.dataset.id;
      renderRun();
    };
    n.onclick = pick;
    n.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick());
  });
  const sel = tasks.find((t) => t.id === current.selectedTask) || tasks.find((t) => t.status === 'running') || tasks.find((t) => t.status === 'escalated');
  if (sel) renderTaskDetail($('#task-detail'), sel, run);
  else $('#task-detail').innerHTML = '<p class="muted" style="margin-top:12px">Select a task to see its spec, attempts and verification results.</p>';
}

function renderTaskDetail(el, t, run) {
  el.innerHTML = `<div class="card task-detail">
    <div class="run-head" style="margin-bottom:12px"><h2 style="margin:0">${esc(t.id)} — ${esc(t.title)} <span class="pill ${esc(t.status)}">${esc(t.status)}</span></h2>
      ${t.status === 'escalated' && !run.executing ? `<div class="actions"><button class="btn" data-do="retry">Retry</button><button class="btn" data-do="skip">Skip</button></div>` : ''}</div>
    <div class="kv">
      <b>role</b><span>${esc(t.role)}</span>
      <b>depends on</b><span>${esc((t.dependsOn || []).join(', ') || '—')}</span>
      <b>spec</b><span>${esc(t.description)}</span>
      <b>acceptance</b><span><ul class="plain">${t.acceptance.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></span>
      ${t.outputs?.length ? `<b>outputs</b><span class="mono">${t.outputs.map(esc).join(', ')}</span>` : ''}
      <b>verify</b><span class="mono">${(t.verify || []).map((v) => `$ ${esc(v)}`).join('<br>') || '—'}</span>
      ${t.result ? `<b>result</b><span>${esc(t.result.summary)}</span><b>files</b><span class="mono">${esc((t.result.files || []).join(', '))}</span>` : ''}
    </div>
    ${(t.attempts || []).map((a) => `<div class="attempt">
      <h4>Attempt ${a.n} <span class="pill ${a.ok ? 'completed' : a.finishedAt ? 'failed' : 'running'}">${a.ok ? 'verified' : a.finishedAt ? 'failed' : 'in progress'}</span><span class="muted mono">${esc(dur(a.startedAt, a.finishedAt))}</span></h4>
      ${a.error ? `<p>${esc(a.error)}</p>` : ''}
      ${(a.verification || []).map((v) => `<div class="vcheck"><span class="${v.ok ? 'ok' : 'no'}" style="color:var(--${v.ok ? 'ok' : 'bad'})">${v.ok ? '✓' : '✗'}</span><span>${esc(v.command)}</span></div>
        ${!v.ok && v.output ? `<pre class="out">${esc(v.output)}</pre>` : ''}`).join('')}
    </div>`).join('')}
  </div>`;
  el.querySelectorAll('[data-do]').forEach((b) => (b.onclick = () => taskAction(t.id, b.dataset.do)));
}

// Activity ----------------------------------------------------------------------------------
function plannerLabel(r) {
  const other = r.plannerProvider && r.plannerProvider !== r.provider;
  if (!other && (!r.plannerModel || r.plannerModel === r.model)) return '';
  return ` · planner ${esc(other ? `${r.plannerProviderLabel || r.plannerProvider} ` : '')}${esc(r.plannerModel)}`;
}

function describe(e) {
  const who = e.taskId ? `${e.taskId}${e.role ? ` · ${e.role}` : ''}` : 'factory';
  switch (e.type) {
    case 'run.created': return [who, `Run created · ${esc(e.provider)} · ${esc(e.model || '')}${plannerLabel(e)}${e.outputDir ? ` · output ${esc(e.outputDir)}` : ''}`];
    case 'output': return [who, e.ok ? `Project delivered to ${esc(e.dir)}` : `Delivery to ${esc(e.dir)} failed: ${esc(e.error)}`, e.ok ? 'ok' : 'bad'];
    case 'run.status': return [who, `Status → <b>${esc(statusLabel(e.status))}</b>${e.note ? ` — ${esc(e.note)}` : ''}`];
    case 'layer': return [who, `Layer <b>${esc(LAYER_NAMES[e.layer] || e.layer)}</b>: ${esc(e.state)}`, e.state === 'done' ? 'ok' : e.state === 'failed' ? 'warn' : ''];
    case 'plan': return [who, `Plan ready: ${e.tasks} tasks across ${e.levels} levels`, 'ok'];
    case 'agents': return [who, `Agents: ${esc(e.roles.join(', '))}`];
    case 'task': return [who, `Task ${esc(e.status)}${e.attempt ? ` (attempt ${e.attempt})` : ''}${e.summary ? ` — ${esc(e.summary)}` : ''}${e.blockedBy ? ` by ${esc(e.blockedBy)}` : ''}`, e.status === 'completed' ? 'ok' : e.status === 'blocked' ? 'warn' : ''];
    case 'agent.message': return [who, `<span class="muted">“${esc(e.text)}”</span>`];
    case 'tool': {
      const label = e.tool === 'run_command' ? `$ ${esc(e.input?.command)}` : `${esc(e.tool)} ${esc(e.input?.path || '')}${e.input?.bytes != null ? ` <span class="muted">(${e.input.bytes}b)</span>` : ''}`;
      return [who, e.output && e.tool === 'run_command' ? `<details><summary class="${e.ok ? '' : 'bad'}">${label}${e.ok ? '' : ` → exit ${e.exitCode}`}</summary><pre class="out">${esc(e.output)}</pre></details>` : `<span class="${e.ok ? '' : 'bad'}">${label}</span>`];
    }
    case 'verify': return [e.taskId === '_final' ? 'final checks' : who, e.results.map((r) => `<span class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '✗'}</span> ${esc(r.command)}`).join('<br>')];
    case 'feedback': return [who, `Feedback: ${esc(e.headline)}${e.willRetry ? ' — sending error to agent and retrying' : ''}`, 'warn'];
    case 'lesson': return [who, `Lesson → CLAUDE.md: ${esc(e.text)}`, 'lesson'];
    case 'escalation': return [who, `Escalated after retries: ${esc(e.reason)}`, 'bad'];
    case 'escalation.resolved': return [who, `Escalation resolved: ${esc(e.action)}`];
    case 'checklist': return [who, e.items.map((i) => `<span class="${i.ok ? 'ok' : 'bad'}">${i.ok ? '✓' : '✗'}</span> ${esc(i.label)}`).join('<br>')];
    case 'deploy': return [who, e.ok ? `Deployed — live preview at <a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url)}</a>` : `Deploy failed: ${esc(e.error)}`, e.ok ? 'ok' : 'bad'];
    case 'deliver': return [who, `Delivered: ${esc([e.report, e.tests, e.archive].filter(Boolean).join(', '))}`, 'ok'];
    case 'git': return [who, e.ok ? `Pushed to ${esc(e.repoUrl)}` : `Git push failed: ${esc(e.error)}`, e.ok ? 'ok' : 'bad'];
    case 'error': return [who, esc(e.message), 'bad'];
    case 'log': return [who, esc(e.text), e.level === 'warn' ? 'warn' : ''];
    default: return [who, esc(e.type)];
  }
}

function feedItem(e) {
  const [who, what, cls = ''] = describe(e);
  const li = document.createElement('li');
  li.dataset.task = e.taskId || '';
  li.innerHTML = `<time>${esc(new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }))}</time><span class="who">${esc(who)}</span><span class="what ${cls}">${what}</span>`;
  return li;
}

function renderActivity(el, run) {
  const tasks = run.plan?.tasks || [];
  el.innerHTML = `<div class="feed-tools"><label class="muted mono" for="ff">Show</label>
    <select id="ff"><option value="">all events</option>${tasks.map((t) => `<option value="${esc(t.id)}">${esc(t.id)} — ${esc(t.title)}</option>`).join('')}</select>
    <label class="muted mono"><input type="checkbox" id="fv" ${current.verbose ? 'checked' : ''}> agent tool calls</label></div>
    <div class="card" style="padding:8px 14px"><ul class="feed" id="feed"></ul></div>`;
  const sel = $('#ff');
  sel.value = current.feedFilter || '';
  sel.onchange = () => {
    current.feedFilter = sel.value;
    renderActivity(el, run);
  };
  $('#fv').onchange = (e) => {
    current.verbose = e.target.checked;
    renderActivity(el, run);
  };
  const feed = $('#feed');
  current.events.forEach((e) => appendFeed(e, feed));
  if (!current.events.length) feed.innerHTML = '<li class="muted">Waiting for events…</li>';
}

function appendFeed(e, feed = $('#feed')) {
  if (!feed) return;
  if (current.feedFilter && e.taskId !== current.feedFilter) return;
  if (!current.verbose && (e.type === 'tool' && e.tool !== 'run_command')) return;
  if (feed.firstElementChild?.classList.contains('muted')) feed.innerHTML = '';
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  feed.append(feedItem(e));
  if (nearBottom && current.run && ACTIVE.has(current.run.status)) window.scrollTo(0, document.body.scrollHeight);
}

// Files -------------------------------------------------------------------------------------
async function renderFiles(el, run) {
  el.innerHTML = '<p class="muted">Loading files…</p>';
  const { files } = await api(`api/runs/${run.id}/files`);
  if (!files.length) {
    el.innerHTML = '<div class="card empty-state">No files yet — agents write them as tasks run.</div>';
    return;
  }
  if (!current.file || !files.some((f) => f.path === current.file)) current.file = (files.find((f) => f.path === 'README.md') || files.find((f) => f.path === 'PLAN.md') || files[0]).path;
  el.innerHTML = `<div class="files">
    <ul class="card tree">${files.map((f) => `<li><button data-path="${esc(f.path)}" aria-current="${f.path === current.file}"><span>${esc(f.path)}</span><small>${f.size < 1024 ? `${f.size}b` : `${(f.size / 1024).toFixed(1)}k`}</small></button></li>`).join('')}</ul>
    <div class="card viewer" id="viewer"><p class="muted">Loading…</p></div></div>`;
  el.querySelectorAll('[data-path]').forEach((b) => (b.onclick = () => {
    current.file = b.dataset.path;
    el.querySelectorAll('[data-path]').forEach((x) => x.setAttribute('aria-current', String(x === b)));
    showFile(run.id, current.file);
  }));
  showFile(run.id, current.file);
}

async function showFile(id, p) {
  const v = $('#viewer');
  try {
    const { content } = await api(`api/runs/${id}/files?path=${encodeURIComponent(p)}`);
    v.innerHTML = p.endsWith('.md')
      ? `<div class="head"><span>${esc(p)}</span><span>${content.length} chars</span></div><div class="md">${md(content)}</div>`
      : `<div class="head"><span>${esc(p)}</span><span>${content.split('\n').length} lines</span></div><pre>${esc(content)}</pre>`;
  } catch (e) {
    v.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}

// Delivery ----------------------------------------------------------------------------------
async function renderDelivery(el, run) {
  if (!run.delivery) {
    el.innerHTML = `<div class="card empty-state"><h2>Not delivered yet</h2><p>The factory packages the code, test results and report after the completion checklist.</p></div>`;
    return;
  }
  const report = await api(`api/runs/${run.id}/report`).catch(() => '');
  el.innerHTML = `<div class="grid-2">
    <div class="card md">${md(report)}</div>
    <div class="stack">
      ${run.outputDir ? `<div class="card"><h2>Project folder</h2>${run.delivery.output?.ok ? `<p>Delivered to <code>${esc(run.outputDir)}</code> (dependencies not included — run <code>npm install</code> there).</p>` : `<p class="form-error">Could not deliver to <code>${esc(run.outputDir)}</code>: ${esc(run.delivery.output?.error || 'not delivered')}. Download the archive instead.</p>`}</div>` : ''}
      <div class="card"><h2>Downloads</h2><div class="actions">
        ${run.delivery.archive ? `<a class="btn accent" href="api/runs/${esc(run.id)}/download/project.tar.gz">Source code (.tar.gz)</a>` : ''}
        <a class="btn" href="api/runs/${esc(run.id)}/download/FACTORY_REPORT.md">Factory report</a>
        <a class="btn" href="api/runs/${esc(run.id)}/download/test-results.json">Test results</a>
      </div></div>
      ${run.finalVerification?.length ? `<div class="card"><h2>Test results</h2>${run.finalVerification.map((v) => `<div class="vcheck"><span style="color:var(--${v.ok ? 'ok' : 'bad'})">${v.ok ? '✓' : '✗'}</span><span>${esc(v.command)} · exit ${v.exitCode} · ${v.durationMs}ms</span></div><pre class="out">${esc(v.output)}</pre>`).join('')}</div>` : ''}
      ${run.security ? `<div class="card"><h2>Security review</h2><p>${run.security.blocking} blocking · ${run.security.findings.length} total findings</p>${run.security.findings.length ? `<ul class="plain mono">${run.security.findings.slice(0, 20).map((f) => `<li>[${esc(f.severity)}] ${esc(f.rule)} — ${esc(f.file)}:${f.line}</li>`).join('')}</ul>` : ''}</div>` : ''}
      ${run.git ? `<div class="card"><h2>Repository</h2><p>${run.git.ok ? `Pushed to ${esc(run.git.repoUrl)} (${esc(run.git.branch)})` : `Push failed: ${esc(run.git.error)}`}</p></div>` : ''}
    </div></div>`;
}

// Minimal, safe markdown renderer (escapes first).
function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let html = '';
  let list = null;
  let table = null;
  let code = null;
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const flush = () => {
    if (list) html += `</${list}>`;
    if (table) html += '</tbody></table>';
    list = null;
    table = null;
  };
  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line)) {
        html += `<pre><code>${esc(code)}</code></pre>`;
        code = null;
      } else code += `${line}\n`;
      continue;
    }
    if (/^```/.test(line)) { flush(); code = ''; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { flush(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
      if (!table) { flush(); table = true; html += `<table><thead><tr>${cells.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`; continue; }
      html += `<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`;
      continue;
    }
    const li = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)/);
    if (li) {
      const type = li[1] ? 'ol' : 'ul';
      if (list !== type) { flush(); list = type; html += `<${type} class="plain">`; }
      const t = li[2].replace(/^\[( |x)\]\s*/, (m, x) => (x === 'x' ? '✓ ' : '○ '));
      html += `<li>${inline(t)}</li>`;
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    flush();
    html += `<p>${inline(line)}</p>`;
  }
  if (code !== null) html += `<pre><code>${esc(code)}</code></pre>`;
  flush();
  return html;
}

// Boot ----------------------------------------------------------------------------------------
config = await api('api/config');
window.addEventListener('hashchange', route);
route();
setInterval(() => {
  refreshRuns();
  if (current?.run && ACTIVE.has(current.run.status) && current.tab !== 'activity') {
    const meta = document.querySelector('.meta span:nth-child(3)');
    if (meta) meta.textContent = dur(current.run.startedAt || current.run.createdAt, current.run.finishedAt);
  }
}, 5000);
