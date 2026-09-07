# shellcheck shell=bash
# Shared stagecraft for the Room Invite demo. Sourced by host.sh and guest.sh.
# Bash 3.2 compatible (macOS default) — no associative arrays, no ${var,,}.

: "${RUN402_API_BASE:=https://api.run402.com}"
: "${DEMO_FAST:=0}"
export RUN402_API_BASE
# The demo never guesses a task from the harness's window title, and never
# lets two actors on one machine collide on the same harness session key.
export RUN402_NO_TASK_FROM_TITLE=1

# ── colour ────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_MAGENTA=$'\033[35m'; C_RED=$'\033[31m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_DIM=""; C_BOLD=""; C_CYAN=""; C_GREEN=""; C_YELLOW=""
  C_MAGENTA=""; C_RED=""; C_BLUE=""
fi

# ── pacing ────────────────────────────────────────────────────────────────
pause() { [ "$DEMO_FAST" = 1 ] || sleep "${1:-1.2}"; }

# Typewriter narration. DEMO_FAST=1 prints instantly.
say() {
  local s="$*"
  printf '%s' "$C_BOLD$C_CYAN"
  if [ "$DEMO_FAST" = 1 ]; then
    printf '%s' "$s"
  else
    local i
    for ((i = 0; i < ${#s}; i++)); do
      printf '%s' "${s:$i:1}"
      sleep 0.012
    done
  fi
  printf '%s\n' "$C_RESET"
  pause 0.6
}

whisper() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
shout()   { printf '%s%s%s\n' "$C_BOLD$C_GREEN" "$*" "$C_RESET"; }
warn()    { printf '%s%s%s\n' "$C_BOLD$C_YELLOW" "$*" "$C_RESET"; }

# Repeat a (possibly multibyte) glyph N times. `tr` is byte-based and mangles
# box-drawing characters, and printf's %-*s pads by bytes on older bashes, so
# every rule and pad here is built by hand from character counts.
rep() { local g="$1" n="$2" s="" i; for ((i = 0; i < n; i++)); do s="$s$g"; done; printf '%s' "$s"; }
# Pad a string with spaces to N display characters (UTF-8 locale assumed).
pad() { local s="$1" n="$2"; printf '%s' "$s"; rep ' ' $((n - ${#s})); }

act() {
  local title="$*"
  local line; line=$(rep '─' 64)
  printf '\n%s%s%s\n' "$C_MAGENTA" "$line" "$C_RESET"
  printf '%s  %s%s\n' "$C_BOLD$C_MAGENTA" "$title" "$C_RESET"
  printf '%s%s%s\n\n' "$C_MAGENTA" "$line" "$C_RESET"
  pause 0.8
}

# Show a command the way a human would type it (arguments with spaces are
# quoted, so the echo is paste-able), then run it. Output goes to the caller
# unchanged, so `run … > file` works.
run() {
  local shown="" a
  for a in "$@"; do
    case "$a" in
      *[[:space:]\'\"]*) shown="$shown \"${a//\"/\\\"}\"" ;;
      "") shown="$shown \"\"" ;;
      *) shown="$shown $a" ;;
    esac
  done
  printf '%s$%s%s\n' "$C_DIM" "$shown" "$C_RESET" >&2
  pause 0.4
  "$@"
}

# Print a boxed receipt: box "title" line line line…
box() {
  local title="$1"; shift
  local w=0 l
  for l in "$title" "$@"; do [ ${#l} -gt $w ] && w=${#l}; done
  local rule; rule=$(rep '─' $((w + 2)))
  printf '%s┌%s┐%s\n' "$C_GREEN" "$rule" "$C_RESET"
  printf '%s│ %s%s%s │%s\n' "$C_GREEN" "$C_BOLD" "$(pad "$title" "$w")" "$C_RESET$C_GREEN" "$C_RESET"
  printf '%s├%s┤%s\n' "$C_GREEN" "$rule" "$C_RESET"
  for l in "$@"; do printf '%s│%s %s %s│%s\n' "$C_GREEN" "$C_RESET" "$(pad "$l" "$w")" "$C_GREEN" "$C_RESET"; done
  printf '%s└%s┘%s\n' "$C_GREEN" "$rule" "$C_RESET"
}

# ── json without jq ───────────────────────────────────────────────────────
# jget FILE dotted.path  → prints the value ("" when absent; objects as JSON)
jget() {
  node -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const v = process.argv[2].split(".").reduce((a, k) => (a == null ? a : a[k]), j);
    if (v === undefined || v === null) process.stdout.write("");
    else process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$1" "$2"
}

# jshow FILE key1 key2 …  → a tidy two-column view of chosen top-level keys
jshow() {
  local f="$1"; shift
  node -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const keys = process.argv.slice(2);
    const w = Math.max(...keys.map((k) => k.length));
    for (const k of keys) {
      const v = k.split(".").reduce((a, x) => (a == null ? a : a[x]), j);
      const s = v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
      console.log("  " + k.padEnd(w) + "  " + s);
    }
  ' "$f" "$@"
}

# On-chain USDC on Base Sepolia for an address, in micro-units. Reads the
# public RPC directly so the demo can show money moving without trusting
# anything the platform says about it.
usdc_micros() {
  node -e '
    const addr = process.argv[1].toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const data = "0x70a08231" + addr;                       // balanceOf(address)
    const body = { jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", data }, "latest"] };
    fetch("https://sepolia.base.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .then((j) => { process.stdout.write(String(BigInt(j.result ?? "0x0"))); })
      .catch(() => process.stdout.write("?"));
  ' "$1"
}

cents() { node -e 'const m=Number(process.argv[1]);process.stdout.write(isFinite(m)?"$"+(m/1e6).toFixed(2):"?")' "$1"; }

# ── preflight ─────────────────────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1 || { printf '%smissing: %s%s\n' "$C_RED" "$1" "$C_RESET" >&2; exit 2; }; }

preflight() {
  need node; need curl; need run402
  local v; v=$(run402 --version 2>/dev/null | tail -1)
  node -e '
    const [a, b] = process.argv.slice(1).map((s) => s.trim().split(".").map(Number));
    const ok = a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])));
    if (!ok) { console.error("run402 " + process.argv[1] + " is too old — the Room Invite shipped in 4.71.0. npm i -g run402@latest"); process.exit(2); }
  ' "$v" "4.71.0"
}

# Wait (up to N seconds) for a file another actor writes.
await_file() {
  local f="$1" n="${2:-300}" i=0
  while [ ! -s "$f" ]; do
    i=$((i + 1)); [ $i -gt "$n" ] && { warn "gave up waiting for $f"; return 1; }
    sleep 1
  done
}
