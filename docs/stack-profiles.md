# Selectable stack profiles for generated applications

A new run chooses the product stack its application is built on. AppPort is the required default. FeltDB and the
Distribution Protocol are optional, supported components. AuthBoundry, AppPort Services and AppBoundry are known but not
supported yet: selecting one fails before anything runs, with the verified blocker and the next step.

The stack builds on the AppPort-native contract ([appport-native.md](appport-native.md)). Nothing here claims that a stack
makes agents more effective or local models better; that needs its own controlled evaluation.

## 1. What the published packages are (verified, not assumed)

Each package was installed from the npm registry and exercised by running code before it was given a status.

| Requested as | Published package | Version | Verified by running | Status |
| --- | --- | --- | --- | --- |
| `@appport/*` | `@appport/core`, `schema`, `authorization`, `protocol`, `server` (+ `client`, `transport-http` for tests) | 1.1.0 / 1.1.0 / 1.0.4 / 1.1.0 / 1.1.1 (+ 1.1.1 / 1.1.1) | discovery, invocation, authorization, official `appport conformance` Level 1 + 2 | **required** |
| `@feltdb/core` | `@feltdb/core` | 0.11.9 | durable writes read back from a fresh process; restart; crash | **supported** |
| `@distribution-protocol/protocol` | `@distribution-protocol/protocol` | 1.0.0 | sign, verify, tampered manifest and wrong bytes rejected | **supported** |
| `@authboundry/*` | `@authboundry/core` (+ `@authboundry/bridge`) | 1.15.3 (0.1.3) | `init` and its FeltDB session bridge work; **the server never served** | unsupported |
| `@appport-services/*` | `@appport/services` (there is no `@appport-services` scope) | 0.4.11 | requires an AuthBoundry `ServiceAuthorizer` | unsupported |
| `@appboundry/*` | `@appport/appboundry` (there is no `@appboundry` scope) | 1.1.1 | needs the contract-driven model | unsupported |

### Findings that shaped the design

- **FeltDB does not enforce its documented single-writer lock.** Its README says a second process gets "Database is
  locked by another process". In 0.11.9, a second process's write was accepted while the first held the database, and both
  writes persisted. Generated apps therefore enforce a sole writer themselves (`DATA_DIR/.writer.lock`), and tests verify
  state read-only from a fresh process.
- **FeltDB sends telemetry by default.** It posts events (event type, random install id, version, runtime, OS, timestamp,
  no application data) to `https://feltdb.com/api/v1/telemetry/events` unless `FELTDB_TELEMETRY=0`. Its 5-second flush
  timer also kept every test process alive for about 5 s (a FeltDB factory run took 21 s instead of 6 s).
  - The factory sets `FELTDB_TELEMETRY=0` for everything it runs: agent commands, tests, previews and gates.
  - A generated app keeps the package default and documents it in its README and DEPLOY.md, so the choice stays with
    whoever deploys it.
- **FeltDB's data model is a `feltdb.flow` file (FlowSpec), but the local runtime does not enforce it.** `@feltdb/core`
  exports `parseFlowSpec`, `validateFlowSpec`, `compileApplicationContract` and `db.deployFlowSpec`. Deploying a flow into a
  local store records it as the active model (`db.application.get()` returns its version and contract hash) and refuses a
  destructive change ("Destructive migration requires explicit approval"). After a deploy, 0.11.9's local runtime still
  accepts records in an undeclared collection, with missing, ill-typed or undeclared fields, with or without
  `authorityScope`. Write-time checks exist only in FeltDB's Rust server. A FeltDB app is therefore generated like this:
  - `feltdb.flow` at the project root is the single declaration of what the store holds; `feltdb validate` passes.
  - `src/flow.js` loads and validates it (an invalid flow stops the app before anything opens). It deploys the flow when the
    active contract differs, never with `allowDestructive`, then requires the active contract hash to equal the flow's.
  - Every record is checked against the parsed flow before it is written: declared collection, declared fields only,
    required fields present, declared types. A type the check does not know fails closed. This check is the app's own,
    derived only from the flow, and documented as such.
  - The deployment is also the store's first durable write. FeltDB writes nothing to disk before one, so this makes the
    store observable to a gate that never mutates the app.
