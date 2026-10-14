// What the factory can actually do, and what a task may therefore promise.
//
// Principle: model output expresses intent; executed operations and verified artifacts establish what happened.
// This module holds the pieces that make that checkable:
//   - detectCapabilities(): which optional tools exist on this machine (a browser to render, an image provider). Core
//     tools (write_file, run_command, …) always exist because Workspace implements them.
//   - validateArtifact(): is a file really there, non-empty and of the type its name promises (PNG signature, JSON that
//     parses, HTML that has markup). Verification uses this; an agent's description of a file never does.
//   - checkTaskContracts(): plan-time validation that every task has a mechanical definition of done, that the outputs it
//     promises can be produced by available tools, and that the plan does not contradict itself.
//   - validateArgs(): tool arguments must satisfy the tool's own input_schema.
//   - renderScreenshot() / generateImage(): the two optional artifact tools. Both write through Workspace and are validated
//     afterwards; neither is offered to an agent unless its capability is available.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { requestWithRetry, describeError } from './providers/http.js';
import { hideSecretValues } from './security.js';

export const IMAGE_EXT = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.gif': 'gif' };

/** Error a tool (or verification) raises when the capability it needs is not available. The retry policy treats it as final. */
export class CapabilityError extends Error {
  constructor(capability, message) {
    super(message);
    this.capability = capability;
    this.kind = 'capability';
  }
}

export const outputKind = (p) => {
  const ext = path.extname(String(p)).toLowerCase();
  if (IMAGE_EXT[ext]) return 'image';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.json') return 'json';
  return 'file';
};

// ── capability detection ───────────────────────────────────────────────────────────────────────────

const BROWSER_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'microsoft-edge'];
const BROWSER_APPS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

