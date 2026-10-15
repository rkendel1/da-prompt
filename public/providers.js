// Provider + model selection for new runs, and the Providers management page.

const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS = {
  ready: ['completed', 'ready'],
  no_key: ['skipped', 'needs key'],
  unreachable: ['blocked', 'not running'],
  auth_error: ['failed', 'key rejected'],
  error: ['failed', 'error'],
  empty: ['needs_attention', 'no models'],
  disabled: ['skipped', 'disabled'],
};
const TYPE_LABEL = { anthropic: 'Anthropic API', openai: 'OpenAI-compatible', ollama: 'Ollama', offline: 'Built-in' };
const PREF_KEY = 'da-prompt:model-choice';

const pill = (status) => {
  const [cls, label] = STATUS[status] || ['skipped', status];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
};

let cache = null;
export async function loadProviders(api, { refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < 20_000) return cache.data;
  const data = await api(`api/providers${refresh ? '?refresh=1' : ''}`);
  cache = { at: Date.now(), data };
  return data;
}
export const invalidateProviders = () => (cache = null);

function readPref() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) || 'null') || {};
  } catch {
    return {};
  }
}
function writePref(v) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

// Roles a model can be assigned to (the planner has its own fields). Mirrors ROLES in src/graph.js.
export const ROUTE_ROLES = [
  ['product', 'Product', 'PRD, docs, README'],
  ['engineer', 'Engineer', 'server, store, API, tests'],
  ['design', 'Design', 'UI and copy'],
  ['qa', 'QA', 'tests and fixes'],
  ['devops', 'DevOps', 'Dockerfile, deploy docs'],
  ['research', 'Research', 'findings'],
];
const SEP = '::';
const routeValue = (r) => (r?.provider && r?.model ? `${r.provider}${SEP}${r.model}` : '');
const routeOf = (v) => {
  const i = String(v || '').indexOf(SEP);
  return i > 0 ? { provider: v.slice(0, i), model: v.slice(i + SEP.length) } : null;
};

/** "4/5 tasks verified · 3/5 first try" for a model in one stage, from GET api/models/performance. */
export function trackRecord(perf, provider, model, stage) {
  const m = perf?.models?.find((x) => x.provider === provider && x.model === model);
  if (stage === 'planner') {
    const p = m?.plans;
    if (!p?.total) return 'no planning history';
    return `${p.planned}/${p.total} plans produced${p.standard ? ` · ${p.standard} used the standard plan` : ''}${p.failed ? ` · ${p.failed} failed` : ''}${p.cancelled ? ` · ${p.cancelled} cancelled` : ''}`;
  }
  const s = m?.stages?.[stage];
  if (!s?.tasks) return `no history as ${stage}`;
  return `${s.verified}/${s.tasks} task${s.tasks === 1 ? '' : 's'} verified · ${s.firstTryVerified}/${s.firstTry} first try${s.escalated ? ` · ${s.escalated} escalated` : ''}`;
}

const fmtSize = (b) => (b ? `${(b / 1e9).toFixed(b > 1e10 ? 0 : 1)} GB` : '');
function modelLabel(m) {
  const bits = [m.params, fmtSize(m.size), m.ctx ? `${Math.round(m.ctx / 1024)}k ctx` : null].filter(Boolean);
  return `${m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id}${bits.length ? ` · ${bits.join(' · ')}` : ''}${m.tools === false ? ' · JSON tools' : ''}`;
}

/**
 * Render the provider/model picker into `root`. Returns { getChoice() } for the form submit.
 */
