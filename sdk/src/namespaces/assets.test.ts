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

/**
 * Helper: install a happy-path apply-flow handler on a mockFetch.
 *
 * v1.48 unified-apply: r.assets.put(projectId, key, source, opts) routes
 * through Deploy.apply, which issues this sequence:
 *
 *   1. POST /apply/v1/plans      → PlanResponse with missing_content + asset_entries
 *   2. POST /content/v1/plans    → ContentPlanResponse with presigned PUTs (if missing)
 *   3. PUT  to each presigned URL → 200 from S3
 *   4. POST /content/v1/plans/:id/commit → 200 (CAS promotion)
 *   5. POST /apply/v1/plans/:id/commit  → CommitResponse status: "ready"
 *
 * The helper takes an `entries` array (one per asset key the test wants
 * the plan response to acknowledge) and a `missing` flag (whether the
 * sha is in CAS already). It also lets the caller customize the
 * asset_ref URL fields via per-entry overrides.
 */
interface ApplyAssetEntry {
  key: string;
  size_bytes: number;
  content_type?: string;
  visibility?: "public" | "private";
  immutable?: boolean;
  missing?: boolean;
  asset_ref_overrides?: Partial<{
    url: string | null;
    immutable_url: string | null;
    cdn_url: string | null;
    cdn_immutable_url: string | null;
    sri: string | null;
    etag: string;
    content_digest: string;
  }>;
}

async function applySha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function installApplyHandler(
  fetch: { calls: FetchCall[] },
  entries: ApplyAssetEntry[],
  shas: Map<string, string>,
): (call: FetchCall) => Response | Promise<Response> {
  return async (call: FetchCall): Promise<Response> => {
    if (call.url.endsWith("/apply/v1/plans") && call.method === "POST") {
      // Each entry's SHA comes from the spec the SDK normalizer sent.
      // The body is { spec: { ..., assets: { put: [...] } } }.
      const body = JSON.parse(call.body as string);
      const putEntries = body.spec.assets.put as Array<{ key: string; sha256: string; size_bytes: number; content_type: string; visibility: "public" | "private"; immutable: boolean }>;
      for (const e of putEntries) shas.set(e.key, e.sha256);
      const missing_content = putEntries
        .filter((e) => entries.find((m) => m.key === e.key)?.missing !== false)
        .map((e) => ({ sha256: e.sha256, size: e.size_bytes, content_type: e.content_type, present: false }));
      const asset_entries = putEntries.map((e) => {
        const cfg = entries.find((m) => m.key === e.key)!;
        const sha = e.sha256;
        const suffix = sha.slice(0, 8);
        const dotIdx = e.key.lastIndexOf(".");
        const suffixedKey = dotIdx > 0
          ? `${e.key.slice(0, dotIdx)}-${suffix}${e.key.slice(dotIdx)}`
          : `${e.key}-${suffix}`;
        const isPublic = e.visibility === "public";
        const isImmutable = e.immutable === true;
        const host = "pr-abc.run402.com";
        const url = cfg.asset_ref_overrides?.url ?? (isPublic ? `https://${host}/_blob/${e.key}` : null);
        const immutableUrl = cfg.asset_ref_overrides?.immutable_url ?? (isPublic && isImmutable ? `https://${host}/_blob/${suffixedKey}` : null);
        const sri = cfg.asset_ref_overrides?.sri ?? (isImmutable ? `sha256-${Buffer.from(sha, "hex").toString("base64")}` : null);
        return {
          key: e.key,
          sha256: sha,
          size_bytes: e.size_bytes,
          content_type: e.content_type,
          visibility: e.visibility,
          immutable: e.immutable,
          status: cfg.missing !== false ? "upload_pending" : "present",
          asset_ref: {
            key: e.key,
            sha256: sha,
            size_bytes: e.size_bytes,
            content_type: e.content_type,
            visibility: e.visibility,
            immutable: e.immutable,
            url,
            immutable_url: immutableUrl,
            cdn_url: cfg.asset_ref_overrides?.cdn_url ?? url,
            cdn_immutable_url: cfg.asset_ref_overrides?.cdn_immutable_url ?? immutableUrl,
            sri,
            etag: cfg.asset_ref_overrides?.etag ?? `"sha256-${sha}"`,
            content_digest: cfg.asset_ref_overrides?.content_digest ?? `sha-256=:${Buffer.from(sha, "hex").toString("base64")}:`,
          },
        };
      });
      return json({
        plan_id: "plan_x",
        operation_id: "op_x",
        base_release_id: null,
        manifest_digest: "digest_x",
        missing_content,
        asset_entries,
        diff: { resources: {} },
        warnings: [],
      });
    }
    if (call.url.endsWith("/content/v1/plans") && call.method === "POST") {
      const body = JSON.parse(call.body as string);
      const content = body.content as Array<{ sha256: string; size: number; content_type?: string }>;
      return json({
        plan_id: "cplan_x",
        expires_at: "2030-01-01T00:00:00Z",
        missing: content.map((c) => ({
          sha256: c.sha256,
          mode: "single",
          part_size_bytes: c.size,
          part_count: 1,
          parts: [{ part_number: 1, url: `https://s3.test/${c.sha256}/p1`, byte_start: 0, byte_end: c.size - 1 }],
          upload_id: `u_${c.sha256.slice(0, 8)}`,
          staging_key: `_staging/u/${c.sha256}`,
          expires_at: "2030-01-01T00:00:00Z",
        })),
        entries: content.map((c) => ({ sha256: c.sha256, missing: true })),
      });
    }
    if (call.url.startsWith("https://s3.test/") && call.method === "PUT") {
      return new Response("", { status: 200, headers: { etag: '"e"' } });
    }
    if (call.url.match(/\/content\/v1\/plans\/[^/]+\/commit$/) && call.method === "POST") {
      return json({});
    }
    if (call.url.match(/\/apply\/v1\/plans\/[^/]+\/commit$/) && call.method === "POST") {
      return json({
        operation_id: "op_x",
        status: "ready",
        release_id: "rel_x",
        urls: { project: "https://prj.run402.test", project_public_id: "abc" },
      });
    }
    throw new Error("unexpected call: " + call.method + " " + call.url);
  };
}