function findOnPath(names, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/**
 * The optional capabilities of this factory, each { available, reason?, … }. Pure inspection: no network, no model call.
 * `cfg.browserPath` / FACTORY_BROWSER_PATH names a Chromium-family binary explicitly; otherwise the usual names and macOS
 * app locations are tried. `cfg.image` (FACTORY_IMAGE_URL, FACTORY_IMAGE_MODEL, FACTORY_IMAGE_API_KEY) names an
 * OpenAI-compatible images endpoint; without it image generation is simply unavailable.
 */
export function detectCapabilities(cfg = {}, { env = process.env, engine = 'builtin' } = {}) {
  const caps = {
    write_file: { available: true },
    run_command: { available: true },
    browser_render: { available: false, reason: 'no Chromium-family browser found (set FACTORY_BROWSER_PATH)' },
    image_generation: { available: false, reason: 'no image provider configured (set FACTORY_IMAGE_URL and FACTORY_IMAGE_MODEL)' },
  };
  const explicit = cfg.browserPath || env.FACTORY_BROWSER_PATH || '';
  const browser = explicit || findOnPath(BROWSER_NAMES, env) || BROWSER_APPS.find((p) => fs.existsSync(p)) || '';
  if (explicit && !fs.existsSync(explicit)) caps.browser_render = { available: false, reason: `FACTORY_BROWSER_PATH does not exist: ${explicit}` };
  else if (browser && cfg.compute?.enabled && !explicit) caps.browser_render = { available: false, reason: 'commands run in a Compute environment, so a browser on this host would not match it (set FACTORY_BROWSER_PATH to opt in)' };
  else if (browser) caps.browser_render = { available: true, path: browser };
  const img = cfg.image || {};
  if (img.url && img.model) caps.image_generation = { available: true, model: img.model, url: img.url };
  else if (img.url || img.model) caps.image_generation = { available: false, reason: 'image generation needs both FACTORY_IMAGE_URL and FACTORY_IMAGE_MODEL' };
  if (engine === 'fx') {
    // The fx engine runs its own tool set (src/engines/fx.js passes AGENT_TOOLS, which includes only the optional tools given to it).
    for (const k of ['browser_render', 'image_generation']) if (caps[k].available) caps[k] = { available: false, reason: 'the fx engine does not offer this tool; use the built-in engine' };
  }
  return caps;
}

/** The names of the optional tools an agent may be given with these capabilities. */
export const optionalTools = (caps) => [...(caps?.browser_render?.available ? ['render_screenshot'] : []), ...(caps?.image_generation?.available ? ['generate_image'] : [])];

// ── artifacts ──────────────────────────────────────────────────────────────────────────────────────

function pngSize(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/**
 * Check a file against what its name promises. Returns { ok, kind, bytes, reason, detail }. Never throws.
 * "Valid" is deliberately modest: present, non-empty, and structurally the right type. It is not a quality judgement.
 */
export async function validateArtifact(ws, rel) {
  const clean = String(rel).replace(/\/$/, '');
  const st = await ws.stat(clean);
  if (!st) return { ok: false, path: clean, kind: outputKind(clean), bytes: 0, reason: 'missing', detail: `${clean} does not exist` };
  if (!st.isFile) return { ok: false, path: clean, kind: outputKind(clean), bytes: 0, reason: 'not-a-file', detail: `${clean} is a directory, not a file` };
  const kind = outputKind(clean);
  if (st.size === 0) return { ok: false, path: clean, kind, bytes: 0, reason: 'empty', detail: `${clean} exists but is empty` };
  const bad = (reason, detail) => ({ ok: false, path: clean, kind, bytes: st.size, reason, detail });
  let buf;
  try {
    buf = await ws.readBuffer(clean, { maxBytes: kind === 'image' ? (path.extname(clean).toLowerCase() === '.png' ? Math.min(st.size, 20_000_000) : 64) : 2_000_000 });
  } catch (err) {
    return bad('unreadable', `${clean} could not be read: ${err.message}`);
  }
  const ext = path.extname(clean).toLowerCase();
  if (kind === 'image') {
    let ok;
    let dims = null;
    if (ext === '.png') {
      dims = pngSize(buf);
      // A complete PNG ends with an IEND chunk; a download or render cut short does not.
      ok = Boolean(dims && dims.width > 0 && dims.height > 0 && buf.subarray(-12).toString('hex') === '0000000049454e44ae426082');
    } else if (ext === '.jpg' || ext === '.jpeg') ok = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    else if (ext === '.gif') ok = /^GIF8[79]a/.test(buf.toString('latin1', 0, 6));
    else ok = buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
    if (!ok) return bad('invalid-image', `${clean} is not a valid ${IMAGE_EXT[ext]} image (the file's bytes do not have the ${ext} format; prose or HTML saved under this name does not count)`);
    return { ok: true, path: clean, kind, bytes: st.size, ...(dims || {}) };
  }
  const text = buf.toString('utf8');
  if (!text.trim()) return bad('empty', `${clean} contains only whitespace`);
  if (kind === 'json') {
    try {
      JSON.parse(text);
    } catch (err) {
      return bad('invalid-json', `${clean} is not valid JSON: ${err.message}`);
    }
  }
  if (kind === 'html' && !/<\s*(html|body|div|main|section|svg|h1|p|form|table|ul|header)\b/i.test(text)) return bad('invalid-html', `${clean} has no HTML markup`);
  if (kind === 'html' && text.replace(/<[^>]*>/g, '').trim().length < 20 && !/<\s*(svg|img|canvas|form|table|input)\b/i.test(text)) return bad('thin', `${clean} has markup but almost no content`);
  if (buf.includes(0)) return bad('binary', `${clean} is a binary file but its name promises text`);
  return { ok: true, path: clean, kind, bytes: st.size };
}

/** Escape-free glob for outputs like "public/images/*.png": * and ? within one path segment, ** across segments. */
export function globToRegExp(glob) {
  const s = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^${s}$`);
}

/** Verify one declared output: a file, a glob (at least one valid match), or a directory (at least one valid file in it). */
export async function checkOutput(ws, output) {
  const out = String(output);
  const t0 = Date.now();
  const wrap = (r, extra = {}) => ({ command: `artifact ${out}`, criterion: `output ${out}`, check: 'artifact', exitCode: r.ok ? 0 : 1, ok: r.ok, durationMs: Date.now() - t0, output: r.ok ? '' : r.detail, artifact: r.artifacts || undefined, ...extra });
  if (/[*?]/.test(out)) {
    const re = globToRegExp(out);
    const files = (await ws.listFiles('.')).filter((f) => re.test(f.path));
    const checked = [];
    for (const f of files.slice(0, 50)) checked.push(await validateArtifact(ws, f.path));
    const good = checked.filter((c) => c.ok);
    return wrap({ ok: good.length > 0, detail: files.length ? `none of the ${files.length} file(s) matching ${out} is valid: ${checked.map((c) => c.detail).slice(0, 3).join('; ')}` : `no file matches ${out}`, artifacts: good.slice(0, 20) });
  }
  if (out.endsWith('/')) {
    const dir = out.replace(/\/$/, '');
    const files = (await ws.listFiles(dir).catch(() => [])).filter((f) => f.size > 0);
    return wrap({ ok: files.length > 0, detail: `directory ${out} has no non-empty file`, artifacts: files.slice(0, 20).map((f) => ({ path: f.path, bytes: f.size })) });
  }
  const r = await validateArtifact(ws, out);
  return wrap({ ...r, artifacts: r.ok ? [r] : [] });
}

// ── plan-time contract ────────────────────────────────────────────────────────────────────────────

export const AGENT_TOOL_NAMES = new Set(['list_files', 'read_file', 'write_file', 'run_command', 'complete_task', 'render_screenshot', 'generate_image']);
const looksLikePath = (s) => typeof s === 'string' && s.length < 300 && !/\s/.test(s);

function ancestors(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map();
  const of = (id) => {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, new Set()); // cycles are reported by validatePlan; do not loop
    const s = new Set();
    for (const d of byId.get(id)?.dependsOn || []) {
      s.add(d);
      for (const a of of(d)) s.add(a);
    }
    memo.set(id, s);
    return s;
  };
  return of;
}

/**
 * Repair ordering defects that have exactly one safe fix, in place, and say what was done. Two cases:
 *   - a task's verify command reads a file another task produces, but does not depend on it: add the dependency;
 *   - two unordered tasks write the same output: the later one in the plan waits for the earlier one.
 * Both only add edges, so no requirement, output or check is changed or dropped. A fix that would create a cycle is not applied
 * (checkTaskContracts then reports it to the planner). Weak planners get these wrong constantly; sending the plan back three
 * times for a missing edge fails the whole run for nothing.
 */
export function repairOrdering(plan) {
  const tasks = plan?.tasks || [];
  const adjustments = [];
  const reaches = (from, to) => ancestors(tasks)(from).has(to);
  const addEdge = (task, dep, why) => {
    if (task.id === dep.id || reaches(dep.id, task.id) || (task.dependsOn || []).includes(dep.id)) return false;
    task.dependsOn = [...(task.dependsOn || []), dep.id];
    adjustments.push(`task "${task.id}" now depends on "${dep.id}" (${why})`);
    return true;
  };
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    const producers = new Map();
    for (const t of tasks) for (const o of t.outputs || []) if (looksLikePath(o) && !/[*?]/.test(o)) (producers.get(o) || producers.set(o, []).get(o)).push(t);
    for (const t of tasks) {
      for (const [o, ps] of producers) {
        if ((t.outputs || []).includes(o)) continue;
        if (!(t.verify || []).some((v) => v.includes(o))) continue;
        for (const p of ps) if (!ancestors(tasks)(t.id).has(p.id)) changed = addEdge(t, p, `its verify command reads ${o}, which "${p.id}" produces`) || changed;
      }
    }
    for (const [o, ps] of producers) {
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const [a, b] = [ps[i], ps[j]];
          if (ancestors(tasks)(a.id).has(b.id) || ancestors(tasks)(b.id).has(a.id)) continue;
          changed = addEdge(b, a, `both write ${o}; ordered so they never write it at the same time`) || changed;
        }
      }
    }
    if (!changed) break;
  }
  return adjustments;
}

/**
 * Validate that a plan is executable before any agent starts. Returns:
 *   problems — defects the planner can fix (an unsafe or contradictory output, two independent tasks writing the same file,
 *              a check that reads another task's output without depending on it);
 *   warnings — a task with no outputs and no verify command: allowed, but it can only be held to "executed some work";
 *   gaps     — { taskId, capability, output, reason }: the task promises something no available tool can produce. These are
 *              given to the planner first; a plan that still contains them is not weakened, the task is blocked with the reason.
 */
export function checkTaskContracts(plan, caps) {
  const problems = [];
  const gaps = [];
  const warnings = [];
  const tasks = plan?.tasks || [];
  const anc = ancestors(tasks);
  const producers = new Map(); // output path -> task ids
  for (const t of tasks) {
    const outs = t.outputs || [];
    const verify = t.verify || [];
    if (!outs.length && !verify.length) warnings.push(`task "${t.id}" has no outputs and no verify command, so the factory can only check that it executed some work (a file written or a command that succeeded), not that the work is right`);
    for (const v of verify) {
      const first = String(v).trim().split(/\s+/)[0];
      if (AGENT_TOOL_NAMES.has(first)) problems.push(`task "${t.id}" verify command "${v}" starts with the tool name ${first}; verify commands are shell commands the factory runs after the agent finishes. Put files in outputs, or use a shell command (for example test -s <file>)`);
    }
    for (const o of outs) {
      if (!looksLikePath(o) || path.isAbsolute(o) || o.split('/').includes('..')) problems.push(`task "${t.id}" output "${o}" must be a relative path inside the project (no spaces, no "..")`);
      else (producers.get(o) || producers.set(o, []).get(o)).push(t.id);
      if (outputKind(o) === 'image') {
        const canRender = caps?.browser_render?.available;
        const canGenerate = caps?.image_generation?.available;
        if (!canRender && !canGenerate) {
          gaps.push({ taskId: t.id, capability: 'image', output: o, reason: `${o} is an image, but this factory can neither render a screenshot (${caps?.browser_render?.reason || 'no browser'}) nor generate images (${caps?.image_generation?.reason || 'no image provider'}); describing or drawing it in text cannot produce the file` });
        }
      }
    }
    const SAVED = '(saved|written|produced|generated|exists?|created|stored)';
    const acceptsPng = (t.acceptance || []).some((a) => /\.(png|jpe?g|webp|gif)\b/i.test(a) || new RegExp(`\\bscreenshots?\\b.*\\b${SAVED}\\b|\\b${SAVED}\\b.*\\bscreenshots?\\b`, 'i').test(a));
    if (acceptsPng && !outs.some((o) => outputKind(o) === 'image') && !(caps?.browser_render?.available || caps?.image_generation?.available)) {
      gaps.push({ taskId: t.id, capability: 'image', output: null, reason: `acceptance criteria require an image or screenshot, but no renderer or image provider is available` });
    }
    if (acceptsPng && !outs.some((o) => outputKind(o) === 'image')) problems.push(`task "${t.id}" has an image/screenshot acceptance criterion but no image in outputs, so it could never be verified; list the image file in outputs`);
  }
  for (const [o, ids] of producers) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = [ids[i], ids[j]];
        if (!anc(a).has(b) && !anc(b).has(a)) problems.push(`tasks "${a}" and "${b}" both write ${o} and neither depends on the other: give each its own file or make one depend on the other`);
      }
    }
  }
  for (const t of tasks) {
    const own = new Set(t.outputs || []);
    for (const [o, ids] of producers) {
      if (own.has(o) || /[*?]/.test(o)) continue;
      const reads = (t.verify || []).some((v) => v.includes(o));
      if (reads && !ids.some((id) => anc(t.id).has(id))) problems.push(`task "${t.id}" verifies ${o}, which is produced by "${ids[0]}", but does not depend on it`);
    }
  }
  return { problems, gaps, warnings };
}

// ── tool arguments ─────────────────────────────────────────────────────────────────────────────────

/** Check tool input against its input_schema (type, required, enum, min/max, items). Returns a list of problems. */
export function validateArgs(schema, input, where = 'arguments') {
  const out = [];
  const check = (s, v, at) => {
    if (!s) return;
    const t = s.type;
    const actual = Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v;
    const ok = !t || t === actual || (t === 'number' && actual === 'integer') || (t === 'integer' && actual === 'number' && Number.isInteger(v));
    if (!ok) return out.push(`${at} must be ${t}, got ${actual}`);
    if (s.enum && !s.enum.includes(v)) out.push(`${at} must be one of ${s.enum.join(', ')}`);
    if (typeof v === 'number') {
      if (s.minimum != null && v < s.minimum) out.push(`${at} must be >= ${s.minimum}`);
      if (s.maximum != null && v > s.maximum) out.push(`${at} must be <= ${s.maximum}`);
    }
    if (t === 'object') {
      for (const k of s.required || []) if (v[k] === undefined || v[k] === null) out.push(`${at}.${k} is required`);
      for (const [k, sub] of Object.entries(s.properties || {})) if (v[k] !== undefined && v[k] !== null) check(sub, v[k], `${at}.${k}`);
    }
    if (t === 'array' && s.items) v.forEach((x, i) => check(s.items, x, `${at}[${i}]`));
  };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return [`${where} must be a JSON object`];
  check(schema, input, where);
  return out;
}

// ── optional tools ─────────────────────────────────────────────────────────────────────────────────

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Render an HTML file from the workspace to a PNG with the detected browser. The command goes through Workspace.runCommand,
 * so the sandbox policy, timeout, cancellation and (when enabled) the Compute launcher apply exactly as for any command.
 * Success means a valid, non-empty PNG exists afterwards; the browser's exit status alone is not believed.
 */
export async function renderScreenshot(ws, caps, { html_path, output_path, width = 1280, height = 800 }, { signal, timeoutMs = 60_000 } = {}) {
  const cap = caps?.browser_render;
  if (!cap?.available) throw new CapabilityError('browser_render', `render_screenshot is unavailable: ${cap?.reason || 'no browser'}`);
  if (outputKind(output_path) !== 'image' || path.extname(output_path).toLowerCase() !== '.png') throw new Error('output_path must end in .png (the renderer only produces PNG)');
  if (outputKind(html_path) !== 'html') throw new Error('html_path must be an .html file');
  const html = await validateArtifact(ws, html_path);
  if (!html.ok) throw new Error(`cannot render: ${html.detail}. Write the HTML file first with write_file.`);
  const w = Math.max(200, Math.min(3840, Math.round(Number(width) || 1280)));
  const h = Math.max(200, Math.min(4000, Math.round(Number(height) || 800)));
  ws.resolve(output_path); // same escape / .git rules as any write
  const profile = `.home/render-${crypto.randomBytes(4).toString('hex')}`;
  const out = path.posix.normalize(String(output_path).replace(/\\/g, '/'));
  fs.mkdirSync(path.dirname(path.join(ws.root, out)), { recursive: true });
  const command = [
    q(cap.path), '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--disable-extensions', `--user-data-dir=${q(profile)}`,
    `--window-size=${w},${h}`, '--virtual-time-budget=3000', `--screenshot=${q(out)}`, q(`file://${ws.resolve(html_path)}`),
  ].join(' ');
  const r = await ws.runCommand(command, { timeoutMs, signal });
  fs.rmSync(path.join(ws.root, profile), { recursive: true, force: true });
  const v = await validateArtifact(ws, out);
  if (!v.ok) {
    const tail = `${r.stderr || r.stdout || ''}`.trim().split('\n').slice(-4).join(' | ').slice(0, 400);
    throw new Error(`the browser exited ${r.exitCode} and ${v.detail}${tail ? ` (${tail})` : ''}`);
  }
  return { path: v.path, bytes: v.bytes, width: v.width, height: v.height };
}

/**
 * Generate an image with the configured OpenAI-compatible images endpoint and write it into the workspace. The provider's
 * bytes are validated against the file extension, so an unsupported output format is an explicit error, not a wrong file.
 */
export async function generateImage(ws, caps, cfg, { prompt, output_path, size = '1024x1024' }, { signal } = {}) {
  const cap = caps?.image_generation;
  if (!cap?.available) throw new CapabilityError('image_generation', `generate_image is unavailable: ${cap?.reason || 'no image provider'}`);
  const ext = path.extname(String(output_path)).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error(`unsupported output format "${ext || 'none'}": use .png, .jpg or .webp`);
  if (!/^\d{3,4}x\d{3,4}$/.test(String(size))) throw new Error('size must look like 1024x1024');
  ws.resolve(output_path);
  const img = cfg.image || {};
  const secrets = [img.apiKey];
  let res;
  try {
    res = await requestWithRetry(`${String(img.url).replace(/\/+$/, '')}/images/generations`, {
      method: 'POST', signal, timeoutMs: img.timeoutMs || 120_000,
      headers: img.apiKey ? { authorization: `Bearer ${img.apiKey}` } : {},
      body: { model: img.model, prompt: String(prompt).slice(0, 4000), n: 1, size, response_format: 'b64_json' },
    }, { retries: 1 });
  } catch (err) {
    if (signal?.aborted) throw new Error('cancelled');
    throw new Error(`image provider error: ${hideSecretValues(describeError(err), secrets)}`);
  }
  const item = res?.data?.[0];
  let buf = null;
  if (item?.b64_json) buf = Buffer.from(item.b64_json, 'base64');
  else if (item?.url) throw new Error('the image provider returned a URL instead of image data; this factory only accepts b64_json responses');
  if (!buf?.length) throw new Error('the image provider returned no image data');
  await ws.writeBytes(output_path, buf);
  const v = await validateArtifact(ws, output_path);
  if (!v.ok) {
    fs.rmSync(ws.resolve(output_path), { force: true });
    throw new Error(`the provider's output was not saved: ${v.detail}`);
  }
  return { path: v.path, bytes: v.bytes, width: v.width, height: v.height };
}

export const OPTIONAL_TOOLS = {
  render_screenshot: {
    name: 'render_screenshot',
    description: 'Render an HTML file you already wrote to a PNG screenshot with a real headless browser. Returns the path, size and dimensions of the verified PNG. Fails with an error if the HTML is missing/empty or the browser produced no valid image.',
    input_schema: {
      type: 'object',
      properties: { html_path: { type: 'string', description: 'Existing .html file in the workspace' }, output_path: { type: 'string', description: 'Where to save the PNG, e.g. docs/screenshot.png' }, width: { type: 'integer', minimum: 200, maximum: 3840 }, height: { type: 'integer', minimum: 200, maximum: 4000 } },
      required: ['html_path', 'output_path'],
    },
  },
  generate_image: {
    name: 'generate_image',
    description: 'Generate an image with the configured image-generation provider and save it to a path. Returns the verified file. Fails with an explicit error if the provider errors or returns an unsupported format.',
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, output_path: { type: 'string', description: '.png, .jpg or .webp path' }, size: { type: 'string', description: 'e.g. 1024x1024' } },
      required: ['prompt', 'output_path'],
    },
  },
};
