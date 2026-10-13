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
git clone https://github.com/rkendel1/da-prompt.git && cd da-prompt
npm link                                  # or: node src/cli.js …   (no install step, zero dependencies)
da-prompt setup                           # providers, models, project folders — validated with real requests
da-prompt run "Add password reset" --project ~/projects/my-app
da-prompt runs diff <id> && da-prompt runs review <id> approve && da-prompt runs apply <id> --yes
```

That is the whole loop, from the terminal, without VS Code or a browser. The same backend also serves the web UI
(`da-prompt server start` prints the URL, or `npm start`; http://localhost:4747): describe an idea, pick a provider and
model, press **Start the factory**. Requires Node.js 20 or newer.


## Command line (the primary interface)

`da-prompt` is a terminal-first development tool. The CLI and the browser are two clients of **one** local backend
(`src/server.js`): same factory, same authorization rules, same run state, same evidence. The CLI is a pure HTTP
client of `/api` — it has no orchestration loop of its own, no run database of its own and **no extra authority because
it runs on your machine**: a path you type is mapped to an opaque project id by the backend and refused unless it is
inside an authorized folder, secrets are write-only, and apply/publish need an approval of the exact diff.

### Install and prerequisites

Node.js 20+, git. No `npm install` is needed (zero runtime dependencies).

```bash
git clone https://github.com/rkendel1/da-prompt.git && cd da-prompt
npm link                      # puts `da-prompt` on your PATH; or run `node src/cli.js …` / `npm run cli -- …`
da-prompt --version
da-prompt doctor              # prerequisites, backend and provider health, with a fix for every problem
```

### Backend lifecycle

You never have to start anything by hand: the first command that needs the backend starts it **detached on
127.0.0.1** (`server.json`, `server.lock` and `server.log` live in the data folder, `FACTORY_DATA_DIR`) and later
commands reuse it. One data folder has at most one server; a second one is refused with the pid of the first, a busy
port is a clear error, and a stale record from a crashed server is detected and removed.

```bash
da-prompt server start [--port N]    # explicit start (prints URL, pid, log path); the browser UI is at the same URL
da-prompt status                     # running? what is it doing?  (exit 3 if not running; never starts anything)
da-prompt server logs -f
da-prompt server stop                # --yes if runs are executing (they can be resumed later)
da-prompt server restart             # applies restart-only settings (host, port)
da-prompt runs list --url http://host:4747    # or DA_PROMPT_URL=…; use DA_PROMPT_PASSWORD when the server has a password
da-prompt runs list --no-start       # never launch a backend; exit 3 if none is running
```

### Setup, providers and models

```bash
da-prompt setup                                   # interactive on a terminal; asks only for what is missing
da-prompt setup --non-interactive --provider ollama --model qwen2.5-coder:7b --project-root ~/projects
printf %s "$ANTHROPIC_API_KEY" | da-prompt providers set-key anthropic --stdin
da-prompt providers list                           # health of every provider + the current default/planner
da-prompt providers models ollama                  # discovery only
da-prompt providers test ollama --model qwen2.5-coder:7b   # connectivity → discovery → a real tool-calling request
da-prompt providers use ollama --model qwen2.5-coder:7b    # validated first; nothing is saved if it fails
da-prompt providers planner anthropic --model <model>   # plan with a different model than builds
da-prompt providers add --label "My vLLM" --provider-url http://gpu:8000/v1 [--stdin]
```

`providers test` reports the three stages separately — *reachable*, *lists the model*, *answered a real request* — so
"the server is up" is never mistaken for "the model works". Keys are accepted only on stdin or from a named
environment variable (`--from-env NAME`), never as arguments, and are never echoed.

### Configuration (no editor needed)

```bash
da-prompt config list [--group github]    # every setting, its effective value and WHERE it came from
da-prompt config get maxParallel
da-prompt config set maxParallel 5        # validated by the backend before anything is saved
da-prompt config set projectRoots ~/projects ~/work
printf %s "$GITHUB_TOKEN" | da-prompt config set githubToken --stdin
da-prompt config unset maxParallel        # fall back to the environment, then the default
da-prompt config path
```

Settings are the same ones the browser edits, persisted by the backend in `<data folder>/settings.json` (mode 0600).
Precedence, highest first: **run option → startup option → saved → environment → default**. The CLI's own
`--option` flags are run options. One deliberate exception to "CLI > env > persisted > defaults": a value you *saved*
(in the browser or with `config set`) beats the environment, because a saved value is an explicit later decision and a
long-lived environment variable should not silently undo it; `config list` always shows which one is in effect and
`config unset` removes the saved value. Nothing in setup edits `.zshrc` or any shell profile; the CLI itself stores only
the selected project id in `~/.config/da-prompt/cli.json` (`DA_PROMPT_CONFIG_DIR` to move it).

### Projects

```bash
da-prompt projects add ~/code/my-app --use           # register once (a path inside an authorized folder); --use selects it
da-prompt projects add acme/api --ref develop        # a remote repository: just the identity, nothing is cloned
da-prompt projects list [--status missing] [--folders]   # registered projects with live status; --folders = candidates
da-prompt projects show my-app                       # identity, location, branch/dirty/remote, problems, run count
da-prompt projects use my-app                        # by name or id (the id is what is remembered)
da-prompt projects rename my-app "Shop v2"           # the id never changes
da-prompt projects repair my-app ~/code/shop         # the folder moved; --accept-different-repository only if intended
da-prompt projects validate my-app                   # exit 6 if missing/inaccessible/needs attention
da-prompt projects archive my-app | restore my-app
da-prompt projects remove my-app --yes               # the registration only: files, runs and artifacts stay
da-prompt projects inspect | current | clear | init "A habit tracker"
```

`run --project my-app`, terminals and the browser all refer to the same registered project by id. See [Projects](#projects-persistent-workspaces).

### Run, monitor and recover

```bash
da-prompt run "Add password reset" --project my-app [--pax] [--provider P --model M] [--attempts 3]
da-prompt run "…" --project . --detach           # returns the run id immediately
da-prompt runs follow <id>                       # reconnects and resumes from the last event; Ctrl-C only detaches
da-prompt runs list [--active] [--status needs_attention]
da-prompt runs show <id>        # tasks, verification, delivery, review, next steps
da-prompt runs tasks <id>       # the task graph; retries/escalations/errors per task
da-prompt runs logs <id> [--tail 50] [--type verify] [-f]
da-prompt runs cancel <id>
da-prompt runs resume <id>      # stopped / interrupted / cancelled / failed / needs-attention runs
da-prompt runs retry <id> <task> [--description "…"] [--verify "cmd"]   # an escalated task, fresh attempts
da-prompt runs skip <id> <task>
```

A run executes on the backend, so closing the terminal does not stop it; `--cancel-on-interrupt` makes Ctrl-C cancel
instead of detach, and `--wait-timeout SECONDS` stops *following* (exit 7) without touching the run.

### Editing a stopped run (and interrupting a running one)

A run that stopped (failed, cancelled, needs attention) can be changed and continued instead of started over; work already
done is kept. In the browser use **Edit run** on the run page (**Interrupt & edit** while it is executing): pick another
provider, model, planner or agent engine, change the limits, edit the request, tick *Install dependencies*, or add a **note to
the agents** (added to their prompt as the newest instruction, and it wins over older text). *Save* keeps it stopped; *Save &
resume* carries on. A model or provider you pick is validated exactly as when a run starts.

```bash
da-prompt runs update <id> --provider openai --model gpt-5 --note "Use TypeScript strict mode" --resume
da-prompt runs update <id> --interrupt --attempts 4 --budget 3000000     # stop it, change it, leave it stopped
da-prompt runs rerun <id> --allow-install                                 # or a NEW run from the same request
```
API: `PATCH /api/runs/<id>` with any of `provider, model, providerOptions, planner, engine, settings, inputs, allowInstall, note,
interrupt, resume`. A task that escalated is still retried, edited or skipped from the Overview tab.

### Changes, verification and evidence

```bash
da-prompt runs files <id>              # changed files and line counts
da-prompt runs diff <id> [--file src/x.js] [--out change.patch]
da-prompt runs tests <id>              # the factory's checks: baseline → result; --run re-runs them now
da-prompt runs verify <id>             # re-run the checks in the run's workspace (recorded apart from the verdict)
da-prompt runs evidence <id> [--strict]   # AGENT CLAIMS · FACTORY VERIFICATION · PAX OBSERVATION, kept separate
da-prompt runs report <id> --out report.md
da-prompt runs artifacts <id> [--get changes.patch --out p.patch]
```

Nothing here changes your project. Previewing and reviewing are separate from applying.

### PAX

PAX is resolved from the **backend's** `PATH` (or `config set paxPath /full/path/pax`); da-prompt never installs it.

```bash
da-prompt pax status                   # path, version, capabilities — and which environment was inspected
da-prompt pax probe /opt/pax/bin/pax   # check an executable without saving it
da-prompt pax verify <run-id> [--steps info,doctor,drift] [--confirm-tests] [--fail-on-findings]
da-prompt pax evidence <run-id>
```

PAX output is *evidence*, shown apart from agent claims and from the factory's own verification, and it never changes a
run's verdict. Missing, incompatible (a different program called `pax`, e.g. the POSIX archiver), timing-out and failing
PAX are each reported as such; drift is a finding (exit 6 with `--fail-on-findings`), a tool failure is exit 1.

### Dependencies and the baseline

Before an existing-project run changes anything it runs the project's own checks (tests, lint, build) to learn what already
fails. On a fresh isolated clone those checks cannot run until the dependencies are installed, so **Install dependencies**
does that first, in the run's isolated workspace (your own directory is never touched and `node_modules` is never part of
the change). It also lets agents install more if a task needs it. It runs the project's own install scripts, which is why it
is a choice and not always on.

Where to turn it on, most specific first:
- **This run:** the *Install dependencies* checkbox on New Run (`--allow-install`, `source.allowInstall`).
- **This project:** Projects → the project → *Dependencies* (Server default / Install before the baseline / Never install).
- **Everywhere:** Settings → Execution → *Install dependencies* (`FACTORY_ALLOW_INSTALL=1`).

What gets installed: Node (`npm ci`, falling back to `npm install` when the lockfile is stale; pnpm, yarn and bun are
recognised), Rust (`cargo fetch`), Go (`go mod download`), Ruby (`bundle install`) and PHP (`composer install`). Python, Java
and .NET are left to the agents because they need an environment of their own. The results are shown in the run's Baseline
card and the `install` events.

If a baseline could not run because dependencies were missing, the Baseline card offers **Re-run with dependency installs**
(`POST /api/runs/<id>/rerun`, `da-prompt runs rerun <id> --allow-install`): a new run with the same request, model and
project; the first run is kept as it was.

### Apply and publish (explicit by default; local apply can be made automatic)

```bash
da-prompt runs review <id> approve --note "read the diff"     # approval is bound to the exact patch (sha256)
da-prompt runs apply <id> --yes          # write the approved files into your directory — nothing staged or committed
da-prompt runs apply <id> --approve --yes # review + apply in one step (approves exactly these changes)
da-prompt run "…" --project <dir> --auto-apply  # opt in: apply automatically if the run finishes verified and ready
da-prompt runs apply <id> --branch --yes # or add the work to your repo as a branch instead
da-prompt runs publish <id> --yes        # GitHub runs: push da-prompt/<id> and open a PR (needs githubToken; --no-pr to push only)
```

`apply` refuses if the files changed since the run started, preserves your uncommitted work and never overwrites it
silently. Without a terminal, `--yes` is required; there is no auto-merge and no deploy command.

### Scripting: `--json`, exit codes, timeouts

Every command takes `--json` (one JSON document on stdout; errors too, as `{"error":{"code","exitCode","message","hint"}}`;
`run`/`follow` stream NDJSON events and end with a `{"type":"result"}` line), `--quiet`, `--no-color` (and `NO_COLOR`),
`--timeout SECONDS` per request, and never prompt when stdin is not a terminal.

| Exit | Meaning |
| --- | --- |
| 0 | success (for a run: completed **and** verified by the factory) |
| 1 | failed (run failed, check failed, provider not usable, step failed, `doctor` found a problem) |
| 2 | usage error (bad flag/argument, missing `--yes` when non-interactive) |
| 3 | backend unreachable / not running / PAX not available |
| 4 | refused (not approved, not authorized, password needed, path outside the authorized folders) |
| 5 | not found (run, task, project, setting) |
| 6 | needs attention (escalated tasks, PAX findings with `--fail-on-findings`) |
| 7 | `--wait-timeout` elapsed (the run keeps going) |
| 8 | run cancelled |
| 130 | interrupted while following (the run keeps going) |

### When da-prompt itself is broken: the independent development path

Nothing below needs da-prompt, a backend, a network or an LLM.

```bash
npm test             # the full suite (offline agents, no keys); exit 0 = pass
npm run check        # lint-style static checks: syntax, relative imports resolve, unused imports, stray .only; `--json` for CI
npm run build        # "build": package contents (npm pack --dry-run), CLI entry, every module imports; exit 1 on failure
npm run validate     # check + build + test
```

There is no TypeScript or bundler in this repository, so there is no separate type-check step and `build` compiles
nothing; `check` reports what it could not run (e.g. ESLint is not installed) as *skipped*, never as passed. The same
three commands run in CI (`.github/workflows/ci.yml`).

Inspecting, reviewing, reverting and recovering with ordinary git (a run never touches your branch until `apply`):

```bash
git status; git diff; git log --oneline -5         # what is in your tree
git checkout -- <file>  ·  git stash -u            # throw away / set aside an applied change
git apply -R path/to/changes.patch                 # undo an applied patch (the run's patch is in its artifacts)
git apply --check path/to/changes.patch            # would it still apply?
ls "$FACTORY_DATA_DIR/runs/<id>/"                  # run.json, events.jsonl, workspace/, delivery/ (report, patch, tar.gz), pax/
git -C "$FACTORY_DATA_DIR/runs/<id>/workspace" log --oneline   # the isolated clone: inspect, test or push it yourself
tar -xzf "$FACTORY_DATA_DIR/runs/<id>/delivery/project.tar.gz" -C /tmp/inspect    # the changed files
```

After a crash or reboot: `da-prompt runs list` shows interrupted runs; `da-prompt runs resume <id>` continues them. If
the CLI cannot start a backend, `da-prompt server logs`, or read `<data>/server.log`; stale records are cleaned up
automatically, or delete `<data>/server.json` and `server.lock` by hand when no `node src/server.js` is running.

### Self-hosting demonstration

[`docs/selfhost/`](docs/selfhost/) records a real run of this CLI on this repository: one bounded change (`redact()` now
masks `Bearer` tokens and `x-api-key` header values, with tests), done through `setup → run → follow → evidence → diff →
review → apply`, then validated with plain npm. Read [`docs/selfhost/README.md`](docs/selfhost/README.md) for what was
real and what was a stand-in (no real model credentials were available, so a scripted OpenAI-compatible server played the
model).

## Projects (persistent workspaces)

A **project** is a durable record of a workspace: an opaque, stable id (`prj_…`) associated with a location. It is *not* a
terminal session, a run, a checkout or a folder name, and it survives restarts, browser refreshes, closing terminals and
finished or failed runs. Register a repository or folder once; every later visit, terminal, task and run history refers
to it by id. Renaming it, moving the folder, or reopening it never changes its identity.

**Where it is stored.** `<data dir>/projects.json` (mode 0600), owned by the backend: written atomically (temp file +
rename) under a single in-process lock, so concurrent registrations cannot both win. Nothing is kept in the browser. A
corrupt file is set aside as `projects.json.corrupt-<time>` and never silently overwritten. No credentials are ever stored
in a project record (remote URLs with credentials are rejected; tokens stay in Settings).

**Data model** (`src/registry.js`): `id`, `name`, `kind` (`local` | `remote`), `createdAt`, `updatedAt`, `lastUsedAt`,
`archived`, `settings` (`workingMode`, `defaultRef`), `validation` (`status`, `errors`, `warnings`, `checkedAt`), and
either `location` (`path`, `rootKey`, `rel`) plus `repo` identity (`isGit`, first commit(s), remote, default branch) for a
local project, or `remote` (`url`, host, owner, repo, default branch) for a remote one.

| Workspace type | What is registered | Notes |
| --- | --- | --- |
| **Local folder** | an existing directory | allowed without Git (snapshot working mode only) |
| **Local Git repository** | the repository root, its first commit(s), remote and default branch | Git itself decides (no provider is assumed; ssh/scp and https remotes both work); the folder name may differ from the remote's |
| **Remote repository** | host/owner/repo + default ref (GitHub workflow) | a *repository* identity, never a clone: each run gets its own isolated clone under the data dir; a remote project has no local folder (no terminal) |

**Statuses come from looking at the host**, not from stored flags: `available`; `missing` (folder moved/deleted: the record
and history stay, work is blocked); `inaccessible` (unreadable, or no longer inside an authorized root); `attention` (the
remote changed, the folder is no longer a repository, or it now holds a **different repository** — detected from its first
commit — so it is never used just because the folder name matches). A blocked project is repaired explicitly
(`POST /api/projects/<id>/repair` / the *Fix* panel / `projects repair`); a folder with a different repository needs
`acceptDifferentRepository`, a changed remote needs `acceptRemoteChange`, a changed remote URL needs `acceptNewRemote`.
The id and all history stay through every repair.

**Conflicts are explained, never silently resolved.** The same folder twice is a hard conflict (it names the existing
project and the resolution). The same repository from another checkout (same first commit or remote) needs
`acknowledgeSameRepository` and becomes a separate, clearly distinguished project. Concurrent duplicates: exactly one wins.

**Authorization.** A record grants nothing. Every use re-resolves the stored path against the *current* authorized roots
(symlink/traversal-safe), re-checks the repository identity, and refuses archived, missing, inaccessible or
needs-attention projects — and read-only roots stay read-only (no apply, no terminal). Registering by `path` needs an
authenticated session or a local browser and the path must be inside an authorized root; anyone may register from the
authorized-folder list (it adds no authority). Non-administrators never see absolute paths in project views. Registration
clones, changes and deletes nothing. Removing a registration (`DELETE /api/projects/<id>` with `{confirm: "<name>"}`)
deletes **no** files, repositories, runs, artifacts or terminal data.

**Common workspace reference.** Terminals (`{projectId}`: validated now, session records only the id, starts in the
project's directory), new runs (`source: {projectId}`; the run stores `projectId` + a name snapshot), run history
(`GET /api/projects/<id>/runs`, `GET /api/runs?projectId=`), inspect, and **apply/publish** (apply follows the project's
*current* folder, so a moved-and-repaired project still receives its runs' results, and is blocked while the project is
missing or archived). Runs show the project's current name; if the registration was removed they keep the id and the
old name (`projectRemoved`). The CLI uses the same ids (`projects use` remembers the id, not a path).

**Migration.** On startup, earlier runs that used an existing project (local directory or GitHub repository) and have no
project id are attached to a registered project — created once per distinct folder/repository, marked
`migratedFrom: "runs"` — and only `projectId`/`projectName` are added to the run. Re-running it creates no duplicates; runs
whose folder is no longer authorized are left alone. The legacy `directoryId`/`repoUrl` API still works (and the
terminal's "other authorized folders" picker), so nothing has to be re-registered after upgrading.

**UI.** *Projects* in the sidebar: search, status filter, archived toggle, register (folder / repository), a detail page
with location, repository state, run history, **Open terminal**, **Start a task**, rename, archive/restore, repair and
remove (typed-name confirmation). New Run has a *Registered project* source; the run page links back to its project.

**Limitations.** A project's folder is where `apply` writes; a terminal's shell is not confined to it. Project-specific
configuration is limited to working mode and default ref. Status freshness: lists reuse a validation for 5 s (opening the
Projects page and every use re-validate). A moved folder is not auto-detected elsewhere — it is repaired by choosing its
new location. Several registered checkouts of one repository are separate projects.

## Chat and Backlog

> Chat helps you think; the backlog preserves what you intend to do; execution happens only when you explicitly start a task.

### Chat (`#/chat`)

