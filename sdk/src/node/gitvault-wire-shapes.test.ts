/**
 * Wire-shape reconciliation (add-gitvault task 5.6c).
 *
 * Task 5.4 built the publication layer against ASSUMED endpoint shapes, before
 * the control plane's routes existed. When they shipped, five of the ten
 * assumptions were wrong — and the two that mattered most were wrong in a way
 * no type-checker could catch, because both sides speak JSON:
 *
 *   1. objects are addressed by LEDGER IDENTITY (`object_kind` + `object_id`,
 *      or `epoch` + `recipient_fingerprint`), never by bucket path. The
 *      manifest validator is CLOSED-KEY, so a stray `path` member is a hard
 *      refusal of the whole session, not an ignored extra;
 *   2. heads and admission records are not uploadable objects at all — they
 *      have their own generation-addressed routes.
 *
 * These tests pin the translation so a future edit cannot quietly reintroduce
 * path-addressing.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createGitvaultHttpTransport, gitvaultLedgerId, gitvaultManifestEntry, gitvaultPaths, gitvaultWireRefForPath } from "./gitvault-publication.js";
import type { GitvaultUploadObject } from "./gitvault-publication.js";
import { checkActivationTokenBinding } from "./gitvault-deploy.js";
import { _resetGitvaultEdgeFetchStateForTest } from "./gitvault-edge-fetch.js";
import { toBase64url } from "../namespaces/gitvault.crypto.js";
import { ApiError } from "../errors.js";
import type { GitvaultActivationToken } from "../namespaces/gitvault.types.js";

const WAL = `wal_${"1".repeat(32)}`;
const REFS = `refs_${"2".repeat(32)}`;
const RR = `rr_${"3".repeat(32)}`;
const CHK = `chk_${"4".repeat(32)}`;
const CKP = `ckp_${"5".repeat(32)}`;
const CCS = `ccs_${"6".repeat(32)}`;
const EK = `ek_${"7".repeat(32)}`;
const EPOCH = "0000000000000001";
const GEN = "0000000000000002";

describe("gitvaultWireRefForPath — every §3 storage path maps to a control-plane identity", () => {
  it("routes heads and admission records to their generation-addressed routes, NOT object-reads", () => {
    assert.deepEqual(gitvaultWireRefForPath(gitvaultPaths.head(GEN)), { kind: "head", generation: GEN });
    assert.deepEqual(gitvaultWireRefForPath(gitvaultPaths.admission(GEN)), { kind: "admission", generation: GEN });
  });

  it("maps every uploadable kind to its object_kind + object_id", () => {
    const cases: Array<[string, string, string]> = [
      [gitvaultPaths.wal(WAL), "wal_pack", WAL],
      [gitvaultPaths.refState(REFS), "ref_state", REFS],
      [gitvaultPaths.retentionRoots(RR), "retention_roots", RR],
      [gitvaultPaths.checkpointManifest(CHK), "checkpoint_manifest", CHK],
      [gitvaultPaths.checkpointPack(CKP), "checkpoint_pack", CKP],
      [gitvaultPaths.claimSet(CCS), "checkpoint_claim_set", CCS],
    ];
    for (const [path, kind, id] of cases) {
      assert.deepEqual(gitvaultWireRefForPath(path), { kind: "object", read: { object_kind: kind, object_id: id } }, path);
    }
  });

  it("maps a key envelope to epoch + recipient_fingerprint (it is path-addressed in storage, identity-addressed on the wire)", () => {
    assert.deepEqual(gitvaultWireRefForPath(`envelopes/${EPOCH}/${EK}`), {
      kind: "object",
      read: { object_kind: "key_envelope", epoch: EPOCH, recipient_fingerprint: EK },
    });
  });

  it("maps a recipient_pin_manifest to pin_manifest_version, NOT epoch/recipient_fingerprint (D197, rev 42 — the SECOND path-addressed, null-idScalar kind)", () => {
    const VERSION = "0000000000000001";
    assert.deepEqual(gitvaultWireRefForPath(gitvaultPaths.pinManifest(VERSION)), {
      kind: "object",
      read: { object_kind: "recipient_pin_manifest", pin_manifest_version: VERSION },
    });
    // This IS the correct wire shape per protocol-v0.md's identity taxonomy
    // ("VERSION-ADDRESSED: ... recipient_pin_manifest by (repo_id,
    // pin_manifest_version)") and the gateway's own upload-side
    // `UPLOADABLE_KINDS.recipient_pin_manifest.pathFields` — and the
    // gateway's object-reads route accepts it (fixed and live-verified
    // 2026-08-28; before that its null-idScalar validation was hardcoded
    // to key_envelope's `{epoch, recipient_fingerprint}` shape and 400'd
    // this read with "epoch must be 16 hex"). A change that reshapes this
    // call to send epoch/recipient_fingerprint would be the regression
    // this test exists to catch. See GitvaultVault.readPinManifestObject's
    // doc comment (gitvault-publication.ts) for the local cache that lets
    // a keystore skip re-fetching a manifest it itself just published.
    const ref = gitvaultWireRefForPath(gitvaultPaths.pinManifest(VERSION));
    assert.equal(ref?.kind, "object");
    if (ref?.kind === "object") {
      assert.deepEqual(Object.keys(ref.read).sort(), ["object_kind", "pin_manifest_version"]);
      assert.equal("epoch" in ref.read, false);
      assert.equal("recipient_fingerprint" in ref.read, false);
    }
  });

  it("does not confuse `retention/<rr>.enc` with `retention/<id>.ticket.json` — the ticket has no wire identity", () => {
    assert.deepEqual(gitvaultWireRefForPath(gitvaultPaths.retentionRoots(RR)), { kind: "object", read: { object_kind: "retention_roots", object_id: RR } });
    assert.equal(gitvaultWireRefForPath(gitvaultPaths.cutoffTicket(RR)), null, "a cutoff ticket is held locally; it is not a readable vault object");
  });

  it("returns null for anything not a §3 path, rather than guessing a kind", () => {
    for (const path of ["", "head/", "head/zzzz", "wal/wal_short.pack.enc", "checkpoints/nope.enc", "../etc/passwd", `envelopes/${EPOCH}/not-a-fingerprint`]) {
      assert.equal(gitvaultWireRefForPath(path), null, path);
    }
  });
});

describe("gitvaultManifestEntry — the closed-key upload manifest", () => {
  const obj = (over: Partial<GitvaultUploadObject> = {}): GitvaultUploadObject => ({
    path: gitvaultPaths.refState(REFS),
    object_kind: "ref_state",
    object_id: REFS,
    bytes: new Uint8Array([1, 2, 3]),
    sha256: "a".repeat(64),
    size_bytes: "3",
    ...over,
  });

  it("NEVER emits `path` — the control plane derives the bucket key and refuses an unexpected member", () => {
    const entry = gitvaultManifestEntry(obj());
    assert.deepEqual(Object.keys(entry).sort(), ["object_id", "object_kind", "sha256", "size_bytes"]);
    assert.equal("path" in entry, false);
  });

  it("emits epoch + recipient_fingerprint for a key envelope, and no object_id", () => {
    const entry = gitvaultManifestEntry(obj({ path: `envelopes/${EPOCH}/${EK}`, object_kind: "key_envelope", object_id: null }));
    assert.deepEqual(Object.keys(entry).sort(), ["epoch", "object_kind", "recipient_fingerprint", "sha256", "size_bytes"]);
    assert.equal(entry.epoch, EPOCH);
    assert.equal(entry.recipient_fingerprint, EK);
  });

  it("emits pin_manifest_version for a recipient_pin_manifest upload, and no object_id/epoch/recipient_fingerprint", () => {
    const VERSION = "0000000000000001";
    const entry = gitvaultManifestEntry(obj({ path: gitvaultPaths.pinManifest(VERSION), object_kind: "recipient_pin_manifest", object_id: null }));
    assert.deepEqual(Object.keys(entry).sort(), ["object_kind", "pin_manifest_version", "sha256", "size_bytes"]);
    assert.equal((entry as unknown as { pin_manifest_version?: string }).pin_manifest_version, VERSION);
  });

  it("carries base_generation for a wal_pack — the ONLY receipt kind that has one (§4.1)", () => {
    const entry = gitvaultManifestEntry(obj({ path: gitvaultPaths.wal(WAL), object_kind: "wal_pack", object_id: WAL, base_generation: GEN }));
    assert.equal(entry.base_generation, GEN);
  });

  it("refuses a wal_pack with no base_generation instead of letting the server reject the whole session", () => {
    assert.throws(
      () => gitvaultManifestEntry(obj({ path: gitvaultPaths.wal(WAL), object_kind: "wal_pack", object_id: WAL })),
      (e: unknown) => (e as { code?: string }).code === "GITVAULT_UPLOAD_SESSION_INVALID",
    );
  });

  it("refuses to build a manifest entry for a non-uploadable path (a head is admitted, never uploaded)", () => {
    assert.throws(
      () => gitvaultManifestEntry(obj({ path: gitvaultPaths.head(GEN), object_kind: "head", object_id: null })),
      (e: unknown) => (e as { code?: string }).code === "GITVAULT_UPLOAD_SESSION_INVALID",
    );
  });
});

describe("gitvaultLedgerId — the key both sides pair receipts on", () => {
  it("is the object id for id-addressed kinds", () => {
    assert.equal(gitvaultLedgerId({ object_kind: "ref_state", object_id: REFS }), REFS);
  });

  it("is the synthetic `key_envelope:<epoch>:<fingerprint>` for envelopes, matching the ledger's own key", () => {
    assert.equal(gitvaultLedgerId({ object_kind: "key_envelope", epoch: EPOCH, recipient_fingerprint: EK }), `key_envelope:${EPOCH}:${EK}`);
  });

  it("round-trips through the path resolver, so an upload and its receipt pair on the same key", () => {
    for (const path of [gitvaultPaths.wal(WAL), gitvaultPaths.claimSet(CCS), `envelopes/${EPOCH}/${EK}`]) {
      const ref = gitvaultWireRefForPath(path);
      assert.ok(ref && ref.kind === "object", path);
      assert.equal(typeof gitvaultLedgerId(ref.read), "string");
    }
  });
});

// ─── Envelope vs payload: what the route wraps, the transport must unwrap ────

/**
 * The third wire-shape assumption that was wrong in a way no type-checker could
 * catch. `POST …/activation-tokens` does not answer the signed token — it
 * answers an ENVELOPE that wraps it and adds routing sugar:
 *
 *   res.status(minted.reissued ? 200 : 201).json({
 *     activation_token: minted.token,
 *     object_id: minted.object_id,
 *     reissued: minted.reissued,
 *     next_actions: [...],
 *   });
 *
 * (gateway `routes/gitvault-admission.ts`, `POST …/activation-tokens` — §6.5.)
 *
 * The envelope's SIBLING `object_id` is what makes this so quiet: the shape
 * looks close enough to a token to pass a glance, and `GitvaultActivationToken`
 * is a plain interface, so `client.request<GitvaultActivationToken>` asserts
 * the wrong type without a single complaint. The failure surfaces nine layers
 * later, as every one of `checkActivationTokenBinding`'s fields mismatching —
 * which reads like a mint bug, not a `.activation_token` that was never
 * dereferenced. Found by the production smoke, not by any local suite.
 *
 * `allocate` has the same envelope shape and is unwrapped the same way.
 */
