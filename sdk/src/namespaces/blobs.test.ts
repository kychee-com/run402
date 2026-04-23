/**
 * Unit tests for the `blobs` namespace. Covers all 5 methods, including
 * the multi-step upload flow (init → PUT parts → complete) and the
 * streaming Response return from `get()`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { ProjectNotFound, ApiError } from "../errors.js";
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
    const result = await sdk.blobs.put("prj_known", "hello.txt", { content: "hello world\n" });

    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.url, "https://api.example.test/storage/v1/uploads");
    assert.equal(calls[0]!.headers["apikey"], "anon_k");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer anon_k");
    const initBody = JSON.parse(calls[0]!.body as string);
    assert.equal(initBody.key, "hello.txt");
    assert.equal(initBody.size_bytes, 12);
    assert.equal(initBody.visibility, "public");
    assert.equal(initBody.immutable, false);
    assert.equal(initBody.sha256, undefined);
    // S3 PUT — no SIWX, no gateway apiBase, uses presigned URL as-is.
    assert.equal(calls[1]!.url, "https://s3.test/u_42/p1");
    assert.equal(calls[1]!.method, "PUT");
    // Complete
    assert.equal(calls[2]!.url, "https://api.example.test/storage/v1/uploads/u_42/complete");
    assert.equal(result.key, "hello.txt");
    assert.equal(result.url, "https://cdn.test/hello.txt");
  });

  it("attaches parts with etags in multipart mode", async () => {
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
    await sdk.blobs.put("prj_known", "multi.bin", { bytes: new Uint8Array(12) });
    const completeBody = JSON.parse(calls[3]!.body as string);
    assert.deepEqual(completeBody.parts, [
      { part_number: 1, etag: '"e1"' },
      { part_number: 2, etag: '"e2"' },
    ]);
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
    await sdk.blobs.put("prj_known", "x.txt", { content: "abc" }, { immutable: true });
    const initBody = JSON.parse(calls[0]!.body as string);
    assert.equal(initBody.immutable, true);
    assert.ok(typeof initBody.sha256 === "string" && initBody.sha256.length === 64);
    // Known sha256 of "abc"
    assert.equal(initBody.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("throws when both content and bytes are provided", async () => {
    const { fetch } = mockFetch(() => json({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.blobs.put("prj_known", "x", { content: "a", bytes: new Uint8Array(1) }),
      (err: unknown) => err instanceof Error && /exactly one/.test((err as Error).message),
    );
  });

  it("throws when neither content nor bytes are provided", async () => {
    const { fetch } = mockFetch(() => json({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.blobs.put("prj_known", "x", {}),
      (err: unknown) => err instanceof Error && /exactly one/.test((err as Error).message),
    );
  });

  it("throws ProjectNotFound before any fetch", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.blobs.put("prj_missing", "x.txt", { content: "hi" }),
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
      sdk.blobs.put("prj_known", "x", { content: "abc" }),
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
    const res = await sdk.blobs.get("prj_known", "hello.txt");
    assert.equal(calls[0]!.url, "https://api.example.test/storage/v1/blob/hello.txt");
    assert.equal(calls[0]!.headers["apikey"], "anon_k");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hello");
  });

  it("encodes key segments", async () => {
    const { fetch, calls } = mockFetch(() => new Response("x", { status: 200 }));
    const sdk = makeSdk(fetch);
    await sdk.blobs.get("prj_known", "foo/a b.png");
    assert.equal(calls[0]!.url, "https://api.example.test/storage/v1/blob/foo/a%20b.png");
  });

  it("throws ApiError on 404", async () => {
    const { fetch } = mockFetch(() => new Response("not found", { status: 404 }));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.blobs.get("prj_known", "missing.txt"),
      (err: unknown) => err instanceof ApiError && (err as ApiError).status === 404,
    );
  });
});

describe("blobs.ls", () => {
  it("GETs /storage/v1/blobs with prefix/limit/cursor", async () => {
    const { fetch, calls } = mockFetch(() => json({ blobs: [], next_cursor: null }));
    const sdk = makeSdk(fetch);
    await sdk.blobs.ls("prj_known", { prefix: "images/", limit: 50, cursor: "c1" });
    const u = new URL(calls[0]!.url);
    assert.equal(u.pathname, "/storage/v1/blobs");
    assert.equal(u.searchParams.get("prefix"), "images/");
    assert.equal(u.searchParams.get("limit"), "50");
    assert.equal(u.searchParams.get("cursor"), "c1");
  });

  it("omits query string when no options", async () => {
    const { fetch, calls } = mockFetch(() => json({ blobs: [], next_cursor: null }));
    const sdk = makeSdk(fetch);
    await sdk.blobs.ls("prj_known");
    assert.equal(calls[0]!.url, "https://api.example.test/storage/v1/blobs");
  });
});

describe("blobs.rm", () => {
  it("DELETEs /storage/v1/blob/:key", async () => {
    const { fetch, calls } = mockFetch(() => json({ status: "ok" }));
    const sdk = makeSdk(fetch);
    await sdk.blobs.rm("prj_known", "old.txt");
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
    const result = await sdk.blobs.sign("prj_known", "secret.bin", { ttl_seconds: 900 });
    assert.equal(calls[0]!.url, "https://api.example.test/storage/v1/blob/secret.bin/sign");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { ttl_seconds: 900 });
    assert.equal(result.expires_in, 3600);
  });
});
