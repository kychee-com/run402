/**
 * Unit tests for the PURE parts of `run402 errors` — duration parsing,
 * formatting, and the human renderers. Network-free and independent of the
 * SDK `errors` namespace (which is built by a sibling package), so these run
 * standalone in the same suite as doctor-source-scan.test.mjs.
 *
 * Run: node --test cli/lib/errors.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDurationMs,
  fmtDuration,
  fmtInt,
  truncate,
  relativeTime,
  describeWindow,
  renderVerdict,
  renderListRow,
  renderHumanList,
  renderHumanDetail,
  renderFailOnNewList,
  renderCleanGate,
  INTERVAL_FLOOR_MS,
  KINDS,
} from "./errors.mjs";

test("parseDurationMs — units and bare seconds", () => {
  assert.equal(parseDurationMs("90s"), 90_000);
  assert.equal(parseDurationMs("10m"), 600_000);
  assert.equal(parseDurationMs("2h"), 7_200_000);
  assert.equal(parseDurationMs("600"), 600_000, "bare number is seconds");
  assert.equal(parseDurationMs("0"), 0);
  assert.equal(parseDurationMs(" 5M "), 300_000, "trims + case-insensitive");
});

test("parseDurationMs — malformed returns null (caller fails)", () => {
  assert.equal(parseDurationMs("abc"), null);
  assert.equal(parseDurationMs("10x"), null);
  assert.equal(parseDurationMs("500ms"), null, "ms is not an accepted unit");
  assert.equal(parseDurationMs("-5s"), null);
  assert.equal(parseDurationMs(""), null);
  assert.equal(parseDurationMs(null), null);
});

test("INTERVAL_FLOOR_MS is 5s and KINDS matches the wire vocabulary", () => {
  assert.equal(INTERVAL_FLOOR_MS, 5000);
  assert.deepEqual(KINDS, ["uncaught", "boot_crash", "invoke_failed", "handled_5xx"]);
});

test("fmtDuration — compact units", () => {
  assert.equal(fmtDuration(90_000), "90s");
  assert.equal(fmtDuration(600_000), "10m");
  assert.equal(fmtDuration(7_200_000), "2h");
  assert.equal(fmtDuration(86_400_000), "1d");
  assert.equal(fmtDuration(0), "0s");
});

test("fmtInt — thousands separators", () => {
  assert.equal(fmtInt(1204), "1,204");
  assert.equal(fmtInt(0), "0");
  assert.equal(fmtInt("42"), "42");
});

test("truncate — appends ellipsis past the limit", () => {
  assert.equal(truncate("short", 100), "short");
  const long = "x".repeat(150);
  const out = truncate(long, 100);
  assert.equal(out.length, 100);
  assert.ok(out.endsWith("…"));
});

test("relativeTime — buckets", () => {
  const now = Date.parse("2026-07-12T12:00:00Z");
  assert.equal(relativeTime("2026-07-12T11:59:50Z", now), "just now");
  assert.equal(relativeTime("2026-07-12T11:57:00Z", now), "3m ago");
  assert.equal(relativeTime("2026-07-12T10:00:00Z", now), "2h ago");
  assert.equal(relativeTime("2026-07-07T12:00:00Z", now), "5d ago");
  assert.equal(relativeTime("not-a-date", now), "not-a-date");
});

test("describeWindow — 'last Nh' when it ends ~now, else a range", () => {
  const now = Date.parse("2026-07-12T12:00:00Z");
  assert.equal(
    describeWindow("2026-07-11T12:00:00Z", "2026-07-12T12:00:00Z", now),
    "last 24h",
  );
  assert.equal(
    describeWindow("2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z", now),
    "2026-07-01T00:00:00Z → 2026-07-02T00:00:00Z",
  );
});

const VERDICT = {
  window: { since: "2026-07-11T12:00:00Z", until: "2026-07-12T12:00:00Z" },
  compared_release_id: "rel_01JX",
  baseline_release_id: "rel_01JW",
  new_fingerprints: 2,
  recurring_fingerprints: 5,
  invocations_in_window: 1204,
  coverage: { full_fidelity_functions: 3, coarse_functions: 1 },
  row_cap: { limit: 200, at_cap: false },
};

test("renderVerdict — verdict-first with release attribution + coverage", () => {
  const out = renderVerdict(VERDICT);
  assert.match(out, /^Verdict —/);
  assert.match(out, /comparing rel_01JX against baseline rel_01JW/);
  assert.match(out, /new error identities\s+2\s+← first seen under rel_01JX/);
  assert.match(out, /recurring\s+5/);
  assert.match(out, /invocations in window\s+1,204/);
  assert.match(out, /coverage\s+3 function\(s\) full-fidelity · 1 coarse \(redeploy/);
});

test("renderVerdict — discloses the row cap only when at_cap", () => {
  assert.doesNotMatch(renderVerdict(VERDICT), /AT CAP/);
  const capped = { ...VERDICT, row_cap: { limit: 200, at_cap: true } };
  assert.match(renderVerdict(capped), /row cap\s+showing up to 200 — AT CAP/);
});

const ROW = {
  fingerprint_id: "fp_9b21fa",
  function: "checkout",
  kind: "uncaught",
  fingerprint_quality: "frame_names",
  error_name: "TypeError",
  message_template: "Cannot read properties of undefined (reading 'x')",
  count: 42,
  last_seen: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
  samples: {
    first: { id: "req_first", at: "2026-07-11T00:00:00Z", release_id: "rel_01JX" },
    recent: [{ id: "req_recent", at: "2026-07-12T11:57:00Z", release_id: "rel_01JX" }],
  },
  next_actions: [{ type: "fetch_logs", command: "run402 logs checkout --request-id req_recent", why: "..." }],
};

test("renderListRow — id, kind, count, name, function, message, coarse marker", () => {
  const line = renderListRow(ROW);
  assert.match(line, /fp_9b21fa/);
  assert.match(line, /uncaught/);
  assert.match(line, /×42/);
  assert.match(line, /TypeError/);
  assert.match(line, /fn:checkout/);
  assert.match(line, /Cannot read properties/);
  assert.doesNotMatch(line, /\[coarse\]/);

  const coarse = renderListRow({ ...ROW, fingerprint_quality: "coarse" });
  assert.match(coarse, /\[coarse\]$/);
});

test("renderHumanList — verdict first, then the gateway's drill-down command", () => {
  const out = renderHumanList({ verdict: VERDICT, errors: [ROW], has_more: false });
  const firstLine = out.split("\n", 1)[0];
  assert.match(firstLine, /^Verdict —/, "verdict must come first");
  assert.match(out, /Investigate the top fingerprint:/);
  assert.match(out, /run402 logs checkout --request-id req_recent/);
});

test("renderHumanList — empty result shows invocations (health vs no-signal)", () => {
  const withTraffic = renderHumanList({
    verdict: { ...VERDICT, invocations_in_window: 1204 },
    errors: [],
    has_more: false,
  });
  assert.match(withTraffic, /No error fingerprints in window \(1,204 invocation\(s\) observed\)/);
  assert.doesNotMatch(withTraffic, /absence of signal/);

  const zeroTraffic = renderHumanList({
    verdict: { ...VERDICT, invocations_in_window: 0 },
    errors: [],
    has_more: false,
  });
  assert.match(zeroTraffic, /No error fingerprints in window \(0 invocation\(s\) observed\)/);
  assert.match(zeroTraffic, /absence of signal, not proven health/);
});

test("renderHumanDetail — both release attributions, coarse hint, per-sample logs", () => {
  const detail = {
    ...ROW,
    fingerprint_quality: "coarse",
    first_seen: "2026-07-11T00:00:00Z",
    last_seen: "2026-07-12T11:57:00Z",
    first_seen_release_id: "rel_01JW",
    last_seen_release_id: "rel_01JX",
    stable_frames: ["at handler (index.mjs:10)"],
    also_seen_in_functions: ["webhook"],
  };
  const out = renderHumanDetail(detail);
  assert.match(out, /first seen\s+2026-07-11T00:00:00Z\s+\(release rel_01JW\)/);
  assert.match(out, /last seen\s+2026-07-12T11:57:00Z\s+\(release rel_01JX\)/);
  assert.match(out, /predates the error side-channel; redeploying it upgrades future fingerprint fidelity/);
  assert.match(out, /also seen in\s+fn:webhook/);
  // pinned first sample + recent ring, each with a runnable logs command
  assert.match(out, /run402 logs checkout --request-id req_first/);
  assert.match(out, /run402 logs checkout --request-id req_recent/);
});

test("renderFailOnNewList — actionable: id, kind, count, sample id, logs command", () => {
  const out = renderFailOnNewList([ROW], "rel_01JX", 1);
  assert.match(out, /^FAIL — 1 new error identity first seen under rel_01JX:/);
  assert.match(out, /fp_9b21fa\s+uncaught\s+×42\s+TypeError\s+fn:checkout/);
  assert.match(out, /sample req_recent/);
  assert.match(out, /run402 logs checkout --request-id req_recent/);
});

test("renderFailOnNewList — pluralizes and notes the un-shown remainder", () => {
  const out = renderFailOnNewList([ROW], "rel_01JX", 3);
  assert.match(out, /^FAIL — 3 new error identities first seen under rel_01JX:/);
  assert.match(out, /… and 2 more not shown/);
});

test("renderCleanGate — PASS line, watched variant carries duration + polls", () => {
  assert.match(renderCleanGate(VERDICT, "rel_01JX"), /^PASS — no new error identities first seen under rel_01JX\./);
  const watched = renderCleanGate(VERDICT, "rel_01JX", { watched: true, durationMs: 600_000, polls: 40 });
  assert.match(watched, /^PASS — Watched 10m \(40 polls\) — no new error identities/);
});
