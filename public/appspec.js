// The application selector on New run: profiles, a searchable, grouped technology selector, the selected stack at a glance,
// and a review of what will happen before anything runs. Everything it shows comes from the server: the catalog
// (GET api/catalog) and, for the current selection, each option's state, the diagnostics and the plan
// (POST api/spec/validate, the same checks run creation applies). No technology or rule is defined here.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS_LABEL = { supported: 'supported', constrained: 'constrained', planned: 'not yet supported' };
const ACTION_LABEL = { preserve: 'Keep (already there)', satisfied: 'Requested and already present (verified at the end)', add: 'Add', observe: 'Observe' };

/**
 * Mount the selector into `root`. `ctx.lifecycle()` is 'new' or 'existing', `ctx.source()` the current source descriptor
 * (or null), `ctx.provider()` the chosen provider id, `ctx.idea()` the request text. Returns { spec(), validate(), refresh() }.
 */
export function mountAppSpec(root, api, ctx) {
  const state = { catalog: null, spec: null, lifecycle: null, result: null, filter: '', seq: 0, reason: '' };
  root.innerHTML = '<p class="muted">Loading the technology catalog…</p>';

  const fieldOf = (category) => state.catalog.categories.find((c) => c.id === category).field;
  const fresh = (lifecycle) => ({ profile: lifecycle === 'existing' ? 'existing-enhancement' : 'quick-prototype' });

  function check() {
    state.pending = run();
    return state.pending;
  }

  async function run() {
    const seq = ++state.seq;
    const body = { spec: state.spec, source: state.lifecycle === 'existing' ? ctx.source() : undefined, provider: ctx.provider(), idea: ctx.idea() };
    let result;
    try {
      result = await api('api/spec/validate', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      result = { ok: false, diagnostics: [{ level: 'error', code: 'request', message: e.message, resolution: 'Choose a project first, or try again.' }], options: [] };
    }
    if (seq !== state.seq || !root.isConnected) return; // a newer check is on its way, or the page changed
    state.result = result;
    if (result.spec) state.spec = stripDerived(result.spec);
    render();
  }

  // What the server normalized is what the user selected; identity and lifecycle are filled in again on submit.
  const stripDerived = (s) => {
    const out = { ...s };
    delete out.identity;
    delete out.version;
    return out;
  };

  function select(id) {
    const e = state.catalog.entries.find((x) => x.id === id);
    const cat = state.catalog.categories.find((c) => c.id === e.category);
    const field = cat.field;
    const cur = state.spec[field];
    if (cat.select === 'one') state.spec[field] = cur === id && state.lifecycle === 'existing' ? null : id;
    else {
      const list = Array.isArray(cur) ? cur : [];
      const exclusive = cat.exclusive || [];
      if (list.includes(id)) state.spec[field] = list.filter((x) => x !== id);
      else if (exclusive.includes(id)) state.spec[field] = [id];
      else state.spec[field] = [...list.filter((x) => !exclusive.includes(x)), id];
    }
    if (id === 'appport') state.spec.appport = { mode: state.spec[field].includes('appport') ? 'require' : state.lifecycle === 'existing' ? 'observe' : 'exempt', ...(state.lifecycle === 'new' && !state.spec[field].includes('appport') ? { reason: state.reason } : {}) };
    state.spec.profile = null; // customized: the profile was only the starting point
    check();
  }

  function render() {
    const r = state.result || {};
    const opts = new Map((r.options || []).map((o) => [o.id, o]));
    const q = state.filter.trim().toLowerCase();
    const profiles = state.catalog.profiles.filter((p) => p.lifecycle === state.lifecycle);
    const errors = (r.diagnostics || []).filter((d) => d.level === 'error');
    const warnings = (r.diagnostics || []).filter((d) => d.level !== 'error');
    const appportOff = state.lifecycle === 'new' && !(state.spec.capabilities || []).includes('appport');
    const plan = r.plan?.items || [];
    const byAction = (a) => plan.filter((i) => i.action === a);
    const name = (id) => state.catalog.entries.find((e) => e.id === id)?.name || id;
    root.innerHTML = `
      <div class="appspec-profiles" role="group" aria-label="Starting profiles">
        ${profiles.map((p) => `<button type="button" class="chip${state.spec.profile === p.id ? ' on' : ''}" data-profile="${esc(p.id)}" aria-pressed="${state.spec.profile === p.id}" title="${esc(p.description)}">${esc(p.name)}</button>`).join('')}
        <span class="muted small">${state.spec.profile ? 'A starting point: change anything below.' : 'Customized.'}</span>
      </div>
      <div class="appspec-summary ${r.ok ? 'ok' : 'bad'}" aria-live="polite"><b>${esc(r.summary || '…')}</b> <span class="pill ${r.ok ? 'completed' : 'failed'}">${r.ok ? 'valid' : `${errors.length} problem${errors.length === 1 ? '' : 's'}`}</span></div>
      <label class="field appspec-search"><span>Find a technology</span><input type="search" id="appspec-search" value="${esc(state.filter)}" placeholder="react, feltdb, docker…"></label>
      ${state.catalog.categories.map((c) => {
        const entries = state.catalog.entries.filter((e) => e.category === c.id && (!q || `${e.name} ${e.id} ${e.description}`.toLowerCase().includes(q)));
        if (!entries.length) return '';
        const many = c.select === 'many';
        const card = (e) => {
          const o = opts.get(e.id) || { state: 'available' };
          const off = o.state === 'unavailable' || o.state === 'incompatible';
          const badge = o.detected ? 'detected' : STATUS_LABEL[e.status];
          // Short by default: a note only when it changes what the user should do.
          const note = o.reason || o.needs || (o.selected && e.constraint) || '';
          return `<label class="opt st-${esc(o.state)}${o.detected ? ' detected' : ''}" title="${esc(`${e.description}${e.constraint ? ` Constraint: ${e.constraint}` : ''}`)}"><input type="${many ? 'checkbox' : 'radio'}" name="appspec-${esc(c.id)}" value="${esc(e.id)}"${o.selected ? ' checked' : ''}${off && !o.selected ? ' disabled' : ''}><span class="opt-body"><span><b>${esc(e.name)}</b> <span class="pill tag st-${esc(o.detected ? 'detected' : e.status)}">${esc(badge)}</span></span>${note ? `<small>${esc(note)}</small>` : ''}</span></label>`;
        };
        const later = entries.filter((e) => (opts.get(e.id) || {}).state === 'unavailable');
        const now = entries.filter((e) => !later.includes(e));
        return `<section class="appspec-cat" aria-label="${esc(c.label)}"><h4>${esc(c.label)} <em>${many ? 'choose any' : 'choose one'}${state.lifecycle === 'existing' && c.required ? '; leave empty to keep what the project has' : ''}</em></h4>
          <div class="appspec-opts">${now.map(card).join('')}</div>
          ${later.length ? `<details class="appspec-more"${q ? ' open' : ''}><summary>${later.length} not yet supported: ${esc(later.map((e) => e.name).join(', '))}</summary><ul class="plain">${later.map((e) => `<li><b>${esc(e.name)}</b> <span class="muted">${esc((opts.get(e.id) || {}).reason || '')}</span></li>`).join('')}</ul></details>` : ''}</section>`;
      }).join('')}
      <label class="field wide" id="appport-reason"${appportOff ? '' : ' hidden'}><span>Why this app should not expose an AppPort boundary <em>required</em></span><input name="appportException" maxlength="300" value="${esc(state.reason)}" placeholder="e.g. an internal batch job with no callers"></label>
      <section class="appspec-review" aria-label="Review before starting"><h4>Review before starting</h4>
        <dl class="fail-dl">
          <dt>Architecture</dt><dd>${esc(state.spec.architecture ? name(state.spec.architecture) : state.lifecycle === 'existing' ? 'as the project has it' : 'not chosen')}</dd>
          <dt>Selected</dt><dd>${esc(r.summary || '')}</dd>
          <dt>Capabilities</dt><dd>${esc((state.spec.capabilities || []).map(name).join(', ') || (state.lifecycle === 'existing' ? 'AppPort is observed and reported, not added' : 'none'))}</dd>
          ${state.lifecycle === 'existing' ? `<dt>Already there (kept)</dt><dd>${r.observed ? esc(byAction('preserve').map((i) => name(i.id)).join(', ') || 'nothing detected') : `<span class="muted">detected ${esc(r.observation || 'when the run starts')}</span>`}</dd>` : ''}
          <dt>${state.lifecycle === 'existing' ? 'Changes' : 'Generated'}</dt><dd>${esc(byAction('add').map((i) => name(i.id)).join(', ') || 'nothing beyond the request')}${byAction('satisfied').length ? `<br><span class="muted">already present, not replaced: ${esc(byAction('satisfied').map((i) => name(i.id)).join(', '))}</span>` : ''}</dd>
          <dt>Problems</dt><dd>${errors.length || warnings.length ? `<ul class="plain">${[...errors, ...warnings].map((d) => `<li class="${d.level === 'error' ? 'bad' : 'warn-text'}">${esc(d.message)} <span class="muted">${esc(d.resolution)}</span></li>`).join('')}</ul>` : 'none'}</dd>
        </dl>
        <p class="hint">Nothing is modified until the run starts, and the run checks this again (for an existing project, against what is actually in it) before any change. Requested technologies count only when verification confirms them.</p>
      </section>`;

    root.querySelectorAll('[data-profile]').forEach((b) => (b.onclick = () => {
      state.spec = { profile: b.dataset.profile };
      check();
    }));
    root.querySelectorAll('.appspec-opts input').forEach((i) => (i.onchange = () => select(i.value)));
    const search = $('#appspec-search', root);
    search.oninput = () => {
      state.filter = search.value;
      const pos = search.selectionStart;
      render();
      const again = $('#appspec-search', root);
      again.focus();
      again.setSelectionRange(pos, pos);
    };
    const reason = $('input[name=appportException]', root);
    reason.oninput = () => {
      state.reason = reason.value;
      state.spec.appport = { mode: 'exempt', reason: reason.value };
      clearTimeout(state.timer);
      state.timer = setTimeout(check, 300);
    };
  }

  const ready = api('api/catalog').then((catalog) => {
    state.catalog = catalog;
    state.lifecycle = ctx.lifecycle();
    state.spec = fresh(state.lifecycle);
    return check();
  }).catch((e) => {
    root.innerHTML = `<p class="form-error">The technology catalog could not be loaded: ${esc(e.message)}</p>`;
  });

  return {
    ready,
    /** Called when the source or provider changes: a new lifecycle starts from its default profile. */
    refresh() {
      if (!state.catalog) return;
      const life = ctx.lifecycle();
      if (life !== state.lifecycle) {
        state.lifecycle = life;
        state.spec = fresh(life);
      }
      check();
    },
    spec: () => ({ ...state.spec, lifecycle: state.lifecycle }),
    /** Before starting: catch up with the current source and provider, and validate again (never submit a stale check). */
    async sync() {
      await ready;
      if (!state.catalog) return;
      const life = ctx.lifecycle();
      if (life !== state.lifecycle) {
        state.lifecycle = life;
        state.spec = fresh(life);
      }
      await check();
    },
    validate() {
      if (!state.result) return 'The application selection is still being checked.';
      if (state.lifecycle === 'new' && !(state.spec.capabilities || []).includes('appport') && !state.reason.trim()) return 'Say why this app should not expose an AppPort boundary, or tick AppPort again.';
      if (!state.result.ok) return `The application selection has problems: ${state.result.diagnostics.filter((d) => d.level === 'error').map((d) => d.message).join(' ')}`;
      return '';
    },
    result: () => state.result,
    toggle: select,
    ACTION_LABEL,
  };
}
