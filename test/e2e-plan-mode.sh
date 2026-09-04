#!/usr/bin/env bash
# Plan-mode loop over the real `/rc` bridge: server + injected interactive claude (tmux) + /rc,
# then drive a plan-mode turn from a web client and dump the ExitPlanMode permission request.
#
# Why the whole tmux rig for one permission request: ExitPlanMode is disabled under `-p`, so
# only an interactive claude behind the bridge ever emits the ask this front-end has to render.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # so a git worktree tests ITS code
cd "$REPO"
SCENARIO="${1:-exit}"
ANSWER="${2:-allow}"
rm -rf /tmp/ccc-logs; rm -f /tmp/ccc-smoke-server.log
printf '#!/usr/bin/env bash\necho hello\n' > /tmp/ccc-plan-target.sh
tmux kill-session -t ccplan 2>/dev/null; sleep 0.5
tmux new-session -d -s ccplan -n cli -x 200 -y 50
tmux new-window -t ccplan -n srv "cd '$REPO'; exec node test/smoke-server.ts >/tmp/srv-stdout.log 2>&1"
sleep 3
source test/e2e-auth.sh
CRED=$(ccc_smoke_token) || exit 1
tmux send-keys -t ccplan:cli "exec ${CLAUDE_BIN:+env CLAUDE_BIN='$CLAUDE_BIN' }node src/control-cli.ts --log-dir /tmp/ccc-logs --server http://127.0.0.1:8790 --credential $CRED" Enter
sleep 18
tmux send-keys -t ccplan:cli "/rc" Enter
sleep 8
echo "=== injection HITs ==="; grep "HIT" /tmp/ccc-logs/latest.log
echo; echo "=== driving a plan-mode turn from the web client ==="
node test/plan-client.ts "$CRED" 8790 "$SCENARIO" "$ANSWER"
RC=$?
echo; echo "=== TUI ==="; tmux capture-pane -t ccplan:cli -p | grep -v "^$" | tail -12
tmux kill-session -t ccplan 2>/dev/null
echo "e2e-plan-mode exit=$RC"
exit $RC