- **A stopped app must close idle connections.** `server.close()` waits for keep-alive connections, so without
  `closeIdleConnections()` a SIGTERM never reached `store.close()`. FeltDB stayed open and the writer lock stayed behind. The
  shutdown handler of every template now closes idle connections and then the store.
- **AppPort Services cannot be used without AuthBoundry.** Every consequential effect is authorized by a host-supplied
  AuthBoundry `ServiceAuthorizer`; without one, API-key management fails closed by design. An app-owned substitute
  authorizer would be a second authorization authority, so none is generated.
- **AuthBoundry's pinned dependencies conflict with this stack.** `@authboundry/core` 1.15.3 pins `@feltdb/core` 0.11.5
  and `@appport/services` 0.3.2 exactly. It is 81 MB installed, with platform-native binaries.
- **AppBoundry is not broken.** Its `build`/`verify` package the contract-driven AppPort model: `appboundry.contract.json`
  and `appport.implementation.json`, created interactively by `appport add`, plus a WASM artifact. That doesn't fit the
  factory's code-defined boundary, so it is a separate integration-design task.

## 2. One mapping, one contract

`templates/stack.json` is the single source for:
- component ids;
- exact published versions;
- runtime and test dependencies;
- what each component requires;
- supported or unsupported status;
- the rules agents are given (supported components);
- the verified blocker and next step (unsupported components).

It replaces `templates/appport-packages.json`. Everything reads it:
- `src/stack.js` (validation, resolution, rules, gate);
- `src/appport.js` (AppPort pins);
- `src/providers/offline.js` (templates).

`src/stack.js`:
- **`resolveStack(selection, { exception })`** validates and normalizes a selection:
  - AppPort is required and implied ("feltdb" means AppPort + FeltDB); only an explicit `appportException` leaves it out;
  - unknown ids, unsupported components and missing requirements throw a `StackError` naming the problem, the blocker
    and the next step.
- **`stackDependencies(ids)`** returns exactly the selected components' packages, and nothing else.
- **`stackRules(ids)`** builds the instructions added to every new-app agent's rules: the selected packages, each selected
  component's rules, and an explicit list of unselected packages that must not be added. The planner is told that the
  implementation task builds on every selected component and the QA task writes the tests those rules name.
- **`describeStack()`** is the view behind `GET /api/stack`, `da-prompt stack` and the New Run form.

## 3. Where the selection is made and kept

| Surface | How |
| --- | --- |
| New Run form | *Product stack* fieldset, shown for new applications. Every supported component (AppPort, FeltDB, Distribution Protocol) can be ticked or unticked; AppPort is ticked by default, and unticking it asks for a reason that becomes the run's recorded AppPort exception (nothing starts without it). Unsupported components are disabled, with their blocker shown. |
| CLI | `da-prompt run "…" --new --stack feltdb` (comma-separated; AppPort implied) · `da-prompt stack` lists components, packages and blockers |
| API | `settings.stack` on `POST /api/runs` (an array of ids) · `GET /api/stack` |
| Run record | `run.settings.stack`, always set for a new run (default `["appport"]`); shown on the run page when not the default |
| Reruns | `POST /api/runs/<id>/rerun` / `da-prompt runs rerun <id>` now also re-run a new app with the same request, model, settings and stack |
| Existing projects | a stack selection is refused: an existing project keeps its own stack |

## 4. The three profiles

The offline agents build each profile through the normal workflow: plan, agents, install, per-task verification, final
`npm test`, preview and gates. Model-backed agents get the same rules and face the same gates.

| Profile | Offline app | Capabilities | Authority |
| --- | --- | --- | --- |
| **AppPort only** (default) | tracker, or a read-only catalog for catalog-like ideas | `items.*` / `entries.*` | the app's in-memory store |
| **AppPort + FeltDB** | tracker on FeltDB | `items.list/get/create/update` | FeltDB in `DATA_DIR`, under the model in `feltdb.flow`: the only store, with the app as the sole writer (its own lock) |
| **AppPort + Distribution Protocol** | release service | `releases.publish` (write), `releases.list/get/verify` (reads) | the app's release store; releases signed with `PUBLISHER_PRIVATE_KEY` |
| **AppPort + FeltDB + Distribution Protocol** | release service on FeltDB | as above | signed releases (manifest, signature and artifact bytes) in FeltDB under `feltdb.flow`; immutable through `putIfAbsent` |

