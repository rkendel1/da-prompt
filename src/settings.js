// Backend-owned, persistent settings for the configuration surface that already exists in config.js.
//
// Precedence for every setting (documented in the README, shown per value in the UI):
//   1. run-specific option      (the New Run form / API body; handled by Factory.createRun, not here)
//   2. startup option           (programmatic overrides passed to loadConfig; used by tests and embedders)
//   3. saved in the UI          (<data dir>/settings.json, mode 0600)
//   4. environment variable     (the deployment baseline)
//   5. built-in default
// "Saved" deliberately beats "environment": the UI is the product, and an environment variable can't
// be changed from a browser. Removing a saved value (Reset) falls back to the environment/default.
// This matches how provider keys/URLs already behave (providers.json beats env).
//
// Secrets (GitHub token, password) are write-only: the view reports whether one is configured and where
// it came from, never the value. Settings that grant host authority (project roots, output root, the PAX
// executable, the GitHub token/API URL, the password) are "privileged": only an authenticated server
// (FACTORY_PASSWORD set) or a request from the host itself (loopback) may change or read them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class SettingsError extends Error {
  constructor(status, message, errors = {}) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}
class Invalid extends Error {}

const FORBIDDEN_ROOTS = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys', '/var', '/run', '/root', '/System', '/Library', '/private', '/opt'];
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

