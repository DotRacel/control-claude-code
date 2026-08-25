#!/usr/bin/env bash
# AskUserQuestion end to end on a real wire: injected interactive claude (tmux) + /rc, then
# answer the question from the web the way the phone does (allow + updatedInput.answers) and
# assert the model actually received the chosen option.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # so a git worktree tests ITS code
cd "$REPO"
rm -rf /tmp/ccc-q-logs
tmux kill-session -t ccq 2>/dev/null; sleep 0.5
tmux new-session -d -s ccq -n cli -x 200 -y 50
tmux new-window -t ccq -n srv "cd '$REPO'; exec node test/smoke-server.ts >/tmp/srv-q.log 2>&1"
sleep 3
source test/e2e-auth.sh
CRED=$(ccc_smoke_token) || exit 1
tmux send-keys -t ccq:cli "exec node src/control-cli.ts --log-dir /tmp/ccc-q-logs --server http://127.0.0.1:8790 --credential $CRED" Enter
sleep 18
tmux send-keys -t ccq:cli "/rc" Enter
sleep 8
echo "=== driving the question from web ==="
node test/question-client.ts "$CRED" 8790
RC=$?
echo; echo "=== TUI ==="; tmux capture-pane -t ccq:cli -p | grep -v "^$" | tail -10
tmux kill-session -t ccq 2>/dev/null
echo "e2e-question exit=$RC"
exit $RC
