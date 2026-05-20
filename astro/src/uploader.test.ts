import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BuildCache } from "./cache.js";
import { GatewayUploadError } from "./errors.js";
import type { AssetRef } from "./types.js";
import type { ProjectAssetsClient } from "./uploader.js";
import { uploadAll } from "./uploader.js";

function fakeAssetRef(overrides: Partial<AssetRef> = {}): AssetRef {
  return {
    key: "astro/hero.jpg",
    sha256: "a".repeat(64),
    size_bytes: 100,
    content_type: "image/jpeg",
    url: "https://example.com/u",
    cdn_url: "https://cdn.example.com/u",
    width_px: 1600,
    height_px: 1200,
    blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
    variant_spec_version: "v1",
    display_url: "https://cdn.example.com/u",
    ...overrides,
  };
}

function makeClient(handler: (key: string, bytes: Uint8Array) => Promise<AssetRef>): {
  client: ProjectAssetsClient;
  callCount: () => number;
} {
  let calls = 0;
  return {
    client: {
      assets: {
        put: async (key, source) => {
          calls++;
          const bytes =
            source instanceof Buffer ? source : Buffer.from(source as Uint8Array | string);
          return handler(key, bytes);
        },
      },
    },
    callCount: () => calls,
  };
}

describe("uploader", () => {
  let root: string;
  let img: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "r402-uploader-"));
    mkdirSync(join(root, "images"), { recursive: true });
    img = join(root, "images", "hero.jpg");
    writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uploads on cache miss and caches the result", async () => {
    const cache = new BuildCache(root);
    const { client, callCount } = makeClient(async () => fakeAssetRef());
    const summary = await uploadAll([img], client, cache);
    assert.equal(summary.uploaded, 1);
    assert.equal(summary.fromCache, 0);
    assert.equal(callCount(), 1);

    // Second call hits cache (same content), zero gateway calls.
    const summary2 = await uploadAll([img], client, cache);
    assert.equal(summary2.uploaded, 0);
    assert.equal(summary2.fromCache, 1);
    assert.equal(callCount(), 1, "no additional gateway calls expected");
  });

  it("returns AssetRef in summary.results keyed by absolute path", async () => {
    const cache = new BuildCache(root);
    const customRef = fakeAssetRef({ blurhash: "L0xx" });
    const { client } = makeClient(async () => customRef);
    const summary = await uploadAll([img], client, cache);
    const got = summary.results.get(img);
    assert.ok(got);
    assert.equal(got.assetRef.blurhash, "L0xx");
    assert.equal(got.fromCache, false);
  });

  it("dedupes identical paths in the input", async () => {
    const cache = new BuildCache(root);
    const { client, callCount } = makeClient(async () => fakeAssetRef());
    const summary = await uploadAll([img, img, img], client, cache);
    assert.equal(summary.total, 1, "duplicates should be deduped");
    assert.equal(callCount(), 1);
  });

  it("retries on TOO_MANY_ENCODES_QUEUED then succeeds", async () => {
    const cache = new BuildCache(root);
    let attempts = 0;
    const { client } = makeClient(async () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error("encoder queue full");
        (err as unknown as { code: string; retryAfter: number }).code =
          "TOO_MANY_ENCODES_QUEUED";
        (err as unknown as { code: string; retryAfter: number }).retryAfter = 0.01;
        throw err;
      }
      return fakeAssetRef();
    });
    const summary = await uploadAll([img], client, cache, { maxRetries: 5 });
    assert.equal(summary.uploaded, 1);
    assert.equal(attempts, 3);
  });

  it("uses batched putMany when client exposes it and projectId is set", async () => {
    // kychee-com/run402-private#408 follow-up: ONE plan + ONE commit
    // for all cache-miss files instead of N per-file plans. Verifies
    // putMany is called exactly once with all items.
    const p1 = join(root, "images", "a.jpg");
    const p2 = join(root, "images", "b.jpg");
    const p3 = join(root, "images", "c.jpg");
    writeFileSync(p1, Buffer.from([0xff, 0xd8, 1]));
    writeFileSync(p2, Buffer.from([0xff, 0xd8, 2]));
    writeFileSync(p3, Buffer.from([0xff, 0xd8, 3]));

    let putManyCalls = 0;
    let perCallPut = 0;
    const client: ProjectAssetsClient = {
      assets: {
        put: async () => {
          perCallPut++;
          return fakeAssetRef();
        },
        putMany: async (items, _opts) => {
          putManyCalls++;
          return {
            byKey: Object.fromEntries(
              items.map((item) => [item.key, fakeAssetRef({ key: item.key })]),
            ),
          };
        },
      },
    };

    const cache = new BuildCache(root);
    const summary = await uploadAll([p1, p2, p3], client, cache, {
      projectId: "prj_test",
    });

    assert.equal(putManyCalls, 1, "putMany must be called exactly once");
    assert.equal(perCallPut, 0, "per-file put must NOT be called when batched path is available");
    assert.equal(summary.uploaded, 3);
    assert.equal(summary.fromCache, 0);
  });

  it("falls back to per-file put when client lacks putMany OR projectId is unset", async () => {
    // When projectId is omitted, even a putMany-capable client falls
    // back to per-file. Keeps the legacy path available for tests and
    // mocked clients.
    const cache = new BuildCache(root);
    let perCallPut = 0;
    const client: ProjectAssetsClient = {
      assets: {
        put: async () => {
          perCallPut++;
          return fakeAssetRef();
        },
        putMany: async () => {
          throw new Error("putMany should not be called");
        },
      },
    };
    const summary = await uploadAll([img], client, cache);
    assert.equal(perCallPut, 1);
    assert.equal(summary.uploaded, 1);
  });

  it("retries on BASE_RELEASE_CONFLICT then succeeds (kychee-com/run402-private#408)", async () => {
    // Apply-substrate race: another deploy activated a new release
    // between plan and commit. With concurrency=1 the retry should
    // succeed on attempt 2 (no other in-flight ops to lose to).
    const cache = new BuildCache(root);
    let attempts = 0;
    const { client } = makeClient(async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error(
          "Another deploy activated release 'rel_X' since this operation was planned against base 'rel_Y'. Re-plan and retry.",
        );
        (err as unknown as { code: string; retryAfter: number }).code =
          "BASE_RELEASE_CONFLICT";
        (err as unknown as { code: string; retryAfter: number }).retryAfter = 0.01;
        throw err;
      }
      return fakeAssetRef();
    });
    const summary = await uploadAll([img], client, cache, { maxRetries: 3 });
    assert.equal(summary.uploaded, 1);
    assert.equal(attempts, 2);
  });

  it("throws GatewayUploadError after exhausting retries", async () => {
    const cache = new BuildCache(root);
    const { client } = makeClient(async () => {
      const err = new Error("queue still full");
      (err as unknown as { code: string; retryAfter: number }).code =
        "TOO_MANY_ENCODES_QUEUED";
      (err as unknown as { code: string; retryAfter: number }).retryAfter = 0.01;
      throw err;
    });
    await assert.rejects(
      uploadAll([img], client, cache, { maxRetries: 2 }),
      (err) =>
        err instanceof GatewayUploadError && err.code === "TOO_MANY_ENCODES_QUEUED" && err.absolutePath === img,
    );
  });

  it("does NOT retry on IMAGE_DECODE_FAILED (non-retryable)", async () => {
    const cache = new BuildCache(root);
    let attempts = 0;
    const { client } = makeClient(async () => {
      attempts++;
      const err = new Error("corrupt input");
      (err as unknown as { code: string }).code = "IMAGE_DECODE_FAILED";
      throw err;
    });
    await assert.rejects(
      uploadAll([img], client, cache),
      (err) => err instanceof GatewayUploadError && err.code === "IMAGE_DECODE_FAILED",
    );
    assert.equal(attempts, 1);
  });

  it("surfaces gateway envelope code via err.envelope.code", async () => {
    const cache = new BuildCache(root);
    const { client } = makeClient(async () => {
      const err = new Error("quota");
      (err as unknown as { envelope: { code: string } }).envelope = {
        code: "QUOTA_EXCEEDED",
      };
      throw err;
    });
    await assert.rejects(
      uploadAll([img], client, cache),
      (err) => err instanceof GatewayUploadError && err.code === "QUOTA_EXCEEDED",
    );
  });

  it("bounded parallelism caps in-flight calls", async () => {
    const paths: string[] = [];
    for (let i = 0; i < 10; i++) {
      const p = join(root, "images", `img${i}.jpg`);
      writeFileSync(p, Buffer.from([0xff, 0xd8, i]));
      paths.push(p);
    }
    const cache = new BuildCache(root);
    let inFlight = 0;
    let maxInFlight = 0;
    const { client } = makeClient(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return fakeAssetRef();
    });
    await uploadAll(paths, client, cache, { concurrency: 3 });
    assert.ok(maxInFlight <= 3, `max in-flight ${maxInFlight} should be ≤ 3`);
  });
});