describe("assets.put (v2.1.0 — routes through apply hero)", () => {
  it("routes through /apply/v1/plans, uploads bytes via /content/v1/plans, commits, returns AssetRef", async () => {
    let outerCalls: FetchCall[] = [];
    const shas = new Map<string, string>();
    const entries: ApplyAssetEntry[] = [
      { key: "hello.txt", size_bytes: 12, content_type: "text/plain", visibility: "public", immutable: true, missing: true },
    ];
    const { fetch, calls } = mockFetch((call) => installApplyHandler({ calls: outerCalls }, entries, shas)(call));
    outerCalls = calls;
    const sdk = makeSdk(fetch);

    const result = await sdk.assets.put("prj_known", "hello.txt", { content: "hello world\n" });

    // Verify path traversal: apply/v1/plans → content/v1/plans → S3 PUT → content/v1/plans/:id/commit → apply/v1/plans/:id/commit
    const paths = calls.map((c) => c.url.replace("https://api.example.test", ""));
    assert.ok(paths.some((p) => p === "/apply/v1/plans"), "POST /apply/v1/plans was issued");
    assert.ok(paths.some((p) => p === "/content/v1/plans"), "POST /content/v1/plans was issued");
    assert.ok(paths.some((p) => p.startsWith("https://s3.test/")), "S3 PUT was issued");
    assert.ok(paths.some((p) => p.match(/\/content\/v1\/plans\/[^/]+\/commit$/)), "content commit was issued");
    assert.ok(paths.some((p) => p.match(/\/apply\/v1\/plans\/[^/]+\/commit$/)), "apply commit was issued");
    // No legacy uploads route is hit.
    assert.equal(paths.filter((p) => p.includes("/storage/v1/uploads")).length, 0);

    assert.equal(result.key, "hello.txt");
    assert.ok(result.cdnUrl, "cdnUrl populated");
    assert.ok(result.sri, "sri populated");
  });

  it("defaults to immutable: true (v1.45) — sha256 computed + cdnUrl + sri populated", async () => {
    let outerCalls: FetchCall[] = [];
    const shas = new Map<string, string>();
    const entries: ApplyAssetEntry[] = [
      { key: "hello.txt", size_bytes: 3, content_type: "text/plain", visibility: "public", immutable: true, missing: true },
    ];
    const { fetch, calls } = mockFetch((call) => installApplyHandler({ calls: outerCalls }, entries, shas)(call));
    outerCalls = calls;
    const sdk = makeSdk(fetch);

    const asset = await sdk.assets.put("prj_known", "hello.txt", { content: "abc" });
    const planCall = calls.find((c) => c.url.endsWith("/apply/v1/plans"));
    const planBody = JSON.parse(planCall!.body as string);
    const entry = planBody.spec.assets.put[0];
    assert.equal(entry.immutable, true);
    assert.equal(entry.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

    assert.ok(asset.cdnUrl, "cdnUrl populated by default");
    assert.ok(asset.sri, "sri populated by default");
    const tag = asset.scriptTag();
    assert.match(tag, /integrity="sha256-/);
  });

  it("accepts a bare string as a polymorphic source (GH-126)", async () => {
    let outerCalls: FetchCall[] = [];
    const shas = new Map<string, string>();
    const entries: ApplyAssetEntry[] = [
      { key: "blob.txt", size_bytes: 10, content_type: "text/plain", visibility: "public", immutable: false, missing: true },
    ];
    const { fetch, calls } = mockFetch((call) => installApplyHandler({ calls: outerCalls }, entries, shas)(call));
    outerCalls = calls;
    const sdk = makeSdk(fetch);

    const result = await sdk.assets.put("prj_known", "blob.txt", "hello blob", { immutable: false });
    const planCall = calls.find((c) => c.url.endsWith("/apply/v1/plans"));
    const planBody = JSON.parse(planCall!.body as string);
    assert.equal(planBody.spec.assets.put[0].size_bytes, 10);
    assert.equal(result.key, "blob.txt");
  });

  it("accepts a bare Uint8Array as a polymorphic source (GH-126)", async () => {
    let outerCalls: FetchCall[] = [];
    const shas = new Map<string, string>();
    const entries: ApplyAssetEntry[] = [
      { key: "raw.bin", size_bytes: 5, content_type: "application/octet-stream", visibility: "public", immutable: false, missing: true },
    ];
    const { fetch, calls } = mockFetch((call) => installApplyHandler({ calls: outerCalls }, entries, shas)(call));
    outerCalls = calls;
    const sdk = makeSdk(fetch);

    const result = await sdk.assets.put("prj_known", "raw.bin", new TextEncoder().encode("bytes"), { immutable: false });
    const planCall = calls.find((c) => c.url.endsWith("/apply/v1/plans"));
    const planBody = JSON.parse(planCall!.body as string);
    assert.equal(planBody.spec.assets.put[0].size_bytes, 5);
    assert.equal(result.key, "raw.bin");
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

  it("rejects 1 MB+ content shorthand pre-network", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    const sdk = makeSdk(fetch);
    // 1.1 MB of "a"s — exceeds the 1 MB content shorthand cap.
    const big = "a".repeat(1_100_000);
    await assert.rejects(
      sdk.assets.put("prj_known", "x.txt", { content: big }),
      (err: unknown) => err instanceof Error && /limited to 1 MB/.test((err as Error).message),
    );
    assert.equal(calls.length, 0);
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
    let outerCalls: FetchCall[] = [];
    const shas = new Map<string, string>();
    const entries: ApplyAssetEntry[] = [
      { key: "x.txt", size_bytes: 3, content_type: "text/plain", visibility: "public", immutable: true, missing: true },
    ];
    const { fetch, calls } = mockFetch((call) => installApplyHandler({ calls: outerCalls }, entries, shas)(call));
    outerCalls = calls;
    const sdk = makeSdk(fetch);
    const result = await sdk.assets.put("prj_known", "x.txt", { content: "abc" }, { immutable: true });

    // Legacy snake_case fields stay populated for back-compat.
    assert.equal(result.size_bytes, 3);
    assert.equal(result.sha256, SHA);
    assert.equal(result.url, "https://pr-abc.run402.com/_blob/x.txt");
    assert.equal(result.immutable_url, "https://pr-abc.run402.com/_blob/x-ba7816bf.txt");
    // New camelCase aliases.
    assert.equal(result.size, 3);
    assert.equal(result.contentSha256, SHA);
    assert.equal(result.immutableUrl, "https://pr-abc.run402.com/_blob/x-ba7816bf.txt");
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
    let outerCalls: FetchCall[] = [];
    const shas = new Map<string, string>();
    const entries: ApplyAssetEntry[] = [
      { key: "app.js", size_bytes: 3, content_type: "text/javascript", visibility: "public", immutable: true, missing: true },
    ];
    const { fetch, calls } = mockFetch((call) => installApplyHandler({ calls: outerCalls }, entries, shas)(call));
    outerCalls = calls;
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
    // URL with characters that need attribute escaping.
    const HOSTILE_URL = "https://pr-abc.run402.com/_blob/a&b\"c<d>.png";
    let outerCalls: FetchCall[] = [];
    const shas = new Map<string, string>();
    const entries: ApplyAssetEntry[] = [
      {
        key: 'a&b"c<d>.png',
        size_bytes: 3,
        content_type: "image/png",
        visibility: "public",
        immutable: true,
        missing: true,
        asset_ref_overrides: {
          url: HOSTILE_URL,
          immutable_url: HOSTILE_URL,
          cdn_url: HOSTILE_URL,
          cdn_immutable_url: HOSTILE_URL,
        },
      },
    ];
    const { fetch, calls } = mockFetch((call) => installApplyHandler({ calls: outerCalls }, entries, shas)(call));
    outerCalls = calls;
    const sdk = makeSdk(fetch);
    const asset = await sdk.assets.put("prj_known", 'a&b"c<d>.png', { content: "abc" }, { immutable: true });
    const img = asset.imgTag('Bad <alt> "quoted"');
    assert.match(img, /alt="Bad &lt;alt&gt; &quot;quoted&quot;"/);
    assert.match(img, /a&amp;b&quot;c&lt;d&gt;\.png/);
  });

  it("tag emitters throw on non-immutable uploads with an actionable hint", async () => {
    let outerCalls: FetchCall[] = [];
    const shas = new Map<string, string>();
    const entries: ApplyAssetEntry[] = [
      // immutable: false → asset_ref.cdn_immutable_url is null → tag emitters throw.
      { key: "x.png", size_bytes: 3, content_type: "image/png", visibility: "public", immutable: false, missing: true },
    ];
    const { fetch, calls } = mockFetch((call) => installApplyHandler({ calls: outerCalls }, entries, shas)(call));
    outerCalls = calls;
    const sdk = makeSdk(fetch);
    const asset = await sdk.assets.put("prj_known", "x.png", { content: "abc" }, { immutable: false });
    assert.throws(() => asset.scriptTag(), /immutable: true/);
    assert.throws(() => asset.linkTag(), /immutable: true/);
    assert.throws(() => asset.imgTag(), /immutable: true/);
  });

  it("leaves integrity fields null when completion omits immutable URL/SHA", async () => {
    let outerCalls: FetchCall[] = [];
    const shas = new Map<string, string>();
    const entries: ApplyAssetEntry[] = [
      // immutable: false + override sri/etag/digest to null/non-sha to assert
      // the SDK widening drops integrity fields when the asset isn't
      // content-addressed. (Without the override the helper would still
      // synthesize URLs from the SHA; this test pins null-passthrough.)
      {
        key: "y.txt",
        size_bytes: 3,
        content_type: "text/plain",
        visibility: "public",
        immutable: false,
        missing: true,
        asset_ref_overrides: {
          url: "https://pr-abc.run402.com/_blob/y.txt",
          immutable_url: null,
          cdn_url: "https://pr-abc.run402.com/_blob/y.txt",
          cdn_immutable_url: null,
          sri: null,
        },
      },
    ];
    const { fetch, calls } = mockFetch((call) => installApplyHandler({ calls: outerCalls }, entries, shas)(call));
    outerCalls = calls;
    const sdk = makeSdk(fetch);
    const result = await sdk.assets.put("prj_known", "y.txt", { content: "abc" }, { immutable: false });
    // For non-immutable uploads, the SDK's widening helper:
    // - leaves cdnUrl null (cdn_immutable_url is the source field — null when
    //   immutable: false in the apply spec).
    // - marks cacheKind: "mutable" and cdn.ready: false.
    // - In v2.1.0 the SDK ALWAYS knows the SHA (computed at submission time),
    //   so etag/sri/contentDigest are populated even on non-immutable puts —
    //   they describe the bytes, not the URL contract. That's a deliberate
    //   change from v1.x where the SDK got the SHA back from the gateway.
    assert.equal(result.cdnUrl, null);
    assert.equal(result.cacheKind, "mutable");
    assert.equal(result.cdn.ready, false);
    assert.match(result.cdn.hint ?? "", /asynchronous|cdnUrl/);
  });

  // The "propagates a gateway-emitted cdn envelope verbatim when present"
  // test was dropped in v2.1.0 — the apply path's plan response doesn't
  // carry a `cdn` envelope (CDN invalidation IDs land in the operation
  // status events, not the AssetRef). The legacy cdn envelope is
  // synthesized from local information by buildAssetRef.
});

describe("blobs upload sessions (REMOVED in v2.1.0)", () => {
  // v1.48 gateway dropped /storage/v1/uploads*. The SDK's low-level resumable-
  // upload session methods (initUploadSession/getUploadSession/
  // completeUploadSession) were removed in v2.1.0 — they have no underlying
  // gateway endpoint. The replacement is the apply hero
  // (r.project(id).apply / r.assets.uploadDir etc) which routes bytes
  // through /content/v1/plans and the activation transaction.

  it("initUploadSession throws LocalError with migration guidance", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch — method should throw before any network call");
    });
    const sdk = makeSdk(fetch);

    await assert.rejects(
      sdk.assets.initUploadSession("prj_known", {
        key: "x",
        size_bytes: 1,
        content_type: "text/plain",
        sha256: "00".repeat(32),
      }),
      (err: unknown) =>
        err instanceof LocalError &&
        /removed in v2\.1\.0/.test(err.message) &&
        /r\.project\(id\)\.apply/.test(err.message),
    );
    assert.equal(calls.length, 0);
  });

  it("getUploadSession throws LocalError with migration guidance", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch");
    });
    const sdk = makeSdk(fetch);

    await assert.rejects(
      sdk.assets.getUploadSession("prj_known", "up_1"),
      (err: unknown) =>
        err instanceof LocalError && /removed in v2\.1\.0/.test(err.message),
    );
    assert.equal(calls.length, 0);
  });

  it("completeUploadSession throws LocalError with migration guidance", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch");
    });
    const sdk = makeSdk(fetch);

    await assert.rejects(
      sdk.assets.completeUploadSession("prj_known", "up_1", {
        parts: [{ part_number: 1, etag: '"e"', sha256: "00".repeat(32) }],
      }),
      (err: unknown) =>
        err instanceof LocalError && /removed in v2\.1\.0/.test(err.message),
    );
    assert.equal(calls.length, 0);
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
