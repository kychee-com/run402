#!/usr/bin/env bash
# Idempotent, transient-tolerant `npm publish` for one package (GH-555).
#
# Usage: scripts/publish-idempotent.sh [--no-wait] <label> <package-dir>
#        scripts/publish-idempotent.sh --wait <label> <package-dir>
#
# The registry is the source of truth, never npm's output text: real runs have
# seen `npm publish` print NOTHING and exit non-zero for a version that was
# already live, which the old text-matching helper misread as a hard failure.
#
#   1. Before publishing, ask the registry for <name>@<version>. Present ->
#      idempotent skip (a re-run after a partial lockstep publish completes the
#      remaining packages instead of failing on the one that already landed).
#   2. After a claimed success, poll the registry until the exact version
#      resolves. A lagging read waits; it never triggers a re-publish. Never
#      appears -> fail.
#   3. On a non-zero exit, re-check the registry first (may already exist).
#      Known transient errors and empty/unrecognized output are retried a
#      bounded number of times, re-checking the registry before each retry.
#
# registry.npmjs.org records a version four to six minutes after `npm publish`
# returns: the version's `time` entry carries that later moment, and no read
# shows the version before it. Step 2 is therefore a wait of minutes per
# package. A lockstep release publishes every package with --no-wait (steps 1
# and 3, and a publish conflict is left to the wait), then runs --wait for all
# of them at once (step 2 alone, never publishing), so the release waits
# once, not once per package.
#
# "Ask the registry" reads the per-version document,
# <registry>/<name>/<version>, which the registry's CDN does not cache
# (cf-cache-status: DYNAMIC). `npm view` reads the packument, which the CDN
# caches for max-age=300, a further five minutes on top of the recording delay.
#
# Tunables (env, mainly for tests):
#   PUBLISH_REGISTRY_URL        registry origin             (default https://registry.npmjs.org)
#   PUBLISH_MAX_ATTEMPTS        publish attempts            (default 3)
#   PUBLISH_RETRY_SLEEP_S       sleep between attempts      (default 10)
#   PUBLISH_VERIFY_TIMEOUT_S    post-success verify window  (default 600)
#   PUBLISH_VERIFY_INTERVAL_S   registry poll interval      (default 5)
#   PUBLISH_FINAL_CHECK_S       last registry window after retries are
#                               exhausted                   (default 600)

set -uo pipefail

usage="usage: publish-idempotent.sh [--no-wait | --wait] <label> <package-dir>"
mode=publish
case "${1:-}" in
  --no-wait) mode=no-wait; shift ;;
  --wait) mode=wait; shift ;;
  -*) echo "$usage"; exit 2 ;;
esac

label="${1:?$usage}"
dir="${2:?$usage}"

max_attempts="${PUBLISH_MAX_ATTEMPTS:-3}"
retry_sleep="${PUBLISH_RETRY_SLEEP_S:-10}"
verify_timeout="${PUBLISH_VERIFY_TIMEOUT_S:-600}"
verify_interval="${PUBLISH_VERIFY_INTERVAL_S:-5}"
final_check="${PUBLISH_FINAL_CHECK_S:-600}"
registry="${PUBLISH_REGISTRY_URL:-https://registry.npmjs.org}"

cd "$dir" || { echo "[$label] cannot cd into $dir"; exit 1; }

pkg=$(node -p "require('./package.json').name") || { echo "[$label] cannot read package name"; exit 1; }
version=$(node -p "require('./package.json').version") || { echo "[$label] cannot read package version"; exit 1; }
spec="$pkg@$version"

doc_url="$registry/$pkg/$version"

# True when the registry's per-version document carries the exact version. A
# 404 (not published), a network failure or a body that is not JSON all read
# as "not there yet".
is_published() {
  local got
  got=$(curl -fsS --max-time 20 "$doc_url" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).version||""))}catch{}})')
  [ "$got" = "$version" ]
}

