#!/usr/bin/env bash
# The GUEST: an agent on a machine with nothing on it — no wallet, no account,
# no config — holding one pasted string. One command later it has paid a
# one-cent seat on Base Sepolia via x402 and is talking in the host's room.
# Run via demo.sh, or by hand with DEMO_DIR shared with host.sh.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

: "${DEMO_DIR:?set DEMO_DIR to a scratch directory shared with host.sh}"
: "${DEMO_SPENT_KEY_CHECK:=1}"
mkdir -p "$DEMO_DIR/guest-config" "$DEMO_DIR/guest-work"
export RUN402_CONFIG_DIR="$DEMO_DIR/guest-config"
export RUN402_SESSION_KEY="room-invite-demo-guest-$$"
cd "$DEMO_DIR/guest-work"
preflight

printf '%s' "$C_BOLD$C_YELLOW"
cat <<'BANNER'
  ┌───────────────────────────────────────────────┐
  │   GUEST  ·  "I have a string. That's it."      │
  └───────────────────────────────────────────────┘
BANNER
printf '%s\n' "$C_RESET"

# ── ACT 1 ────────────────────────────────────────────────────────────────
act "ACT 1 — A machine with nothing on it"
say "No wallet. No account. No config. Let me prove it."
run ls -A "$RUN402_CONFIG_DIR"
whisper "   (empty)"
run ls -A .
whisper "   (empty — a plain directory, not even a git repo)"
pause
say "I'm waiting for someone to hand me a key."
await_file "$DEMO_DIR/handoff.json" 300
KEY=$(jget "$DEMO_DIR/handoff.json" key)
INVITE_ID=$(jget "$DEMO_DIR/handoff.json" invite_id)
MASKED="${KEY:0:9}…${KEY: -4}"
shout "→ got one: $MASKED"
pause

# ── ACT 2 ────────────────────────────────────────────────────────────────
act "ACT 2 — What the door asks for"
say "Before paying anything, let me knock with nothing and read what comes back."
run curl -s -X POST "$RUN402_API_BASE/rooms/v1/invites/$INVITE_ID/claim" \
  -H 'content-type: application/json' -d '{}' > challenge.json
printf '\n'
jshow challenge.json code price message next_actions.0.type
printf '\n'
say "A real HTTP 402. One cent, testnet USDC, Base Sepolia. Not a tier. Not a subscription. A seat."
say "And it's not on the platform's discovery list — you can't shop for this. You need the key."
pause

# ── ACT 3 ────────────────────────────────────────────────────────────────
act "ACT 3 — One command"
say "Watch the left margin: wallet, faucet, payment, arrival — all inside this one call."
printf '\n'
run run402 rooms join "$KEY" --json > join.json
printf '\n'
ADDR=$(run402 allowance export | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).address))')
ME=$(jget join.json presence.name)
shout "→ I am '$ME', a $(jget join.json membership.role) of org $(jget join.json org_id)"
printf '\n'
jshow join.json inviter.name room.room_key seat.amount_usd_micros seat.network deduplicated
printf '\n'
printf '   %snote from the host:%s %s\n' "$C_BOLD" "$C_RESET" "$(jget join.json note)"
printf '\n'
say "The room's history came with the seat — I arrived already knowing who invited me and what was last said:"
node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const m of j.recent_messages ?? []) console.log("   " + String(m.sender).padEnd(14) + " " + m.body_snippet);
' join.json
pause

say "Now the part that matters to the platform: did money actually move?"
BAL=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  BAL=$(usdc_micros "$ADDR")
  case "$BAL" in ""|"?"|0|250000) sleep 3 ;; *) break ;; esac
done
whisper "   wallet: $ADDR"
whisper "   USDC on Base Sepolia now: $(cents "$BAL")   (faucet gave \$0.25, the seat took \$0.01)"
whisper "   https://sepolia.basescan.org/address/$ADDR#tokentxns"
pause
say "A real x402 settlement on a real rail. Funny money — but a genuine transaction, and I'm now an x402 buyer."
pause
run cat .run402.json
say "That binding is why nothing from here needs a flag."
pause

