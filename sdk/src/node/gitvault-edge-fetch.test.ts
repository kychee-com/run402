/**
 * gitvault — CDN-edge read preference + silent fallback (gitvault-read-edge-
 * cache, task 2.4, design D5). Unit tests for `fetchGitvaultObjectBytes`
 * itself — every call site in `gitvault-publication.ts` and
 * `gitvault-mirror.ts` shares this one function, so pinning its behavior
 * here is what keeps every call site's behavior pinned too.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { _resetGitvaultEdgeFetchStateForTest, fetchGitvaultObjectBytes, type GitvaultEdgeFetchClient } from "./gitvault-edge-fetch.js";

/** A `.fetch`-only fake client, keyed by exact URL, recording every URL it was asked to fetch (in call order). */
function fakeClient(handlers: Record<string, () => Response | Promise<Response>>): { client: GitvaultEdgeFetchClient; calls: string[] } {
  const calls: string[] = [];
  const client: GitvaultEdgeFetchClient = {
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const handler = handlers[url];
      if (!handler) throw new Error(`unexpected fetch: ${url}`);
      return handler();
    }) as typeof globalThis.fetch,
  };
  return { client, calls };
}

async function bytesOf(r: Response): Promise<number[]> {
  return [...new Uint8Array(await r.arrayBuffer())];
}

describe("fetchGitvaultObjectBytes — prefer edge_url, silently fall back to url per-process (gitvault-read-edge-cache design D5)", () => {
  beforeEach(() => {
    _resetGitvaultEdgeFetchStateForTest();
  });

  it("(a) edge_url present and healthy — edge is fetched, and `url` is never touched", async () => {
    const { client, calls } = fakeClient({
      "https://edge.example/obj": () => new Response(new Uint8Array([1]), { status: 200 }),
      "https://origin.example/obj": () => { throw new Error("must not fetch url when edge succeeds"); },
    });
    const r = await fetchGitvaultObjectBytes(client, { url: "https://origin.example/obj", edge_url: "https://edge.example/obj" });
    assert.equal(r.status, 200);
    assert.deepEqual(await bytesOf(r), [1]);
    assert.deepEqual(calls, ["https://edge.example/obj"]);
  });

  it("(b) edge returns a non-ok response — falls back to `url` in the SAME call; the result is exactly url's response", async () => {
    const { client, calls } = fakeClient({
      "https://edge.example/obj": () => new Response(null, { status: 500 }),
      "https://origin.example/obj": () => new Response(new Uint8Array([2]), { status: 200 }),
    });
    const r = await fetchGitvaultObjectBytes(client, { url: "https://origin.example/obj", edge_url: "https://edge.example/obj" });
    assert.equal(r.status, 200);
    assert.deepEqual(await bytesOf(r), [2]);
    assert.deepEqual(calls, ["https://edge.example/obj", "https://origin.example/obj"]);
  });

  it("(b') a 404 from edge ALSO falls back to `url` — absence is decided by url, the unchanged source of truth, never by the edge", async () => {
    const { client, calls } = fakeClient({
      "https://edge.example/obj": () => new Response(null, { status: 404 }),
      "https://origin.example/obj": () => new Response(null, { status: 404 }),
    });
    const r = await fetchGitvaultObjectBytes(client, { url: "https://origin.example/obj", edge_url: "https://edge.example/obj" });
    assert.equal(r.status, 404);
    assert.deepEqual(calls, ["https://edge.example/obj", "https://origin.example/obj"], "url is consulted even though edge already answered 404");
  });

  it("(c) edge throws a network error — falls back to `url`, whose result is returned untouched", async () => {
    const { client, calls } = fakeClient({
      "https://edge.example/obj": () => { throw new TypeError("fetch failed"); },
      "https://origin.example/obj": () => new Response(new Uint8Array([3]), { status: 200 }),
    });
    const r = await fetchGitvaultObjectBytes(client, { url: "https://origin.example/obj", edge_url: "https://edge.example/obj" });
    assert.equal(r.status, 200);
    assert.deepEqual(await bytesOf(r), [3]);
    assert.deepEqual(calls, ["https://edge.example/obj", "https://origin.example/obj"]);
  });

  it("(d) once edge has failed once in this process, a LATER read with its own healthy edge_url still goes straight to `url` (process-wide stickiness)", async () => {
    const { client, calls } = fakeClient({
      "https://edge.example/first": () => new Response(null, { status: 500 }),
      "https://origin.example/first": () => new Response(new Uint8Array([4]), { status: 200 }),
      "https://edge.example/second": () => { throw new Error("edge must not be tried again in this process after the first failure"); },
      "https://origin.example/second": () => new Response(new Uint8Array([5]), { status: 200 }),
    });
    const r1 = await fetchGitvaultObjectBytes(client, { url: "https://origin.example/first", edge_url: "https://edge.example/first" });
    assert.equal(r1.status, 200);
    calls.length = 0; // isolate the second call's own fetch pattern

    const r2 = await fetchGitvaultObjectBytes(client, { url: "https://origin.example/second", edge_url: "https://edge.example/second" });
    assert.equal(r2.status, 200);
    assert.deepEqual(await bytesOf(r2), [5]);
    assert.deepEqual(calls, ["https://origin.example/second"], "edge_url skipped entirely on the second read — no attempt, no throw surfaced");
  });

  it("(e) edge_url absent — `url` fetched directly, byte-identical to calling client.fetch(url) today", async () => {
    const { client, calls } = fakeClient({
      "https://origin.example/obj": () => new Response(new Uint8Array([6]), { status: 200 }),
    });
    const r = await fetchGitvaultObjectBytes(client, { url: "https://origin.example/obj" });
    assert.equal(r.status, 200);
    assert.deepEqual(await bytesOf(r), [6]);
    assert.deepEqual(calls, ["https://origin.example/obj"]);
  });

  it("(e') an absent edge_url never consults or flips the process-wide fallback flag — a LATER read with edge_url still prefers it", async () => {
    const { client, calls } = fakeClient({
      "https://origin.example/no-edge": () => new Response(new Uint8Array([7]), { status: 200 }),
      "https://edge.example/has-edge": () => new Response(new Uint8Array([8]), { status: 200 }),
      "https://origin.example/has-edge": () => { throw new Error("must not fall back to url when edge_url succeeds"); },
    });
    await fetchGitvaultObjectBytes(client, { url: "https://origin.example/no-edge" });
    const r2 = await fetchGitvaultObjectBytes(client, { url: "https://origin.example/has-edge", edge_url: "https://edge.example/has-edge" });
    assert.equal(r2.status, 200);
    assert.deepEqual(await bytesOf(r2), [8]);
    assert.deepEqual(calls, ["https://origin.example/no-edge", "https://edge.example/has-edge"]);
  });

  it("passes the given `init` through unchanged to whichever URL is actually fetched", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const client: GitvaultEdgeFetchClient = {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), init });
        return new Response(null, { status: 200 });
      }) as typeof globalThis.fetch,
    };
    const init = { method: "GET", headers: { "x-test": "1" } };
    await fetchGitvaultObjectBytes(client, { url: "https://origin.example/obj", edge_url: "https://edge.example/obj" }, init);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, "https://edge.example/obj");
    assert.equal(seen[0]!.init, init);
  });
});
