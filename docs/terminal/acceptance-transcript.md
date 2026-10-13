# Terminal acceptance run

- date: 2026-10-13T06:30:18.122Z
- host: linux/x64, node v22.22.0, shell `/bin/bash`
- repository under test: `/home/user/da-prompt` (project root authorized: `/home/user`)

### 1. Open the Terminal panel
**PASS** — sidebar link → #/terminal; the host-shell warning and project picker are shown

### 2. Select the da-prompt repository and open a terminal in it
**PASS** — header shows project "da-prompt" and cwd /home/user/da-prompt

### 3. Run `pwd` and `git status`
**PASS** — pwd printed the repository path; git status -sb printed the branch line

### 4. Run the repository's actual test command (`npm test`, the full suite)
**PASS** — exit 0 after 400s (tests 219, pass 219, fail 0, cancelled 0, skipped 0)

### 5. Inspect a Git diff
**PASS** — diff --stat and a file diff were rendered in the terminal

### 6. Run a real development command with an installed local tool (cargo, node, pax)
**PASS** — cargo, node and `node scripts/build.mjs` ran from the login shell; the real `pax` binary is on the terminal's PATH and answered --version

### 7. Interrupt a running process (Ctrl-C from the keyboard, then the Interrupt button)
**PASS** — `sleep 300` stopped by Ctrl-C (exit 130); `yes` stopped by the Interrupt button (exit 130)

### 8. Refresh the browser and reconnect to a running session
**PASS** — same session id, same shell pid 13293; the loop kept counting while the page was gone and continued after reattach

### 9. Close the session and verify its processes are cleaned up
**PASS** — pids 30297, 30300, 13293 were running before Close and are gone after; `ps` shows no `sleep 901/902`; the session list is empty

### 10. Stop the AI provider; the terminal still works
**PASS** — provider status went ready → unreachable; a new terminal opened and ran git/ls normally

### 11. Check tools (login-shell PATH diagnostics)
**PASS** — table rendered (2 tool rows)

**11/11 steps passed**