describe("createGitvaultHttpTransport — head-reads is a POST batch whose bytes stay untrusted (gitvault-batched-head-reads)", () => {
  const REPO = `r402s_${"e".repeat(32)}`;
  const G = (n: number): string => BigInt(n).toString(16).padStart(16, "0");
  const b64u = (s: string): string => toBase64url(new TextEncoder().encode(s));

  interface WireCall { path: string; method?: string; body?: unknown }

  function transportOver(handler: (call: WireCall) => unknown): { transport: ReturnType<typeof createGitvaultHttpTransport>; calls: WireCall[] } {
    const calls: WireCall[] = [];
    const client = {
      apiBase: "https://api.example.test",
      async request<T>(path: string, opts: { method?: string; body?: unknown }): Promise<T> {
        const call = { path, method: opts.method, body: opts.body };
        calls.push(call);
        return handler(call) as T;
      },
    } as unknown as Parameters<typeof createGitvaultHttpTransport>[0];
    return { transport: createGitvaultHttpTransport(client), calls };
  }

  it("POSTs `{generations}` to …/head-reads and returns the decoded bytes in request order", async () => {
    const { transport, calls } = transportOver(() => ({
      format: "r402s/v0",
      repo_id: REPO,
      heads: [
        { generation: G(1), stored_bytes: b64u("one"), stored_bytes_sha256: "a".repeat(64) },
        { generation: G(2), stored_bytes: b64u("two"), stored_bytes_sha256: "b".repeat(64) },
      ],
    }));
    const got = await transport.getHeads({ repo_id: REPO, generations: [G(1), G(2)] });
    assert.deepEqual(calls, [{ path: `/gitvault/v1/vaults/${REPO}/head-reads`, method: "POST", body: { generations: [G(1), G(2)] } }]);
    assert.deepEqual(got?.map((b) => new TextDecoder().decode(b)), ["one", "two"]);
  });

  it("costs nothing for an empty request — no round trip at all", async () => {
    const { transport, calls } = transportOver(() => ({ heads: [] }));
    assert.deepEqual(await transport.getHeads({ repo_id: REPO, generations: [] }), []);
    assert.deepEqual(calls, []);
  });

  it("reads a short, reordered, or malformed page as UNSUPPORTED — never as a partial answer", async () => {
    // A hole here would reach the walk as "this head is absent", which is a
    // very different claim from "the batch could not serve me". The route is
    // all-or-nothing; anything less falls back.
    for (const body of [
      { heads: [{ generation: G(1), stored_bytes: b64u("one") }] }, // short
      { heads: [{ generation: G(9), stored_bytes: b64u("x") }, { generation: G(8), stored_bytes: b64u("y") }] }, // wrong generations
      { heads: [{ generation: G(1) }, { generation: G(2) }] }, // no bytes
      {}, // no heads member at all
    ]) {
      const { transport } = transportOver(() => body);
      assert.equal(await transport.getHeads({ repo_id: REPO, generations: [G(1), G(2)] }), null, JSON.stringify(body));
    }
  });

  it("reads any failure as UNSUPPORTED, and remembers only a route-absent 404", async () => {
    // Real `ApiError`s: the memo turns on `isRun402Error` + `status`, so a
    // hand-rolled lookalike would test the fixture instead of the code.
    const notFound = new ApiError("no such route", 404, {}, "reading gitvault heads in a batch");
    const serverError = new ApiError("boom", 500, {}, "reading gitvault heads in a batch");

    // A transient failure falls back for THIS call only — the next call still probes.
    let thrown: unknown = serverError;
    const transient = transportOver(() => {
      throw thrown;
    });
    assert.equal(await transient.transport.getHeads({ repo_id: REPO, generations: [G(1)] }), null);
    thrown = serverError;
    assert.equal(await transient.transport.getHeads({ repo_id: REPO, generations: [G(1)] }), null);
    assert.equal(transient.calls.length, 2, "a transient failure must not disable the route");

    // A 404 is what an older gateway says about a route it never shipped, so
    // the verdict sticks for this transport's lifetime — one probe, not one
    // per window.
    let raise: unknown = notFound;
    const absent = transportOver(() => {
      throw raise;
    });
    assert.equal(await absent.transport.getHeads({ repo_id: REPO, generations: [G(1)] }), null);
    raise = null;
    assert.equal(await absent.transport.getHeads({ repo_id: REPO, generations: [G(2)] }), null);
    assert.equal(absent.calls.length, 1, "the unsupported verdict is remembered, so no second probe goes out");
  });
});

