# Audit: agent architecture, FX/Chip integration and execution options

Status: **audit and proposal only. No source code was changed.** Nothing here has been run against a real local model, so every
performance statement below is either established by code or listed in §9 as a measurement still to collect.

Sources examined (all read, none executed unless stated):

| Source | Version / commit | How obtained |
| --- | --- | --- |
| This repository | branch `claude/affectionate-allen-9peb3o`, base `4e223e7` | working tree |
| `@appport/fx` | npm `0.1.2` (published 2026-10-12) | `npm pack`, unpacked and read, not installed or run |
| FX source `rkendel1/3fx` | `3c3b6bc` (2026-10-12) | shallow clone, read |
| `@appport/chip` | npm `0.54.5` | `npm pack`, unpacked and read, not installed or run |
| Chip source `rkendel1/eve` (`packages/eve`) | `80c6e3d`, package version `0.54.5` | shallow clone, read |

References look like `path:line` (this repo), `fx:` (the `@appport/fx` tarball or `3fx` clone) or `chip:` (the Chip tarball or `eve` clone).

---

## 1. Current-state architecture

### 1.1 Control flow (as implemented)

```
Human / task input
  UI (public/) · CLI (src/cli/) · POST /api/tasks/<id>/start · POST /api/runs        [src/server.js]
        │
        ▼
Factory orchestration — src/factory.js  Factory.start() → plan → executionLoop → complete → deliver
        │   one `provider` + one `plannerProvider`, built once per run          factory.js:484-485
        │   token budget `track`, run time limit (default 120 min)               factory.js:486-495, 125
        │
        ├── Layer 1  runPlanner()  ── provider.chat()  (≤3 model calls)           agents.js:169-192
        │
        ├── executionLoop(): up to maxParallel (default 3) tasks at once          factory.js:599
        │     runTask(): up to maxAttempts (default 3) attempts per task          factory.js:625-
        │        │
        │        ▼  this.agentRunner(run)(…)   engine chosen per run             factory.js:381-385
        │   ┌────────────────────────────┬──────────────────────────────────────────┐
        │   │ engine "builtin" (default) │ engine "fx" (experimental, optional)     │
        │   │ runAgent()  agents.js:275  │ makeFxRunner()  engines/fx.js:17         │
        │   │ own loop, ≤ maxAgentTurns  │ @appport/fx createFxAgent loop           │
        │   │ provider.chat() per turn   │ createFxModel → OpenAI-compatible only   │
        │   └─────────────┬──────────────┴──────────────────┬───────────────────────┘
        │                 │ tool calls                       │ tool calls
        │                 ▼                                  ▼
        │            execTool(ws, …)  agents.js:330  → Workspace (src/sandbox.js)    ← SAME for both engines
        │                 list_files · read_file · write_file · run_command · complete_task
        │
        │   AGENCY / DECISION LAYER:  **none as a separate component.** Decisions (which tool, when to stop) are
        │   made by the model inside the loop; the *authority* over effects is the Workspace sandbox + factory gates.
        │
        ├── Verification  verifyTask() factory.js:692  → ws.runCommand(task.verify…), outputs-exist checks
        │      failure → Layer 6 feedback → next attempt (feedback text goes back into the brief)
        │
        └── complete()/completeExisting() factory.js:832 / 1130
              final verify commands · baseline classification · security scan · optional preview ·
              writeSummary() = 1 model call · checklist
        ▼
Evidence and delivery — src/evidence.js, src/deliver.js, src/publish.js (+ optional PAX in src/pax.js, never part of the verdict)
```

Missing / unclear boundaries, marked rather than filled in:

* **No agency layer.** There is no component that selects or governs actions apart from the loop itself. This is deliberate in the current design, see §4.
* **Planner and agent can use different providers** (`plannerProvider`, `factory.js:44-50`), but **all tasks of a run share one agent provider and model**; there is no per-task or per-role routing.
* **The `fx` engine bypasses `src/providers/*`.** It reads `baseUrl/model/apiKey` off the provider object (`engines/index.js:57-61`) and sends requests through FX's native client, so the retry, timeout, `num_ctx` and JSON-tool fallback behaviour of `src/providers/` does **not** apply to it (§3, §5).
* **Chat** (`src/chat.js:307-309, 417`) is a third inference call site. It is advisory, tool-less and separate from runs.

### 1.2 Inference call sites (complete list)

