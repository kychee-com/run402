/**
 * Unit tests for the `blobs` namespace. Covers all 5 methods, including
 * the multi-step upload flow (init → PUT parts → complete) and the
 * streaming Response return from `get()`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { ProjectNotFound, ApiError, LocalError } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function makeCreds(): CredentialsProvider {
  return {
    async getAuth() { return { "SIGN-IN-WITH-X": "test" }; },
    async getProject(id: string) {
      if (id === "prj_known") return { anon_key: "anon_k", service_key: "svc_k" };
      return null;
    },
  };
}

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  return new Run402({
    apiBase: "https://api.example.test",
    credentials: makeCreds(),
    fetch: fetchImpl,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("blobs.put", () => {
  it("runs init → PUT → complete flow for small content", async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.endsWith("/storage/v1/uploads") && call.method === "POST") {
        return json({
          upload_id: "u_42",
          mode: "single",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.test/u_42/p1", byte_start: 0, byte_end: 11 }],
        });
      }
      if (call.url === "https://s3.test/u_42/p1" && call.method === "PUT") {
        return new Response("", {
          status: 200,
          headers: { etag: '"etag-part1"' },
        });
      }
      if (call.url.endsWith("/storage/v1/uploads/u_42/complete") && call.method === "POST") {
        return json({
          key: "hello.txt",
          size_bytes: 12,
          sha256: null,
          visibility: "public",
          url: "https://cdn.test/hello.txt",
          immutable_url: null,
        });
      }
      throw new Error("unexpected call: " + call.url);
    });

    const sdk = makeSdk(fetch);
    // Pass `immutable: false` explicitly: this test verifies the basic flow
    // shape (init → PUT → complete) and non-immutable URL semantics while
    // still sending the required digest to the upload API.
    // The v1.45 default is `immutable: true`; the dedicated default-and-
    // tag-emitter tests below cover that path.
    const result = await sdk.assets.put(
      "prj_known", "hello.txt", { content: "hello world\n" },
      { immutable: false },
    );

    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.url, "https://api.example.test/storage/v1/uploads");
    assert.equal(calls[0]!.headers["apikey"], "svc_k");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer svc_k");
    const initBody = JSON.parse(calls[0]!.body as string);
    assert.equal(initBody.key, "hello.txt");
    assert.equal(initBody.size_bytes, 12);
    assert.equal(initBody.visibility, "public");
    assert.equal(initBody.immutable, false);
    assert.equal(initBody.sha256, "a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447");
    // S3 PUT — no SIWX, no gateway apiBase, uses presigned URL as-is.
    assert.equal(calls[1]!.url, "https://s3.test/u_42/p1");
    assert.equal(calls[1]!.method, "PUT");
    assert.equal(calls[1]!.headers["x-amz-checksum-sha256"], "qUiQTy8PR5uPgZdpSzAYSw0u0cHNKh7A+4XSmaGSpEc=");
    // Complete
    assert.equal(calls[2]!.url, "https://api.example.test/storage/v1/uploads/u_42/complete");
    assert.equal(result.key, "hello.txt");
    assert.equal(result.url, "https://cdn.test/hello.txt");
  });

  it("defaults to immutable: true (v1.45) — computes SHA + sends content-hashed flag", async () => {
    let initBody: Record<string, unknown> | null = null;
    const { fetch } = mockFetch((call) => {
      if (call.url.endsWith("/storage/v1/uploads")) {
        initBody = JSON.parse(call.body as string);
        return json({
          upload_id: "u_d",
          mode: "single",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.test/u_d/p1", byte_start: 0, byte_end: 2 }],
        });
      }
      if (call.url.startsWith("https://s3.test/")) {
        return new Response("", { status: 200, headers: { etag: '"e"' } });
      }
      if (call.url.endsWith("/complete")) {
        return json({
          key: "hello.txt",
          size_bytes: 3,
          sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
          visibility: "public",
          content_type: "text/plain",
          immutable_suffix: "ba7816bf",
          url: "https://cdn.test/hello.txt",
          immutable_url: "https://cdn.test/hello-ba7816bf.txt",
          cdn_url: "https://pr-abc.run402.com/_blob/hello.txt",
          cdn_immutable_url: "https://pr-abc.run402.com/_blob/hello-ba7816bf.txt",
        });
      }
      throw new Error("unexpected: " + call.url);
    });
    const sdk = makeSdk(fetch);
    // No opts — relying on v1.45 defaults.
    const asset = await sdk.assets.put("prj_known", "hello.txt", { content: "abc" });
    assert.equal(initBody!.immutable, true);
    assert.equal(
      initBody!.sha256,
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    assert.ok(asset.cdnUrl, "cdnUrl populated by default");
    assert.ok(asset.sri, "sri populated by default");
    // Tag emitters work without the agent ever passing { immutable: true }.
    const tag = asset.scriptTag();
    assert.match(tag, /integrity="sha256-/);
  });

  it("attaches parts with etags and sha256 in multipart mode", async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.endsWith("/storage/v1/uploads") && call.method === "POST") {
        return json({
          upload_id: "u_2",
          mode: "multipart",
          part_count: 2,
          parts: [
            { part_number: 1, url: "https://s3.test/u_2/p1", byte_start: 0, byte_end: 5 },
            { part_number: 2, url: "https://s3.test/u_2/p2", byte_start: 6, byte_end: 11 },
          ],
        });
      }
      if (call.url === "https://s3.test/u_2/p1") {
        return new Response("", { status: 200, headers: { etag: '"e1"' } });
      }
      if (call.url === "https://s3.test/u_2/p2") {
        return new Response("", { status: 200, headers: { etag: '"e2"' } });
      }
      if (call.url.endsWith("/complete")) {
        return json({ key: "multi.bin", size_bytes: 12, sha256: null, visibility: "public", url: null, immutable_url: null });
      }
      throw new Error("unexpected");
    });
    const sdk = makeSdk(fetch);
    // Pin immutable: false — this test asserts on the multipart-complete
    // shape, not on the sha-computation path.
    await sdk.assets.put(
      "prj_known", "multi.bin", { bytes: new Uint8Array(12) },
      { immutable: false },
    );
    const completeBody = JSON.parse(calls[3]!.body as string);
    assert.deepEqual(completeBody.parts, [
      { part_number: 1, etag: '"e1"', sha256: "b0f66adc83641586656866813fd9dd0b8ebb63796075661ba45d1aa8089e1d44" },
      { part_number: 2, etag: '"e2"', sha256: "b0f66adc83641586656866813fd9dd0b8ebb63796075661ba45d1aa8089e1d44" },
    ]);
  });

  it("does not duplicate checksum header when the presigned URL carries the checksum", async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.endsWith("/storage/v1/uploads")) {
        return json({
          upload_id: "u_q",
          mode: "single",
          part_count: 1,
          parts: [{
            part_number: 1,
            url: "https://s3.test/u_q/p1?x-amz-checksum-sha256=encoded",
            byte_start: 0,
            byte_end: 2,
          }],
        });
      }
      if (call.url.startsWith("https://s3.test/")) {
        return new Response("", { status: 200, headers: { etag: '"e"' } });
      }
      if (call.url.endsWith("/complete")) {
        return json({
          key: "x.txt", size_bytes: 3, sha256: null, visibility: "public",
          url: null, immutable_url: null,
        });
      }
      throw new Error("unexpected");
    });
    const sdk = makeSdk(fetch);
    await sdk.assets.put("prj_known", "x.txt", { content: "abc" }, { immutable: false });
    assert.equal(calls[1]!.headers["x-amz-checksum-sha256"], undefined);
  });

  it("computes sha256 when immutable is true", async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.endsWith("/storage/v1/uploads")) {
        return json({
          upload_id: "u_i",
          mode: "single",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.test/u_i/p1", byte_start: 0, byte_end: 2 }],
        });
      }
      if (call.url.startsWith("https://s3.test/")) {
        return new Response("", { status: 200, headers: { etag: '"e"' } });
      }
      if (call.url.endsWith("/complete")) {
        return json({
          key: "x.txt", size_bytes: 3, sha256: "abc", visibility: "public",
          url: null, immutable_url: "https://cdn.test/x.abc.txt",
        });
      }
      throw new Error("unexpected");
    });
    const sdk = makeSdk(fetch);
    await sdk.assets.put("prj_known", "x.txt", { content: "abc" }, { immutable: true });
    const initBody = JSON.parse(calls[0]!.body as string);
    assert.equal(initBody.immutable, true);
    assert.ok(typeof initBody.sha256 === "string" && initBody.sha256.length === 64);
    // Known sha256 of "abc"
    assert.equal(initBody.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("accepts a bare string as a polymorphic source (GH-126)", async () => {
    let initBody: Record<string, unknown> | null = null;
    const { fetch } = mockFetch((call) => {
      if (call.url.endsWith("/storage/v1/uploads")) {
        initBody = JSON.parse(call.body as string);
        return json({
          upload_id: "u_str",
          mode: "single",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.test/u_str/p1", byte_start: 0, byte_end: 9 }],
        });
      }
      if (call.url.startsWith("https://s3.test/")) {
        return new Response("", { status: 200, headers: { etag: '"e"' } });
      }
      if (call.url.endsWith("/complete")) {
        return json({
          key: "blob.txt",
          size_bytes: 10,
          sha256: null,
          visibility: "public",
          url: "https://cdn.test/blob.txt",
          immutable_url: null,
        });
      }
      throw new Error("unexpected: " + call.url);
    });
    const sdk = makeSdk(fetch);
    // The natural "just give me a string" call shape — no { content: ... } wrapper.
    const result = await sdk.assets.put(
      "prj_known", "blob.txt", "hello blob",
      { immutable: false },
    );
    assert.equal(result.key, "blob.txt");
    assert.equal(initBody!.size_bytes, 10);
  });

  it("accepts a bare Uint8Array as a polymorphic source (GH-126)", async () => {
    let initBody: Record<string, unknown> | null = null;
    const { fetch } = mockFetch((call) => {
      if (call.url.endsWith("/storage/v1/uploads")) {
        initBody = JSON.parse(call.body as string);
        return json({
          upload_id: "u_u8",
          mode: "single",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.test/u_u8/p1", byte_start: 0, byte_end: 4 }],
        });
      }
      if (call.url.startsWith("https://s3.test/")) {
        return new Response("", { status: 200, headers: { etag: '"e"' } });
      }
      if (call.url.endsWith("/complete")) {
        return json({
          key: "raw.bin",
          size_bytes: 5,
          sha256: null,
          visibility: "public",
          url: "https://cdn.test/raw.bin",
          immutable_url: null,
        });
      }
      throw new Error("unexpected: " + call.url);
    });
    const sdk = makeSdk(fetch);
    const result = await sdk.assets.put(
      "prj_known", "raw.bin", new TextEncoder().encode("bytes"),
      { immutable: false },
    );
    assert.equal(result.key, "raw.bin");
    assert.equal(initBody!.size_bytes, 5);
  });

  it("throws when both content and bytes are provided", async () => {
    const { fetch } = mockFetch(() => json({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.assets.put("prj_known", "x", { content: "a", bytes: new Uint8Array(1) }),
      (err: unknown) => err instanceof Error && /exactly one/.test((err as Error).message),
    );
  });

  it("throws when neither content nor bytes are provided", async () => {
    const { fetch } = mockFetch(() => json({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.assets.put("prj_known", "x", {}),
      (err: unknown) => err instanceof Error && /exactly one/.test((err as Error).message),
    );
  });

  it("throws ProjectNotFound before any fetch", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.assets.put("prj_missing", "x.txt", { content: "hi" }),
      ProjectNotFound,
    );
    assert.equal(calls.length, 0);
  });

  it("wraps S3 PUT failures in ApiError", async () => {
    const { fetch } = mockFetch((call) => {
      if (call.url.endsWith("/storage/v1/uploads")) {
        return json({
          upload_id: "u",
          mode: "single",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.test/u/p1", byte_start: 0, byte_end: 2 }],
        });
      }
      return new Response("access denied", { status: 403 });
    });
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.assets.put("prj_known", "x", { content: "abc" }),
      (err: unknown) => err instanceof ApiError && (err as ApiError).status === 403,
    );
  });
});

describe("blobs.get", () => {
  it("GETs /storage/v1/blob/:key and returns the raw Response", async () => {
    const { fetch, calls } = mockFetch(() =>
      new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })
    );
    const sdk = makeSdk(fetch);
    const res = await sdk.assets.get("prj_known", "hello.txt");
    assert.equal(calls[0]!.url, "https://api.example.test/storage/v1/blob/hello.txt");
    assert.equal(calls[0]!.headers["apikey"], "svc_k");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hello");
  });

  it("encodes key segments", async () => {
    const { fetch, calls } = mockFetch(() => new Response("x", { status: 200 }));
    const sdk = makeSdk(fetch);
    await sdk.assets.get("prj_known", "foo/a b.png");
    assert.equal(calls[0]!.url, "https://api.example.test/storage/v1/blob/foo/a%20b.png");
  });

  it("throws ApiError on 404", async () => {
    const { fetch } = mockFetch(() => new Response("not found", { status: 404 }));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.assets.get("prj_known", "missing.txt"),
      (err: unknown) => err instanceof ApiError && (err as ApiError).status === 404,
    );
  });
});

describe("blobs.ls", () => {
  it("GETs /storage/v1/blobs with prefix/limit/cursor", async () => {
    const { fetch, calls } = mockFetch(() => json({ blobs: [], next_cursor: null }));
    const sdk = makeSdk(fetch);
    await sdk.assets.ls("prj_known", { prefix: "images/", limit: 50, cursor: "c1" });
    const u = new URL(calls[0]!.url);
    assert.equal(u.pathname, "/storage/v1/blobs");
    assert.equal(u.searchParams.get("prefix"), "images/");
    assert.equal(u.searchParams.get("limit"), "50");
    assert.equal(u.searchParams.get("cursor"), "c1");
  });

  it("omits query string when no options", async () => {
    const { fetch, calls } = mockFetch(() => json({ blobs: [], next_cursor: null }));
    const sdk = makeSdk(fetch);
    await sdk.assets.ls("prj_known");
    assert.equal(calls[0]!.url, "https://api.example.test/storage/v1/blobs");
  });

  it("throws LocalError and does not request for invalid limits", async () => {
    const invalidLimits = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1];

    for (const limit of invalidLimits) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for limit ${String(limit)}`);
      });
      const sdk = makeSdk(fetch);

      await assert.rejects(
        sdk.assets.ls("prj_known", { limit }),
        (err: unknown) =>
          err instanceof LocalError &&
          err.context === "listing blobs" &&
          /limit.*positive safe integer/i.test(err.message),
      );
      assert.equal(calls.length, 0, `limit ${String(limit)} should not request`);
    }
  });
});

describe("blobs.rm", () => {
  it("DELETEs /storage/v1/blob/:key", async () => {
    const { fetch, calls } = mockFetch(() => json({ status: "ok" }));
    const sdk = makeSdk(fetch);
    await sdk.assets.rm("prj_known", "old.txt");
    assert.equal(calls[0]!.url, "https://api.example.test/storage/v1/blob/old.txt");
    assert.equal(calls[0]!.method, "DELETE");
  });
});

describe("blobs.sign", () => {
  it("POSTs /storage/v1/blob/:key/sign with optional ttl_seconds", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ signed_url: "https://s3.test/signed", expires_at: "2026-04-24T00:00:00Z", expires_in: 3600 }),
    );
    const sdk = makeSdk(fetch);
    const result = await sdk.assets.sign("prj_known", "secret.bin", { ttl_seconds: 900 });
    assert.equal(calls[0]!.url, "https://api.example.test/storage/v1/blob/secret.bin/sign");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { ttl_seconds: 900 });
    assert.equal(result.expires_in, 3600);
  });

  it("rejects invalid ttl_seconds locally before request", async () => {
    const invalidTtls = [59, 604801, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1];

    for (const ttl of invalidTtls) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for ttl ${String(ttl)}`);
      });
      const sdk = makeSdk(fetch);

      await assert.rejects(
        sdk.assets.sign("prj_known", "secret.bin", { ttl_seconds: ttl }),
        (err: unknown) =>
          err instanceof LocalError &&
          err.context === "signing blob URL" &&
          /ttl_seconds/i.test(err.message),
      );
      assert.equal(calls.length, 0, `ttl ${String(ttl)} should not request`);
    }
  });
});

// ---------------------------------------------------------------------------
// v1.45 — AssetRef widened return + diagnoseUrl + waitFresh
// ---------------------------------------------------------------------------

describe("blobs.put — AssetRef widening (v1.45)", () => {
  it("populates camelCase aliases + integrity fields for immutable upload", async () => {
    // sha256 of "abc"
    const SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const { fetch } = mockFetch((call) => {
      if (call.url.endsWith("/storage/v1/uploads")) {
        return json({
          upload_id: "u_a",
          mode: "single",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.test/u_a/p1", byte_start: 0, byte_end: 2 }],
        });
      }
      if (call.url.startsWith("https://s3.test/")) {
        return new Response("", { status: 200, headers: { etag: '"e"' } });
      }
      if (call.url.endsWith("/complete")) {
        return json({
          key: "x.txt",
          size_bytes: 3,
          sha256: SHA,
          visibility: "public",
          content_type: "text/plain",
          immutable_suffix: SHA.slice(0, 8),
          url: "https://app.run402.com/_blob/x.txt",
          immutable_url: "https://app.run402.com/_blob/x-ba7816bf.txt",
          cdn_url: "https://pr-abc.run402.com/_blob/x.txt",
          cdn_immutable_url: "https://pr-abc.run402.com/_blob/x-ba7816bf.txt",
        });
      }
      throw new Error("unexpected: " + call.url);
    });
    const sdk = makeSdk(fetch);
    const result = await sdk.assets.put("prj_known", "x.txt", { content: "abc" }, { immutable: true });

    // Legacy snake_case fields stay populated for back-compat.
    assert.equal(result.size_bytes, 3);
    assert.equal(result.sha256, SHA);
    assert.equal(result.url, "https://app.run402.com/_blob/x.txt");
    assert.equal(result.immutable_url, "https://app.run402.com/_blob/x-ba7816bf.txt");
    // New camelCase aliases.
    assert.equal(result.size, 3);
    assert.equal(result.contentSha256, SHA);
    assert.equal(result.immutableUrl, "https://app.run402.com/_blob/x-ba7816bf.txt");
    assert.equal(result.contentType, "text/plain");
    // v1.45 cdn-reachable URLs (auto-subdomain, guaranteed-working).
    assert.equal(result.cdnUrl, "https://pr-abc.run402.com/_blob/x-ba7816bf.txt");
    assert.equal(result.cdnMutableUrl, "https://pr-abc.run402.com/_blob/x.txt");
    // Integrity fields derived from the SHA.
    assert.equal(result.etag, `"sha256-${SHA}"`);
    assert.match(result.sri ?? "", /^sha256-[A-Za-z0-9+/]+={0,2}$/);
    assert.match(result.contentDigest ?? "", /^sha-256=:[A-Za-z0-9+/]+={0,2}:$/);
    // Cache kind + cdn envelope.
    assert.equal(result.cacheKind, "immutable");
    assert.equal(result.cdn.version, "blob-gateway-v2");
    assert.equal(result.cdn.ready, true);
    assert.match(result.cdn.hint ?? "", /Use cdnUrl/);
  });

  it("scriptTag/linkTag/imgTag emit ready-to-paste tags with SRI + crossorigin", async () => {
    const SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const { fetch } = mockFetch((call) => {
      if (call.url.endsWith("/storage/v1/uploads")) {
        return json({
          upload_id: "u_t",
          mode: "single",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.test/u_t/p1", byte_start: 0, byte_end: 2 }],
        });
      }
      if (call.url.startsWith("https://s3.test/")) {
        return new Response("", { status: 200, headers: { etag: '"e"' } });
      }
      if (call.url.endsWith("/complete")) {
        return json({
          key: "app.js",
          size_bytes: 3,
          sha256: SHA,
          visibility: "public",
          content_type: "text/javascript",
          immutable_suffix: SHA.slice(0, 8),
          url: "https://app.run402.com/_blob/app.js",
          immutable_url: "https://app.run402.com/_blob/app-ba7816bf.js",
          cdn_url: "https://pr-abc.run402.com/_blob/app.js",
          cdn_immutable_url: "https://pr-abc.run402.com/_blob/app-ba7816bf.js",
        });
      }
      throw new Error("unexpected: " + call.url);
    });
    const sdk = makeSdk(fetch);
    const asset = await sdk.assets.put("prj_known", "app.js", { content: "abc" }, { immutable: true });

    // Default scriptTag — emits `defer` by default (modern best practice).
    const tag = asset.scriptTag();
    assert.match(tag, /^<script /);
    assert.match(tag, /src="https:\/\/pr-abc\.run402\.com\/_blob\/app-ba7816bf\.js"/);
    assert.match(tag, /\bdefer\b/);
    assert.match(tag, /integrity="sha256-[A-Za-z0-9+/]+={0,2}"/);
    assert.match(tag, /crossorigin/);
    // No async by default.
    assert.equal(/\basync\b/.test(tag), false);

    // Explicit defer: false opts out.
    const noDefer = asset.scriptTag({ defer: false });
    assert.equal(/\bdefer\b/.test(noDefer), false);

    // Module + explicit defer.
    const moduleTag = asset.scriptTag({ type: "module", defer: true });
    assert.match(moduleTag, /type="module"/);
    assert.match(moduleTag, /\bdefer\b/);

    // async: true overrides defer (mutually exclusive per HTML spec).
    const asyncTag = asset.scriptTag({ async: true });
    assert.match(asyncTag, /\basync\b/);
    assert.equal(/\bdefer\b/.test(asyncTag), false);

    // Default linkTag (stylesheet).
    const link = asset.linkTag();
    assert.match(link, /^<link /);
    assert.match(link, /rel="stylesheet"/);
    assert.match(link, /href="https:\/\/pr-abc\.run402\.com\/_blob\/app-ba7816bf\.js"/);
    assert.match(link, /integrity="sha256-/);
    assert.match(link, /crossorigin/);

    // Custom rel + as (preload). crossorigin still emitted (required for
    // SRI to be enforced AND for preload-fetch deduping).
    const preload = asset.linkTag({ rel: "preload", as: "font" });
    assert.match(preload, /rel="preload"/);
    assert.match(preload, /as="font"/);
    assert.match(preload, /crossorigin/);

    // imgTag — emits loading="lazy" + decoding="async" by default.
    const img = asset.imgTag("Company logo");
    assert.match(img, /^<img /);
    assert.match(img, /src="https:\/\/pr-abc\.run402\.com\/_blob\/app-ba7816bf\.js"/);
    assert.match(img, /alt="Company logo"/);
    assert.match(img, /loading="lazy"/);
    assert.match(img, /decoding="async"/);
    // No SRI on <img> per HTML spec.
    assert.equal(/integrity=/.test(img), false);
  });

  it("tag emitters escape HTML special chars in alt + url + sri", async () => {
    // sha256 of "abc"
    const SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    // URL with characters that need attribute escaping.
    const HOSTILE_URL = "https://pr-abc.run402.com/_blob/a&b\"c<d>.png";
    const { fetch } = mockFetch((call) => {
      if (call.url.endsWith("/storage/v1/uploads")) {
        return json({
          upload_id: "u_e", mode: "single", part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.test/u_e/p1", byte_start: 0, byte_end: 2 }],
        });
      }
      if (call.url.startsWith("https://s3.test/")) {
        return new Response("", { status: 200, headers: { etag: '"e"' } });
      }
      if (call.url.endsWith("/complete")) {
        return json({
          key: 'a&b"c<d>.png',
          size_bytes: 3, sha256: SHA, visibility: "public",
          content_type: "image/png", immutable_suffix: SHA.slice(0, 8),
          url: HOSTILE_URL, immutable_url: HOSTILE_URL,
          cdn_url: HOSTILE_URL, cdn_immutable_url: HOSTILE_URL,
        });
      }
      throw new Error("unexpected: " + call.url);
    });
    const sdk = makeSdk(fetch);
    const asset = await sdk.assets.put("prj_known", 'a&b"c<d>.png', { content: "abc" }, { immutable: true });
    const img = asset.imgTag('Bad <alt> "quoted"');
    assert.match(img, /alt="Bad &lt;alt&gt; &quot;quoted&quot;"/);
    assert.match(img, /a&amp;b&quot;c&lt;d&gt;\.png/);
  });

  it("tag emitters throw on non-immutable uploads with an actionable hint", async () => {
    const { fetch } = mockFetch((call) => {
      if (call.url.endsWith("/storage/v1/uploads")) {
        return json({
          upload_id: "u_n", mode: "single", part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.test/u_n/p1", byte_start: 0, byte_end: 2 }],
        });
      }
      if (call.url.startsWith("https://s3.test/")) {
        return new Response("", { status: 200, headers: { etag: '"e"' } });
      }
      if (call.url.endsWith("/complete")) {
        return json({
          key: "x.png", size_bytes: 3, sha256: null, visibility: "public",
          content_type: "image/png", immutable_suffix: null,
          url: "https://app.run402.com/_blob/x.png", immutable_url: null,
          cdn_url: "https://pr-abc.run402.com/_blob/x.png", cdn_immutable_url: null,
        });
      }
      throw new Error("unexpected: " + call.url);
    });
    const sdk = makeSdk(fetch);
    const asset = await sdk.assets.put("prj_known", "x.png", { content: "abc" });
    assert.throws(() => asset.scriptTag(), /immutable: true/);
    assert.throws(() => asset.linkTag(), /immutable: true/);
    assert.throws(() => asset.imgTag(), /immutable: true/);
  });

  it("leaves integrity fields null when completion omits immutable URL/SHA", async () => {
    const { fetch } = mockFetch((call) => {
      if (call.url.endsWith("/storage/v1/uploads")) {
        return json({
          upload_id: "u_b",
          mode: "single",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.test/u_b/p1", byte_start: 0, byte_end: 2 }],
        });
      }
      if (call.url.startsWith("https://s3.test/")) {
        return new Response("", { status: 200, headers: { etag: '"e"' } });
      }
      if (call.url.endsWith("/complete")) {
        return json({
          key: "y.txt",
          size_bytes: 3,
          sha256: null,
          visibility: "public",
          content_type: null,
          immutable_suffix: null,
          url: "https://app.run402.com/_blob/y.txt",
          immutable_url: null,
        });
      }
      throw new Error("unexpected: " + call.url);
    });
    const sdk = makeSdk(fetch);
    const result = await sdk.assets.put("prj_known", "y.txt", { content: "abc" });
    assert.equal(result.contentSha256, null);
    assert.equal(result.etag, null);
    assert.equal(result.sri, null);
    assert.equal(result.contentDigest, null);
    assert.equal(result.cacheKind, "mutable");
    assert.equal(result.cdn.ready, false);
    assert.match(result.cdn.hint ?? "", /Prefer immutableUrl|wait_for_cdn_freshness/);
  });

  it("propagates a gateway-emitted cdn envelope verbatim when present", async () => {
    const { fetch } = mockFetch((call) => {
      if (call.url.endsWith("/storage/v1/uploads")) {
        return json({
          upload_id: "u_c",
          mode: "single",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.test/u_c/p1", byte_start: 0, byte_end: 2 }],
        });
      }
      if (call.url.startsWith("https://s3.test/")) {
        return new Response("", { status: 200, headers: { etag: '"e"' } });
      }
      if (call.url.endsWith("/complete")) {
        return json({
          key: "z.txt",
          size_bytes: 3,
          sha256: null,
          visibility: "public",
          content_type: "text/plain",
          immutable_suffix: null,
          url: "https://app.run402.com/_blob/z.txt",
          immutable_url: null,
          cdn: {
            version: "blob-gateway-v2",
            invalidationId: "I-1234",
            invalidationStatus: "InProgress",
            hint: "Invalidation is asynchronous; use wait_for_cdn_freshness.",
          },
        });
      }
      throw new Error("unexpected: " + call.url);
    });
    const sdk = makeSdk(fetch);
    const result = await sdk.assets.put("prj_known", "z.txt", { content: "abc" });
    assert.equal(result.cdn.invalidationId, "I-1234");
    assert.equal(result.cdn.invalidationStatus, "InProgress");
    assert.match(result.cdn.hint ?? "", /asynchronous/);
  });
});

describe("blobs upload sessions", () => {
  it("initializes upload sessions with project service auth", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        upload_id: "up_1",
        mode: "multipart",
        part_count: 2,
        part_size_bytes: 16_777_216,
        parts: [
          { part_number: 1, url: "https://s3.test/up_1/1", byte_start: 0, byte_end: 5 },
          { part_number: 2, url: "https://s3.test/up_1/2", byte_start: 6, byte_end: 10 },
        ],
      }, 201),
    );
    const sdk = makeSdk(fetch);
    const session = await sdk.assets.initUploadSession("prj_known", {
      key: "video.mp4",
      size_bytes: 11,
      content_type: "video/mp4",
      visibility: "private",
      immutable: true,
      sha256: "00".repeat(32),
    });

    assert.equal(session.upload_id, "up_1");
    assert.equal(session.part_count, 2);
    assert.equal(calls[0]!.url, "https://api.example.test/storage/v1/uploads");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.apikey, "svc_k");
    assert.equal(calls[0]!.headers.Authorization, "Bearer svc_k");
    const body = JSON.parse(calls[0]!.body as string);
    assert.deepEqual(body, {
      key: "video.mp4",
      size_bytes: 11,
      content_type: "video/mp4",
      visibility: "private",
      immutable: true,
      sha256: "00".repeat(32),
    });
  });

  it("rejects upload session init without a sha256 digest before request", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch");
    });
    const sdk = makeSdk(fetch);

    await assert.rejects(
      sdk.assets.initUploadSession("prj_known", {
        key: "x",
        size_bytes: 1,
        content_type: "text/plain",
      } as any),
      (err: unknown) =>
        err instanceof LocalError &&
        err.context === "initializing upload" &&
        /sha256/i.test(err.message),
    );
    assert.equal(calls.length, 0);
  });

  it("fetches upload session status with encoded upload id", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        upload_id: "up/1",
        status: "active",
        mode: "single",
        part_count: 1,
        parts: [{ part_number: 1, url: "https://s3.test/up_1/1", byte_start: 0, byte_end: 9 }],
      }),
    );
    const sdk = makeSdk(fetch);
    const session = await sdk.assets.getUploadSession("prj_known", "up/1");

    assert.equal(session.status, "active");
    assert.equal(calls[0]!.url, "https://api.example.test/storage/v1/uploads/up%2F1");
    assert.equal(calls[0]!.headers.apikey, "svc_k");
  });

  it("completes upload sessions and returns AssetRef shape", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        key: "app.js",
        size_bytes: 42,
        sha256: "00".repeat(32),
        visibility: "public",
        content_type: "text/javascript",
        immutable_suffix: "00000000",
        url: "https://cdn.test/app.js",
        immutable_url: "https://cdn.test/app-00000000.js",
        cdn_url: "https://pr-abc.run402.com/_blob/app.js",
        cdn_immutable_url: "https://pr-abc.run402.com/_blob/app-00000000.js",
      }),
    );
    const sdk = makeSdk(fetch);
    const result = await sdk.assets.completeUploadSession("prj_known", "up 1", {
      parts: [{ part_number: 1, etag: '"etag1"', sha256: "00".repeat(32) }],
    });

    assert.equal(calls[0]!.url, "https://api.example.test/storage/v1/uploads/up%201/complete");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      parts: [{ part_number: 1, etag: '"etag1"', sha256: "00".repeat(32) }],
    });
    assert.equal(result.key, "app.js");
    assert.equal(result.contentType, "text/javascript");
    assert.equal(result.cdnUrl, "https://pr-abc.run402.com/_blob/app-00000000.js");
  });

  it("throws ProjectNotFound for missing upload-session project", async () => {
    const { fetch } = mockFetch(() => json({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.assets.initUploadSession("prj_missing", {
        key: "x",
        size_bytes: 1,
        content_type: "text/plain",
        sha256: "00".repeat(32),
      }),
      ProjectNotFound,
    );
  });
});

describe("blobs.diagnoseUrl", () => {
  it("GETs /storage/v1/blobs/diagnose with the URL query-encoded", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        projectId: "prj_known",
        key: "avatar.png",
        expectedSha256: "abc",
        observedSha256: "abc",
        vantage: "gateway-us-east-1",
        probeMethod: "GET_RANGE_0_0",
        acceptEncoding: "identity",
        observedAt: "2026-04-27T00:00:00Z",
        probeMayHaveWarmedCache: true,
        canonicalUrl: "https://app.run402.com/_blob/avatar.png",
        pathKind: "blob-mutable",
        cache: { xCache: "Hit from cloudfront", ageSeconds: 5, cacheKind: "mutable" },
        invalidation: { id: null, status: null },
        hint: "CDN is serving the current SHA.",
      }),
    );
    const sdk = makeSdk(fetch);
    const env = await sdk.assets.diagnoseUrl(
      "prj_known",
      "https://app.run402.com/_blob/avatar.png",
    );
    assert.equal(env.observedSha256, "abc");
    assert.equal(env.vantage, "gateway-us-east-1");
    assert.equal(env.probeMethod, "GET_RANGE_0_0");
    assert.equal(env.probeMayHaveWarmedCache, true);
    assert.match(
      calls[0]!.url,
      /\/storage\/v1\/blobs\/diagnose\?url=https%3A%2F%2Fapp\.run402\.com%2F_blob%2Favatar\.png/,
    );
  });

  it("throws ProjectNotFound for unknown project", async () => {
    const { fetch } = mockFetch(() => json({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.assets.diagnoseUrl("prj_missing", "https://app.run402.com/_blob/x"),
      ProjectNotFound,
    );
  });
});

describe("blobs.waitFresh", () => {
  function envelope(observed: string | null) {
    return {
      projectId: "prj_known",
      key: "k",
      expectedSha256: "ff",
      observedSha256: observed,
      vantage: "gateway-us-east-1" as const,
      probeMethod: "GET_RANGE_0_0" as const,
      acceptEncoding: "identity",
      observedAt: "2026-04-27T00:00:00Z",
      probeMayHaveWarmedCache: true as const,
      canonicalUrl: "https://app.run402.com/_blob/k",
      pathKind: "blob-mutable" as const,
      cache: { xCache: null, ageSeconds: null, cacheKind: "mutable" as const },
      invalidation: { id: null, status: null },
      hint: "",
    };
  }

  it("returns fresh: true once observedSha256 matches expected", async () => {
    let calls = 0;
    const { fetch } = mockFetch(() => {
      calls++;
      // First two calls return the old SHA, third returns the new one.
      return json(envelope(calls < 3 ? "00".repeat(32) : "ff"));
    });
    const sdk = makeSdk(fetch);
    const result = await sdk.assets.waitFresh("prj_known", {
      url: "https://app.run402.com/_blob/k",
      sha256: "ff",
      timeoutMs: 5_000,
    });
    assert.equal(result.fresh, true);
    assert.equal(result.observedSha256, "ff");
    assert.ok(result.attempts >= 3);
    assert.equal(result.vantage, "gateway-us-east-1");
  });

  it("returns fresh: false on timeout (no exception thrown)", async () => {
    const { fetch } = mockFetch(() => json(envelope("00".repeat(32))));
    const sdk = makeSdk(fetch);
    const result = await sdk.assets.waitFresh("prj_known", {
      url: "https://app.run402.com/_blob/k",
      sha256: "ff",
      timeoutMs: 250,
    });
    assert.equal(result.fresh, false);
    assert.ok(result.attempts >= 1);
    assert.ok(result.elapsedMs >= 250 - 50);
  });

  it("throws ProjectNotFound for unknown project", async () => {
    const { fetch } = mockFetch(() => json({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.assets.waitFresh("prj_missing", { url: "https://app.run402.com/_blob/k", sha256: "ff" }),
      ProjectNotFound,
    );
  });

  it("throws LocalError and does not diagnose for invalid timeoutMs", async () => {
    const invalidTimeouts = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1];

    for (const timeoutMs of invalidTimeouts) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for timeoutMs ${String(timeoutMs)}`);
      });
      const sdk = makeSdk(fetch);

      await assert.rejects(
        sdk.assets.waitFresh("prj_known", {
          url: "https://app.run402.com/_blob/k",
          sha256: "ff",
          timeoutMs,
        }),
        (err: unknown) =>
          err instanceof LocalError &&
          err.context === "waiting for CDN freshness" &&
          /timeoutMs.*positive safe integer/i.test(err.message),
      );
      assert.equal(calls.length, 0, `timeoutMs ${String(timeoutMs)} should not request`);
    }
  });
});
