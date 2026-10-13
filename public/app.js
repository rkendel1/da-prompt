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
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.body = body;
    throw err;
  }
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
  const project = mountProjectPicker(form);
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
    const missing = project.validate(new FormData(form));
    if (missing) {
      err.textContent = missing;
      err.hidden = false;
      return;
    }
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
      repoUrl: project.mode() === 'new' ? fd.get('repoUrl') || undefined : undefined,
      source: project.source(fd),
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

// Project section: new project | local directory | GitHub repository. Paths never come from the browser:
// local directories are picked from the server's authorized list and referenced by opaque id.
function mountProjectPicker(form) {
  const cfg = config.projects || {};
  const radios = [...form.querySelectorAll('[name=sourceMode]')];
  const summary = $('#src-summary');
  const dirSel = $('#directory-id');
  const modeSel = $('#working-mode');
  let dirs = null;
  let info = null;
  const mode = () => form.querySelector('[name=sourceMode]:checked').value;

  const local = radios.find((r) => r.value === 'local');
  if (!cfg.local) {
    local.disabled = true;
    local.nextElementSibling.title = 'No project roots are configured on the server (FACTORY_PROJECT_ROOTS)';
  }
  const showSummary = (html, bad = false) => {
    summary.hidden = !html;
    summary.className = `srcsummary${bad ? ' bad' : ''}`;
    summary.innerHTML = html || '';
  };
  const warnList = (w) => (w?.length ? `<ul>${w.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');

  const render = () => {
    const m = mode();
    if (m === 'local' && info?.mode === 'local') {
      const g = info.git;
      const where = modeSel.value === 'snapshot' ? 'an isolated copy of the working tree' : 'an isolated clone of the last commit';
      showSummary(`<b>Reads:</b> ${esc(info.name)}${g.isGit ? ` · branch ${esc(g.branch || 'detached')} · ${g.dirty ? `${g.counts.staged + g.counts.unstaged + g.counts.untracked} uncommitted change(s)` : 'clean'}` : ' · not a git repository'}<br>
        <b>Edits happen in:</b> ${where}, ${g.isGit && modeSel.value === 'clone' ? 'on branch <code>da-prompt/&lt;run id&gt;</code>' : 'under the factory data directory'}<br>
        <b>Your directory:</b> ${info.readOnly ? 'read-only — results can only be downloaded' : 'never written during the run; results are applied only if you choose to, with a conflict check'}<br>
        <b>Publishing:</b> off — local runs never push or open pull requests
        ${info.detected ? `<br><b>Detected:</b> ${esc(info.detected.summary)}` : ''}${warnList(info.warnings)}`);
    } else if (m === 'github' && info?.mode === 'github') {
      const publish = form.publish.checked && cfg.canPublish;
      showSummary(`<b>Reads:</b> ${esc(info.repo)} @ ${esc(info.ref.name)}${info.ref.kind === 'default' ? ' (default branch)' : ` (${esc(info.ref.kind)})`}<br>
        <b>Edits happen in:</b> an isolated clone on a new branch <code>da-prompt/&lt;run id&gt;</code>; ${esc(info.ref.name)} is never modified<br>
        <b>Publishing:</b> ${publish ? 'ON — pushes only the run branch and opens a pull request' : 'off — you get a patch and archive; nothing is pushed'}${warnList(info.warnings)}`);
    } else if (m !== 'new') showSummary('');
    else showSummary('');
  };

  const inspectLocal = async () => {
    info = null;
    if (!dirSel.value) return render();
    showSummary('Inspecting…');
    try {
      info = await api('api/projects/inspect', { method: 'POST', body: JSON.stringify({ source: { mode: 'local', directoryId: dirSel.value } }) });
      modeSel.innerHTML = info.workingModes.map((w) => `<option value="${esc(w)}">${w === 'clone' ? 'Clone — committed state (HEAD), on its own branch' : 'Snapshot — copy of the working tree, including uncommitted changes'}</option>`).join('');
      modeSel.value = info.defaultWorkingMode;
      render();
    } catch (e) {
      showSummary(esc(e.message), true);
    }
  };
  const loadDirs = async () => {
    if (dirs) return;
    try {
      dirs = await api('api/projects/directories');
      dirSel.innerHTML = dirs.directories.length
        ? dirs.directories.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} — ${d.git.isGit ? `${esc(d.git.branch || 'detached')}${d.git.dirty ? ' · uncommitted changes' : ' · clean'}` : 'not a git repository'}${d.readOnly ? ' · read-only' : ''}</option>`).join('')
        : '<option value="">(no directories under the authorized roots)</option>';
    } catch (e) {
      dirSel.innerHTML = '<option value="">(could not list directories)</option>';
      showSummary(esc(e.message), true);
    }
    inspectLocal();
  };
  const inspectRepo = async () => {
    const repoUrl = form.sourceRepo.value.trim();
    if (!repoUrl) return showSummary('Enter a repository, e.g. owner/repo.', true);
    showSummary('Checking the repository…');
    try {
      info = await api('api/projects/inspect', { method: 'POST', body: JSON.stringify({ source: { mode: 'github', repoUrl, ref: form.ref.value.trim() || undefined } }) });
      $('#repo-branches').innerHTML = info.branches.map((b) => `<option value="${esc(b)}"></option>`).join('');
      form.ref.placeholder = info.defaultBranch;
      form.publish.disabled = !info.canPublish;
      if (!info.canPublish) form.publish.checked = false;
      render();
    } catch (e) {
      info = null;
      showSummary(esc(e.message), true);
    }
  };

  const apply = () => {
    const m = mode();
    $('#src-local').hidden = m !== 'local';
    $('#src-github').hidden = m !== 'github';
    $('#install-field').hidden = m === 'new';
    $('#idea-label').innerHTML = m === 'new' ? 'Idea <em>required</em>' : 'What do you want to change? <em>required</em>';
    form.idea.placeholder = m === 'new' ? 'A shared reading list for book clubs…' : 'Add password reset to this application…';
    $('#examples').hidden = m !== 'new';
    $('#repo-field').hidden = m !== 'new' || !config.gitPush;
    $('#deploy-label').textContent = m === 'new' ? 'Deploy a live preview' : 'Authorize a local preview of the result (off by default)';
    form.deploy.checked = m === 'new';
    info = null;
    if (m === 'local') loadDirs();
    else showSummary('');
  };
  radios.forEach((r) => r.addEventListener('change', apply));
  dirSel.addEventListener('change', inspectLocal);
  modeSel.addEventListener('change', render);
  $('#check-repo').addEventListener('click', inspectRepo);
  form.sourceRepo.addEventListener('change', () => form.sourceRepo.value.trim() && inspectRepo());
  form.ref.addEventListener('change', () => form.sourceRepo.value.trim() && inspectRepo());
  form.publish.addEventListener('change', render);

  return {
    mode,
    validate(fd) {
      if (mode() === 'local' && !fd.get('directoryId')) return 'Choose one of the authorized directories.';
      if (mode() === 'github' && !String(fd.get('sourceRepo') || '').trim()) return 'Enter the GitHub repository to change.';
      return '';
    },
    source(fd) {
      const m = mode();
      if (m === 'local') return { mode: m, directoryId: fd.get('directoryId'), workingMode: fd.get('workingMode') || undefined, allowInstall: fd.get('allowInstall') === 'on' };
      if (m === 'github') return { mode: m, repoUrl: fd.get('sourceRepo'), ref: fd.get('ref') || undefined, publish: fd.get('publish') === 'on', allowInstall: fd.get('allowInstall') === 'on' };
      return undefined;
    },
  };
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
        <p class="eyebrow">run ${esc(run.id)} · ${esc(run.providerLabel || run.provider)} · ${esc(run.model)}${plannerLabel(run)}${run.source ? ` · ${run.source.mode === 'github' ? 'github' : 'local'} ${esc(run.source.label)}` : ''}</p>
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
        ${run.source && run.delivery?.patch ? `<a class="btn" href="api/runs/${esc(run.id)}/download/changes.patch">Download patch</a>` : ''}
        ${!run.source && run.delivery?.archive ? `<a class="btn" href="api/runs/${esc(run.id)}/download/project.tar.gz">Download code</a>` : ''}
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
    ${stagesHtml(run)}
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

