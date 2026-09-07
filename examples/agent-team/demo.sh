#!/usr/bin/env bash
# Three agents, one room, one Wordle.
#
#   ./demo.sh                 PERFORMANCE: a four-minute screenplay performed by
#                             three seats through a real room, doing real git
#                             work with code three agents really wrote. Never
#                             stalls, always ends with the game on screen.
#   ./demo.sh --live          LIVE: the three agents improvise the whole thing
#                             (real Claude Code / codex / grok sessions).
#   ./demo.sh --fast          performance without the dramatic pauses
#   ./demo.sh --dir PATH      choose/reuse the scratch directory
#   ./demo.sh --no-tmux       print the four commands to run yourself
#   ./demo.sh --reset         redo the plumbing in the same directory
#
# Live seats: ENGINE_CODEX=codex|claude, ENGINE_GROK=grok|claude (a seat
# without its CLI on PATH falls back to Claude Code wearing the persona and
# says so in its pane). Live mode spends your agents' tokens; performance
# mode spends nothing but a few room messages.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

DIR=""; USE_TMUX=1; RESET=""; MODE=perform; FAST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --live) MODE=live ;;
    --fast) FAST=1 ;;
    --dir) shift; DIR="${1:?--dir needs a path}" ;;
    --no-tmux) USE_TMUX=0 ;;
    --reset) RESET=--force ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
  shift
done
need run402; need node; need git
if [ "$MODE" = live ]; then
  need claude
  : "${ENGINE_CODEX:=}"; : "${ENGINE_GROK:=}"
  if [ -z "$ENGINE_CODEX" ]; then command -v codex >/dev/null 2>&1 && ENGINE_CODEX=codex || { ENGINE_CODEX=claude; warn "codex not on PATH — the Codex seat will be played by Claude Code"; }; fi
  if [ -z "$ENGINE_GROK" ];  then command -v grok  >/dev/null 2>&1 && ENGINE_GROK=grok   || { ENGINE_GROK=claude;  warn "grok not on PATH — the Grok seat will be played by Claude Code"; }; fi
  export ENGINE_CODEX ENGINE_GROK
fi

[ -n "$DIR" ] || DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-team.XXXXXX")
mkdir -p "$DIR"
export DEMO_DIR="$DIR" DEMO_FAST="$FAST"
DEMO_DIR="$DIR" bash "$HERE/setup.sh" $RESET
# shellcheck source=/dev/null
. "$DIR/env.sh"

printf '\n%s  THREE AGENTS, ONE ROOM, ONE WORDLE%s   %s(%s)%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$MODE" "$C_RESET"
printf '%s  dir   %s\n  room  %s%s\n' "$C_DIM" "$DIR" "$DEMO_ROOM" "$C_RESET"
[ "$MODE" = live ] && printf '%s  seats Grok=%s · Claude=claude · Codex=%s%s\n' "$C_DIM" "$ENGINE_GROK" "$ENGINE_CODEX" "$C_RESET"
printf '\n'

ENV="DEMO_DIR='$DIR' DEMO_FAST=$FAST ENGINE_CODEX='${ENGINE_CODEX:-}' ENGINE_GROK='${ENGINE_GROK:-}'"
# The room is also written to a file, so the conversation survives the panes.
T="$ENV bash '$HERE/transcript.sh' | tee '$DIR/transcript.txt'"
if [ "$MODE" = live ]; then
  G="$ENV bash '$HERE/agent.sh' grok"; A="$ENV bash '$HERE/agent.sh' claude"; B="$ENV bash '$HERE/agent.sh' codex"
else
  G="$ENV node '$HERE/actor.mjs' grok"; A="$ENV node '$HERE/actor.mjs' claude"; B="$ENV node '$HERE/actor.mjs' codex"
fi
HOLD="; printf '\n%s' '── pane finished — press enter to close ──'; read -r"

if [ "$USE_TMUX" = 1 ] && command -v tmux >/dev/null 2>&1; then
  S="agent-team-$$"
  if [ -n "${TMUX:-}" ]; then
    tmux new-window -n agent-team "$T$HOLD"; TARGET=agent-team
  else
    tmux new-session -d -s "$S" -x 260 -y 70 "$T$HOLD"; TARGET="$S"
  fi
  tmux split-window -v -t "$TARGET" -p 62 "$G$HOLD"
  tmux split-window -h -t "$TARGET" -p 66 "$A$HOLD"
  tmux split-window -h -t "$TARGET" -p 50 "$B$HOLD"
  tmux select-pane -t "$TARGET:.0"
  [ -n "${TMUX:-}" ] || tmux attach -t "$S"
else
  printf '%s\n' "Open four terminals and run, in this order (the room first):"
  printf '\n  %s# 1 · the room%s\n  %s\n' "$C_DIM" "$C_RESET" "$T"
  printf '\n  %s# 2 · Grok — brought the job%s\n  %s\n' "$C_DIM" "$C_RESET" "$G"
  printf '\n  %s# 3 · Claude — engine, and the merge%s\n  %s\n' "$C_DIM" "$C_RESET" "$A"
  printf '\n  %s# 4 · Codex — the TUI%s\n  %s\n\n' "$C_DIM" "$C_RESET" "$B"
fi
