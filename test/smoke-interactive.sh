#!/usr/bin/env bash
# Interactive /rc smoke test driver: runs the controller server + an injected interactive
# claude in tmux, sends /rc, and dumps the injection log + every server request + the TUI.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # so a git worktree tests ITS code
cd "$REPO"
rm -rf /tmp/ccc-logs; rm -f /tmp/ccc-smoke-server.log /tmp/srv-stdout.log /tmp/ccc-smoke-token
tmux kill-session -t ccsmoke 2>/dev/null; sleep 0.5
tmux new-session -d -s ccsmoke -n cli -x 200 -y 50
tmux new-window -t ccsmoke -n srv "cd '$REPO'; exec node test/smoke-server.ts >/tmp/srv-stdout.log 2>&1"
sleep 3
# The credential is issued by the server now; smoke-server.ts drops it here on startup.
CRED=$(cat /tmp/ccc-smoke-token 2>/dev/null)
[ -n "$CRED" ] || { echo "smoke-server did not write a token — check /tmp/srv-stdout.log"; cat /tmp/srv-stdout.log; exit 1; }
tmux send-keys -t ccsmoke:cli "CCC_CLAUDE_DEBUG=1 exec node src/control-cli.ts --log-dir /tmp/ccc-logs --server http://127.0.0.1:8790 --credential $CRED" Enter
sleep 18
tmux send-keys -t ccsmoke:cli "/rc" Enter
sleep "${1:-12}"
echo "=== injection log ==="; cat /tmp/ccc-logs/latest.log 2>/dev/null
echo; echo "=== server (http + events) ==="; cat /tmp/ccc-smoke-server.log 2>/dev/null
echo; echo "=== srv stderr ==="; grep -iE "error|throw|Cannot|undefined" /tmp/srv-stdout.log 2>/dev/null | head
echo; echo "=== TUI ==="; tmux capture-pane -t ccsmoke:cli -p 2>/dev/null | grep -v "^$" | tail -14
echo; echo "=== claude bridge debug ==="; grep -iE "bridge|oauth|preflight|precondition|remote.control|no.token|enroll" /tmp/ccc-logs/latest.claude.log 2>/dev/null | tail -40
tmux kill-session -t ccsmoke 2>/dev/null
echo EXIT_OK
