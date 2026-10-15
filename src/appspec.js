// The application specification: what an application is and must provide, for NEW and EXISTING applications alike.
//
// One versioned shape, validated deterministically against the technology catalog (templates/catalog.json; package pins stay
// in templates/stack.json). A run keeps four things apart, in run.spec:
//   desired  - what the user asked for (never evidence of anything)
//   observed - what the factory established from the repository's files (detected, with the file or manifest entry as basis)
//   plan     - what must change to reconcile the two (computed before any task modifies the repository)
//   evidence - what verification actually established (commands, checklist gates); a selection or a dependency is not proof
// The same validator, capability contract (AppPort, src/appport.js) and conformance gate apply to both workflows. Nothing here
// generates code or runs anything; the factory does, guided by this.

import fs from 'node:fs';
import { STACK_COMPONENTS } from './stack.js';

export const SPEC_VERSION = 1;
const CATALOG = JSON.parse(fs.readFileSync(new URL('../templates/catalog.json', import.meta.url), 'utf8'));
const BY_ID = new Map(CATALOG.entries.map((e) => [e.id, e]));
const CATEGORY = new Map(CATALOG.categories.map((c) => [c.id, c]));
/** Spec field per catalog category, and whether it holds one id or a list. */
export const FIELDS = { architecture: 'architecture', frontend: 'frontend', tooling: 'tooling', language: 'languages', runtime: 'runtimes', backend: 'backend', data: 'data', capability: 'capabilities', production: 'production' };
const LIFECYCLES = ['new', 'existing'];
const APPPORT_MODES = ['require', 'observe', 'exempt'];

export class SpecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpecError';
  }
}

const isMany = (category) => CATEGORY.get(category).select === 'many';
const label = (id) => BY_ID.get(id)?.name || id;

/**
 * A catalog entry with its effective status. An entry backed by a stack.json component can never claim more than that
 * component's status, and inherits its blocker and next step.
 */
export function catalogEntry(id) {
  const e = BY_ID.get(id);
  if (!e) return null;
  const c = e.stack ? STACK_COMPONENTS[e.stack] : null;
  if (c && c.status !== 'supported') return { ...e, status: 'planned', blocker: e.blocker || c.blocker, next: e.next || c.next };
  return e;
}

/** For GET /api/catalog, the UI and the CLI: categories, entries (effective status) and profiles. */
export function describeCatalog() {
  return {
    version: CATALOG.version,
    specVersion: SPEC_VERSION,
    categories: CATALOG.categories.map((c) => ({ ...c, field: FIELDS[c.id] })),
    entries: CATALOG.entries.map((e) => {
      const x = catalogEntry(e.id);
      return { id: x.id, name: x.name, category: x.category, description: x.description, status: x.status, constraint: x.constraint || null, blocker: x.blocker || null, next: x.next || null, requires: requiresOf(x), conflicts: x.conflicts || [], generation: x.generation || 'none', integration: x.integration || 'none', verification: (x.verify || []).map(verifyLabel), detectable: Boolean(x.detect) };
    }),
    profiles: CATALOG.profiles.map((p) => ({ id: p.id, name: p.name, description: p.description, lifecycle: p.lifecycle })),
  };
}

const verifyLabel = (v) => (v.kind === 'checklist' ? `checklist: ${v.item}` : v.kind === 'command' ? `$ ${v.command}` : `file: ${v.path}`);

/** Every prerequisite of an entry: its own, plus its stack component's (mapped to the catalog ids that carry them). */
function requiresOf(e) {
  const fromStack = e.stack ? (STACK_COMPONENTS[e.stack]?.requires || []).map((s) => CATALOG.entries.find((x) => x.stack === s)?.id || s) : [];
  return [...new Set([...(e.requires || []), ...fromStack])];
}

// ── shape ──────────────────────────────────────────────────────────────────────────────────────

const str = (v, max = 4000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');
const ids = (v, where) => {
  if (v == null) return null;
  const list = typeof v === 'string' ? v.split(',') : v;
  if (!Array.isArray(list)) throw new SpecError(`${where} must be a list of catalog ids`);
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
};
const one = (v, where) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new SpecError(`${where} must be one catalog id`);
  return v.trim();
};