export async function mountModelPicker(root, api, { initial = null } = {}) {
  root.innerHTML = '<p class="muted mono">Checking which providers and models are available…</p>';
  // `initial` presets the picker from an existing run (Edit run) instead of the remembered choice, and is not remembered.
  const state = { data: null, provider: null, pref: initial || readPref(), engines: null };
  const usable = (id) => Boolean(state.data?.providers.some((x) => x.id === id && x.status === 'ready' && x.enabled));

  // Who runs each task. "Built-in" is always available and is the default; others are optional experiments.
  const engineChoice = (p) => {
    const list = state.engines?.engines || [];
    const want = state.engine ?? (state.pref.engine || state.engines?.default || 'builtin');
    const row = list.find((e) => e.id === want);
    return row && usableEngine(row, p).ok ? want : 'builtin';
  };
  const usableEngine = (e, p) => (!e.available ? { ok: false, why: e.reason } : e.id === 'fx' && p?.type === 'offline' ? { ok: false, why: 'The offline demo agents have no model for FX to drive.' } : { ok: true });
  const engineBlock = (p) => {
    const list = state.engines?.engines || [];
    if (list.length < 2) return '';
    const cur = engineChoice(p);
    const row = list.find((e) => e.id === cur);
    const bad = list.filter((e) => e.id !== 'builtin' && !usableEngine(e, p).ok);
    return `<div class="picker-grid" style="align-items:start"><label class="field"><span>Agent engine <em>who runs each task</em></span>
        <select id="pk-engine">${list.map((e) => { const u = usableEngine(e, p); return `<option value="${esc(e.id)}" ${e.id === cur ? 'selected' : ''} ${u.ok ? '' : 'disabled'}>${esc(e.label)}${e.experimental ? ' · experimental' : ''}${u.ok ? '' : ' — unavailable'}</option>`; }).join('')}</select></label>
        <p class="hint" id="pk-engine-note">${esc(row?.description || '')}${row?.id !== 'builtin' ? ' Switch back to Built-in any time; nothing else changes.' : ''}${bad.map((e) => ` ${esc(e.label)}: ${esc(usableEngine(e, p).why)}`).join('')}</p></div>`;
  };

  const render = () => {
    const { providers } = state.data;
    const ready = providers.filter((p) => p.status === 'ready' && p.enabled);
    const notReady = providers.filter((p) => !(p.status === 'ready' && p.enabled));
    const pid = state.provider;
    const p = providers.find((x) => x.id === pid);
    const models = p?.models || [];
    const pref = state.pref.provider === pid ? state.pref : {};
    const model = state.model ?? (pref.model && (models.some((m) => m.id === pref.model) || !models.length) ? pref.model : p?.defaultModel || models[0]?.id || '');
    const custom = state.customModel ?? (model && models.length && !models.some((m) => m.id === model));
    const plannerProv = state.plannerProvider ?? (usable(pref.plannerProvider) && pref.plannerProvider !== pid ? pref.plannerProvider : '');
    const pp = plannerProv ? providers.find((x) => x.id === plannerProv) : p;
    const plannerModels = pp?.models || [];
    const planner = state.planner ?? (pref.plannerProvider === plannerProv || (!pref.plannerProvider && !plannerProv) ? pref.plannerModel : '') ?? '';
    const plannerCustom = state.plannerCustom ?? Boolean(planner && plannerModels.length && !plannerModels.some((m) => m.id === planner));
    const selected = models.find((m) => m.id === model);
    const offline = p?.type === 'offline';
    // Per-role routing: remembered with the provider it was chosen for, like the planner.
    const roles = state.roles ?? (pref.roles || {});
    const retry = state.retry ?? (pref.retryModel ? routeValue(pref.retryModel) : '');
    const standardPlanOnFailure = state.standardPlanOnFailure ?? pref.standardPlanOnFailure !== false;
    const routeSelect = (attrs, value) => {
      const known = ready.filter((x) => x.type !== 'offline').some((x) => x.models.some((m) => routeValue({ provider: x.id, model: m.id }) === value));
      return `<select ${attrs}><option value="">Same as agent model</option>
        ${ready.filter((x) => x.type !== 'offline').map((x) => `<optgroup label="${esc(x.label)}${x.local ? ' · local' : ''}">${x.models.map((m) => { const v = routeValue({ provider: x.id, model: m.id }); return `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(m.id)}</option>`; }).join('')}</optgroup>`).join('')}
        ${value && !known ? `<option value="${esc(value)}" selected>${esc(value.replace(SEP, ' · '))}</option>` : ''}</select>`;
    };
    const effective = (v) => routeOf(v) || { provider: pid, model };
    const overrides = Object.values(roles).filter(Boolean).length + (retry ? 1 : 0);
    // Several local models in one run: Ollama loads each one; if they do not fit in memory together it swaps them per call.
    const localIds = new Set(providers.filter((x) => x.local && x.type !== 'offline').map((x) => x.id));
    const localModels = new Set([...Object.values(roles), retry, `${pid}${SEP}${model}`, plannerProv ? `${plannerProv}${SEP}${planner}` : ''].map(routeOf).filter((r) => r && localIds.has(r.provider) && r.model).map(routeValue));
    const routingBlock = `
      <details class="routing" id="pk-routing" ${overrides || state.routingOpen ? 'open' : ''}>
        <summary>Who does what <em>${overrides ? `${overrides} model override${overrides === 1 ? '' : 's'}` : 'every role uses the agent model'}</em></summary>
        <p class="hint">Give each role its own model, for example a strong local coder for Engineer and a small fast model for docs. The planner is set above. Under each choice: that model's record in that role from your earlier runs.</p>
        <div class="picker-grid route-grid">
          ${ROUTE_ROLES.map(([id, label, what]) => `<label class="field"><span>${esc(label)} <em>${esc(what)}</em></span>${routeSelect(`data-role="${id}"`, routeValue(roles[id]))}
            <small class="hint track" data-track="${id}">${esc(trackRecord(state.perf, effective(routeValue(roles[id])).provider, effective(routeValue(roles[id])).model, id))}</small></label>`).join('')}
          <label class="field"><span>Retry attempts with <em>attempt 2 onward of any task</em></span>${routeSelect('id="pk-retry"', retry)}
            <small class="hint">${retry ? 'A failed task gets its next attempts from this model.' : 'Retries use the same model as the first attempt.'}</small></label>
        </div>
        <label class="field check"><input type="checkbox" id="pk-standardplan" ${standardPlanOnFailure ? 'checked' : ''}> <span>New apps: if the planner can't produce a valid plan, continue with the factory's standard plan (shown on the run) instead of failing</span></label>
        ${localModels.size > 1 ? `<p class="hint warn-text">This run uses ${localModels.size} local models. If they don't fit in memory together, the local server reloads them between calls, which is slow; lower Parallel agents or share models.</p>` : ''}
      </details>`;

    root.innerHTML = `
      <div class="picker-row">
        <label class="field grow"><span>Provider</span>
          <select name="provider" id="pk-provider">
            <optgroup label="Ready">
              ${ready.map((x) => `<option value="${esc(x.id)}" ${x.id === pid ? 'selected' : ''}>${esc(x.label)} — ${x.type === 'offline' ? 'no LLM' : `${x.models.length} model${x.models.length === 1 ? '' : 's'}`}${x.local && x.type !== 'offline' ? ' · local' : ''}</option>`).join('')}
            </optgroup>
            ${notReady.length ? `<optgroup label="Not available — set up on the Providers page">
              ${notReady.map((x) => `<option value="${esc(x.id)}" disabled>${esc(x.label)} — ${esc((STATUS[x.status] || [])[1] || x.status)}</option>`).join('')}
            </optgroup>` : ''}
          </select>
        </label>
        <button type="button" class="btn icon" id="pk-refresh" title="Re-check providers and models" aria-label="Re-check providers and models">↻</button>
      </div>
      ${offline ? '<p class="hint">Offline demo agents build a template app without any LLM — useful to see the factory work. Pick a real provider to build your actual idea.</p>' : `
      <div class="picker-grid">
        <label class="field"><span>Agent model</span>
          ${models.length ? `<select id="pk-model">
            ${models.map((m) => `<option value="${esc(m.id)}" ${!custom && m.id === model ? 'selected' : ''}>${esc(modelLabel(m))}</option>`).join('')}
            <option value="__custom" ${custom ? 'selected' : ''}>Other model id…</option>
          </select>` : ''}
          ${custom || !models.length ? `<input id="pk-model-custom" placeholder="model id, e.g. qwen2.5-coder:14b" value="${esc(custom || !models.length ? model : '')}" ${models.length ? 'style="margin-top:6px"' : ''}>` : ''}
        </label>
        ${p?.type === 'ollama' ? `<label class="field"><span>Context window (tokens)</span>
          <input id="pk-numctx" type="number" min="2048" step="1024" value="${esc(state.numCtx ?? pref.numCtx ?? p.numCtx ?? 32768)}">
        </label>` : ''}
        <label class="field"><span>Tool calling</span>
          <select id="pk-toolmode">
            ${[['auto', 'Auto (native, JSON fallback)'], ['native', 'Native function calling'], ['json', 'JSON in text (for models without tools)']]
              .map(([v, l]) => `<option value="${v}" ${(state.toolMode ?? p?.toolMode ?? 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="picker-grid planner-grid">
        <label class="field"><span>Planner provider <em>design &amp; task graph</em></span>
          <select id="pk-planner-provider">
            <option value="">Same as agents</option>
            ${ready.filter((x) => x.type !== 'offline' && x.id !== pid).map((x) => `<option value="${esc(x.id)}" ${x.id === plannerProv ? 'selected' : ''}>${esc(x.label)}${x.local ? ' · local' : ''}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Planner model</span>
          <select id="pk-planner">
            <option value="">${plannerProv ? 'Provider default' : 'Same as agent model'}</option>
            ${plannerModels.map((m) => `<option value="${esc(m.id)}" ${!plannerCustom && m.id === planner ? 'selected' : ''}>${esc(m.id)}</option>`).join('')}
            <option value="__custom" ${plannerCustom ? 'selected' : ''}>Other model id…</option>
          </select>
          ${plannerCustom ? `<input id="pk-planner-custom" placeholder="model id" value="${esc(planner)}" style="margin-top:6px">` : ''}
        </label>
      </div>
      ${state.perf ? `<p class="hint track">Track record · ${esc(model)} as engineer: ${esc(trackRecord(state.perf, pid, model, 'engineer'))}${planner || !plannerProv ? ` · ${esc(planner || model)} as planner: ${esc(trackRecord(state.perf, plannerProv || pid, planner || model, 'planner'))}` : ''} · <a href="#/providers">all models</a></p>` : ''}
      ${routingBlock}
      ${engineBlock(p)}
      <div class="picker-status">
        <span id="pk-note" class="hint">${selected?.tools === false ? `${esc(selected.id)} doesn't advertise tool support; the factory will use JSON tool calls. Larger coding models work best.` : p?.local ? `Runs locally at ${esc(p.baseUrl)} — no API key needed.` : `Using ${esc(p?.label)}${p?.keySource ? ` · key from ${esc(p.keySource === 'saved' ? 'Providers page' : p.keySource)}` : ''}.`}</span>
        <button type="button" class="btn" id="pk-test">Test model</button>
      </div>`}
      <p class="hint"><a href="#/providers">Manage providers, keys and local servers →</a></p>`;

    $('#pk-provider', root).onchange = (e) => {
      state.provider = e.target.value;
      state.model = state.customModel = state.planner = state.plannerCustom = state.plannerProvider = state.numCtx = state.toolMode = state.roles = state.retry = undefined;
      render();
    };
    const routing = $('#pk-routing', root);
    if (routing) routing.ontoggle = () => (state.routingOpen = routing.open);
    root.querySelectorAll('select[data-role]').forEach((sel) => (sel.onchange = () => {
      state.roles = { ...roles, [sel.dataset.role]: routeOf(sel.value) || undefined };
      render();
    }));
    const retrySel = $('#pk-retry', root);
    if (retrySel) retrySel.onchange = () => { state.retry = retrySel.value; render(); };
    const standardBox = $('#pk-standardplan', root);
    if (standardBox) standardBox.onchange = () => (state.standardPlanOnFailure = standardBox.checked);
    $('#pk-refresh', root).onclick = async () => {
      root.querySelector('#pk-refresh').disabled = true;
      state.data = await loadProviders(api, { refresh: true });
      if (!state.data.providers.some((x) => x.id === state.provider && x.status === 'ready')) state.provider = state.data.defaultProvider;
      render();
    };
    const modelSel = $('#pk-model', root);
    if (modelSel) modelSel.onchange = () => {
      if (modelSel.value === '__custom') {
        state.customModel = true;
        state.model = '';
      } else {
        state.customModel = false;
        state.model = modelSel.value;
      }
      render();
    };
    const customInput = $('#pk-model-custom', root);
    if (customInput) customInput.oninput = () => (state.model = customInput.value.trim());
    const engineSel = $('#pk-engine', root);
    if (engineSel) engineSel.onchange = () => { state.engine = engineSel.value; render(); };
    const plannerProvSel = $('#pk-planner-provider', root);
    if (plannerProvSel) plannerProvSel.onchange = () => {
      state.plannerProvider = plannerProvSel.value;
      state.planner = '';
      state.plannerCustom = false;
      render();
    };
    const plannerSel = $('#pk-planner', root);
    if (plannerSel) plannerSel.onchange = () => {
      state.plannerCustom = plannerSel.value === '__custom';
      state.planner = state.plannerCustom ? '' : plannerSel.value;
      render();
    };
    const plannerCustomInput = $('#pk-planner-custom', root);
    if (plannerCustomInput) plannerCustomInput.oninput = () => (state.planner = plannerCustomInput.value.trim());
    const ctx = $('#pk-numctx', root);
    if (ctx) ctx.oninput = () => (state.numCtx = ctx.value);
    const tm = $('#pk-toolmode', root);
    if (tm) tm.onchange = () => (state.toolMode = tm.value);
    const testBtn = $('#pk-test', root);
    if (testBtn) testBtn.onclick = async () => {
      const note = $('#pk-note', root);
      const choice = getChoice();
      testBtn.disabled = true;
      note.textContent = `Testing ${choice.model}… (local models may take a while to load)`;
      try {
        const r = await api(`api/providers/${encodeURIComponent(choice.provider)}/test`, { method: 'POST', body: JSON.stringify({ model: choice.model }) });
        note.innerHTML = `${r.ok ? '<b class="ok">✓</b>' : '<b class="bad">✗</b>'} ${esc(r.message)} <span class="muted">(${(r.latencyMs / 1000).toFixed(1)}s)</span>`;
      } catch (err) {
        note.innerHTML = `<b class="bad">✗</b> ${esc(err.message)}`;
      }
      testBtn.disabled = false;
    };
  };

  function getChoice() {
    const p = state.data.providers.find((x) => x.id === state.provider);
    const modelSel = $('#pk-model', root);
    const customInput = $('#pk-model-custom', root);
    const model = customInput?.value.trim() || (modelSel && modelSel.value !== '__custom' ? modelSel.value : '') || '';
    const pSel = $('#pk-planner', root)?.value;
    const plannerModel = $('#pk-planner-custom', root)?.value.trim() || (pSel && pSel !== '__custom' ? pSel : '') || undefined;
    const plannerProvider = $('#pk-planner-provider', root)?.value || undefined;
    const offline = p?.type === 'offline';
    const roles = {};
    root.querySelectorAll('select[data-role]').forEach((sel) => {
      const r = routeOf(sel.value);
      if (r) roles[sel.dataset.role] = r;
    });
    const retryModel = routeOf($('#pk-retry', root)?.value);
    const standardPlanOnFailure = $('#pk-standardplan', root)?.checked ?? true;
    const choice = {
      provider: state.provider,
      model: offline ? undefined : model,
      planner: offline ? undefined : { provider: plannerProvider, model: plannerModel },
      engine: offline ? undefined : $('#pk-engine', root)?.value || undefined,
      providerOptions: {
        numCtx: $('#pk-numctx', root)?.value || undefined,
        toolMode: $('#pk-toolmode', root)?.value || undefined,
      },
      // Sent as-is: {} and null clear earlier routing when a run is edited.
      roles: offline ? {} : roles,
      retryModel: offline ? null : retryModel,
      standardPlanOnFailure,
    };
    if (!initial) writePref({ provider: choice.provider, model: choice.model, engine: choice.engine, plannerProvider, plannerModel, numCtx: choice.providerOptions.numCtx, roles, retryModel, standardPlanOnFailure });
    return choice;
  }

  try {
    state.data = await loadProviders(api);
  } catch (err) {
    root.innerHTML = `<p class="form-error">Could not load providers: ${esc(err.message)}</p>`;
    return { getChoice: () => ({}) };
  }
  state.engines = await api('api/engines').catch(() => null);
  state.perf = await api('api/models/performance').catch(() => null);
  state.provider = usable(state.pref.provider) ? state.pref.provider : state.data.defaultProvider;
  render();
  return { getChoice };
}

// ── Providers page ──────────────────────────────────────────────────────────────────────────
/** Every model's results across stored runs, per stage: what to route where, from evidence rather than guesswork. */
function trackTable(perf) {
  const head = '<h2>Model track record</h2><p class="hint">From every stored run: how often each model\'s work passed the factory\'s own verification, per role. Small numbers are anecdotes, not rankings. Choose who does what under <b>Who does what</b> on New run.</p>';
  if (!perf?.models?.length) return `${head}<p class="muted">No runs yet.</p>`;
  const roles = ['product', 'engineer', 'design', 'qa', 'devops', 'research'];
  const cell = (s) => (s?.tasks ? `${s.verified}/${s.tasks}<br><span class="muted">${s.firstTryVerified}/${s.firstTry} first try</span>` : '<span class="muted">–</span>');
  return `${head}<div class="table-scroll"><table class="plain models-table">
    <thead><tr><th>model</th><th>runs</th><th>planner<br><span class="muted">plans produced</span></th>${roles.map((r) => `<th>${r}<br><span class="muted">tasks verified</span></th>`).join('')}<th>last used</th></tr></thead>
    <tbody>${perf.models.map((m) => `<tr><td><b>${esc(m.model)}</b><br><span class="muted">${esc(m.label)}</span></td><td>${m.runs}</td>
      <td>${m.plans.total ? `${m.plans.planned}/${m.plans.total}${m.plans.standard ? `<br><span class="muted">${m.plans.standard} standard plan</span>` : ''}${m.plans.cancelled ? `<br><span class="muted">${m.plans.cancelled} cancelled</span>` : ''}` : '<span class="muted">–</span>'}</td>
      ${roles.map((r) => `<td>${cell(m.stages[r])}</td>`).join('')}<td class="muted">${esc(String(m.lastUsedAt || '').slice(0, 10))}</td></tr>`).join('')}</tbody></table></div>
    ${perf.models.some((m) => m.inferred) ? '<p class="hint">Attempts from before attempts recorded their model are attributed to their run\'s agent model.</p>' : ''}`;
}

export async function renderProvidersPage(main, api, toast) {
  document.title = 'Providers · da-prompt';
  main.innerHTML = `<section class="page">
    <p class="eyebrow">providers · models · keys</p>
    <div class="run-head">
      <div><h1>Providers</h1><p class="lede" style="margin:0">Any OpenAI-compatible API, Anthropic, or a local server such as Ollama, LM Studio, llama.cpp or vLLM. Local servers need no key; they show up as soon as they are running.</p></div>
      <div class="actions"><button class="btn" id="pv-refresh">↻ Re-check all</button></div>
    </div>
    <div id="pv-list" class="pv-list"><p class="muted">Checking providers…</p></div>
    <div class="card" id="pv-track"><h2>Model track record</h2><p class="muted">Loading…</p></div>
    <form class="card pv-add" id="pv-add" autocomplete="off">
      <h2>Add a provider</h2>
      <p class="hint">For another machine running Ollama, a hosted gateway, or any server that speaks the OpenAI Chat Completions API.</p>
      <div class="settings">
        <label class="field"><span>Name</span><input name="label" required placeholder="Ollama on the GPU box"></label>
        <label class="field"><span>API type</span><select name="type"><option value="ollama">Ollama</option><option value="openai" selected>OpenAI-compatible</option><option value="anthropic">Anthropic</option></select></label>
        <label class="field wide"><span>Base URL</span><input name="baseUrl" required placeholder="http://192.168.1.20:11434  or  https://my-gateway.example.com/v1"></label>
        <label class="field wide"><span>API key (optional)</span><input name="apiKey" type="password" placeholder="leave empty for local servers"></label>
      </div>
      <button class="primary" type="submit">Add provider</button>
    </form>
  </section>`;

  const list = $('#pv-list');
  api('api/models/performance').then((perf) => ($('#pv-track').innerHTML = trackTable(perf))).catch((e) => ($('#pv-track').innerHTML = `<h2>Model track record</h2><p class="form-error">${esc(e.message)}</p>`));
  const draw = (data) => {
    const sorted = [...data.providers].sort((a, b) => (b.status === 'ready') - (a.status === 'ready'));
    list.innerHTML = sorted.map((p) => card(p, data.defaultProvider, data)).join('');
    list.querySelectorAll('form[data-id]').forEach((f) => wire(f, data.providers.find((p) => p.id === f.dataset.id)));
  };
  const reload = async (refresh = true) => {
    invalidateProviders();
    draw(await loadProviders(api, { refresh }));
  };

  function card(p, def, data = {}) {
    const offline = p.type === 'offline';
    const models = p.models || [];
    return `<form class="card pv-card ${p.status === 'ready' ? 'is-ready' : ''}" data-id="${esc(p.id)}" autocomplete="off">
      <div class="pv-head">
        <div><h3>${esc(p.label)} ${p.id === def ? `<span class="pill" title="${esc(data.defaultSource ? `chosen by: ${data.defaultSource}` : '')}">default${data.defaultModel ? ` · ${esc(data.defaultModel)}` : ''}</span>` : ''}</h3>
          <span class="mono muted">${esc(TYPE_LABEL[p.type] || p.type)}${p.local && !offline ? ' · local' : ''}${p.custom ? ' · custom' : ''}</span></div>
        ${pill(p.status)}
      </div>
      ${p.message ? `<p class="hint">${esc(p.message)}</p>` : ''}
      ${p.status === 'ready' && !offline ? `<p class="hint">${models.length} model${models.length === 1 ? '' : 's'}: ${esc(models.slice(0, 6).map((m) => m.id).join(', '))}${models.length > 6 ? ', …' : ''}</p>` : ''}
      ${offline ? '<p class="hint">Template agents that need no LLM. Good for trying the factory.</p>' : `
      ${p.status === 'ready' || p.custom ? '' : '<details class="pv-setup"><summary>Set up</summary>'}
      <div class="settings">
        <label class="field wide"><span>Base URL ${p.baseUrlSource && p.baseUrlSource !== 'saved' && p.baseUrlSource !== 'default' ? `<em>from ${esc(p.baseUrlSource)}</em>` : ''}</span>
          <input name="baseUrl" value="${esc(p.baseUrl || '')}"></label>
        ${p.local && !p.needsKey && !p.hasKey ? '' : `<label class="field wide"><span>API key ${p.keySource ? `<em>${p.keySource === 'saved' ? 'saved' : `from ${esc(p.keySource)}`} </em>` : ''} ${p.keyUrl ? `<a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">get a key ↗</a>` : ''}</span>
          <input name="apiKey" type="password" placeholder="${p.hasKey ? 'leave blank to keep the current key' : p.keyEnv ? `paste a key, or set ${esc(p.keyEnv)}` : 'paste a key'}"></label>`}
        ${models.length ? `<label class="field"><span>Default model</span><select name="defaultModel">
          <option value="">Automatic${p.defaultModel ? ` (${esc(p.defaultModel)})` : ''}</option>
          ${models.map((m) => `<option value="${esc(m.id)}">${esc(modelLabel(m))}</option>`).join('')}</select></label>` : ''}
        ${p.type === 'ollama' ? `<label class="field"><span>Context window</span><input name="numCtx" type="number" min="2048" step="1024" value="${esc(p.numCtx || 32768)}"></label>` : ''}
        <label class="field"><span>Tool calling</span><select name="toolMode">
          ${['auto', 'native', 'json'].map((v) => `<option ${p.toolMode === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field check"><input name="enabled" type="checkbox" ${p.enabled ? 'checked' : ''}> <span>Enabled</span></label>
      </div>
      ${p.status === 'ready' || p.custom ? '' : '<button class="btn" type="submit" style="margin-top:10px">Save</button></details>'}`}
      <div class="actions pv-actions">
        ${offline || !(p.status === 'ready' || p.custom) ? '' : '<button class="btn" type="submit">Save</button>'}
        ${p.status === 'ready' ? '<button class="btn" type="button" data-act="test">Test</button>' : ''}
        ${p.custom ? '<button class="btn danger" type="button" data-act="remove">Remove</button>' : p.keySource === 'saved' || p.baseUrlSource === 'saved' ? '<button class="btn" type="button" data-act="reset">Reset to defaults</button>' : ''}
        <span class="hint pv-result"></span>
      </div>
    </form>`;
  }

  function wire(f, p) {
    const out = f.querySelector('.pv-result');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const patch = { baseUrl: fd.get('baseUrl') || null, enabled: fd.get('enabled') === 'on' };
      if (fd.get('apiKey')) patch.apiKey = fd.get('apiKey');
      if (fd.has('defaultModel') && fd.get('defaultModel')) patch.defaultModel = fd.get('defaultModel');
      if (fd.has('numCtx')) patch.numCtx = Number(fd.get('numCtx')) || null;
      if (fd.has('toolMode')) patch.toolMode = fd.get('toolMode');
      out.textContent = 'Saving and checking…';
      try {
        const { provider } = await api(`api/providers/${encodeURIComponent(p.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
        toast(`${provider.label}: ${(STATUS[provider.status] || [])[1] || provider.status}`);
        await reload(false);
      } catch (err) {
        out.textContent = err.message;
      }
    };
    f.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
      if (b.dataset.act === 'test') {
        b.disabled = true;
        const model = f.querySelector('[name=defaultModel]')?.value || undefined;
        out.textContent = 'Testing… local models may need a moment to load';
        try {
          const r = await api(`api/providers/${encodeURIComponent(p.id)}/test`, { method: 'POST', body: JSON.stringify({ model }) });
          out.innerHTML = `${r.ok ? '<b class="ok">✓</b>' : '<b class="bad">✗</b>'} ${esc(r.model || '')}: ${esc(r.message)} <span class="muted">(${(r.latencyMs / 1000).toFixed(1)}s)</span>`;
        } catch (err) {
          out.textContent = err.message;
        }
        b.disabled = false;
        return;
      }
      const msg = b.dataset.act === 'remove' ? `Remove ${p.label}?` : `Forget the saved key and URL for ${p.label}?`;
      if (!confirm(msg)) return;
      try {
        await api(`api/providers/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
        await reload(false);
      } catch (err) {
        out.textContent = err.message;
      }
    }));
  }

  $('#pv-refresh').onclick = () => reload(true);
  $('#pv-add').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const fd = new FormData(f);
    try {
      const { provider } = await api('api/providers', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
      toast(`Added ${provider.label} (${(STATUS[provider.status] || [])[1] || provider.status})`);
      f.reset();
      await reload(false);
    } catch (err) {
      toast(err.message);
    }
  };
  try {
    draw(await loadProviders(api));
  } catch (err) {
    list.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
  }
}