# Poll the registry for up to $1 seconds. Never publishes.
wait_for_version() {
  local timeout="$1" waited=0
  while :; do
    if is_published; then return 0; fi
    if [ "$waited" -ge "$timeout" ]; then return 1; fi
    sleep "$verify_interval"
    waited=$((waited + verify_interval))
    # One line every 30 seconds: --wait runs several of these side by side.
    if [ $((waited % 30)) -lt "$verify_interval" ]; then
      echo "[$label] waiting for $spec to resolve on the registry (${waited}s/${timeout}s)"
    fi
  done
}

if [ "$mode" = wait ]; then
  if wait_for_version "$verify_timeout"; then
    echo "[$label] verified on the registry: $spec"
    exit 0
  fi
  echo "[$label] $spec never resolved on the registry within ${verify_timeout}s."
  exit 1
fi

if is_published; then
  echo "[$label] $spec already published at this version — idempotent skip."
  exit 0
fi

log=$(mktemp "${TMPDIR:-/tmp}/publish-idempotent.XXXXXX")
trap 'rm -f "$log"' EXIT

attempt=0
while [ "$attempt" -lt "$max_attempts" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 1 ] && is_published; then
    echo "[$label] $spec is on the registry — idempotent skip."
    exit 0
  fi

  echo "[$label] npm publish $spec (attempt $attempt/$max_attempts)"
  # --ignore-scripts=false: .npmrc refuses dependency install scripts, which
  # would also skip the cli and sdk prepack that stages the tarball contents.
  npm publish --ignore-scripts=false --access public --provenance 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}

  if [ "$rc" -eq 0 ]; then
    if [ "$mode" = no-wait ]; then
      echo "[$label] npm publish accepted $spec (attempt $attempt); --wait verifies it on the registry"
      exit 0
    fi
    echo "[$label] npm publish exited 0; verifying $spec on the registry"
    if wait_for_version "$verify_timeout"; then
      echo "[$label] published and verified: $spec (attempt $attempt)"
      exit 0
    fi
    echo "[$label] npm publish claimed success but $spec never resolved on the registry within ${verify_timeout}s."
    exit 1
  fi

  echo "[$label] npm publish exited $rc"
  if is_published; then
    echo "[$label] $spec already published at this version — idempotent skip."
    exit 0
  fi

  if grep -qiE "cannot publish over|previously published|EPUBLISHCONFLICT" "$log"; then
    if [ "$mode" = no-wait ]; then
      echo "[$label] npm reports $spec already exists; --wait confirms it on the registry"
      exit 0
    fi
    echo "[$label] npm reports $spec already exists; waiting for the registry to confirm"
    if wait_for_version "$verify_timeout"; then
      echo "[$label] $spec confirmed on the registry — idempotent skip."
      exit 0
    fi
    echo "[$label] npm reported a publish conflict but $spec never resolved on the registry."
    exit 1
  fi

  if grep -qiE "TLOG_CREATE_ENTRY_ERROR|rekor\.sigstore\.dev|tlog entry|ETIMEDOUT|ECONNRESET|socket hang up|aborted" "$log"; then
    echo "[$label] transient provenance/network error — retry $attempt/$max_attempts"
  elif [ ! -s "$log" ]; then
    echo "[$label] npm publish failed with EMPTY output — unknown outcome, retry $attempt/$max_attempts"
  else
    echo "[$label] unrecognized npm publish failure — unknown outcome, retry $attempt/$max_attempts"
  fi
  if [ "$attempt" -lt "$max_attempts" ]; then sleep "$retry_sleep"; fi
done

echo "[$label] exhausted $max_attempts attempts; last registry check for $spec"
if wait_for_version "$final_check"; then
  echo "[$label] $spec resolved on the registry — idempotent skip."
  exit 0
fi
echo "[$label] publish of $spec failed: not on the registry after $max_attempts attempts."
exit 1
