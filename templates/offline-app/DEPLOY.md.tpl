# Deploying {{APP_TITLE}}

The app is a single zero-dependency Node.js process. It reads `PORT` (default `3000`)
and exposes `GET /api/health` for health checks.

## Run locally
```bash
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
- Build command: none (no dependencies)
- Start command: `node src/app.js`
- Health check path: `/api/health`
- Environment: `PORT` is provided by the host.

## Operations
- Logs go to stdout.
- `SIGTERM` triggers a graceful shutdown.
- Data is in memory: plan a database adapter before relying on it for durable data.