A ChatGPT-style interface: a chat list on the left, a centered thread with Markdown replies, a typing indicator and a live caret while the answer streams, and a composer with provider, model, project and **Context** chips. A new chat is only created when you send the first message. A conversation can be **general (no project)** or belong to **one registered project**, fixed at creation (a project id, not a path). Switching project means starting a new conversation; a conversation is never silently moved (`PATCH` ignores `projectId`). Conversations have stable `cnv_…` ids and are stored on the backend (`<dataDir>/chat/<id>.json`, atomic writes, mode 0600), independent of the browser, terminals and runs. They survive refresh and restart; a response that was streaming when the server stopped is marked *failed* and can be retried.

- **Provider and model** are chosen per conversation (and per message). Each assistant message records the provider and model that actually produced it (and every retry attempt); changing the selection only affects future messages. Credentials stay server-side: the browser receives provider ids and labels, never keys or base URLs.
- **Streaming, Stop, Retry.** Providers stream through their adapters (`chatStream` on Anthropic, OpenAI-compatible and Ollama; providers without it deliver the answer whole). Stop keeps the partial text as *stopped*; Retry regenerates the latest failed/stopped response in place. One response runs at a time per conversation.
- **Retrieved vs inferred.** Before each answer the server retrieves bounded context through the project registry (`registry.locate()`): project record, git state, top-level docs, a file list, files you mention by path or that match your question, open tasks and recent runs. Secret-like files (`.env`, keys…) are never read; everything passes `redact()`. The list of what was retrieved (and limitations: missing folder, remote repository, archived or removed project) is stored on the message and shown under it; everything else in an answer is the model's inference. Context never crosses projects.
- **Context you control.** The *Context* panel lists everything that can be sent with your next message and lets you tick or untick each source: earlier messages in the chat, and (for a project chat) project details, backlog tasks, recent runs, git status and commits, the file list, README/docs and the files your question mentions. Sizes are shown. You can also **pin notes** (background text kept with the chat, sent only while ticked; secrets are redacted). A reply's *Retrieved from the project* line records what was actually sent. API: `PATCH /api/chat/conversations/:id` with `{ context: { sources: { docs: false }, notes: [...] } }`, `GET /api/chat/conversations/:id/context` for the panel.
- **Advisory only.** Chat has no tools: it cannot run commands, edit files, create runs or publish. Model output is escaped before a small Markdown renderer formats it (links are http(s) only); code blocks have a Copy button.
- **Copy.** Whole response, each code block independently, a text selection, a conversation excerpt (tick messages) or the whole conversation. If the browser blocks the clipboard the UI says so and shows the text selected in a dialog instead of claiming success.

