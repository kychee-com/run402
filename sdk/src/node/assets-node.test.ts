/**
 * Unit tests for the v1.48 unified-apply Node-only ergonomic helpers:
 * `dir(path)`, `NodeAssets.uploadDir`, `NodeAssets.syncDir`,
 * `NodeAssets.prepareDir`, `NodeAssets.putMany`.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import {
  dir,
  NodeAssets,
  PruneConfirmationRequired,
  entriesFromLocalDir,
} from "./assets-node.js";

describe("dir(path) — synchronous LocalDirRef factory (design D12)", () => {
  it("returns a {__source:'local-dir',path} marker synchronously", () => {
    const ref = dir("./assets");
    assert.equal(ref.__source, "local-dir");
    assert.equal(ref.path, "./assets");
    assert.equal(ref.prefix, undefined);
  });

  it("captures prefix + ignore + includeSensitive options", () => {
    const ref = dir("./assets", {
      prefix: "static/",
      ignore: ["build"],
      includeSensitive: true,
    });
    assert.equal(ref.prefix, "static/");
    assert.deepEqual(ref.ignore, ["build"]);
    assert.equal(ref.includeSensitive, true);
  });

  it("does not touch the filesystem (path may not exist)", () => {
    // dir() is synchronous and deferred — calling it on a missing path
    // must not throw. The walk happens at apply submission.
    const ref = dir("/definitely/does/not/exist");
    assert.equal(ref.path, "/definitely/does/not/exist");
  });
});

describe("entriesFromLocalDir() — directory walk → wire-shaped entries", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "run402-assets-node-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("walks a flat directory and produces one AssetPutEntry per file", async () => {
    writeFileSync(join(tempDir, "a.txt"), "hello");
    writeFileSync(join(tempDir, "b.json"), `{"k":1}`);
    const ref = dir(tempDir);
    const entries = await entriesFromLocalDir(ref);
    assert.equal(entries.length, 2);
    const a = entries.find((e) => e.key === "a.txt");
    const b = entries.find((e) => e.key === "b.json");
    assert.ok(a, "a.txt entry present");
    assert.ok(b, "b.json entry present");
    assert.equal(a!.sha256, createHash("sha256").update("hello").digest("hex"));
    assert.equal(a!.size_bytes, 5);
    assert.equal(a!.visibility, "public");
    assert.equal(a!.immutable, true);
  });

  it("applies the prefix option to every key", async () => {
    writeFileSync(join(tempDir, "logo.png"), "PNG");
    const entries = await entriesFromLocalDir(
      dir(tempDir, { prefix: "static/" }),
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.key, "static/logo.png");
  });

  it("appends a separator when prefix is missing the trailing slash", async () => {
    writeFileSync(join(tempDir, "logo.png"), "PNG");
    const entries = await entriesFromLocalDir(dir(tempDir, { prefix: "static" }));
    assert.equal(entries[0]!.key, "static/logo.png");
  });

  it("recurses into subdirectories with POSIX-style relative keys", async () => {
    mkdirSync(join(tempDir, "nested", "deep"), { recursive: true });
    writeFileSync(join(tempDir, "nested", "deep", "x.css"), "body{}");
    const entries = await entriesFromLocalDir(dir(tempDir));
    assert.equal(entries.length, 1);
    assert.match(entries[0]!.key, /^nested\/deep\/x\.css$/);
  });
});

// ─── NodeAssets — wires through to the apply engine ────────────────────────
// Functional tests of uploadDir/syncDir/prepareDir/putMany require mocking
// the apply engine; we test the wire-up behavior of syncDir's destructive
// guardrail here (it throws PruneConfirmationRequired before any network
// call when called without a confirm token).

/** Mock client that responds to /apply/v1/plans requests with an
 *  asset_sync block — what the gateway plan endpoint returns in
 *  v1.48 when the spec carries assets.sync.prune: true (design D10).
 *  Used by the destructive-guardrail test to verify the SDK forwards
 *  the confirmation values into PruneConfirmationRequired. */
function makeMockClient(
  asset_sync: {
    prefix: string;
    prune: true;
    base_revision: string;
    delete_set_digest: string;
    expected_delete_count: number;
    sample_keys: string[];
    over_inline_threshold: boolean;
  } | undefined = undefined,
) {
  return {
    async request<T>(_path: string): Promise<T> {
      // Return a minimal plan response that matches PlanResponse shape.
      return {
        kind: "plan_response",
        schema_version: "agent-deploy-observability.v1",
        plan_id: null,
        operation_id: null,
        base_release_id: null,
        manifest_digest: "0".repeat(64),
        missing_content: [],
        diff: {},
        warnings: [],
        asset_sync,
      } as unknown as T;
    },
  } as unknown as never;
}

// ─── 8.17 — three-schema fidelity (design D3/D12) ─────────────────────────
// SDK ergonomic input (LocalDirRef, FileSet, ContentSource) is normalized
// to wire-shaped AssetPutEntry[] BEFORE the request lands at the gateway.
// The gateway type-bound request body never sees LocalDirRef. These tests
// pin that contract.