describe("createGitvaultHttpTransport — compaction headroom grant open/close (gitvault-checkpoint-cadence design D3)", () => {
  const REPO = `r402s_${"f".repeat(32)}`;

  interface WireCall { path: string; method?: string; body?: unknown }

  function transportOver(handler: (call: WireCall) => unknown): { transport: ReturnType<typeof createGitvaultHttpTransport>; calls: WireCall[] } {
    const calls: WireCall[] = [];
    const client = {
      apiBase: "https://api.example.test",
      async request<T>(path: string, opts: { method?: string; body?: unknown }): Promise<T> {
        const call = { path, method: opts.method, body: opts.body };
        calls.push(call);
        return handler(call) as T;
      },
    } as unknown as Parameters<typeof createGitvaultHttpTransport>[0];
    return { transport: createGitvaultHttpTransport(client), calls };
  }

  it("opens with a bare POST …/compaction-grant and returns the grant verbatim", async () => {
    // Byte fields are STRINGS on the wire (gateway BIGINT serialization, verified live 2026-08-31).
    const grant = { granted_bytes: "1024", expires_at: "2026-01-01T01:00:00.000Z", pool_used_bytes: "10", pool_limit_bytes: "1000", effective_pool_limit_bytes: "2024" };
    const { transport, calls } = transportOver(() => grant);
    const got = await transport.openCompactionGrant({ repo_id: REPO });
    assert.deepEqual(calls, [{ path: `/gitvault/v1/vaults/${REPO}/compaction-grant`, method: "POST", body: undefined }]);
    assert.deepEqual(got, grant);
  });

  it("closes with a bare DELETE …/compaction-grant and normalizes `closed` to a strict boolean", async () => {
    const { transport, calls } = transportOver(() => ({ closed: true }));
    const got = await transport.closeCompactionGrant({ repo_id: REPO });
    assert.deepEqual(calls, [{ path: `/gitvault/v1/vaults/${REPO}/compaction-grant`, method: "DELETE", body: undefined }]);
    assert.deepEqual(got, { closed: true });
  });

  it("a route that omits `closed` (or answers falsily) reports `{closed: false}`, never `undefined`", async () => {
    for (const body of [{}, { closed: false }, { closed: null }]) {
      const { transport } = transportOver(() => body);
      assert.deepEqual(await transport.closeCompactionGrant({ repo_id: REPO }), { closed: false }, JSON.stringify(body));
    }
  });

  it("propagates a 409 GITVAULT_COMPACTION_GRANT_ACTIVE / 404 route-absent refusal verbatim — the namespace layer, not the transport, interprets them", async () => {
    const conflict = { status: 409, code: "GITVAULT_COMPACTION_GRANT_ACTIVE", details: { expires_at: "2026-01-01T00:00:00.000Z" } };
    const { transport } = transportOver(() => {
      throw conflict;
    });
    await assert.rejects(transport.openCompactionGrant({ repo_id: REPO }), (e: unknown) => (e as { code?: string }).code === "GITVAULT_COMPACTION_GRANT_ACTIVE");

    const missing = { status: 404, code: "ROUTE_NOT_FOUND" };
    const { transport: t2 } = transportOver(() => {
      throw missing;
    });
    await assert.rejects(t2.openCompactionGrant({ repo_id: REPO }), (e: unknown) => (e as { status?: number }).status === 404);
  });
});

