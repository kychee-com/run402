// Tests for scripts/publish-idempotent.sh (GH-555): publish idempotency is
// decided by the registry's per-version document (<registry>/<name>/<version>),
// never by npm's output text. Each case runs the real script against a stub
// `npm` (the publish) and a stub `curl` (the registry read) on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "publish-idempotent.sh");

// Stubs. State lives in $STATE:
//   published   - present => the per-version document resolves
//   lag         - number of registry reads that still miss after publish
//   calls       - one line per invocation ("view" / "publish")
//   urls        - the URL of every registry read
// FAKE_PUBLISH is a space-separated script of outcomes, one per publish call:
//   ok            exit 0, version becomes visible
//   ok-invisible  exit 0, version never becomes visible
//   empty-exists  no output, exit 1, version IS published
//   empty         no output, exit 1, nothing published
//   transient     ETIMEDOUT text, exit 1, nothing published
//   conflict      npm's "cannot publish over" text, exit 1, nothing visible
//
// The curl stub answers like the registry with -f: the document on a hit,
// nothing and exit 22 on a 404.
const CURL_STUB = `#!/usr/bin/env bash
echo view >> "$STATE/calls"
echo "\${@: -1}" >> "$STATE/urls"
if [ -f "$STATE/published" ]; then
  lag=$(cat "$STATE/lag" 2>/dev/null || echo 0)
  if [ "$lag" -gt 0 ]; then echo $((lag - 1)) > "$STATE/lag"; exit 22; fi
  echo "{\\"name\\":\\"fake-pkg\\",\\"version\\":\\"$FAKE_VERSION\\"}"
  exit 0
fi
exit 22
`;

const STUB = `#!/usr/bin/env bash
cmd="$1"
echo "$cmd" >> "$STATE/calls"
if [ "$cmd" = "view" ]; then
  echo "stub: the registry is read through curl, never npm view"; exit 97
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
    conflict) echo "npm error You cannot publish over the previously published versions: $FAKE_VERSION."; exit 1 ;;
    *) echo "stub: no outcome for publish #$n"; exit 99 ;;
  esac
fi
echo "stub: unexpected npm $*"; exit 98
`;

function run({ publish = "", prePublished = false, lag = 0, env = {}, flags = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-idem-"));
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  const pkgDir = path.join(root, "pkg");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  fs.mkdirSync(pkgDir);
  fs.writeFileSync(path.join(bin, "npm"), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), CURL_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(state, "calls"), "");
  fs.writeFileSync(path.join(state, "urls"), "");
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "fake-pkg", version: "9.9.9" }));
  if (prePublished) fs.writeFileSync(path.join(state, "published"), "");
  if (lag) fs.writeFileSync(path.join(state, "lag"), String(lag));
  const res = spawnSync("bash", [SCRIPT, ...flags, "fake", pkgDir], {
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
  const urls = fs.readFileSync(path.join(state, "urls"), "utf8").split("\n").filter(Boolean);
  fs.rmSync(root, { recursive: true, force: true });
  return { status: res.status, out: res.stdout + res.stderr, publishes: calls.filter((c) => c === "publish").length, urls };
}

test("reads the per-version document, which the registry CDN never caches", () => {
  const r = run({ publish: "ok", env: { PUBLISH_REGISTRY_URL: "https://registry.example" } });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.urls.length >= 2, r.out);
  for (const url of r.urls) assert.equal(url, "https://registry.example/fake-pkg/9.9.9");
});

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

test("--no-wait: npm accepts the version, the helper returns without polling for it", () => {
  const r = run({ publish: "ok-invisible", flags: ["--no-wait"] });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.publishes, 1);
  assert.equal(r.urls.length, 1, "only the pre-publish registry read");
  assert.match(r.out, /--wait verifies/);
});

test("--no-wait: a publish conflict is left to --wait, never re-published", () => {
  const r = run({ publish: "conflict", flags: ["--no-wait"] });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.publishes, 1);
  assert.match(r.out, /--wait confirms/);
});

test("--no-wait: still skips a version the registry already holds", () => {
  const r = run({ prePublished: true, flags: ["--no-wait"] });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.publishes, 0);
  assert.match(r.out, /idempotent skip/);
});

test("--wait: polls a lagging registry until the version resolves, never publishes", () => {
  const r = run({ prePublished: true, lag: 2, flags: ["--wait"] });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.publishes, 0);
  assert.equal(r.urls.length, 3);
  assert.match(r.out, /verified on the registry: fake-pkg@9\.9\.9/);
});

test("--wait: a version that never resolves fails, never publishes", () => {
  const r = run({ flags: ["--wait"], env: { PUBLISH_VERIFY_TIMEOUT_S: "1" } });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.publishes, 0);
  assert.match(r.out, /never resolved/);
});

test("an unknown flag is refused before anything runs", () => {
  const r = run({ flags: ["--verify"] });
  assert.equal(r.status, 2, r.out);
  assert.equal(r.publishes, 0);
  assert.equal(r.urls.length, 0);
  assert.match(r.out, /usage:/);
});
