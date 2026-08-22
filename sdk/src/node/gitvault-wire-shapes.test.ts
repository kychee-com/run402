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

import { gitvaultLedgerId, gitvaultManifestEntry, gitvaultPaths, gitvaultWireRefForPath } from "./gitvault-publication.js";
import type { GitvaultUploadObject } from "./gitvault-publication.js";

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