| # | Site | Calls | Provider used | Notes |
| --- | --- | --- | --- | --- |
| 1 | `runPlanner` `agents.js:178` | `provider.chat` ≤3 | planner provider, `plannerModel` | forced `submit_plan` tool, re-asks on invalid plan |
| 2 | `runAgent` `agents.js:283` | `provider.chat` once per turn, ≤ `maxAgentTurns` (default 40) | agent provider | builtin engine |
| 3 | `makeFxRunner` `engines/fx.js:28-70` | FX loop: ≤ `maxAgentTurns` model requests per prompt, ≤ `MAX_ROUNDS`(3)+malformed(≤4) prompts | agent provider, via FX | fx engine |
| 4 | `writeSummary` `agents.js:368` (called `factory.js:898, 1176`) | 1 | agent provider | feeds the checklist item `summary` |
| 5 | `ChatService` `chat.js:307, 417` | `chatStream` / `chat` | conversation's provider | not part of a run |
| 6 | `ProviderRegistry.test` `registry.js:270` | 1 | any | connectivity test only |

Plus discovery probes (`registry.js:181-198, 372-403`): `/models`, `/api/tags`, `/api/show` — no inference.

### 1.3 Direct Ollama coupling (all of it)

| Where | What | Required? |
| --- | --- | --- |
| `providers/registry.js:18` | `ollama` preset (127.0.0.1:11434, `OLLAMA_HOST`/`OLLAMA_BASE_URL`, `defaultNumCtx: 32768`) | One preset among 13 |
| `providers/registry.js:163-168` `pickDefault` | default provider = `FACTORY_PROVIDER` / remembered choice / **first ready non-offline preset**. Preset order is anthropic, openai, **ollama**, … so with no cloud key set and Ollama running, Ollama becomes the default | **Default only** |
| `factory.js:177` `remember()` | every run stores its provider/model as the next default (`providers.json`), so one Ollama run makes Ollama sticky | **Default only** |
| `providers/openai.js:66-76` | native `/api/chat`, `stream: false`, `num_ctx`, retries 2 | dialect for Ollama only |
| `providers/registry.js:328` | `numCtx` defaults to 32 768 for Ollama | Ollama only |
| `engines/index.js:57-61` | FX engine appends `/v1` for the `ollama` dialect | FX-on-Ollama only |
| `config.js:244-248` | `FACTORY_PROVIDER`, `FACTORY_MODEL`, `FACTORY_PLANNER_PROVIDER`, `FACTORY_PLANNER_MODEL` | selection, not coupling |
| `README.md`, `.env.example:13,19`, `src/cli/commands/system.js:182` | documentation / setup hints | docs |

**Conclusion (code-established):** nothing in the factory requires Ollama or any local inference. It *defaults* to it when no hosted provider is
configured and Ollama is reachable. Every provider is selectable per run (`provider`, `model`, `planner`, `engine`), by env, saved defaults, CLI
flags, and `PATCH /api/runs/<id>`.

---

## 2. Agent capability inventory

| Capability | Implemented? | Evidence |
| --- | --- | --- |
| Entry points | UI, CLI (client of one backend), HTTP API, task start | `server.js`, `src/cli/`, `server.js:918` |
| Plan → tasks DAG with roles | yes | `agents.js:81-131`, `graph.js` |
| Role briefs / prompts / lessons in context | yes | `agents.js:9-16, 237-269`, `prompt.js`, `factory.js:642 readLessons` |
| Context size bounds | planner context 16 000 chars; tool output 12 000 chars; FX instructions 60 000 chars; file reads 60 000 | `project.js:1010`, `agents.js:320`, `engines/fx.js:54` |
| Tools | `list_files read_file write_file run_command complete_task` | `agents.js:40-79`; effects only via `Workspace` (`sandbox.js`) |
| Policy / approval for tool calls | **No per-call approval.** Authority = sandbox path rules, secret-free env (`safeEnv`), command timeout 180 s, existing-project rules in the prompt; human approval exists at delivery/apply (`publish.js`, run review) | `sandbox.js`, `config.js:52`, `agents.js:29-36` |
| Model selection | per run: provider, model, planner provider/model, engine; options `numCtx`, `toolMode`, `maxTokens`, `temperature` | `factory.js:181-250`, `registry.js:307-330` |
| Retries | HTTP-level: 4 (OpenAI-compat / Anthropic), 2 (Ollama), on 408/409/425/429/5xx and `ECONNRESET/ETIMEDOUT/…`; task level: `maxAttempts` (3); planner: 3 | `http.js:161-165`, `openai.js:71`, `factory.js:625` |
| Timeouts | per HTTP request 30 min (OpenAI-compat/Ollama), 15 min (Anthropic); run limit 120 min; command 3 min | `openai.js:32`, `anthropic.js:17`, `factory.js:125`, `config.js:52` |
| Cancellation | `AbortSignal` through providers, tools and FX | `agents.js`, `http.js`, `engines/fx.js:29, 61` |
| Streaming | chat only (`chatStream`). **The agent loop does not stream** (`stream:false` for Ollama, no `stream` for OpenAI-compat) | `openai.js:67, 78`, `chat.js:307` |
| Concurrency | `maxParallel` tasks (default 3, max 8), all against the same endpoint | `factory.js:599, 121` |
| Token budget | `tokenBudget` 2 M, checked before each call | `factory.js:486-495`, `agents.js:394-399` |
| Deterministic mode | `offline` provider (template agents, no LLM) | `providers/offline.js`, `templates/offline-app/` |
| Fallback between providers | **none** (a failed call fails the attempt) | no code path; see §6 |
| Verification | per-task `verify` commands + `outputs` existence; final verify; baseline regression classification; security scan; checklist | `factory.js:692, 832-905, 1130-1180` |
| Evidence | `src/evidence.js`; PAX output kept separate (`run.pax`) | `evidence.js`, CLAUDE.md |
| Tests | `npm test` offline: `test/engines.test.js`, `test/providers.test.js` (mock Ollama/OpenAI servers), `test/anthropic.test.js`, `test/factory.test.js`; static `scripts/check.mjs`, `scripts/build.mjs` | `package.json:scripts` |

