// da-prompt factory UI. No framework: hash routing, fetch, EventSource.
import { mountModelPicker, renderProvidersPage } from './providers.js';
import { renderTerminalPage } from './terminal.js';
import { renderProjectsPage } from './projects.js';
import { renderChatPage } from './chat.js';
import { chooseFolder } from './folderpicker.js';
import { renderBacklogPage } from './backlog.js';
import { renderSetupPage, renderSettingsPage, renderPaxPage, renderHistoryPage, renderEvidence, refreshHealthDot, loadHealth } from './ops.js';

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

let backendUp = true;
function setBackend(up) {
  if (up === backendUp) return;
  backendUp = up;
  const b = $('#backend-banner');
  if (b) b.hidden = up;
  if (up && current?.id) reconnectRun();
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
    setBackend(true);
  } catch {
    setBackend(false);
    const err = new Error('The da-prompt backend is not reachable. Check that the server is running; this page will reconnect on its own.');
    err.unreachable = true;
    throw err;
  }
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
let pageCleanup = null;
function route() {
  if (pageCleanup) { try { pageCleanup(); } catch { /* ignore */ } pageCleanup = null; }
  const full = location.hash.replace(/^#/, '') || '/';
  const [hash, query = ''] = full.split('?');
  const params = new URLSearchParams(query);
  for (const a of document.querySelectorAll('.side-link')) {
    const to = a.getAttribute('href').replace(/^#/, '');
    if (to !== '/' && (hash === to || hash.startsWith(`${to}/`))) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (current?.es) current.es.close();
  const m = hash.match(/^\/runs\/([\w-]+)/);
  if (m) {
    current = { id: m[1], events: [], tab: 'overview', selectedTask: null, file: null };
    renderRunShell();
  } else if (hash === '/prompt') {
    current = null;
    renderPrompt();
  } else if (hash === '/setup') {
    current = null;
    renderSetupPage(main, api, { toast });
  } else if (hash === '/settings') {
    current = null;
    renderSettingsPage(main, api, { toast, group: params.get('group') });
  } else if (hash === '/projects' || hash.startsWith('/projects/')) {
    current = null;
    renderProjectsPage(main, api, { toast, id: hash.split('/')[2] || '' }).then((c) => { if (location.hash.replace(/^#/, '').split('?')[0].startsWith('/projects')) pageCleanup = c; else c?.(); });
  } else if (hash === '/chat' || hash.startsWith('/chat/')) {
    current = null;
    const mine = hash;
    renderChatPage(main, api, { toast, id: hash.split('/')[2] || '', project: params.get('project') || '' }).then((c) => { if (location.hash.replace(/^#/, '').split('?')[0] === mine) pageCleanup = c; else c?.(); });
  } else if (hash === '/backlog' || hash.startsWith('/backlog/')) {
    current = null;
    renderBacklogPage(main, api, { toast, task: hash.split('/')[2] || '' }).then((c) => { if (location.hash.replace(/^#/, '').split('?')[0].startsWith('/backlog')) pageCleanup = c; else c?.(); });
  } else if (hash === '/terminal') {
    current = null;
    renderTerminalPage(main, api, { toast, project: params.get('project') || '' }).then((c) => { if (location.hash.replace(/^#/, '').split('?')[0] === '/terminal') pageCleanup = c; else c(); });
  } else if (hash === '/pax') {
    current = null;
    renderPaxPage(main, api, { toast });
  } else if (hash === '/history') {
    current = null;
    renderHistoryPage(main, api);
  } else if (hash === '/providers') {
    current = null;
    renderProvidersPage(main, api, toast);
  } else {
    current = null;
    renderNew({ project: params.get('project') || '' });
  }
  refreshRuns();
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

// ── New run ─────────────────────────────────────────────────────────────────────────────────
function renderNew({ project: preselect = '' } = {}) {
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
  const project = mountProjectPicker(form, { preselect });
  mountNewRunExtras(form, picker, project);
  form.allowInstall.checked = Boolean(config.defaults.allowInstall);
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
        pax: fd.get('pax') === 'on',
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


// First-run banner, PAX option and the "what this run may do" summary on the New Run screen.
function mountNewRunExtras(form, picker, project) {
  const banner = $('#setup-banner');
  loadHealth(api).then((h) => {
    if (!h.needsSetup && h.ready) return;
    const fails = h.checks.filter((c) => c.status === 'fail');
    if (!banner.isConnected) return;
    banner.hidden = false;
    banner.innerHTML = `<h2>Finish setup before your first run</h2><p>${esc(fails[0]?.summary || 'The factory is not ready to run real work yet.')}</p><a class="btn accent" href="#/setup">Open setup &amp; health →</a>`;
  }).catch(() => {});

  const pax = $('#pax-check');
  const hint = $('#pax-hint');
  api('api/pax').then((d) => {
    if (!pax.isConnected) return;
    if (d.status.state === 'ok') {
      pax.checked = Boolean(d.config.autoRun);
      hint.innerHTML = `PAX ${esc(d.status.version)} is available on the server. Steps: ${esc(d.config.steps.join(', '))}. The output is stored beside the run and shown separately — it is not verification. <a href="#/pax">Details</a>`;
    } else {
      pax.disabled = true;
      pax.checked = false;
      hint.innerHTML = `PAX is not usable on the server (${esc(d.status.state)}): ${esc(d.status.message || '')} <a href="#/pax">See the PAX page</a>`;
    }
    renderScope();
  }).catch(() => {
    pax.disabled = true;
    hint.textContent = 'PAX status could not be read.';
  });

  async function renderScope() {
    const fd = new FormData(form);
    const m = project.mode();
    let choice = {};
    try {
      choice = (await picker).getChoice();
    } catch {
      /* picker not ready */
    }
    const L = [];
    const dir = $('#directory-id');
    const isReg = form.querySelector('[name=sourceMode]:checked').value === 'registered';
    const dirLabel = (isReg ? $('#project-id') : dir)?.selectedOptions?.[0]?.textContent?.split(' — ')[0] || 'the selected directory';
    if (m === 'new') {
      L.push('<b>Creates</b> a new application in the run\'s isolated workspace. You download it, or export it to a new folder you name.');
    } else if (m === 'local') {
      const snap = (isReg ? fd.get('regWorkingMode') : fd.get('workingMode')) === 'snapshot';
      L.push(`<b>Reads</b> ${esc(dirLabel)} to build ${snap ? 'a copy of the working tree (including uncommitted files)' : 'a clone of the last commit'}.`);
      L.push('<b>May modify</b> only that isolated workspace on the server. Your directory is not written during the run.');
      L.push(fd.get('autoApply') === 'on'
        ? '<b>Applying is automatic</b>: if the run finishes verified and ready, its changes are written into your directory with a conflict check (nothing staged or committed). Otherwise you review it first.'
        : '<b>Applying</b> the result to your directory is one click after you review the diff (it approves and applies together); nothing is staged or committed.');
      L.push('<b>Publishing</b> is not available for local runs.');
    } else {
      const repo = (isReg ? $('#project-id').selectedOptions?.[0]?.textContent?.split(' — ')[0] : String(fd.get('sourceRepo') || '').trim()) || 'the repository';
      L.push(`<b>Reads</b> ${esc(repo)}${fd.get('ref') ? ` @ ${esc(fd.get('ref'))}` : ''} into an isolated clone on a new <code>da-prompt/…</code> branch.`);
      L.push('<b>May modify</b> only that clone; the source branch is never changed.');
      L.push((isReg ? fd.get('regPublish') : fd.get('publish')) === 'on' ? '<b>Publishing is ON</b>: when the run finishes, only the run branch is pushed and a pull request is opened (a draft unless everything is verified).' : '<b>Publishing is off</b>: pushing and opening a pull request are explicit actions after you approve the diff.');
    }
    if (m !== 'new') L.push(fd.get('allowInstall') === 'on' ? '<b>Dependencies are installed</b> in the isolated workspace before the baseline, and agents may install more (this runs the project\'s own install scripts; your directory is not touched).' : 'Dependency installs, migrations and deploy commands are not run.');
    L.push(fd.get('deploy') === 'on' ? `<b>Deploy:</b> ${m === 'new' ? 'a live preview of the new app will start on the server.' : 'a local preview of the result may start on the server.'}` : '<b>Deploy:</b> nothing is deployed.');
    L.push(fd.get('pax') === 'on' ? '<b>PAX:</b> observations are collected after verification, separately from it.' : '<b>PAX:</b> not collected for this run.');
    L.push(`<b>Models:</b> ${esc(choice.provider || 'default provider')}${choice.model ? ` · ${esc(choice.model)}` : ''}${choice.planner?.provider || choice.plannerProvider ? ` (planner ${esc(choice.planner?.provider || choice.plannerProvider)})` : ''}.`);
    const list = $('#scope-list');
    if (list) list.innerHTML = L.map((x) => `<li>${x}</li>`).join('');
  }
  form.addEventListener('change', renderScope);
  form.addEventListener('input', renderScope);
  setTimeout(renderScope, 400);
  renderScope();
}

// Project section: new project | local directory | GitHub repository. Paths never come from the browser:
// local directories are picked from the server's authorized list and referenced by opaque id.
function mountProjectPicker(form, { preselect = '' } = {}) {
  const cfg = config.projects || {};
  const radios = [...form.querySelectorAll('[name=sourceMode]')];
  const summary = $('#src-summary');
  const dirSel = $('#directory-id');
  const modeSel = $('#working-mode');
  let dirs = null;
  let info = null;
  const radio = () => form.querySelector('[name=sourceMode]:checked').value;
  const regSel = $('#project-id');
  const regModeSel = $('#reg-working-mode');
  let regProjects = null;
  // "new" | "local" | "github": the effective kind of work (a registered project is local or remote).
  const mode = () => (radio() === 'registered' ? regInfo?.mode || 'local' : radio());
  let regInfo = null;

  const local = radios.find((r) => r.value === 'local');
  // Selectable when folders are already authorized, or when this session may browse and authorize one.
  const syncLocal = () => {
    local.disabled = !cfg.local && !cfg.canBrowse;
    local.nextElementSibling.title = local.disabled ? 'No project folders are configured (FACTORY_PROJECT_ROOTS) and folders can only be browsed from the server machine or with an access password' : '';
    $('#browse-row').hidden = !cfg.canBrowse;
  };
  syncLocal();
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
      const publish = (radio() === 'registered' ? $('#reg-publish').checked : form.publish.checked) && cfg.canPublish;
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
        : `<option value="">${cfg.canBrowse ? '(none yet — use “Browse for a folder…”)' : '(no directories under the authorized roots)'}</option>`;
    } catch (e) {
      dirSel.innerHTML = '<option value="">(could not list directories)</option>';
      showSummary(esc(e.message), true);
    }
    inspectLocal();
  };
  $('#browse-dir').addEventListener('click', async () => {
    const picked = await chooseFolder(api);
    if (!picked) return;
    cfg.local = true;
    syncLocal();
    dirs = null;
    await loadDirs();
    // The picked folder may be a plain (non-git) folder or sit deeper than the listing shows: make sure it is selectable.
    if (![...dirSel.options].some((o) => o.value === picked.id)) dirSel.insertAdjacentHTML('beforeend', `<option value="${esc(picked.id)}">${esc(picked.name)}</option>`);
    dirSel.value = picked.id;
    inspectLocal();
  });
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

  const regSelected = () => regProjects?.find((p) => p.id === regSel.value);
  const inspectRegistered = async () => {
    info = null;
    regInfo = null;
    const p = regSelected();
    $('#reg-publish-field').hidden = !p || p.kind !== 'remote';
    if (p) form.allowInstall.checked = p.settings?.allowInstall ?? Boolean(config.defaults.allowInstall); // the project's own default, else the server's
    if (!p) return showSummary(regProjects?.length ? '' : 'No projects are registered yet. <a href="#/projects">Register one</a> (a folder or a repository) and it will be here every time.', !regProjects?.length);
    if (p.status !== 'available') return showSummary(`<b>${esc(p.name)} is ${esc(p.status)}.</b> ${esc(p.errors?.[0]?.message || '')} <a href="#/projects/${esc(p.id)}">Open the project to fix it</a>`, true);
    showSummary('Inspecting…');
    try {
      info = await api('api/projects/inspect', { method: 'POST', body: JSON.stringify({ source: { projectId: p.id } }) });
      regInfo = info;
      if (info.mode === 'local') {
        regModeSel.innerHTML = info.workingModes.map((w) => `<option value="${esc(w)}">${w === 'clone' ? 'Clone — committed state (HEAD), on its own branch' : 'Snapshot — copy of the working tree, including uncommitted changes'}</option>`).join('');
        regModeSel.value = info.workingModes.includes(p.settings?.workingMode) ? p.settings.workingMode : info.defaultWorkingMode;
        regModeSel.disabled = false;
      } else {
        regModeSel.innerHTML = '<option value="clone">Clone — an isolated clone on a new branch</option>';
        regModeSel.disabled = true;
      }
      form.dispatchEvent(new Event('change'));
      render();
    } catch (e) {
      showSummary(esc(e.message), true);
    }
  };
  const loadRegistered = async () => {
    if (!regProjects) {
      try {
        regProjects = (await api('api/projects')).projects;
      } catch (e) {
        regProjects = [];
        showSummary(esc(e.message), true);
      }
      regSel.innerHTML = regProjects.length
        ? regProjects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} — ${esc(p.location.label || p.location.url)}${p.status !== 'available' ? ` · ${esc(p.status)}` : ''}</option>`).join('')
        : '<option value="">(no registered projects)</option>';
      if (preselect && regProjects.some((p) => p.id === preselect)) regSel.value = preselect;
    }
    inspectRegistered();
  };

  const apply = () => {
    const m = mode();
    const r = radio();
    $('#src-registered').hidden = r !== 'registered';
    $('#src-local').hidden = r !== 'local';
    $('#src-github').hidden = r !== 'github';
    $('#install-field').hidden = m === 'new';
    $('#auto-apply-field').hidden = m !== 'local';
    $('#idea-label').innerHTML = m === 'new' ? 'Idea <em>required</em>' : 'What do you want to change? <em>required</em>';
    form.idea.placeholder = m === 'new' ? 'A shared reading list for book clubs…' : 'Add password reset to this application…';
    $('#examples').hidden = m !== 'new';
    $('#repo-field').hidden = m !== 'new' || !config.gitPush;
    $('#deploy-label').textContent = m === 'new' ? 'Deploy a live preview' : 'Authorize a local preview of the result (off by default)';
    form.deploy.checked = m === 'new';
    info = null;
    if (r === 'registered') loadRegistered();
    else if (m === 'local') loadDirs();
    else showSummary('');
  };
  radios.forEach((r) => r.addEventListener('change', apply));
  if (preselect) {
    radios.find((r) => r.value === 'registered').checked = true;
    apply();
  }
  dirSel.addEventListener('change', inspectLocal);
  regSel.addEventListener('change', inspectRegistered);
  regModeSel.addEventListener('change', render);
  $('#reg-publish').addEventListener('change', render);
  modeSel.addEventListener('change', render);
  $('#check-repo').addEventListener('click', inspectRepo);
  form.sourceRepo.addEventListener('change', () => form.sourceRepo.value.trim() && inspectRepo());
  form.ref.addEventListener('change', () => form.sourceRepo.value.trim() && inspectRepo());
  form.publish.addEventListener('change', render);

  return {
    mode,
    validate(fd) {
      if (radio() === 'registered') {
        const p = regSelected();
        return !p ? 'Choose a registered project (or register one under Projects).' : p.status !== 'available' ? `${p.name} is ${p.status}; fix it on its project page first.` : '';
      }
      if (mode() === 'local' && !fd.get('directoryId')) return 'Choose one of the authorized directories.';
      if (mode() === 'github' && !String(fd.get('sourceRepo') || '').trim()) return 'Enter the GitHub repository to change.';
      return '';
    },
    source(fd) {
      const m = mode();
      if (radio() === 'registered') {
        const p = regSelected();
        return { projectId: p.id, workingMode: p.kind === 'local' ? fd.get('regWorkingMode') || undefined : undefined, publish: p.kind === 'remote' && fd.get('regPublish') === 'on', allowInstall: fd.get('allowInstall') === 'on', autoApply: p.kind === 'local' && fd.get('autoApply') === 'on' || undefined };
      }
      if (m === 'local') return { mode: m, directoryId: fd.get('directoryId'), workingMode: fd.get('workingMode') || undefined, allowInstall: fd.get('allowInstall') === 'on', autoApply: fd.get('autoApply') === 'on' || undefined };
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
  // EventSource reconnects by itself and resumes from the last event id, so no event is replayed twice.
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false);
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

function setLive(on) {
  if (current) current.live = on;
  const el = $('#live-ind');
  if (el) {
    el.className = `live ${on ? 'on' : 'off'}`;
    el.textContent = on ? 'live' : 'reconnecting…';
  }
}

// After the backend comes back (or the tab regains focus) re-open the stream and reload the run's state.
async function reconnectRun() {
  if (!current?.id) return;
  const id = current.id;
  try {
    current.run = (await api(`api/runs/${id}`)).run;
    if (current?.es?.readyState === 2) connect();
    renderRun({ keepTab: true });
  } catch {
    /* still down */
  }
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
        <p class="eyebrow">run ${esc(run.id)} · ${esc(run.providerLabel || run.provider)} · ${esc(run.model)}${plannerLabel(run)}${run.engine && run.engine !== 'builtin' ? ` · engine ${esc(run.engine)}` : ''}${run.source ? ` · ${run.source.mode === 'github' ? 'github' : 'local'} ${esc(run.source.label)}` : ''}${run.projectId ? ` · project <a href="#/projects/${esc(run.projectId)}">${esc(run.projectName || 'project')}</a>` : ''}</p>
        <h1>${esc(run.title)} <span class="pill ${esc(run.status)}">${esc(statusLabel(run.status))}</span></h1>
        <div class="meta">
          <span>${tasks.length ? `${done}/${tasks.length} tasks` : 'planning'}</span>
          <span>${fmtNum(tokens)} tokens · ${run.usage?.calls || 0} calls</span>
          <span>${esc(dur(run.startedAt || run.createdAt, run.finishedAt))}</span>
          ${run.executing || ACTIVE.has(run.status) ? `<span id="live-ind" class="live ${current.live === false ? 'off' : 'on'}" role="status">${current.live === false ? 'reconnecting…' : 'live'}</span>` : ''}
          <span>${esc(run.settings.maxParallel)} parallel · ${esc(run.settings.maxAttempts)} attempts</span>
        </div>
      </div>
      <div class="actions">
        ${run.previewLive ? `<a class="btn accent" href="preview/${esc(run.id)}/" target="_blank" rel="noopener">Open app ↗</a>` : ''}
        ${!run.previewLive && run.deployment?.ok && !run.executing ? '<button class="btn" data-act="deploy">Restart preview</button>' : ''}
        ${run.executing ? '<button class="btn" data-act="edit" title="Stop the run where it is, change it, and carry on">Interrupt &amp; edit</button><button class="btn danger" data-act="cancel">Cancel</button>' : ''}
        ${canResume ? '<button class="btn" data-act="edit" title="Change the provider, model, limits or request, or add a note to the agents">Edit run</button><button class="btn" data-act="resume">Resume</button>' : ''}
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
    ${failureCard(run, canResume)}
    ${nextActions(run, canResume)}
    <div class="tabs" role="tablist">
      ${[['overview', 'Overview'], ['graph', 'Task graph'], ['activity', 'Activity'], ['files', 'Files'], ['evidence', 'Evidence'], ['delivery', 'Delivery']]
        .map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${current.tab === k}">${l}<span class="count" data-count="${k}"></span></button>`).join('')}
    </div>`;

  root.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => {
    current.tab = b.dataset.goto;
    renderRun();
  }));
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
  ({ overview: renderOverview, graph: renderGraph, activity: renderActivity, files: renderFiles, evidence: renderEvidenceTab, delivery: renderDelivery })[current.tab](tab, run, escalated);
}


// What failed, what was observed, whether anything changed, and what the user can do next (and where).
function failureCard(run, canResume) {
  const tasks = run.plan?.tasks || [];
  const esc1 = tasks.filter((t) => t.status === 'escalated');
  const stopped = run.error || (['failed', 'cancelled', 'interrupted'].includes(run.status) && !run.executing);
  if (!stopped && !esc1.length) return '';
  const stages = run.project?.stages || {};
  const lastStage = Object.entries(stages).filter(([, s]) => s.state === 'failed').map(([k, s]) => `${k}: ${s.detail || 'failed'}`)[0];
  const changed = run.changes?.files?.length;
  const what = run.error || (esc1.length ? `${esc1.length} task(s) could not be completed: ${esc1.map((t) => `${t.id} (${t.error || 'failed verification'})`).join('; ')}` : `The run is ${run.status.replace(/_/g, ' ')}.`);
  const done = tasks.filter((t) => t.status === 'completed').length;
  const next = [];
  if (canResume) next.push('<b>Edit run</b> (button above) to pick another provider or model, change limits or add a note for the agents, then <b>Resume</b> to continue from where it stopped.');
  if (esc1.length) next.push('<b>Retry, edit or skip</b> each escalated task in the Overview tab.');
  if (run.status === 'needs_attention' && run.error && /token budget/.test(run.error)) next.push('Raise the token budget in <a href="#/settings?group=execution">Settings</a>, then Resume.');
  if (/not ready|ECONN|unreachable|rejected|key/i.test(run.error || '')) next.push('Check the model provider on <a href="#/setup">Setup &amp; health</a>.');
  next.push('Inspect what happened in the <b>Activity</b> and <b>Evidence</b> tabs.');
  return `<div class="card escalation failure" role="alert" style="margin-bottom:16px"><h3>${esc(run.status === 'cancelled' ? 'Run cancelled' : run.status === 'needs_attention' ? 'Run needs your attention' : 'Run stopped')}</h3>
    <dl class="fail-dl"><dt>What failed</dt><dd>${esc(what)}</dd>
    <dt>What the factory observed</dt><dd>${esc(lastStage || `${done}/${tasks.length || 0} tasks completed; status ${run.status.replace(/_/g, ' ')}.`)}</dd>
    <dt>Was anything changed</dt><dd>${run.source ? `Your ${run.source.mode === 'github' ? 'repository' : 'directory'} was <b>not</b> modified — edits happen in an isolated workspace${changed ? ` (${changed} file${changed === 1 ? '' : 's'} changed there so far)` : ''}.` : 'Only the run\'s own workspace was written.'}</dd>
    <dt>What you can do next</dt><dd><ul class="plain">${next.map((n) => `<li>${n}</li>`).join('')}</ul></dd></dl></div>`;
}

function nextActions(run, canResume) {
  if (run.executing || !['completed', 'needs_attention'].includes(run.status) || !run.source || !run.delivery) return '';
  const review = run.review?.decision;
  const items = [];
  if (!review && run.source.mode !== 'local') items.push(['Review the changes', 'Look at the diff and the evidence, then approve or reject.', 'delivery']);
  if (run.source.mode === 'local' && !run.delivery.local?.applied && review !== 'rejected') items.push(['Apply to your directory', review === 'approved' ? 'Approved. Apply writes the files, with a conflict check.' : 'Look at the diff, then Apply: it approves exactly these changes and writes them in one step.', 'delivery']);
  if (review === 'approved' && run.source.mode === 'github' && !run.delivery.publication?.pr) items.push(['Push and open a pull request', 'Approved. Publishing is its own step.', 'delivery']);
  if (review === 'rejected') items.push(['Changes rejected', 'Nothing will be applied or published. Retry tasks or start a new run.', 'overview']);
  if (run.delivery.publication?.pr) items.push(['Pull request ready', run.delivery.publication.pr.url, 'delivery']);
  if (!items.length) return '';
  return `<div class="card nexts" style="margin-bottom:16px"><h2>Next</h2><ul class="plain">${items.map(([t, d, tab]) => `<li><button class="btn" data-goto="${tab}">${esc(t)}</button> <span class="muted">${esc(d)}</span></li>`).join('')}</ul></div>`;
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
  const inst = run.project.install || [];
  const missing = b.some((x) => x.limitation) && !run.source?.allowInstall;
  return `<div class="card"><h2>Baseline <span class="muted mono">before any change</span></h2>
    ${inst.length ? `<p class="muted">Dependencies installed first:</p><table class="plain">${inst.map((x) => `<tr><td>${esc(x.command)}</td><td><span class="pill ${esc(x.status)}">${esc(x.status)}</span></td><td class="muted">${x.status === 'passed' ? `${Math.round((x.durationMs || 0) / 1000)}s` : esc((x.output || '').split('\n').filter(Boolean).slice(-1)[0] || '')}</td></tr>`).join('')}</table>` : ''}
    <table class="plain">${b.map((x) => `<tr><td>${esc(x.command)}</td><td><span class="pill ${esc(x.status)}">${esc(x.status)}</span></td><td class="muted">${esc(x.limitation || x.signature?.[0] || '')}</td></tr>`).join('')}</table>
    ${missing ? `<div class="callout warn" style="margin-top:10px"><p>Some checks could not run because dependencies are not installed, and installing was off for this run. Re-run the same request with installs allowed: dependencies are installed in the isolated workspace first, so the baseline means something.</p><button class="btn accent" type="button" id="rerun-install"${run.executing ? ' disabled' : ''}>Re-run with dependency installs</button></div>` : ''}</div>`;
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

async function renderEvidenceTab(el, run) {
  const catalog = config.pax?.catalog || [];
  await renderEvidence(el, run, api, { toast, catalog, reload: async () => { current.run = (await api(`api/runs/${run.id}`)).run; renderRun(); } });
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
  if (action === 'edit') return openEditRun(current.run);
  btn.disabled = true;
  try {
    if (action === 'cancel') await api(`api/runs/${id}/cancel`, { method: 'POST' });
    if (action === 'resume') await api(`api/runs/${id}/resume`, { method: 'POST' });
    if (action === 'deploy') {
      if (current.run.source && !current.run.settings.deploy && !confirm('Start a local preview of this existing project on the server? It runs the start command the plan proposed. Nothing is deployed anywhere else.')) return void (btn.disabled = false);
      toast('Starting preview…');
      await api(`api/runs/${id}/deploy`, { method: 'POST', body: JSON.stringify({ authorize: true }) });
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
  $('#rerun-install', el)?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const { run: fresh } = await api(`api/runs/${run.id}/rerun`, { method: 'POST', body: JSON.stringify({ allowInstall: true }) });
      toast('Started a new run with dependency installs on');
      location.hash = `#/runs/${fresh.id}`;
    } catch (err) {
      toast(err.message);
      b.disabled = false;
    }
  });
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
    case 'install': return [who, `Install <span class="${e.status === 'passed' ? 'ok' : 'bad'}">${e.status === 'passed' ? '✓' : '✗'}</span> ${esc(e.command)} → ${esc(e.status)}${e.durationMs ? ` (${Math.round(e.durationMs / 1000)}s)` : ''}`, e.status === 'passed' ? 'ok' : 'warn'];
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
  const rv = run.review;
  const approved = rv?.decision === 'approved';
  const canDecide = !busy && d.integrity?.ok && run.changes?.files.length;
  const reviewCard = `<div class="card" id="review-card"><h2>Review <span class="pill ${approved ? 'completed' : rv ? 'failed' : 'skipped'}">${esc(rv ? rv.decision : 'not reviewed')}</span></h2>
    <p>Check the diff (Files tab) and the evidence, then decide. ${s.mode === 'local' ? 'You can approve here, or just press <b>Approve &amp; apply</b> under “Your directory” to do both at once.' : 'Publishing stays disabled until you approve <b>these exact changes</b>; if they change afterwards you must approve again.'}</p>
    ${rv ? `<p class="mono muted">${esc(rv.decision)} ${esc(new Date(rv.at).toLocaleString())} · ${rv.files} file(s)${rv.note ? ` · “${esc(rv.note)}”` : ''}</p>` : ''}
    ${!d.readiness?.ready && d.readiness?.reasons?.length ? `<p class="muted">The factory still reports: ${esc(d.readiness.reasons.join('; '))}. Approval is your decision; it does not change those results.</p>` : ''}
    ${!canDecide ? `<p class="muted">${d.integrity?.ok ? (run.changes?.files.length ? 'The run is still executing.' : 'There are no changes to review.') : 'Source protection failed, so these changes cannot be approved.'}</p>` : ''}
    <label class="field"><span>Note <em>optional</em></span><input id="review-note" maxlength="500" placeholder="Why you approved or rejected" ${canDecide ? '' : 'disabled'}></label>
    <div class="actions"><button class="btn accent" data-review="approve" ${canDecide && !approved ? '' : 'disabled'}>Approve changes</button><button class="btn" data-review="reject" ${canDecide ? '' : 'disabled'}>Reject</button>${rv ? '<button class="btn" data-review="clear">Withdraw decision</button>' : ''}</div></div>`;
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
      ${reviewCard}
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
        ${pub?.pr ? `<p><a class="btn accent" href="${esc(pub.pr.url)}" target="_blank" rel="noopener">Open pull request #${pub.pr.number}${pub.pr.draft ? ' (draft)' : ''} ↗</a> <button class="btn" type="button" data-copy="${esc(pub.pr.url)}">Copy link</button></p>` : ''}
        ${pub?.branch ? `<p class="mono">pushed ${esc(pub.branch)}${pub.sha ? ` @ ${esc(pub.sha.slice(0, 12))}` : ''} <button class="btn" type="button" data-copy="${esc(pub.branch)}">Copy branch</button></p>` : ''}
        <div class="actions"><button class="btn ${pub?.pr ? '' : 'accent'}" data-pub="pr" ${busy || !approved || !config.projects?.canPublish || !d.integrity?.ok || !run.changes?.files.length ? 'disabled' : ''} >${pub?.state === 'failed' || pub?.prError ? 'Retry: push &amp; open pull request' : pub?.pr ? 'Re-run publish (idempotent)' : 'Push branch &amp; open pull request'}</button>
        <button class="btn" data-pub="push" ${busy || !approved || !config.projects?.canPublish || !d.integrity?.ok || !run.changes?.files.length ? 'disabled' : ''}>Push branch only</button></div>
        ${!config.projects?.canPublish ? '<p class="muted">No GitHub token is configured on the server. <a href="#/settings?group=github">Add one in Settings</a>.</p>' : !approved ? '<p class="muted">Approve the changes in the Review card to enable publishing.</p>' : '<p class="muted">Pushes only the run branch (never forced, never the base branch). Opens a draft PR unless everything is verified.</p>'}
      </div>` : `<div class="card" id="local-card"><h2>Your directory</h2>
        ${d.local?.applied ? `<p class="mono">✓ applied ${d.local.applied.files.length} file(s) to the source directory${rv?.auto ? ' automatically' : ''} (nothing staged or committed)</p>` : ''}
        ${d.local?.autoApply && d.local.autoApply.state !== 'applied' ? `<p class="callout warn">Automatic apply did not write anything: ${esc(d.local.autoApply.reason)}. Review the changes and apply them yourself.</p>` : ''}
        ${d.local?.branch ? `<p class="mono">✓ branch <b>${esc(d.local.branch.branch)}</b> added to your repository (nothing checked out)</p>` : ''}
        <ul class="conflicts" id="conflicts" hidden></ul>
        <p class="muted">${d.local?.applied ? '' : 'Nothing was written to your directory during the run. '}Apply approves exactly these changes and writes them, unless a file the run changed has changed in your directory since it started (then nothing is written).${s.readOnly ? ' This directory is in a read-only root, so use the patch.' : ''}</p>
        <div class="actions"><button class="btn accent" data-apply="working-tree" data-approve="${approved ? '' : '1'}" ${busy || s.readOnly || !run.changes?.files.length || !d.integrity?.ok ? 'disabled' : ''}>${d.local?.applied ? 'Apply again' : approved ? 'Apply to my directory' : 'Approve &amp; apply to my directory'}</button>
        ${s.workingMode === 'clone' ? `<button class="btn" data-apply="branch" data-approve="${approved ? '' : '1'}" ${busy || s.readOnly || !run.changes?.files.length || !d.integrity?.ok ? 'disabled' : ''}>${approved ? 'Add as a branch in my repository' : 'Approve &amp; add as a branch'}</button>` : ''}</div>
      </div>`}
      ${run.outputDir ? `<div class="card"><h2>Project folder</h2>${d.output?.ok ? `<p>Full resulting project exported to <code>${esc(run.outputDir)}</code> (a new folder; your source was not touched).</p>` : `<p class="form-error">Could not export to <code>${esc(run.outputDir)}</code>: ${esc(d.output?.error || 'not delivered')}.</p>`}</div>` : ''}
      ${run.security ? `<div class="card"><h2>Security review <span class="muted mono">changed files</span></h2><p>${run.security.blocking} blocking · ${run.security.findings.length} total findings</p>${run.security.findings.length ? `<ul class="plain mono">${run.security.findings.slice(0, 20).map((f) => `<li>[${esc(f.severity)}] ${esc(f.rule)} — ${esc(f.file)}:${f.line}</li>`).join('')}</ul>` : ''}</div>` : ''}
    </div></div>`;
  el.querySelectorAll('[data-review]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try {
      current.run = (await api(`api/runs/${run.id}/review`, { method: 'POST', body: JSON.stringify({ decision: b.dataset.review, note: $('#review-note')?.value || '' }) })).run;
      toast(b.dataset.review === 'approve' ? 'Changes approved' : b.dataset.review === 'reject' ? 'Changes rejected' : 'Decision withdrawn');
    } catch (e) {
      toast(e.message);
    }
    renderRun();
  }));
  el.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast('Copied');
    } catch {
      toast('Copy is not available in this browser context');
    }
  }));
  el.querySelectorAll('[data-pub]').forEach((b) => (b.onclick = async () => {
    const repo = s.repo ? `${s.repo.owner}/${s.repo.name}` : s.label;
    const msg = b.dataset.pub === 'pr' ? `Push the branch ${s.branch} to ${repo} and open a pull request against ${s.baseBranch || 'the base branch'}?` : `Push the branch ${s.branch} to ${repo}? No pull request will be opened.`;
    if (!confirm(`${msg}\n\nOnly the run branch is pushed (never forced). The base branch is not changed.`)) return;
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
    const n = run.changes?.files.length || 0;
    const approving = b.dataset.approve === '1';
    const lead = approving ? 'Approve these exact changes and ' : '';
    const msg = b.dataset.apply === 'branch' ? `${lead}${lead ? 'a' : 'A'}dd the run's work to your repository as the branch da-prompt/${run.id}? Nothing is checked out.` : `${lead}${lead ? 'w' : 'W'}rite ${n} file${n === 1 ? '' : 's'} into your directory “${s.label}”? Nothing is staged or committed, and nothing is written if any of those files changed since the run started.`;
    if (!confirm(msg)) return;
    b.disabled = true;
    try {
      current.run = (await api(`api/runs/${run.id}/apply`, { method: 'POST', body: JSON.stringify({ mode: b.dataset.apply, approve: approving }) })).run;
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
// Boot. If the backend is down, say so and keep retrying instead of leaving a blank page.
for (;;) {
  try {
    config = await api('api/config');
    break;
  } catch (e) {
    main.innerHTML = `<section class="page"><div class="card escalation" role="alert"><h3>The da-prompt backend is not reachable</h3><p>${esc(e.message)}</p><p class="muted">Retrying every few seconds…</p></div></section>`;
    await new Promise((r) => setTimeout(r, 3000));
  }
}
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reconnectRun());
route();
refreshHealthDot(api);
setInterval(() => refreshHealthDot(api), 60_000);
setInterval(() => api('api/health').catch(() => {}), 4000); // drives the "backend not responding" banner
setInterval(() => {
  refreshRuns();
  if (current?.run && ACTIVE.has(current.run.status) && current.tab !== 'activity') {
    const meta = document.querySelector('.meta span:nth-child(3)');
    if (meta) meta.textContent = dur(current.run.startedAt || current.run.createdAt, current.run.finishedAt);
  }
}, 5000);


// Edit run ----------------------------------------------------------------------------------
// Change a stopped run (or interrupt a running one) and carry on: provider, model, planner, engine, limits, the request
// text, and a note to the agents. Work already done is kept; the next attempt uses the new choices.
async function openEditRun(run) {
  const dlg = document.createElement('dialog');
  dlg.className = 'task-dialog edit-run';
  dlg.setAttribute('aria-label', 'Edit run');
  const s = run.settings;
  const i = run.inputs || {};
  dlg.innerHTML = `<form class="task-form" id="er-form" autocomplete="off">
    <h2>${run.executing ? 'Interrupt &amp; edit run' : 'Edit run'}</h2>
    <p class="muted">${run.executing ? 'Saving stops the run where it is, applies your changes, and (with Save &amp; resume) carries on.' : 'Work already done is kept. The next attempt uses your changes.'}</p>
    ${run.error ? `<p class="callout warn" role="note"><b>Why it stopped:</b> ${esc(run.error)}</p>` : ''}
    <h3>Model</h3>
    <div id="er-picker" class="model-picker"></div>
    <h3>Request</h3>
    <label class="field"><span>${run.source ? 'What to change' : 'Idea'}</span><textarea name="idea" rows="3" maxlength="4000">${esc(i.idea)}</textarea></label>
    <label class="field"><span>Requirements</span><textarea name="requirements" rows="2">${esc(i.requirements)}</textarea></label>
    <details class="advanced"><summary>Stack, limits and access</summary><div class="settings">
      <label class="field wide"><span>Stack / constraints</span><input name="stack" value="${esc(i.stack)}"></label>
      <label class="field wide"><span>Budget / limits</span><input name="limits" value="${esc(i.limits)}"></label>
      <label class="field wide"><span>Access / keys</span><input name="tools" value="${esc(i.tools)}"></label></div></details>
    <label class="field"><span>Note to the agents <em>optional, added to the prompt as the newest instruction</em></span><textarea name="note" rows="3" maxlength="2000" placeholder="e.g. Use TypeScript strict mode. Do not touch the billing module."></textarea></label>
    <h3>Limits</h3>
    <div class="settings">
      <label class="field"><span>Parallel agents</span><input name="maxParallel" type="number" min="1" max="8" value="${esc(s.maxParallel)}"></label>
      <label class="field"><span>Attempts per task</span><input name="maxAttempts" type="number" min="1" max="5" value="${esc(s.maxAttempts)}"></label>
      <label class="field"><span>Turns per attempt</span><input name="maxAgentTurns" type="number" min="2" max="200" value="${esc(s.maxAgentTurns)}"></label>
      <label class="field"><span>Token budget</span><input name="tokenBudget" type="number" min="10000" step="10000" value="${esc(s.tokenBudget)}"></label>
      <label class="field"><span>Time limit (minutes)</span><input name="timeoutMinutes" type="number" min="1" value="${esc(s.timeoutMinutes)}"></label>
      ${run.source ? `<label class="field check"><input name="allowInstall" type="checkbox" ${run.source.allowInstall ? 'checked' : ''}> <span>Install dependencies (agents may install what they need)</span></label>` : ''}
    </div>
    <p class="error" id="er-error" role="alert" hidden></p>
    <div class="actions"><button type="button" class="btn" id="er-cancel">Cancel</button><button type="submit" class="btn" data-save>Save</button><button type="submit" class="btn accent" data-save-resume>Save &amp; resume</button></div>
  </form>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  const picker = await mountModelPicker($('#er-picker', dlg), api, {
    initial: { provider: run.provider, model: run.model, plannerProvider: run.plannerProvider !== run.provider ? run.plannerProvider : undefined, plannerModel: run.plannerModel, engine: run.engine || 'builtin', numCtx: run.providerOptions?.numCtx },
  });
  $('#er-cancel', dlg).onclick = () => dlg.close();
  $('#er-form', dlg).addEventListener('submit', async (e) => {
    e.preventDefault();
    const resume = e.submitter?.hasAttribute('data-save-resume');
    const f = e.target;
    const choice = picker.getChoice();
    const body = {
      ...(choice.provider ? { provider: choice.provider, model: choice.model, providerOptions: choice.providerOptions, ...(choice.planner ? { planner: choice.planner } : {}), ...(choice.engine ? { engine: choice.engine } : {}) } : {}),
      inputs: { idea: f.idea.value, requirements: f.requirements.value, stack: f.stack.value, limits: f.limits.value, tools: f.tools.value },
      settings: { maxParallel: f.maxParallel.value, maxAttempts: f.maxAttempts.value, maxAgentTurns: f.maxAgentTurns.value, tokenBudget: f.tokenBudget.value, timeoutMinutes: f.timeoutMinutes.value },
      ...(f.allowInstall ? { allowInstall: f.allowInstall.checked } : {}),
      ...(f.note.value.trim() ? { note: f.note.value } : {}),
      interrupt: Boolean(current.run?.executing),
      resume,
    };
    dlg.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      await api(`api/runs/${run.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      dlg.close();
      toast(resume ? 'Saved; resuming' : 'Saved. Press Resume to continue');
      current.run = (await api(`api/runs/${run.id}`)).run;
      renderRun();
    } catch (err) {
      const box = $('#er-error', dlg);
      box.textContent = err.message;
      box.hidden = false;
      dlg.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  });
}