Authority stays as before: client → AppPort → the app's own store functions → authoritative state. The FeltDB tracker uses
the same `app.js`, `appport.js` and tests as the in-memory one; only `src/store.js` differs. Every call is awaited, so a
synchronous and an asynchronous store fit the same code.

For Distribution Protocol, a valid signature is not enough. A release must be signed by **this** publisher's key, so
`verifyRelease` alone would accept a release signed by anyone. Artifact bytes must match the signed digest. The private key
comes only from the environment and never appears in a response, the manifest or the browser. Publishing goes through the
authorized AppPort capability only; the HTTP API is read-only, plus public verification.

The offline templates cover every combination of the supported components. Template layers are applied in order:
`releases-feltdb` → `releases` → `feltdb` → base. FeltDB + Distribution therefore reuses the release service's API, AppPort
boundary and signing, plus FeltDB's `src/flow.js`, and adds only its own store, flow and durability test.

## 5. The stack gate

A new run's checklist has a **stack** item next to the AppPort one (`checkStackConformance` in `src/stack.js`):

| Check | Fails when |
| --- | --- |
| `stack-packages` | a selected component's package is not declared; uses a `file:`/`link:`/git/URL spec; is not installed; or is installed at an incompatible version (0.x: same major and minor; 1.x+: same major; not older than the pin) |
| `stack-unselected-absent` | a package of any unselected component (supported or not) is declared, or installed at the top level |
| `feltdb-used` | FeltDB selected, but no `src/` file imports it, or no test reads the state back through it |
| `feltdb-durable-store` | the app, started with a throwaway `DATA_DIR`, creates no FeltDB state there |
| `feltdb-sole-writer` | a second instance on the same `DATA_DIR` starts |
| `feltdb-clean-shutdown` | after SIGTERM, the app does not release `DATA_DIR/.writer.lock` within 5 s |
| `feltdb-flow` | `feltdb.flow` is missing at the project root, or the app's own `feltdb validate feltdb.flow` fails (checked even when the app does not start) |
| `feltdb-flow-deployed` | after the app ran, a separate process reads the store's active model (`db.application.get()`) and its contract hash is not the one `feltdb.flow` compiles to; this includes an app that deploys no model or a different one |
| `distribution-used` | Distribution selected, but no `src/` file imports it, or no test exercises it |

The gate never touches the app's real data: it uses throwaway data folders under the workspace's `.home`, and previews get
their own folder there too. The AppPort conformance gate is unchanged.

Distribution behaviour (signing, tamper, wrong bytes, foreign key) is proved by the app's own `test/distribution.test.js`
(run by `finalVerify`) and by `test/stack.test.js`. The gate's `distribution-used` check is a source supplement only.

## 6. Footprint

Measured on this container from the offline agents' output, with a warm npm cache and `FELTDB_TELEMETRY=0`. Medians are
from 3 test runs and 5 starts. Timings are indicative, not a benchmark.

| | AppPort only (tracker) | AppPort only (catalog) | AppPort + FeltDB | AppPort + Distribution |
| --- | --- | --- | --- | --- |
| Declared dependencies (runtime / dev) | 5 / 2 | 5 / 2 | 6 / 2 | 6 / 2 |
| Installed packages | 7 | 7 | 8 | 8 |
| `node_modules` size | 2.2 MB | 2.2 MB | 18.4 MB (FeltDB ships WASM) | 2.4 MB |
| Install (warm cache) | 0.38 s | 0.41 s | 0.79 s | 0.40 s |
| `npm test` (median) | 0.39 s | 0.40 s | 0.54 s | 0.38 s |
| Start to healthy | ≤ 0.41 s | ≤ 0.41 s | ≤ 0.41 s | ≤ 0.41 s |
| App files / `src` lines / `test` lines | 18 / 295 / 194 | 18 / 247 / 155 | 19 / 374 / 262 | 21 / 370 / 195 |
| Whole offline factory run | 3.5 s | 3.5 s | 5.8 s | 3.6 s |