---

## 3. FX integration audit

### 3.1 What the published package provides (`@appport/fx@0.1.2`, `fx:README.md`, `fx:direct-agent.js`)

* Two distinct paths in `createFxAgent`:
  1. **Vercel AI Gateway** (default): string/object `model` or none; requires `apiKey`; runs the fx core (native addon or Wasm).
  2. **Direct model** (new in 0.1.2): `model` is a `createFxModel({ baseUrl, model, apiKeyEnv, toolChoiceMode })` handle; the loop is JavaScript (`fx:direct-agent.js`), the provider is the native OpenAI-compatible client.
* Direct path facts: streaming events; structured tool calls only; `maxSteps` (default 100) and `maxOutputTokens`; cancellation by signal; usage as `inputTokens/outputTokens/…`; `checkpoint()`; failures reject with `LIBFX_MODEL_FAILED` + `kind` (`rate_limited`, `server_error`, `malformed_tool_call`, …) or `LIBFX_MODEL_TIMEOUT / _CANCELLED / _CREDENTIAL_* / _REQUEST_FAILED`; **no `temperature`, `num_ctx`, timeout or retry option**; `http://` only for localhost; needs the native addon (no Wasm fallback for models); no image prompts; requires Node ≥ 20.
* `createFxModel()` alone is also a usable one-shot `chat()`/`stream()` client with no agent loop.
* Certification: `fx:CERTIFICATION.md` states the direct agent is verified at level 1 (scripted provider) only; **real-model quality was not run for that report**.

### 3.2 What da-prompt uses

`src/engines/fx.js` uses only: `createFxModel({ baseUrl, model, apiKeyEnv })` (`fx.js:28`), `createFxAgent({ model, tools, instructions, maxSteps })` (`fx.js:54`), `agent.prompt(…, { signal })`, event iteration (`text_delta`, `tool_start`), `turn.result` (`stopReason`, `usage`), `turn.cancel()`, `agent.close()`. Tools are da-prompt's own, executed through `execTool` (`fx.js:47`). The credential is passed as an env-var *name* (`fx.js:23-28`). This is the **public contract**; no internals are touched. It is loaded from `<data dir>/engines` (`engines/index.js:23-45`), so the repo keeps zero dependencies.

### 3.3 Supported vs implemented

| FX capability | Supported by FX | Used by the factory | Gap / note |
| --- | --- | --- | --- |
| OpenAI-compatible provider (Ollama `/v1`, vLLM, LM Studio, OpenAI, OpenRouter, Groq, …) | yes | yes (`fxEndpoint`) | Anthropic dialect refused (`engines/index.js:58`) — correct, FX has no Anthropic client |
| Vercel AI Gateway path (many models incl. Claude) | yes | **no** | would need `apiKey` as a JS string, which contradicts the "credentials only as env var names" rule in CLAUDE.md; unexplored |
| Tool calling | yes, structured only | yes | `malformed_tool_call` handled with ≤4 retries (`fx.js:81-86`) |
| Streaming | yes | consumed only to emit `agent.message` | no latency benefit for the factory itself |
| `maxOutputTokens` | yes | **no** — `FACTORY_MAX_OUTPUT_TOKENS` (default 8192) is ignored on the fx path | candidate fix, §7 |
| Timeout configuration | **no option** | n/a | **hardcoded in FX native code, see below** |
| Retries | none in the direct loop (`fx:README` "does not retry") | factory retries the whole *attempt* | a transport failure restarts the whole prompt |
| Usage | yes | yes → `track.add` | OK; `cache_*` and `reasoning_tokens` ignored |
| Ollama `num_ctx` | **no** (OpenAI-compat has no such field) | n/a | `/v1` uses the server's default context, **not** the 32 768 the built-in Ollama adapter sets. Effect on a given model is a §9 measurement |
| Checkpoint/resume | yes | no | `run.engine` is fixed per run, retries restart the prompt |

