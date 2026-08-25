#!/usr/bin/env bash
# Verify transcript backfill: establish a word in the TUI BEFORE /rc, then have a web client
# subscribe AFTER /rc and confirm it receives the pre-/rc history.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # so a git worktree tests ITS code
cd "$REPO"
rm -rf /tmp/ccc-logs; rm -f /tmp/ccc-smoke-server.log
tmux kill-session -t cche 2>/dev/null; sleep 0.5
tmux new-session -d -s cche -n cli -x 200 -y 50
tmux new-window -t cche -n srv "cd '$REPO'; exec node test/smoke-server.ts >/tmp/srv-stdout.log 2>&1"
sleep 3
source test/e2e-auth.sh
CRED=$(ccc_smoke_token) || exit 1
tmux send-keys -t cche:cli "exec node src/control-cli.ts --log-dir /tmp/ccc-logs --server http://127.0.0.1:8790 --credential $CRED" Enter
sleep 15
tmux send-keys -t cche:cli "Reply with exactly the word SECRETMANGO99 and nothing else." Enter
sleep 42
tmux send-keys -t cche:cli "/rc" Enter
sleep 10
echo "=== web subscribes AFTER /rc — should backfill the pre-/rc history ==="
node test/webclient.ts "$CRED" 8790 "say the word DONE"
RC=$?
tmux kill-session -t cche 2>/dev/null
echo "e2e exit=$RC"
