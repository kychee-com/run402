/**
 * gitvault-byo-primary-bucket — client (public repo) Phase 3 tests (task 3.6).
 *
 * Covers:
 *   A. Allocation-time bucket probe (task 3.1) — the fail-closed matrix,
 *      naming exactly which property failed.
 *   B. BYO payload write path + finalize attestation round-trip (task 3.2).
 *   C. Chain-copy dual-write, scoped to chain kinds, admission order (task 3.3).
 *   D. BYO absence adjudication (task 3.3 read half).
 *   E. Degraded-read BYO branch + precedence (task 3.4).
 *   F. Zero-credential / zero-payload-bytes server-blindness.
 *   G. Managed vaults stay byte-identical with storage_profile unset.
 *
 * Run: node --experimental-test-module-mocks --test --import tsx sdk/src/node/gitvault-byo.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { isRun402Error } from "../errors.js";
import { readByoConfig, saveByoConfig } from "./gitvault-byo-config.js";
import { probeGitvaultByoDestination, gitvaultByoProbeFailingProperties } from "./gitvault-byo-probe.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { DirectoryMirrorBackend, openGitvaultDestinationBackend, openGitvaultMirrorBackend, S3MirrorBackend } from "./gitvault-mirror-backend.js";
import { saveMirrorConfig } from "./gitvault-mirror-config.js";
import { byoChainCopySync, verifyByoObjectsPresent } from "./gitvault-mirror.js";
import { resolveDegradedReadSource } from "./gitvault-degraded-read.js";
import { createGitvaultHttpTransport, gitvaultLedgerId, gitvaultManifestEntry, gitvaultPaths, GITVAULT_INLINE_UPLOAD_MAX_OBJECT_BYTES } from "./gitvault-publication.js";
import type { GitvaultUploadObject } from "./gitvault-publication.js";
import { _resetGitvaultEdgeFetchStateForTest } from "./gitvault-edge-fetch.js";

const REPO = `src_${"9".repeat(32)}`;
const WAL = `wal_${"1".repeat(32)}`;
const VR = `vr_${"2".repeat(32)}`;

function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ─── A. Allocation-time bucket probe (task 3.1) ───────────────────────────────

describe("gitvault BYO bucket probe (task 3.1) — DirectoryMirrorBackend", () => {
  it("a fresh, writable directory satisfies every property", async () => {
    const root = scratchDir("run402-byo-probe-dir-");
    const backend = new DirectoryMirrorBackend(root);
    const result = await backend.probeWritePolicy();
    assert.deepEqual(result, { write_permitted: true, create_only_honored: true, versioning_off: true });
    assert.deepEqual(gitvaultByoProbeFailingProperties(result), []);
  });

  it("probeGitvaultByoDestination against a writable directory succeeds and reports nothing failing", async () => {
    const root = scratchDir("run402-byo-probe-happy-");
    const result = await probeGitvaultByoDestination({ kind: "directory", path: root });
    assert.equal(result.write_permitted, true);
    assert.equal(result.create_only_honored, true);
    assert.equal(result.versioning_off, true);
  });
});

describe("gitvault BYO bucket probe (task 3.1) — S3MirrorBackend fail-closed matrix", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function credential(): { kind: "ambient" } {
    return { kind: "ambient" };
  }

  function withAmbientCreds<T>(fn: () => T): T {
    const prevKey = process.env.AWS_ACCESS_KEY_ID;
    const prevSecret = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = "AKIA_TEST_PROBE";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret-probe";
    try {
      return fn();
    } finally {
      if (prevKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = prevKey;
      if (prevSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = prevSecret;
    }
  }

  it("write_permitted:false when the first probe PUT is refused (e.g. 403) — versioning is still checked and reported honestly", async () => {
    await withAmbientCreds(async () => {
      const calls: string[] = [];
      globalThis.fetch = (async (url: unknown, init: unknown) => {
        const method = (init as { method?: string } | undefined)?.method ?? "GET";
        calls.push(method);
        if (method === "PUT") return new Response(null, { status: 403 });
        // versioning GET
        return new Response("<VersioningConfiguration/>", { status: 200 });
      }) as typeof fetch;
      const backend = new S3MirrorBackend("bucket", "prefix", "us-east-1", credential());
      const result = await backend.probeWritePolicy();
      assert.equal(result.write_permitted, false);
      assert.equal(result.create_only_honored, false);
      assert.equal(result.versioning_off, true, "versioning is a SEPARATE bucket-level check — a failed write must not mask it");
      assert.ok(result.detail?.includes("403"));
      assert.deepEqual(gitvaultByoProbeFailingProperties(result), ["write_permitted", "create_only_honored"]);
    });
  });

  it("create_only_honored:false when a second create-only PUT to the same key silently succeeds (overwrite)", async () => {
    await withAmbientCreds(async () => {
      let putCount = 0;
      globalThis.fetch = (async (url: unknown, init: unknown) => {
        const method = (init as { method?: string } | undefined)?.method ?? "GET";
        if (method === "PUT") {
          putCount += 1;
          return new Response(null, { status: 200 }); // both PUTs "succeed" — the bucket does not enforce if-none-match
        }
        return new Response("<VersioningConfiguration/>", { status: 200 });
      }) as typeof fetch;
      const backend = new S3MirrorBackend("bucket", "prefix", "us-east-1", credential());
      const result = await backend.probeWritePolicy();
      assert.equal(putCount, 2);
      assert.equal(result.write_permitted, true);
      assert.equal(result.create_only_honored, false);
      assert.equal(result.versioning_off, true);
      assert.deepEqual(gitvaultByoProbeFailingProperties(result), ["create_only_honored"]);
    });
  });

  it("create_only_honored:true when the second PUT is correctly refused with 412", async () => {
    await withAmbientCreds(async () => {
      let putCount = 0;
      globalThis.fetch = (async (url: unknown, init: unknown) => {
        const method = (init as { method?: string } | undefined)?.method ?? "GET";
        if (method === "PUT") {
          putCount += 1;
          return new Response(null, { status: putCount === 1 ? 200 : 412 });
        }
        return new Response("<VersioningConfiguration/>", { status: 200 });
      }) as typeof fetch;
      const backend = new S3MirrorBackend("bucket", "prefix", "us-east-1", credential());
      const result = await backend.probeWritePolicy();
      assert.deepEqual(gitvaultByoProbeFailingProperties(result), []);
    });
  });

  it("versioning_off:false when the bucket reports Enabled — the exact hazard the profile guards against", async () => {
    await withAmbientCreds(async () => {
      let putCount = 0;
      globalThis.fetch = (async (url: unknown, init: unknown) => {
        const method = (init as { method?: string } | undefined)?.method ?? "GET";
        if (method === "PUT") {
          putCount += 1;
          return new Response(null, { status: putCount === 1 ? 201 : 412 }); // create-only genuinely honored
        }
        return new Response("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>", { status: 200 });
      }) as typeof fetch;
      const backend = new S3MirrorBackend("bucket", "prefix", "us-east-1", credential());
      const result = await backend.probeWritePolicy();
      assert.equal(result.versioning_off, false);
      assert.deepEqual(gitvaultByoProbeFailingProperties(result), ["versioning_off"]);
    });
  });

  it("Suspended versioning is treated as compliant (only Enabled fails the probe)", async () => {
    await withAmbientCreds(async () => {
      let putCount = 0;
      globalThis.fetch = (async (url: unknown, init: unknown) => {
        const method = (init as { method?: string } | undefined)?.method ?? "GET";
        if (method === "PUT") {
          putCount += 1;
          return new Response(null, { status: putCount === 1 ? 201 : 409 });
        }
        return new Response("<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>", { status: 200 });
      }) as typeof fetch;
      const backend = new S3MirrorBackend("bucket", "prefix", "us-east-1", credential());
      const result = await backend.probeWritePolicy();
      assert.equal(result.versioning_off, true);
      assert.deepEqual(gitvaultByoProbeFailingProperties(result), []);
    });
  });

  it("a versioning read that cannot be confirmed (e.g. missing GetBucketVersioning permission) fails closed", async () => {
    await withAmbientCreds(async () => {
      let putCount = 0;
      globalThis.fetch = (async (url: unknown, init: unknown) => {
        const method = (init as { method?: string } | undefined)?.method ?? "GET";
        if (method === "PUT") {
          putCount += 1;
          return new Response(null, { status: putCount === 1 ? 201 : 412 });
        }
        return new Response(null, { status: 403 }); // no s3:GetBucketVersioning
      }) as typeof fetch;
      const backend = new S3MirrorBackend("bucket", "prefix", "us-east-1", credential());
      const result = await backend.probeWritePolicy();
      assert.equal(result.versioning_off, false, "an unconfirmable fact must never be reported as compliant");
      assert.deepEqual(gitvaultByoProbeFailingProperties(result), ["versioning_off"]);
    });
  });

  it("probeGitvaultByoDestination throws GITVAULT_BYO_BUCKET_PROBE_FAILED naming every failing property, and no allocation call is reachable from it", async () => {
    await withAmbientCreds(async () => {
      globalThis.fetch = (async () => new Response(null, { status: 403 })) as typeof fetch;
      await assert.rejects(
        () => probeGitvaultByoDestination({ kind: "s3", bucket: "bucket", prefix: "prefix", region: "us-east-1" }, credential()),
        (e: unknown) => {
          assert.ok(isRun402Error(e));
          assert.equal((e as { code?: string }).code, "GITVAULT_BYO_BUCKET_PROBE_FAILED");
          const details = (e as { details?: { failing_properties?: string[] } }).details;
          assert.ok(details?.failing_properties?.includes("write_permitted"));
          return true;
        },
      );
    });
  });

  it("a thrown transport failure (network/DNS) is treated identically to a failed probe — refused, never silently passed", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed: ENOTFOUND");
    }) as typeof fetch;
    await assert.rejects(
      () => probeGitvaultByoDestination({ kind: "s3", bucket: "bucket", prefix: "prefix", region: "us-east-1" }, credential()),
      (e: unknown) => {
        assert.ok(isRun402Error(e));
        assert.equal((e as { code?: string }).code, "GITVAULT_BYO_BUCKET_PROBE_FAILED");
        return true;
      },
    );
  });
});

// ─── B. BYO payload write path + attestation round-trip (task 3.2) ───────────

describe("gitvault BYO payload write path + finalize attestation round-trip (task 3.2)", () => {
  interface WireCall { path: string; method?: string; body?: unknown }

  function walObject(bytes: Uint8Array): GitvaultUploadObject {
    return { path: gitvaultPaths.wal(WAL), object_kind: "wal_pack", object_id: WAL, bytes, sha256: sha256Hex(bytes), size_bytes: String(bytes.length), base_generation: "0000000000000000" };
  }

  function verifierReceiptObject(bytes: Uint8Array): GitvaultUploadObject {
    return { path: gitvaultPaths.verifierReceipt(VR), object_kind: "verifier_receipt", object_id: VR, bytes, sha256: sha256Hex(bytes), size_bytes: String(bytes.length) };
  }

  function byoTransportOver(destinationRoot: string, handler: (call: WireCall) => unknown): { transport: ReturnType<typeof createGitvaultHttpTransport>; calls: WireCall[] } {
    const calls: WireCall[] = [];
    const client = {
      apiBase: "https://api.example.test",
      credentials: { getAuth: async () => ({}) },
      async request<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
        const call = { path, method: opts.method, body: opts.body };
        calls.push(call);
        return handler(call) as T;
      },
      async fetch(url: string) {
        calls.push({ path: `FETCH ${url}` });
        throw new Error(`server-blindness violation: a payload-kind PUT reached client.fetch (should have gone to the customer bucket directly): ${url}`);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as Parameters<typeof createGitvaultHttpTransport>[0];
    return { transport: createGitvaultHttpTransport(client), calls };
  }

  it("a payload-kind object (put:null + key) is written DIRECTLY to the BYO destination — never through client.fetch — and finalize carries the matching attestation", async () => {
    const root = scratchDir("run402-byo-upload-");
    const walBytes = new Uint8Array([9, 9, 9]);
    const entry = gitvaultManifestEntry(walObject(walBytes));
    const key = `source/${REPO}/wal/${WAL}.pack.enc`;

    const { transport, calls } = byoTransportOver(root, (call) => {
      if (call.path.endsWith("/upload-sessions")) {
        return { upload_session_id: "us_1", objects: [{ ...entry, put: null, key }] };
      }
      if (call.path.includes("/finalize")) {
        return { receipts: [{ ...entry, stored_bytes_sha256: entry.sha256, size_bytes: entry.size_bytes, storage_verification: "client_attested" }] };
      }
      throw new Error(`unexpected call: ${call.path}`);
    });

    const receipts = await transport.uploadObjects({
      repo_id: REPO,
      objects: [walObject(walBytes)],
      byo: { destination: { kind: "directory", path: root } },
    });

    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.sha256, sha256Hex(walBytes));

    // The bytes actually landed in the CUSTOMER destination, at the server-named key.
    const written = readFileSync(join(root, "source", REPO, "wal", `${WAL}.pack.enc`));
    assert.deepEqual(new Uint8Array(written), walBytes);

    // The finalize call carried exactly one attestation, echoing the DECLARED
    // manifest values (never re-derived), with the literal accepted result.
    const finalizeCall = calls.find((c) => c.path.includes("/finalize"))!;
    assert.deepEqual(finalizeCall.body, { attestations: [{ key, sha256: entry.sha256, size_bytes: entry.size_bytes, create_only_result: "created" }] });

    // Server-blindness: no call ever carried the raw bytes, and client.fetch
    // was never reached for this object (the fake would have thrown).
    for (const call of calls) {
      assert.ok(!JSON.stringify(call.body ?? "").includes("9,9,9"), "run402 must never receive the payload bytes for a BYO object");
    }
  });

  it("a chain-adjacent object (put: presigned URL) in the SAME BYO session still goes through client.fetch, byte-identical to the managed path", async () => {
    const root = scratchDir("run402-byo-chain-adjacent-");
    const vrBytes = new Uint8Array([1, 2, 3, 4]);
    const entry = gitvaultManifestEntry(verifierReceiptObject(vrBytes));
    let fetchCalled = false;

    const calls: WireCall[] = [];
    const client = {
      apiBase: "https://api.example.test",
      credentials: { getAuth: async () => ({}) },
      async request<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
        calls.push({ path, method: opts.method, body: opts.body });
        if (path.endsWith("/upload-sessions")) {
          return { upload_session_id: "us_2", objects: [{ ...entry, put: { url: "https://run402-bucket.example/presigned" } }] } as T;
        }
        if (path.includes("/finalize")) {
          return { receipts: [{ ...entry, stored_bytes_sha256: entry.sha256, size_bytes: entry.size_bytes }] } as T;
        }
        throw new Error(`unexpected call: ${path}`);
      },
      async fetch(url: string) {
        fetchCalled = true;
        assert.equal(url, "https://run402-bucket.example/presigned");
        return new Response(null, { status: 200 });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as Parameters<typeof createGitvaultHttpTransport>[0];
    const transport = createGitvaultHttpTransport(client);

    await transport.uploadObjects({ repo_id: REPO, objects: [verifierReceiptObject(vrBytes)], byo: { destination: { kind: "directory", path: root } } });
    assert.ok(fetchCalled, "a chain-adjacent (non-payload) kind must still PUT through run402's own presigned URL on a BYO vault");
    // Nothing was written to the customer bucket for a chain-adjacent object —
    // the destination's `source/<repo_id>/` prefix was never even created.
    assert.equal(existsSync(join(root, "source", REPO)), false);
  });

  it("a write refused by the customer bucket fails the push with GITVAULT_BYO_BUCKET_WRITE_REFUSED — the primary is never advisory", async () => {
    const root = scratchDir("run402-byo-refused-");
    const walBytes = new Uint8Array([5, 5, 5]);
    const entry = gitvaultManifestEntry(walObject(walBytes));
    const key = `source/${REPO}/wal/${WAL}.pack.enc`;

    // Pre-seed a DIFFERENT object at the SAME key so create-only genuinely conflicts.
    const { transport } = byoTransportOver(root, (call) => {
      if (call.path.endsWith("/upload-sessions")) return { upload_session_id: "us_3", objects: [{ ...entry, put: null, key }] };
      throw new Error(`finalize must never be reached: ${call.path}`);
    });
    const backend = openGitvaultDestinationBackend({ kind: "directory", path: root });
    await backend.putCreateOnly(key, new Uint8Array([1, 1, 1])); // different bytes at the same key

    await assert.rejects(
      () => transport.uploadObjects({ repo_id: REPO, objects: [walObject(walBytes)], byo: { destination: { kind: "directory", path: root } } }),
      (e: unknown) => {
        assert.ok(isRun402Error(e));
        assert.equal((e as { code?: string }).code, "GITVAULT_BYO_BUCKET_WRITE_REFUSED");
        return true;
      },
    );
  });

  it("an idempotent retry (same key, matching bytes already present) succeeds and still attests created", async () => {
    const root = scratchDir("run402-byo-idempotent-");
    const walBytes = new Uint8Array([7, 7, 7]);
    const entry = gitvaultManifestEntry(walObject(walBytes));
    const key = `source/${REPO}/wal/${WAL}.pack.enc`;
    const backend = openGitvaultDestinationBackend({ kind: "directory", path: root });
    await backend.putCreateOnly(key, walBytes); // simulate an earlier partial attempt that DID land

    const { transport, calls } = byoTransportOver(root, (call) => {
      if (call.path.endsWith("/upload-sessions")) return { upload_session_id: "us_4", objects: [{ ...entry, put: null, key }] };
      if (call.path.includes("/finalize")) return { receipts: [{ ...entry, stored_bytes_sha256: entry.sha256, size_bytes: entry.size_bytes }] };
      throw new Error(`unexpected call: ${call.path}`);
    });
    await transport.uploadObjects({ repo_id: REPO, objects: [walObject(walBytes)], byo: { destination: { kind: "directory", path: root } } });
    const finalizeCall = calls.find((c) => c.path.includes("/finalize"))!;
    assert.deepEqual(finalizeCall.body, { attestations: [{ key, sha256: entry.sha256, size_bytes: entry.size_bytes, create_only_result: "created" }] });
  });

  it("the inline (bytes-in-body) fast path is NEVER used for a BYO vault, even for a tiny payload well under the inline caps", async () => {
    const root = scratchDir("run402-byo-no-inline-");
    const tiny = new Uint8Array([1]);
    const entry = gitvaultManifestEntry(walObject(tiny));
    const key = `source/${REPO}/wal/${WAL}.pack.enc`;
    let sawInlineBytesField = false;
    const { transport } = byoTransportOver(root, (call) => {
      if (call.path.endsWith("/upload-sessions")) {
        const body = call.body as { objects?: Array<{ bytes?: unknown }> } | undefined;
        if (body?.objects?.some((o) => o.bytes !== undefined)) sawInlineBytesField = true;
        return { upload_session_id: "us_5", objects: [{ ...entry, put: null, key }] };
      }
      if (call.path.includes("/finalize")) return { receipts: [{ ...entry, stored_bytes_sha256: entry.sha256, size_bytes: entry.size_bytes }] };
      throw new Error(`unexpected call: ${call.path}`);
    });
    await transport.uploadObjects({ repo_id: REPO, objects: [walObject(tiny)], byo: { destination: { kind: "directory", path: root } } });
    assert.equal(sawInlineBytesField, false, "a BYO session-create request must never carry inline bytes, even under the inline caps");
  });
});

// ─── C/D. Chain-copy dual-write + absence adjudication (task 3.3) ────────────

describe("gitvault BYO chain-copy dual-write, scoped to chain kinds, admission order (task 3.3)", () => {
  function G(n: number): string {
    return BigInt(n).toString(16).padStart(16, "0");
  }

  function listingClient(entries: Array<{ key: string; object_kind: string; sha256: string; size_bytes: string }>): Parameters<typeof byoChainCopySync>[0] {
    const bytesByKey = new Map<string, Uint8Array>();
    for (const e of entries) bytesByKey.set(e.key, new TextEncoder().encode(`${e.key}-bytes`));
    return {
      apiBase: "https://api.example.test",
      credentials: { getAuth: async () => ({}) },
      async request<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
        if (path.includes("/objects")) return { repo_id: REPO, objects: entries.map((e) => ({ key: `source/${REPO}/${e.key}`, object_kind: e.object_kind, sha256: e.sha256, size_bytes: e.size_bytes })), has_more: false, next_cursor: null } as T;
        if (path.includes("/object-reads")) {
          const body = opts?.body as { objects: Array<{ object_kind: string; object_id?: string }> };
          const reads = body.objects.map((o) => {
            const found = entries.find((e) => e.object_kind === o.object_kind && (o.object_id === undefined || e.key.includes(o.object_id)));
            return found ? { url: `mem://${found.key}` } : null;
          }).filter(Boolean);
          return { reads } as T;
        }
        throw new Error(`unexpected request: ${path}`);
      },
      async fetch(url: string) {
        const key = url.replace("mem://", "");
        // generation-addressed (heads/admissions) fetch:
        if (url.includes("/heads/") || url.includes("/admissions/")) {
          const gen = url.split("/").pop()!;
          const entry = entries.find((e) => e.key === `head/${gen}` || e.key === `admissions/${gen}`);
          return entry ? new Response(bytesByKey.get(entry.key)) : new Response(null, { status: 404 });
        }
        const bytes = bytesByKey.get(key);
        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
      },
      async fetch2() {
        return new Response(null, { status: 404 });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  // A raw generation-addressed head/admission read goes through
  // `${base}/heads/:gen` / `${base}/admissions/:gen`, not object-reads —
  // build a client that answers both shapes directly.
  function fullListingClient(): Parameters<typeof byoChainCopySync>[0] {
    const wal = { key: `wal/${WAL}.pack.enc`, object_kind: "wal_pack", sha256: sha256Hex(new TextEncoder().encode("wal-bytes")), size_bytes: String(new TextEncoder().encode("wal-bytes").length) };
    const vr = { key: `verifier-receipts/${VR}.json`, object_kind: "verifier_receipt", sha256: sha256Hex(new TextEncoder().encode("vr-bytes")), size_bytes: String(new TextEncoder().encode("vr-bytes").length) };
    const admission1 = { key: `admissions/${G(1)}`, object_kind: "admission_record", sha256: sha256Hex(new TextEncoder().encode("adm1")), size_bytes: String(4) };
    const head0 = { key: `head/${G(0)}`, object_kind: "vault_genesis", sha256: sha256Hex(new TextEncoder().encode("head0")), size_bytes: String(5) };
    const head1 = { key: `head/${G(1)}`, object_kind: "head", sha256: sha256Hex(new TextEncoder().encode("head1")), size_bytes: String(5) };
    const bytesByKey = new Map<string, Uint8Array>([
      [wal.key, new TextEncoder().encode("wal-bytes")],
      [vr.key, new TextEncoder().encode("vr-bytes")],
      [admission1.key, new TextEncoder().encode("adm1")],
      [head0.key, new TextEncoder().encode("head0")],
      [head1.key, new TextEncoder().encode("head1")],
    ]);
    const all = [wal, vr, admission1, head0, head1];
    return {
      apiBase: "https://api.example.test",
      credentials: { getAuth: async () => ({}) },
      async request<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
        if (path.includes("/objects")) return { repo_id: REPO, objects: all.map((e) => ({ key: `source/${REPO}/${e.key}`, object_kind: e.object_kind, sha256: e.sha256, size_bytes: e.size_bytes })), has_more: false, next_cursor: null } as T;
        if (path.includes("/object-reads")) {
          const body = opts?.body as { objects: Array<{ object_kind: string; object_id?: string }> };
          const reads = body.objects.map((o) => {
            const found = all.find((e) => e.object_kind === o.object_kind);
            return found ? { url: `mem://${found.key}` } : null;
          }).filter(Boolean);
          return { reads } as T;
        }
        throw new Error(`unexpected request: ${path}`);
      },
      async fetch(url: string) {
        if (url.startsWith("mem://")) {
          const key = url.replace("mem://", "");
          const bytes = bytesByKey.get(key);
          return bytes ? new Response(bytes) : new Response(null, { status: 404 });
        }
        // Raw generation-addressed route: `.../heads/<gen>` or `.../admissions/<gen>`
        const genMatch = /\/(heads|admissions)\/([0-9a-f]{16})/.exec(url);
        if (genMatch) {
          const [, route, gen] = genMatch;
          const entry = all.find((e) => e.key === `${route === "heads" ? "head" : "admissions"}/${gen}`);
          return entry ? new Response(bytesByKey.get(entry.key)) : new Response(null, { status: 404 });
        }
        return new Response(null, { status: 404 });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it("copies ONLY the chain (heads/admissions + chain-adjacent), never the payload kinds already written directly by task 3.2's push path", async () => {
    const root = scratchDir("run402-byo-chaincopy-");
    // gitvault-mirror.ts's own default resolution (`openByoBackendFromConfig`)
    // opens a REPO-SCOPED backend (`openGitvaultMirrorBackend`, which bakes
    // `source/<repo_id>` into its root) because `listGitvaultObjectsAll`
    // strips that prefix before anything in this module sees a key — the
    // override here must match that shape, not the payload-write path's
    // root-scoped `openGitvaultDestinationBackend` (section B, above).
    const summary = await byoChainCopySync(fullListingClient(), REPO, { backend: openGitvaultMirrorBackend({ kind: "directory", path: root }, REPO, undefined) });
    assert.equal(summary.objects_failed, 0, JSON.stringify(summary.errors));
    // 4 chain entries copied: admission_record, vault_genesis, head, verifier_receipt — NOT the wal_pack.
    assert.equal(summary.objects_copied, 4);
    assert.equal(existsSync(join(root, "source", REPO, "wal")), false, "the wal_pack payload object must never be copied by the chain-only dual-write");
    assert.ok(readFileSync(join(root, "source", REPO, "verifier-receipts", `${VR}.json`)));
    assert.ok(readFileSync(join(root, "source", REPO, "head", G(1))));
    assert.ok(readFileSync(join(root, "source", REPO, "admissions", G(1))));
  });

  it("torn chain-copy (interrupted mid-admissions/heads) still leaves a fully valid, resumable state — objects phase always completes before any admission/head write", async () => {
    const root = scratchDir("run402-byo-chaincopy-torn-");
    const backend = openGitvaultMirrorBackend({ kind: "directory", path: root }, REPO, undefined);
    // Only copy the objects phase (chain-adjacent, non-generation-addressed) —
    // simulating an interruption BEFORE any admissions/heads write landed.
    await backend.putCreateOnly(`verifier-receipts/${VR}.json`, new TextEncoder().encode("vr-bytes"));
    const present = await verifyByoObjectsPresent(fullListingClient(), REPO, { backend });
    // The wal_pack payload object is genuinely absent from THIS destination in
    // this test (never written by this test) — reported by name, not silently.
    assert.ok(present.missing.some((m) => m.object_kind === "wal_pack"));
    assert.ok(present.missing.some((m) => m.object_kind === "head"));
    assert.ok(!present.missing.some((m) => m.object_kind === "verifier_receipt"), "the one object this test did write must not be reported missing");
  });
});

// ─── E. Degraded-read BYO branch + precedence (task 3.4) ─────────────────────

describe("gitvault degraded-read BYO branch (task 3.4)", () => {
  let root: string;
  let keystore: GitvaultKeystore;

  beforeEach(() => {
    _resetGitvaultEdgeFetchStateForTest();
    root = scratchDir("run402-byo-degraded-");
    keystore = new GitvaultKeystore({ rootDir: root });
  });

  it("resolves to the BYO destination when no mirror is configured", () => {
    saveByoConfig(keystore, { repo_id: REPO, destination: { kind: "directory", path: join(root, "byo") } });
    const source = resolveDegradedReadSource(keystore, REPO);
    assert.equal(source?.kind, "byo");
    assert.equal(source?.destination, join(root, "byo"));
  });

  it("prefers the configured MIRROR over a BYO local config when both exist on this machine", () => {
    saveByoConfig(keystore, { repo_id: REPO, destination: { kind: "directory", path: join(root, "byo") } });
    saveMirrorConfig(keystore, { repo_id: REPO, destination: { kind: "directory", path: join(root, "mirror") } });
    const source = resolveDegradedReadSource(keystore, REPO);
    assert.equal(source?.kind, "mirror");
    assert.equal(source?.destination, join(root, "mirror"));
  });

  it("null when neither a mirror nor a BYO config exists", () => {
    assert.equal(resolveDegradedReadSource(keystore, REPO), null);
  });

  it("readByoConfig round-trips exactly what was saved, including credential kind", () => {
    saveByoConfig(keystore, { repo_id: REPO, destination: { kind: "s3", bucket: "b", prefix: "p", region: "us-east-1" }, credential: { kind: "profile", profile: "recovery-laptop" } });
    const cfg = readByoConfig(keystore, REPO);
    assert.equal(cfg?.destination.kind, "s3");
    assert.equal(cfg?.credential?.kind, "profile");
  });
});

// ─── G. Managed vaults stay byte-identical with storage_profile unset ────────

describe("managed vaults are byte-identical — uploadObjects with no `byo` arg never touches BYO machinery", () => {
  it("a session response with a real presigned put (no key, no null) goes through the ordinary PUT path even when the caller never passes byo", async () => {
    // Sized ABOVE GITVAULT_INLINE_UPLOAD_MAX_OBJECT_BYTES on purpose: a
    // small payload is inline-eligible (`gitvaultInlineUploadEligible`) and
    // `upload()` would take the one-POST inline fast path instead of the
    // session+PUT+finalize path this test names and exercises.
    const vrBytes = new Uint8Array(GITVAULT_INLINE_UPLOAD_MAX_OBJECT_BYTES + 1).fill(3);
    const entry = { object_kind: "verifier_receipt", object_id: VR, sha256: sha256Hex(vrBytes), size_bytes: String(vrBytes.length) };
    let fetchCalled = false;
    const client = {
      apiBase: "https://api.example.test",
      credentials: { getAuth: async () => ({}) },
      async request<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
        if (path.endsWith("/upload-sessions")) {
          const body = opts.body as { objects?: unknown[] };
          assert.ok(Array.isArray(body.objects));
          return { upload_session_id: "us_managed", objects: [{ ...entry, put: { url: "https://managed-bucket.example/presigned" } }] } as T;
        }
        if (path.includes("/finalize")) {
          const b = opts.body as Record<string, unknown>;
          assert.deepEqual(b, {}, "a managed finalize body stays exactly {} — no attestations field appears");
          return { receipts: [{ ...entry, stored_bytes_sha256: entry.sha256, size_bytes: entry.size_bytes }] } as T;
        }
        throw new Error(`unexpected request: ${path}`);
      },
      async fetch(url: string) {
        fetchCalled = true;
        assert.equal(url, "https://managed-bucket.example/presigned");
        return new Response(null, { status: 200 });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as Parameters<typeof createGitvaultHttpTransport>[0];
    const transport = createGitvaultHttpTransport(client);
    const receipts = await transport.uploadObjects({
      repo_id: REPO,
      objects: [{ path: gitvaultPaths.verifierReceipt(VR), object_kind: "verifier_receipt", object_id: VR, bytes: vrBytes, sha256: entry.sha256, size_bytes: entry.size_bytes }],
    });
    assert.ok(fetchCalled);
    assert.equal(receipts[0]!.sha256, entry.sha256);
  });
});

// ─── C. BYO payload READ path (gitvault-byo-primary-bucket task 5.1 finding) ─
//
// The gateway holds no payload copy of a BYO vault, so `object-reads` entries
// and `GET …/state` carriers for the payload kinds carry `byo_key` instead of
// a presign. The transport must read that key from the vault's locally
// configured destination — never from run402 — and a machine WITHOUT a local
// config must refuse by name rather than report a false absence (which is
// exactly what a clean machine's cold open did before this path existed:
// "base key_envelope could not be retrieved").

describe("gitvault BYO payload read path: byo_key entries are read from the local destination backend", () => {
  const KEY = `source/${REPO}/wal/${WAL}.pack.enc`;
  const BYTES = new Uint8Array([7, 7, 7, 7]);

  function fakeBackend(store: Map<string, Uint8Array>, gets: string[]) {
    return {
      describe: () => "fake://byo",
      head: async () => null,
      get: async (key: string) => {
        gets.push(key);
        return store.get(key) ?? null;
      },
      putCreateOnly: async () => ({ created: true }),
    } as unknown as import("./gitvault-mirror-backend.js").GitvaultMirrorBackend;
  }

  function client(handler: (path: string, opts: { method?: string; body?: unknown }) => unknown, fetched: string[]) {
    return {
      apiBase: "https://api.example.test",
      credentials: { getAuth: async () => ({}) },
      async request<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
        return handler(path, opts) as T;
      },
      async fetch(url: string) {
        fetched.push(url);
        throw new Error(`a BYO payload read reached client.fetch (run402 or a presign) instead of the customer bucket: ${url}`);
      },
    } as unknown as Parameters<typeof createGitvaultHttpTransport>[0];
  }

  it("getObject resolves a byo_key entry through byoBackend and never dials run402 for the bytes", async () => {
    const gets: string[] = [];
    const fetched: string[] = [];
    const store = new Map([[KEY, BYTES]]);
    const transport = createGitvaultHttpTransport(
      client((path) => {
        if (path.endsWith("/object-reads")) return { reads: [{ object_kind: "wal_pack", object_id: WAL, byo_key: KEY, stored_bytes_sha256: sha256Hex(BYTES), size_bytes: String(BYTES.length) }] };
        throw new Error(`unexpected request ${path}`);
      }, fetched),
      { byoBackend: () => fakeBackend(store, gets) },
    );
    const got = await transport.getObject({ repo_id: REPO, path: gitvaultPaths.wal(WAL) });
    assert.deepEqual(got, BYTES);
    assert.deepEqual(gets, [KEY]);
    assert.deepEqual(fetched, []);
  });

  it("an absent key in the customer bucket is `null` (absence adjudication takes over), not an error", async () => {
    const transport = createGitvaultHttpTransport(
      client((path) => {
        if (path.endsWith("/object-reads")) return { reads: [{ object_kind: "wal_pack", object_id: WAL, byo_key: KEY, stored_bytes_sha256: "0".repeat(64), size_bytes: "4" }] };
        throw new Error(`unexpected request ${path}`);
      }, []),
      { byoBackend: () => fakeBackend(new Map(), []) },
    );
    assert.equal(await transport.getObject({ repo_id: REPO, path: gitvaultPaths.wal(WAL) }), null);
  });

  it("a machine with no local BYO config refuses GITVAULT_BYO_NOT_CONFIGURED by name — never a false absence", async () => {
    for (const opts of [{}, { byoBackend: () => null }]) {
      const transport = createGitvaultHttpTransport(
        client((path) => {
          if (path.endsWith("/object-reads")) return { reads: [{ object_kind: "wal_pack", object_id: WAL, byo_key: KEY, stored_bytes_sha256: "0".repeat(64), size_bytes: "4" }] };
          throw new Error(`unexpected request ${path}`);
        }, []),
        opts,
      );
      await assert.rejects(
        transport.getObject({ repo_id: REPO, path: gitvaultPaths.wal(WAL) }),
        (e: unknown) => (e as { code?: string }).code === "GITVAULT_BYO_NOT_CONFIGURED",
      );
    }
  });

  it("GET …/state byo_key carriers resolve through the same backend", async () => {
    const gets: string[] = [];
    const refKey = `source/${REPO}/refs/rs_${"1".repeat(32)}.enc`;
    const rrKey = `source/${REPO}/retention/rr_${"2".repeat(32)}.enc`;
    const store = new Map([[refKey, new Uint8Array([1])], [rrKey, new Uint8Array([2])]]);
    const headBytes = new TextEncoder().encode("{}");
    const transport = createGitvaultHttpTransport(
      client((path) => {
        if (path.includes("/state")) {
          return {
            vault: { repo_id: REPO },
            newest_generation: "0000000000000003",
            head: { stored_bytes: Buffer.from(headBytes).toString("base64url"), stored_bytes_sha256: sha256Hex(headBytes) },
            carriers: { ref_state: { byo_key: refKey }, retention_roots: { byo_key: rrKey } },
          };
        }
        throw new Error(`unexpected request ${path}`);
      }, []),
      { byoBackend: () => fakeBackend(store, gets) },
    );
    const state = await transport.getState({ repo_id: REPO });
    assert.deepEqual(state.carriers?.ref_state, new Uint8Array([1]));
    assert.deepEqual(state.carriers?.retention_roots, new Uint8Array([2]));
    assert.deepEqual(gets.sort(), [refKey, rrKey].sort());
  });
});