const STAGE_NAMES = { connect: 'Connect', inspect: 'Inspect', baseline: 'Baseline' };
// Connect → Inspect → Baseline happen inside the Plan layer for existing projects; the seven layers are unchanged.
function stagesHtml(run) {
  if (!run.source) return '';
  return `<div class="stages" aria-label="Existing project stages">${Object.entries(STAGE_NAMES).map(([k, name]) => {
    const st = run.project?.stages?.[k];
    return `<div class="stage ${esc(st?.state || 'pending')}" title="${esc(st?.detail || '')}"><b>${name}</b><span class="st">${esc(st?.state || 'pending')}</span></div>`;
  }).join('')}</div>`;
}

const VERDICT_LABEL = { verified: 'verified', 'verified-with-preexisting-failures': 'verified, pre-existing failures remain', 'partially-verified': 'partially verified', unverified: 'not verified', failed: 'failed' };
// Mirrors the server's verdict: failures introduced by the run beat everything; nothing proven means unverified.
function verdictOf(run) {
  const f = run.finalVerification || [];
  const n = (s) => f.filter((v) => v.state === s).length;
  if (n('regression') || n('new-failure') || n('blocked')) return 'failed';
  if (!n('passed') && !n('fixed')) return 'unverified';
  if (n('unavailable')) return 'partially-verified';
  if (n('preexisting')) return 'verified-with-preexisting-failures';
  return 'verified';
}

