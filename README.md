# da-prompt — a software factory

Turn an idea into a working, tested, deployed application. da-prompt runs the
"software factory" operating prompt as a real workflow: a planner writes a task
graph, specialized agents build it in parallel against a real workspace, every
step is verified by running code, failures loop back with the actual error, and
the run ends with a completion checklist, a live deployment and a downloadable
project.

```
idea ─▶ 1 PLAN ─▶ 2 AGENTS ─▶ 3 EXECUTION ─▶ 4 ARTIFACTS ─▶ 5 VERIFICATION ─▶ 6 FEEDBACK ─▶ 7 COMPLETION ─▶ deliver
         task      product      parallel       files,         run each          retry ×3,       full tests,
         graph     engineer     subgraphs      commands,      task's checks     escalate,       security, deploy,
         (DAG)     design, qa   per task       logs           before moving on  CLAUDE.md       docs, summary
                   devops, research
```

## Quick start

```bash
git clone https://github.com/rkendel1/da-prompt.git
cd da-prompt
npm start                     # http://localhost:3000 — no install step, zero dependencies
```

Open the app, describe an idea, pick a provider and model, and press **Start the factory**.
The provider and model lists fill themselves from what you have: any provider with a key
configured, and any local server that is running right now.

Requires Node.js 20 or newer.

## Using da-prompt from the browser

Everything routine is done in the web UI; no editor, terminal or CLI is needed after the server is running.

| Where | What you do there |
| --- | --- |
| **New run** (`#/`) | Pick a project (new, authorized local folder, GitHub repo), describe the change, choose models, review the *"what this run may do"* summary, start. |
| **Run view** | Follow the seven layers and the Connect/Inspect/Baseline stages live (it reconnects by itself after a refresh or a network blip), cancel, resume, retry/skip escalated tasks. Tabs: Overview, Task graph, Activity, Files (changed files + diff), **Evidence**, Delivery. |
| **History** (`#/history`) | Every run on record, searchable by task, project, id, model; filter by status, project type and verification. |
| **Setup & health** (`#/setup`) | First-run checklist and ongoing health. Every line is a real probe, with what was observed and the next step. |
| **Settings** (`#/settings`) | The supported configuration, saved on the server, with the source of each value. |
| **PAX** (`#/pax`) | Where PAX was found, its version, what this install can do, and what its evidence means. |
| **Providers** (`#/providers`) | Provider URLs/keys, model discovery, connection tests. |

### Launching it

Start the server once (`npm start`, or the Docker image) and open `http://localhost:3000`. That one start is the only
host-level step: a browser cannot start, install or restart the program on your machine. Everything below happens in the UI.

### First-run setup (in the browser)

1. Open the app. If something blocks real work, **New run** shows *"Finish setup before your first run"* and the sidebar dot is red.
2. **Setup & health** runs real checks: the backend, the data folder (a real write), model providers (a real call to each),
   the default model (is it actually offered?), the delivery folder, project folders (read/write access), `git --version`,
   the GitHub API (a real `GET /user` with your token), PAX (`pax --version` / `--help`) and access protection. Each problem says
   *what was observed*, *what to do*, and gives a button when the UI can do it, or marks it **host-level** when only the
   machine's owner can (installing git or PAX, file permissions, restarting the process).
3. **Providers**: add a key or point at a local server (Ollama, LM Studio, …); the page tests the connection and lists the models
   the provider really offers. Provider keys are write-only.