const asInt = (min, max) => (v) => {
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < min || n > max) throw new Invalid(`must be a whole number from ${min} to ${max}`);
  return n;
};
const asText = ({ max = 200, pattern, patternHint, empty = true } = {}) => (v) => {
  const s = String(v ?? '').trim();
  if (!s) {
    if (empty) return '';
    throw new Invalid('is required');
  }
  if (s.length > max) throw new Invalid(`must be at most ${max} characters`);
  if (/[\0\r\n]/.test(s)) throw new Invalid('must be a single line');
  if (pattern && !pattern.test(s)) throw new Invalid(patternHint || 'has an invalid format');
  return s;
};
const asBool = (v) => {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'off') return false;
  throw new Invalid('must be on or off');
};
const asEnum = (options) => (v) => {
  if (!options.includes(v)) throw new Invalid(`must be one of: ${options.join(', ')}`);
  return v;
};
const asList = (item, { max = 20 } = {}) => (v) => {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/);
  const out = [];
  for (const x of raw.map((s) => String(s).trim()).filter(Boolean)) {
    const n = item(x);
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > max) throw new Invalid(`at most ${max} entries`);
  return out;
};
const asHost = (x) => {
  const h = x.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(h) || h.includes('..')) throw new Invalid(`"${x}" is not a valid host name`);
  return h;
};
/** An absolute directory that exists; roots that would hand the browser the whole machine are refused. */
const asRoot = (x, ctx) => {
  if (!path.isAbsolute(x)) throw new Invalid(`"${x}" must be an absolute path`);
  let real;
  try {
    real = fs.realpathSync(x);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Invalid(`"${x}" does not exist or is not a directory on the server`);
  }
  const home = fs.realpathSync(os.homedir());
  if (real === path.parse(real).root || real === home || home.startsWith(real + path.sep) || FORBIDDEN_ROOTS.some((f) => real === f || (f !== '/opt' && f !== '/var' && within(real, f)))) {
    throw new Invalid(`"${x}" is too broad or a system location; choose the folder that contains your projects`);
  }
  const data = ctx.cfg.dataDir && path.resolve(ctx.cfg.dataDir);
  // A folder that merely contains the data directory (e.g. ~/Developer holding da-prompt) is fine: every project
  // folder is checked against the data directory when it is used, so da-prompt itself is never offered as a project.
  if (data && within(real, data)) throw new Invalid(`"${x}" is inside the factory data directory`);
  return real;
};
const asUrl = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Invalid('must be a URL such as https://github.example.com/api/v3');
  }
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Invalid('must be https:// (http:// only for localhost)');
  if (u.username || u.password) throw new Invalid('must not contain credentials');
  return s.replace(/\/+$/, '');
};
const asSecret = ({ min = 8, max = 500, spaces = false } = {}) => (v) => {
  const s = String(v ?? '');
  if (s.length < min || s.length > max || (spaces ? /[\0\r\n]/ : /[\s\0]/).test(s)) throw new Invalid(`must be ${min}–${max} characters${spaces ? '' : ' with no spaces'}`);
  return s;
};
const asExecutable = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/[\0\r\n;&|<>$`"'\\*?]/.test(s) || s.length > 400) throw new Invalid('must be a plain executable name or absolute path');
  if (s.includes('/')) {
    if (!path.isAbsolute(s)) throw new Invalid('a path must be absolute (or use just the command name to look it up on the PATH)');
    let st;
    try {
      st = fs.statSync(s);
      if (!st.isFile()) throw new Error('not a file');
      fs.accessSync(s, fs.constants.X_OK);
    } catch {
      throw new Invalid(`${s} is not an executable file on the server`);
    }
  }
  return s;
};
export const PAX_STEP_IDS = ['info', 'doctor', 'reality', 'drift', 'graph', 'test-plan', 'test'];

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const GROUPS = [
  { id: 'models', label: 'Models', help: 'Which provider and model the factory uses by default. Providers, keys and URLs are managed on the Providers page.' },
  { id: 'execution', label: 'Execution', help: 'How hard and how long a run may work. Each run can override these in the New Run form.' },
  { id: 'folders', label: 'Folders and projects', help: 'Where results may be delivered and which folders can be used as existing projects.' },
  { id: 'github', label: 'GitHub', help: 'Needed to clone private repositories, push run branches and open pull requests.' },
  { id: 'pax', label: 'PAX', help: 'PAX observes project artifacts and reports structured evidence. It never decides whether a run succeeded.' },
  { id: 'server', label: 'Server and security', help: 'How this server is reached and protected.' },
];

// Each entry maps onto a field that config.js / the runtime genuinely reads. `apply: 'live'` takes effect on
// the next request; `apply: 'restart'` is saved now and used the next time the server process starts.
export const SCHEMA = [
  { key: 'defaultProvider', group: 'models', label: 'Default provider', help: 'Used when a run does not choose one.', kind: 'provider', env: ['FACTORY_PROVIDER'], apply: 'live', normalize: (v) => asText({ max: 40, pattern: PROVIDER_ID, patternHint: 'is not a provider id' })(v), read: (c) => c.defaultProvider, write: (c, v) => (c.defaultProvider = v), ovr: (o) => 'defaultProvider' in o },
  { key: 'defaultModel', group: 'models', label: 'Default model', help: 'The model the default provider should use.', kind: 'model', env: ['FACTORY_MODEL'], apply: 'live', normalize: asText({ max: 200 }), read: (c) => c.defaultModel, write: (c, v) => (c.defaultModel = v), ovr: (o) => 'defaultModel' in o },
  { key: 'defaultEngine', group: 'models', label: 'Agent engine', help: 'Who runs each task. "builtin" is da-prompt\'s own agent loop (works with every provider). "fx" is the experimental @appport/fx engine (OpenAI-compatible endpoints and Ollama; needs `npm run engine:install -- fx`). Each run can override this, and switching back is just choosing builtin.', kind: 'enum', options: ['builtin', 'fx'], env: ['FACTORY_AGENT_ENGINE'], apply: 'live', normalize: asEnum(['builtin', 'fx']), read: (c) => c.defaultEngine, write: (c, v) => (c.defaultEngine = v), ovr: (o) => 'defaultEngine' in o },
  { key: 'defaultPlannerProvider', group: 'models', label: 'Planner provider', help: 'Plan with a different provider than the one that executes (for example a frontier model plans, a local model builds). Empty = same as the default provider.', kind: 'provider', env: ['FACTORY_PLANNER_PROVIDER'], apply: 'live', normalize: (v) => asText({ max: 40, pattern: PROVIDER_ID, patternHint: 'is not a provider id' })(v), read: (c) => c.defaultPlannerProvider, write: (c, v) => (c.defaultPlannerProvider = v), ovr: (o) => 'defaultPlannerProvider' in o },
  { key: 'defaultPlannerModel', group: 'models', label: 'Planner model', help: 'Model for planning.', kind: 'model', env: ['FACTORY_PLANNER_MODEL'], apply: 'live', normalize: asText({ max: 200 }), read: (c) => c.defaultPlannerModel, write: (c, v) => (c.defaultPlannerModel = v), ovr: (o) => 'defaultPlannerModel' in o },
  { key: 'maxOutputTokens', group: 'models', label: 'Max tokens per reply', help: 'Upper bound on one model reply.', kind: 'int', unit: 'tokens', min: 256, max: 200000, env: ['FACTORY_MAX_OUTPUT_TOKENS'], apply: 'live', normalize: asInt(256, 200000), read: (c) => c.maxOutputTokens, write: (c, v) => (c.maxOutputTokens = v), ovr: (o) => 'maxOutputTokens' in o },

  { key: 'maxParallel', group: 'execution', label: 'Parallel agents', help: 'How many tasks run at the same time.', kind: 'int', min: 1, max: 8, env: ['FACTORY_MAX_PARALLEL'], apply: 'live', normalize: asInt(1, 8), read: (c) => c.defaults.maxParallel, write: (c, v) => (c.defaults.maxParallel = v), ovr: (o) => 'maxParallel' in (o.defaults || {}) },
  { key: 'maxAttempts', group: 'execution', label: 'Attempts per task', help: 'Retries before a task is escalated to you.', kind: 'int', min: 1, max: 5, env: ['FACTORY_MAX_ATTEMPTS'], apply: 'live', normalize: asInt(1, 5), read: (c) => c.defaults.maxAttempts, write: (c, v) => (c.defaults.maxAttempts = v), ovr: (o) => 'maxAttempts' in (o.defaults || {}) },
  { key: 'maxAgentTurns', group: 'execution', label: 'Tool turns per attempt', help: 'How many tool calls an agent may make in one attempt.', kind: 'int', min: 2, max: 200, env: ['FACTORY_MAX_AGENT_TURNS'], apply: 'live', normalize: asInt(2, 200), read: (c) => c.defaults.maxAgentTurns, write: (c, v) => (c.defaults.maxAgentTurns = v), ovr: (o) => 'maxAgentTurns' in (o.defaults || {}) },
  { key: 'tokenBudget', group: 'execution', label: 'Token budget per run', help: 'A run stops cleanly when it has used this many tokens.', kind: 'int', unit: 'tokens', min: 10000, max: 50000000, env: ['FACTORY_TOKEN_BUDGET'], apply: 'live', normalize: asInt(10000, 50000000), read: (c) => c.defaults.tokenBudget, write: (c, v) => (c.defaults.tokenBudget = v), ovr: (o) => 'tokenBudget' in (o.defaults || {}) },
  { key: 'commandTimeoutMs', group: 'execution', label: 'Command timeout', help: 'Longest a single shell command may run.', kind: 'int', unit: 'ms', min: 1000, max: 3600000, env: ['FACTORY_COMMAND_TIMEOUT_MS'], apply: 'live', normalize: asInt(1000, 3600000), read: (c) => c.defaults.commandTimeoutMs, write: (c, v) => (c.defaults.commandTimeoutMs = v), ovr: (o) => 'commandTimeoutMs' in (o.defaults || {}) },
  { key: 'maxPreviews', group: 'execution', label: 'Live previews kept running', help: 'The oldest preview is stopped when this many are running.', kind: 'int', min: 1, max: 20, env: ['FACTORY_MAX_PREVIEWS'], apply: 'live', normalize: asInt(1, 20), read: (c) => c.maxPreviews, write: (c, v) => (c.maxPreviews = v), ovr: (o) => 'maxPreviews' in o },

  { key: 'outputRoot', group: 'folders', label: 'Delivery folder', help: 'When set, finished projects can only be exported to folders inside it.', kind: 'path', privileged: true, env: ['FACTORY_OUTPUT_ROOT'], apply: 'live', placeholder: '/home/me/factory-output', normalize: (v) => {
    const s = asText({ max: 400 })(v);
    if (s && !path.isAbsolute(s)) throw new Invalid('must be an absolute path');
    return s ? path.resolve(s) : '';
  }, read: (c) => c.outputRoot, write: (c, v) => (c.outputRoot = v), ovr: (o) => 'outputRoot' in o },
  { key: 'projectRoots', group: 'folders', label: 'Project folders (read/write)', help: 'Subfolders of these folders can be used as existing projects. Results are only written back when you apply them.', kind: 'paths', privileged: true, env: ['FACTORY_PROJECT_ROOTS'], apply: 'live', placeholder: '/home/me/projects', normalize: (v, ctx) => asList((x) => asRoot(x, ctx))(v), read: (c) => c.projectRoots, write: (c, v) => (c.projectRoots = v), ovr: (o) => 'projectRoots' in o },
  { key: 'projectRootsReadOnly', group: 'folders', label: 'Project folders (read-only)', help: 'Can be read and used as a source, but results can only be downloaded, never applied.', kind: 'paths', privileged: true, env: ['FACTORY_PROJECT_ROOTS_READONLY'], apply: 'live', placeholder: '/srv/reference', normalize: (v, ctx) => asList((x) => asRoot(x, ctx))(v), read: (c) => c.projectRootsReadOnly, write: (c, v) => (c.projectRootsReadOnly = v), ovr: (o) => 'projectRootsReadOnly' in o },
  { key: 'dataDir', group: 'folders', label: 'Data folder', help: 'Where runs, workspaces, deliveries and these settings are stored. It is chosen when the server starts and cannot be moved from the browser.', kind: 'path', readOnly: true, privileged: true, env: ['FACTORY_DATA_DIR'], apply: 'restart', read: (c) => c.dataDir, write: () => {}, ovr: () => false },

  { key: 'githubToken', group: 'github', label: 'GitHub access token', help: 'Used for cloning private repositories, pushing run branches and opening pull requests. Write-only: it is never shown again.', kind: 'secret', privileged: true, env: ['GITHUB_TOKEN'], apply: 'live', normalize: asSecret({ min: 10 }), read: (c) => c.githubToken, write: (c, v) => (c.githubToken = v), ovr: (o) => 'githubToken' in o },
  { key: 'gitHosts', group: 'github', label: 'Allowed git hosts', help: 'Hosts runs may clone from. Add your GitHub Enterprise host here. The token is only ever sent to these hosts.', kind: 'hosts', privileged: true, env: ['FACTORY_GIT_HOSTS'], apply: 'live', placeholder: 'github.com', normalize: (v) => {
    const l = asList(asHost)(v);
    if (!l.length) throw new Invalid('needs at least one host');
    return l;
  }, read: (c) => c.gitHosts, write: (c, v) => (c.gitHosts = v), ovr: (o) => 'gitHosts' in o },
  { key: 'githubApiUrl', group: 'github', label: 'GitHub API URL', help: 'Leave empty for github.com. For GitHub Enterprise use https://<host>/api/v3.', kind: 'url', privileged: true, env: ['FACTORY_GITHUB_API_URL'], apply: 'live', normalize: asUrl, read: (c) => c.githubApiUrl, write: (c, v) => (c.githubApiUrl = v), ovr: (o) => 'githubApiUrl' in o },

  { key: 'paxPath', group: 'pax', label: 'PAX executable', help: 'Empty = look for "pax" on the PATH of the server process. Set a full path to use a specific install.', kind: 'executable', privileged: true, env: ['FACTORY_PAX_PATH'], apply: 'live', placeholder: 'pax', normalize: asExecutable, read: (c) => c.paxPath, write: (c, v) => (c.paxPath = v), ovr: (o) => 'paxPath' in o },
  { key: 'paxAutoRun', group: 'pax', label: 'Collect PAX evidence on every run', help: 'Runs the selected PAX steps after verification and stores the output next to the run. Each run can override this.', kind: 'bool', env: [], apply: 'live', normalize: asBool, read: (c) => c.paxAutoRun, write: (c, v) => (c.paxAutoRun = v), ovr: (o) => 'paxAutoRun' in o },
  { key: 'paxSteps', group: 'pax', label: 'PAX steps to run', help: 'Read-only observations are safe. "test" runs the project\'s native test command through PAX and can change files exactly as that command does.', kind: 'steps', env: [], apply: 'live', normalize: (v) => {
    const l = asList(asEnum(PAX_STEP_IDS), { max: 10 })(v);
    if (!l.length) throw new Invalid('choose at least one step');
    return l;
  }, read: (c) => c.paxSteps, write: (c, v) => (c.paxSteps = v), ovr: (o) => 'paxSteps' in o },
  { key: 'paxTimeoutMs', group: 'pax', label: 'PAX step timeout', help: 'Longest a single PAX step may run.', kind: 'int', unit: 'ms', min: 1000, max: 3600000, env: ['FACTORY_PAX_TIMEOUT_MS'], apply: 'live', normalize: asInt(1000, 3600000), read: (c) => c.paxTimeoutMs, write: (c, v) => (c.paxTimeoutMs = v), ovr: (o) => 'paxTimeoutMs' in o },

  { key: 'host', group: 'server', label: 'Listen address', help: 'The network address the server binds to. 127.0.0.1 = this machine only. Inside Docker keep 0.0.0.0 or the published port stops working.', kind: 'text', privileged: true, env: ['HOST'], apply: 'restart', normalize: asText({ max: 100, pattern: /^[A-Za-z0-9.:_-]+$/, patternHint: 'must be an address or host name', empty: false }), read: (c) => c.host, write: (c, v) => (c.host = v), ovr: (o) => 'host' in o },
  { key: 'port', group: 'server', label: 'Port', help: 'The port the server listens on.', kind: 'int', min: 1, max: 65535, privileged: true, env: ['PORT'], apply: 'restart', normalize: asInt(1, 65535), read: (c) => c.port, write: (c, v) => (c.port = v), ovr: (o) => 'port' in o },
  { key: 'password', group: 'server', label: 'Access password', help: 'HTTP basic auth for the whole server (any user name). Agents run shell commands, so set one before exposing the server. Your browser will ask you to sign in after you save.', kind: 'secret', privileged: true, env: ['FACTORY_PASSWORD'], apply: 'live', normalize: asSecret({ min: 8, max: 200, spaces: true }), read: (c) => c.password, write: (c, v) => (c.password = v), ovr: (o) => 'password' in o },
  { key: 'terminalEnabled', group: 'server', label: 'Embedded terminal', help: 'A host shell in the browser (Terminal page) running as the user who started the server. Only an authenticated session or a browser on the server machine can use it. Turn it off to remove the feature.', kind: 'bool', privileged: true, env: ['FACTORY_TERMINAL'], envTrue: '1', apply: 'live', normalize: asBool, read: (c) => c.terminalEnabled, write: (c, v) => (c.terminalEnabled = v), ovr: (o) => 'terminalEnabled' in o },
  { key: 'hideOffline', group: 'server', label: 'Hide the offline demo agents', help: 'Removes the built-in demo provider from the pickers.', kind: 'bool', env: ['FACTORY_HIDE_OFFLINE'], envTrue: '1', apply: 'live', normalize: asBool, read: (c) => c.hideOffline, write: (c, v) => (c.hideOffline = v), ovr: (o) => 'hideOffline' in o },
  { key: 'offlineFaults', group: 'server', label: 'Offline demo faults', help: '"on" injects one bug the feedback loop fixes, "persistent" fails a full round so escalation can be demonstrated.', kind: 'enum', options: ['on', 'off', 'persistent'], env: ['FACTORY_OFFLINE_FAULTS'], apply: 'live', normalize: asEnum(['on', 'off', 'persistent']), read: (c) => c.offlineFaults, write: (c, v) => (c.offlineFaults = v), ovr: (o) => 'offlineFaults' in o },
];
const BY_KEY = new Map(SCHEMA.map((d) => [d.key, d]));

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export class SettingsStore {
  constructor(cfg, overrides = {}) {
    this.cfg = cfg;
    this.file = path.join(cfg.dataDir, 'settings.json');
    this.listeners = new Map();
    this.overridden = new Set(SCHEMA.filter((d) => d.ovr(overrides)).map((d) => d.key));
    this.envName = {};
    for (const d of SCHEMA) this.envName[d.key] = d.env.find((n) => process.env[n]) || null;
    this.base = {}; // what the environment/default produced, before anything saved was applied
    for (const d of SCHEMA) this.base[d.key] = clone(d.read(cfg));
    this.saved = this.load();
    for (const [k, v] of Object.entries(this.saved)) {
      const d = BY_KEY.get(k);
      if (d && !d.readOnly && !this.overridden.has(k)) d.write(cfg, clone(v));
    }
    this.boot = {}; // effective at process start: restart-type settings compare against this
    for (const d of SCHEMA) this.boot[d.key] = clone(d.read(cfg));
    this.lastSavedAt = null;
    try {
      this.lastSavedAt = fs.statSync(this.file).mtime.toISOString();
    } catch {
      /* never saved */
    }
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return j && typeof j.saved === 'object' && j.saved ? j.saved : {};
    } catch {
      return {};
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, saved: this.saved, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    fs.chmodSync(this.file, 0o600);
    this.lastSavedAt = new Date().toISOString();
  }

  /** Run `fn(value)` whenever a live setting changes (e.g. the preview manager's limit). */
  onChange(key, fn) {
    this.listeners.set(key, [...(this.listeners.get(key) || []), fn]);
  }

  source(key) {
    if (this.overridden.has(key)) return 'startup';
    if (key in this.saved) return 'saved';
    return this.envName[key] ? 'environment' : 'default';
  }

  /** Is this setting's saved value waiting for a restart? */
  pending(def) {
    return def.apply === 'restart' && !def.readOnly && !same(this.boot[def.key], this.effective(def.key));
  }

  effective(key) {
    return key in this.saved && !this.overridden.has(key) ? this.saved[key] : this.base[key];
  }

  /**
   * Validate and save. `patch` maps key → new value, or null to reset to the environment/default.
   * Nothing is written unless every entry is valid. Returns what changed and what needs a restart.
   */
  update(patch, { admin = false } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError(400, 'send an object of settings');
    const errors = {};
    const denied = [];
    const next = { ...this.saved };
    const ctx = { cfg: this.cfg };
    for (const [key, raw] of Object.entries(patch)) {
      const d = BY_KEY.get(key);
      if (!d) {
        errors[key] = 'is not a setting this server supports';
        continue;
      }
      if (d.readOnly) {
        errors[key] = 'cannot be changed from the browser';
        continue;
      }
      if (d.privileged && !admin) {
        denied.push(key);
        continue;
      }
      if (this.overridden.has(key)) {
        errors[key] = 'is fixed by a startup option and cannot be changed while the server runs';
        continue;
      }
      if (raw === null) {
        delete next[key];
        continue;
      }
      try {
        next[key] = d.normalize(raw, ctx);
      } catch (e) {
        if (!(e instanceof Invalid)) throw e;
        errors[key] = e.message;
      }
    }
    if (denied.length) throw new SettingsError(403, `Changing ${denied.map((k) => BY_KEY.get(k).label).join(', ')} needs an authenticated session. Set an access password (FACTORY_PASSWORD) or open the UI from the machine that runs the server.`, Object.fromEntries(denied.map((k) => [k, 'requires an authenticated or local session'])));
    // Cross-field rules.
    const eff = (k) => (k in next && !this.overridden.has(k) ? next[k] : this.base[k]) || [];
    const overlap = eff('projectRoots').filter((p) => eff('projectRootsReadOnly').includes(p));
    if (overlap.length && ('projectRoots' in patch || 'projectRootsReadOnly' in patch)) errors.projectRootsReadOnly = `${overlap[0]} is listed as both read/write and read-only`;
    if (Object.keys(errors).length) throw new SettingsError(400, 'Some values are not valid; nothing was saved.', errors);

    const changed = [];
    const restart = [];
    this.saved = next;
    this.persist();
    for (const k of Object.keys(patch)) {
      const d = BY_KEY.get(k);
      const eff = clone(this.effective(k));
      if (!same(this.boot[k] === undefined || d.apply === 'live' ? d.read(this.cfg) : this.boot[k], eff)) changed.push(k);
      if (d.apply === 'live') {
        d.write(this.cfg, eff);
        for (const fn of this.listeners.get(k) || []) fn(eff);
      }
      if (this.pending(d)) restart.push(k);
    }
    return { saved: true, savedAt: this.lastSavedAt, changed, restartRequired: restart };
  }

  /** Browser-safe description of every setting: effective value, where it came from, and how it applies. */
  view({ admin = false } = {}) {
    const settings = SCHEMA.map((d) => {
      const secret = d.kind === 'secret';
      const value = d.read(this.cfg);
      const hidden = d.privileged && !admin && !secret;
      const entry = {
        key: d.key,
        group: d.group,
        label: d.label,
        help: d.help,
        kind: d.kind,
        unit: d.unit,
        min: d.min,
        max: d.max,
        options: d.options,
        placeholder: d.placeholder,
        apply: d.apply,
        privileged: Boolean(d.privileged),
        readOnly: Boolean(d.readOnly) || this.overridden.has(d.key),
        editable: !d.readOnly && !this.overridden.has(d.key) && (!d.privileged || admin),
        source: this.source(d.key),
        saved: d.key in this.saved && !this.overridden.has(d.key),
        env: d.env[0] || null,
        envAlsoSet: Boolean(this.envName[d.key]) && d.key in this.saved,
        restartPending: this.pending(d),
      };
      if (secret) entry.configured = Boolean(value);
      else if (hidden) entry.hidden = true;
      else entry.value = value ?? '';
      if (!secret && !hidden && d.key in this.saved) entry.defaultValue = this.base[d.key] ?? '';
      return entry;
    });
    return { groups: GROUPS, settings, file: { persisted: fs.existsSync(this.file), savedAt: this.lastSavedAt, mode: '0600' }, admin };
  }
}

export const settingDef = (key) => BY_KEY.get(key);
