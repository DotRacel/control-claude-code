#!/usr/bin/env bash
# Does the REPL bridge replay the pre-/rc conversation to the data-plane? Establish a
# distinctive word in the TUI BEFORE /rc, then check whether the server sees it after /rc.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # so a git worktree tests ITS code
cd "$REPO"
rm -rf /tmp/ccc-logs; rm -f /tmp/ccc-smoke-server.log
tmux kill-session -t cchist 2>/dev/null; sleep 0.5
tmux new-session -d -s cchist -n cli -x 200 -y 50
tmux new-window -t cchist -n srv "cd '$REPO'; exec node test/smoke-server.ts >/tmp/srv-stdout.log 2>&1"
sleep 3
source test/e2e-auth.sh
CRED=$(ccc_smoke_token) || exit 1
tmux send-keys -t cchist:cli "exec node src/control-cli.ts --log-dir /tmp/ccc-logs --server http://127.0.0.1:8790 --credential $CRED" Enter
sleep 15
# establish history BEFORE /rc
tmux send-keys -t cchist:cli "Reply with exactly the word SECRETBANANA42 and nothing else." Enter
sleep 42
# now open remote control
tmux send-keys -t cchist:cli "/rc" Enter
sleep 10
echo "=== pre-/rc history word present in server events? (count) ==="
grep -c "SECRETBANANA42" /tmp/ccc-smoke-server.log
echo "=== event payload types the server received ==="
grep -oE '"type":"[a-z_]+"' /tmp/ccc-smoke-server.log | sort | uniq -c
echo "=== first few claude.event lines ==="
grep "claude.event" /tmp/ccc-smoke-server.log | head -6 | sed 's/.\{240\}/&…/'
echo "=== TUI ==="; tmux capture-pane -t cchist:cli -p | grep -v "^$" | tail -8
tmux kill-session -t cchist 2>/dev/null