4. **Settings → Models**: choose the default provider and model (the model list is the provider's own), and optionally a separate
   planner provider/model.
5. **Settings → Folders and projects**: authorize the folder(s) that contain your projects.
6. **Settings → GitHub**: paste a token to clone private repos and publish; **Settings → Server**: set an access password.
7. Re-check on **Setup & health**, then start a run.

### Persistent settings and precedence

Settings the UI saves live in `<data dir>/settings.json` (mode `0600`, written atomically, never sent to the browser, never in
logs). Every setting is a field the server genuinely reads; nothing is invented for the page. Precedence, highest first:

1. **Run-specific option** (the New Run form / API body) — for example attempts, parallelism, token budget, PAX on/off.
2. **Startup option** (programmatic overrides; fixed while the server runs).
3. **Saved in the UI**.
4. **Environment variable**.
5. **Built-in default**.

The UI shows the effective value, which of these supplied it, and — when the environment *also* sets it — that the saved value
wins. **Reset** removes the saved value and falls back to the environment/default. *Saved beats environment* on purpose
(the UI is the product and an environment variable cannot be changed from a browser); this is also how provider keys and URLs
already behaved. Values are validated before anything is saved: an invalid batch saves nothing.
Each setting is marked **applies immediately** or **needs a restart** (listen address, port): restart-only values are saved, flagged
*restart pending*, and used the next time the server starts. **The browser cannot restart the server**; restart it where it runs
(for example `docker restart`).

Secrets (GitHub token, access password) are write-only: the UI shows *configured · source*, never a value or a fragment.
Settings that grant host authority — project folders, delivery folder, GitHub token/API URL/hosts, the PAX path, the password,
the listen address — are **privileged**: they can only be read or changed when the server has an access password
(`FACTORY_PASSWORD`, so every client is authenticated) or the browser is on the server machine (loopback, and not relayed
through a proxy). Otherwise they are hidden/locked with an explanation. The data folder is chosen at startup and shown read-only.

### Local vs remote / container backends

da-prompt always looks things up in **the server process's own environment**: its PATH, its folders, its `localhost`. Setup &
health says whether the server runs on a host or in a container. In a container, a PAX or Ollama installed on your computer is
not visible (`127.0.0.1` is the container); use `host.docker.internal`/the host's address for providers, mount your projects as
volumes, and install PAX in the image. The UI never pretends otherwise.

### PAX

[PAX](https://github.com/rkendel1/pax) inspects project artifacts and reports structured observations (`pax --json …`). da-prompt
integrates it through `src/pax.js`:

- **Discovery** — `pax` on the server process's PATH, or the executable path set in Settings (`FACTORY_PAX_PATH`). The page shows the
  resolved path, how it was found and the version.
- **Capability checks** read the installed binary: identity from `--version` (`pax <semver>`), commands/flags from `--help`, and per-step
  availability including minimum versions (for example `--json test` needs ≥ 0.3.0). A different program called `pax` (such as the POSIX
  archiver), an unrecognisable help, a missing or non-executable file, a hang (timeout) are each reported as such.
- **Steps** are a fixed catalog of documented commands — `info`, `doctor`, `reality`, `drift`, `graph` (read-only), `test-plan`
  (`--dry-run`) and `test` (runs the project's native tests through PAX; opt-in, needs confirmation) — run without a shell, in the run's
  workspace, with a timeout and process-group kill. No guessed flags.
- **Evidence** — per step: exit status, interpretation (for example `drift` exit 1 = *drift detected*, a finding; `pax.execution-result.v1`
  parsed strictly), a structured summary, stderr tail, and artifact files under `<run>/pax/` with sizes and SHA-256. Host paths are replaced
  by `<workspace>` before anything is stored. Collect it per run (New Run checkbox), automatically (Settings), or later from the **Evidence** tab.

**Evidence semantics.** An agent's claim is not evidence. A process exiting 0 is not proof the requested outcome was achieved. PAX
observations are stored as `run.pax`, shown in their own section, and **never** feed the checklist, the verdict or readiness — a run is
*verified* only by the project's own checks, whether or not PAX was present or invoked. Where sources disagree (for example agents say
done, the factory says failed, PAX says its test run passed) the Evidence tab says so instead of resolving it. Missing or inconclusive
evidence is listed explicitly.

**Validating the real PAX install (host-side smoke test).** CI uses deterministic fake executables; to check your real install run, on
the machine that runs da-prompt:

```bash
pax --version && pax --help | head -5         # expect "pax <version>" and the PAX help
npm test -- --test-name-pattern "real PAX smoke"   # skipped unless a real pax is found (set DA_PROMPT_PAX_BIN=/path/to/pax to force one)
```

It runs every step against a throw-away Cargo project and checks the outcomes and that no host path is stored. It was run against PAX 0.5.0
built from `rkendel1/pax` while developing this feature.

### Project authorization, review, apply and publish

Local projects come only from the folders authorized in Settings (see *Existing projects* below); the browser only ever holds opaque
ids. The New Run screen shows exactly what a run may do (reads, where edits happen, whether anything can be applied or published, deploy,
PAX, models). **Preview, apply, publish and deploy are separate decisions**:

1. **Preview** — the Files tab shows changed files and diffs; the Evidence tab shows verification, baseline comparison and PAX.
2. **Review** — Delivery → *Approve changes* / *Reject*. The approval is bound to a hash of the exact change set; if the changes differ later
   you must approve again. Rejecting blocks apply and publish.
3. **Apply** (local) — writes only the changed files, only if none changed in your directory since the baseline; nothing is staged or
   committed. Or add the run as a branch in your repository. A confirmation states exactly what will be written.
4. **Publish** (GitHub) — pushes only the run branch (never forced, never the base) and opens a pull request (a draft unless fully verified);
   idempotent on retry. The PR link and branch can be opened or copied from the UI. Creation-time *publish* (the New Run checkbox) is itself an
   explicit authorization.
5. **Deploy** — unchanged: off for existing projects unless you authorize a local preview.

### Remaining host-level prerequisites

- Starting the server (and restarting it after *restart-only* settings).
- Installing **git** and **PAX** (and Ollama or other local model servers) on the machine/image that runs the server; file permissions on
  project folders. The UI detects and explains each, but cannot perform them.
- Setting `FACTORY_PASSWORD` in the environment when the server runs in a container behind a published port (otherwise host-authority
  settings stay locked, because a containerised request does not come from loopback). Everything else can be set in the UI.

## Providers and models

The factory works with any LLM that can chat. Pick the provider and model per run in the
UI (or with `--provider` / `--model` on the CLI); your last choice is remembered.

| Provider | How it is detected |
| --- | --- |
| **Ollama** (local) | Running at `127.0.0.1:11434` or `OLLAMA_HOST`. No key. Installed models are listed with size, context length and tool support. |
| **LM Studio**, **llama.cpp server**, **vLLM** (local) | Running at their default ports (`1234`, `8080`, `8000`) or `LMSTUDIO_BASE_URL` / `LLAMACPP_BASE_URL` / `VLLM_BASE_URL`. No key. |
| **Anthropic** | `ANTHROPIC_API_KEY` |
| **OpenAI** | `OPENAI_API_KEY` (and optional `OPENAI_BASE_URL`) |
| **OpenRouter**, **Google Gemini**, **Groq**, **Mistral**, **DeepSeek**, **xAI**, **Together** | `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `TOGETHER_API_KEY` |
| **Anything else** | Add it on the **Providers** page: any OpenAI-compatible endpoint, another machine's Ollama, or an Anthropic-compatible gateway, with or without a key. |
| **Offline demo agents** | Always available. Build a template app with no LLM, so you can watch every layer work (including a deliberate bug the feedback loop fixes). |

Keys can come from environment variables or be pasted on the Providers page (saved to
`data/providers.json` with owner-only permissions and never sent back to the browser).
The Providers page also lets you change base URLs, set a default model, set Ollama's
context window, and **Test** a model with a real tool call.

### Running with Ollama

```bash
ollama pull qwen2.5-coder:14b        # or qwen3-coder, devstral, gpt-oss, llama3.1 …
npm start                            # Ollama appears automatically with your models
# or headless:
npm run factory -- "A habit tracker" --provider ollama --model qwen2.5-coder:14b --num-ctx 32768
npm run factory -- --providers       # list everything that is available right now
```

Notes for local models:

- **Context window.** Ollama's default context is small and silently truncates long prompts.
  The factory talks to Ollama's native `/api/chat` and sets `num_ctx` (32k by default,
  adjustable per run). Use a value your RAM/VRAM can hold.
- **Tool calling.** Models with native tool support use it. Models without it (or that
  reject the `tools` field) automatically switch to **JSON tool calls in text**, and tool
  calls that a model writes into its reply instead of the structured field are recovered.
  You can force either mode per run or per provider.
- **Model choice matters.** Agents write and fix real code over many turns. Coding models of
  roughly 14B parameters and up do much better than small chat models. You can use a larger
  model for planning only (the *Planner model* setting).
- **No timeouts on slow hardware.** Requests to local models may take as long as they need
  (up to 30 minutes per call).

### Protect the server

```bash
export FACTORY_PASSWORD=choose-something   # agents run shell commands
npm start
```

### Headless

```bash
npm run factory -- "A shared reading list for book clubs" \
  --requirements "members add books, vote on the next pick" \
  --provider openai --model gpt-5 --planner-model gpt-5 --parallel 3

# Frontier model plans, a local model builds, and the project lands in ~/Projects/habits
npm run factory -- "a habit tracker" --planner-provider anthropic --planner-model claude-opus-5-5 \
  --provider ollama --model qwen2.5-coder:14b --output ~/Projects/habits
# add --keep-alive to leave the built app running
```

### Docker (recommended for real runs)

Agents execute the commands they write. Run the factory in a container so that the
container is the sandbox:

```bash
docker build -t da-prompt .
docker run -p 3000:3000 -v da-prompt-data:/data \
  -e ANTHROPIC_API_KEY -e FACTORY_PASSWORD=change-me da-prompt

# Ollama running on the host machine:
docker run -p 3000:3000 -v da-prompt-data:/data --add-host=host.docker.internal:host-gateway \
  -e OLLAMA_HOST=http://host.docker.internal:11434 -e FACTORY_PASSWORD=change-me da-prompt
```
(Ollama must listen on more than localhost for this: `OLLAMA_HOST=0.0.0.0 ollama serve`.)

## Existing projects

> Connect a project. Describe what you want changed. Get tested, reviewable engineering work against your existing codebase.

Besides generating a new app, a run can target **a local directory** or **a GitHub repository**. The same seven
layers, scheduler, retry/escalation loop, checklist and delivery run on top of three extra steps inside the *Plan* layer:

1. **Connect** — authorize the source and build an isolated workspace.
2. **Inspect** — read the structure, manifests, `AGENTS.md` / `CLAUDE.md` (also nested ones), scripts, test/lint/build
   commands, deploy configuration. The planner gets a *bounded* inventory (never the whole repo); each agent gets a short
   brief plus only the guidance files that apply to the files its task touches.
3. **Baseline** — run the project's own checks *before any edit* and record what already fails.

Then the plan is made against the real stack, agents implement, the project's checks run again, and every result is
classified against the baseline: **passed**, **fixed** (failed at baseline), **pre-existing** (still failing, nothing new),
**regression** (newly failing — its real output goes back to the responsible agent), **new failure**, or **not run**
(tool missing / blocked). A run is only called *verified* if checks actually ran and passed; if none could run it is
reported as **unverified**, never as success. Pre-existing failures are reported separately and do not fail the run.
(Comparison is per command, using normalised failure lines, so a new failing test inside an already-red suite is still
caught; it is a heuristic, not a test-framework parser.)

### The three project modes

| Mode | Source | Where edits happen | What you get |
| --- | --- | --- | --- |
| **New project** | an idea | the run workspace | exactly the previous behaviour |
| **Local directory** | a directory under a server-configured root | an isolated copy under `FACTORY_DATA_DIR` | patch, changed-files archive, optional apply / branch |
| **GitHub repository** | `owner/repo` or an https URL + optional branch/tag/commit | an isolated clone on branch `da-prompt/<run id>` | patch, archive, optional push + pull request |

**Local directories and authorization.** A browser cannot name a path. The server owns the list:

```bash
export FACTORY_PROJECT_ROOTS=/home/me/projects            # read/write roots (path-delimiter separated)
export FACTORY_PROJECT_ROOTS_READONLY=/srv/reference      # can be read and used as a source, never written back
npm start
```

Every immediate subfolder of a root (and the root itself if it is a git repo) is offered in the UI with its repository
state, branch and whether the working tree has changes. Requests reference a directory only by an opaque
`directoryId` (`<root hash>:<relative path>`), which is re-resolved against the configured roots on **every** use:
traversal (`..`), absolute paths, backslashes, NUL and symlinks that resolve outside the root are rejected, the
filesystem root can never be a root, and a folder overlapping `FACTORY_DATA_DIR` is refused. Server paths are never
returned to the browser (or stored in the run). Inspection (`POST /api/projects/inspect`) is read-only and works on
read-only roots.

Isolation for a local source (`workingMode`):
- **`clone`** (default for git repos with commits) — `git clone` of the *committed* state into the workspace, on its own
  branch. The clone keeps no remote pointing back at your repository. Uncommitted changes in your tree are **not** in the
  workspace (the UI/summary tells you how many).
- **`snapshot`** (the only option for non-git folders) — a copy of the working tree *including* uncommitted files (git
  sources honour `.gitignore`; symlinks, `node_modules`, files > 8 MB are skipped), committed as a baseline in a fresh
  local repository. Your uncommitted work is the baseline, not part of the diff.

I chose clone/snapshot over `git worktree` deliberately: a worktree writes into your repository's `.git` and shares refs
with it, so an agent command could move your branches. A clone shares nothing.

Your directory is **never written during a run**. Afterwards, in the Delivery tab (or `POST /api/runs/:id/apply`):
- **Apply to my directory** writes only the changed files, *only if* none of them has changed in your directory since the
  baseline (edited, deleted or newly created). On any conflict nothing is written and the conflicting files are listed;
  a failure mid-way restores every touched file. Nothing is staged or committed, and a read-only root refuses.
- **Add as a branch** (clone mode) fetches the run branch into your repository as `da-prompt/<run id>`. It adds one ref;
  nothing is checked out.
- Or just download the patch / archive. Non-git folders get a patch and archive; there is no pull request or branch.

**GitHub repositories.** `POST /api/projects/inspect` (and run creation) runs `git ls-remote` first, so a bad URL, missing
ref, auth failure or network problem is reported before a run starts (`could not resolve host`, `authentication was
rejected`, `ref "x" was not found (branches include: …)`, `git is not installed`, …). Only `https://<host>/<owner>/<repo>`
is accepted — no embedded credentials, ports or query strings. The default host is `github.com`; for GitHub Enterprise add
its host to `FACTORY_GIT_HOSTS` (the API base becomes `https://<host>/api/v3`, or set `FACTORY_GITHUB_API_URL`).

- **Public repos** need nothing. **Private repos and publishing** need `GITHUB_TOKEN` on the server (read access to
  clone; write access to push and open pull requests). It is the same single credential the project already used for
  pushes; there is no second store. It is injected into git through environment variables scoped to the repository's
  host, so it never appears in argv, a remote URL, `.git/config`, the run record, events, reports, the browser or any
  model prompt, and it is scrubbed from the agents' shell environment.
- The clone keeps history (so the diff is accurate) and each run works on its own `da-prompt/<run id>` branch; the source
  branch is never checked out for editing. A ref can be a branch, tag or commit (a pull request needs a branch to target).

**Publishing is explicit.** With `publish` set on the run (UI checkbox / `--publish`) or via **Push branch & open pull
request** in the Delivery tab (`POST /api/runs/:id/publish`), the factory pushes only the run branch — never forced, never
the base or default branch — and opens a pull request against the selected base branch (a **draft** unless everything is
verified). The body lists the goal, implementation, changed files, verification, baseline failures and anything
outstanding. It is idempotent: an unchanged branch is not pushed again, an open PR from the branch is reused, and a
remote branch with the same name but different history is reported and left alone. Push/PR failures are recorded as such
(`publication.state`, `error`, `prError`); they never change the verification verdict and a verified run is never reported
as "published" unless it was. Local runs never push or open pull requests, whatever the settings.

### Source protection

Before delivery the factory verifies, from git itself, that the workspace is still on the run branch, still descends from
the baseline commit, and that the base branch (local and remote-tracking) did not move. If not, nothing is committed or
published and the run is `needs_attention` with the reason. The **command policy** for existing projects additionally refuses
dependency installs (they run project scripts), publish/deploy/infra commands, migrations, privileged commands and git
operations that move branches (`push`, `reset`, `checkout <branch>`, `rebase`, `remote`, …), and `.git` is not writable
through the file tools. Installs can be authorized per run (`--allow-install` / the checkbox). Repository files are treated as
untrusted data: they are fenced and labelled in prompts and cannot override factory rules. Commands run **only** inside the
workspace; deployment of an existing project never happens unless you authorize a local preview.

### CLI

```bash
# a local project inside FACTORY_PROJECT_ROOTS (the original is never edited)
FACTORY_PROJECT_ROOTS=/authorized/projects \
  npm run factory -- "Add password reset to this application" --directory /authorized/projects/my-app

# include uncommitted work as the baseline instead of cloning HEAD
npm run factory -- "Fix the pagination bug" --directory /authorized/projects/my-app --working-mode snapshot

# a GitHub repo at a base ref; push the run branch and open a pull request when done (needs GITHUB_TOKEN)
GITHUB_TOKEN=… npm run factory -- "Add rate limiting to the API" --repo acme/widgets --ref develop --publish

# also export the resulting project tree to a NEW folder (never into the source); FACTORY_OUTPUT_ROOT still confines it
npm run factory -- "Add dark mode" --directory /authorized/projects/my-app --output ~/Projects/my-app-dark

npm run factory -- --list-directories
```

Flags: `--directory PATH|ID`, `--repo URL|owner/repo`, `--ref`, `--working-mode clone|snapshot`, `--publish`,
`--allow-install`, `--deploy` (authorize a local preview; existing projects are not deployed by default). `--directory` must be inside a
configured root. `--output` with a project source exports the whole resulting tree (without `.git`/`node_modules`) to a new
folder and refuses folders inside the source; the patch and archive are always written to the run's `delivery/` folder (paths
printed at the end). The exit code is non-zero if the run needs attention or a requested publish failed.

### Docker and security guidance

The container is the real boundary; the command policy is a speed bump, **not** a security boundary (`sh -c` can always
indirect around a pattern; the post-run integrity check is what proves the source was left alone). For real projects:

```bash
docker run -p 3000:3000 -v da-prompt-data:/data \
  -v /home/me/projects:/projects:ro -e FACTORY_PROJECT_ROOTS_READONLY=/projects \
  -e GITHUB_TOKEN -e FACTORY_PASSWORD=change-me da-prompt
# mount read-write and use FACTORY_PROJECT_ROOTS=/projects only if you want "Apply to my directory"
```

A project's own tests execute project code inside the workspace: run untrusted repositories only in the container, with
a token that has the least privilege needed. The Docker image has no network egress restrictions of its own.

### Known limitations

- A local source must itself be a git repository root (a sub-folder of a repo is treated as a plain folder).
- Dependencies are not installed unless authorized, and snapshots skip `node_modules`; Node/Python projects that need
  installed dependencies will show their baseline checks as failed ("dependencies missing") until you enable installs.
- Baseline/regression comparison is per command and heuristic; flaky checks can be misclassified.
- Detected check commands cover common Node, Python, Go, Rust, Maven/Gradle, Ruby, PHP, .NET and `make test` setups;
  anything else is "no baseline" and results in an *unverified* run (a reviewable diff, but not a verified one).
- `git clone` copies the full history; very large repositories are slow. Snapshots are capped (30 000 files / 600 MB).
- Only `clone`/`snapshot` isolation exist (no worktrees); submodules, LFS and forks are not handled.
- GitHub API use is limited to listing/creating pull requests via `fetch`. `@appport/github` is not a dependency of this
  repository (and the project is zero-dependency), so the REST calls live in one small module, `src/publish.js`, that could
  be swapped for a shared GitHub capability. One `GITHUB_TOKEN` is used for every enabled host.
- The offline demo agents cannot write real code for an existing project: they plan from the inspected stack, record the
  request in `docs/da-prompt-change-request.md` and run the project's checks. Use a model provider for real changes.
- The browser UI shows the diff but does not edit it; resolving an apply conflict means re-running or applying the patch by hand.

## What each layer does

| Layer | Implementation |
| --- | --- |
| **1 Plan** | The planner (the run's planner model, forced `submit_plan` tool) returns product summary, users, success criteria, tasks with roles, dependencies, acceptance criteria and `verify` commands, risks, open questions, a final test command and a deploy command. The plan is validated as a DAG (unknown deps, duplicates, cycles, roles) and sent back for fixes up to 3 times. Written to `PLAN.md`. |
| **2 Agents** | Only the roles the plan uses are spun up: product, engineer, design, QA, DevOps, research. Each gets a role brief on top of the shared operating prompt. |
| **3 Execution** | Ready tasks (all deps done) run in parallel up to the run's limit. Each agent sees only its task spec, acceptance criteria, upstream task summaries/files and recorded lessons — and works with real tools: `list_files`, `read_file`, `write_file`, `run_command`, `complete_task`. |
| **4 Artifacts** | Every task returns files, commands run, a summary and next steps. Tool calls, outputs and messages are streamed to the UI and stored in `events.jsonl`. |
| **5 Verification** | After an agent says it is done, the factory itself checks declared outputs exist and runs the task's `verify` commands. A task is complete only when they pass. |
| **6 Feedback** | Failing output goes back to the agent with the real error. Up to 3 attempts (configurable), then the task is **escalated** with options — retry, edit the spec and retry, or skip — and its dependents are blocked. Every fix or unresolved failure is appended to the project's `CLAUDE.md` and fed to later agents. |
| **7 Completion** | Runs the full test suite, a security scan (hardcoded keys, tokens, passwords, `eval`), starts the app with its deploy command and health-checks it, checks docs, and writes the final summary. The run is `completed` only when every checklist item passes. |
| **Deliver** | `FACTORY_REPORT.md`, `test-results.json` and `project.tar.gz`, a live preview at `/preview/<run-id>/`, and optionally a push to a GitHub repo. |

## The UI

- **New run** — the prompt's `<inputs>` (idea, requirements, stack, limits, access) the `<model>` picker (provider, agent model, planner model, context window, tool-calling mode — prepopulated from discovery), and factory settings: parallel agents, attempts per task, token budget, live preview, target repo.
- **Run view** — live status of the seven layers, and tabs for:
  - **Overview** — product, success criteria, escalations with action buttons, completion checklist, deployment, lessons, final summary.
  - **Task graph** — the DAG by level (parallel tasks share a column); click a task for its spec, attempts, verification output and feedback.
  - **Activity** — the full record of work streamed live (filter by task, toggle tool calls).
  - **Files** — browse the generated workspace.
  - **Delivery** — report, test output, security findings and downloads.
- **Operating prompt** — the exact prompt rendered into every planner and agent call.

Runs survive restarts: a run that was mid-flight is marked *interrupted* and can be resumed.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| Provider keys / URLs | — | See *Providers and models* above |
| `FACTORY_PROVIDER` | auto | Force the default provider id (e.g. `ollama`) |
| `FACTORY_MODEL` | auto | Default model for that provider |
| `FACTORY_PLANNER_PROVIDER` | same as agents | Plan with a different provider than the agents (e.g. `anthropic` for design, `ollama` for execution) |
| `FACTORY_PLANNER_MODEL` | same | Default planner model |
| `FACTORY_OUTPUT_ROOT` | — | Confine run output folders to this directory (relative names resolve inside it) |
| `FACTORY_MAX_OUTPUT_TOKENS` | `8192` | Max tokens per model reply |
| `FACTORY_HIDE_OFFLINE` | — | `1` hides the offline demo agents |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Server address |
| `FACTORY_DATA_DIR` | `./data` | Runs, workspaces, deliveries |
| `FACTORY_PASSWORD` | — | HTTP basic auth for the whole server |
| `FACTORY_MAX_PARALLEL` | `3` | Default parallel agents |
| `FACTORY_MAX_ATTEMPTS` | `3` | Attempts per task before escalation |
| `FACTORY_MAX_AGENT_TURNS` | `40` | Tool-use turns per attempt |
| `FACTORY_TOKEN_BUDGET` | `2000000` | Default per-run token budget |
| `FACTORY_COMMAND_TIMEOUT_MS` | `180000` | Timeout per command |
| `FACTORY_MAX_PREVIEWS` | `5` | Live previews kept running (oldest evicted) |
| `GITHUB_TOKEN` | — | Clone private repos, push run branches and open pull requests; also pushes a new project to `repoUrl` |
| `FACTORY_PROJECT_ROOTS` | — | Directories (path-delimiter separated) whose subfolders can be used as local projects, read/write |
| `FACTORY_PROJECT_ROOTS_READONLY` | — | Same, but results can only be downloaded, never applied back |
| `FACTORY_GIT_HOSTS` | `github.com` | Git hosts GitHub-backed runs may use (add a GitHub Enterprise host) |
| `FACTORY_GITHUB_API_URL` | host default | Override the REST API base (Enterprise, testing) |
| `FACTORY_PAX_PATH` | — | PAX executable (empty = `pax` on the server's PATH) |
| `FACTORY_PAX_TIMEOUT_MS` | `120000` | Timeout per PAX step |
| `FACTORY_OFFLINE_FAULTS` | `on` | Offline agents: `on` injects one bug the feedback loop fixes, `persistent` fails a full round to demo escalation, `off` |

See `.env.example`.

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/config` | Defaults, layers |
| GET / POST | `/api/providers[?refresh=1]` | Discover providers + models / add a custom provider |
| GET / PATCH / DELETE | `/api/providers/:id` | One provider / update URL, key, default model, context, tool mode / remove or reset |
| POST | `/api/providers/:id/test` | Tool-calling check against `{ model }` |
| GET | `/api/prompt?idea=…` | Operating prompt, raw and rendered |
| GET / POST | `/api/runs` | List runs / start a run `{ idea, requirements, stack, limits, tools, provider, model, planner: { provider, model, providerOptions }, plannerModel, providerOptions: { numCtx, temperature, toolMode }, settings, repoUrl, outputDir, source: { mode: 'new' \| 'local' \| 'github', directoryId, repoUrl, ref, workingMode, publish, allowInstall } }` (omit `source` for a new project) |
| GET / DELETE | `/api/runs/:id` | Run state / delete run |
| GET | `/api/runs/:id/events` | Server-sent events (replays history, then live) |
| POST | `/api/runs/:id/resume` · `/cancel` · `/deploy` | Control the run / restart the preview |
| POST | `/api/runs/:id/tasks/:taskId/retry` | Escalation: retry, optionally `{ description, verify, acceptance }` |
| POST | `/api/runs/:id/tasks/:taskId/skip` | Escalation: skip and continue |
| GET | `/api/runs/:id/files[?path=]` | Workspace listing / file content |
| GET | `/api/projects/directories` | Authorized local directories (ids, names, git state — no paths) |
| POST | `/api/projects/inspect` | Read-only summary of `{ source: { mode: 'local', directoryId } }` or `{ mode: 'github', repoUrl, ref }` |
| GET / PUT | `/api/settings` | Effective settings with sources and masking / validate + save (`{ values: { key: value \| null } }`; `null` resets) |
| GET | `/api/system/health[?refresh=1]` | Real health probes (the unauthenticated `/api/health` stays a bare liveness check) |
| GET · POST | `/api/pax` · `/api/pax/probe` | PAX status, capability catalog / probe a candidate executable (privileged) |
| GET | `/api/runs/:id/evidence` · `/artifacts` | Agent claims vs factory verification vs PAX, missing evidence / downloadable artifacts (`/download/pax/<file>`) |
| POST | `/api/runs/:id/review` · `/pax` | Approve/reject/clear the delivered changes / collect PAX evidence `{ steps, confirmTests }` |
| GET | `/api/runs/:id/changes[?path=]` | Changed files since the baseline / the diff of one file |
| POST | `/api/runs/:id/publish` · `/apply` | Explicit, and require an approval of the exact changes (`/review`): push the run branch + PR `{ pullRequest }` / apply to the local directory `{ mode: 'working-tree' \| 'branch' }` |
| GET | `/api/runs/:id/report` · `/download/:file` | Report, `project.tar.gz` (changed files only for existing projects), `test-results.json`, `changes.patch` |
| ANY | `/preview/:id/*` | Proxy to the deployed app |

## Safety model

- Agents can only touch files inside their run's workspace (path and symlink checks).
- Commands run with `sh -c` in the workspace, with a timeout, a process-group kill, an
  environment scrubbed of anything that looks like a credential, and a deny-list
  (`sudo`, deleting `/` or `~`, `git push`, …). This is a guard rail, not isolation:
  use the Docker image for untrusted ideas.
- Secrets that look like API keys or tokens are redacted from stored inputs, events,
  reports and the UI; the security scan blocks completion if they appear in code.
- Set `FACTORY_PASSWORD` before exposing the server.

## Development

```bash
npm test          # graph, sandbox, prompt, providers (incl. full runs through mock Ollama/OpenAI servers), factory, HTTP API,
                  # existing projects (temp git repos, a mock GitHub, scripted agents, CLI; the browser test needs Playwright and is skipped without it)
npm run dev       # restart on change
```

Layout:

```
src/prompt.js      the operating prompt and input rendering
src/graph.js       plan validation, levels, ready/blocked tasks (layer 1)
src/agents.js      planner, role briefs, agent tool loop, summary (layers 2–4)
src/factory.js     orchestrator: execution loop, verification, feedback, completion
src/sandbox.js     workspace file + command sandbox
src/security.js    secret scan and redaction
src/deploy.js      live preview processes and health checks
src/deliver.js     report, archive, optional git push
src/providers/     registry (presets, discovery, saved keys), anthropic, openai (OpenAI-compatible
                   + Ollama native), tooltext (JSON tool-call fallback), offline (deterministic demo)
src/server.js      HTTP API, SSE, preview proxy, static UI
src/cli.js         headless runner
public/            the web app
templates/         files the offline agents generate
```

Inspired by public ideas on "software factories". Not affiliated with or endorsed by
Cursor or its founders.
