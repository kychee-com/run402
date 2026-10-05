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
#      resolves. registry.npmjs.org can lag a good publish by minutes, so a
#      lagging read waits; it never triggers a re-publish. Never appears -> fail.
#   3. On a non-zero exit, re-check the registry first (may already exist).
#      Known transient errors and empty/unrecognized output are retried a
#      bounded number of times, re-checking the registry before each retry.
#
# Tunables (env, mainly for tests):
#   PUBLISH_MAX_ATTEMPTS        publish attempts            (default 3)
#   PUBLISH_RETRY_SLEEP_S       sleep between attempts      (default 10)
#   PUBLISH_VERIFY_TIMEOUT_S    post-success verify window  (default 600)
#   PUBLISH_VERIFY_INTERVAL_S   registry poll interval      (default 15)
#   PUBLISH_FINAL_CHECK_S       last registry window after retries are
#                               exhausted                   (default 120)

set -uo pipefail

label="${1:?usage: publish-idempotent.sh <label> <package-dir>}"
dir="${2:?usage: publish-idempotent.sh <label> <package-dir>}"

max_attempts="${PUBLISH_MAX_ATTEMPTS:-3}"
retry_sleep="${PUBLISH_RETRY_SLEEP_S:-10}"
verify_timeout="${PUBLISH_VERIFY_TIMEOUT_S:-600}"
verify_interval="${PUBLISH_VERIFY_INTERVAL_S:-15}"
final_check="${PUBLISH_FINAL_CHECK_S:-120}"

cd "$dir" || { echo "[$label] cannot cd into $dir"; exit 1; }

pkg=$(node -p "require('./package.json').name") || { echo "[$label] cannot read package name"; exit 1; }
version=$(node -p "require('./package.json').version") || { echo "[$label] cannot read package version"; exit 1; }
spec="$pkg@$version"

# True when the registry resolves the exact version. --prefer-online bypasses
# npm's local metadata cache so a poll sees fresh registry state.
is_published() {
  local got
  got=$(npm view "$spec" version --prefer-online 2>/dev/null | tr -d '[:space:]')
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
  npm publish --access public --provenance 2>&1 | tee "$log"
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
