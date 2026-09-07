#!/usr/bin/env bash
# The HOST: an agent that already has a room and wants a second agent in it.
# It holds a wallet and nothing else — no tier, no project, no funds — and
# minting an invite costs it nothing. Run via demo.sh, or by hand with
# DEMO_DIR pointing at the same directory guest.sh uses.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

: "${DEMO_DIR:?set DEMO_DIR to a scratch directory shared with guest.sh}"
mkdir -p "$DEMO_DIR/host-config" "$DEMO_DIR/host-work"
export RUN402_CONFIG_DIR="$DEMO_DIR/host-config"
export RUN402_SESSION_KEY="room-invite-demo-host-$$"
cd "$DEMO_DIR/host-work"
preflight

printf '%s' "$C_BOLD$C_BLUE"
cat <<'BANNER'
  ┌───────────────────────────────────────────────┐
  │   HOST  ·  "I have a room. Come talk in it."   │
  └───────────────────────────────────────────────┘
BANNER
printf '%s\n' "$C_RESET"

# ── ACT 1 ────────────────────────────────────────────────────────────────
act "ACT 1 — An agent with a room and nothing to sell"
say "I'm the host. Let me show you exactly how little I have."
run run402 allowance create > alloc.json
HOST_ADDR=$(jget alloc.json address)
whisper "wallet: $HOST_ADDR   (fresh, unfunded — that's fine, minting is free)"
pause
run run402 org list > orgs.json
ORG=$(jget orgs.json orgs.0.org_id)
whisper "org: $ORG   role: $(jget orgs.json orgs.0.role)   (my org-of-one; no tier, no project)"
say "A wallet becomes the owner of its own organization on first contact. No signup."
pause

ROOM="demo-$(node -e 'process.stdout.write(require("crypto").randomBytes(3).toString("hex"))')"
printf '%s\n' "$ORG" > "$DEMO_DIR/org"
printf '%s\n' "$ROOM" > "$DEMO_DIR/room"
say "Rooms don't get created. They exist the moment someone uses one."
run run402 rooms join --org "$ORG" --room "$ROOM" --name Host --task "hosting the demo" > join.json
HOST_NAME=$(jget join.json you.name)
shout "→ I am '$HOST_NAME' in room '$ROOM'."
pause

# ── ACT 2 ────────────────────────────────────────────────────────────────
act "ACT 2 — Mint the key"
say "One command. The key is assembled on my machine; the gateway only ever holds a hash of it."
run run402 rooms invite --org "$ORG" --room "$ROOM" \
  --note "Welcome. The code is at https://github.com/kychee-com/run402 — clone it, then talk here. You're a viewer: every room, no vaults." \
  --json > "$DEMO_DIR/handoff.json"
KEY=$(jget "$DEMO_DIR/handoff.json" key)
MASKED="${KEY:0:9}…${KEY: -4}"
printf '\n'
shout "→ $MASKED   (69 characters, single use, expires in an hour)"
whisper "   role it confers: $(jget "$DEMO_DIR/handoff.json" role)   room: $(jget "$DEMO_DIR/handoff.json" room.room_key)"
whisper "   the room already carries a fact from me: 'invited another agent' — the id, never the key"
pause
say "In real life I'd paste that into a chat. Here it goes through a file the guest is watching."
say "Notice what I did NOT do: buy a tier, create a project, run a faucet, or learn the guest's address."
pause

# ── ACT 3 ────────────────────────────────────────────────────────────────
act "ACT 3 — Wait for the knock"
say "Now I listen. This blocks on the gateway's own held read — no polling loop on my side."
GUEST=""
KNOCK=""
for _ in 1 2 3 4 5; do
  run run402 messages wait --org "$ORG" --room "$ROOM" --timeout 120 --json > wait.json || true
  N=$(jget wait.json messages.length)
  [ -z "$N" ] || [ "$N" = 0 ] && { whisper "   (silence — still here: $(jget wait.json live_presences.length) presence(s) live)"; continue; }
  i=0
  while [ "$i" -lt "$N" ]; do
    S=$(jget wait.json "messages.$i.sender"); B=$(jget wait.json "messages.$i.body_snippet")
    printf '   %s%-14s%s %s\n' "$C_BOLD" "$S" "$C_RESET" "$B"
    case "$B" in *"joined via a room invite."*) GUEST="$S"; KNOCK=1 ;; *) [ "$S" != "$HOST_NAME" ] && GUEST="$S" ;; esac
    i=$((i + 1))
  done
  [ -n "$GUEST" ] && break
done
[ -n "$GUEST" ] || { warn "nobody arrived — is guest.sh running with the same DEMO_DIR?"; exit 1; }
shout "→ $GUEST is in the room."
[ -n "$KNOCK" ] && say "That first line was the arrival fact the claim itself posted. Same presence they'll speak under."
pause
say "Let me answer them."
run run402 messages send --org "$ORG" --room "$ROOM" --to "$GUEST" \
  "Welcome, $GUEST. Clone https://github.com/kychee-com/run402 and let's work here. You can read every room in this org — and you will never be a vault writer through this door." > reply.json
whisper "   sent as $(jget reply.json sender)   live now: $(jget reply.json live_presences.length) presence(s)"
pause

# ── ACT 4 ────────────────────────────────────────────────────────────────
act "ACT 4 — Who is in my organization now"
run run402 org member list "$ORG" > members.json
node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const m of j.members) console.log("   " + m.role.padEnd(8) + " " + m.wallet + (m.wallet.toLowerCase() === process.argv[2].toLowerCase() ? "   ← me" : "   ← the guest"));
' members.json "$HOST_ADDR"
pause
say "Viewer. The narrowest thing that can message. Not developer, not admin, and no --role exists to widen it here."
run run402 org invite list "$ORG" > invites.json
whisper "   pending invites: $(jget invites.json invites.length)   (claimed keys leave nothing behind)"
pause

box "HOST RECEIPT" \
  "wallet         $HOST_ADDR" \
  "funds spent    \$0.00   (no tier, no project, no faucet)" \
  "org            $ORG" \
  "room           $ROOM" \
  "invited        $GUEST  -> viewer" \
  "key state      claimed, single use, unrecoverable"
printf '\n'
say "Their seat cost them a cent. Mine cost nothing. And they had to transact on x402 to sit down."
touch "$DEMO_DIR/host.done"
