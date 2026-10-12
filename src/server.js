import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { RunStore } from './store.js';
import { Factory, LAYERS } from './factory.js';
import { PreviewManager } from './deploy.js';
import { Workspace } from './sandbox.js';
import { availableProviders } from './providers/index.js';
import { renderPrompt, PROMPT_TEMPLATE, INPUT_FIELDS } from './prompt.js';
import { buildReport } from './deliver.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 256 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body must be valid JSON');
  }
}

function checkAuth(req, password) {
  if (!password) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass = ''] = Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s);
  const a = Buffer.from(pass);
  const b = Buffer.from(password);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Public view of a run (no huge tool outputs). */
function publicRun(run, factory, previews) {
  return {
    ...run,
    executing: factory.isActive(run.id),
    previewLive: Boolean(previews.get(run.id)),
    plan: run.plan && {
      ...run.plan,
      tasks: run.plan.tasks.map((t) => ({
        ...t,
        attempts: (t.attempts || []).map((a) => ({
          ...a,
          verification: (a.verification || []).map((v) => ({ ...v, output: (v.output || '').slice(-4000) })),
        })),
      })),
    },
  };
}

export async function createServer(overrides = {}) {
  const cfg = loadConfig(overrides);
  const store = new RunStore(cfg.dataDir);
  const previews = new PreviewManager({ max: cfg.maxPreviews });
  const factory = new Factory({ cfg, store, previews });
  await factory.recover();
  const publicDir = path.join(cfg.root, 'public');

  const getRun = async (id) => {
    if (!/^[0-9a-z-]{6,40}$/i.test(id) || !store.exists(id)) throw new HttpError(404, 'run not found');
    return store.load(id);
  };

  async function api(req, res, parts, url) {
    const method = req.method;
    // /api/...
    if (parts[1] === 'health') return json(res, 200, { ok: true, active: factory.active.size });
    if (parts[1] === 'config' && method === 'GET') {
      return json(res, 200, { defaultProvider: cfg.defaultProvider, providers: availableProviders(cfg), defaults: cfg.defaults, layers: LAYERS, inputs: INPUT_FIELDS, gitPush: Boolean(cfg.githubToken) });
    }
    if (parts[1] === 'prompt' && method === 'GET') {
      const inputs = Object.fromEntries(INPUT_FIELDS.map(({ field }) => [field, url.searchParams.get(field) || '']));
      return json(res, 200, { template: PROMPT_TEMPLATE, rendered: renderPrompt(inputs) });
    }
    if (parts[1] !== 'runs') throw new HttpError(404, 'not found');

    if (parts.length === 2) {
      if (method === 'GET') return json(res, 200, { runs: await store.list() });
      if (method === 'POST') {
        const body = await readBody(req);
        let run;
        try {
          run = await factory.createRun(body);
        } catch (err) {
          throw new HttpError(400, err.message);
        }
        if (body.start !== false) factory.start(run.id);
        return json(res, 201, { run: publicRun(run, factory, previews) });
      }
      throw new HttpError(405, 'method not allowed');
    }

    const id = parts[2];
    const run = await getRun(id);
    const sub = parts[3];

    if (!sub) {
      if (method === 'GET') return json(res, 200, { run: publicRun(run, factory, previews) });
      if (method === 'DELETE') {
        await factory.cancel(id);
        await factory.active.get(id)?.promise.catch(() => {});
        await store.remove(id);
        return json(res, 200, { ok: true });
      }
      throw new HttpError(405, 'method not allowed');
    }
    if (sub === 'events' && method === 'GET') return sse(req, res, id, Number(url.searchParams.get('after') || req.headers['last-event-id'] || 0));
    if (sub === 'resume' && method === 'POST') {
      try {
        return json(res, 202, { run: publicRun(await factory.resume(id), factory, previews) });
      } catch (err) {
        throw new HttpError(409, err.message);
      }
    }
    if (sub === 'cancel' && method === 'POST') return json(res, 202, { cancelled: await factory.cancel(id) });
    if (sub === 'tasks' && parts[4] && method === 'POST' && ['retry', 'skip'].includes(parts[5])) {
      const body = await readBody(req);
      try {
        if (parts[5] === 'retry') await factory.retryTask(id, parts[4], body);
        else await factory.skipTask(id, parts[4]);
      } catch (err) {
        throw new HttpError(409, err.message);
      }
      return json(res, 202, { run: publicRun(await store.load(id), factory, previews) });
    }
    if (sub === 'deploy' && method === 'POST') {
      if (!run.plan?.deploy) throw new HttpError(409, 'this run has no deploy command');
      const d = await previews.start(id, store.workspaceDir(id), run.plan.deploy);
      run.deployment = { ...(run.deployment || {}), ...d, start: run.plan.deploy.start, healthPath: run.plan.deploy.healthPath, url: d.ok ? `/preview/${id}/` : null, at: new Date().toISOString() };
      await store.save(run);
      store.event(id, 'deploy', { ok: d.ok, url: run.deployment.url, error: d.error, logs: d.logs, restarted: true });
      return json(res, d.ok ? 200 : 502, { deployment: run.deployment });
    }
    if (sub === 'preview' && method === 'DELETE') return json(res, 200, { stopped: previews.stop(id) });
    if (sub === 'files' && method === 'GET') {
      const ws = new Workspace(store.workspaceDir(id));
      const p = url.searchParams.get('path');
      if (!p) return json(res, 200, { files: await ws.listFiles('.') });
      try {
        return json(res, 200, { path: p, content: await ws.readFile(p, { maxBytes: 400_000 }) });
      } catch (err) {
        throw new HttpError(404, err.message);
      }
    }
    if (sub === 'report' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', ...SECURITY_HEADERS });
      return res.end(buildReport(run));
    }
    if (sub === 'download' && method === 'GET') {
      const name = parts[4] || 'project.tar.gz';
      if (!['project.tar.gz', 'FACTORY_REPORT.md', 'test-results.json'].includes(name)) throw new HttpError(404, 'unknown file');
      const file = path.join(store.deliveryDir(id), name);
      if (!fs.existsSync(file)) throw new HttpError(404, 'not delivered yet');
      const slug = (run.plan?.product?.name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const downloadName = name === 'project.tar.gz' ? `${slug}-${id}.tar.gz` : name;
      res.writeHead(200, { 'content-type': TYPES[path.extname(name)] || 'application/gzip', 'content-disposition': `attachment; filename="${downloadName}"`, ...SECURITY_HEADERS });
      return fs.createReadStream(file).pipe(res);
    }
    throw new HttpError(404, 'not found');
  }

  async function sse(req, res, id, after) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    let last = after;
    const send = (e) => {
      if (e.seq <= last) return;
      last = e.seq;
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const queue = [];
    let replaying = true;
    const unsub = store.subscribe(id, (e) => (replaying ? queue.push(e) : send(e)));
    for (const e of await store.events(id, { after })) send(e);
    replaying = false;
    queue.forEach(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      unsub();
    });
  }

  function proxyPreview(req, res, parts) {
    const id = parts[1];
    const p = id && previews.get(id);
    if (!p) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>Preview stopped</title><body style="font-family:system-ui;padding:40px;max-width:560px;margin:auto"><h1>Preview is not running</h1><p>Open the run in the factory and choose <b>Restart preview</b>.</p><p><a href="/#/runs/${encodeURIComponent(id || '')}">Back to the run</a></p>`);
    }
    if (parts.length === 2 && !req.url.split('?')[0].endsWith('/')) {
      res.writeHead(308, { location: `/preview/${id}/` });
      return res.end();
    }
    const rest = req.url.replace(new RegExp(`^/preview/${id}`), '') || '/';
    const headers = { ...req.headers, host: `127.0.0.1:${p.port}` };
    delete headers.authorization;
    const upstream = http.request(
      { host: '127.0.0.1', port: p.port, method: req.method, path: rest, headers },
      (up) => {
        const out = { ...up.headers };
        if (out.location?.startsWith('/')) out.location = `/preview/${id}${out.location}`;
        res.writeHead(up.statusCode || 502, out);
        up.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) json(res, 502, { error: `preview unreachable: ${err.message}` });
      else res.destroy();
    });
    req.pipe(upstream);
  }

  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const abs = path.resolve(publicDir, rel);
    if (!abs.startsWith(publicDir + path.sep)) throw new HttpError(404, 'not found');
    try {
      const data = await fsp.readFile(abs);
      res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
      res.end(data);
    } catch {
      throw new HttpError(404, 'not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (parts[0] === 'api' && parts[1] === 'health') return json(res, 200, { ok: true });
      if (!checkAuth(req, cfg.password)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="da-prompt factory"', 'content-type': 'text/plain' });
        return res.end('authentication required');
      }
      if (parts[0] === 'api') return await api(req, res, parts, url);
      if (parts[0] === 'preview') return proxyPreview(req, res, parts);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      return await serveStatic(res, url.pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: err.message || 'internal error' });
      else res.end();
    }
  });

  const close = async () => {
    for (const { controller } of factory.active.values()) controller.abort(new Error('server shutting down'));
    await Promise.allSettled([...factory.active.values()].map((a) => a.promise));
    previews.stopAll();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  };

  return { server, cfg, store, factory, previews, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createServer();
  app.server.listen(app.cfg.port, app.cfg.host, () => {
    const p = availableProviders(app.cfg).find((x) => x.name === app.cfg.defaultProvider);
    console.log(`da-prompt software factory on http://localhost:${app.cfg.port}`);
    console.log(`provider: ${app.cfg.defaultProvider} (${p.model})  data: ${app.cfg.dataDir}`);
    if (!app.cfg.password && app.cfg.host !== '127.0.0.1') console.log('note: set FACTORY_PASSWORD before exposing this server; agents run shell commands.');
  });
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
