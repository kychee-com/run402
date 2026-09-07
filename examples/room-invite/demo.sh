#!/usr/bin/env bash
# Room Invite — the two-agent demo, against production, in one command.
#
#   ./demo.sh              two tmux panes: HOST on the left, GUEST on the right
#   ./demo.sh --fast       no typewriter, no dramatic pauses
#   ./demo.sh --no-tmux    print the two commands to run in two terminals
#   ./demo.sh --dir PATH   reuse/choose the scratch directory
#
# Everything runs in isolated config directories under the scratch dir — your
# own ~/.config/run402 wallet is never read or written. The only money that
# moves is testnet USDC from the public faucet: the guest receives $0.25 and
# spends $0.01. Nothing durable is created on the platform: no tier, no
# project; one org-of-one per wallet (which every wallet gets on first
# contact anyway) and one viewer membership.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

FAST=0; USE_TMUX=1; DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fast) FAST=1 ;;
    --no-tmux) USE_TMUX=0 ;;
    --dir) shift; DIR="${1:?--dir needs a path}" ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) printf 'unknown flag: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$DIR" ] || DIR=$(mktemp -d "${TMPDIR:-/tmp}/room-invite-demo.XXXXXX")
mkdir -p "$DIR"
export DEMO_DIR="$DIR" DEMO_FAST="$FAST"
# Start clean: a stale handoff from a previous run would let the guest skip
# the wait and claim a key that is already spent.
rm -f "$DIR/handoff.json" "$DIR/host.done" "$DIR/guest.done" "$DIR/org" "$DIR/room"

# shellcheck source=lib.sh
. "$HERE/lib.sh"
preflight

printf '\n%s  ROOM INVITE — two agents, one paste, one cent%s\n' "$C_BOLD" "$C_RESET"
printf '%s  scratch dir: %s%s\n' "$C_DIM" "$DIR" "$C_RESET"
printf '%s  api:         %s%s\n\n' "$C_DIM" "$RUN402_API_BASE" "$C_RESET"

HOST_CMD="DEMO_DIR='$DIR' DEMO_FAST=$FAST bash '$HERE/host.sh'"
GUEST_CMD="DEMO_DIR='$DIR' DEMO_FAST=$FAST bash '$HERE/guest.sh'"
HOLD="; printf '\n%s' '── done — press enter to close this pane ──'; read -r"

if [ "$USE_TMUX" = 1 ] && command -v tmux >/dev/null 2>&1; then
  if [ -n "${TMUX:-}" ]; then
    # Already inside tmux: use the current window.
    tmux split-window -h "$GUEST_CMD$HOLD"
    tmux select-pane -L
    tmux send-keys "clear; $HOST_CMD$HOLD" C-m
  else
    SESSION="room-invite-$$"
    tmux new-session -d -s "$SESSION" -x 240 -y 60 "$HOST_CMD$HOLD"
    tmux split-window -h -t "$SESSION" "$GUEST_CMD$HOLD"
    tmux select-layout -t "$SESSION" even-horizontal
    tmux select-pane -t "$SESSION:0.0"
    tmux attach -t "$SESSION"
  fi
else
  printf '%s\n' "tmux not used. Open two terminals and run, in this order:"
  printf '\n  %s# terminal 1 — the host%s\n  %s\n' "$C_DIM" "$C_RESET" "$HOST_CMD"
  printf '\n  %s# terminal 2 — the guest%s\n  %s\n\n' "$C_DIM" "$C_RESET" "$GUEST_CMD"
fi
