#!/usr/bin/env bash
# The projector: a live transcript of the room, one line per message, colour
# per speaker. Joins as "Audience" on the client's wallet with its own session
# key so it never resumes an actor's presence. The agents are told to ignore it.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
: "${DEMO_DIR:?set DEMO_DIR}"
require_setup
export RUN402_CONFIG_DIR="$DEMO_DIR/cfg/grok"
export RUN402_SESSION_KEY="agent-team-audience"
mkdir -p "$DEMO_DIR/work/audience"
cp "$DEMO_DIR/work/grok/.run402.json" "$DEMO_DIR/work/audience/.run402.json"
cd "$DEMO_DIR/work/audience"

hue() { case "$1" in Grok) printf "%s" "$C_YELLOW" ;; Claude) printf "%s" "$C_CYAN" ;; Codex) printf "%s" "$C_GREEN" ;; *) printf "%s" "$C_MAGENTA" ;; esac; }

run402 rooms join --name Audience --task "the projector" > join.json
printf '%s  THE ROOM  %s%s%s\n' "$C_BOLD" "$C_DIM" "$DEMO_ROOM" "$C_RESET"
node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  // rooms join reports the roster under "presences" (the arrival view); a
  // claim or send response calls the same list "live_presences".
  const live = (j.presences ?? j.live_presences ?? []).filter((p) => p.name !== "Audience").map((p) => p.name + (p.task ? " (" + p.task + ")" : ""));
  console.log("  live: " + (live.length ? live.join(" · ") : "nobody yet"));
' join.json
printf '%s  ─────────────────────────────────────────────────────────────────────%s\n\n' "$C_DIM" "$C_RESET"

# Start from the beginning of the room so the brief is on screen even if the
# projector came up a beat late.
CURSOR_FLAG=""
FIRST=1
while :; do
  if [ "$FIRST" = 1 ]; then
    run402 messages list --json > page.json 2>/dev/null || true
    FIRST=0
  else
    run402 messages wait --timeout 60 --json > page.json 2>/dev/null || true
  fi
  N=$(jget page.json messages.length)
  [ -z "$N" ] && N=0
  i=0
  while [ "$i" -lt "$N" ]; do
    ID=$(jget page.json "messages.$i.message_id")
    S=$(jget page.json "messages.$i.sender")
    T=$(jget page.json "messages.$i.created_at")
    TR=$(jget page.json "messages.$i.body_truncated")
    if [ "$TR" = "true" ]; then
      run402 messages get "$ID" > full.json 2>/dev/null && B=$(jget full.json body) || B=$(jget page.json "messages.$i.body_snippet")
    else
      B=$(jget page.json "messages.$i.body_snippet")
    fi
    TO=$(node -e '
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const r = j.messages[Number(process.argv[2])].recipients ?? [];
      process.stdout.write(r.map((x) => x.name ?? x).join(","));
    ' page.json "$i")
    [ "$S" = "Audience" ] && { i=$((i + 1)); continue; }
    printf '%s%s%s  %s%-7s%s%s\n' "$C_DIM" "${T:11:8}" "$C_RESET" "$(hue "$S")$C_BOLD" "$S" "$C_RESET" "$( [ -n "$TO" ] && printf ' %s→ %s%s' "$C_DIM" "$TO" "$C_RESET" )"
    printf '%s\n' "$B" | node -e '
      let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
        const w = 100;
        for (let line of d.replace(/\s+$/, "").split("\n")) {
          while (line.length > w) { const cut = line.lastIndexOf(" ", w); const at = cut > 20 ? cut : w; console.log("          " + line.slice(0, at)); line = line.slice(at).trimStart(); }
          console.log("          " + line);
        }
      });'
    printf '\n'
    i=$((i + 1))
  done
done