**How to read the timings:**
- "Start to healthy" is bounded by the preview's 400 ms health-poll interval. Every profile was healthy at the first or
  second poll; started by hand, the FeltDB tracker was healthy after 0.23 s.
- With FeltDB telemetry left on, every test process of the FeltDB app lingered about 5 s after its tests finished
  (its flush timer).

**Integration code per profile:**
- **FeltDB:** `src/store.js` grows from 74 to 153 lines (FeltDB, lock, schema record), plus `test/feltdb.test.js` (68 lines).
- **Distribution:** `src/signing.js` (73 lines), plus `test/distribution.test.js` (48) and `test/keys.js` (5). The release
  app's `store.js`, `app.js`, `appport.js` and UI are its own variant files.

**Factory side:**
- `templates/stack.json`;
- `src/stack.js` (about 230 lines);
- one checklist item, one run setting, one CLI command and flag, one API route, one form fieldset;
- the factory still has no runtime dependency.

## 7. Verification

```bash
npm run check                                                     # ok
node --require ./test/setup-env.cjs --test test/stack.test.js     # 12/12
npm run prove:stack -- --out docs/stack-proof.md                  # the end-to-end proof below
node --require ./test/setup-env.cjs --test test/appport.test.js   # 10/10 (existing AppPort-native gate, unchanged behaviour)
npm test                                                          # see the PR for the full result
```

`test/stack.test.js` covers:
- **Validation:** unknown ids; each unsupported component with its blocker and next step; the exception interplay; the
  API's 400 response; CLI refusals; reruns keeping the selection.
- **AppPort only:** no optional package is declared or installed.
- **AppPort + FeltDB:**
  - writes through AppPort are read back from a fresh process that opens the app's FeltDB folder after the app stopped,
    including an update;
  - a restarted app serves the same state;
  - a second instance is refused;
  - the lock is released on shutdown;
  - the store's active model is exactly `feltdb.flow`, and each stored record has exactly the declared fields.
- **AppPort + Distribution:**
  - publish through AppPort;
  - verify independently with the package, pinned to our key, over the bytes the app serves;
  - a tampered manifest, wrong bytes and a validly signed foreign release are rejected;
  - anonymous publishing gets `UNAUTHORIZED` and a repeat publish gets `CONFLICT`;
  - REST publishing gets 405.
- **AppPort + FeltDB + Distribution:**
  - every gate check passes;
  - a release published through AppPort is read from a fresh process: `Release` record with exactly the flow's fields,
    `verifyRelease` and `verifyArtifactBytes` pass on the stored manifest and bytes, and the active model is the flow;
  - a restarted app serves and verifies the same release and still answers `CONFLICT` to a republish.
- **Gate negatives:**
  - an unselected package declared, or installed;
  - a selected package missing, or at an incompatible version;
  - a FeltDB app without a sole-writer lock, or keeping its state outside `DATA_DIR`;
  - a FeltDB app whose `feltdb.flow` is missing, or invalid (it also does not start), or that deploys a model other than the
    one it ships.

Each generated FeltDB app's own `test/feltdb.test.js` also proves the flow: `feltdb validate` passes; the record check
refuses an undeclared collection, an undeclared field, a wrong type and a missing field; an invalid flow is refused; a
destructive change keeps the store closed; an additive change becomes model version 2.

### End-to-end proof (`npm run prove:stack`, report in [stack-proof.md](stack-proof.md))

`scripts/prove-stack.mjs` generates *"A release service for our CLI tool that keeps every release"* with all three supported
components through the normal factory workflow. It then checks the app from outside, independently of the factory's gates.
The last run had 70 checks, all passing:
- **Dependencies:** declared and installed packages equal the stack, and the unsupported packages are absent.
- **The app's own tests** pass.
- **AppPort:** the official `appport conformance` passes Level 1 (protocol) and Level 2 (discovery). Discovery, the
  declared capabilities and scopes, invocation, authorization (anonymous, wrong token, reader, writer) and exposure rules
  hold; REST publishing gets 405.