describe("createGitvaultHttpTransport — the mint's envelope is unwrapped, never passed on as the token", () => {
  const REPO = `r402s_${"a".repeat(32)}`;
  const OP = "op_wire_shapes";

  /** A minted token exactly as the mint signs it — every field the binding check reads. */
  const token = (): GitvaultActivationToken => ({
    format: "r402s/v0",
    object_kind: "activation_token",
    suite: "x25519-hkdf-sha256-chacha20poly1305-ed25519",
    repo_id: REPO,
    object_id: `ct_${"b".repeat(32)}`,
    service_key_id: "svc_1",
    operation_id: OP,
    generation: "0000000000000003",
    head_sha256: "c".repeat(64),
    capture_id: "d".repeat(32),
    apply_plan_sha256: "e".repeat(64),
    snapshot_oid_hmac: "f".repeat(64),
    issued_at: "2026-08-22T00:00:00.000Z",
    authorization_epoch: "0".repeat(32),
    signature: "sig",
  });

  /** The expectation the deploy lane checks the minted token against (§6.5). */
  const expected = (t: GitvaultActivationToken) => ({
    repo_id: t.repo_id,
    operation_id: t.operation_id,
    generation: t.generation,
    head_sha256: t.head_sha256,
    capture_id: t.capture_id,
    apply_plan_sha256: t.apply_plan_sha256,
    snapshot_oid_hmac: t.snapshot_oid_hmac,
  });

  interface Call { path: string; method?: string; body?: unknown }

  function transportReturning(body: unknown): { transport: ReturnType<typeof createGitvaultHttpTransport>; calls: Call[] } {
    const calls: Call[] = [];
    const client = {
      apiBase: "https://api.example.test",
      async request<T>(path: string, opts: { method?: string; body?: unknown }): Promise<T> {
        calls.push({ path, method: opts.method, body: opts.body });
        return body as T;
      },
    } as unknown as Parameters<typeof createGitvaultHttpTransport>[0];
    return { transport: createGitvaultHttpTransport(client), calls };
  }

  it("unwraps `activation_token` — the envelope the shipped route actually returns", async () => {
    const t = token();
    const { transport, calls } = transportReturning({
      activation_token: t,
      object_id: t.object_id,
      reissued: false,
      next_actions: [{ type: "resume_deploy", why: "commit this operation's apply plan carrying the activation_token" }],
    });
    const got = await transport.exchangeActivationToken({ repo_id: REPO, operation_id: OP, capture_receipt: {} as never });
    assert.deepEqual(got, t, "the signed token, not the envelope that wrapped it");
    assert.deepEqual(calls, [{
      path: `/gitvault/v1/vaults/${REPO}/activation-tokens`,
      method: "POST",
      body: { operation_id: OP, capture_receipt: {} },
    }]);
  });

  it("the unwrapped token satisfies the binding check — the envelope fails ALL NINE fields", () => {
    const t = token();
    assert.deepEqual(checkActivationTokenBinding(t, expected(t)), [], "a correctly unwrapped token binds the deploy");
    // The precise production symptom: the envelope carries a plausible
    // `object_id` and nothing else the check reads, so every field mismatches
    // and the commit is never attempted (`GITVAULT_TOKEN_BINDING_MISMATCH`).
    const envelope = { activation_token: t, object_id: t.object_id, reissued: false } as unknown as GitvaultActivationToken;
    assert.deepEqual(
      checkActivationTokenBinding(envelope, expected(t)),
      ["object_id", "repo_id", "operation_id", "generation", "head_sha256", "capture_id", "apply_plan_sha256", "snapshot_oid_hmac", "authorization_epoch"],
    );
  });

  it("tolerates a bare token body, so the unwrap can never become the new way to be wrong", async () => {
    const t = token();
    const { transport } = transportReturning(t);
    assert.deepEqual(await transport.exchangeActivationToken({ repo_id: REPO, operation_id: OP, capture_receipt: {} as never }), t);
  });

  it("`retention-cutoffs` is NOT enveloped the same way — `{ticket, receipt}` IS the payload", async () => {
    const issued = { ticket: { object_kind: "retention_cutoff" }, receipt: { object_id: `rc_${"9".repeat(32)}` } };
    const { transport } = transportReturning({ ...issued, next_actions: [] });
    const got = await transport.requestRetentionCutoff({ repo_id: REPO, base_head_sha256: "a".repeat(64) });
    assert.equal((got as unknown as { ticket: unknown }).ticket, issued.ticket);
    assert.equal((got as unknown as { receipt: unknown }).receipt, issued.receipt);
  });
});