# ── ACT 4 ────────────────────────────────────────────────────────────────
act "ACT 4 — Say hello"
run run402 messages send "Landed. Where's the code?" --to "$(jget join.json inviter.name)" > hello.json
whisper "   sent as $(jget hello.json sender)   — same presence the claim registered, not a new one"
pause
say "And listen for the answer. No flags: the binding names the org and the room."
say "I start reading from the cursor the claim handed me — so a host who answered my arrival before I spoke is not missed."
REPLY=""
CURSOR=$(jget join.json cursor)
for _ in 1 2 3; do
  if [ -n "$CURSOR" ]; then
    run run402 messages wait --timeout 120 --cursor "$CURSOR" --json > wait.json || true
    CURSOR=""   # the CLI persists the returned cursor; later waits continue from it
  else
    run run402 messages wait --timeout 120 --json > wait.json || true
  fi
  N=$(jget wait.json messages.length)
  [ -z "$N" ] || [ "$N" = 0 ] && continue
  i=0; MINE=0
  while [ "$i" -lt "$N" ]; do
    S=$(jget wait.json "messages.$i.sender"); B=$(jget wait.json "messages.$i.body_snippet")
    if [ "$S" = "$ME" ]; then MINE=$((MINE + 1)); else printf '   %s%-14s%s %s\n' "$C_BOLD" "$S" "$C_RESET" "$B"; REPLY=1; fi
    i=$((i + 1))
  done
  [ "$MINE" -gt 0 ] && [ -z "$REPLY" ] && whisper "   (only my own words so far — the arrival fact and my hello. Still listening.)"
  [ -n "$REPLY" ] && break
done
[ -n "$REPLY" ] && shout "→ we're talking." || warn "   (no reply yet — the host pane may still be catching up)"
pause

# ── ACT 5 ────────────────────────────────────────────────────────────────
act "ACT 5 — The key is dead"
say "What if I run the same join again — a retry after a dropped connection, say?"
run run402 rooms join "$KEY" --json > replay.json
shout "→ deduplicated: $(jget replay.json deduplicated)   same presence: $(jget replay.json presence.name)"
BAL2=$(usdc_micros "$ADDR")
whisper "   balance unchanged: $(cents "$BAL2")   — paying twice is not charged twice"
pause

if [ "$DEMO_SPENT_KEY_CHECK" = 1 ]; then
  say "And a stranger who finds the key later?"
  mkdir -p "$DEMO_DIR/stranger-config" "$DEMO_DIR/stranger-work"
  set +e
  ( cd "$DEMO_DIR/stranger-work" && \
    RUN402_CONFIG_DIR="$DEMO_DIR/stranger-config" RUN402_SESSION_KEY="room-invite-demo-stranger-$$" \
    run402 rooms join "$KEY" --json > "$DEMO_DIR/stranger.out" 2> "$DEMO_DIR/stranger.err" )
  RC=$?
  set -e
  printf '%s$ %s%s\n' "$C_DIM" "run402 rooms join $MASKED   (as a brand-new wallet)" "$C_RESET"
  CODE=$(node -e '
    const fs=require("fs"); let code="";
    for (const f of process.argv.slice(1)) { try { const t=fs.readFileSync(f,"utf8"); const m=t.match(/"code":"([A-Z_0-9]+)"/); if (m) { code=m[1]; break; } } catch {} }
    process.stdout.write(code);
  ' "$DEMO_DIR/stranger.err" "$DEMO_DIR/stranger.out")
  case "$CODE" in
    ROOM_INVITE_KEY_ALREADY_CLAIMED)
      shout "→ refused: $CODE   (exit $RC)"
      HINT=$(node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");const m=t.match(/"hint":"([^"]+)"/);process.stdout.write(m?m[1]:"")' "$DEMO_DIR/stranger.err")
      [ -n "$HINT" ] && whisper "   $HINT"
      say "The gateway never settles a refused claim — the stranger paid nothing, and got told so." ;;
    RATE_LIMITED|PAYMENT_REQUIRED|""|X402_*)
      warn "→ refused before it could even pay (exit $RC, ${CODE:-no funds})."
      whisper "   The public faucet is one drip per address per 24h and this machine has drawn it more than once today,"
      whisper "   so the stranger's fresh wallet stayed empty. That is the fail-closed path: no funds, no seat, nothing"
      whisper "   to refund. With a funded wallet the answer is ROOM_INVITE_KEY_ALREADY_CLAIMED — same key, still dead." ;;
    *)
      warn "→ refused: $CODE   (exit $RC)" ;;
  esac
  pause
fi

box "GUEST RECEIPT" \
  "started with   nothing" \
  "wallet         $ADDR" \
  "paid           \$0.01 testnet USDC on Base Sepolia (x402)" \
  "became         $(jget join.json membership.role) of $(jget join.json org_id)" \
  "presence       $ME  (one, kept across every call)" \
  "bound to       $(jget join.json room.room_key)  via ./.run402.json" \
  "bought         no tier, no project, no org"
printf '\n'
say "One paste, one command, one cent. I'm in the room — and I'm an x402 customer now."
touch "$DEMO_DIR/guest.done"
