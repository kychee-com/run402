#!/usr/bin/env bash
# Three agents, one room, one Wordle.
#
#   ./demo.sh                  set up (once) and open tmux: the room on top,
#                              Grahak | Claude | Codex below
#   ./demo.sh --engine-b claude   run the Codex seat as a Claude Code session
#                              wearing the Codex persona (no codex CLI needed)
#   ./demo.sh --dir PATH       choose/reuse the scratch directory
#   ./demo.sh --no-tmux        print the four commands to run yourself
#   ./demo.sh --reset          redo the plumbing in the same directory
#
# Real agents, real tokens: Grahak and Claude are headless Claude Code
# sessions on your account; Codex is `codex exec` on yours. The job — a
# terminal Wordle — is the excuse. The room is the point.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

DIR=""; USE_TMUX=1; RESET=""; ENGINE_B="${ENGINE_B:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) shift; DIR="${1:?--dir needs a path}" ;;
    --engine-b) shift; ENGINE_B="${1:?--engine-b codex|claude}" ;;
    --no-tmux) USE_TMUX=0 ;;
    --reset) RESET=--force ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
  shift
done
need run402; need node; need git; need claude
if [ -z "$ENGINE_B" ]; then
  if command -v codex >/dev/null 2>&1; then ENGINE_B=codex; else ENGINE_B=claude; warn "codex not on PATH — the Codex seat will be played by Claude Code (--engine-b claude)"; fi
fi
[ "$ENGINE_B" = codex ] && need codex
export ENGINE_B

[ -n "$DIR" ] || DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-team.XXXXXX")
mkdir -p "$DIR"
export DEMO_DIR="$DIR"
DEMO_DIR="$DIR" bash "$HERE/setup.sh" $RESET
# shellcheck source=/dev/null
. "$DIR/env.sh"

printf '\n%s  THREE AGENTS, ONE ROOM, ONE WORDLE%s\n' "$C_BOLD" "$C_RESET"
printf '%s  dir   %s\n  room  %s\n  seats Grahak=claude · Claude=claude · Codex=%s%s\n\n' "$C_DIM" "$DIR" "$DEMO_ROOM" "$ENGINE_B" "$C_RESET"

ENV="DEMO_DIR='$DIR' ENGINE_B='$ENGINE_B'"
# The room is also written to a file, so the conversation survives the panes.
T="$ENV bash '$HERE/transcript.sh' | tee '$DIR/transcript.txt'"
G="$ENV bash '$HERE/agent.sh' grahak"
A="$ENV bash '$HERE/agent.sh' claude"
B="$ENV bash '$HERE/agent.sh' codex"
HOLD="; printf '\n%s' '── pane finished — press enter to close ──'; read -r"

if [ "$USE_TMUX" = 1 ] && command -v tmux >/dev/null 2>&1; then
  S="agent-team-$$"
  if [ -n "${TMUX:-}" ]; then
    tmux new-window -n agent-team "$T$HOLD"
  else
    tmux new-session -d -s "$S" -x 260 -y 70 "$T$HOLD"
  fi
  TARGET=${TMUX:+agent-team}; TARGET=${TARGET:-$S}
  tmux split-window -v -t "$TARGET" -p 62 "$G$HOLD"
  tmux split-window -h -t "$TARGET" -p 66 "$A$HOLD"
  tmux split-window -h -t "$TARGET" -p 50 "$B$HOLD"
  tmux select-pane -t "$TARGET:.0"
  [ -n "${TMUX:-}" ] || tmux attach -t "$S"
else
  printf '%s\n' "Open four terminals and run, in this order (the room first):"
  printf '\n  %s# 1 · the room%s\n  %s\n' "$C_DIM" "$C_RESET" "$T"
  printf '\n  %s# 2 · Grahak, the client%s\n  %s\n' "$C_DIM" "$C_RESET" "$G"
  printf '\n  %s# 3 · Claude, lead engineer%s\n  %s\n' "$C_DIM" "$C_RESET" "$A"
  printf '\n  %s# 4 · Codex, engineer%s\n  %s\n\n' "$C_DIM" "$C_RESET" "$B"
fi
