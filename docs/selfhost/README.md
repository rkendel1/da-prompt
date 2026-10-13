# Self-hosting demonstration: da-prompt changing da-prompt, from the terminal

This directory records a **real execution** of the CLI on this repository, with its real transcript, including the two
earlier attempts that did not go cleanly.

## Read this first: what was real and what was a stand-in

| | |
| --- | --- |
| **Real** | The CLI (`src/cli.js`), the backend it started, the planner/agent loop, the tool sandbox, the factory's baseline and final verification (it ran the repository's own `npm test`, `npm run lint`, `npm run build` — the whole suite, twice, inside the run), the evidence aggregation, the diff, the approval bound to the exact patch, the explicit `apply`, and the independent validation afterwards with plain npm. The code change itself is committed on this branch as its own commit (`redact(): also mask Bearer tokens and x-api-key header values`). |
| **Stand-in** | **The model.** No real model credentials exist in the environment this was produced in, so [`scripted-model.mjs`](scripted-model.mjs) — a small OpenAI-compatible server — played the model: it returns a fixed plan, reads `src/security.js` through the agent's real `read_file` tool, applies one known edit to the file content it was given, writes `test/redact.test.js`, runs the tests through the real `run_command` tool and reports. It demonstrates that the *workflow* completes a real source + test change end to end; it does **not** demonstrate that a language model can produce this change. The change is small enough that a model is expected to manage it, but that was not measured. |
| **Approval** | `runs review approve` was typed by the operator of this session (an AI assistant), after reading the diff in the transcript. No separate human reviewed it before it was applied; the human review is the pull request. |

## The task

> Make `redact()` in `src/security.js` also mask `"Bearer <token>"` and `"x-api-key"` header values.
> Acceptance: `redact("Authorization: Bearer abcdefghijklmnop1234567890")` returns `"Authorization: Bearer ***"`;
> `redact("x-api-key: abcdef1234567890zzzz")` returns `"x-api-key: ***"`; every existing redaction is unchanged; a new
> `test/redact.test.js` covers both cases and `node --test test/redact.test.js` passes.

A real gap: `redact()` is what keeps credentials out of logs, reports, errors and `--json` output, and it did not know
about those two shapes (`redact('Authorization: Bearer …')` returned the token unchanged before this change).

## What ran (final attempt — [`transcript.txt`](transcript.txt), run `202610130252-3184a1`)

`run.sh` drives only `da-prompt …` commands (plus `git` and `npm` for the independent steps):

1. `git clone` of the repository into the only folder the backend is authorized to read (`config set projectRoots`).
2. `server start`, `config set commandTimeoutMs 900000`, `providers add/test/use` (connectivity ✓ discovery ✓ inference ✓),
   `projects list/use <path>` (the path is mapped to an opaque id by the backend), `doctor`.
3. `run "<task>" --attempts 2` → planning → **baseline** (`npm test` passed in ~5 min, `lint`, `build` passed) → one task
   (1 attempt) → final verification (the task's checks, `scripts/check.mjs`, `npm test`, `lint`, `build` all passed) →
   *verified*.
4. `runs list/tasks/files/diff/tests/evidence`. The diff is two `.replace(...)` lines in `src/security.js` and a 27-line
   `test/redact.test.js`. `runs evidence` prints **agent claims**, **factory verification** and **PAX observation** as
   separate sections (PAX was not requested for this run).
5. Working tree check (`git status` clean), then `runs apply --yes` → **exit 4, not approved**; `runs review … approve`;
   `runs apply` without `--yes` → **exit 2** (non-interactive); `runs apply --yes` → applied: `src/security.js` modified,
   `test/redact.test.js` added, nothing staged or committed.
6. Independent validation with plain npm (no da-prompt): `npm run check` and `node --test test/redact.test.js test/sandbox.test.js`
   pass. (The whole suite was run by the factory itself — twice — and by me directly; results are in the PR description.)
7. `server stop`; `server status` → not running (exit 3), no orphan process.

The result was committed with ordinary git in the clone and brought onto this branch with `git cherry-pick`.

## Failures, retries and manual interventions (all of them)

| # | What happened | What I did |
| --- | --- | --- |
| 1 | [`transcript-attempt-1.txt`](transcript-attempt-1.txt): `providers test` and `providers use` **failed** — the stand-in did not answer the provider health probe (a request to call `report_status`), so the CLI correctly refused to make it the default (exit 1, nothing saved). | Fixed the **stand-in** (answers the probe like a real model does). Not a CLI bug. |
| 1 | Same attempt: the baseline `npm test` **timed out** at the factory's default 3-minute per-command limit; the suite takes ~5 minutes. The run still completed, verdict "verified, pre-existing failures remain", and `runs tests` drew the timed-out check with a green ✓. | `config set commandTimeoutMs 900000` (a documented setting) in `run.sh`; fixed `runs tests` to draw pre-existing/not-runnable checks with `!` and an explanation. |
| 2 | [`transcript-attempt-2.txt`](transcript-attempt-2.txt): the baseline `npm test` **failed (exit 1)** inside the factory although the same suite passes when run directly (178 passed, 1 skipped, 0 failed). | Reproduced with `HOST=127.0.0.1 PORT=39999 FACTORY_DATA_DIR=… DA_PROMPT_CONFIG_DIR=… npm test` → `health.test.js` "first run: nothing is configured…" fails. Root cause: the backend's own environment (`HOST`, `PORT`, `FACTORY_*`) is inherited by the commands agents run (that is by design: they are not secrets), and the suite was not hermetic. This is the exact situation a daily CLI user is in. **Fix (narrowest):** `test/setup-env.cjs`, preloaded by `npm test`, drops those variables; `test/hermetic.test.js` proves a leaky environment no longer changes the result. |
| 3 | Final attempt: baseline 3/3 passed, final all passed, 1 attempt, no retries or escalations inside the factory. | — |

Because fixing 1–2 changed the repository, the final run was made from a clean clone of the commit containing the fixes,
so the baseline that the verdict compares against is the code that was actually shipped. The self-hosted change is its own
commit on top.

## Reproduce

```bash
docs/selfhost/run.sh /tmp/selfhost-demo > /tmp/selfhost-demo.txt     # ~11 minutes: it runs the whole suite twice inside the factory
docs/selfhost/pax-validation.sh <work-dir>                           # real pax binary: set PAX_DIR to the directory containing it
```

[`pax-transcript.txt`](pax-transcript.txt) is the second script run against a **real** `pax` 0.5.0 built from
`rkendel1/pax` at `31b4871`: `pax status` (found on the backend's PATH, version, capabilities, which environment was
inspected), `pax verify` on a run (info/doctor/reality/graph observed, drift reported as a *finding*, the dry-run test
plan failing because PAX could not detect a native tool for that toy project — reported as a step error, exit 1),
`pax evidence` (kept apart from the factory verdict), `pax probe` of the real binary and of `/bin/ls` (reported as not PAX).
