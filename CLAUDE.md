# CLAUDE.md

da-prompt is a zero-dependency Node.js (>=20, ESM) software factory: a planner, role agents,
verification/feedback loop, completion checklist and delivery, with a web UI.

## Commands
- `npm test` — full suite (uses offline agents, no network or API key needed)
- `npm start` — server on PORT (default 4747)
- `npm run factory -- "idea"` — headless run

## Dev path (works without da-prompt, a backend or an LLM)
- `npm run check` (static checks) · `npm run build` (package/entry/import smoke) · `npm test` · `npm run validate` runs all three.
- The CLI (`src/cli/`) is a client of the one backend: add a capability to `src/server.js`/`src/factory.js` first, then a command in `src/cli/commands/`. Never give it a second run store or orchestration loop.

## Conventions
- No runtime dependencies. Use `node:` built-ins and global `fetch`.
- All agent file access goes through `Workspace` in `src/sandbox.js`; never bypass it.
- Anything persisted or shown in the UI that might contain secrets goes through `redact()`.
- Every new factory behaviour should be covered in `test/factory.test.js` via the offline provider.
- The UI (`public/`) is plain HTML/CSS/JS; escape every dynamic string with `esc()`.
- Provider calls go through `src/providers/http.js` (node:http, no fetch headers timeout — local models are slow).
- New provider presets go in `PRESETS` in `src/providers/registry.js`; cover new adapters with `test/mock-llm.js`.
- CLI output: human text through `out.print/info`, machine output through `out.data` (so `--json` stays one clean document); errors are `CliError(message,{code,hint})` with the documented exit codes. Every new command needs a test in `test/cli*.test.js` (in-process `cli()` against `startBackend()` from `test/cli-helpers.js`).
- Offline agent output lives in `templates/offline-app/*.tpl`; keep its tests passing.

## Lessons
- Agent engines (`src/engines/`): `builtin` is the default and must keep working with no extra packages; optional engines (today `fx`) are installed under `<data dir>/engines`, never into this repo's dependencies, and take the SAME `runAgent` arguments/result. Their tools must go through `execTool`/`Workspace`, credentials may only reach them as env var names, and a run keeps the `engine` it started with. Test with an injected fake module (`cfg.engineModules`), as in `test/engines.test.js`.
- `node --test <dir>/` does not accept a directory on Node 22; use a glob (`test/*.test.js`) or no argument.
- `safeEnv()` drops `NODE_TEST_CONTEXT`: inherited, it makes a nested `node --test` skip itself and exit 0. Do not delete it in test files instead; that collapses the runner's per-test reporting.
- `safeEnv()` must drop the whole `GIT_CONFIG_*` family, not just the `*KEY*` entries, or `git` breaks in agent shells.
- Existing-project work lives in `src/project.js` (sources, inspection, baseline, changes) and `src/publish.js` (push + PR); factory behaviour is branched on `isExisting(run)`, not duplicated.
- Operating surface: `src/settings.js` (saved settings + precedence), `src/health.js` (real probes), `src/pax.js` (PAX adapter), `src/evidence.js`, UI in `public/ops.js`. Every setting must map to a field the runtime reads; PAX output is `run.pax` and must never feed the verdict, checklist or readiness.
- Browser tests: open the page on the target hash instead of re-navigating to the same route (a hashchange re-renders New Run and swaps the form under your `fill`).
- Tests that depend on provider/GitHub/PAX state must clear the machine's env first (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, ...) and give each server its own `env` (the registry reads it lazily).
- `node --check` treats `.js` as CommonJS when no `package.json` with `"type":"module"` is above it; fixtures that test `scripts/check.mjs` need one.
- The factory's per-command timeout (`commandTimeoutMs`, 3 min) is shorter than this repo's full `npm test`; when da-prompt works on itself raise it (`da-prompt config set commandTimeoutMs 900000`) or the baseline `npm test` reports a timeout.
- In CLI tests, `main()` reads `io.env`/`io.cfg`; state helpers must be passed `ctx.env` (a `writeState()` without it wrote to the real HOME once).
- Terminal (`src/terminal.js`, `src/terminal-pty.py`, `public/terminal.js`, `/api/terminal`): a privileged host-shell feature. Never route it through agents/providers/runs; never build a shell string (argv arrays + raw PTY bytes); keep every route behind `terminalGuard` (admin + Origin/Host checks) and the session principal; never log or persist terminal I/O or environment.
- Terminal tests: the typed command line is echoed by the PTY, so wait for output with a leading newline (`/\nMARK/`), not for the bare word. Use `/bin/bash` in UI tests (dash has no history); a test must never leave `sleep` children behind (they keep the test runner's pipes open and the run hangs).
- `req.on('close')` does not fire for a dead socket once the request body was read; SSE cleanup must also listen on `res`.
- `npm test` preloads `test/setup-env.cjs`, which strips FACTORY_*/DA_PROMPT_*/PORT/HOST/keys/tokens from the environment (except `DA_PROMPT_PAX_BIN`).
- Projects (`src/registry.js`, `public/projects.js`, `/api/projects/<prj_id>`): the registry is the one project system; features take a `projectId` and obtain the workspace only through `registry.locate()` (re-validates, refuses archived/missing/inaccessible/attention). Never store a path or directoryId as a project's identity, never auto-follow a folder that holds a different repository, never delete files on removal. Keep conflict checks inside the serialized `mutate()`.
- Registry tests: two temp repos with identical content and commit time get the same first-commit hash and look like the same repository; give them different messages.

- Chat and backlog (`src/chat.js`, `src/chat-context.js`, `src/tasks.js`, `src/jsonstore.js`, `public/chat.js`, `public/backlog.js`): chat is advisory and has no tools; a conversation is bound to one `projectId` (or to none: a general chat) for life, created lazily on the first message from the UI; what is sent to the model is the per-conversation `context` (switchable `sources` + pinned `notes`, ids stable across reads), never more than the user left ticked; context is retrieved server-side via `registry.locate()`, bounded and recorded on the message. The backlog order is the single `order` array in `tasks.json` plus a `rev`; never add a second priority field, never reorder on status change. Only `POST /api/tasks/<id>/start` may create a run from a task, and a run finishing never completes a task. Tests: `ChatFake` and `startWorkBackend` in `test/work-helpers.js`.
- `shutdown()` in `ChatService` runs before the server closes: interrupted responses are finalized as retryable errors, not left `streaming`.
