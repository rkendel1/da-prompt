#!/usr/bin/env bash
# Exercises `da-prompt pax …` against a REAL pax binary (not a stand-in).
# Usage: PAX_DIR=/path/to/dir/containing/pax docs/selfhost/pax-validation.sh <work-dir>
# The directory is put on the backend's PATH (it is the host's own pax; nothing is installed or copied).
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
W="${1:?work dir}"; mkdir -p "$W"; W="$(cd "$W" && pwd)"
export DA_PROMPT_CONFIG_DIR="$W/cfg" FACTORY_DATA_DIR="$W/data" HOST=127.0.0.1 PORT="${PORT:-39556}" NO_COLOR=1
unset ANTHROPIC_API_KEY OPENAI_API_KEY GITHUB_TOKEN GH_TOKEN
dp() { node "$REPO/src/cli.js" "$@"; }
step() { printf '\n$ %s\n' "$*"; "$@"; printf '[exit %s]\n' "$?"; return 0; }
mkdir -p "$W/projects/app" && cd "$W/projects/app" && git init -q -b main && printf '{"name":"app","version":"1.0.0","scripts":{"test":"node -e 0"}}\n' > package.json && git add -A && git -c user.name=t -c user.email=t@t commit -qm init && cd "$REPO"
echo "# pax on PATH of the backend: $(PATH="$PAX_DIR:$PATH" command -v pax)"
export PATH="$PAX_DIR:$PATH"
step dp config set projectRoots "$W/projects"
step dp pax status
RUN="$(dp run 'record a note' --project "$W/projects/app" --provider offline --detach --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
until dp runs show "$RUN" --json | grep -q '"executing": false'; do sleep 1; done
step dp pax verify "$RUN" --steps info,doctor,reality,drift,graph,test-plan
step dp pax evidence "$RUN"
step dp runs artifacts "$RUN"
echo; echo "# explicit path, saved with config; then an executable that is not PAX"
step dp pax probe "$PAX_DIR/pax"
step dp pax probe /bin/ls
step dp server stop
