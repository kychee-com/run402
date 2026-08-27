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

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createGitvaultHttpTransport, gitvaultLedgerId, gitvaultManifestEntry, gitvaultPaths, gitvaultWireRefForPath } from "./gitvault-publication.js";
import type { GitvaultUploadObject } from "./gitvault-publication.js";
import { checkActivationTokenBinding } from "./gitvault-deploy.js";
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
    // Regression guard for the exact live failure (confirmed 2026-08-27
    // against src_c78d2f710a8f49d22f9c66faf2a915cd): the gateway's
    // object-reads route still validates every null-idScalar kind against
    // key_envelope's `{epoch, recipient_fingerprint}` shape, so it 400s
    // "epoch must be 16 hex" on a genuinely protocol-correct
    // `{object_kind:"recipient_pin_manifest", pin_manifest_version}` read.
    // This IS the correct wire shape per protocol-v0.md's identity taxonomy
    // ("VERSION-ADDRESSED: ... recipient_pin_manifest by (repo_id,
    // pin_manifest_version)") and the gateway's own upload-side
    // `UPLOADABLE_KINDS.recipient_pin_manifest.pathFields` — a future "fix"
    // that reshapes this call to send epoch/recipient_fingerprint to
    // appease the buggy gateway would be the regression this test exists
    // to catch, not a fix. See GitvaultVault.readPinManifestObject's own
    // doc comment (gitvault-publication.ts) for the read-side gap this
    // maps to, and its local-cache workaround for a keystore reading back
    // a manifest it itself just published.
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
