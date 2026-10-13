#!/usr/bin/env bash
# Reproduces the self-hosting demonstration: da-prompt (this checkout's CLI) changes da-prompt's own source, in a
# clean clone, with a scripted stand-in model. Usage: docs/selfhost/run.sh <work-dir> > transcript.txt
# Needs: node >= 20, git. No network, no API keys.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
W="${1:?work dir}"
mkdir -p "$W" && W="$(cd "$W" && pwd)"
export DA_PROMPT_CONFIG_DIR="$W/cfg" FACTORY_DATA_DIR="$W/data" HOST=127.0.0.1 PORT="${PORT:-39555}" NO_COLOR=1
unset ANTHROPIC_API_KEY OPENAI_API_KEY GITHUB_TOKEN GH_TOKEN
dp() { node "$REPO/src/cli.js" "$@"; }
step() { printf '\n$ %s\n' "$*"; "$@"; rc=$?; printf '[exit %s]\n' "$rc"; return 0; }
say() { printf '\n# %s\n' "$*"; }

say "A clean clone of the repository, inside the only folder da-prompt is authorized to read"
rm -rf "$W/projects" && mkdir -p "$W/projects"
step git clone -q "$REPO" "$W/projects/da-prompt"
( cd "$W/projects/da-prompt" && git checkout -q "$(git -C "$REPO" rev-parse HEAD)" 2>/dev/null; git status -sb | head -3; git log --oneline | head -1 )

say "The stand-in model (an OpenAI-compatible server; see docs/selfhost/scripted-model.mjs)"
MODEL_URL="$(node "$REPO/docs/selfhost/scripted-model.mjs" > "$W/model.url" 2>/dev/null & echo $! > "$W/model.pid"; for _ in $(seq 50); do [ -s "$W/model.url" ] && break; sleep 0.1; done; cat "$W/model.url")"
echo "model endpoint: $MODEL_URL"

say "Configure through the CLI only"
step dp server start
step dp config set projectRoots "$W/projects"
# The repository's own suite takes ~3 minutes; the default per-command limit is 3 minutes.
step dp config set commandTimeoutMs 900000
step dp providers add --label "Scripted stand-in" --provider-url "$MODEL_URL"
PID="$(dp providers list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).providers.find(p=>/Scripted/.test(p.label)).id))')"
step dp providers test "$PID" --model scripted-selfhost
step dp providers use "$PID" --model scripted-selfhost
step dp projects list
step dp projects use "$W/projects/da-prompt"
step dp projects current
step dp doctor

say "Start the task (bounded, with an explicit acceptance criterion)"
TASK='Make redact() in src/security.js also mask "Bearer <token>" and "x-api-key" header values. Acceptance: redact("Authorization: Bearer abcdefghijklmnop1234567890") returns "Authorization: Bearer ***"; redact("x-api-key: abcdef1234567890zzzz") returns "x-api-key: ***"; every existing redaction is unchanged; a new test/redact.test.js covers both cases and node --test test/redact.test.js passes.'
printf '\n$ dp run "%s" --attempts 2 --wait-timeout 1500\n' "$TASK"
dp run "$TASK" --attempts 2 --wait-timeout 1500 | tee "$W/run.out"; echo "[exit ${PIPESTATUS[0]}]"
RUN="$(grep -Eo '[0-9]{12}-[0-9a-f]{6}' "$W/run.out" | head -1)"
echo "run id: $RUN"

say "Inspect: tasks, files, diff, the factory's checks, and the evidence (agent claims / factory verification / PAX kept apart)"
step dp runs list
step dp runs tasks "$RUN"
step dp runs files "$RUN"
step dp runs diff "$RUN"
step dp runs tests "$RUN"
step dp runs evidence "$RUN"

say "The working tree is untouched until approval + explicit apply"
step git -C "$W/projects/da-prompt" status --short
step dp runs apply "$RUN" --yes
step dp runs review "$RUN" approve --note "reviewed the diff above: two replacements and a test file"
step dp runs apply "$RUN"
step dp runs apply "$RUN" --yes
step git -C "$W/projects/da-prompt" status --short
step git -C "$W/projects/da-prompt" diff --stat

say "Independent validation with ordinary npm, no da-prompt involved"
( cd "$W/projects/da-prompt" && printf '\n$ npm run check\n' && npm run check 2>&1 | tail -4; echo "[exit ${PIPESTATUS[0]}]" )
( cd "$W/projects/da-prompt" && printf '\n$ node --test test/redact.test.js test/sandbox.test.js\n' && node --test test/redact.test.js test/sandbox.test.js 2>&1 | grep -E '^# (tests|pass|fail)'; echo "[exit ${PIPESTATUS[0]}]" )

say "Shut down"
step dp server stop
kill "$(cat "$W/model.pid")" 2>/dev/null
step dp server status