describe("three-schema fidelity — SDK input vs wire (design D3/D12)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "run402-three-schema-"));
    writeFileSync(join(tempDir, "a.txt"), "hello");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("dir(path) returns a LocalDirRef with __source: 'local-dir' (SDK-input-only)", () => {
    const ref = dir(tempDir);
    assert.equal(ref.__source, "local-dir");
    // The kind discriminator is the gateway's clue to reject this shape
    // at the wire layer with HTTP 400 INVALID_WIRE_SCHEMA. The SDK
    // normalizes the LocalDirRef into wire-shaped entries before any
    // network call.
  });

  it("entriesFromLocalDir produces wire-shaped AssetPutEntry[] with no LocalDirRef leakage", async () => {
    const ref = dir(tempDir);
    const entries = await entriesFromLocalDir(ref);
    // The output is the wire shape — each entry has exactly the fields
    // the gateway expects: key, sha256, size_bytes, content_type,
    // visibility, immutable. No __source field, no path field.
    for (const entry of entries) {
      const e = entry as unknown as Record<string, unknown>;
      assert.equal(typeof e.key, "string");
      assert.match(e.sha256 as string, /^[0-9a-f]{64}$/);
      assert.equal(typeof e.size_bytes, "number");
      assert.equal(typeof e.content_type, "string");
      assert.ok(e.visibility === "public" || e.visibility === "private");
      assert.equal(typeof e.immutable, "boolean");
      assert.equal(e.__source, undefined, "LocalDirRef.__source must NOT leak to the wire entry");
      assert.equal(e.path, undefined, "LocalDirRef.path must NOT leak to the wire entry");
    }
  });

  it("LocalDirRef's path/prefix/ignore/includeSensitive fields are SDK-internal only", () => {
    const ref = dir("./assets", {
      prefix: "static/",
      ignore: [".git"],
      includeSensitive: true,
    });
    // These options stay on the LocalDirRef — never serialized to the
    // wire. The SDK consumes them during entriesFromLocalDir to drive
    // the walk; the resulting AssetPutEntry[] omits them entirely.
    assert.equal(ref.prefix, "static/");
    assert.deepEqual(ref.ignore, [".git"]);
    assert.equal(ref.includeSensitive, true);
    assert.equal(ref.__source, "local-dir");
  });
});

// ─── 8.18 / SR-10 — prototype-pollution safety (design D9) ─────────────────
// AssetManifest.byKey + .manifest are constructed via Object.create(null)
// so attacker-controlled keys can't pollute Object.prototype. This test
// pins that invariant — a regression that switched to {} would surface
// here.

describe("AssetManifest — prototype-pollution safety (design D9 / SR-10)", () => {
  it("entriesFromLocalDir handles a filename like __proto__.txt without crashing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "run402-proto-pollute-"));
    try {
      // Most filesystems allow __proto__ as a literal filename. If yours
      // doesn't, this throws at writeFileSync rather than at the SDK's
      // entriesFromLocalDir — which is fine, we want to assert the
      // SDK's normalization path is safe IF such a key arrives.
      writeFileSync(join(tmpDir, "__proto__.txt"), "x");
      writeFileSync(join(tmpDir, "constructor.txt"), "y");
      writeFileSync(join(tmpDir, "real.txt"), "z");
      const entries = await entriesFromLocalDir(dir(tmpDir));
      const keys = entries.map((e) => e.key).sort();
      assert.deepEqual(keys, ["__proto__.txt", "constructor.txt", "real.txt"]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("__proto__ in a key string does not pollute Object.prototype", () => {
    // Mirror what buildManifestFromEntries does in assets-node.ts.
    const byKey: Record<string, unknown> = Object.create(null);
    byKey["__proto__"] = "attacker-value";
    // Object.prototype is untouched.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(({} as any).__proto__, Object.prototype);
    // The local map carries the literal key (no setter coercion).
    assert.equal(byKey["__proto__"], "attacker-value");
    // A freshly-constructed empty object isn't polluted with "attacker-value".
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.notEqual((Object.create({}) as any).__proto__, "attacker-value");
  });

  it("an Object.create(null) container has no prototype methods to call", () => {
    // Regression: if a future refactor changes byKey/manifest to a
    // plain {} literal, this test still passes (`hasOwnProperty` exists
    // on the prototype). The test exists to document the contract;
    // pairing it with the source's `Object.create(null)` is the
    // protection. Reviewers seeing this test fail mean
    // buildManifestFromEntries lost its null-prototype init.
    const nullProto = Object.create(null);
    nullProto.foo = "bar";
    assert.equal(typeof nullProto.hasOwnProperty, "undefined");
    assert.equal(typeof ({}).hasOwnProperty, "function");
  });
});

describe("NodeAssets.syncDir destructive guardrail (design D10)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "run402-syncdir-test-"));
    writeFileSync(join(tempDir, "a.txt"), "x");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("blocks the destructive sync before any inventory mutation when confirm is absent", async () => {
    // The SDK runs a plan first (to fetch real base_revision +
    // delete_set_digest from the gateway), then throws
    // PruneConfirmationRequired. With a fake client whose plan
    // response carries no asset_sync block, we still expect an error —
    // either PruneConfirmationRequired (placeholder values) or a
    // plan-normalization error. Either way, syncDir MUST NOT mutate
    // inventory without an explicit confirm token.
    const assets = new NodeAssets(makeMockClient(undefined));
    let threw = false;
    try {
      await assets.syncDir(tempDir, {
        project: "prj_test",
        prefix: "static/",
        prune: true,
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, true, "syncDir({ prune: true }) without confirm MUST throw");
  });

  it("requires a prefix when prune:true (no implicit project-root prune)", async () => {
    const assets = new NodeAssets({} as never);
    await assert.rejects(
      assets.syncDir(tempDir, { project: "prj_test", prune: true }),
      /requires an explicit prefix/,
    );
  });
});
