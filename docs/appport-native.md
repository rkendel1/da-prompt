# AppPort-native generated applications

Every **new** application the factory builds exposes an explicit AppPort capability boundary over its own state and rules,
using the published `@appport/*` packages. This document records the reconnaissance behind the change, the contract, the
conformance gate, the one exception mechanism, the measured footprint, and what is not covered.

Nothing here claims that AppPort reduces tool calls, tokens, integration effort or the model size a task needs. Those are
not measured by this change. It establishes the generation contract that such a measurement needs.

## 1. Reconnaissance (before the change)

**Generation pipeline.** A new run plans with `submit_plan` (`src/agents.js`: `plannerSystem`, `WORKSPACE_RULES`) under the
operating prompt (`src/prompt.js`; default stack "Node.js (>=20), zero or minimal dependencies"). Agents build the app with
four tools in a sandboxed workspace. Verification runs each task's `verify` commands, then `plan.finalVerify`. A live preview
(`src/deploy.js`) starts `plan.deploy.start` and polls `healthPath`, and `complete()` (`src/factory.js`) fills the checklist:
tasks, tests, security, deploy, docs, summary.

**Application types.** There were none: no archetype, kind or template selection exists anywhere in `src/`. With a model,
the app is whatever the planner designs. Offline, `src/providers/offline.js` always wrote one items-CRUD app from
`templates/offline-app/*.tpl`:
- `node:http` with `ItemStore` in memory;
- REST routes `/api/items[/:id]` plus `/api/health`;
- static UI files and 6 `node:test` tests;
- no authentication, and `package.json` had no dependencies at all.

**Dependencies and installs.** New runs had no install step. The offline app had zero dependencies, previews never install,
and the Dockerfile copied only `package.json`, `src` and `public`. `HOME` is redirected per workspace, so npm's cache was
per-run as well.

**Settings.** Run settings are built and clamped in `createRun`/`updateRun`. `deploy` is the precedent for a per-run flag
whose default depends on new versus existing mode. Existing-project behaviour branches on `isExisting(run)`.

**Tests and CI.**
- `test/factory.test.js`, `test/server.test.js` and the mock-LLM tests all generate the offline app.
- CI (`.github/workflows/ci.yml`) runs `check`, `build`, `test:contracts`, `npm test` and a headless offline run on Node 20 and 22.
- The runner has internet access, but no test installed from the npm registry.

**Published AppPort packages** (inspected from the registry, not from source):

| Package | Version | Third-party deps |
| --- | --- | --- |
| `@appport/core` | 1.1.0 | none |
| `@appport/schema` | 1.1.0 | none |
| `@appport/authorization` | 1.0.4 | none |
| `@appport/protocol` | 1.1.0 | none |
| `@appport/server` | 1.1.1 | none |
| `@appport/client` | 1.1.1 | none |
| `@appport/transport-http` | 1.1.1 | none |

Each package depends only on other `@appport/*` packages, pinned exactly. `@appport/runtime` and `@appport/services` pull in
express and more, and are not needed.

The APIs used:
- `defineCapability` and `createApplication` (`@appport/core`);
- `s` (`@appport/schema`);
- `permissionAuthorizer` (`@appport/authorization`);
- `AppPortError` (`@appport/protocol`);
- `createServer` and `createHttpBinding` (`@appport/server`);
- `handleNodeRequest` (`@appport/server/node`), which mounts the binding inside an existing `node:http` server;
- `AppPort.discover` (`@appport/client`) with `createHttpTransport` (`@appport/transport-http`).

Behaviour verified against the packages before relying on it:
- A consequential capability without declared authorization is rejected by `defineCapability`. One explicitly declared
  public is accepted, though, and runs for anonymous callers, so the factory gate must catch that case itself.
- `allowedCapabilities` on the binding refuses unlisted capabilities, but they still appear in the manifest. Generated apps
  therefore register only what they expose.
- Discovery needs `transports: [{ kind: 'http', endpoint: '/appport' }]`.
- Anonymous callers get `UNAUTHORIZED`. An authenticated caller without the permission gets `FORBIDDEN`.
- Input is validated before authorization.

**Smallest common integration point.** The generation boundary itself: the rules every new-app agent receives, the planner's
rules, the offline templates, and the completion checklist. No new framework, control plane or registry was needed. AppPort's
own registry, authorizer, binding and client do the work.

## 2. The contract

The single source is `src/appport.js` (`APPPORT_RULES`, given to every agent building a new app) together with
`templates/stack.json` (the pins, shared with the offline templates):

- **Packages:** the published packages at the pinned versions. Install with
  `npm install --no-audit --no-fund --ignore-scripts --prefer-offline`. No `file:`, `link:` or git dependencies, and no copied
  source.
