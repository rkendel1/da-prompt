import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReleaseStore, ValidationError } from './store.js';
import { createAppPort } from './appport.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 64 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

export const APP_NAME = {{APP_TITLE_JSON}};

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', ...headers });
  res.end(payload);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ValidationError('request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('body must be valid JSON');
  }
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

export function createApp({ store = new ReleaseStore(), tokens } = {}) {
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
      if (parts[1] === 'health' && parts.length === 2) {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
        return send(res, 200, { ok: true, name: APP_NAME, releases: await store.stats(), publisher: { id: store.signer.publisherId, publicKey: store.signer.publicKey, canPublish: store.signer.canSign } });
      }
      // Anyone may verify a release (and artifact bytes) against this publisher. Publishing goes through AppPort only.
      if (parts[1] === 'verify' && parts.length === 2) {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        const body = await readJson(req);
        if (!body.release || typeof body.release !== 'object') throw new ValidationError('release is required');
        if (body.content !== undefined && typeof body.content !== 'string') throw new ValidationError('content must be base64');
        return send(res, 200, await store.verify(body.release, body.content));
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      if (parts[1] === 'releases' && parts.length === 2) return send(res, 200, { releases: await store.list() });
      if (parts[1] === 'releases' && (parts.length === 4 || parts.length === 5)) {
        const [name, version] = [decodeURIComponent(parts[2]), decodeURIComponent(parts[3])];
        const release = await store.get(name, version);
        if (!release) return send(res, 404, { error: 'release not found' });
        if (parts.length === 4) return send(res, 200, { release });
        if (parts[4] !== 'artifact') return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': release.mediaType, 'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="${release.artifactId}"` });
        return res.end(await store.artifact(name, version));
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
  const store = new ReleaseStore();
  try {
    await store.ready; // a durable store opens (and deploys its data model) before the app accepts a request
  } catch (err) {
    console.error(`${APP_NAME} cannot start: ${err.message}`);
    process.exit(1);
  }
  const server = createApp({ store });
  server.listen(port, () => console.log(`${APP_NAME} listening on http://localhost:${port}`));
  // Stop accepting requests, end idle keep-alive connections (they would hold close() open), then close the store so a
  // durable store is flushed and its lock released.
  const stop = () => {
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