### Backlog (`#/backlog`)

One persistent, ordered list of tasks across **all** products and projects (`<dataDir>/tasks.json`). The array order *is* the priority (position 1 first); there is no second ordering. Rows show title, project, product, status, origin (manual or the chat conversation) and the linked run's real status; **Details** opens editing, history and status changes.

- **Reorder.** Drag a row by its handle, or use **Move up / Move down** (keyboard accessible; focus stays on the moved row). A plain click never reorders. The UI updates immediately and then reconciles with the server's answer. Moves are relative (`beforeId`/`afterId`/`top`/`bottom`) and carry the client's `rev`; if the backlog changed elsewhere the server refuses with `409` and returns the authoritative list (nothing is moved), and a failed save puts the order back with a visible error.
- **Filters** (search, product, project, status) are views over the same global order and never create another one; positions shown are positions in the full backlog. Completed/cancelled tasks stay in the list; *Open only* is an explicit status filter.
- **Product.** There was no Product entity, so a project has an optional `product` label (set on the project page or at registration; empty clears). It is never derived from the repository name.
- **Tasks from chat.** *Create task* on a message, a text selection, ticked messages or the whole conversation opens a draft. A model may summarize the conversation (`POST /api/chat/conversations/:id/task-draft`; falls back to a plain extract with a warning), but nothing is saved until you review and edit it. The task keeps its origin (conversation, message ids, optional excerpt) and defaults to the conversation's project. Manual tasks use the same entity.
- **Lifecycle.** `backlog`, `ready`, `in_progress`, `blocked`, `completed`, `cancelled`. Creating, editing, reordering or changing status never runs anything. **Start** (with a confirmation showing the exact description) creates a normal factory run on the task's project (`source: { projectId }`, `taskId`), links it, and moves the task to *in progress*; the run's own status/verdict is displayed. A finished run **does not complete the task** — you do. Applying and publishing stay separately approved on the run. Tasks of an archived, unavailable or removed project remain inspectable (labelled) but cannot be started.