- **FeltDB:**
  - the sole writer is enforced and a clean shutdown releases the lock;
  - a fresh process reads the release from FeltDB and gets the same view as AppPort and HTTP, with the stored bytes equal
    to the served bytes;
  - the release survives a restart and stays immutable.
- **`feltdb.flow`:**
  - it is valid by FeltDB's CLI and deployed as the active model, with the contract hashes equal;
  - stored records have exactly the declared fields;
  - FeltDB's own local runtime is shown *not* to check records;
  - app variants with a changed flow (copies; the generated app is untouched) show:
    - an invalid flow stops the app ("Unsupported field type int");
    - a flow that no longer declares a written field makes that write fail with nothing stored;
    - a destructive change stops the app and leaves the store unchanged ("Destructive migration requires explicit
      approval: Release.content");
    - an additive change becomes model v2 with the release still served.
- **Distribution Protocol:**
  - the package verifies the stored release and its bytes;
  - a tampered manifest, wrong bytes and a foreign key are rejected, both by the package and by the app's `/api/verify`.
- **Unsupported components:** selecting AuthBoundry, AppPort Services or AppBoundry together with the three is refused with
  their blockers.

Screenshots of the New Run stack picker are in [screenshots/stack/](screenshots/stack/):
1. the default (AppPort only);
2. all supported components selected;
3. one deselected;
4. AppPort deselected, which asks for a reason;
5. that refused without a reason;
6. the full form;
7. the run page showing the stack.

`test/ops-ui.test.js` drives the New Run form:
- every supported component can be ticked and unticked, and unsupported ones are disabled with their blocker;
- the fieldset hides for an existing project;
- unticking AppPort without a reason is refused;
- ticking FeltDB records `["appport", "feltdb"]`;
- unticking AppPort with a reason records the exception and an empty stack.

## 8. Unsupported components: what must happen next

- **AuthBoundry.**
  - Verify the exact `authboundry serve` invocation, environment, prerequisites and bridge lifecycle on a supported machine.
    Observed here: `serve` 1.15.3 on linux-x64, with and without `--upstream`, with `AUTHBOUNDRY_FELTDB_PATH` set, never
    bound its port and printed nothing; the native process blocked on a pipe read from its Node bridges.
  - Capture a sign-in → `/auth/session` → `/auth/authorize` grant and denial round trip.
  - Resolve the pinned `@feltdb/core` 0.11.5 and `@appport/services` 0.3.2 against this stack's versions.
  - Then add AuthBoundry as its own tested increment.
- **AppPort Services.** After AuthBoundry is supported, add it on its intended AuthBoundry authorization path, as a separate
  increment.
- **AppBoundry.** A separate integration design: how a generated app adopts the contract-driven model, or how AppBoundry
  packages a code-defined boundary, with a non-interactive build.

## 9. Limitations

- Generated apps install from the npm registry (one shared cache per data dir; tests share one cache). FeltDB adds 16 MB
  to the first download.
- The FeltDB profile is single-machine: one process per `DATA_DIR`, as the store requires. The FeltDB server and remote
  modes are not part of this profile.
- Without FeltDB, the release service keeps releases in memory; select FeltDB for durable releases.
- `feltdb.flow` is the authority by the app's own enforcement (validate, deploy, compare hashes, check every record).
  FeltDB 0.11.9's local runtime records the deployed model but does not reject records that violate it. Its `unique`
  indexes and policies are not enforced locally either, so the templates do not declare any. Release immutability comes
  from `putIfAbsent` on the `name@version` key.
- The official `appport conformance` Level 3 (capability execution) fails against generated apps. It probably cannot send
  a credential to these authenticated capabilities; the same behaviour is covered by the client-based checks.
- The stack gate's `*-used` checks are source supplements. Behaviour is proved by the apps' own tests (run by
  `finalVerify`) and by this repository's tests, not generically for arbitrary model-built apps.
- No model-backed run was performed for this change; how often real models satisfy the stack rules is unknown.
