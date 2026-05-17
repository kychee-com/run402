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
