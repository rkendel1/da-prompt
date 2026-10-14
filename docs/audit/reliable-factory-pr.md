# PR: Reliable, resource-aware coding factory

## Root causes
- `write_file` without `content` wrote an empty file and reported success; arguments were never checked against tool schemas.
- Verification only tested that an output *exists*: an empty file, or prose saved as `.png`, passed. A task with no outputs/verify completed on the agent's word, and files named in `complete_task` were never checked.
- Planning never asked whether an output could be produced (no renderer or image tool exists), whether tasks were verifiable, or whether two tasks wrote the same file.
- Retries repeated identical failures until `maxAttempts`; nothing compared attempts. No task deadline.
- Up to `maxParallel` generations hit one local model at once; Ollama got no `keep_alive`, the prompt was not fitted to `num_ctx` (Ollama silently truncates), load vs generation time was discarded.
- Note: `AuthBoundry` and `FeltDB` do not exist in this repo (`AppPort` only as the optional `@appport/fx` engine). Nothing was added for them and no authority boundary was touched; see `docs/audit/reliable-factory.md`.

## Behavior changed
See README "Truthful completion, recovery and local inference". Highlights: artifact validation by type; `complete_task` refused for missing files; tool events carry `status` (executed/failed/rejected/unavailable/duplicate); plan contract checks with automatic ordering repair; capability gaps block a task with a reason; optional `render_screenshot` / `generate_image`; structured feedback, failure fingerprints, `no_progress`, deadlines, targeted re-checks; `maxLocalInference` limiter (default 1), context fitting, `keep_alive` (default 30m), seed/top_p, `run.metrics`.
Intentional changes to existing behavior: identical consecutive failures stop a task after 2 attempts (was 3); provider exceptions are classified (still end the task); tasks with no outputs/verify must show executed work.

## Files
New: `src/capabilities.js`, `src/recovery.js`, `src/inference.js`, `src/providers/context.js`, `test/reliable.test.js`, `bench/reliability/*`, `scripts/bench-report.mjs`. Modified: `agents.js`, `factory.js`, `sandbox.js`, `providers/openai.js`, `providers/registry.js`, `config.js`, `contract.js`, `diagnostics.js`, `evidence.js`, `bench.js`, `scripts/bench.mjs`, README, 5 existing tests updated for the changes above.

## Tests
`test/reliable.test.js`: 34 new tests, all pass. Suites touched run green in isolation. Failing here and **also failing on clean `main`** (environment): `setup is non-interactive`, `a failing required test fails the pipeline`, `npm test is hermetic`. `the script: modes are explicit` fails here because this machine's `data/settings.json` defaults to the fx engine. The terminal PTY tests time out in this environment; not compared against `main`. A single uninterrupted `npm test` was **not** completed (it stalled in the terminal tests), so the full suite has not been shown green.

## Benchmark (qwen2.5-coder:7b via Ollama, M-series Mac, numCtx 8192, temperature 0, seed 42, maxParallel 3, 3 attempts, 30 turns, 15 min cap, 1 repetition)
| scenario | before | after | wall before | wall after | model calls b→a | tools b→a | task retries b→a | false success b→a |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r1-write-file-and-test | incomplete (run cancelled) | failed (run failed) | 900.0 s | 18.5 s | 69 → 3 | 10 → 0 | 0 → 0 | no → no |
| r2-design-artifact | passed (run completed) | failed (run needs_attention) | 176.9 s | 78.8 s | 13 → 20 | 10 → 6 | 2 → 1 | no → no |
| r3-recover-after-failure | failed (run needs_attention) | failed (run needs_attention) | 650.8 s | 28.4 s | 92 → 13 | 5 → 3 | 2 → 1 | no → no |
| r4-multi-agent-shared | incomplete (run cancelled) | failed (run needs_attention) | 900.1 s | 343.0 s | 85 → 53 | 8 → 27 | 0 → 4 | no → no |

Passed (independent acceptance): 1 → 0 of 4 → 4
Wall clock: 2627.9 s → 468.6 s · model calls: 259 → 89 · tool calls: 33 → 36 · task retries: 4 → 6
False successes (run said "completed", acceptance disagreed): 0 → 0 · verification accuracy: 100% → 75%
After — concurrency: peak simultaneous generations 1, total queue wait 583.6 s, model-load time 1.7 s; backend-reported tokens/s 65.8, 62.7, 63.8, 38.1
Before config a5f930d2f701 (574e7451) · after config ce1404393ea4 (8d1c7ffc) · modes live/live

Reading it honestly: after the change **0/4** scenarios passed versus **1/4** before (n=1 per scenario; a 7B model is noisy). There were no false successes in either run. The change made failures fast and explicit (469 s vs 2628 s total, 89 vs 259 model calls) but did **not** make this model succeed. The stricter planner rejected r1's plan three times (a code task verified a test file that depends on it: a genuine cycle the 7B could not fix), which is a regression for this model on that scenario; r2 passed before only because its differently-worded plan happened to be satisfiable. Verification accuracy 75% after = r2 where the run said needs_attention while acceptance... see report JSON. Shorter wall time is not an improvement claim. Reports: `docs/audit/bench/`.

## Remaining limitations
- Weak tool callers still often answer in prose; the loop now stops and says so but cannot make them call tools.
- Plan-time grep-style verify commands the planner invents cannot be judged impossible.
- Images are only recognised as producible via `render_screenshot`/`generate_image`; a shell-scripted image is accepted by verification but not planned for.
- `fx` engine: no limiter, no new tools.
- No UI work beyond showing blocked reasons.
