#!/usr/bin/env bash
# LIVE mode — launch one improvising seat: agent.sh <grok|claude|codex>
#
# Each seat is a real headless coding-agent session handed its persona plus
# the shared protocol, in its own clone, with its own wallet and session key
# (see setup.sh). Which CLI plays which seat:
#
#   Claude  claude -p                       (always)
#   Codex   codex exec        or ENGINE_CODEX=claude → Claude Code wearing the persona
#   Grok    grok (xAI CLI)    or ENGINE_GROK=claude  → Claude Code wearing the persona
#
# A seat played by Claude Code says so in its pane header. The choreography is
# identical either way — the room does not know or care which model is typing.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
: "${DEMO_DIR:?set DEMO_DIR}"
: "${ENGINE_CODEX:=codex}"
: "${ENGINE_GROK:=grok}"
: "${AGENT_WALL:=30m}"
ROLE="${1:?agent.sh <grok|claude|codex>}"
require_setup
role_env "$ROLE"
NAME=$(role_name "$ROLE")
cd "$ROLE_WORK"

PROMPT="$DEMO_DIR/prompts/$ROLE.md"
mkdir -p "$DEMO_DIR/prompts"
{ cat "$HERE/prompts/$ROLE.md"; printf '\n\n'; cat "$HERE/prompts/protocol.md"; } > "$PROMPT"

printf '%s%s%s  %s\n' "$C_BOLD" "$NAME" "$C_RESET" "$(role_task "$ROLE")" >&2
printf '%s%s%s\n' "$C_DIM" "cwd $ROLE_WORK · room $DEMO_ROOM · wall $AGENT_WALL" "$C_RESET" >&2

run_claude() {
  # Explicit tool grants rather than --dangerously-skip-permissions: the seat
  # can run commands and edit files in its own clone, and nothing else is
  # pre-approved. (The dangerous flag is also refused under root, which is
  # what a CI or container demo often runs as.)
  timeout "$AGENT_WALL" claude -p \
    --output-format stream-json --verbose \
    --allowedTools "Bash Read Edit Write MultiEdit Glob Grep" \
    --max-turns 400 \
    < "$PROMPT" | node "$HERE/feed.mjs" "$NAME"
}

run_codex() {
  need codex
  # --full-auto approves edits and commands inside a workspace-write sandbox.
  timeout "$AGENT_WALL" codex exec --full-auto --skip-git-repo-check -C "$ROLE_WORK" "$(cat "$PROMPT")"
}

run_grok() {
  need grok
  # xAI's CLI takes the prompt as its argument; auto-approve inside the clone.
  timeout "$AGENT_WALL" grok --auto-approve -p "$(cat "$PROMPT")"
}

persona_by_claude() {
  warn "$NAME seat is a Claude Code session wearing the $NAME persona (ENGINE_$(echo "$ROLE" | tr a-z A-Z)=claude)"
  run_claude
}

case "$ROLE" in
  claude) run_claude ;;
  codex)  [ "$ENGINE_CODEX" = claude ] && persona_by_claude || run_codex ;;
  grok)   [ "$ENGINE_GROK"  = claude ] && persona_by_claude || run_grok ;;
  *) die "unknown role $ROLE" ;;
esac
