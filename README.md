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
| `FACTORY_PLANNER_MODEL` | same | Default planner model for that provider |
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
| `GITHUB_TOKEN` | — | Lets runs push the finished project to a repo URL |
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
| GET / POST | `/api/runs` | List runs / start a run `{ idea, requirements, stack, limits, tools, provider, model, plannerModel, providerOptions: { numCtx, temperature, toolMode }, settings, repoUrl }` |
| GET / DELETE | `/api/runs/:id` | Run state / delete run |
| GET | `/api/runs/:id/events` | Server-sent events (replays history, then live) |
| POST | `/api/runs/:id/resume` · `/cancel` · `/deploy` | Control the run / restart the preview |
| POST | `/api/runs/:id/tasks/:taskId/retry` | Escalation: retry, optionally `{ description, verify, acceptance }` |
| POST | `/api/runs/:id/tasks/:taskId/skip` | Escalation: skip and continue |
| GET | `/api/runs/:id/files[?path=]` | Workspace listing / file content |
| GET | `/api/runs/:id/report` · `/download/:file` | Report, `project.tar.gz`, `test-results.json` |
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
npm test          # graph, sandbox, prompt, providers (incl. full runs through mock Ollama/OpenAI servers), factory, HTTP API
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