function sourceCard(run) {
  const s = run.source;
  const i = run.project?.inspection;
  return `<div class="card"><h2>Project source</h2><table class="plain">
    <tr><th>source</th><td>${s.mode === 'github' ? `GitHub ${esc(s.label)}${s.ref ? ` @ ${esc(s.ref)}` : ''}` : `local directory ${esc(s.label)}${s.readOnly ? ' (read-only root)' : ''}`}</td></tr>
    <tr><th>isolation</th><td>${esc(s.workingMode || 'pending')} — the source is never edited</td></tr>
    ${s.baseSha ? `<tr><th>base</th><td>${esc(s.baseSha.slice(0, 12))}${s.baseBranch ? ` on ${esc(s.baseBranch)}` : ''}</td></tr>` : ''}
    ${s.branch ? `<tr><th>working branch</th><td>${esc(s.branch)}</td></tr>` : ''}
    ${s.snapshotNote ? `<tr><th>note</th><td>${esc(s.snapshotNote)}</td></tr>` : ''}
    ${i ? `<tr><th>detected</th><td>${esc(i.ecosystems.join(', ') || 'unknown stack')} · ${i.files} files · ${i.instructions.length} instruction file(s)${i.instructions.length ? `: ${esc(i.instructions.map((x) => x.path).join(', '))}` : ''}</td></tr>` : ''}
    <tr><th>publishing</th><td>${s.mode === 'github' ? (s.publish ? 'enabled for this run' : 'off — explicit action in Delivery') : 'not applicable (local runs never push)'}</td></tr>
  </table></div>`;
}

function baselineCard(run) {
  const b = run.project?.baseline;
  if (!run.project?.inspection) return '';
  if (!b?.length) return `<div class="card"><h2>Baseline</h2><p class="muted">${run.project.stages?.baseline?.state === 'skipped' ? 'No test, lint or build command was detected, so there is no baseline and nothing can be claimed as verified.' : 'Running the project\'s own checks before any change…'}</p></div>`;
  return `<div class="card"><h2>Baseline <span class="muted mono">before any change</span></h2><table class="plain">${b.map((x) => `<tr><td>${esc(x.command)}</td><td><span class="pill ${esc(x.status)}">${esc(x.status)}</span></td><td class="muted">${esc(x.limitation || x.signature?.[0] || '')}</td></tr>`).join('')}</table></div>`;
}