/** The profile preset's selections (a copy), or null for an unknown id. */
export function profileSpec(id) {
  const p = CATALOG.profiles.find((x) => x.id === id);
  return p ? { profile: p.id, lifecycle: p.lifecycle, ...structuredClone(p.spec) } : null;
}

/**
 * Normalize a requested specification. Structure errors (wrong types, an unknown version or profile) throw SpecError; whether
 * the selections make sense is validateSpec's job. A profile fills in only the fields the request leaves out, so a profile
 * plus edits is just a spec. For an existing application, technology fields left empty mean "keep what the repository has".
 */
export function normalizeSpec(input = {}, { lifecycle, idea = '', name = '' } = {}) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) throw new SpecError('spec must be an object');
  if (input.version != null && input.version !== SPEC_VERSION) throw new SpecError(`spec version ${JSON.stringify(input.version)} is not supported (this factory reads version ${SPEC_VERSION})`);
  const life = input.lifecycle || lifecycle || 'new';
  if (!LIFECYCLES.includes(life)) throw new SpecError(`lifecycle must be "new" or "existing"`);
  if (lifecycle && input.lifecycle && input.lifecycle !== lifecycle) throw new SpecError(`the spec says lifecycle "${input.lifecycle}" but this run is for ${lifecycle === 'new' ? 'a new application' : 'an existing project'}`);
  let base = {};
  if (input.profile) {
    base = profileSpec(input.profile);
    if (!base) throw new SpecError(`unknown profile "${input.profile}" (known: ${CATALOG.profiles.map((p) => p.id).join(', ')})`);
    if (base.lifecycle !== life) throw new SpecError(`profile "${input.profile}" is for ${base.lifecycle === 'new' ? 'new applications' : 'existing projects'}`);
  } else if (life === 'new' && !Object.values(FIELDS).some((f) => input[f] != null)) {
    base = profileSpec('quick-prototype'); // nothing chosen: the factory's default application
  } else if (life === 'existing' && !input.profile) {
    base = profileSpec('existing-enhancement');
  }
  const pick = (f) => (input[f] !== undefined ? input[f] : base[f]);
  const ap = input.appport && typeof input.appport === 'object' ? input.appport : {};
  const capabilities = ids(pick('capabilities'), 'capabilities') || [];
  const mode = ap.mode || (capabilities.includes('appport') ? 'require' : life === 'existing' ? 'observe' : 'require');
  if (!APPPORT_MODES.includes(mode)) throw new SpecError(`appport.mode must be one of ${APPPORT_MODES.join(', ')}`);
  const model = Array.isArray(input.capabilityModel) ? input.capabilityModel : [];
  return {
    version: SPEC_VERSION,
    lifecycle: life,
    profile: input.profile || base.profile || null,
    identity: { name: str(input.identity?.name || name, 120), intent: str(input.identity?.intent || idea) },
    architecture: one(pick('architecture'), 'architecture'),
    frontend: one(pick('frontend'), 'frontend'),
    tooling: one(pick('tooling'), 'tooling'),
    languages: ids(pick('languages'), 'languages') || [],
    runtimes: ids(pick('runtimes'), 'runtimes') || [],
    backend: one(pick('backend'), 'backend'),
    data: ids(pick('data'), 'data') || [],
    capabilities,
    appport: { mode, ...(mode === 'exempt' ? { reason: str(ap.reason, 300) } : {}) },
    production: ids(pick('production'), 'production') || [],
    constraints: (ids(input.constraints, 'constraints') || []).map((c) => c.slice(0, 500)).slice(0, 20),
    changes: (ids(input.changes, 'changes') || []).map((c) => c.slice(0, 500)).slice(0, 20),
    capabilityModel: model.slice(0, 200).map(normalizeCapability),
  };
}

function normalizeCapability(c, i) {
  if (!c || typeof c !== 'object' || !str(c.name, 120)) throw new SpecError(`capabilityModel[${i}] needs a name`);
  return {
    name: str(c.name, 120),
    effect: ['observation', 'consequential'].includes(c.effect) ? c.effect : null,
    implementation: { language: str(c.implementation?.language, 40) || null, location: str(c.implementation?.location, 300) || null },
    dependsOn: ids(c.dependsOn, `capabilityModel[${i}].dependsOn`) || [],
    replaces: str(c.replaces, 120) || null,
  };
}