// ─── RUN402_GITVAULT_TRACE=1 (design D7) ──────────────────────────────────────

describe("createGitvaultHttpTransport — RUN402_GITVAULT_TRACE debug trace", () => {
  const REPO = `r402s_${"a".repeat(32)}`;

  function fakeVaultRecordClient(): Parameters<typeof createGitvaultHttpTransport>[0] {
    return {
      apiBase: "https://api.example.test",
      async request<T>(): Promise<T> {
        return { repo_id: REPO, project_id: "prj_1", org_id: "org_1" } as unknown as T;
      },
    } as unknown as Parameters<typeof createGitvaultHttpTransport>[0];
  }

  it("is silent by default — no RUN402_GITVAULT_TRACE, no stderr writes", async (t) => {
    const original = process.env.RUN402_GITVAULT_TRACE;
    delete process.env.RUN402_GITVAULT_TRACE;
    t.after(() => { if (original === undefined) delete process.env.RUN402_GITVAULT_TRACE; else process.env.RUN402_GITVAULT_TRACE = original; });

    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    t.after(() => { process.stderr.write = originalWrite; });

    const transport = createGitvaultHttpTransport(fakeVaultRecordClient());
    await transport.getVaultRecord({ repo_id: REPO });
    assert.deepEqual(writes.filter((w) => w.includes("gitvault-trace")), []);
  });

  it("RUN402_GITVAULT_TRACE=1 prints one stderr line per operation, naming the op kind", async (t) => {
    const original = process.env.RUN402_GITVAULT_TRACE;
    process.env.RUN402_GITVAULT_TRACE = "1";
    t.after(() => { if (original === undefined) delete process.env.RUN402_GITVAULT_TRACE; else process.env.RUN402_GITVAULT_TRACE = original; });

    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    t.after(() => { process.stderr.write = originalWrite; });

    const transport = createGitvaultHttpTransport(fakeVaultRecordClient());
    await transport.getVaultRecord({ repo_id: REPO });
    const traceLines = writes.filter((w) => w.includes("gitvault-trace"));
    assert.equal(traceLines.length, 1, `expected exactly one trace line, saw: ${JSON.stringify(writes)}`);
    assert.match(traceLines[0]!, /gitvault-trace: getVaultRecord/);
    assert.match(traceLines[0]!, /\d+ms/, "reports a duration");
  });

  it("never writes to stdout — only stderr, matching the remote helper's own note() discipline", async (t) => {
    const original = process.env.RUN402_GITVAULT_TRACE;
    process.env.RUN402_GITVAULT_TRACE = "1";
    t.after(() => { if (original === undefined) delete process.env.RUN402_GITVAULT_TRACE; else process.env.RUN402_GITVAULT_TRACE = original; });

    const stdoutWrites: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => { stdoutWrites.push(String(chunk)); return true; }) as typeof process.stdout.write;
    t.after(() => { process.stdout.write = originalStdoutWrite; });
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    t.after(() => { process.stderr.write = originalStderrWrite; });

    const transport = createGitvaultHttpTransport(fakeVaultRecordClient());
    await transport.getVaultRecord({ repo_id: REPO });
    assert.deepEqual(stdoutWrites, []);
  });
});