### 3.4 Provider failures and timeouts

* Errors are mapped to `FX model error (<kind|code>): …` and returned as `{ ok:false }`, which becomes a failed attempt with that text as feedback (`engines/fx.js:79-88`, `factory.js:~662`). Rate-limit and 5xx are not retried at transport level, only through the next *attempt* (a full re-run of the task).
* **Hard 120-second limit before the first response byte.** `3fx/src/gateway/openai_compatible_model_provider.zig:197-213`: connect 30 s, then `phase_deadline(120_000, …)` for `receiveHead`; on expiry the call fails with `error.Timeout` → `LIBFX_MODEL_TIMEOUT` (`napi_core_main.zig:1614`). Nothing in `napi_model_provider.zig` sets a longer caller deadline. After headers arrive the body has no total deadline in this file.
  * Consequence (**code-established**): any request whose time-to-first-response-header exceeds 120 s fails on the fx engine, regardless of the factory's 30-minute setting.
  * Whether an Ollama `/v1/chat/completions` stream sends headers only after prompt evaluation (so that a long CPU prompt hits the limit) is **not established from FX's code** and is a §9 measurement. The built-in adapter does not have this limit.

---

## 4. Chip capability and integration assessment

### 4.1 What Chip actually is (published `@appport/chip@0.54.5` and `rkendel1/eve` at `80c6e3d`)

* Same code, same version (`0.54.5`) in both. The README still says "The framework is called eve" (`chip:README.md`); the `chip` binary is an alias (`chip:package.json` `bin`). Repository field points at `vercel/eve`.
* It is **a framework for building and hosting agent services** as an authored directory (`agent/agent.ts`, `tools/`, `skills/`, `channels/`, `sandbox/`, `schedules/` …), compiled to `.eve/`, served through Nitro with its own HTTP protocol, durable sessions/workflow, human-in-the-loop approvals (`always() / once() / never() / policy`), its own sandbox backends, evals, subagents, telemetry. It needs **Node ≥ 24** and the AI SDK (`ai ^7`) as a peer.
* It is **not** an in-process "decision gate" library. `defineTool`/`approval` exist, but only inside a Chip agent running in Chip's harness; there is no documented API to ask Chip "may this action run?" from a foreign loop.
* **FX integration exists and is real:** `fx()` from `eve/models/fx` wraps a `createFxModel()` handle as the agent's model (`chip:docs/reference/typescript-api.md` "FX models"; changelog `13bf18d`). Text/reasoning stream, tool calls arrive whole, failures become `APICallError` with FX's `kind` and retry delay. You must set `modelContextWindowTokens`; unsupported settings (`temperature`, `topP`, …) are not sent. So **Chip sits above FX** for inference; Chip does not replace FX.
* **Vercel coupling (user stated "fully decoupled"; the evidence for 0.54.5 differs).** The package's own `docs/audit-chip-independence.md` says Chip "is not yet independent". In source: telemetry defaults to `https://telemetry.vercel.com/api/eve-cli/v1/events` (`eve:packages/eve/src/cli/telemetry/flush.ts:1`), opt-out via `EVE_TELEMETRY_DISABLED` or `chip telemetry disable`; gateway code remains in `src/internal/gateway.ts`, `src/setup/gateway-models.ts`; gateway-routed models need catalog metadata. Install/boot paths reach no Vercel host (that audit, §1), and the **FX model path does not use the gateway**. This audit records the 0.54.5 facts; a branch where the remaining items are removed was not provided.

### 4.2 Capability matrix

