// Operating pages: Setup & health, Settings, PAX, History, and the run Evidence view.
// Everything shown comes from the backend (real probes, saved settings, stored runs). Nothing here
// decides that something is "ok" on its own: it renders what the API observed.

import { esc, loadProviders, invalidateProviders } from './providers.js';

const $ = (sel, root = document) => root.querySelector(sel);
const STATUS = { ok: ['✓', 'Ready'], warn: ['!', 'Needs attention'], fail: ['✗', 'Problem'], na: ['–', 'Not applicable'] };
const statusPill = (s) => `<span class="hs ${esc(s)}" role="img" aria-label="${esc(STATUS[s]?.[1] || s)}">${STATUS[s]?.[0] || '?'}</span>`;
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const elapsed = (a, b) => {
  if (!a) return '—';
  const s = Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const SOURCE_LABEL = { saved: 'saved in the UI', environment: 'environment variable', default: 'built-in default', startup: 'fixed at startup' };
const sourceBadge = (s) => `<span class="src-badge ${esc(s.source)}" title="Where the effective value comes from">${esc(SOURCE_LABEL[s.source] || s.source)}${s.source === 'environment' && s.env ? ` · ${esc(s.env)}` : ''}</span>`;

function errorCard(e, retryLabel = 'Try again') {
  return `<div class="card escalation" role="alert"><h3>The factory backend did not answer</h3><p>${esc(e.message)}</p>
    <p class="muted">What was observed: the request to the da-prompt server failed. Nothing was changed. If the server is running on another machine or in a container, check that it is up; this page keeps retrying.</p>
    <button class="btn" data-retry>${esc(retryLabel)}</button></div>`;
}

// ── Health badge for the sidebar and the New Run banner ──────────────────────────────────────────

let healthCache = null;
export async function loadHealth(api, { refresh = false } = {}) {
  if (!refresh && healthCache && Date.now() - healthCache.at < 15_000) return healthCache.data;
  const data = await api(`api/system/health${refresh ? '?refresh=1' : ''}`);
  healthCache = { at: Date.now(), data };
  return data;
}
export const invalidateHealth = () => (healthCache = null);

/** Update the sidebar dot from the last health result (never blocks the UI). */
export async function refreshHealthDot(api) {
  const dot = $('#health-dot');
  if (!dot) return null;
  try {
    const h = await loadHealth(api);
    const worst = h.counts.fail ? 'fail' : h.counts.warn ? 'warn' : 'ok';
    dot.className = `hdot ${worst}`;
    dot.title = h.counts.fail ? `${h.counts.fail} problem(s)` : h.counts.warn ? `${h.counts.warn} item(s) need attention` : 'All checks passed';
    return h;
  } catch {
    dot.className = 'hdot fail';
    dot.title = 'Backend unreachable';
    return null;
  }
}

// ── Setup & health ──────────────────────────────────────────────────────────────────────────────

const GROUP_TITLES = { system: 'System', models: 'Models', folders: 'Folders and projects', git: 'Git and GitHub', pax: 'PAX' };

function checkCard(c) {
  const rows = (c.details || []).map((d) => `<tr><th scope="row">${esc(d.k)}</th><td>${esc(d.v)}</td></tr>`).join('');
  const providers = c.providers
    ? `<ul class="plain prov-list">${c.providers.map((p) => `<li><b>${esc(p.label)}</b> <span class="pill ${p.status === 'ready' ? 'completed' : p.status === 'disabled' ? 'skipped' : 'failed'}">${esc(p.status.replace('_', ' '))}</span>${p.fix ? ` <span class="muted">— ${esc(p.fix.text)}</span>${p.fix.ui ? ` <a href="${esc(p.fix.ui.href)}">${esc(p.fix.ui.label)}</a>` : ''}` : ''}</li>`).join('')}</ul>`
    : '';
  const r = c.remediation;
  return `<article class="check ${esc(c.status)}" data-check="${esc(c.id)}" aria-labelledby="ck-${esc(c.id)}">
    <header>${statusPill(c.status)}<h3 id="ck-${esc(c.id)}">${esc(c.label)}</h3></header>
    <p class="summary">${esc(c.summary)}</p>
    ${c.note ? `<p class="muted note">${esc(c.note)}</p>` : ''}
    ${providers}
    ${r ? `<div class="fix"><p><b>${r.host && !r.ui ? 'Needs access to the host:' : 'Next step:'}</b> ${esc(r.text)}</p>${r.ui ? `<a class="btn ${c.status === 'fail' ? 'accent' : ''}" href="${esc(r.ui.href)}">${esc(r.ui.label)}</a>` : ''}${r.host ? '<span class="pill needs_attention" title="A browser cannot change this on the host machine">host-level</span>' : ''}</div>` : ''}
    ${rows ? `<details><summary>What was observed</summary><table class="plain">${rows}</table></details>` : ''}
  </article>`;
}

export async function renderSetupPage(main, api, { toast }) {
  document.title = 'Setup & health · da-prompt';
  main.innerHTML = `<section class="page setup"><p class="eyebrow">first-run setup · system health</p>
    <div class="run-head"><h1>Setup &amp; health</h1><div class="actions"><button class="btn" id="recheck">Re-check now</button></div></div>
    <p class="lede">Every line below is a real probe the server just ran: a write to the data folder, a call to each provider, <code>git --version</code>, the GitHub API, <code>pax --version</code>. Nothing is assumed from a setting existing.</p>
    <div id="health" aria-live="polite"><p class="muted">Running checks…</p></div></section>`;
  const root = $('#health');
  const load = async (refresh) => {
    root.innerHTML = '<p class="muted">Running checks…</p>';
    let h;
    try {
      h = await loadHealth(api, { refresh });
    } catch (e) {
      root.innerHTML = errorCard(e, 'Re-check');
      $('[data-retry]', root).onclick = () => load(true);
      return;
    }
    refreshHealthDot(api);
    const groups = {};
    for (const c of h.checks) (groups[c.group] ||= []).push(c);
    const todo = h.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
    root.innerHTML = `
      <div class="card callout ${h.ready ? (todo.length ? 'warn' : 'ok') : 'fail'}" role="status">
        <h2>${h.ready ? (todo.length ? 'Ready to run — with items worth a look' : 'Everything is ready') : 'Setup is not finished'}</h2>
        <p>${h.ready ? 'The factory can start runs.' : 'The factory cannot run real work yet.'} ${h.counts.ok} ready · ${h.counts.warn} need attention · ${h.counts.fail} problem${h.counts.fail === 1 ? '' : 's'} · checked ${esc(fmtTime(h.checkedAt))}</p>
        <p class="muted">This server is running ${h.environment.kind === 'container' ? `inside a <b>${esc(h.environment.container)} container</b>` : 'directly on <b>a host</b>'} (${esc(h.environment.hostname)}). ${h.environment.kind === 'container' ? 'Folders, the PATH and "localhost" below refer to the container.' : 'Folders, the PATH and "localhost" below refer to that machine.'}</p>
        ${h.ready ? '<a class="btn accent" href="#/">Start a run →</a>' : ''}
        ${!h.admin ? '<p class="muted">You are viewing from a session without host authority, so settings that grant it (folders, tokens, the PAX path) are read-only. Set an access password or open this page on the server machine.</p>' : ''}
      </div>
      ${Object.entries(GROUP_TITLES).filter(([g]) => groups[g]).map(([g, title]) => `<section aria-labelledby="g-${g}"><h2 id="g-${g}" class="grp">${title}</h2><div class="checks">${groups[g].map(checkCard).join('')}</div></section>`).join('')}`;
  };
  $('#recheck').onclick = async (e) => {
    e.target.disabled = true;
    await load(true);
    e.target.disabled = false;
    toast('Checked again');
  };
  load(false);
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────

const STEP_CLASS = { observation: 'read-only', plan: 'dry run', execution: 'runs native tests' };

function control(s, ctx) {
  const id = `set-${s.key}`;
  const dis = !s.editable ? 'disabled' : '';
  const val = s.value;
  switch (s.kind) {
    case 'int':
      return `<input id="${id}" name="${s.key}" type="number" inputmode="numeric" min="${s.min ?? ''}" max="${s.max ?? ''}" value="${esc(val)}" ${dis}> ${s.unit ? `<span class="muted">${esc(s.unit)}</span>` : ''}`;
    case 'bool':
      return `<label class="switch"><input id="${id}" name="${s.key}" type="checkbox" ${val ? 'checked' : ''} ${dis}><span>${val ? 'On' : 'Off'}</span></label>`;
    case 'enum':
      return `<select id="${id}" name="${s.key}" ${dis}>${s.options.map((o) => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    case 'secret':
      return `<div class="secret"><span class="pill ${s.configured ? 'completed' : 'skipped'}">${s.configured ? `configured · ${esc(SOURCE_LABEL[s.source])}` : 'not set'}</span>
        <input id="${id}" name="${s.key}" type="password" autocomplete="new-password" placeholder="${s.configured ? 'Enter a new value to replace it' : 'Enter a value'}" ${dis}>
        ${s.saved ? `<button class="btn" type="button" data-reset="${s.key}" ${dis}>Remove saved value</button>` : ''}</div>`;
    case 'paths':
    case 'hosts':
      return `<textarea id="${id}" name="${s.key}" rows="3" placeholder="${esc(s.placeholder || '')}" ${dis}>${esc((val || []).join('\n'))}</textarea><span class="muted">one per line</span>`;
    case 'steps': {
      const cat = ctx.catalog;
      return `<fieldset class="steps" ${dis}><legend class="sr-only">${esc(s.label)}</legend>${cat.map((c) => `<label><input type="checkbox" name="${s.key}" value="${esc(c.id)}" ${(val || []).includes(c.id) ? 'checked' : ''} ${dis}> <b>${esc(c.title)}</b> <span class="pill ${c.class === 'execution' ? 'needs_attention' : 'skipped'}">${esc(STEP_CLASS[c.class])}</span></label>`).join('')}</fieldset>`;
    }
    case 'provider':
      return `<select id="${id}" name="${s.key}" data-provider ${dis}><option value="">(automatic)</option>${ctx.providers.map((p) => `<option value="${esc(p.id)}" ${p.id === val ? 'selected' : ''} ${p.status === 'ready' ? '' : 'class="unready"'}>${esc(p.label)}${p.status === 'ready' ? '' : ` — ${esc(p.status.replace('_', ' '))}`}</option>`).join('')}</select>`;
    case 'model': {
      const prefix = s.key === 'defaultModel' ? 'defaultProvider' : 'defaultPlannerProvider';
      return `<select id="${id}" name="${s.key}" data-model-for="${prefix}" data-current="${esc(val)}" ${dis}></select>`;
    }
    default:
      return `<input id="${id}" name="${s.key}" type="text" value="${esc(val)}" placeholder="${esc(s.placeholder || '')}" ${dis} autocomplete="off" spellcheck="false">`;
  }
}

function settingRow(s, ctx) {
  const lock = s.hidden ? '<p class="lock">This value grants access to the host and is hidden from this session.</p>' : '';
  const why = !s.editable && !s.hidden ? `<p class="lock">${s.readOnly && s.source === 'startup' ? 'Fixed by a startup option; it cannot be changed while the server runs.' : s.privileged && !ctx.admin ? 'Changing this needs an authenticated session: set an access password, or open the UI on the server machine.' : 'This cannot be changed from the browser. ' + esc('')}</p>` : '';
  return `<div class="setting" data-key="${esc(s.key)}">
    <div class="sh"><label for="set-${esc(s.key)}">${esc(s.label)}</label>${sourceBadge(s)}<span class="apply ${esc(s.apply)}">${s.apply === 'restart' ? 'needs a restart' : 'applies immediately'}</span>${s.restartPending ? '<span class="pill needs_attention">restart pending</span>' : ''}</div>
    <p class="muted help">${esc(s.help)}</p>
    ${s.hidden ? lock : `<div class="ctl">${control(s, ctx)}</div>`}
    ${why}
    ${s.envAlsoSet ? `<p class="muted">The environment also sets this (${esc(s.env)}); the saved value wins. Remove the saved value to use the environment again.</p>` : ''}
    <div class="adv">${s.saved && s.kind !== 'secret' ? `<button class="btn" type="button" data-reset="${esc(s.key)}">Reset to ${s.source === 'saved' && s.defaultValue !== undefined ? esc(Array.isArray(s.defaultValue) ? s.defaultValue.join(', ') || 'empty' : s.defaultValue === '' ? 'default' : s.defaultValue) : 'default'}</button>` : ''}
      ${s.env ? `<details><summary>Advanced</summary><p class="muted mono">Environment variable: ${esc(s.env)}</p></details>` : ''}</div>
    <p class="field-error" role="alert" hidden></p></div>`;
}

export async function renderSettingsPage(main, api, { toast, group: wanted }) {
  document.title = 'Settings · da-prompt';
  main.innerHTML = '<section class="page settings"><p class="muted">Loading settings…</p></section>';
  let view;
  let paxCatalog = [];
  let providers = [];
  try {
    [view, { providers }] = await Promise.all([api('api/settings'), loadProviders(api)]);
    paxCatalog = (await api('api/config')).pax?.catalog || [];
  } catch (e) {
    main.innerHTML = `<section class="page">${errorCard(e)}</section>`;
    $('[data-retry]', main).onclick = () => renderSettingsPage(main, api, { toast, group: wanted });
    return;
  }
  const group = view.groups.find((g) => g.id === wanted)?.id || view.groups[0].id;
  const g = view.groups.find((x) => x.id === group);
  const list = view.settings.filter((s) => s.group === group);
  const ctx = { providers, catalog: paxCatalog, admin: view.admin };
  main.innerHTML = `<section class="page settings"><p class="eyebrow">persistent settings · ${view.file.persisted ? `saved ${esc(fmtTime(view.file.savedAt))}` : 'nothing saved yet'}</p>
    <h1>Settings</h1>
    <p class="lede">Values are validated before they are saved and stored by the server (not in your browser). Precedence, highest first: this run's own options → saved here → environment variable → built-in default. Secrets are write-only.</p>
    <div class="settings-grid"><nav class="card gnav" aria-label="Settings groups">${view.groups.map((x) => `<a href="#/settings?group=${esc(x.id)}" ${x.id === group ? 'aria-current="page"' : ''}>${esc(x.label)}${view.settings.some((s) => s.group === x.id && s.restartPending) ? ' <span class="hdot warn" title="restart pending"></span>' : ''}</a>`).join('')}<a href="#/providers">Providers &amp; keys →</a></nav>
    <form class="card sform" id="sform" novalidate aria-labelledby="gtitle"><h2 id="gtitle">${esc(g.label)}</h2><p class="muted">${esc(g.help)}</p>
      ${!view.admin && list.some((s) => s.privileged) ? '<p class="callout warn" role="note">Some settings here grant access to the host. They are locked in this session. Set an access password (environment variable FACTORY_PASSWORD on the server) or open this UI on the server machine to change them.</p>' : ''}
      ${list.map((s) => settingRow(s, ctx)).join('')}
      <div class="form-actions"><button class="btn accent" type="submit">Save ${esc(g.label.toLowerCase())}</button><span id="save-state" class="muted" role="status" aria-live="polite"></span></div>
    </form></div></section>`;
  const form = $('#sform');

  // Model selects follow the chosen provider and only offer models that provider really lists.
  const fillModels = () => {
    for (const sel of form.querySelectorAll('[data-model-for]')) {
      const pSel = form.querySelector(`[name="${sel.dataset.modelFor}"]`);
      const pid = pSel?.value || '';
      const p = providers.find((x) => x.id === pid) || null;
      const models = p?.models || [];
      const cur = sel.dataset.current;
      sel.innerHTML = `<option value="">(automatic)</option>${models.map((m) => `<option value="${esc(m.id)}" ${m.id === cur ? 'selected' : ''}>${esc(m.id)}${m.params ? ` · ${esc(m.params)}` : ''}</option>`).join('')}`;
      if (cur && !models.some((m) => m.id === cur)) sel.insertAdjacentHTML('afterbegin', `<option value="${esc(cur)}" selected>${esc(cur)} — not offered by this provider</option>`);
      if (!pid) sel.title = 'Choose a provider first, or leave both automatic';
    }
  };
  form.querySelectorAll('[data-provider]').forEach((s) => s.addEventListener('change', () => { form.querySelectorAll('[data-model-for]').forEach((m) => (m.dataset.current = '')); fillModels(); }));
  fillModels();

  const collect = () => {
    const out = {};
    for (const s of list) {
      if (!s.editable) continue;
      const el = form.querySelector(`[name="${s.key}"]`);
      if (!el) continue;
      let v;
      if (s.kind === 'bool') v = el.checked;
      else if (s.kind === 'steps') v = [...form.querySelectorAll(`[name="${s.key}"]:checked`)].map((x) => x.value);
      else if (s.kind === 'secret') {
        if (!el.value) continue;
        v = el.value;
      } else if (s.kind === 'paths' || s.kind === 'hosts') v = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
      else if (s.kind === 'int') v = el.value === '' ? null : Number(el.value);
      else v = el.value;
      const before = s.kind === 'secret' ? undefined : s.value;
      if (s.kind !== 'secret' && JSON.stringify(v) === JSON.stringify(before ?? (s.kind === 'bool' ? false : ''))) continue;
      out[s.key] = v;
    }
    return out;
  };
  const save = async (values, label) => {
    const state = $('#save-state');
    form.querySelectorAll('.field-error').forEach((e) => (e.hidden = true));
    state.textContent = 'Saving…';
    try {
      const r = await api('api/settings', { method: 'PUT', body: JSON.stringify({ values }) });
      invalidateProviders();
      invalidateHealth();
      const restart = r.restartRequired?.length;
      toast(restart ? 'Saved — restart the server for some changes to take effect' : label || 'Saved');
      await renderSettingsPage(main, api, { toast, group });
      const s2 = $('#save-state');
      if (s2) s2.textContent = restart ? `Saved ${new Date().toLocaleTimeString()}. Restart pending for: ${r.restartRequired.join(', ')} — the browser cannot restart the server; restart it from where it runs (for example docker restart).` : `Saved ${new Date().toLocaleTimeString()}${r.changed.length ? '' : ' (no changes)'}.`;
    } catch (e) {
      state.textContent = e.body?.errors ? 'Not saved — fix the highlighted fields.' : `Not saved: ${e.message}`;
      for (const [k, msg] of Object.entries(e.body?.errors || {})) {
        const row = form.querySelector(`.setting[data-key="${k}"] .field-error`);
        if (row) {
          row.textContent = msg;
          row.hidden = false;
        }
      }
      form.querySelector('.field-error:not([hidden])')?.scrollIntoView({ block: 'center' });
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const values = collect();
    if (!Object.keys(values).length) return void ($('#save-state').textContent = 'Nothing to save: no values were changed.');
    save(values);
  });
  form.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = () => save({ [b.dataset.reset]: null }, 'Reset')));
  form.querySelectorAll('.switch input').forEach((i) => i.addEventListener('change', () => (i.nextElementSibling.textContent = i.checked ? 'On' : 'Off')));
}

// ── PAX ─────────────────────────────────────────────────────────────────────────────────────────

const PAX_STATE = {
  ok: ['completed', 'Available'],
  unavailable: ['skipped', 'Not found'],
  permission: ['failed', 'Not executable'],
  incompatible: ['failed', 'Not PAX / incompatible'],
  timeout: ['failed', 'Timed out'],
  error: ['failed', 'Could not start'],
};

export async function renderPaxPage(main, api, { toast }) {
  document.title = 'PAX · da-prompt';
  main.innerHTML = '<section class="page pax"><p class="muted">Checking PAX…</p></section>';
  const draw = async (probeResult) => {
    let d;
    try {
      d = await api('api/pax');
    } catch (e) {
      main.innerHTML = `<section class="page">${errorCard(e)}</section>`;
      $('[data-retry]', main).onclick = () => draw();
      return;
    }
    const s = probeResult || d.status;
    const [cls, label] = PAX_STATE[s.state] || ['skipped', s.state];
    // Capabilities always describe the binary being shown (the configured one, or a candidate being tested).
    const catalog = d.catalog.map((c) => ({ ...c, available: s.steps?.[c.id]?.available ?? false, reason: s.steps?.[c.id]?.reason ?? (s.state === 'ok' ? null : 'PAX is not usable') }));
    main.innerHTML = `<section class="page pax"><p class="eyebrow">project observation · evidence</p>
      <div class="run-head"><h1>PAX <span class="pill ${cls}">${esc(label)}</span></h1><div class="actions"><button class="btn" id="pax-recheck">Check again</button><a class="btn" href="#/settings?group=pax">PAX settings</a></div></div>
      <p class="lede">PAX inspects project files and reports structured observations. da-prompt runs it on the server, stores the output next to each run, and shows it <b>separately</b> from verification.</p>
      <div class="grid-2"><div class="stack">
        <div class="card"><h2>Installation</h2>
          <table class="plain"><tr><th>State</th><td>${esc(s.message || label)}</td></tr>
          <tr><th>Path</th><td class="mono">${esc(s.path || '—')}</td></tr>
          <tr><th>Found by</th><td>${s.source === 'configured' ? `configured path (${esc(d.config.pathSource)})` : 'the PATH of the server process'}</td></tr>
          <tr><th>Version</th><td>${esc(s.version || '—')}</td></tr>
          <tr><th>Commands</th><td class="mono">${esc((s.commands || []).join(' ') || '—')}</td></tr>
          <tr><th>Runs on</th><td>${d.environment.kind === 'container' ? `a ${esc(d.environment.container)} container` : 'a host'} (${esc(d.environment.hostname)})</td></tr></table>
          <p class="muted">PAX is looked up in the environment of the da-prompt <b>server</b> process, not in your browser's or terminal's PATH${d.environment.kind === 'container' ? ' — a PAX installed on your computer is not visible from inside a container' : ''}.</p>
          ${s.state !== 'ok' ? `<div class="fix"><p><b>${s.state === 'unavailable' || s.state === 'permission' ? 'Needs access to the host:' : 'Next step:'}</b> ${s.state === 'unavailable' ? 'Install PAX so that <code>pax</code> is on the server\'s PATH (release archives: github.com/rkendel1/pax/releases), or enter the executable\'s full path in the PAX settings. A browser cannot install a program on the machine that runs the server.' : s.state === 'permission' ? 'Make the file executable for the user the server runs as. This needs host access.' : s.state === 'incompatible' ? 'The program that was found is not PAX, or is not a version this adapter can verify. Point da-prompt at the right executable in the PAX settings.' : 'See the message above, then check the executable runs on the server.'}</p></div>` : ''}
        </div>
        <div class="card"><h2>Test an executable</h2><p class="muted">Check a different path without saving it. This runs the file's <code>--version</code> and <code>--help</code> on the server, so it needs an authenticated session.</p>
          <form id="probe" class="inline-form"><label class="sr-only" for="probe-path">Executable path</label><input id="probe-path" placeholder="/usr/local/bin/pax" autocomplete="off" spellcheck="false"><button class="btn" type="submit">Test</button></form><p class="field-error" id="probe-error" role="alert" hidden></p></div>
      </div><div class="stack">
        <div class="card"><h2>What this installed version can do</h2>
          <table class="plain"><thead><tr><th>Step</th><th>Kind</th><th>Available</th></tr></thead><tbody>${catalog.map((c) => `<tr><td><b>${esc(c.title)}</b><br><span class="muted">${esc(c.about)}</span></td><td><span class="pill ${c.class === 'execution' ? 'needs_attention' : 'skipped'}">${esc(STEP_CLASS[c.class])}</span></td><td>${c.available ? '<span class="hs ok" role="img" aria-label="available">✓</span>' : `<span class="hs fail" role="img" aria-label="not available">✗</span><br><span class="muted">${esc(c.reason || '')}</span>`}</td></tr>`).join('')}</tbody></table>
          <p class="muted">Availability comes from the installed binary's own <code>--version</code> and <code>--help</code>. Collection settings: ${d.config.autoRun ? 'runs automatically' : 'on request, or per run'} · steps ${esc(d.config.steps.join(', '))} · timeout ${Math.round(d.config.timeoutMs / 1000)}s.</p></div>
        <div class="card callout"><h2>What PAX evidence means</h2><p>${esc(d.semantics)}</p><ul class="plain"><li>An agent saying it worked is a claim, not evidence.</li><li>A process exiting 0 is not proof the requested outcome was achieved.</li><li>PAX presence or invocation never makes a run "verified".</li><li>Factory verification and PAX observations are always shown in separate sections.</li></ul></div>
      </div></div></section>`;
    $('#pax-recheck').onclick = async (e) => {
      e.target.disabled = true;
      await draw();
      toast('Checked PAX again');
    };
    $('#probe').onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#probe-error');
      err.hidden = true;
      try {
        const r = await api('api/pax/probe', { method: 'POST', body: JSON.stringify({ path: $('#probe-path').value }) });
        await draw(r.status);
        toast(`${r.status.state === 'ok' ? 'Looks like PAX ' + r.status.version : 'Not usable: ' + r.status.state}`);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    };
  };
  draw();
}

// ── History ─────────────────────────────────────────────────────────────────────────────────────

export async function renderHistoryPage(main, api) {
  document.title = 'History · da-prompt';
  main.innerHTML = '<section class="page history"><p class="muted">Loading runs…</p></section>';
  let runs;
  try {
    runs = (await api('api/runs')).runs;
  } catch (e) {
    main.innerHTML = `<section class="page">${errorCard(e)}</section>`;
    $('[data-retry]', main).onclick = () => renderHistoryPage(main, api);
    return;
  }
  main.innerHTML = `<section class="page history"><p class="eyebrow">every run the server has on record</p><h1>History</h1>
    <form class="filters" role="search" aria-label="Filter runs">
      <label class="field"><span>Search</span><input id="h-q" type="search" placeholder="task, project, run id…" autocomplete="off"></label>
      <label class="field"><span>Status</span><select id="h-status"><option value="">any</option>${[...new Set(runs.map((r) => r.status))].map((s) => `<option>${esc(s)}</option>`).join('')}</select></label>
      <label class="field"><span>Project</span><select id="h-source"><option value="">any</option><option value="new">new project</option><option value="local">local directory</option><option value="github">GitHub</option></select></label>
      <label class="field"><span>Verification</span><select id="h-verdict"><option value="">any</option><option value="verified">verified</option><option value="verified-with-preexisting-failures">verified, pre-existing failures</option><option value="partially-verified">partially verified</option><option value="unverified">not verified</option><option value="failed">failed</option></select></label>
    </form><p class="muted" id="h-count" role="status" aria-live="polite"></p><div id="h-list"></div></section>`;
  const draw = () => {
    const q = $('#h-q').value.trim().toLowerCase();
    const st = $('#h-status').value;
    const so = $('#h-source').value;
    const ve = $('#h-verdict').value;
    const rows = runs.filter((r) => (!st || r.status === st) && (!so || (so === 'new' ? !r.source : r.source?.mode === so)) && (!ve || r.verdict === ve) && (!q || `${r.title} ${r.idea} ${r.id} ${r.source?.label || ''} ${r.provider} ${r.model || ''}`.toLowerCase().includes(q)));
    $('#h-count').textContent = runs.length ? `${rows.length} of ${runs.length} run${runs.length === 1 ? '' : 's'}` : '';
    $('#h-list').innerHTML = !runs.length
      ? '<div class="card empty-state"><h2>No runs yet</h2><p>Runs you start appear here with their verification, review and delivery state.</p><a class="btn accent" href="#/">Start a run</a></div>'
      : !rows.length
        ? '<div class="card empty-state"><h2>No runs match</h2><p>Change or clear the filters.</p></div>'
        : `<div class="card tablewrap"><table class="plain runs-table"><thead><tr><th>Task</th><th>Project</th><th>Status</th><th>Model</th><th>Started</th><th>Elapsed</th><th>Verification</th><th>Delivery</th></tr></thead><tbody>${rows.map((r) => `<tr>
          <td><a href="#/runs/${esc(r.id)}"><b>${esc(r.title)}</b></a><br><span class="muted mono">${esc(r.id)}</span></td>
          <td>${r.source ? `${r.source.mode === 'github' ? 'GitHub' : 'local'} · ${esc(r.source.label)}` : 'new project'}</td>
          <td><span class="pill ${esc(r.status)}">${esc(r.status.replace(/_/g, ' '))}</span>${r.error ? `<br><span class="muted">${esc(r.error)}</span>` : ''}</td>
          <td>${esc(r.provider)}${r.model ? `<br><span class="muted">${esc(r.model)}</span>` : ''}</td>
          <td>${esc(fmtTime(r.startedAt || r.createdAt))}</td><td>${esc(elapsed(r.startedAt, r.finishedAt))}</td>
          <td>${r.verdict ? `<span class="pill ${esc(r.verdict)}">${esc(r.verdict.replace(/-/g, ' '))}</span>` : r.checklistOk === undefined ? '<span class="muted">not yet</span>' : r.checklistOk ? 'checklist passed' : 'checklist failed'}${r.pax ? `<br><span class="muted">PAX: ${esc(r.pax)}</span>` : ''}</td>
          <td>${r.publication?.pr ? `<a href="${esc(r.publication.pr)}" target="_blank" rel="noopener">PR #${r.publication.prNumber} ↗</a>` : r.publication ? esc(r.publication.state) : r.review ? `review: ${esc(r.review)}` : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  };
  for (const id of ['h-q', 'h-status', 'h-source', 'h-verdict']) $(`#${id}`).addEventListener('input', draw);
  $('.filters').addEventListener('submit', (e) => e.preventDefault());
  draw();
}

// ── Evidence (a run tab) ────────────────────────────────────────────────────────────────────────

const OUTCOME_CLASS = { observed: 'completed', 'no-drift': 'completed', planned: 'completed', passed: 'completed', fixed: 'completed', 'drift-detected': 'needs_attention', failed: 'failed', ambiguous: 'needs_attention', unsupported: 'needs_attention', not_run: 'needs_attention', preexisting: 'needs_attention', 'not-supported': 'skipped', error: 'failed', timeout: 'failed', permission: 'failed', unavailable: 'failed', 'unrecognized-output': 'failed', cancelled: 'skipped', regression: 'failed', 'new-failure': 'failed', blocked: 'failed' };
const outcomePill = (o) => `<span class="pill ${OUTCOME_CLASS[o] || 'skipped'}">${esc(String(o).replace(/[-_]/g, ' '))}</span>`;
const VERDICT = { verified: 'verified', 'verified-with-preexisting-failures': 'verified, pre-existing failures remain', 'partially-verified': 'partially verified', unverified: 'not verified', failed: 'failed' };

export async function renderEvidence(el, run, api, { toast, reload, catalog }) {
  el.innerHTML = '<p class="muted">Loading evidence…</p>';
  let ev;
  let arts;
  try {
    [{ evidence: ev }, arts] = await Promise.all([api(`api/runs/${run.id}/evidence`), api(`api/runs/${run.id}/artifacts`)]);
  } catch (e) {
    el.innerHTML = `<div class="card empty-state">${esc(e.message)}</div>`;
    return;
  }
  const f = ev.factory;
  const checkRows = (rows) => rows.map((v) => `<tr><td class="mono">${esc(v.command)}</td><td>${outcomePill(v.state)}</td><td>exit ${esc(v.exitCode)}</td></tr>${!v.ok && v.output ? `<tr><td colspan="3"><pre class="out">${esc(v.output)}</pre></td></tr>` : ''}`).join('');
  const pax = ev.pax;
  const busy = run.executing;
  el.innerHTML = `
    ${ev.missing.length ? `<div class="card callout warn" role="note"><h2>Evidence that is missing or incomplete</h2><ul class="plain">${ev.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}
    ${ev.notes.length ? `<div class="card callout warn" role="note"><h2>Sources disagree</h2><ul class="plain">${ev.notes.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}
    <div class="grid-2"><div class="stack">
      <section class="card" aria-labelledby="ev-factory"><h2 id="ev-factory">Factory verification ${f.verdict ? `<span class="pill ${esc(f.verdict)}">${esc(VERDICT[f.verdict])}</span>` : ''}</h2>
        <p class="muted">${esc(f.note)}</p>
        ${f.baseline.length ? `<h3>Baseline (before any change)</h3><table class="plain">${f.baseline.map((b) => `<tr><td class="mono">${esc(b.command)}</td><td>${outcomePill(b.status)}</td><td class="muted">${esc(b.limitation || b.failing[0] || '')}</td></tr>`).join('')}</table>` : ''}
        ${f.final.length ? `<h3>At the end of the run</h3><table class="plain">${checkRows(f.final)}</table>` : '<p class="muted">No end-of-run check results are on record.</p>'}
        ${f.summary ? `<p class="muted">${f.summary.passed + f.summary.fixed} passed · ${f.summary.preexisting} pre-existing · ${f.summary.regressions + f.summary.newFailures} new failures · ${f.summary.unavailable + f.summary.blocked} not run</p>` : ''}
        <h3>Task checks</h3>${f.tasks.length ? `<table class="plain">${f.tasks.map((t) => `<tr><td><b>${esc(t.taskId)}</b></td><td>${outcomePill(t.status)}</td><td>${t.checks.length ? t.checks.map((c) => `<span class="mono">${esc(c.command)}</span> ${outcomePill(c.state)}`).join('<br>') : '<span class="muted">no check on record</span>'}</td></tr>`).join('')}</table>` : '<p class="muted">No task history.</p>'}
        ${f.security ? `<p class="muted">Security scan: ${f.security.blocking} blocking · ${f.security.findings} findings</p>` : ''}
      </section>
      <section class="card" aria-labelledby="ev-agent"><h2 id="ev-agent">Agent claims</h2><p class="muted">${esc(ev.agent.note)}</p>
        ${ev.agent.claims.length ? `<ul class="plain">${ev.agent.claims.map((c) => `<li><b>${esc(c.taskId)}</b> (${esc(c.role)}, ${c.attempts} attempt${c.attempts === 1 ? '' : 's'}): “${esc(c.summary)}”</li>`).join('')}</ul>` : '<p class="muted">No agent reported a result yet.</p>'}</section>
    </div><div class="stack">
      <section class="card" aria-labelledby="ev-pax"><h2 id="ev-pax">PAX observation ${pax.state === 'collected' ? '<span class="pill skipped">not verification</span>' : `<span class="pill ${pax.state === 'not-requested' ? 'skipped' : 'needs_attention'}">${esc(pax.state)}</span>`}</h2>
        <p class="muted">${esc(pax.note)}</p>
        ${pax.message ? `<p class="form-error">${esc(pax.message)}</p>` : ''}
        ${pax.binary?.version ? `<p class="mono muted">PAX ${esc(pax.binary.version)} · ${esc(pax.binary.source === 'configured' ? 'configured path' : 'from PATH')} · collected ${esc(fmtTime(pax.collectedAt))}</p>` : ''}
        ${(pax.steps || []).map((s) => `<div class="paxstep"><div class="ps-head"><b>${esc(s.title)}</b> ${outcomePill(s.outcome)}${s.exitCode != null ? ` <span class="muted">exit ${s.exitCode} · ${s.durationMs}ms</span>` : ''}</div>
          <p>${esc(s.detail)}</p>${s.result ? `<details><summary>Structured result</summary><pre class="out">${esc(JSON.stringify(s.result, null, 2))}</pre></details>` : ''}${s.stderrTail ? `<details><summary>stderr</summary><pre class="out">${esc(s.stderrTail)}</pre></details>` : ''}
          ${(s.artifacts || []).length ? `<p class="muted">Evidence: ${s.artifacts.map((a) => `<a href="api/runs/${esc(run.id)}/download/pax/${esc(a.name)}">${esc(a.name)}</a> (${fmtBytes(a.bytes)}, sha256 ${esc(a.sha256.slice(0, 12))}…)`).join(' · ')}</p>` : ''}</div>`).join('') || (pax.state === 'not-requested' ? '<p class="muted">PAX was not requested for this run.</p>' : '')}
        <form id="pax-run" class="paxform" aria-label="Collect PAX evidence"><fieldset ${busy ? 'disabled' : ''}><legend>Collect evidence now</legend>
          ${(catalog || []).map((c) => `<label><input type="checkbox" name="step" value="${esc(c.id)}" ${['info', 'doctor', 'reality', 'drift'].includes(c.id) ? 'checked' : ''}> ${esc(c.title)} <span class="pill ${c.class === 'execution' ? 'needs_attention' : 'skipped'}">${esc(STEP_CLASS[c.class])}</span></label>`).join('')}
          <p class="muted">“Test execution result” runs the project's native tests through PAX and may change files exactly as that command does; you will be asked to confirm.</p>
          <button class="btn" type="submit">Run PAX on this run's workspace</button></fieldset></form>
      </section>
      <section class="card" aria-labelledby="ev-art"><h2 id="ev-art">Artifacts</h2>
        <ul class="plain">${arts.delivery.map((a) => `<li><a href="${esc(a.href)}">${esc(a.label)}</a> <span class="muted">${esc(a.name)} · ${fmtBytes(a.bytes)}</span></li>`).join('') || '<li class="muted">No delivery artifacts yet.</li>'}${arts.pax.map((a) => `<li><a href="${esc(a.href)}">PAX evidence: ${esc(a.name)}</a> <span class="muted">${fmtBytes(a.bytes)}${a.sha256 ? ` · sha256 ${esc(a.sha256.slice(0, 12))}…` : ''}</span></li>`).join('')}</ul></section>
    </div></div>`;
  $('#pax-run').onsubmit = async (e) => {
    e.preventDefault();
    const steps = [...el.querySelectorAll('#pax-run [name=step]:checked')].map((x) => x.value);
    if (!steps.length) return toast('Choose at least one PAX step');
    const confirmTests = steps.includes('test');
    if (confirmTests && !confirm("This runs the project's native tests through PAX in the run's workspace. They can change files exactly as that command normally does (your original project is not touched). Continue?")) return;
    e.target.querySelector('button').disabled = true;
    try {
      await api(`api/runs/${run.id}/pax`, { method: 'POST', body: JSON.stringify({ steps, confirmTests }) });
      toast('PAX evidence collected');
      await reload();
    } catch (ex) {
      toast(ex.message);
      e.target.querySelector('button').disabled = false;
    }
  };
}