### Limitations

Conversations are plain text (no Markdown rendering beyond code blocks); context retrieval is keyword/path based, not semantic, and remote repositories get metadata only; there is no history search across conversations; the backlog polls every 5 s for changes made elsewhere instead of pushing; there is one backlog per da-prompt data directory (no per-user lists); drag-and-drop needs a pointer — keyboard users use the Move buttons.

## Embedded terminal

The **Terminal** page (`#/terminal`, in the sidebar) is an integrated developer terminal: real shells on a real pseudo-terminal, rendered by xterm.js (the emulator VS Code's terminal uses), on the machine that runs the da-prompt backend. It is **not** an agent, not routed through any model, provider, Chip/AppPort/FeltDB, PAX or run orchestration, and works when all of them are broken, so you can open it and repair da-prompt itself.

What you get: multiple sessions in tabs, each started in an authorized project; the shell's own history (↑/↓), editing, completion and job control; copy/paste/selection/scrollback; Ctrl-C and an Interrupt button; resize; the shell's current directory (with an *outside project* marker); running / exited (with the exit status) / reconnecting / disconnected / closed states; sessions that survive a browser refresh; **Check tools**, which shows what a login shell finds for `git node npm python3 cargo rustc ollama pax make`.

### Security model (read this)

A terminal runs your login shell **with the permissions of the user who started da-prompt**. It can read, change and delete anything that user can, and run anything installed. A project root is a *starting directory*, **not a sandbox**: after it starts, `cd`, absolute paths and child processes reach the rest of the filesystem. The page says so and shows when the shell has left the project. The security boundary is *who may open a terminal*, not what the shell can touch:

| Boundary | Behaviour |
| --- | --- |
| Who | Only an authenticated request (access password) or a browser **on the server machine** (loopback, not relayed by a proxy — the same rule as host-level settings). Everything else gets 403, including a LAN browser to an unprotected server. The terminal can be removed entirely (`FACTORY_TERMINAL=0` or Settings → Server). |
| Every call | Create, attach (stream), input, resize, signal, close, list: each re-checks the above and that the session belongs to the caller's principal. Unknown, malformed and foreign ids return the same 404. |
| Session ids | 192 random bits (`crypto.randomBytes(24)`); a capability, never an index; never logged. |
| Browser attacks | Requests with a foreign `Origin` or `Sec-Fetch-Site: cross-site` are refused (CSRF); on an unprotected server the `Host` must be `localhost`/`127.0.0.1`/`[::1]` (DNS rebinding). |
| Start directory | The browser sends an opaque `directoryId` from the authorized list; the server resolves it (symlink-escape, traversal and the data directory are refused). Read-only roots are refused — a shell cannot honour "read-only". A path in the request is ignored. |
| Injection | No shell string is ever built: the PTY helper receives `argv` as an array; input is raw bytes written to the PTY (a 64 KiB cap per message). |
| Secrets | The shell inherits the backend's environment minus `FACTORY_PASSWORD`/`DA_PROMPT_PASSWORD` (it is *your* shell: variables you exported for the backend, such as provider keys, are visible to it). No environment is ever sent to the browser; terminal input/output is never logged by the server; errors go through `redact()`; the session is not persisted. |
| Resource limits | At most 8 sessions (`FACTORY_TERMINAL_MAX_SESSIONS`), 1 MiB of retained output per session, output flood-safe (below), idle and abandoned-session cleanup. No CPU/memory quotas on what the shell runs: use a container for that. |
| Transport | HTTP. With a password, credentials and terminal traffic are cleartext unless you put TLS in front (reverse proxy). Prefer `127.0.0.1` (the default when no password is set; the CLI starts the backend there) and an SSH tunnel for remote use. |

### Architecture and lifecycle

```
xterm.js ──POST /input /resize /signal──▶ server.js (/api/terminal, guards) ──▶ TerminalManager (src/terminal.js)
   ▲                                                                                  │ stdin/fd3 ▲ stdout/fd4
   └────── SSE /stream?after=<byte offset> (data · state · truncated) ◀─ ring buffer ◀─ src/terminal-pty.py ── PTY ── $SHELL -l
```

* **PTY.** Node has no pseudo-terminal and this repository has no native dependencies, so a ~250-line Python 3 helper (standard library only, `os.forkpty`) owns the PTY, runs the shell as a session leader with a controlling TTY (so prompts, job control, `Ctrl-C`, `stty`, `[ -t 0 ]` and programs that need a TTY work; full-screen programs such as `vim` or `top` run on the same TTY but were not part of the automated tests) and relays bytes. Python 3 ships with the Xcode command line tools on macOS and with most Linux hosts; without it the page says so and how to fix it (`xcode-select --install`) — there is deliberately no fake non-TTY fallback.
* **Transport.** The repository's existing mechanism: server-sent events for output (resumable by **byte offset**, so a reconnect continues exactly where it stopped, with no duplication) and small JSON POSTs for input, resize and signals. No WebSocket dependency.
* **Session lifecycle.** create → attach (stream) → detach (browser closes/refreshes: the shell keeps running) → reattach (`after=<offset>` or from the start of the retained buffer) → close. Exited sessions stay readable for 10 minutes (`FACTORY_TERMINAL_EXITED_KEEP_MS`).
* **Backpressure and limits.** Output goes into a bounded ring (`FACTORY_TERMINAL_BUFFER_BYTES`, default 1 MiB); a client that is slower than the shell is skipped forward and told (`truncated`), a client that never reads only costs its own socket; the shell is never blocked by a browser. Input is delivered in order, batched while a request is in flight.
* **Cleanup (no orphans).** *Close* hangs the shell up, then kills everything in its process tree (descendants snapshotted from `ps`, plus every process in its login session, with SIGKILL after a 2 s grace; processes that ignore SIGHUP/SIGTERM are killed). *Server shutdown* closes every session. If the backend dies hard (SIGKILL, crash) the helper sees its control pipe close and takes the shell and its tree down. A session with no browser attached for 30 minutes (`FACTORY_TERMINAL_IDLE_MS`; `0` disables) is closed as abandoned. When the shell exits by itself, whatever is left in its session is killed. **Limit:** a process that deliberately daemonizes (`setsid` + parent exits) leaves the session and tree and is not tracked.
* **Working directory.** Shown live (`/proc/<pid>/cwd` on Linux, `lsof` on macOS). Navigation is the shell's; nothing switches directories for you. A deleted/moved project directory is reported at create time ("it was deleted or moved") and nothing is started.

### Environment on macOS (and everywhere)

Shells are started as **login shells** (`$SHELL -l`, else the account's shell, else `/bin/zsh` on macOS, `/bin/bash` elsewhere), so they read the same startup files a Terminal.app window does (zsh: `/etc/zprofile` → `path_helper`, `~/.zprofile`, `~/.zshrc`). That is how a terminal finds Homebrew (`/opt/homebrew/bin`), `cargo` (`~/.cargo/bin`), `ollama`, `pax`, even when da-prompt was launched from the Dock/launchd with a minimal PATH (the GUI-vs-terminal difference). **Check tools** reports what a login shell finds and which PATH folders only it adds; da-prompt **never edits** `.zshrc`, `.zprofile`, `.bash_profile` or any shell file. Tools added to PATH only in files the shell does not read are not found — the page says where to put them. Override the shell with `FACTORY_TERMINAL_SHELL=/bin/bash`, the Python with `FACTORY_TERMINAL_PYTHON`.

### Settings

`FACTORY_TERMINAL=0` (or Settings → Server → *Embedded terminal*), `FACTORY_TERMINAL_SHELL`, `FACTORY_TERMINAL_PYTHON`, `FACTORY_TERMINAL_MAX_SESSIONS` (8), `FACTORY_TERMINAL_BUFFER_BYTES` (1048576), `FACTORY_TERMINAL_IDLE_MS` (1800000), `FACTORY_TERMINAL_EXITED_KEEP_MS` (600000).

### Limitations

Needs Python 3 on the backend host; POSIX only (no Windows); the `lsof`-based directory display on macOS and the macOS login-shell PATH behaviour are implemented from documentation but were **not run on macOS** in development (the automated and manual tests ran on Linux); sessions do not survive a backend restart (they are shells, not tmux); only one principal (the password holder / the local user); no shell-integration markers (command boundaries), file upload/download, split panes or search; the scrollback replayed after a refresh is at most the last 1 MiB; terminal bytes are not scrubbed for secrets (that is the shell's output, shown to you only).

## Using da-prompt from the browser

Everything routine is done in the web UI; no editor, terminal or CLI is needed after the server is running.

| Where | What you do there |
| --- | --- |
| **New run** (`#/`) | Pick a project (new, authorized local folder, GitHub repo), describe the change, choose models, review the *"what this run may do"* summary, start. |
| **Run view** | Follow the seven layers and the Connect/Inspect/Baseline stages live (it reconnects by itself after a refresh or a network blip), cancel, resume, retry/skip escalated tasks. Tabs: Overview, Task graph, Activity, Files (changed files + diff), **Evidence**, Delivery. |
| **Projects** (`#/projects`) | Your registered repositories and folders: register once, see live status, open a terminal or start a task, repair, rename, archive, remove. |
| **Terminal** (`#/terminal`) | A real shell in a project folder — see [Embedded terminal](#embedded-terminal). Works with no provider, no PAX and no agent. |
| **History** (`#/history`) | Every run on record, searchable by task, project, id, model; filter by status, project type and verification. |
| **Setup & health** (`#/setup`) | First-run checklist and ongoing health. Every line is a real probe, with what was observed and the next step. |
| **Settings** (`#/settings`) | The supported configuration, saved on the server, with the source of each value. |
| **PAX** (`#/pax`) | Where PAX was found, its version, what this install can do, and what its evidence means. |
| **Providers** (`#/providers`) | Provider URLs/keys, model discovery, connection tests. |

### Launching it

Start the server once (`npm start`, or the Docker image) and open `http://localhost:4747`. That one start is the only
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

### Agent engines (experimental): built-in or FX

Planning, verification, feedback, review and delivery are always da-prompt's own. The *engine* only decides who runs one
task attempt, so you can try another agent loop and switch back without losing anything.

| Engine | What it is | Providers |
| --- | --- | --- |
| `builtin` (default) | da-prompt's own tool loop. | all |
| `fx` | [`@appport/fx`](https://www.npmjs.com/package/@appport/fx) runs the loop and the model connection; every tool is still da-prompt's sandboxed one (same file, command and secret rules, same events and token budget). | OpenAI-compatible APIs and Ollama (not Anthropic) |

```bash
npm run engine:install -- fx          # installs @appport/fx under <data dir>/engines (da-prompt itself stays dependency-free)
npm run engine:install -- fx --remove # and removes it again
da-prompt run "…" --engine fx         # one run; omit it (or --engine builtin) to use the built-in loop
FACTORY_AGENT_ENGINE=fx               # or set the default (Settings → Models → Agent engine); a run's own choice wins
```

In the browser it is the **Agent engine** selector under the model picker; engines that are not installed or cannot use the
chosen provider are greyed out with the reason (`GET /api/engines`). The run page and report show a non-default engine.

Things to know: fx executes only structured tool calls. Local models that write a call as plain text (qwen3-coder does this
often) are retried by the adapter up to four times, but the built-in engine's text-call fallback is more forgiving, so compare
on your model. `http://` endpoints are accepted by fx only on localhost. The model credential reaches fx as an environment
variable *name* (never the key) that agent shells cannot see, and is removed when the task attempt ends.

**`@appport/chip` is not an engine yet.** It is the eve framework (a durable agent *service* you author as a directory, build
and serve, on Node ≥ 24 with its own sandbox backends: Docker, microsandbox or a JS shell at `/workspace`). Its tools would not
touch da-prompt's sandboxed workspace without a bridge, so it needs its own design rather than a flag; see the note in the
development log if you want to take that on. `chip` already uses `fx` as its model provider (`eve/models/fx`).

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

### Headless (compatibility runner)

The original in-process runner is kept: `da-prompt "<idea>" [flags]` (any first argument that is not a command, with spaces or
flags) builds without a backend and prints the result. Prefer `da-prompt run …`, which uses the shared backend, is
observable from the browser and supports review/apply/publish.

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
docker run -p 4747:4747 -v da-prompt-data:/data \
  -e ANTHROPIC_API_KEY -e FACTORY_PASSWORD=change-me da-prompt

# Ollama running on the host machine:
docker run -p 4747:4747 -v da-prompt-data:/data --add-host=host.docker.internal:host-gateway \
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
docker run -p 4747:4747 -v da-prompt-data:/data \
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
| `PORT` / `HOST` | `4747` / `127.0.0.1` (`0.0.0.0` when `FACTORY_PASSWORD` is set; the Docker image sets `0.0.0.0`) | Server address |
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
| GET / POST | `/api/projects` | **Registry**: list (`?q&status&archived=false|only|all&refresh=1`) / register `{kind, directoryId \| path \| repoUrl, name, workingMode, defaultRef, acknowledgeSameRepository}` |
| GET / PATCH / DELETE | `/api/projects/<prj_id>` | Details + git state / rename + settings, `acceptRemoteChange`, `acceptNewRemote` / remove the registration (`{confirm: name}`) |
| POST | `/api/projects/<prj_id>/validate` · `/repair` · `/archive` · `/restore` | Re-check against the host / point at another folder (`acceptDifferentRepository`) / make inactive / reactivate |
| GET | `/api/projects/<prj_id>/runs` | Run history of the project |
| GET / POST | `/api/chat/conversations` | List (`?projectId`) / create `{ projectId?, provider?, model?, title?, context? }` (no `projectId` = a general chat) |
| GET / PATCH | `/api/chat/conversations/<cnv_id>` | Conversation with messages, live project status / `{ title, provider, model }` (future messages only) |
| POST | `/api/chat/conversations/<cnv_id>/messages` · `/stop` · `/messages/<msg_id>/retry` · `/task-draft` | Send `{ content, provider?, model? }` (202; the answer streams) / stop / retry the latest failed or stopped response / draft a task (not saved) |
| GET | `/api/chat/conversations/<cnv_id>/stream` | Server-sent events: `sync`, `messages`, `context`, `delta`, `message`, `idle` |
| GET / POST | `/api/tasks` | The backlog in order (`?projectId&product&status=open|finished|<status>&q`; returns `rev`, `total`) / create `{ title, description, projectId, status, position, origin }` |
| GET / PATCH | `/api/tasks/<tsk_id>` | One task / `{ title, description, projectId }` (never reorders) |
| POST | `/api/tasks/<tsk_id>/status` · `/move` · `/start` | `{ status }` / `{ beforeId \| afterId \| top \| bottom, rev }` (409 + current list when stale) / explicit start: creates and links a run |
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
npm run validate  # check + build + test, no da-prompt or LLM involved (see "Command line" above)
npm run check     # static checks      ·  npm run build  # package/entry/import smoke
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
src/cli.js         entry: the CLI (src/cli/) or, for a bare idea, the legacy in-process runner (src/cli/legacy.js)
src/cli/           terminal client of the backend: client.js (HTTP/SSE), backend.js (start/stop), commands/*
src/runtime.js     server.json / lock / log: the single-instance backend record
scripts/           check.mjs and build.mjs: dependency-free static checks and package smoke test
docs/selfhost/     the self-hosting demonstration (stand-in model, script, transcripts)
public/            the web app
templates/         files the offline agents generate
```

Inspired by public ideas on "software factories". Not affiliated with or endorsed by
Cursor or its founders.
