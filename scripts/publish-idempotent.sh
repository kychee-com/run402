#!/usr/bin/env bash
# Idempotent, transient-tolerant `npm publish` for one package (GH-555).
#
# Usage: scripts/publish-idempotent.sh <label> <package-dir>
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
# "Ask the registry" reads the per-version document,
# <registry>/<name>/<version>, which registry.npmjs.org serves from its origin
# on every request (cf-cache-status: DYNAMIC), so it holds a version seconds
# after the publish. `npm view` reads the whole packument instead, which the
# CDN caches for max-age=300: polling through it waited out that cache, three
# to five minutes per package after a publish that took seven seconds.
#
# Tunables (env, mainly for tests):
#   PUBLISH_REGISTRY_URL        registry origin             (default https://registry.npmjs.org)
#   PUBLISH_MAX_ATTEMPTS        publish attempts            (default 3)
#   PUBLISH_RETRY_SLEEP_S       sleep between attempts      (default 10)
#   PUBLISH_VERIFY_TIMEOUT_S    post-success verify window  (default 600)
#   PUBLISH_VERIFY_INTERVAL_S   registry poll interval      (default 5)
#   PUBLISH_FINAL_CHECK_S       last registry window after retries are
#                               exhausted                   (default 120)

set -uo pipefail

label="${1:?usage: publish-idempotent.sh <label> <package-dir>}"
dir="${2:?usage: publish-idempotent.sh <label> <package-dir>}"

max_attempts="${PUBLISH_MAX_ATTEMPTS:-3}"
retry_sleep="${PUBLISH_RETRY_SLEEP_S:-10}"
verify_timeout="${PUBLISH_VERIFY_TIMEOUT_S:-600}"
verify_interval="${PUBLISH_VERIFY_INTERVAL_S:-5}"
final_check="${PUBLISH_FINAL_CHECK_S:-120}"
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
    echo "[$label] waiting for $spec to resolve on the registry (${waited}s/${timeout}s)"
  done
}

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