/** Every catalog id a spec selects, with the field it came from. */
export function selections(spec) {
  const out = [];
  for (const [category, field] of Object.entries(FIELDS)) {
    const v = spec[field];
    for (const id of Array.isArray(v) ? v : v ? [v] : []) out.push({ id, field, category });
  }
  return out;
}

// ── validation ─────────────────────────────────────────────────────────────────────────────────

// Languages that run on the same toolchain can share one application; more than one family needs a multi-service architecture.
const FAMILY = { javascript: 'node', typescript: 'node', python: 'python', rust: 'rust', go: 'go', java: 'jvm', csharp: 'dotnet' };

/**
 * Deterministic checks of a normalized spec. `observed` (existing applications) is the observation from observeApplication;
 * `provider` is the run's agent provider type, so the offline template agents are refused what only model agents can build.
 * Returns { ok, diagnostics: [{ level, code, selections, message, resolution }] }. Never throws, never changes the spec.
 */
export function validateSpec(spec, { observed = null, offline = false } = {}) {
  const d = [];
  const add = (level, code, sel, message, resolution) => d.push({ level, code, selections: sel, message, resolution });
  const existing = spec.lifecycle === 'existing';
  const detected = new Set((observed?.technologies || []).map((t) => t.id));
  const chosen = selections(spec);
  const have = new Set([...chosen.map((s) => s.id), ...detected]);

  for (const s of chosen) {
    const e = catalogEntry(s.id);
    if (!e) {
      add('error', 'unknown', [s.id], `"${s.id}" is not in the technology catalog (${s.field}).`, `Use one of: ${CATALOG.entries.filter((x) => x.category === s.category).map((x) => x.id).join(', ')}.`);
      continue;
    }
    if (e.category !== s.category) add('error', 'wrong-category', [s.id], `${e.name} is a ${CATEGORY.get(e.category).label.toLowerCase()} option, not ${CATEGORY.get(s.category).label.toLowerCase()}.`, `Move it to "${FIELDS[e.category]}".`);
  }
  // Required single and multi selections (new applications; an existing one keeps what it has where a field is empty).
  if (!existing) {
    for (const c of CATALOG.categories) {
      if (!c.required) continue;
      const v = spec[FIELDS[c.id]];
      if (Array.isArray(v) ? !v.length : !v) add('error', 'missing', [], `${c.label}: nothing selected.`, `Choose ${c.select === 'one' ? 'one option' : 'at least one option'} under ${c.label}.`);
    }
  }
  for (const c of CATALOG.categories) {
    const v = spec[FIELDS[c.id]];
    for (const x of c.exclusive || []) if (Array.isArray(v) && v.includes(x) && v.length > 1) add('error', 'contradictory', v, `${label(x)} cannot be combined with ${v.filter((y) => y !== x).map(label).join(', ')}.`, `Keep either ${label(x)} or the others.`);
  }
  if (d.some((x) => x.code === 'unknown' || x.code === 'wrong-category')) return finish(d);

  for (const s of chosen) {
    const e = catalogEntry(s.id);
    const adding = !existing || !detected.has(s.id);
    // Support: what the factory cannot generate (new) or integrate (existing) is refused with its blocker, never downgraded.
    if (e.status === 'planned' && adding) add('error', 'unsupported', [s.id], `${e.name} is not supported yet${existing ? ' as an addition to an existing application' : ''}. ${e.blocker || ''}`.trim(), e.next ? `Next step: ${e.next} Until then, choose a supported option.` : 'Choose a supported option.');
    if (e.status !== 'planned' && adding && existing && (e.integration || 'none') === 'none') add('error', 'integration-mode', [s.id], `${e.name} cannot be added to an existing application: the factory has no integration for it (only for new applications).`, `Remove ${e.name}, or start a new application.`);
    if (e.status !== 'planned' && adding && existing) {
      const missing = (e.integrationRequires || []).filter((r) => !detected.has(r));
      if (missing.length && observed) add('error', 'integration-gap', [s.id, ...missing], `${e.name} can only be integrated into an application on ${missing.map(label).join(' and ')}; this repository was not detected as one${observed.technologies.length ? ` (detected: ${observed.technologies.map((t) => label(t.id)).join(', ')})` : ''}.`, `Remove ${e.name} for this project; nothing is claimed about it.`);
    }
    if (e.status !== 'planned' && adding && !existing && offline && e.generation === 'agents') add('error', 'no-generator', [s.id], `${e.name} is built by the model agents; the offline demo agents only have templates for the default application.`, 'Pick a real provider and model, or the Quick prototype profile.');
    // Prerequisites and conflicts describe how the factory builds or integrates an option; a technology the existing
    // repository already has is kept as it is, so they are not imposed on it.
    if (!adding) continue;
    const missing = requiresOf(e).filter((r) => !have.has(r));
    if (missing.length) add('error', 'missing-prerequisite', [s.id, ...missing], `${e.name} requires ${missing.map(label).join(' and ')}.`, `Add ${missing.map(label).join(' and ')}, or remove ${e.name}.`);
    for (const group of e.requiresAny || []) if (!group.some((r) => have.has(r))) add('error', 'missing-prerequisite', [s.id, ...group], `${e.name} needs one of: ${group.map(label).join(', ')}.`, `Choose one of ${group.map(label).join(', ')}.`);
    const clash = (e.conflicts || []).filter((r) => have.has(r));
    if (clash.length) add('error', 'incompatible', [s.id, ...clash], `${e.name} does not apply to ${clash.map(label).join(', ')}.`, `Remove one of them.`);
  }
  // Languages: one toolchain per application unless the architecture is multi-service.
  const families = [...new Set(spec.languages.map((l) => FAMILY[l]).filter(Boolean))];
  if (families.length > 1 && spec.architecture !== 'monorepo' && !existing) add('error', 'architecture', spec.languages, `${spec.languages.map(label).join(', ')} need different runtimes, which one ${label(spec.architecture) || 'application'} cannot hold.`, 'Choose one language family, or the Monorepo / multi-service architecture.');
  // Runtimes follow from the other choices; a runtime nothing uses is a contradiction, not a harmless extra.
  if (!existing && spec.runtimes.includes('browser') && spec.frontend === 'frontend-none') add('error', 'runtime-mismatch', ['browser', 'frontend-none'], 'The Browser runtime is selected but there is no frontend.', 'Remove Browser, or choose a frontend.');
  if (!existing && spec.frontend && spec.frontend !== 'frontend-none' && !spec.runtimes.includes('browser')) add('error', 'runtime-mismatch', [spec.frontend, 'browser'], `${label(spec.frontend)} runs in the browser, but the Browser runtime is not selected.`, 'Add the Browser runtime.');
  // AppPort: the default contract. Leaving it out of a new app needs a recorded reason; it is never silently added or dropped.
  const appport = spec.capabilities.includes('appport');
  if (!existing && !appport && spec.appport.mode !== 'exempt') add('error', 'appport-required', ['appport'], 'AppPort is the default capability contract for new applications and is not selected.', 'Select AppPort, or state why this application should not expose an AppPort boundary (appport.mode "exempt" with a reason).');
  if (spec.appport.mode === 'exempt' && !spec.appport.reason) add('error', 'appport-exception', ['appport'], 'An AppPort exception needs a reason.', 'Say why this application should not expose an AppPort boundary.');
  if (spec.appport.mode === 'exempt' && appport) add('error', 'contradictory', ['appport'], 'AppPort is both selected and exempted.', 'Remove one of the two.');
  if (existing && spec.appport.mode === 'exempt') add('error', 'appport-exception', ['appport'], 'Existing applications do not need an AppPort exception: AppPort is observed and reported, and adopted only when you select it.', 'Use mode "observe" (the default) or select AppPort to adopt it.');
  // Capability model: names unique, dependencies and replacements refer to declared capabilities.
  const names = new Set();
  for (const c of spec.capabilityModel) {
    if (names.has(c.name)) add('error', 'capability-model', [c.name], `Capability "${c.name}" is declared twice.`, 'Declare each capability once.');
    names.add(c.name);
  }
  for (const c of spec.capabilityModel) {
    for (const dep of c.dependsOn) if (!names.has(dep)) add('error', 'capability-model', [c.name, dep], `Capability "${c.name}" depends on "${dep}", which is not declared.`, `Declare "${dep}" or remove the dependency.`);
    if (c.replaces && !names.has(c.replaces)) add('error', 'capability-model', [c.name, c.replaces], `Capability "${c.name}" replaces "${c.replaces}", which is not declared.`, `Declare "${c.replaces}" (the implementation being replaced).`);
  }
  return finish(d);
}

