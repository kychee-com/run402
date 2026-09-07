# shellcheck shell=bash
# Shared helpers for the agent-team demo. Bash 3.2 compatible.
: "${RUN402_API_BASE:=https://api.run402.com}"
export RUN402_API_BASE RUN402_NO_TASK_FROM_TITLE=1

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_MAGENTA=$'\033[35m'; C_RED=$'\033[31m'; C_BLUE=$'\033[34m'; C_WHITE=$'\033[37m'
else
  C_RESET=""; C_DIM=""; C_BOLD=""; C_CYAN=""; C_GREEN=""; C_YELLOW=""
  C_MAGENTA=""; C_RED=""; C_BLUE=""; C_WHITE=""
fi

note()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET" >&2; }
ok()    { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_RESET" >&2; }
warn()  { printf '%s%s%s\n' "$C_BOLD$C_YELLOW" "$*" "$C_RESET" >&2; }
die()   { printf '%s%s%s\n' "$C_BOLD$C_RED" "$*" "$C_RESET" >&2; exit 1; }
need()  { command -v "$1" >/dev/null 2>&1 || die "missing: $1"; }

# jget FILE dotted.path → value ("" when absent; objects as JSON)
jget() {
  node -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const v = process.argv[2].split(".").reduce((a, k) => (a == null ? a : a[k]), j);
    if (v === undefined || v === null) process.stdout.write("");
    else process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$1" "$2"
}

# Three coding agents from three vendors. Grok brings the job.
ROLES="grok claude codex"
role_name() { case "$1" in grok) echo Grok ;; claude) echo Claude ;; codex) echo Codex ;; *) echo "$1" ;; esac; }
role_task() {
  case "$1" in
    grok)   echo "brought the job — words, README, acceptance" ;;
    claude) echo "engine — and the merge" ;;
    codex)  echo "the TUI" ;;
  esac
}

# Per-role environment. Every actor gets its own wallet (config dir), its own
# session key (so three agents on one machine never resume each other's
# presence), and a working directory bound to the room by ./.run402.json.
role_env() {
  local r="$1"
  export RUN402_CONFIG_DIR="$DEMO_DIR/cfg/$r"
  export RUN402_SESSION_KEY="agent-team-$r"
  export ROLE_WORK="$DEMO_DIR/work/$r"
}

require_setup() {
  [ -f "$DEMO_DIR/env.sh" ] || die "no demo at $DEMO_DIR — run setup.sh first (demo.sh does it for you)"
  # shellcheck source=/dev/null
  . "$DEMO_DIR/env.sh"
}
