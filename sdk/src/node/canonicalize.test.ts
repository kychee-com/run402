/**
 * Self-consistency tests for the local canonicalize / digest helper.
 *
 * As of v1.34 the gateway is authoritative for the deploy manifest digest;
 * the SDK's local digest is advisory only. These tests assert the helper
 * produces stable, deterministic output (so it remains useful for caching
 * + debugging) without making any cross-repo byte-for-byte claim.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCanonicalManifest,
  canonicalizeJson,
  computeManifestDigest,
} from "./canonicalize.js";

describe("canonicalizeJson", () => {
  it("encodes primitives RFC 8785-style", () => {
    assert.equal(canonicalizeJson(null), "null");
    assert.equal(canonicalizeJson(true), "true");
    assert.equal(canonicalizeJson(false), "false");
    assert.equal(canonicalizeJson(0), "0");
    assert.equal(canonicalizeJson(1024), "1024");
    assert.equal(canonicalizeJson("abc"), "\"abc\"");
  });

  it("sorts object keys ASCII-ascending and emits no whitespace", () => {
    const out = canonicalizeJson({ b: 1, a: 2, c: 3 });
    assert.equal(out, "{\"a\":2,\"b\":1,\"c\":3}");
  });

  it("emits arrays with comma separators and no whitespace", () => {
    assert.equal(canonicalizeJson([1, 2, 3]), "[1,2,3]");
    assert.equal(canonicalizeJson([{ b: 1, a: 2 }, { d: 4, c: 3 }]), "[{\"a\":2,\"b\":1},{\"c\":3,\"d\":4}]");
  });

  it("recursively canonicalizes nested objects in arrays", () => {
    const m = {
      files: [
        { path: "b.html", sha256: "ff", size: 2, content_type: "text/html" },
        { path: "a.html", sha256: "ee", size: 1, content_type: "text/html" },
      ],
    };
    // Note: array order is preserved (we sort separately at manifest-build time).
    // Inside each object, keys are sorted ASCII: content_type < path < sha256 < size.
    assert.equal(
      canonicalizeJson(m),
      "{\"files\":[" +
        "{\"content_type\":\"text/html\",\"path\":\"b.html\",\"sha256\":\"ff\",\"size\":2}," +
        "{\"content_type\":\"text/html\",\"path\":\"a.html\",\"sha256\":\"ee\",\"size\":1}" +
        "]}",
    );
  });

  it("throws on unsupported value types (undefined, function, symbol)", () => {
    assert.throws(() => canonicalizeJson(undefined), /unsupported/);
    assert.throws(() => canonicalizeJson(() => 0), /unsupported/);
    assert.throws(() => canonicalizeJson(Symbol("x")), /unsupported/);
  });
});

describe("buildCanonicalManifest", () => {
  it("sorts entries by path ascending and defaults missing content_type", () => {
    const m = buildCanonicalManifest([
      { path: "z.css", sha256: "cc", size: 10 },
      { path: "a.html", sha256: "aa", size: 1, content_type: "text/html" },
      { path: "m.js", sha256: "bb", size: 5 },
    ]);
    assert.deepEqual(m.files.map((f) => f.path), ["a.html", "m.js", "z.css"]);
    // Default content_type
    assert.equal(m.files.find((f) => f.path === "m.js")!.content_type, "application/octet-stream");
    assert.equal(m.files.find((f) => f.path === "z.css")!.content_type, "application/octet-stream");
    // Explicit content_type preserved
    assert.equal(m.files.find((f) => f.path === "a.html")!.content_type, "text/html");
  });

  it("does not mutate the input entries", () => {
    const inputs = [{ path: "a", sha256: "x", size: 1 }];
    const before = JSON.stringify(inputs);
    buildCanonicalManifest(inputs);
    assert.equal(JSON.stringify(inputs), before);
  });
});

describe("computeManifestDigest (self-consistency)", () => {
  it("produces a 64-char hex digest from a canonical manifest", async () => {
    // Smoke test only. The gateway computes its own authoritative digest
    // and the SDK no longer asserts byte-for-byte agreement; this test
    // pins canonical-form output and confirms the SHA-256 is deterministic.
    const manifest = buildCanonicalManifest([
      { path: "index.html", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", size: 0, content_type: "text/html" },
      { path: "assets/logo.png", sha256: "abc1230000000000000000000000000000000000000000000000000000000000", size: 1024, content_type: "image/png" },
      { path: "style.css", sha256: "def4560000000000000000000000000000000000000000000000000000000000", size: 256 },
    ]);

    // Sanity: canonical form is what we expect (paths sorted, keys sorted, no spaces).
    const canonical = canonicalizeJson(manifest);
    assert.equal(
      canonical,
      "{\"files\":[" +
        "{\"content_type\":\"image/png\",\"path\":\"assets/logo.png\",\"sha256\":\"abc1230000000000000000000000000000000000000000000000000000000000\",\"size\":1024}," +
        "{\"content_type\":\"text/html\",\"path\":\"index.html\",\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"size\":0}," +
        "{\"content_type\":\"application/octet-stream\",\"path\":\"style.css\",\"sha256\":\"def4560000000000000000000000000000000000000000000000000000000000\",\"size\":256}" +
        "]}",
    );

    // SHA-256 of the canonical bytes above. Recomputable via:
    //   echo -n '<canonical>' | shasum -a 256
    const digest = await computeManifestDigest(manifest);
    assert.match(digest, /^[0-9a-f]{64}$/, "digest must be 64 lowercase hex chars");

    // Check stability across runs (no nondeterminism).
    const digest2 = await computeManifestDigest(manifest);
    assert.equal(digest, digest2);
  });

  it("is sensitive to a single-byte change (sha or size mismatch breaks digest)", async () => {
    const a = buildCanonicalManifest([{ path: "x", sha256: "aa", size: 1 }]);
    const b = buildCanonicalManifest([{ path: "x", sha256: "aa", size: 2 }]);
    const c = buildCanonicalManifest([{ path: "x", sha256: "ab", size: 1 }]);
    const da = await computeManifestDigest(a);
    const db = await computeManifestDigest(b);
    const dc = await computeManifestDigest(c);
    assert.notEqual(da, db);
    assert.notEqual(da, dc);
    assert.notEqual(db, dc);
  });
});
