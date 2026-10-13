# Embedded terminal: manual acceptance record

`acceptance.mjs` drives the real Terminal page (real Chromium, real keyboard events) against a real backend with the real
da-prompt repository as the project, and writes a PASS/FAIL line per step plus screenshots (`screens/`). A step only passes
if its observable outcome was checked (the output text, exit codes, process liveness via the OS, session lists from the API).

```bash
NODE_PATH=$(npm root -g) node docs/terminal/acceptance.mjs <parent-of-the-repo> [dir-containing-a-real-pax]   # ~10 minutes: step 4 runs the whole suite
```

* [`acceptance-transcript.md`](acceptance-transcript.md) — the final run: **11/11 steps passed** (Linux, Node 22, bash).
* Earlier runs, kept because they found real problems (none of them in the terminal itself):
  * [attempt 1](acceptance-transcript-attempt-1.md): `npm test` run *inside the terminal* failed 4 tests because a real `pax` was on PATH (two health tests and two UI tests assume "pax is not installed"). The suite was not hermetic for developers who have PAX installed — exactly this user. Fixed in `test/setup-env.cjs` (hides any `pax` from PATH, keeps it for the opt-in smoke test) + `test/hermetic.test.js`.
  * [attempt 2](acceptance-transcript-attempt-2.md): 1 failure in `ops-ui` — a race in an existing UI test (the PAX form is disabled while the backend still counts a finished run as executing). The test now waits for the form.
  * [attempt 3](acceptance-transcript-attempt-3.md): `npm test` passed (219/219); step 7 timed out once without a diagnostic. Cause not established; the script now waits until the process it is about to interrupt actually exists and prints the last screen lines on failure. The next run passed.

Not run here: macOS (see the README's "Embedded terminal → Limitations").