| Capability | Existing factory | FX | Chip | Gap or overlap |
| --- | --- | --- | --- | --- |
| Inference transport to OpenAI-compatible endpoints | yes (`src/providers/openai.js`) | yes (`createFxModel`) | via `fx()` or AI SDK providers | **Overlap** between the factory's providers and FX; the `fx` engine already chooses FX for transport |
| Anthropic transport | yes (`anthropic.js`) | no | AI SDK / gateway | FX cannot serve Claude directly (only via Gateway path) |
| Agent loop (model↔tools) | yes (`runAgent`) | yes (direct agent) | yes (own harness) | **Two loops already coexist**; a third (Chip) would duplicate |
| Tool execution authority | `execTool` over `Workspace` | host `execute` callbacks only | own tools + own sandbox (Docker/microsandbox/JS shell) | Chip's sandbox is a different execution authority from `Workspace`; would need a bridge |
| Per-action approval policy | none per call; gates are verification + delivery | none (host tools carry own authority) | yes (`approval: always/once/never/policy`, durable pause) | **Real gap in the factory** — but only matters for risky tools, and today the tool set is 4 sandboxed tools |
| Durable runs / resume after crash | partial (run state in `store.js`, `resume` of runs) | `checkpoint()` | yes (workflow durability) | **Overlap** with `store.js`; two state stores would diverge |
| Orchestration (DAG, parallelism) | yes (`graph.js`, `executionLoop`) | no | subagents/schedules | Overlap if Chip were used for orchestration (out of scope) |
| Verification / acceptance gates | yes, authoritative | no | evals (offline scoring), not delivery gating | factory must remain the authority |
| Evidence / delivery | yes | no | traces/telemetry | no overlap with factory evidence |
| Provider fallback | **none** | none | **unknown** (not documented for `fx()`; AI SDK has no built-in cross-provider fallback in the docs read) | do not assume |
| Timeout / retry knobs for local models | builtin: yes (30 min, retries) | **no**, hardcoded 120 s to first byte | `fx()` inherits FX's | FX limit is the blocker for slow local inference through FX/Chip |
| Streaming | chat only | yes | yes | not needed by factory loop |
| Usage metrics | yes (`track`) | yes | via AI SDK usage | equal |
| Telemetry to a third party | none | none observed | default-on to `telemetry.vercel.com` (0.54.5) | a data-handling decision before any adoption |
| Dependencies | zero runtime | optional, private install | Node ≥ 24, nitro, undici, `ai` peer | would break Node ≥ 20 / zero-dependency convention for any in-repo use |

### 4.3 Assessment

* The factory does **not** call a model without an agency layer by accident: its authority model is "model proposes tool calls, the sandbox constrains effects, deterministic verification decides". That is already implemented and tested (`test/sandbox.test.js`, `test/engines.test.js`).
* Chip **could govern actions** (approvals, durable pause) but only by hosting the agent loop *and tools* itself. That is a replacement of `runAgent`/`execTool`, not a seam: its tools would not touch `Workspace` without a bridge (the README already says this), it would add a second state store and a second execution authority, and it needs Node ≥ 24.
* **The one concrete gap Chip addresses — per-action approval — is not demonstrated as needed** by any current requirement. The brief asks not to add Chip to increase dependency count. **Recommendation: do not integrate Chip now.** Revisit if a requirement appears for human approval of individual high-risk tool calls (e.g. network or deploy tools), and then prefer a small factory-side approval hook over adopting a second harness.
* The minimal seam, if ever needed: a pre-execution policy callback inside `execTool` (`agents.js:330`), shared by both engines. That reuses existing authority boundaries and works with or without Chip.

---

## 5. Local inference bottleneck analysis

**Established by code:**