// ─── gitvault-read-edge-cache design D5: edge_url wiring through the real routes ──

/**
 * `fetchGitvaultObjectBytes` (`gitvault-edge-fetch.ts`) itself is unit-tested
 * against a bare `{fetch}` fake in `gitvault-edge-fetch.test.ts` — every
 * preference/fallback/stickiness scenario lives there. What THIS describe
 * pins is the wiring on top of it: that `getObject`/`getObjects`/`getState`
 * actually extract `edge_url` from the wire responses they parse
 * (`object-reads`'s per-read entries, `state`'s presigned carrier arm) and
 * hand it to the shared helper, rather than a plain `client.fetch(url, …)`
 * that happens to ignore the new field.
 */
describe("createGitvaultHttpTransport — edge_url from the wire response reaches every read (gitvault-read-edge-cache design D5)", () => {
  const REPO = `r402s_${"a".repeat(32)}`;
  const WAL_ID = `wal_${"9".repeat(32)}`;
  const REFS_ID = `refs_${"8".repeat(32)}`;

  beforeEach(() => {
    _resetGitvaultEdgeFetchStateForTest();
  });

  function fakeClient(opts: { requestResponses: Record<string, unknown>; fetchHandlers: Record<string, () => Response> }): {
    client: Parameters<typeof createGitvaultHttpTransport>[0];
    fetchCalls: string[];
  } {
    const fetchCalls: string[] = [];
    const client = {
      apiBase: "https://api.example.test",
      async request<T>(path: string): Promise<T> {
        if (!(path in opts.requestResponses)) throw new Error(`unexpected request: ${path}`);
        return opts.requestResponses[path] as T;
      },
      async fetch(input: string | URL | Request) {
        const url = String(input);
        fetchCalls.push(url);
        const handler = opts.fetchHandlers[url];
        if (!handler) throw new Error(`unexpected fetch: ${url}`);
        return handler();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return { client, fetchCalls };
  }

  it("getObject prefers the object-reads response's `edge_url` over its `url`", async () => {
    const path = gitvaultPaths.wal(WAL_ID);
    const { client, fetchCalls } = fakeClient({
      requestResponses: {
        [`/gitvault/v1/vaults/${REPO}/object-reads`]: {
          reads: [{ object_kind: "wal_pack", object_id: WAL_ID, url: "https://origin.example/wal", edge_url: "https://edge.example/wal", stored_bytes_sha256: "x", size_bytes: "1" }],
        },
      },
      fetchHandlers: {
        "https://edge.example/wal": () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
        "https://origin.example/wal": () => { throw new Error("must not fetch url when edge_url succeeds"); },
      },
    });
    const transport = createGitvaultHttpTransport(client);
    const bytes = await transport.getObject({ repo_id: REPO, path });
    assert.deepEqual([...bytes!], [1, 2, 3]);
    assert.deepEqual(fetchCalls, ["https://edge.example/wal"]);
  });

  it("getObject falls back to `url` when the response carries no `edge_url` — byte-identical to before this change", async () => {
    const path = gitvaultPaths.wal(WAL_ID);
    const { client, fetchCalls } = fakeClient({
      requestResponses: {
        [`/gitvault/v1/vaults/${REPO}/object-reads`]: {
          reads: [{ object_kind: "wal_pack", object_id: WAL_ID, url: "https://origin.example/wal", stored_bytes_sha256: "x", size_bytes: "1" }],
        },
      },
      fetchHandlers: {
        "https://origin.example/wal": () => new Response(new Uint8Array([4, 5]), { status: 200 }),
      },
    });
    const transport = createGitvaultHttpTransport(client);
    const bytes = await transport.getObject({ repo_id: REPO, path });
    assert.deepEqual([...bytes!], [4, 5]);
    assert.deepEqual(fetchCalls, ["https://origin.example/wal"]);
  });

  it("getObjects (batch) prefers each target's own `edge_url` independently", async () => {
    const walPath = gitvaultPaths.wal(WAL_ID);
    const refsPath = gitvaultPaths.refState(REFS_ID);
    const { client, fetchCalls } = fakeClient({
      requestResponses: {
        [`/gitvault/v1/vaults/${REPO}/object-reads`]: {
          reads: [
            { object_kind: "wal_pack", object_id: WAL_ID, url: "https://origin.example/wal", edge_url: "https://edge.example/wal", stored_bytes_sha256: "x", size_bytes: "1" },
            { object_kind: "ref_state", object_id: REFS_ID, url: "https://origin.example/refs", stored_bytes_sha256: "y", size_bytes: "1" },
          ],
        },
      },
      fetchHandlers: {
        "https://edge.example/wal": () => new Response(new Uint8Array([1]), { status: 200 }),
        "https://origin.example/refs": () => new Response(new Uint8Array([2]), { status: 200 }),
      },
    });
    const transport = createGitvaultHttpTransport(client);
    const [wal, refs] = await transport.getObjects({ repo_id: REPO, paths: [walPath, refsPath] });
    assert.deepEqual([...wal!], [1], "the entry WITH edge_url went to the edge");
    assert.deepEqual([...refs!], [2], "the entry with NO edge_url went straight to url");
    assert.deepEqual([...fetchCalls].sort(), ["https://edge.example/wal", "https://origin.example/refs"]);
  });

  it("getState prefers the presigned carrier's `edge_url` over its `presigned_url`", async () => {
    const { client, fetchCalls } = fakeClient({
      requestResponses: {
        [`/gitvault/v1/vaults/${REPO}/state`]: {
          vault: { repo_id: REPO, project_id: "prj_1", org_id: "org_1" },
          newest_generation: "0000000000000001",
          head: { stored_bytes: toBase64url(new Uint8Array([9])), stored_bytes_sha256: "h" },
          carriers: {
            ref_state: { presigned_url: "https://origin.example/ref_state", edge_url: "https://edge.example/ref_state", expires_at: "2026-08-29T00:00:00.000Z" },
            retention_roots: { inline: toBase64url(new Uint8Array([7])) },
          },
        },
      },
      fetchHandlers: {
        "https://edge.example/ref_state": () => new Response(new Uint8Array([3]), { status: 200 }),
        "https://origin.example/ref_state": () => { throw new Error("must not fetch presigned_url when edge_url succeeds"); },
      },
    });
    const transport = createGitvaultHttpTransport(client);
    const state = await transport.getState({ repo_id: REPO });
    assert.deepEqual([...state.carriers!.ref_state!], [3], "the presigned carrier arm preferred edge_url");
    assert.deepEqual([...state.carriers!.retention_roots!], [7], "the inline carrier arm is untouched by any of this");
    assert.deepEqual(fetchCalls, ["https://edge.example/ref_state"]);
  });

  it("getState carries `since` on the wire and decodes the delta — inline packs only, refs dropped (gitvault-delta-fetch)", async () => {
    const headBytes = new Uint8Array([9, 9]);
    const packBytes = new Uint8Array([1, 2, 3]);
    const { client } = fakeClient({
      requestResponses: {
        [`/gitvault/v1/vaults/${REPO}/state?since=0000000000000001`]: {
          vault: { repo_id: REPO, project_id: "prj_1", org_id: "org_1" },
          newest_generation: "0000000000000002",
          head: { stored_bytes: toBase64url(headBytes), stored_bytes_sha256: "h2" },
          carriers: { retention_roots: { inline: toBase64url(new Uint8Array([7])) }, ref_state: { inline: toBase64url(new Uint8Array([8])) } },
          delta: {
            heads: [{ generation: "0000000000000002", stored_bytes: toBase64url(headBytes), stored_bytes_sha256: "h2" }],
            packs: [
              { object_kind: "wal_pack", object_id: "wal_inline", inline: toBase64url(packBytes) },
              { object_kind: "wal_pack", object_id: "wal_ref", presigned_url: "https://origin.example/big", expires_at: "2026-08-31T00:00:00.000Z" },
            ],
          },
        },
      },
    });
    const transport = createGitvaultHttpTransport(client);
    const state = await transport.getState({ repo_id: REPO, since: "0000000000000001" });
    assert.ok(state.delta, "a delta-bearing response must surface `delta`");
    assert.deepEqual(state.delta!.heads.map((h) => h.generation), ["0000000000000002"]);
    assert.deepEqual([...state.delta!.heads[0]!.stored_bytes], [...headBytes]);
    assert.deepEqual(state.delta!.packs.map((pk) => pk.object_id), ["wal_inline"], "presigned delta refs are dropped — the ordinary fetch owns them");
    assert.deepEqual([...state.delta!.packs[0]!.bytes], [...packBytes]);
  });

  it("getState without `since` sends no query and tolerates a delta-less response — byte-identical to before this change", async () => {
    const { client } = fakeClient({
      requestResponses: {
        [`/gitvault/v1/vaults/${REPO}/state`]: {
          vault: { repo_id: REPO, project_id: "prj_1", org_id: "org_1" },
          newest_generation: "0000000000000001",
          head: { stored_bytes: toBase64url(new Uint8Array([9])), stored_bytes_sha256: "h" },
          carriers: { ref_state: { inline: toBase64url(new Uint8Array([8])) }, retention_roots: { inline: toBase64url(new Uint8Array([7])) } },
        },
      },
    });
    const transport = createGitvaultHttpTransport(client);
    const state = await transport.getState({ repo_id: REPO });
    assert.equal(state.delta, undefined, "no since, no delta");
  });

  it("getState falls back to `presigned_url` when the carrier has no `edge_url` — byte-identical to before this change", async () => {
    const { client, fetchCalls } = fakeClient({
      requestResponses: {
        [`/gitvault/v1/vaults/${REPO}/state`]: {
          vault: { repo_id: REPO, project_id: "prj_1", org_id: "org_1" },
          newest_generation: "0000000000000001",
          head: { stored_bytes: toBase64url(new Uint8Array([9])), stored_bytes_sha256: "h" },
          carriers: {
            ref_state: { presigned_url: "https://origin.example/ref_state", expires_at: "2026-08-29T00:00:00.000Z" },
            retention_roots: { inline: toBase64url(new Uint8Array([7])) },
          },
        },
      },
      fetchHandlers: {
        "https://origin.example/ref_state": () => new Response(new Uint8Array([3]), { status: 200 }),
      },
    });
    const transport = createGitvaultHttpTransport(client);
    const state = await transport.getState({ repo_id: REPO });
    assert.deepEqual([...state.carriers!.ref_state!], [3]);
    assert.deepEqual(fetchCalls, ["https://origin.example/ref_state"]);
  });
});