function finish(d) {
  const seen = new Set();
  const diagnostics = d.filter((x) => {
    const k = `${x.code}|${x.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { ok: !diagnostics.some((x) => x.level === 'error'), diagnostics };
}

/** Validate or throw a SpecError listing every error with its resolution (for run creation). */
export function assertValid(spec, opts) {
  const v = validateSpec(spec, opts);
  if (!v.ok) throw Object.assign(new SpecError(`The application specification is not valid: ${v.diagnostics.filter((x) => x.level === 'error').map((x) => `${x.message} ${x.resolution}`).join(' ')}`), { diagnostics: v.diagnostics, extra: { diagnostics: v.diagnostics } });
  return v;
}

/**
 * The state of every catalog option for this spec, for the selector: selected, detected (existing repository), available,
 * incompatible (selecting it now would be refused, with the reason) or unavailable (catalog-only, with its blocker).
 */
export function optionStates(spec, opts = {}) {
  const detected = new Set((opts.observed?.technologies || []).map((t) => t.id));
  const chosen = new Set(selections(spec).map((s) => s.id));
  const base = new Set(validateSpec(spec, opts).diagnostics.map((x) => x.message));
  return CATALOG.entries.map((raw) => {
    const e = catalogEntry(raw.id);
    const field = FIELDS[e.category];
    const row = { id: e.id, category: e.category, status: e.status, selected: chosen.has(e.id), detected: detected.has(e.id) };
    if (row.selected) return { ...row, state: 'selected' };
    if (e.status === 'planned' && !row.detected) return { ...row, state: 'unavailable', reason: `${e.blocker || 'Not supported yet.'}${e.next ? ` Next: ${e.next}` : ''}` };
    // Selecting AppPort means requiring it again (the selector does the same), not "selected and exempted".
    const trial = { ...spec, [field]: toggle(spec, e.id), ...(e.id === 'appport' ? { appport: { mode: 'require' } } : {}) };
    const fresh = validateSpec(trial, opts).diagnostics.filter((x) => x.level === 'error' && !base.has(x.message));
    // Incompatible: it clashes with a choice or cannot be built or integrated here. Otherwise it can be selected, and what it
    // still needs (another selection) is shown with it.
    const blocking = fresh.filter((x) => x.selections.includes(e.id) && !RESOLVABLE.has(x.code));
    if (blocking.length) return { ...row, state: 'incompatible', reason: blocking.map((x) => x.message).join(' ') };
    return { ...row, state: row.detected ? 'detected' : 'available', ...(fresh.length ? { needs: fresh.map((x) => x.resolution).join(' ') } : {}) };
  });
}

const RESOLVABLE = new Set(['missing-prerequisite', 'runtime-mismatch']);

/**
 * The value of an entry's field after the user selects it: single-select replaces; multi-select adds, except in a category
 * with exclusive options ("No persistent storage"), where an exclusive option replaces the others and any other option
 * replaces the exclusive one. The selector shows the result; nothing else changes.
 */
export function toggle(spec, id) {
  const e = BY_ID.get(id);
  const field = FIELDS[e.category];
  if (!isMany(e.category)) return id;
  const cur = spec[field] || [];
  if (cur.includes(id)) return cur.filter((x) => x !== id);
  const exclusive = CATEGORY.get(e.category).exclusive || [];
  if (exclusive.includes(id)) return [id];
  return [...cur.filter((x) => !exclusive.includes(x)), id];
}

/** "Full-stack web | React | Vite | TypeScript | Node.js | FeltDB | AppPort" (requested selections; production listed apart). */
export function specSummary(spec) {
  const main = selections(spec).filter((s) => s.category !== 'production' && s.category !== 'runtime' && !['tooling-none', 'data-none', 'frontend-none'].includes(s.id));
  return main.map((s) => label(s.id)).join(' | ') || (spec.lifecycle === 'existing' ? 'Keep the existing application' : '(nothing selected)');
}

/** The stack.json components a spec selects (the input of the existing stack machinery: packages, rules, stack gate). */
export function stackOf(spec) {
  return [...new Set(selections(spec).map((s) => catalogEntry(s.id)?.stack).filter(Boolean))];
}

/** A spec for a run created the earlier way (settings.stack and settings.appportException), so every run has one. */
export function specFromStack(stack = [], { exception = '', lifecycle = 'new', idea = '' } = {}) {
  if (lifecycle === 'existing') return normalizeSpec({}, { lifecycle, idea });
  const base = profileSpec('quick-prototype');
  const byStack = (sid) => CATALOG.entries.find((e) => e.stack === sid)?.id;
  const extra = stack.map(byStack).filter(Boolean);
  const cat = (c) => extra.filter((id) => BY_ID.get(id).category === c);
  return normalizeSpec({
    ...base,
    profile: extra.every((id) => id === 'appport') && !exception ? 'quick-prototype' : undefined,
    data: cat('data').length ? cat('data') : base.data,
    capabilities: exception ? cat('capability').filter((x) => x !== 'appport') : [...new Set(['appport', ...cat('capability')])],
    appport: exception ? { mode: 'exempt', reason: exception } : { mode: 'require' },
    frontend: cat('frontend')[0] || base.frontend,
    tooling: cat('tooling')[0] || base.tooling,
    languages: [...new Set([...base.languages, ...cat('language')])],
  }, { lifecycle, idea });
}

/** Rules agents get for the selected non-package entries (package rules come from stack.json via stackRules). */
export function specRules(spec) {
  const lines = selections(spec).flatMap((s) => (catalogEntry(s.id)?.stack ? [] : catalogEntry(s.id)?.rules || []));
  return lines.length ? `Application specification: ${specSummary(spec)}.\n${lines.map((r) => `- ${r}`).join('\n')}` : `Application specification: ${specSummary(spec)}.`;
}

// ── observation ────────────────────────────────────────────────────────────────────────────────

/**
 * What the repository's files establish (src/project.js inspectProject: files, manifests and dependency names). Each
 * technology carries its basis (the manifest entry or file), so a detection is never confused with a requirement or with
 * verified behaviour. AppPort is reported as "declared" (packages present) only: conformance needs the gate.
 */
export function observeApplication(inspection) {
  const npm = new Set(inspection?.dependencies?.npm || []);
  const py = new Set((inspection?.dependencies?.python || []).map((x) => x.toLowerCase()));
  const files = [...new Set([...(inspection?.markers || []), ...(inspection?.sample || [])])];
  const fileSet = new Set(files);
  const technologies = [];
  for (const e of CATALOG.entries) {
    const r = e.detect;
    if (!r) continue;
    const basis = r.npm?.find((p) => npm.has(p)) ? `package.json dependency ${r.npm.find((p) => npm.has(p))}`
      : r.python?.find((p) => py.has(p)) ? `Python requirement ${r.python.find((p) => py.has(p))}`
      : r.files?.find((f) => (f.startsWith('*') ? files.some((x) => x.endsWith(f.slice(1))) : fileSet.has(f))) ? `file ${r.files.find((f) => (f.startsWith('*') ? files.some((x) => x.endsWith(f.slice(1))) : fileSet.has(f)))}`
      : r.globs?.find((g) => files.some((x) => new RegExp(g).test(x))) ? `file ${files.find((x) => r.globs.some((g) => new RegExp(g).test(x)))}`
      : null;
    if (basis) technologies.push({ id: e.id, category: e.category, basis });
  }
  // Runtimes that follow from detected languages (a Node project runs on Node.js), with the same basis.
  const add = (id, from) => !technologies.some((t) => t.id === id) && technologies.push({ id, category: BY_ID.get(id).category, basis: `follows from ${label(from)}` });
  if (technologies.some((t) => t.id === 'javascript')) add('node', 'javascript');
  if (technologies.some((t) => t.id === 'python')) add('python-runtime', 'python');
  const appport = technologies.some((t) => t.id === 'appport');
  return {
    at: new Date().toISOString(),
    technologies,
    appport: { declared: appport, conformance: 'not-verified', basis: appport ? technologies.find((t) => t.id === 'appport').basis : 'no @appport package in package.json' },
  };
}

/** The paths among `paths` that some catalog detection rule looks at (bounded): what inspection keeps for observation. */
export function detectionMarkers(paths, limit = 200) {
  const exact = new Set(CATALOG.entries.flatMap((e) => (e.detect?.files || []).filter((f) => !f.startsWith('*'))));
  const suffixes = CATALOG.entries.flatMap((e) => (e.detect?.files || []).filter((f) => f.startsWith('*')).map((f) => f.slice(1)));
  const globs = CATALOG.entries.flatMap((e) => (e.detect?.globs || []).map((g) => new RegExp(g)));
  return paths.filter((p) => exact.has(p) || suffixes.some((x) => p.endsWith(x) && !p.includes('node_modules/')) || globs.some((g) => g.test(p))).slice(0, limit);
}

// ── reconciliation plan ────────────────────────────────────────────────────────────────────────

/**
 * What must change to make the observed application match the desired one, before anything is modified. Items:
 * preserve (detected, kept), satisfied (requested and already present; still verified at the end), add (requested, missing,
 * integrable), observe (AppPort is recorded, not adopted). Validation has already refused gaps; none are hidden here.
 */
export function planReconciliation(spec, observed) {
  const detected = new Map((observed?.technologies || []).map((t) => [t.id, t]));
  const requested = new Set(selections(spec).map((s) => s.id));
  const items = [];
  for (const [id, t] of detected) if (!requested.has(id)) items.push({ id, action: 'preserve', detail: `${label(id)} (${t.basis}): keep as is` });
  for (const s of selections(spec)) {
    if (['tooling-none', 'data-none', 'frontend-none'].includes(s.id) && spec.lifecycle === 'existing') continue;
    const t = detected.get(s.id);
    if (t) items.push({ id: s.id, action: 'satisfied', detail: `${label(s.id)} is already present (${t.basis}); keep the existing implementation and verify it` });
    else items.push({ id: s.id, action: 'add', detail: spec.lifecycle === 'new' ? `${label(s.id)}: generate` : `${label(s.id)}: add with the smallest change that fits the existing code` });
  }
  if (spec.appport.mode === 'observe') items.push({ id: 'appport', action: 'observe', detail: observed?.appport?.declared ? `AppPort packages are declared (${observed.appport.basis}); conformance is reported only if the factory can start the app and run the AppPort gate` : 'No AppPort boundary detected; nothing is added unless you select AppPort' });
  return { at: new Date().toISOString(), items };
}

/** The plan as context for the planner of an existing-project run. */
export function planContext(spec, plan) {
  if (!plan?.items?.length) return '';
  const by = (a) => plan.items.filter((i) => i.action === a);
  const L = [`Application specification: ${specSummary(spec)}.`];
  if (by('add').length) L.push(`Add (smallest change, in the project's own style): ${by('add').map((i) => i.detail).join('; ')}.`);
  if (by('satisfied').length) L.push(`Already present, do NOT replace: ${by('satisfied').map((i) => label(i.id)).join(', ')}.`);
  if (by('preserve').length) L.push(`Existing technologies to preserve: ${by('preserve').map((i) => label(i.id)).join(', ')}.`);
  return L.join('\n');
}

// ── evidence ───────────────────────────────────────────────────────────────────────────────────

/** Commands the spec's selections need run at completion (build, typecheck), deduplicated, in catalog order. */
export function verifyCommands(spec) {
  return [...new Set(selections(spec).flatMap((s) => (catalogEntry(s.id)?.verify || []).filter((v) => v.kind === 'command').map((v) => v.command)))];
}

/**
 * What verification established for each requested entry: verified (every check passed, at least one behavioural), present
 * (only presence could be checked, and the entry declares nothing more), failed, or not-verified (not run, or not applicable
 * here). `checklist` is the run's completion checklist, `commands` the results of verifyCommands, `exists(path)` checks a file,
 * `observedAfter` the observation of the finished workspace (a requested technology must actually be in the result).
 */
export function specEvidence(spec, { checklist = [], commands = [], exists = () => false, observedAfter = null, scope = null } = {}) {
  const after = new Set((observedAfter?.technologies || []).map((t) => t.id));
  // An existing application keeps its own layout: the generated-app commands and files do not apply to it; its own checks
  // (the checklist), the shared gates and detection in the result do.
  const generated = spec.lifecycle === 'new';
  const items = [];
  for (const s of selections(spec)) {
    if (scope && !scope.has(s.id)) continue;
    const e = catalogEntry(s.id);
    if (!e) continue;
    const checks = [];
    for (const v of e.verify || []) {
      if (v.kind === 'checklist') {
        const c = checklist.find((x) => x.id === v.item);
        checks.push({ check: `checklist: ${v.item}`, state: !c ? 'not-run' : c.state === 'na' ? 'not-applicable' : c.ok ? 'passed' : 'failed', detail: c?.detail || 'not part of this run\'s checklist' });
      } else if (!generated) {
        checks.push({ check: verifyLabel(v), state: 'not-applicable', detail: 'checks the generated layout; an existing application is verified by its own checks' });
      } else if (v.kind === 'command') {
        const r = commands.find((x) => x.command === v.command);
        checks.push({ check: `$ ${v.command}`, state: !r ? 'not-run' : r.ok ? 'passed' : 'failed', detail: r ? `exit ${r.exitCode}` : 'not run' });
      } else if (v.kind === 'file') {
        checks.push({ check: `file: ${v.path}`, state: exists(v.path) ? 'present' : 'failed', detail: exists(v.path) ? 'exists' : 'missing' });
      }
    }
    if (e.detect && observedAfter) checks.push({ check: 'detected in the result', state: after.has(s.id) ? 'present' : 'failed', detail: after.has(s.id) ? observedAfter.technologies.find((t) => t.id === s.id).basis : `${e.name} was requested but is not in the resulting application` });
    const counted = checks.filter((c) => c.state !== 'not-applicable');
    const declaredPresenceOnly = (e.verify || []).filter((v) => generated || v.kind === 'checklist').every((v) => v.kind === 'file');
    let state;
    if (counted.some((c) => c.state === 'failed')) state = 'failed';
    else if (counted.some((c) => c.state === 'not-run')) state = 'not-verified';
    else if (!counted.length) state = 'nothing-to-verify';
    else if (counted.some((c) => c.state === 'passed')) state = 'verified';
    else state = declaredPresenceOnly ? 'present' : 'not-verified';
    items.push({ id: s.id, name: e.name, state, checks });
  }
  return { at: new Date().toISOString(), items };
}

/** A requirement counts as met when it was verified, is presence-only by declaration and present, or declares nothing to verify. */
export const MET = new Set(['verified', 'present', 'nothing-to-verify']);

// ── capability model (modernization) ───────────────────────────────────────────────────────────

/**
 * The capability graph of a spec's capabilityModel: edges from each capability to what it depends on, and for a capability
 * name, everything affected by changing it (its dependents, transitively). A replacement boundary is a capability whose
 * replacement (another capability with `replaces`) is declared: the boundary at which old and new implementations meet.
 */
export function capabilityGraph(model = []) {
  const dependents = new Map(model.map((c) => [c.name, []]));
  for (const c of model) for (const d of c.dependsOn) dependents.get(d)?.push(c.name);
  const affected = (name) => {
    const out = new Set();
    const walk = (n) => (dependents.get(n) || []).forEach((m) => !out.has(m) && (out.add(m), walk(m)));
    walk(name);
    return [...out];
  };
  return {
    nodes: model.map((c) => ({ name: c.name, language: c.implementation.language, location: c.implementation.location })),
    edges: model.flatMap((c) => c.dependsOn.map((d) => ({ from: c.name, to: d }))),
    affected,
    replacements: model.filter((c) => c.replaces).map((c) => ({ replacement: c.name, replaces: c.replaces, from: model.find((x) => x.name === c.replaces)?.implementation.language || null, to: c.implementation.language, affected: affected(c.replaces) })),
  };
}

/**
 * Contract comparison of two capability sets (for example the AppPort gate's capabilities of an old and a new implementation):
 * which capabilities are missing, added, or changed in effect or authorization. This compares declared contracts, not
 * behaviour; behavioural equivalence needs recorded invocations replayed against both (not implemented; see docs).
 */
export function compareCapabilities(before = [], after = []) {
  const a = new Map(before.map((c) => [c.name, c]));
  const b = new Map(after.map((c) => [c.name, c]));
  const key = (c) => JSON.stringify([c.effect || null, [...(Array.isArray(c.authorization) ? c.authorization : [c.authorization])].sort()]);
  return {
    missing: [...a.keys()].filter((n) => !b.has(n)),
    added: [...b.keys()].filter((n) => !a.has(n)),
    changed: [...a.keys()].filter((n) => b.has(n) && key(a.get(n)) !== key(b.get(n))).map((n) => ({ name: n, before: a.get(n), after: b.get(n) })),
    basis: 'declared contract (effect and authorization), not behaviour',
  };
}
