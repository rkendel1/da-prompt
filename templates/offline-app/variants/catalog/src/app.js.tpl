import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EntryStore, ValidationError } from './store.js';
import { createAppPort } from './appport.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

export const APP_NAME = {{APP_TITLE_JSON}};

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', ...headers });
  res.end(payload);
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.resolve(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'not found' });
  try {
    const data = await fs.readFile(abs);
    res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

export function createApp({ store = new EntryStore(), tokens } = {}) {
  // The AppPort capability boundary (src/appport.js) over the same store: /appport, /appport/manifest, /.well-known/appport.
  const appport = createAppPort({ store, ...(tokens ? { tokens } : {}) });
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (appport.handles(url.pathname)) return appport.handle(req, res);
    try {
      if (parts[0] !== 'api') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
        return await serveStatic(res, url.pathname);
      }
      // The catalog is read-only: every API route answers GET only.
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      if (parts[1] === 'health' && parts.length === 2) {
        return send(res, 200, { ok: true, name: APP_NAME, entries: store.stats() });
      }
      if (parts[1] === 'categories' && parts.length === 2) return send(res, 200, { categories: store.categories() });
      if (parts[1] === 'entries' && parts.length === 2) {
        const entries = store.search({ query: url.searchParams.get('q') ?? '', category: url.searchParams.get('category') ?? '' });
        return send(res, 200, { entries, total: entries.length });
      }
      if (parts[1] === 'entries' && parts.length === 3) {
        const entry = store.get(decodeURIComponent(parts[2]));
        return entry ? send(res, 200, { entry }) : send(res, 404, { error: 'entry not found' });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof ValidationError) return send(res, 400, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'internal error' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const server = createApp();
  server.listen(port, () => console.log(`${APP_NAME} listening on http://localhost:${port}`));
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections(); // idle keep-alive connections would hold close() open
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
