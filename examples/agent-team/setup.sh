#!/usr/bin/env bash
# One-time plumbing for the agent-team demo. Nothing here is the show; it is
# the part a platform does so the agents never have to:
#
#   • three wallets in isolated config dirs (Grahak, Claude, Codex)
#   • Grahak's org-of-one gets the two engineers as developers
#   • a fresh room key, and each actor's directory bound to it
#   • a shared bare git repo (the "GitHub") with an empty main, one clone each
#   • each actor's presence registered under its name
#
# Usage: DEMO_DIR=/path setup.sh [--force]
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
: "${DEMO_DIR:?set DEMO_DIR}"
need run402; need node; need git

if [ -f "$DEMO_DIR/env.sh" ] && [ "${1:-}" != "--force" ]; then
  note "already set up at $DEMO_DIR (pass --force to redo)"; exit 0
fi
rm -rf "$DEMO_DIR/cfg" "$DEMO_DIR/work" "$DEMO_DIR/origin.git" "$DEMO_DIR/seed" "$DEMO_DIR/env.sh" "$DEMO_DIR/prompts"
mkdir -p "$DEMO_DIR/cfg" "$DEMO_DIR/work"

note "── wallets"
for r in $ROLES; do
  mkdir -p "$DEMO_DIR/cfg/$r"
  RUN402_CONFIG_DIR="$DEMO_DIR/cfg/$r" run402 allowance create > "$DEMO_DIR/cfg/$r.json"
  ok "  $(role_name "$r")  $(jget "$DEMO_DIR/cfg/$r.json" address)"
done
ADDR_CLAUDE=$(jget "$DEMO_DIR/cfg/claude.json" address)
ADDR_CODEX=$(jget "$DEMO_DIR/cfg/codex.json" address)

note "── organization (Grahak's, created on first contact)"
RUN402_CONFIG_DIR="$DEMO_DIR/cfg/grahak" run402 org list > "$DEMO_DIR/cfg/orgs.json"
ORG=$(jget "$DEMO_DIR/cfg/orgs.json" orgs.0.org_id)
[ -n "$ORG" ] || die "could not resolve Grahak's org"
ok "  org $ORG"
for a in "$ADDR_CLAUDE" "$ADDR_CODEX"; do
  RUN402_CONFIG_DIR="$DEMO_DIR/cfg/grahak" run402 org member add "$ORG" "$a" --role developer > /dev/null
  ok "  + developer $a"
done

ROOM="wordle-$(node -e 'process.stdout.write(require("crypto").randomBytes(2).toString("hex"))')"
ok "  room $ROOM"

note "── the shared repo (a bare git repo standing in for GitHub)"
git init -q -b main "$DEMO_DIR/seed"
printf '# wordle\n\nBuilt by a team of agents coordinating in a run402 room.\n' > "$DEMO_DIR/seed/README.md"
git -C "$DEMO_DIR/seed" -c user.name=setup -c user.email=setup@example.invalid add README.md
git -C "$DEMO_DIR/seed" -c user.name=setup -c user.email=setup@example.invalid commit -q -m "seed"
# A bare clone of the seed, rather than init + push: pushing into an empty
# bare repo over the file transport trips push negotiation on some gits
# ("expected 'acknowledgments', received 'packfile'") and main never lands.
git clone -q --bare "$DEMO_DIR/seed" "$DEMO_DIR/origin.git"
rm -rf "$DEMO_DIR/seed"
git --git-dir="$DEMO_DIR/origin.git" rev-parse --verify main >/dev/null || die "origin.git has no main"
ok "  origin.git with main at $(git --git-dir="$DEMO_DIR/origin.git" rev-parse --short main)"

note "── one clone, one binding, one presence per actor"
for r in $ROLES; do
  role_env "$r"
  NAME=$(role_name "$r")
  git clone -q "$DEMO_DIR/origin.git" "$ROLE_WORK"
  git -C "$ROLE_WORK" config user.name "$NAME"
  git -C "$ROLE_WORK" config user.email "$r@agent-team.invalid"
  printf '{\n  "org": "%s",\n  "room": "%s"\n}\n' "$ORG" "$ROOM" > "$ROLE_WORK/.run402.json"
  printf '.run402.json\n.run402/\n' >> "$ROLE_WORK/.git/info/exclude"
  ( cd "$ROLE_WORK" && run402 rooms join --name "$NAME" --task "$(role_task "$r")" > "$DEMO_DIR/cfg/$r.presence.json" )
  ok "  $NAME  →  $(jget "$DEMO_DIR/cfg/$r.presence.json" you.name)   ($ROLE_WORK)"
done

cat > "$DEMO_DIR/env.sh" <<EOF
export DEMO_ORG='$ORG'
export DEMO_ROOM='$ROOM'
export DEMO_ORIGIN='$DEMO_DIR/origin.git'
EOF
ok "── ready. org=$ORG room=$ROOM"
