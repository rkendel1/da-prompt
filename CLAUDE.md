# CLAUDE.md

da-prompt is a zero-dependency Node.js (>=20, ESM) software factory: a planner, role agents,
verification/feedback loop, completion checklist and delivery, with a web UI.

## Commands
- `npm test` — full suite (uses offline agents, no network or API key needed)
- `npm start` — server on PORT (default 3000)
- `npm run factory -- "idea"` — headless run

## Conventions
- No runtime dependencies. Use `node:` built-ins and global `fetch`.
- All agent file access goes through `Workspace` in `src/sandbox.js`; never bypass it.
- Anything persisted or shown in the UI that might contain secrets goes through `redact()`.
- Every new factory behaviour should be covered in `test/factory.test.js` via the offline provider.
- The UI (`public/`) is plain HTML/CSS/JS; escape every dynamic string with `esc()`.
- Provider calls go through `src/providers/http.js` (node:http, no fetch headers timeout — local models are slow).
- New provider presets go in `PRESETS` in `src/providers/registry.js`; cover new adapters with `test/mock-llm.js`.
- Offline agent output lives in `templates/offline-app/*.tpl`; keep its tests passing.

## Lessons
- `node --test <dir>/` does not accept a directory on Node 22; use a glob (`test/*.test.js`) or no argument.
- `safeEnv()` drops `NODE_TEST_CONTEXT`: inherited, it makes a nested `node --test` skip itself and exit 0. Do not delete it in test files instead; that collapses the runner's per-test reporting.
- `safeEnv()` must drop the whole `GIT_CONFIG_*` family, not just the `*KEY*` entries, or `git` breaks in agent shells.
- Existing-project work lives in `src/project.js` (sources, inspection, baseline, changes) and `src/publish.js` (push + PR); factory behaviour is branched on `isExisting(run)`, not duplicated.
- Operating surface: `src/settings.js` (saved settings + precedence), `src/health.js` (real probes), `src/pax.js` (PAX adapter), `src/evidence.js`, UI in `public/ops.js`. Every setting must map to a field the runtime reads; PAX output is `run.pax` and must never feed the verdict, checklist or readiness.
- Browser tests: open the page on the target hash instead of re-navigating to the same route (a hashchange re-renders New Run and swaps the form under your `fill`).
- Tests that depend on provider/GitHub/PAX state must clear the machine's env first (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, ...) and give each server its own `env` (the registry reads it lazily).
