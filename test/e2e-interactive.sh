#!/usr/bin/env bash
# Full interactive /rc loop: server + injected interactive claude (tmux) + /rc, then drive the
# connected session from a web client and confirm reply + owner semantics.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # so a git worktree tests ITS code
cd "$REPO"
rm -rf /tmp/ccc-logs; rm -f /tmp/ccc-smoke-server.log
tmux kill-session -t ccint 2>/dev/null; sleep 0.5
tmux new-session -d -s ccint -n cli -x 200 -y 50
tmux new-window -t ccint -n srv "cd '$REPO'; exec node test/smoke-server.ts >/tmp/srv-stdout.log 2>&1"
sleep 3
source test/e2e-auth.sh
CRED=$(ccc_smoke_token) || exit 1
# CLAUDE_BIN is forwarded into the pane rather than merely exported here: the pane's shell comes
# from the tmux SERVER's environment, not ours, so an export in this script does not reach it. It
# matters whenever the installed `latest` is the thing that is broken and you want to prove the
# loop against a version you know is good.
tmux send-keys -t ccint:cli "exec ${CLAUDE_BIN:+env CLAUDE_BIN='$CLAUDE_BIN' }node src/control-cli.ts --log-dir /tmp/ccc-logs --server http://127.0.0.1:8790 --credential $CRED" Enter
sleep 18
tmux send-keys -t ccint:cli "/rc" Enter
sleep 8
echo "=== injection HITs ==="; grep "HIT" /tmp/ccc-logs/latest.log
echo; echo "=== driving from web client ==="
node test/webclient.ts "$CRED" 8790
RC=$?
echo; echo "=== TUI ==="; tmux capture-pane -t ccint:cli -p | grep -v "^$" | tail -8
# The /rc line and its QR, whole. `-e` keeps the escape sequences so this also answers the one
# question static reading cannot: whether claude's ink fork passes our per-line black-on-white
# through to the terminal, or eats it and leaves the code in the theme's grey.
echo; echo "=== /rc link + QR (glyphs) ==="
tmux capture-pane -t ccint:cli -p -S -80 | grep -A 20 "remote-control is active" | head -24
echo; echo "=== /rc QR (with escapes) ==="
tmux capture-pane -t ccint:cli -p -e -S -80 | grep -m 1 -A 3 "remote-control is active" | cat -v | cut -c1-200
tmux kill-session -t ccint 2>/dev/null
echo "e2e exit=$RC"
