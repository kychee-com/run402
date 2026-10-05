// Tests for scripts/publish-idempotent.sh (GH-555): publish idempotency is
// decided by the registry (`npm view <name>@<version>`), never by npm's output
// text. Each case runs the real script against a stub `npm` on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "publish-idempotent.sh");

// Stub npm. State lives in $STATE:
//   published   - present => `npm view` resolves the version
//   lag         - number of `npm view` calls that still miss after publish
//   calls       - one line per invocation ("view" / "publish")
// FAKE_PUBLISH is a space-separated script of outcomes, one per publish call:
//   ok            exit 0, version becomes visible
//   ok-invisible  exit 0, version never becomes visible
//   empty-exists  no output, exit 1, version IS published
//   empty         no output, exit 1, nothing published
//   transient     ETIMEDOUT text, exit 1, nothing published
const STUB = `#!/usr/bin/env bash
cmd="$1"
echo "$cmd" >> "$STATE/calls"
if [ "$cmd" = "view" ]; then
  if [ -f "$STATE/published" ]; then
    lag=$(cat "$STATE/lag" 2>/dev/null || echo 0)
    if [ "$lag" -gt 0 ]; then echo $((lag - 1)) > "$STATE/lag"; exit 0; fi
    echo "$FAKE_VERSION"
  fi
  exit 0
fi
if [ "$cmd" = "publish" ]; then
  n=$(grep -c '^publish$' "$STATE/calls")
  outcome=$(echo "$FAKE_PUBLISH" | cut -d' ' -f"$n")
  case "$outcome" in
    ok) echo "+ pkg@$FAKE_VERSION"; touch "$STATE/published"; exit 0 ;;
    ok-invisible) echo "+ pkg@$FAKE_VERSION"; exit 0 ;;
    empty-exists) touch "$STATE/published"; exit 1 ;;
    empty) exit 1 ;;
    transient) echo "npm error code ETIMEDOUT"; exit 1 ;;
    *) echo "stub: no outcome for publish #$n"; exit 99 ;;
  esac
fi
echo "stub: unexpected npm $*"; exit 98
`;

function run({ publish = "", prePublished = false, lag = 0, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-idem-"));
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  const pkgDir = path.join(root, "pkg");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  fs.mkdirSync(pkgDir);
  fs.writeFileSync(path.join(bin, "npm"), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(state, "calls"), "");
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "fake-pkg", version: "9.9.9" }));
  if (prePublished) fs.writeFileSync(path.join(state, "published"), "");
  if (lag) fs.writeFileSync(path.join(state, "lag"), String(lag));
  const res = spawnSync("bash", [SCRIPT, "fake", pkgDir], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STATE: state,
      FAKE_VERSION: "9.9.9",
      FAKE_PUBLISH: publish,
      PUBLISH_RETRY_SLEEP_S: "0",
      PUBLISH_VERIFY_INTERVAL_S: "1",
      PUBLISH_VERIFY_TIMEOUT_S: "30",
      PUBLISH_FINAL_CHECK_S: "0",
      ...env,
    },
  });
  const calls = fs.readFileSync(path.join(state, "calls"), "utf8").split("\n").filter(Boolean);
  fs.rmSync(root, { recursive: true, force: true });
  return { status: res.status, out: res.stdout + res.stderr, publishes: calls.filter((c) => c === "publish").length };
}

test("already on the registry: idempotent skip without publishing", () => {
  const r = run({ prePublished: true });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.publishes, 0);
  assert.match(r.out, /idempotent skip/);
});

test("empty output + non-zero exit, but the version exists: success (GH-555)", () => {
  const r = run({ publish: "empty-exists" });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.publishes, 1);
  assert.match(r.out, /idempotent skip/);
});

test("claimed success with a lagging registry: polls, never re-publishes", () => {
  const r = run({ publish: "ok", lag: 2 });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.publishes, 1);
  assert.match(r.out, /published and verified/);
});

test("claimed success that never resolves: fails loudly, never re-publishes", () => {
  const r = run({ publish: "ok-invisible", env: { PUBLISH_VERIFY_TIMEOUT_S: "1" } });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.publishes, 1);
  assert.match(r.out, /never resolved/);
});

test("transient then empty-unknown then success: bounded retry", () => {
  const r = run({ publish: "transient empty ok" });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.publishes, 3);
});

test("persistent empty failure: bounded retries, then fails", () => {
  const r = run({ publish: "empty empty empty" });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.publishes, 3);
  assert.match(r.out, /EMPTY output/);
});
