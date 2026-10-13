// A tiny loopback HTTP server for adapter tests: route(req, body, log) -> [status, object, headers?] (or a promise).
// Everything it serves is local; bodies are recorded so a test can assert exactly what an adapter sent.
import http from 'node:http';

export async function serve(route) {
  const log = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { __raw: raw };
    }
    log.push({ method: req.method, url: req.url, body, headers: req.headers });
    const out = await route(req, body, log, res);
    if (out === 'hang') return; // never answer
    const [status, obj, headers = {}] = out;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    log,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}

export const completion = (message, extra = {}) => [200, { choices: [{ message: { role: 'assistant', ...message }, finish_reason: extra.finish || 'stop' }], ...(extra.usage ? { usage: extra.usage } : {}) }];
