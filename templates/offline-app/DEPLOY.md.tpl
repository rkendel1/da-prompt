# Deploying {{APP_TITLE}}

The app is a single Node.js process. Its only runtime dependencies are the published AppPort packages (`@appport/*`,
pinned exact versions). It reads `PORT` (default `3000`), exposes `GET /api/health` for health checks, and serves its
AppPort capability boundary at `/appport` (discovery: `/.well-known/appport`).

## Run locally
```bash
npm install     # the pinned @appport/* packages
npm test        # run the test suite
npm start       # http://localhost:3000
```

## Docker
```bash
docker build -t {{SLUG}} .
docker run --rm -p 3000:3000 {{SLUG}}
```
The image runs as the unprivileged `node` user and includes a `HEALTHCHECK`.

## Any Node host (Render, Railway, Fly.io, a VM)
- Build command: `npm install --omit=dev --ignore-scripts`
- Start command: `node src/app.js`
- Health check path: `/api/health`
- Environment: `PORT` is provided by the host. Set `APP_API_TOKEN` (and optionally `APP_READ_TOKEN`) as a secret to let
  AppPort callers in; without it every protected capability is refused.

## Operations
- Logs go to stdout.
- `SIGTERM` triggers a graceful shutdown.
- Data is in memory: plan a database adapter before relying on it for durable data.