- **Boundary in `src/appport.js`:**
  - one capability per semantic operation the app really implements;
  - each calls the same store/service function as the HTTP API, with no second copy of data, no direct database access, and
    no extra cache or in-memory state;
  - each has a description, input/output schemas, an explicit effect (`observation` for reads, `consequential` for writes)
    and a permission; writes always need one;
  - the app's own validation and not-found errors become `INVALID_INPUT` / `NOT_FOUND`.
- **Opt-in exposure:** only the listed capabilities are registered and passed as `allowedCapabilities`. A method existing
  internally exposes nothing.
- **Mounted in the existing HTTP server** (no second server), and advertised so `/.well-known/appport` works.
- **Authentication is the app's:**
  - `Authorization: Bearer <token>`, mapped by the app to `{ principal, session.permissions }`;
  - tokens come from `APP_API_TOKEN` (full access) and optionally `APP_READ_TOKEN` (read-only);
  - with no token configured, every protected capability is refused;
  - tokens are never in source, browser code or capability descriptions.
- **No retries of ambiguous writes:** writes are not marked idempotent, and nothing retries them.
- **Tested:** `test/appport.test.js` drives the boundary with the published client. It covers discovery, every capability,
  results checked against the store and HTTP API, refused callers, and operations that are absent. The README documents the
  capabilities.

The planner is told that the implementation task builds the boundary and the QA task tests it, and the default stack now
names the AppPort packages. Existing projects are unaffected: their rules, plan and checklist do not mention AppPort.

## 3. The two generated application types

The offline agents now build two materially different apps through the same contract. Files under
`templates/offline-app/variants/catalog/` replace the shared ones.

| | Tracker (default) | Catalog (ideas such as catalog, directory, glossary, reference) |
| --- | --- | --- |
| State | `ItemStore` (create, update, delete, list) | `EntryStore`: a validated, read-only seed (search, get, categories) |
| HTTP API | `/api/items[/:id]`: GET, POST, PATCH, DELETE | `/api/entries[/:id]`, `/api/categories`: GET only (everything else 405) |
| Capabilities | `items.list`, `items.get` (reads, `items.read`); `items.create`, `items.update` (writes, `items.write`) | `entries.search`, `entries.get`, `entries.categories` (reads, `entries.read`); no writes |
| Not exposed | `ItemStore.remove()` (delete) | nothing to write |
| Roles | full: read and write; read token: read only | both tokens: read |

Choosing the type by keyword stands in for a model's interpretation of the idea. With a model provider, the planner designs
the app and the same contract and gate apply.

## 4. The conformance gate

`checkAppPortConformance` (in `src/appport.js`) is the checklist item **"Capabilities are AppPort-native (discoverable,
authorized, invocable)"** of every new run. It runs once every task is complete. It starts the finished app with its own
start command and a one-off `APP_API_TOKEN`, through the same `launchApp` that previews use, and speaks the AppPort wire
protocol to it. The factory stays dependency-free and never mutates the app.

| Check | Fails when |
| --- | --- |
| `tested` | no test under `test/` uses `@appport/client`. This is a source supplement; the tests themselves run in `finalVerify`. |
| `packages` | `@appport/core`/`server` missing; an `@appport` spec is `file:`/`link:`/git/URL; a package isn't installed; or an installed version isn't compatible (same major, not older than the pin) |
| `starts` | the app does not become healthy |
| `discovery` | `/.well-known/appport` is missing, isn't `appport/1`, or advertises no http transport |
| `capabilities` | the manifest declares no application capability |
| `declared` | a capability lacks a description, an input schema or an explicit effect |
| `writes-authorized` | a `consequential` capability does not require a permission |
| `anonymous-refused` | a protected capability answers an anonymous caller, called with a schema-valid sample input. Answering `INVALID_INPUT` instead of `UNAUTHORIZED`/`FORBIDDEN` also fails. |
| `invocation` | an authorized read fails with anything other than `NOT_FOUND`/`CONFLICT` (for example, when the app ignores `APP_API_TOKEN`) |
| `unexposed-refused` | an undeclared capability answers |
| `no-credentials` | the token value appears in the discovery document or the manifest |

**State authority** cannot be checked generically, because the gate cannot know an app's data. It is proved by the app's own
`test/appport.test.js`, which compares every capability result and mutation with the store and the HTTP API, and which
`finalVerify` runs. The gate's `tested` check requires such a test to exist. `test/appport.test.js` in this repository
shows that a capability answering from its own copy of the data fails the generated suite.

The gate runs in the normal CI path: `npm test` includes `test/appport.test.js`, and every offline factory test now passes
the gate.

## 5. Exceptions

`settings.appportException` (CLI: `da-prompt run "…" --new --appport-exception "<reason>"`) is the only opt-out:
- a non-empty reason is required (up to 300 characters);
- it is recorded in the run settings, logged when the run starts, and shown as the checklist item (`state: 'na'`, with the
  reason);
