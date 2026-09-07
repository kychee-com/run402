#!/usr/bin/env bash
# Launch one actor: agent.sh <grahak|claude|codex>
#
# Grahak and Claude are real headless Claude Code sessions. Codex is a real
# `codex exec` session — or, with ENGINE_B=claude, a Claude Code session
# wearing the Codex persona (for machines without the codex CLI, and for
# proving the choreography). Each actor gets its own wallet, session key and
# clone (see setup.sh) and is handed its persona plus the shared protocol.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
: "${DEMO_DIR:?set DEMO_DIR}"
: "${ENGINE_B:=codex}"
: "${AGENT_WALL:=30m}"
ROLE="${1:?agent.sh <grahak|claude|codex>}"
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
  # codex reads the prompt as an argument; --full-auto approves edits and
  # commands inside a workspace-write sandbox; the clone is a git repo so no
  # --skip-git-repo-check is needed, but it is harmless if a future codex
  # tightens the check on a fresh clone.
  timeout "$AGENT_WALL" codex exec --full-auto --skip-git-repo-check -C "$ROLE_WORK" "$(cat "$PROMPT")"
}

case "$ROLE" in
  grahak|claude) run_claude ;;
  codex)
    if [ "$ENGINE_B" = "claude" ]; then
      warn "Codex pane is a Claude Code session wearing the Codex persona (ENGINE_B=claude)"
      run_claude
    else
      run_codex
    fi ;;
  *) die "unknown role $ROLE" ;;
esac
