# Audit: reliable, resource-aware factory (baseline before the change)

Branch `claude/reliable-resource-aware-factory`, from `main` at `574e745`. Working tree was clean. Instructions read: `CLAUDE.md`.

## Execution path as found

| Stage | Where | What actually happens |
| --- | --- | --- |
| Run creation | `Factory.createRun` (`src/factory.js`) | Validates source, provider/model/engine, clamps `settings` (`maxParallel` 3, `maxAttempts` 3, `maxAgentTurns` 40, `tokenBudget`, `timeoutMinutes` 120). Persists `run.json`. |
| Planning | `runPlanner` (`src/agents.js`) | Up to 3 `submit_plan` calls, validated by `validatePlan` (`src/graph.js`): ids, roles, cycles, **non-empty `acceptance`**. Nothing checks that outputs can be produced, that tasks are verifiable, or that two tasks do not write the same file. |
| Scheduling | `executionLoop` | `readyTasks` (all dependencies `completed`/`skipped`) up to `maxParallel` at once. No output-conflict control. |
| Agent loop | `runAgent` | Non-streaming `provider.chat` per turn, 5 tools (`list_files`, `read_file`, `write_file`, `run_command`, `complete_task`). Every tool result is capped at 12 000 characters; the history is resent whole every turn. `complete_task` is accepted without looking at what it claims. |
| Tools | `execTool` | Arguments are not checked against the schemas. `write_file` with no `content` wrote an **empty file and reported success** (`String(content ?? '')`). |
| Verification | `Factory.verifyTask` | `outputs` only checked with `exists` (an empty file, or a text file named `.png`, passes); glob outputs skipped; claimed files never checked; a task with no `verify` and no `outputs` verified **nothing** and completed on the agent's word. |
| Retry | `runTask` | Up to `maxAttempts`, feedback is the raw failing command + output. Nothing compares attempts, so identical failures repeat to the limit. A thrown provider error escalates the task at once. No per-task deadline. |
| Terminal states | `escalated` (needs a person), `blocked` (dependency), `cancelled`; the run ends `completed` / `needs_attention` / `failed` / `cancelled`. |
| Evidence | `diagnostics.jsonl` (per model call), run events, `buildEvidence` (`src/evidence.js`): claims and factory checks already kept apart. No run-level metrics; no inference timing split. |

## Local inference as found

Ollama dialect (`src/providers/openai.js`): `POST /api/chat`, `stream:false`, `options.num_predict = maxOutputTokens` (8192), `options.num_ctx = numCtx` (**32768 default**, per run via `providerOptions.numCtx`), optional `temperature`. No `keep_alive` (server default 5 min, so a model can unload between slow tasks), no `seed`/`top_p`. Request timeout 30 min fixed, 2 transport retries fixed. **Concurrency:** none beyond `maxParallel` (3 by default) — three agents can send three generations to one local model at once. Prompt size is not bounded relative to `num_ctx`; Ollama silently drops the start of an over-long prompt. Backend timings (`load_duration`, `eval_duration`) were discarded.

## Tools genuinely available to an agent

`list_files`, `read_file`, `write_file` (**text only**), `run_command` (`sh -c` in the sandboxed workspace, optionally in Compute), `complete_task`. There is **no** image generation, **no** renderer and no browser tool. A browser exists on a developer machine, but nothing in the factory could drive it.

## Reproduction (replay harness, scripted model, real factory)

Run against `main` before any change:

| Scenario | Result on `main` |
| --- | --- |
| Design task requires `public/images/reading-list.png`; the model answers in prose three times | 3 attempts, all failed identically; run `needs_attention` (same shape as the 7B run: minutes of repeats) |
| Task requires `REPORT.md`; the agent writes it **empty** and claims success | Task **completed**, run `completed` |
| Task has no outputs/verify; the agent calls `complete_task` naming `nothing.js` (does not exist) | Task **completed**, run `completed` |

These became tests in `test/reliable.test.js`.

## Requirements in the brief that do not match this repository

* **AuthBoundry and FeltDB do not exist here.** `grep -ri authboundry\|feltdb` finds nothing in code or docs. "AppPort" appears only as the optional `@appport/fx` agent engine (and mentions of `@appport/chip` / `@appport/github` in the README). The factory's actual authority boundaries are `Workspace` (all agent file/command access), `existingProjectPolicy`, `registry.locate()`, `terminalGuard`, `redact()` / `hideSecrets()`. This change touches none of them, adds no store, and routes every new tool through `Workspace`. Nothing was invented to stand in for the missing components.
* The repository has no tenant concept beyond the project registry and run store; tenant isolation here means those.

## Smallest coherent change set

1. Truthful completion: confirm writes on disk, validate tool arguments, refuse unproven `complete_task`, validate artifacts by type, check claims, require executed work when nothing else can be checked (`sandbox.js`, `agents.js`, `capabilities.js`, `factory.js`).
2. Executable specs: contract checks in the planner loop, capability gaps block the task, runtime write-set lock (`capabilities.js`, `agents.js`, `factory.js`).
3. Real artifact tools, optional and capability-driven (`render_screenshot`, `generate_image`).
4. Recovery policy: structured feedback, failure fingerprints, categories, deadline, targeted re-checks (`recovery.js`, `factory.js`).
5. Inference: limiter, context fitting, Ollama options and timings (`inference.js`, `providers/context.js`, `providers/openai.js`, `config.js`, `contract.js`).
6. Evidence and benchmark: `run.metrics`, per-call `inference`, reliability scenarios under `bench/reliability`.