- agents are then not asked for the boundary.

Existing projects never carry it, and there is no global switch or environment variable. A normal run has no exception
field at all.

## 6. Footprint

Measured on this container: the base factory (`fcc4cbc`) against this branch, offline provider, warm npm cache, and the
median of 3 test runs and 5 starts. Timings are indicative, not a benchmark.

| | Tracker before | Tracker AppPort-native | Catalog AppPort-native |
| --- | --- | --- | --- |
| App files (excluding node_modules) | 13 | 17 (+`src/appport.js`, `src/auth.js`, `test/appport.test.js`, `package-lock.json`) | 17 |
| `src/` lines | 169 | 288 (+74 appport, +41 auth, +4 mount) | 247 |
| `test/` lines | 74 | 175 (+101) | 147 |
| Runtime / dev dependencies | 0 / 0 | 5 / 2 | 5 / 2 |
| Installed packages, size | none | 7 `@appport/*`, 2.2 MB, no third-party code | same |
| Install (warm cache) | none | ~0.45 s (cold, first download: ~2.6 s) | ~0.44 s |
| `npm test` | 0.29 s (6 tests) | 0.43 s (12 tests) | 0.41 s (12 tests) |
| Start to healthy | 0.42 s | 0.41 s (no measurable change) | 0.41 s |
| Whole offline factory run | 1.8 s | 3.8 s (install, 6 more tests, the gate) | 3.5 s |

**Integration code per app type:**
- `src/appport.js`: its capabilities, plus about 6 lines of setup;
- `src/auth.js`: shared by both types, unchanged;
- 3 lines in `src/app.js` to mount the boundary;
- `package.json` pins rendered from one JSON file;
- one AppPort test file.

**Remaining duplication:**
- The 6-line `createAppPort` setup is repeated in both `appport.js` templates.
- The catalog's `app.js`, UI and tests are variant copies of the tracker's scaffolding. That cost comes from having a
  second app type, not from AppPort.

**Factory side:**
- `src/appport.js`: contract and gate, about 260 lines;
- the `launchApp` refactor in `src/deploy.js`, which previews now share;
- one checklist item, one run setting, one CLI flag;
- the npm cache setting (`FACTORY_NPM_CACHE` / `cfg.npmCache`);
- the factory still has no runtime dependencies.

## 7. Verification

```bash
npm run check                                       # ok
npm run build                                       # ok
node --require ./test/setup-env.cjs --test test/appport.test.js   # 10/10
npm test                                            # see the commit / PR for the full result
```

`test/appport.test.js` does three things:
1. Generates a tracker and a catalog through the normal factory workflow: plan, agents, install, per-task verification,
   `npm test`, preview and gate.
2. Starts each app the documented way, with tokens, and drives it from the generated workspace with the published client:
   - discovery and invocation;
   - reads and writes checked independently through the HTTP API;
   - anonymous callers get `UNAUTHORIZED`, a read token writing gets `FORBIDDEN`;
   - delete and catalog writes are not exposed;
   - invalid input and unknown ids give `INVALID_INPUT`/`NOT_FOUND`;
   - the existing HTTP API and UI still work;
   - a preview without a token fails closed.
3. Breaks one rule at a time on a copy of a generated app and checks that the gate fails on exactly that rule.

## 8. Limitations and open points

- **Network.** Generated apps install from the npm registry. Tests share one cache (`test/setup-env.cjs`), so a machine
  downloads 2.2 MB once; a cold cache with no registry access fails the generated apps' installs. CI has registry access.
  The test process itself still opens no off-machine connection (`test/offline-guard.js`).
- **The HTTP API and UI of the generated tracker remain unauthenticated, as before.** The AppPort boundary is stricter than
  the app's own REST surface. Adding accounts to the app is a separate product change.
- **No sessions or tenancy beyond tokens.** The authenticator maps a bearer token to a role. Real apps with user accounts
  would map their own sessions.
- **Generic gate limits.**
  - It cannot prove state authority for an arbitrary model-built app; it relies on the app's own tests and the source
    supplement.
  - It reaches the authorization step with schema-derived sample inputs. Unusual schemas may need the app to accept a
    minimal input, otherwise the gate reports the check as failed (it never passes it).
  - It invokes reads only, never writes.
- **Model-built apps.** The rules tell agents the exact APIs and point them at the installed READMEs. Whether a given model
  follows them is what the gate checks. No model run was performed for this change, so how often real models pass the gate
  is unknown.
- **UI.** The exception is available through the API and the CLI, not yet in the New Run form.
- **Not covered:** other transports (WebSocket, MCP via `@appport/mcp`), events and streams, generated typed clients
  (`@appport/generators`), and public discovery (`publication`). The packages support them; the contract does not require
  them.