function verificationCard(run) {
  const f = run.finalVerification;
  if (!run.source || !f?.length) return '';
  const groups = [['Regressions and new failures', ['regression', 'new-failure', 'blocked']], ['Pre-existing failures (not caused by this run)', ['preexisting']], ['Could not run', ['unavailable']], ['Passing', ['passed', 'fixed']]];
  return `<div class="card"><h2>Verification <span class="pill ${esc(verdictOf(run))}">${esc(VERDICT_LABEL[verdictOf(run)])}</span></h2>
    ${groups.map(([title, states]) => {
      const rows = f.filter((v) => states.includes(v.state));
      return rows.length ? `<h3>${title}</h3>${rows.map((v) => `<div class="vcheck"><span class="pill ${esc(v.state)}">${esc(v.state)}</span><span>${esc(v.command)} · exit ${v.exitCode}</span></div>${v.newFailures?.length ? `<ul class="plain mono">${v.newFailures.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}${!v.ok ? `<pre class="out">${esc(v.output)}</pre>` : ''}`).join('')}` : '';
    }).join('')}</div>`;
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
    : (run.source
      ? ['Requested change implemented; every planned task verified', 'Project checks pass with no regressions', 'No critical errors or security issues in the changed files', 'Deployment', 'Documentation', 'Final summary and next steps provided']
      : ['All core features work and are tested', 'Full test suite passes', 'No critical errors or security issues', 'Deployment is successful (URL or clear instructions)', 'Documentation is updated', 'Final summary and next steps provided']).map((label) => ({ label, pending: true }));
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
          <h2>${p ? esc(p.product.name) : run.source && !run.plan ? 'Connecting to the project…' : 'Planning…'}</h2>
          <p>${p ? esc(p.product.summary) : esc(run.inputs.idea)}</p>
          ${p?.architecture ? `<h3>Existing architecture</h3><p>${esc(p.architecture)}</p>` : ''}
          ${p?.affectedFiles?.length ? `<h3 style="margin-top:14px">Files likely to change</h3><ul class="plain mono">${p.affectedFiles.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
          ${p ? `<h3>Success criteria</h3><ul class="plain">${p.product.successCriteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
          ${p?.product.users?.length ? `<h3 style="margin-top:14px">Users</h3><ul class="plain">${p.product.users.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
        </div>
        ${run.source ? sourceCard(run) + baselineCard(run) + verificationCard(run) : ''}
        ${run.summary ? `<div class="card md"><h2>Final summary</h2>${md(run.summary)}</div>` : ''}
        ${run.lessons?.length ? `<div class="card"><h2>Lessons (${run.source ? 'factory notes' : 'CLAUDE.md'})</h2><ul class="plain">${run.lessons.map((l) => `<li>${esc(l.text)}</li>`).join('')}</ul></div>` : ''}
      </div>
      <div class="stack">
        <div class="card">
          <h2>Completion checklist</h2>
          <ul class="checklist">${checklist.map((c) => `<li><span class="ic ${c.pending ? 'pending' : c.state === 'na' ? 'na' : c.state === 'warn' || c.state === 'partial' ? 'warn' : c.state === 'skipped' ? 'skipped' : c.ok ? 'ok' : 'no'}">${c.pending ? '○' : c.state === 'na' ? '–' : c.state === 'warn' || c.state === 'partial' ? '!' : c.state === 'skipped' ? '○' : c.ok ? '✓' : '✗'}</span><span>${esc(c.label)}</span>${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</li>`).join('')}</ul>
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
    case 'run.created': return [who, `Run created · ${esc(e.provider)} · ${esc(e.model || '')}${plannerLabel(e)}${e.source ? ` · ${esc(e.source.mode)} ${esc(e.source.label)}` : ''}${e.outputDir ? ` · output ${esc(e.outputDir)}` : ''}`];
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
    case 'stage': return [who, `<b>${esc(STAGE_NAMES[e.stage] || e.stage)}</b>: ${esc(e.state)}${e.detail ? ` — ${esc(e.detail)}` : ''}`, e.state === 'done' ? 'ok' : e.state === 'failed' ? 'bad' : ''];
    case 'source': return [who, `Source: ${esc(e.mode)} ${esc(e.label)}${e.ref ? ` @ ${esc(e.ref)}` : ''} · isolation ${esc(e.workingMode)} · base ${esc(String(e.baseSha || '').slice(0, 10))} · branch ${esc(e.branch)}${e.note ? ` · ${esc(e.note)}` : ''}`];
    case 'inspect': return [who, `Inspected: ${esc(e.summary)}${e.instructions?.length ? ` · instructions: ${esc(e.instructions.join(', '))}` : ''}`, 'ok'];
    case 'baseline': return [who, `Baseline <span class="${e.status === 'passed' ? 'ok' : 'bad'}">${e.status === 'passed' ? '✓' : '✗'}</span> ${esc(e.command)} → ${esc(e.status)}${e.limitation ? ` (${esc(e.limitation)})` : ''}`, e.status === 'passed' ? 'ok' : 'warn'];
    case 'publish': return [who, e.state === 'failed' ? `Publish failed (${esc(e.step)}): ${esc(e.error)}` : `Publish: ${esc(e.state)}${e.branch ? ` ${esc(e.branch)}` : ''}${e.pr ? ` — <a href="${esc(e.pr.url)}" target="_blank" rel="noopener">pull request #${e.pr.number}</a>` : ''}${e.prError ? ` — ${esc(e.prError)}` : ''}`, e.state === 'failed' || e.prError ? 'bad' : 'ok'];
    case 'apply': return [who, e.mode === 'branch' ? `Branch exported to your repository: ${esc(e.branch)}` : e.ok ? `Applied ${e.files} file(s) to your directory` : `Apply refused: ${(e.conflicts || []).length} conflicting file(s)`, e.ok === false ? 'bad' : 'ok'];
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
function filesToggle(view) {
  return `<div class="toggle" role="group" aria-label="File view"><button data-view="changed" aria-pressed="${view === 'changed'}">Changed files</button><button data-view="all" aria-pressed="${view === 'all'}">All files</button></div>`;
}
function bindToggle(el, run) {
  el.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => {
    current.filesView = b.dataset.view;
    renderFiles(el, run);
  }));
}

async function renderChangedFiles(el, run) {
  let changes;
  try {
    changes = await api(`api/runs/${run.id}/changes`);
  } catch (e) {
    el.innerHTML = `${filesToggle('changed')}<div class="card empty-state">${esc(e.message)}</div>`;
    return bindToggle(el, run);
  }
  const files = changes.files;
  if (!files.length) {
    el.innerHTML = `${filesToggle('changed')}<div class="card empty-state">No files changed so far. The original project is untouched; edits appear here as agents work in the isolated workspace.</div>`;
    return bindToggle(el, run);
  }
  if (!current.changedFile || !files.some((f) => f.path === current.changedFile)) current.changedFile = files[0].path;
  el.innerHTML = `${filesToggle('changed')}<div class="files">
    <ul class="card tree" aria-label="Changed files">${files.map((f) => `<li><button data-path="${esc(f.path)}" aria-current="${f.path === current.changedFile}"><span class="left"><span class="st ${esc(f.status)}">${esc(f.status)}</span><span>${esc(f.path)}</span></span><small>${f.binary ? 'binary' : `<span class="plus">+${f.additions}</span> <span class="minus">−${f.deletions}</span>`}</small></button></li>`).join('')}</ul>
    <div class="card viewer" id="viewer"><p class="muted">Loading…</p></div></div>
    <p class="muted mono" style="margin-top:10px">${files.length} file(s) · +${changes.additions} −${changes.deletions} against the baseline</p>`;
  bindToggle(el, run);
  el.querySelectorAll('[data-path]').forEach((b) => (b.onclick = () => {
    current.changedFile = b.dataset.path;
    el.querySelectorAll('[data-path]').forEach((x) => x.setAttribute('aria-current', String(x === b)));
    showDiff(run.id, current.changedFile);
  }));
  showDiff(run.id, current.changedFile);
}

async function showDiff(id, p) {
  const v = $('#viewer');
  try {
    const { diff } = await api(`api/runs/${id}/changes?path=${encodeURIComponent(p)}`);
    const lines = diff.split('\n').map((l) => {
      const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'meta' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
      return `<span class="${cls || 'ctx'}">${esc(l) || ' '}</span>`;
    });
    v.innerHTML = `<div class="head"><span>${esc(p)}</span><span>diff against the baseline</span></div><pre class="diff">${lines.join('') || 'No textual changes.'}</pre>`;
  } catch (e) {
    v.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}

async function renderFiles(el, run) {
  if (run.source?.baseSha && (current.filesView || 'changed') === 'changed') return renderChangedFiles(el, run);
  el.innerHTML = '<p class="muted">Loading files…</p>';
  const { files } = await api(`api/runs/${run.id}/files`);
  if (!files.length) {
    el.innerHTML = '<div class="card empty-state">No files yet — agents write them as tasks run.</div>';
    return;
  }
  if (!current.file || !files.some((f) => f.path === current.file)) current.file = (files.find((f) => f.path === 'README.md') || files.find((f) => f.path === 'PLAN.md') || files[0]).path;
  el.innerHTML = `${run.source?.baseSha ? filesToggle('all') : ''}<div class="files">
    <ul class="card tree">${files.map((f) => `<li><button data-path="${esc(f.path)}" aria-current="${f.path === current.file}"><span>${esc(f.path)}</span><small>${f.size < 1024 ? `${f.size}b` : `${(f.size / 1024).toFixed(1)}k`}</small></button></li>`).join('')}</ul>
    <div class="card viewer" id="viewer"><p class="muted">Loading…</p></div></div>`;
  if (run.source?.baseSha) bindToggle(el, run);
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
  if (run.delivery && run.source) return renderDeliveryExisting(el, run);
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

async function renderDeliveryExisting(el, run) {
  const d = run.delivery;
  const s = run.source;
  const pub = d.publication;
  const verdict = verdictOf(run);
  const open = (run.plan?.tasks || []).filter((t) => t.status !== 'completed' && t.status !== 'skipped');
  const report = await api(`api/runs/${run.id}/report`).catch(() => '');
  const dl = (name, label, cls = '') => `<a class="btn ${cls}" href="api/runs/${esc(run.id)}/download/${name}">${label}</a>`;
  const busy = run.executing;
  el.innerHTML = `<div class="grid-2">
    <div class="card md">${md(report)}</div>
    <div class="stack">
      <div class="card"><h2>Delivery <span class="pill ${d.readiness?.ready ? 'ready' : 'notready'}">${d.readiness?.ready ? 'ready for review' : 'not ready'}</span></h2>
        <p>Implementation verification: <span class="pill ${esc(verdict)}">${esc(VERDICT_LABEL[verdict])}</span></p>
        ${d.readiness?.reasons?.length ? `<ul class="plain">${d.readiness.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        <p class="mono">${d.integrity?.ok ? '✓ source protection verified — the source ref and history were not modified' : `✗ source protection: ${esc((d.integrity?.problems || []).join('; '))}`}</p>
        <table class="plain">
          ${s.baseBranch ? `<tr><th>source branch</th><td>${esc(s.baseBranch)} @ ${esc(s.baseSha.slice(0, 12))}</td></tr>` : `<tr><th>baseline</th><td>${esc(s.baseSha.slice(0, 12))}</td></tr>`}
          <tr><th>working branch</th><td>${esc(s.branch)}${d.commit?.sha ? ` @ ${esc(d.commit.sha.slice(0, 12))}` : ''}</td></tr>
          <tr><th>changed files</th><td>${run.changes?.files.length ?? 0} · +${run.changes?.additions ?? 0} −${run.changes?.deletions ?? 0}</td></tr>
        </table></div>
      <div class="card"><h2>Downloads</h2><div class="actions">
        ${d.patch ? dl('changes.patch', 'Patch (.patch)', 'accent') : ''}
        ${d.archive ? dl('project.tar.gz', 'Changed files (.tar.gz)') : ''}
        ${d.deleted ? dl('DELETED_FILES.txt', 'Deleted files') : ''}
        ${dl('FACTORY_REPORT.md', 'Factory report')}
        ${dl('test-results.json', 'Test results')}
      </div></div>
      ${open.length ? `<div class="card escalation"><h3>Unresolved tasks</h3><ul class="plain">${open.map((t) => `<li><b>${esc(t.id)}</b> — ${esc(t.status)}${t.escalation?.reason || t.error ? `: ${esc(t.escalation?.reason || t.error)}` : ''}</li>`).join('')}</ul><p class="muted">Resolve them from the Overview tab (retry, edit or skip).</p></div>` : ''}
      ${verificationCard(run)}
      ${s.mode === 'github' ? `<div class="card" id="pub-card"><h2>GitHub</h2>
        <p>${pub ? `Publication: <span class="pill ${pub.state === 'failed' ? 'failed' : pub.state === 'nothing-to-publish' ? 'skipped' : 'completed'}">${esc(pub.state)}</span>` : s.publish ? 'Publishing was enabled for this run.' : 'Not published. Pushing and opening a pull request are explicit actions.'}</p>
        ${pub?.error ? `<p class="form-error">${esc(pub.error)}</p>` : ''}${pub?.prError ? `<p class="form-error">${esc(pub.prError)}</p>` : ''}
        ${pub?.pr ? `<p><a class="btn accent" href="${esc(pub.pr.url)}" target="_blank" rel="noopener">Pull request #${pub.pr.number}${pub.pr.draft ? ' (draft)' : ''} ↗</a></p>` : ''}
        ${pub?.branch ? `<p class="mono">pushed ${esc(pub.branch)}${pub.sha ? ` @ ${esc(pub.sha.slice(0, 12))}` : ''}</p>` : ''}
        <div class="actions"><button class="btn ${pub?.pr ? '' : 'accent'}" data-pub="pr" ${busy || !config.projects?.canPublish || !d.integrity?.ok || !run.changes?.files.length ? 'disabled' : ''}>${pub?.state === 'failed' || pub?.prError ? 'Retry: push &amp; open pull request' : pub?.pr ? 'Re-run publish (idempotent)' : 'Push branch &amp; open pull request'}</button>
        <button class="btn" data-pub="push" ${busy || !config.projects?.canPublish || !d.integrity?.ok || !run.changes?.files.length ? 'disabled' : ''}>Push branch only</button></div>
        ${config.projects?.canPublish ? '<p class="muted">Pushes only the run branch (never forced, never the base branch). Opens a draft PR unless everything is verified.</p>' : '<p class="muted">Set GITHUB_TOKEN on the server to enable pushing.</p>'}
      </div>` : `<div class="card" id="local-card"><h2>Your directory</h2>
        ${d.local?.applied ? `<p class="mono">✓ applied ${d.local.applied.files.length} file(s) to the source directory (nothing staged or committed)</p>` : ''}
        ${d.local?.branch ? `<p class="mono">✓ branch <b>${esc(d.local.branch.branch)}</b> added to your repository (nothing checked out)</p>` : ''}
        <ul class="conflicts" id="conflicts" hidden></ul>
        <p class="muted">Nothing was written to your directory during the run. Apply only if no file the run changed has changed in your directory since it started; otherwise nothing is written.${s.readOnly ? ' This directory is in a read-only root, so use the patch.' : ''}</p>
        <div class="actions"><button class="btn accent" data-apply="working-tree" ${busy || s.readOnly || !run.changes?.files.length || !d.integrity?.ok ? 'disabled' : ''}>Apply to my directory</button>
        ${s.workingMode === 'clone' ? `<button class="btn" data-apply="branch" ${busy || s.readOnly || !run.changes?.files.length || !d.integrity?.ok ? 'disabled' : ''}>Add as a branch in my repository</button>` : ''}</div>
      </div>`}
      ${run.outputDir ? `<div class="card"><h2>Project folder</h2>${d.output?.ok ? `<p>Full resulting project exported to <code>${esc(run.outputDir)}</code> (a new folder; your source was not touched).</p>` : `<p class="form-error">Could not export to <code>${esc(run.outputDir)}</code>: ${esc(d.output?.error || 'not delivered')}.</p>`}</div>` : ''}
      ${run.security ? `<div class="card"><h2>Security review <span class="muted mono">changed files</span></h2><p>${run.security.blocking} blocking · ${run.security.findings.length} total findings</p>${run.security.findings.length ? `<ul class="plain mono">${run.security.findings.slice(0, 20).map((f) => `<li>[${esc(f.severity)}] ${esc(f.rule)} — ${esc(f.file)}:${f.line}</li>`).join('')}</ul>` : ''}</div>` : ''}
    </div></div>`;
  el.querySelectorAll('[data-pub]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try {
      current.run = (await api(`api/runs/${run.id}/publish`, { method: 'POST', body: JSON.stringify({ pullRequest: b.dataset.pub === 'pr' }) })).run;
      const pb = current.run.delivery?.publication;
      toast(pb?.state === 'failed' ? `Publish failed: ${pb.error}` : pb?.prError ? `Pushed, but: ${pb.prError}` : pb?.pr ? 'Pull request ready' : 'Branch pushed');
    } catch (e) {
      toast(e.message);
    }
    renderRun();
  }));
  el.querySelectorAll('[data-apply]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try {
      current.run = (await api(`api/runs/${run.id}/apply`, { method: 'POST', body: JSON.stringify({ mode: b.dataset.apply }) })).run;
      toast(b.dataset.apply === 'branch' ? 'Branch added to your repository' : 'Applied to your directory');
      renderRun();
    } catch (e) {
      toast(e.message);
      const list = $('#conflicts');
      if (e.body?.conflicts?.length && list) {
        list.hidden = false;
        list.innerHTML = e.body.conflicts.map((c) => `<li>${esc(c.path)} — ${esc(c.reason)}</li>`).join('');
      }
      b.disabled = false;
    }
  }));
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