1. **No inference parallelism safety.** Up to `maxParallel`=3 tasks run concurrently against one endpoint (`factory.js:599`). On a single-GPU/CPU Ollama these requests queue or compete (Ollama's concurrency is its own setting). A local box thus does 3× the work at once → CPU saturation.
2. **Non-streaming, full-history resend per turn.** `runAgent` resends the entire message history each turn (`agents.js:281-326`); history grows with every tool result (up to 12 000 chars each). Prompt processing cost per turn grows with turns (≤40). On CPU, prompt evaluation dominates; there is no prompt caching on Ollama's native `/api/chat` path unless Ollama's own KV reuse applies (not verified).
3. **Large fixed context.** Ollama is asked for `num_ctx` 32 768 by default (`registry.js:18, 328`). A bigger context means a bigger KV cache and more memory/CPU even for short prompts. Whether this is the dominant cost is **not measured**.
4. **Amplifying retries.** (a) `requestWithRetry` retries `ETIMEDOUT` (`http.js:162`), up to 2× for Ollama: a 30-minute timeout could be spent three times before the attempt fails (worst case 90 min per call, bounded by the 120-min run limit). (b) A failed attempt repeats the *whole task* (3 attempts), re-sending full context. (c) On the fx engine, `malformed_tool_call` restarts the prompt up to 4 times (`engines/fx.js:14, 81`), each a full prompt evaluation; the README acknowledges qwen3-coder does this "often".
5. **Fixed per-run model calls.** Planner ≥1 (≤3), summary 1, plus every agent turn. The summary call (`agents.js:368`) summarises facts the factory already holds and feeds a checklist item that fails when the call fails (`factory.js:899`, `1177`). It is the one model call whose result does not influence any verification outcome.
6. **FX engine has no `num_ctx` and a fixed 120 s first-byte limit** (§3.4), the opposite trade-off from the builtin adapter.
7. **Planner can already be remote while agents are local** (`FACTORY_PLANNER_PROVIDER`, `factory.js:44-50`, `test/providers.test.js:145`): the factory already supports a hybrid at the planner/agent boundary.

**Not established (needs measurement, §9):** share of time in prompt evaluation vs generation vs tools vs model load; whether Ollama unloads/reloads models between calls (`keep_alive`); effective context used per call; how often retries fire; whether `/v1` streaming headers precede prompt evaluation.

**Does the factory require local inference?** No (§1.3). **Does anything prevent a remote endpoint?** No — all hosted presets exist in `PRESETS`, are selected through the same `ProviderRegistry.create()`, and are exercised offline by `test/providers.test.js:131` (full run through a mock OpenAI-compatible API with key) and `test/anthropic.test.js`.

**Deterministic checks that already avoid model calls** (kept): `exists` output checks, `verify` commands, baseline classification, security scan, preview health check — all are non-model and authoritative.

---

## 6. Execution-mode comparison

| | A. Local Ollama (today) | B. Another provider through existing registry (builtin engine) | C. Hybrid | D. FX engine with a hosted OpenAI-compatible endpoint | E. Chip-governed |
| --- | --- | --- | --- | --- | --- |
| Code changes | none | **none** | none for planner/agent split; per-task routing would be new | none | large: Chip project, tool bridge to `Workspace`, state sync, Node ≥ 24 |
| Reuse | everything | `ProviderRegistry`, 12 hosted presets, `AnthropicProvider`, `OpenAICompatProvider`, tests | `plannerProvider`, offline provider | `engines/fx.js`, `fxEndpoint` | `fx()` for model only |
| Blockers | CPU/latency (unmeasured) | needs a key/endpoint; **none verified** (no credentials in the audit environment) | per-task model choice not implemented | `https` required for non-localhost; no Anthropic; FX 120 s first-byte limit; FX path ignores `FACTORY_MAX_OUTPUT_TOKENS`; real-model quality uncertified | not demonstrated to be needed; telemetry default-on; second authority |
| Config / credentials | `OLLAMA_HOST` | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / … or Providers page (stored 0600 in `providers.json`, never returned to the browser: `registry.js:65-69, 134-153`) | both | key by env-var *name* only (`engines/fx.js:23-28`) | gateway/provider key owned by Chip |
| Data handling | prompts stay on the machine | repository content and tool output leave the machine to the provider; `redact()` applies to persisted/UI text, **not** to what is sent to the model | split: only planning inputs leave | same as B | same as B plus telemetry destination |
| Complexity | low | **lowest** | low–medium | low–medium | high |
| Correctness enforcement | unchanged | unchanged (verification is provider-independent) | unchanged | unchanged (same `execTool`, same verify) | would need to be re-proved |
| Test without Ollama | mock Ollama in `test/mock-llm.js` | mock OpenAI / Anthropic servers already used | `Scripted` providers | `cfg.engineModules` fake (`test/engines.test.js`) | n/a |

Fallback: **no mode provides automatic fallback between providers.** Neither the factory nor (per available docs) FX/Chip is shown to do this; do not assume it.

---

## 7. Recommended minimal implementation plan

Principle: use what exists first. Ordered; each item stands alone.

**Step 0 — no code (answers "make it usable without Ollama today").** Configure a hosted provider and select it explicitly:
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (or any preset key) and `FACTORY_PROVIDER=<id>` (or `da-prompt providers use <id> --model <m>`; or `--provider`/`--model` per run). Keep `FACTORY_AGENT_ENGINE=builtin`. For a partial move, keep Ollama for agents and set `FACTORY_PLANNER_PROVIDER` to a hosted provider (already tested). This needs no change and no new dependency. *Not verified end to end here: no credentials were available.*

**Step 1 — fix assumptions that unnecessarily force local inference** (small, in `src/providers/registry.js`):
1. `pickDefault()` prefers a hosted provider over a local one only by preset order (anthropic, openai before ollama), which is already correct when a key is present. The stickiness comes from `remember()` (`factory.js:177`). Proposed: surface *why* a provider is the default (the Providers page and `da-prompt providers` already list defaults; add "default source: saved choice / env / first ready"), and do not change the selection rule. *Small UX/diagnostic change; no behaviour change.* Decision needed before doing it.
2. Nothing else in the factory forces Ollama; do not touch.

**Step 2 — use FX correctly where it is already used** (`src/engines/fx.js`, 1-2 lines each):
1. Pass `maxOutputTokens: cfg.maxOutputTokens` to `createFxAgent` (FX supports it, `fx:direct-agent.js:73`) so the fx path honours `FACTORY_MAX_OUTPUT_TOKENS` like the builtin path. `makeFxRunner(cfg)` already receives `cfg`.
2. Map `LIBFX_MODEL_TIMEOUT` to a clear message that names the 120 s first-byte limit and suggests the builtin engine for slow local models (`fx.js:87`). Error-text only.
3. Document in README that the fx engine has a 120 s first-byte limit and no `num_ctx` (§8).
Each needs a test in `test/engines.test.js` using the existing fake FX (assert `maxOutputTokens` on the created agent; assert the timeout message).

**Step 3 — optional, only with a stated requirement: remove a non-verifying model call.** `writeSummary` is descriptive. A deterministic fallback summary (built from the same `facts` object, `agents.js:369-375`) would let the `summary` checklist item pass without a model when the call fails or on a metered provider. This changes what "summary provided" means, so it needs an explicit decision; it does not alter any verification item.

**Explicitly unnecessary / not recommended:**
* Adding `@appport/chip` as a dependency or engine (no demonstrated gap; Node ≥ 24; second harness and sandbox; default-on telemetry).
* A new provider abstraction, a "router", or direct provider calls from the FX engine (the registry already is the abstraction; FX is already the transport for the fx engine).
* Per-task model routing, provider fallback, caching layers, prompt compaction, reducing `num_ctx` defaults or `maxParallel`, skipping verification, or weakening any gate — **no benchmark exists to justify any of them**; collect §9 first.
* Replacing the builtin engine with FX.

**Dependencies:** none in this repository (`package.json` unchanged). `@appport/fx@0.1.2` stays an optional private install (`scripts/install-engine.mjs`); pin it in the install script only if reproducibility is wanted.

**Tests / invariants to keep or add:** `npm run validate` must stay green; keep `test/engines.test.js` (credentials only as env var name, sandbox unchanged, verification decides); add the Step 2 tests; invariant: *the provider/engine used never changes the verdict logic* — verification code paths (`verifyTask`, `completeExisting`) take no provider argument except `writeSummary`.

**Migration / rollback:** Step 0 is configuration (rollback: reset `FACTORY_PROVIDER` / `providers use`). Steps 1-3 are additive and default-preserving; rollback is reverting the commit. Runs keep their recorded `engine`, `provider` and `model`, so in-flight runs are unaffected.

**Acceptance criteria:**
* A run completes end to end through a hosted-style provider with Ollama absent (existing mock test `providers.test.js:131` passes; add one real-endpoint smoke run by the operator).
* `FACTORY_MAX_OUTPUT_TOKENS` is visible in the FX agent options (test).
* No change to verification, checklist, or sandbox tests.
* §9 measurements collected before any performance claim is made.

---

## 8. Documentation findings (recommend, not applied)

| Document | Finding | Recommended correction |
| --- | --- | --- |
| `README.md` "No timeouts on slow hardware … up to 30 minutes per call" (Running with Ollama) | True for the built-in adapters; **false for the fx engine** (120 s to first response byte, `3fx:src/gateway/openai_compatible_model_provider.zig:197-213`) | Add: "The fx engine gives a model 120 s to start answering and cannot set `num_ctx`; use the built-in engine for slow local models." |
| `README.md` "Agent engines" paragraph on Chip | Accurate on Node ≥ 24 and no bridge; omits that 0.54.5 telemetry is default-on to `telemetry.vercel.com`, that the package is the eve framework under another name, and that `chip` already uses `fx` via `eve/models/fx` (that last point is present) | Add the telemetry and Node ≥ 24 facts with the package version |
| `README.md` / `src/settings.js:149` help text for `defaultEngine` | says fx works with "OpenAI-compatible endpoints and Ollama"; does not say `https` is required off-localhost | Add one clause |
| `README.md` "Running with Ollama" | does not say the default provider falls back to Ollama when no key is set or a previous run chose it (`registry.js:163`, `factory.js:177`) | Add one sentence |
| `docs/selfhost/*` | historic transcripts (scripted model); not obsolete, but not evidence of real-model performance | label as such (the README of that folder already does) |

No document was found to be duplicated or obsolete beyond the above.

---

## 9. Unresolved questions and measurements to collect

Runtime measurements (require the operator's machine; none were taken):

1. Per-call time split (prompt evaluation vs generation) and tokens/s for the target model on the target hardware: `ollama run <m> --verbose`, or `prompt_eval_duration`/`eval_duration` from `/api/chat` (the builtin adapter already receives `prompt_eval_count`/`eval_count`; durations are discarded: `openai.js:72-76`).
2. Ollama model residency (`keep_alive`, `ollama ps`) across consecutive calls: is the model reloaded?
3. CPU/RAM with `maxParallel` = 1 vs 3, and `num_ctx` 8k vs 32k, for the same run (change one variable at a time).
4. Typical prompt size per turn (`run.usage.input / run.usage.calls`) and turns per task — available from existing run records.
5. Frequency of retries: `ETIMEDOUT` retries, failed attempts per task, `malformed_tool_call` per task on the fx engine.
6. Whether Ollama's `/v1/chat/completions` (stream) emits response headers before or after prompt evaluation (decides whether the FX 120 s limit bites on CPU).
7. A hosted-provider end-to-end run of a small idea (cost, wall-clock, attempts) to compare against the local baseline.

Open questions:

* Which Chip commit, if any, has the remaining Vercel couplings removed? 0.54.5 (npm and `rkendel1/eve`) still has default telemetry and gateway code.
* Is a per-action approval requirement real? That is the only thing that would justify revisiting Chip.
* Does Chip document or implement provider fallback with `fx()`? Not found; marked unknown.
* FX's real-model quality for tool use is uncertified (`fx:CERTIFICATION.md` level 2 "not run").
* Does any consumer rely on `remember()` stickiness (Step 1)?

---

## 10. Evidence index

| Conclusion | Source |
| --- | --- |
| Factory does not require Ollama; defaults to it only when nothing else is ready or saved | `src/providers/registry.js:15-30, 163-168`; `src/factory.js:177, 181-212` |
| All inference call sites | `src/agents.js:178, 283, 368`; `src/engines/fx.js:28-70`; `src/chat.js:307, 417`; `src/providers/registry.js:279` |
| One shared agent provider per run; separate planner provider | `src/factory.js:39-50, 484-485` |
| Ollama adapter: non-streaming, `num_ctx`, 2 retries, 30-min timeout | `src/providers/openai.js:32, 66-76` |
| Retry set includes `ETIMEDOUT` | `src/providers/http.js:161-165` |
| FX engine uses only public FX API; env-var-name credentials | `src/engines/fx.js:23-28, 54`; `fx:README.md` "Local and direct providers" |
| FX engine refuses Anthropic; appends `/v1` for Ollama | `src/engines/index.js:57-61` |
| FX engine ignores `maxOutputTokens` setting | `src/engines/fx.js:54` vs `src/config.js:42`; FX option `fx:direct-agent.js:73` |
| FX has no timeout/retry/`num_ctx` options; `createFxModel` options | `fx:node.js:733-745`; `fx:README.md` options table |
| FX 120 s first-byte limit, 30 s connect | `3fx:src/gateway/openai_compatible_model_provider.zig:197-213`; error mapping `3fx:src/napi_core_main.zig:1614` |
| FX direct-agent loop, `LIBFX_MODEL_FAILED`, no retry | `fx:direct-agent.js:113-184`; `fx:README.md` |
| FX direct path certified at scripted level only | `3fx:sdk/CERTIFICATION.md` "Verification levels" |
| Chip is the eve framework, Node ≥ 24, AI SDK peer | `chip:package.json`; `chip:README.md`; `eve:packages/eve/package.json` (v0.54.5) |
| Chip `fx()` model adapter | `chip:docs/reference/typescript-api.md` "FX models"; `chip:CHANGELOG.md` 0.54.4 `13bf18d` |
| Chip not yet independent of Vercel (0.54.5) | `chip:docs/audit-chip-independence.md` §1; `eve:packages/eve/src/cli/telemetry/flush.ts:1`; `eve:packages/eve/src/internal/gateway.ts` |
| Chip approvals exist only inside the Chip harness | `chip:docs/tools/human-in-the-loop.md` |
| Verification is provider-independent and authoritative | `src/factory.js` `verifyTask`, `completeExisting`, `complete` |
| Offline tests of alternative providers and FX | `test/providers.test.js:102-170`, `test/engines.test.js`, `test/mock-llm.js` |
| Summary call feeds a checklist item | `src/factory.js:898-899, 1176-1177` |
| Credentials never returned to the browser | `src/providers/registry.js:65-69, 134-153` |

Reproduce the package facts: `npm view @appport/fx @appport/chip`, `npm pack` each, read `README.md`, `direct-agent.js`, `CHANGELOG.md`, `docs/`.
