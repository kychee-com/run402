import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

mock.module("./config.js", {
  namedExports: {
    config: {
      API_BASE: "https://test.run402.com",
      PROJECT_ID: "prj_test",
      SERVICE_KEY: "sk_test",
    },
  },
});

const { assets } = await import("./assets.js");

const STUB_REF = {
  key: "images/avatar.png",
  sha256: "abc123",
  size_bytes: 4,
  content_type: "image/png",
  visibility: "public",
  immutable: true,
  url: "https://cdn.run402.com/images/avatar.png",
  immutable_url: "https://cdn.run402.com/images/avatar.png@abc123",
  cdn_url: null,
  cdn_immutable_url: null,
  sri: null,
  etag: "abc123",
  content_digest: "sha256-abc123",
};

describe("assets.put — gateway path and auth", () => {
  let capturedUrl = "";
  let capturedOpts: RequestInit = {};

  beforeEach(() => {
    capturedUrl = "";
    capturedOpts = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedOpts = opts;
      return new Response(JSON.stringify(STUB_REF), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  it("posts to /apply/v1/service-asset-put with service credentials", async () => {
    await assets.put("images/avatar.png", new Uint8Array([1, 2, 3, 4]));

    assert.equal(capturedUrl, "https://test.run402.com/apply/v1/service-asset-put");
    assert.equal(capturedOpts.method, "POST");
    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk_test");
  });

  it("sets x-run402-asset-key header to the key argument", async () => {
    await assets.put("images/avatar.png", new Uint8Array([1, 2, 3, 4]));

    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["x-run402-asset-key"], "images/avatar.png");
  });

  it("defaults visibility to public and immutable to true", async () => {
    await assets.put("images/avatar.png", new Uint8Array([1, 2, 3, 4]));

    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["x-run402-asset-visibility"], "public");
    assert.equal(headers["x-run402-asset-immutable"], "true");
  });

  it("forwards explicit visibility and immutable options", async () => {
    await assets.put("data/secret.bin", new Uint8Array([1, 2, 3, 4]), {
      visibility: "private",
      immutable: false,
    });

    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["x-run402-asset-visibility"], "private");
    assert.equal(headers["x-run402-asset-immutable"], "false");
  });

  it("guesses Content-Type from key extension", async () => {
    await assets.put("styles/main.css", new Uint8Array([46, 99, 108, 115]));

    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "text/css; charset=utf-8");
  });

  it("uses explicit contentType option over guessed extension", async () => {
    await assets.put("data/blob", new Uint8Array([1, 2, 3, 4]), {
      contentType: "application/msgpack",
    });

    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/msgpack");
  });

  it("sends raw binary body (not JSON)", async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    await assets.put("file.bin", bytes);

    assert.ok(capturedOpts.body instanceof ArrayBuffer, "body must be ArrayBuffer (binary)");
    assert.notEqual(typeof capturedOpts.body, "string", "body must not be stringified");
  });

  it("accepts a string source — encodes to UTF-8 bytes", async () => {
    await assets.put("hello.txt", "hello");

    assert.ok(capturedOpts.body instanceof ArrayBuffer);
    const decoded = new TextDecoder().decode(capturedOpts.body as ArrayBuffer);
    assert.equal(decoded, "hello");
  });

  it("returns a widened AssetRef with camelCase aliases", async () => {
    const ref = await assets.put("images/avatar.png", new Uint8Array([1, 2, 3, 4]));

    assert.equal(ref.key, "images/avatar.png");
    assert.equal(ref.immutableUrl, STUB_REF.immutable_url);
    assert.equal(ref.contentType, STUB_REF.content_type);
    assert.equal(ref.size, STUB_REF.size_bytes);
    assert.equal(ref.contentSha256, STUB_REF.sha256);
  });
});

describe("assets.put — validation", () => {
  it("throws for empty key", async () => {
    await assert.rejects(
      async () => { await assets.put("", new Uint8Array([1])); },
      /key must be a non-empty string/,
    );
  });

  it("throws for empty source bytes", async () => {
    await assert.rejects(
      async () => { await assets.put("file.bin", new Uint8Array([])); },
      /bytes must be non-empty/,
    );
  });

  it("throws for object source with both content and bytes", async () => {
    await assert.rejects(
      async () => {
        await assets.put("f.bin", { content: "hi", bytes: new Uint8Array([1]) });
      },
      /provide exactly one of/,
    );
  });

  it("throws on non-ok response and preserves error detail", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ code: "STORAGE_QUOTA_EXCEEDED", message: "over limit" }), {
        status: 402,
      }),
    );
    await assert.rejects(
      async () => { await assets.put("f.bin", new Uint8Array([1])); },
      /Asset put failed \(402\): STORAGE_QUOTA_EXCEEDED: over limit/,
    );
  });
});
