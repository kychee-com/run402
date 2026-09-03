/**
 * gitvault epoch rotation — the client-half producer (D193-D203, rev 42,
 * change `gitvault-human-envelopes`). Two layers:
 *
 *  1. PURE decisive-vector behaviors (no I/O, no transport) — the exact
 *     witnesses the round-3 `/consult` review's own findings named:
 *     old-epoch-key reuse refusal (D195's producer obligation), the
 *     complementary-path mosaic (D195 — two attempts sampling DIFFERENT
 *     secrets must derive DIFFERENT `rotation_id`s), the H-partition
 *     bijection's exact/extra/missing-coverage rejections (D196's own
 *     finding-3 witness: one principal, two live fingerprints), and
 *     `epoch_key_commitment`'s per-recipient-only claim (D200).
 *  2. An END-TO-END producer round trip against the in-memory transport
 *     fixture (`gitvault-memory-transport.test.ts`): `rotateEpochForKeyRevocation`
 *     drives a real rotation, the self-check passes, the local keystore
 *     advances (both the "current" pointer AND `epoch_keys`), a SECOND
 *     principal's keystore can independently open the new envelope and
 *     reproduce `epoch_key_commitment`, and — the exact bug this fold's
 *     own `signHead` fix closes — an ORDINARY push immediately after the
 *     rotation succeeds instead of `CHAIN_BROKEN` forever.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attemptKeyCommitment,
  checkFreshEpochKeyAgainstPriorKeys,
  checkHPartition,
  checkPinManifestConservation,
  computeRotationId,
  computeTargetPartitionDigest,
  ekFingerprint,
  epochRotationKeyCommitment,
  generateEncryptionKeypair,
  generateSigningKeypair,
  nextEpoch,
  openKeyEnvelope,
  parseGitvaultStrict,
  parseRotateEpochPayload,
  randomBytes,
  signGitvaultObject,
  vkFingerprint,
} from "../namespaces/gitvault.crypto.js";
import type { GitvaultHead } from "../namespaces/gitvault.types.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { GitvaultMemoryTransport, commitFile, makeVault } from "./gitvault-memory-transport.test.js";
import { GitvaultVault, gitvaultPaths } from "./gitvault-publication.js";

describe("epoch rotation — pure decisive vectors (D193-D203)", () => {
  it("nextEpoch increments by exactly one, no skip (D194 chain-link rule)", () => {
    assert.equal(nextEpoch("0000000000000001"), "0000000000000002");
    assert.equal(nextEpoch("00000000000000ff"), "0000000000000100");
    assert.equal(nextEpoch("ffffffffffffffff"), "10000000000000000"); // overflow is representable; the schema's hex16 bound would reject it upstream, not this pure function
  });

  it("D195 producer obligation: a freshly sampled K_e equal to a PRIOR epoch key is refused before anything is sealed", () => {
    const prior1 = randomBytes(32);
    const prior2 = randomBytes(32);
    // A genuinely fresh key passes.
    assert.doesNotThrow(() => checkFreshEpochKeyAgainstPriorKeys(randomBytes(32), [prior1, prior2]));
    // A reused key — the exact failure mode a broken CSPRNG or an accidental
    // seed reuse would produce — is refused, never silently sealed under it.
    assert.throws(() => checkFreshEpochKeyAgainstPriorKeys(prior1, [prior1, prior2]), (e: unknown) => (e as { code?: string }).code === "GITVAULT_EPOCH_KEY_NOT_FRESH");
    assert.throws(() => checkFreshEpochKeyAgainstPriorKeys(prior2, [prior1, prior2]), (e: unknown) => (e as { code?: string }).code === "GITVAULT_EPOCH_KEY_NOT_FRESH");
  });

  it("D195 complementary-path mosaic: two attempts sampling DIFFERENT K_e derive DIFFERENT rotation_id, even with every OTHER field identical", () => {
    const writer = generateSigningKeypair();
    const baseFields = {
      format: "r402s/v0" as const, object_kind: "rotation_attempt_descriptor" as const, suite: "r402s-1" as const,
      repo_id: "src_" + "00".repeat(16), base_head_sha256: "aa".repeat(32), new_epoch: "0000000000000002",
      recipient_state_version: "3", recipient_revocation_version: "1", pin_manifest_sha256: "bb".repeat(32),
      target_partition_digest: "cc".repeat(32), client_idempotency_key: "dd".repeat(16), writer_key_id: vkFingerprint(writer.public_key),
    };
    const kE1 = randomBytes(32);
    const kE2 = randomBytes(32);
    assert.notEqual(Buffer.from(kE1).toString("hex"), Buffer.from(kE2).toString("hex"));
    const commitment1 = attemptKeyCommitment(kE1, baseFields.repo_id, baseFields.new_epoch, baseFields);
    const commitment2 = attemptKeyCommitment(kE2, baseFields.repo_id, baseFields.new_epoch, baseFields);
    assert.notEqual(commitment1, commitment2, "attempt_key_commitment must differ when K_e differs, with every declared field identical");
    const descriptor1 = signGitvaultObject({ ...baseFields, attempt_key_commitment: commitment1 }, writer.seed);
    const descriptor2 = signGitvaultObject({ ...baseFields, attempt_key_commitment: commitment2 }, writer.seed);
    const id1 = computeRotationId(descriptor1);
    const id2 = computeRotationId(descriptor2);
    assert.notEqual(id1, id2, "rotation_id must differ — the create-only CAS at rotation-attempts/<rotation_id>.json therefore cannot collide, closing the mosaic BEFORE any envelope write (D195)");
  });

  it("D195: a byte-identical resume of one's OWN prior attempt derives the SAME rotation_id", () => {
    const writer = generateSigningKeypair();
    const fields = {
      format: "r402s/v0" as const, object_kind: "rotation_attempt_descriptor" as const, suite: "r402s-1" as const,
      repo_id: "src_" + "11".repeat(16), base_head_sha256: "ee".repeat(32), new_epoch: "0000000000000002",
      recipient_state_version: "0", recipient_revocation_version: "0", pin_manifest_sha256: "0".repeat(64),
      target_partition_digest: "ff".repeat(32), client_idempotency_key: "22".repeat(16), writer_key_id: vkFingerprint(writer.public_key),
    };
    const kE = randomBytes(32);
    const commitment = attemptKeyCommitment(kE, fields.repo_id, fields.new_epoch, fields);
    const descriptorA = signGitvaultObject({ ...fields, attempt_key_commitment: commitment }, writer.seed);
    const descriptorB = signGitvaultObject({ ...fields, attempt_key_commitment: commitment }, writer.seed);
    assert.equal(computeRotationId(descriptorA), computeRotationId(descriptorB));
  });

  it("D200: epoch_key_commitment is a PER-RECIPIENT self-check only — a wrong fingerprint SET changes the commitment (proves it is not order-independent noise), but a matching recompute never claims anything about ANOTHER recipient's envelope", () => {
    const kE = randomBytes(32);
    const repoId = "src_" + "33".repeat(16);
    const epoch = "0000000000000002";
    const rotationId = "44".repeat(32);
    const c1 = epochRotationKeyCommitment(kE, repoId, epoch, rotationId, ["ek_" + "aa".repeat(16), "ek_" + "bb".repeat(16)]);
    const c2 = epochRotationKeyCommitment(kE, repoId, epoch, rotationId, ["ek_" + "aa".repeat(16), "ek_" + "bb".repeat(16)]);
    assert.equal(c1, c2, "deterministic over the same inputs — sorted, so caller-side ordering cannot introduce drift");
    const c3 = epochRotationKeyCommitment(kE, repoId, epoch, rotationId, ["ek_" + "aa".repeat(16), "ek_" + "bb".repeat(16)].reverse());
    assert.equal(c1, c3, "sorted internally — insertion order of the fingerprint list must not matter");
    const differentSet = epochRotationKeyCommitment(kE, repoId, epoch, rotationId, ["ek_" + "aa".repeat(16)]);
    assert.notEqual(c1, differentSet, "a different included-fingerprint SET changes the commitment");
  });

  it("D196 H-partition: the round-3 review's own finding-3 witness — one principal with TWO live fingerprints (one pinned+confirmed, one an unmapped extra) is REFUSED, not silently admitted", () => {
    const desiredPrincipalIds = new Set(["p1"]);
    const keyedPrincipalIds = new Set(["p1"]);
    const pinnedFingerprintOf = new Map([["p1", "ek_" + "aa".repeat(16)]]);
    // The witness: TWO pairs both naming p1 (one with the pinned fingerprint,
    // one with a second, unmapped fingerprint) — principal appears twice in
    // the partition, which the exactness check catches directly.
    const verdict = checkHPartition({
      desiredPrincipalIds, keyedPrincipalIds, pinnedFingerprintOf,
      included: [{ principal_id: "p1", ek_fingerprint: "ek_" + "aa".repeat(16) }, { principal_id: "p1", ek_fingerprint: "ek_" + "bb".repeat(16) }],
      excludedKeylessPrincipalIds: [], excludedUnconfirmedPrincipalIds: [],
    });
    assert.equal(verdict.ok, false);
  });

  it("D196 H-partition: exact coverage (included ⊎ excluded_keyless ⊎ excluded_unconfirmed == H) is accepted", () => {
    const verdict = checkHPartition({
      desiredPrincipalIds: new Set(["p1", "p2", "p3"]),
      keyedPrincipalIds: new Set(["p1", "p2"]),
      pinnedFingerprintOf: new Map([["p1", "ek_" + "aa".repeat(16)]]),
      included: [{ principal_id: "p1", ek_fingerprint: "ek_" + "aa".repeat(16) }],
      excludedKeylessPrincipalIds: ["p3"],
      excludedUnconfirmedPrincipalIds: ["p2"],
    });
    assert.deepEqual(verdict, { ok: true });
  });

  it("D196 H-partition: a principal missing from EVERY bucket is refused (partition does not cover H)", () => {
    const verdict = checkHPartition({
      desiredPrincipalIds: new Set(["p1", "p2"]),
      keyedPrincipalIds: new Set(["p1", "p2"]),
      pinnedFingerprintOf: new Map([["p1", "ek_" + "aa".repeat(16)], ["p2", "ek_" + "bb".repeat(16)]]),
      included: [{ principal_id: "p1", ek_fingerprint: "ek_" + "aa".repeat(16) }], // p2 named nowhere
      excludedKeylessPrincipalIds: [], excludedUnconfirmedPrincipalIds: [],
    });
    assert.equal(verdict.ok, false);
  });

  it("D196 H-partition: an included principal's envelope fingerprint must equal the PINNED one, not merely 'a' fingerprint they hold", () => {
    const verdict = checkHPartition({
      desiredPrincipalIds: new Set(["p1"]), keyedPrincipalIds: new Set(["p1"]),
      pinnedFingerprintOf: new Map([["p1", "ek_" + "aa".repeat(16)]]),
      included: [{ principal_id: "p1", ek_fingerprint: "ek_" + "cc".repeat(16) }], // wrong fingerprint
      excludedKeylessPrincipalIds: [], excludedUnconfirmedPrincipalIds: [],
    });
    assert.equal(verdict.ok, false);
  });

  it("D196: target_partition_digest is deterministic and order-independent over included/excluded arrays", () => {
    const base = {
      recipient_state_version: "5", recipient_revocation_version: "2", pin_manifest_version: "0000000000000003", pin_manifest_sha256: "aa".repeat(32),
      included: [{ principal_id: "p2", ek_fingerprint: "ek_" + "bb".repeat(16) }, { principal_id: "p1", ek_fingerprint: "ek_" + "aa".repeat(16) }],
      excluded_keyless_principal_ids: ["p4", "p3"], excluded_unconfirmed_principal_ids: ["p6", "p5"],
    };
    const reordered = { ...base, included: [...base.included].reverse(), excluded_keyless_principal_ids: [...base.excluded_keyless_principal_ids].reverse(), excluded_unconfirmed_principal_ids: [...base.excluded_unconfirmed_principal_ids].reverse() };
    assert.equal(computeTargetPartitionDigest(base), computeTargetPartitionDigest(reordered));
    const changed = { ...base, recipient_revocation_version: "3" };
    assert.notEqual(computeTargetPartitionDigest(base), computeTargetPartitionDigest(changed));
  });

  it("D197 pin-manifest conservation: deletion by omission is refused; a receipted change/addition is accepted", () => {
    const prior = [{ principal_id: "p1" }, { principal_id: "p2" }];
    assert.equal(checkPinManifestConservation(prior, [{ principal_id: "p1" }]).ok, false, "p2 silently dropped");
    assert.equal(checkPinManifestConservation(prior, [{ principal_id: "p1" }, { principal_id: "p2" }, { principal_id: "p3" }]).ok, true, "addition, nothing dropped");
    assert.equal(checkPinManifestConservation(prior, [{ principal_id: "p1" }, { principal_id: "p1" }]).ok, false, "duplicate entry, and p2 dropped");
  });
});

/**
 * Bootstrap a principal's pin (D197): `/confirm` (first-seen) then publish
 * the receipted entry via an ordinary head. NEEDED before ANY rotation can
 * validly include a principal — this SDK's genesis stays single-envelope
 * (D198 N-recipient genesis is out of this change's scope), so it never
 * embeds an initial `pin_manifest`; even the vault's OWN CREATOR has no
 * live pin until one is bootstrapped this way. This is protocol-correct,
 * not a test workaround: it is exactly the "an owner runs N confirmation
 * ceremonies" story D198/D197 describe for any vault whose founding
 * evidence trail is incomplete — which, for every vault this SDK creates,
 * is every vault, until this bootstrap runs once.
 */
async function bootstrapPin(vault: GitvaultVault, principalId: string, ekFp: string): Promise<void> {
  const receipt = await vault.transport.confirmRecipient({ repo_id: vault.repoId, principal_id: principalId, new_fingerprint: ekFp });
  await vault.publishPinManifestUpdate({ principal_id: principalId, ek_fingerprint: ekFp, confirmed_by: "operator_confirmation", receipt });
}

describe("epoch rotation — producer end-to-end (rotateEpochForKeyRevocation)", () => {
  it("drives a real rotation, self-checks its own envelope, advances the local keystore, and an ordinary push immediately after succeeds (the signHead epoch fix)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-rotate-"));
    try {
      const { transport, vault, repoDir } = await makeVault(dir);
      const orgId = (await vault.transport.getVaultRecord({ repo_id: vault.repoId })).org_id;

      // Push once ordinarily first, at epoch 1 — proves the pre-rotation path is untouched.
      const c1 = await commitFile(repoDir, "a.txt", "a\n");
      const materialized1 = await vault.materialize();
      const push1 = await vault.push({ transaction: { updates: [{ ref: "refs/heads/main", new_oid: c1, expected_old_oid: null, force: false }] }, head_target: materialized1.head_target });
      assert.equal(push1.generation, "0000000000000001");

      // Configure the org's desired-recipient state: the vault's OWN creator
      // principal (recipient_key_revoked is org-scoped and does not require
      // a second principal to exercise the full producer path end-to-end).
      const identity = vault.keystore.ensureIdentity();
      const ownEk = ekFingerprint((vault.keystore.encryptionKeypair(identity)!).public_key);
      transport.desiredRecipients.set(orgId, [
        { principal_id: "principal_1", display_name: "Creator", status: "active", ek_fingerprint: ownEk, public_key: Buffer.from((vault.keystore.encryptionKeypair(identity)!).public_key).toString("base64url"), suite: "r402s-1", covered: false },
      ]);
      await bootstrapPin(vault, "principal_1", ownEk);

      const result = await vault.rotateEpochForKeyRevocation("principal_1");
      assert.equal(result.outcome, "admitted");
      assert.equal(result.new_epoch, "0000000000000002");
      assert.equal(result.reason, "recipient_key_revoked");
      assert.equal(result.self_check, "passed", "the creator's own principal is the sole desired recipient, so the self-check must run and pass");
      assert.equal(result.included.length, 1);
      assert.equal(result.included[0]!.principal_id, "principal_1");

      // The local keystore advanced: current epoch/key AND the historical map.
      const repoFile = vault.keystore.readRepo(vault.repoId)!;
      assert.equal(repoFile.epoch, "0000000000000002");
      assert.ok(repoFile.epoch_keys?.["0000000000000001"], "the OLD epoch's key stays retained for historical decrypt");
      assert.ok(repoFile.epoch_keys?.["0000000000000002"], "the NEW epoch's key is recorded");
      assert.notEqual(repoFile.epoch_keys!["0000000000000001"], repoFile.epoch_keys!["0000000000000002"]);

      // The exact bug this fold's signHead fix closes: an ORDINARY push
      // immediately after a rotation must succeed, not CHAIN_BROKEN forever.
      const c2 = await commitFile(repoDir, "b.txt", "b\n");
      const materialized2 = await vault.materialize();
      const push2 = await vault.push({ transaction: { updates: [{ ref: "refs/heads/main", new_oid: c2, expected_old_oid: c1, force: false }] }, head_target: materialized2.head_target });
      assert.equal(push2.head.epoch, "0000000000000002", "the ordinary post-rotation head claims the CURRENT epoch, not the genesis constant");

      // A fresh open of the SAME vault (this principal's own keystore) can
      // still materialize the post-rotation tip — the current epoch/key the
      // keystore now holds is exactly what decrypting the tip's ref_state needs.
      const reopened = GitvaultVault.open({ keystore: vault.keystore, transport, repo_id: vault.repoId, repo_dir: repoDir });
      const remat = await reopened.materialize();
      assert.equal(remat.generation, push2.generation);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Local pin-manifest cache (`GitvaultRepoFile.known_pin_manifest`):
   * `loadEffectivePinManifest` re-reads the predecessor manifest on EVERY
   * `rotateEpoch` once ANY manifest has ever been admitted, and a manifest
   * this keystore itself just built+admitted needs no re-fetch of its OWN
   * bytes — the cache saves that round trip. (It originally also routed
   * around a since-fixed gateway bug that 400'd every
   * `recipient_pin_manifest` object-read; the request shape stays pinned in
   * `gitvault-wire-shapes.test.ts`.) This test pins BOTH halves — the cache
   * hit skips the network call, and a cache MISS still falls through to it
   * unchanged (never a blanket bypass of verification for a manifest this
   * keystore did not author).
   */
  it("local pin-manifest cache: a manifest this keystore just published is read back locally (no network round trip); a cache miss still falls through to the network path unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-rotate-cache-"));
    try {
      const { transport, vault, repoDir } = await makeVault(dir);
      const orgId = (await vault.transport.getVaultRecord({ repo_id: vault.repoId })).org_id;
      const identity = vault.keystore.ensureIdentity();
      const ownEk = ekFingerprint((vault.keystore.encryptionKeypair(identity)!).public_key);
      transport.desiredRecipients.set(orgId, [
        { principal_id: "principal_1", display_name: "Creator", status: "active", ek_fingerprint: ownEk, public_key: Buffer.from((vault.keystore.encryptionKeypair(identity)!).public_key).toString("base64url"), suite: "r402s-1", covered: false },
      ]);
      await bootstrapPin(vault, "principal_1", ownEk);

      const cached = vault.keystore.readRepo(vault.repoId)!.known_pin_manifest;
      assert.ok(cached, "publishPinManifestUpdate caches the manifest it just admitted");
      assert.equal(cached!.pin_manifest_version, "0000000000000001");
      assert.deepEqual(cached!.pins, [{ principal_id: "principal_1", ek_fingerprint: ownEk }]);

      // A fresh open of the SAME keystore/repo — the realistic shape of the
      // exact ceremony this fixes (confirm/publish and rotate as separate
      // CLI invocations, each a brand-new GitvaultVault instance sharing
      // one on-disk keystore, per Gitvault.open()'s "new instance per call"
      // contract).
      const reopened = GitvaultVault.open({ keystore: vault.keystore, transport, repo_id: vault.repoId, repo_dir: repoDir });
      const callsBeforeRotate = transport.calls.length;
      const rotated = await reopened.rotateEpochForKeyRevocation("principal_1");
      assert.equal(rotated.outcome, "admitted");
      assert.equal(rotated.included.length, 1);
      assert.equal(rotated.included[0]!.principal_id, "principal_1", "the predecessor manifest's pin resolved correctly from the cache — the principal is confirmed and included");
      const pinManifestReadsAfterCacheHit = transport.calls.slice(callsBeforeRotate).filter((c) => c.startsWith("get:recipient-pins/"));
      assert.deepEqual(pinManifestReadsAfterCacheHit, [], "the cache hit skipped the network object-reads round trip entirely");

      // Clear the cache (simulating a keystore that did not itself author
      // this manifest — a genuinely different machine/principal, or an
      // older SDK version's local file with no known_pin_manifest field at
      // all) and confirm the read still falls through to the network path,
      // unchanged, rather than silently trusting nothing or crashing.
      vault.keystore.updateRepo(vault.repoId, { known_pin_manifest: null });
      const callsBeforeSecondRotate = transport.calls.length;
      const rotatedAgain = await vault.rotateEpochForKeyRevocation("principal_1");
      assert.equal(rotatedAgain.outcome, "admitted");
      const pinManifestReadsAfterCacheMiss = transport.calls.slice(callsBeforeSecondRotate).filter((c) => c.startsWith("get:recipient-pins/"));
      assert.deepEqual(pinManifestReadsAfterCacheMiss, [`get:${gitvaultPaths.pinManifest("0000000000000001")}`], "a cache miss falls through to the SAME network object-reads read the pre-fix code always made");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("EPOCH_ROTATION_REQUIRED blocks an ordinary push while a migration condition is outstanding, and a rotation clears it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-rotate-migrate-"));
    try {
      const { transport, vault, repoDir } = await makeVault(dir);

      // Bootstrap the creator's pin FIRST, while the vault is healthy — a
      // pin-manifest-only publish is an ORDINARY head (transition: null),
      // so it is ITSELF blocked once migration_required is set (a single
      // head CAN legally carry both a rotate_epoch transition AND a
      // pin_manifest update together, D197/D198's general "any head" rule —
      // this producer does not build that COMBINED form yet, a documented
      // residual; this test exercises the more common case of a vault that
      // already has pins, later needing a migration rotation).
      const orgId = (await vault.transport.getVaultRecord({ repo_id: vault.repoId })).org_id;
      const identity = vault.keystore.ensureIdentity();
      const ownEk = ekFingerprint((vault.keystore.encryptionKeypair(identity)!).public_key);
      transport.desiredRecipients.set(orgId, [
        { principal_id: "principal_1", display_name: "Creator", status: "active", ek_fingerprint: ownEk, public_key: Buffer.from((vault.keystore.encryptionKeypair(identity)!).public_key).toString("base64url"), suite: "r402s-1", covered: false },
      ]);
      await bootstrapPin(vault, "principal_1", ownEk);

      transport.migrationRotationRequired.set(vault.repoId, true);
      const c1 = await commitFile(repoDir, "a.txt", "a\n");
      const materialized = await vault.materialize();
      await assert.rejects(
        vault.push({ transaction: { updates: [{ ref: "refs/heads/main", new_oid: c1, expected_old_oid: null, force: false }] }, head_target: materialized.head_target }),
        (e: unknown) => (e as { code?: string }).code === "EPOCH_ROTATION_REQUIRED",
      );

      const rotated = await vault.rotateEpoch({ reason: "elective_rekey", recipient_state_version: "0", recipient_revocation_version: "0" });
      assert.equal(rotated.outcome, "admitted");
      assert.equal(rotated.included.length, 1);

      // The flag is cleared — an ordinary push now succeeds. `refs/heads/main`
      // was never actually created (the earlier attempt refused BEFORE any
      // ref update landed), so this is still the creation form.
      const materialized2 = await vault.materialize();
      const push = await vault.push({ transaction: { updates: [{ ref: "refs/heads/main", new_oid: c1, expected_old_oid: null, force: false }] }, head_target: materialized2.head_target });
      assert.equal(push.head.epoch, rotated.new_epoch);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("elective_rekey refuses locally (never round-trips) when coverage is a proper subset — a keyless desired principal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-rotate-elective-"));
    try {
      const { transport, vault } = await makeVault(dir);
      const orgId = (await vault.transport.getVaultRecord({ repo_id: vault.repoId })).org_id;
      transport.desiredRecipients.set(orgId, [
        { principal_id: "principal_1", display_name: "Creator", status: "active", ek_fingerprint: null, public_key: null, suite: null, covered: false },
      ]);
      await assert.rejects(
        vault.rotateEpoch({ reason: "elective_rekey", recipient_state_version: "0", recipient_revocation_version: "0" }),
        (e: unknown) => (e as { code?: string }).code === "EPOCH_ROTATION_INCOMPLETE_ENROLLMENT",
      );
      assert.equal(transport.calls.filter((c) => c.startsWith("rotation-attempt")).length, 0, "refused BEFORE ever submitting a rotation-attempt descriptor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a pending_removal principal is excluded from H entirely — never wrapped into the new epoch (the forward-revocation point of member_removed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-rotate-removal-"));
    try {
      const { transport, vault } = await makeVault(dir);
      const orgId = (await vault.transport.getVaultRecord({ repo_id: vault.repoId })).org_id;
      const identity = vault.keystore.ensureIdentity();
      const ownEk = ekFingerprint((vault.keystore.encryptionKeypair(identity)!).public_key);
      const outsider = generateEncryptionKeypair();
      transport.desiredRecipients.set(orgId, [
        { principal_id: "principal_1", display_name: "Creator", status: "active", ek_fingerprint: ownEk, public_key: Buffer.from((vault.keystore.encryptionKeypair(identity)!).public_key).toString("base64url"), suite: "r402s-1", covered: false },
        { principal_id: "principal_removed", display_name: "Removed", status: "pending_removal", ek_fingerprint: ekFingerprint(outsider.public_key), public_key: Buffer.from(outsider.public_key).toString("base64url"), suite: "r402s-1", covered: true },
      ]);
      await bootstrapPin(vault, "principal_1", ownEk);
      const result = await vault.rotateEpochForKeyRevocation("principal_removed");
      assert.equal(result.included.length, 1);
      assert.equal(result.included[0]!.principal_id, "principal_1");
      assert.equal(result.excluded_keyless_principal_ids.length, 0);
      assert.equal(result.excluded_unconfirmed_principal_ids.length, 0, "pending_removal is excluded from H entirely — not even named in an exclusion array");

      // The removed principal's own keypair CANNOT open the new epoch's envelope.
      const envelopeBytes = await transport.getObject({ repo_id: vault.repoId, path: `envelopes/${result.new_epoch}/${result.rotation_id}/${ekFingerprint(outsider.public_key)}` });
      assert.equal(envelopeBytes, null, "no envelope was ever sealed to the removed principal at the new epoch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The exact ceremony deadlock reproduced live in production 2026-08-27
   * (vault `src_7f7933b3…`, its first-ever `epoch_secret_exposed` rekey):
   * `declareEpochSecretExposed` gates every ordinary admission
   * (`EPOCH_ROTATION_REQUIRED`) — including a pin-manifest-only publish,
   * since that publish carries `transition: null` and is therefore an
   * ORDINARY admission by the exact same rule. `/confirm` minted a receipt
   * server-side (it is `gitvault.rotate`-gated, never touches the ordinary-
   * push admission path), but `publishPinManifestUpdate` for that receipt
   * was itself stuck behind the gate it was needed to help clear.
   *
   * The fix: fold the receipt into `rotateEpoch`'s `pending_confirmations`
   * so it rides the SAME head as the `rotate_epoch` transition — which IS
   * `EPOCH_ROTATION_REQUIRED`'s own escape valve (the flag can only ever
   * clear via a rotation admission, so a rotation admission cannot itself
   * be refused by that same flag). D196 is honored throughout: the folded
   * principal is NOT counted toward THIS rotation's H-partition (still
   * `excluded_unconfirmed`, exactly as it would be without folding) — only
   * the ALREADY-predecessor-confirmed creator is `included`. What changes
   * is that the manifest becomes durably admitted in the SAME atomic
   * submission, unblocking every subsequent ordinary admission (no second,
   * separately-gated publish needed) and making the folded principal
   * eligible starting at the very NEXT rotation.
   */
  it("D196/D197 fold: rotateEpoch's pending_confirmations durably publishes a receipted pin-manifest update on the SAME head as the rotation, closing the standalone publishPinManifestUpdate deadlock while an urgent condition is outstanding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-rotate-fold-"));
    try {
      const { transport, vault, repoDir } = await makeVault(dir);
      const orgId = (await vault.transport.getVaultRecord({ repo_id: vault.repoId })).org_id;
      const identity = vault.keystore.ensureIdentity();
      const ownEk = ekFingerprint((vault.keystore.encryptionKeypair(identity)!).public_key);
      const p2 = generateEncryptionKeypair();
      const p2Ek = ekFingerprint(p2.public_key);
      transport.desiredRecipients.set(orgId, [
        { principal_id: "principal_1", display_name: "Creator", status: "active", ek_fingerprint: ownEk, public_key: Buffer.from((vault.keystore.encryptionKeypair(identity)!).public_key).toString("base64url"), suite: "r402s-1", covered: false },
        { principal_id: "principal_2", display_name: "Directory member", status: "active", ek_fingerprint: p2Ek, public_key: Buffer.from(p2.public_key).toString("base64url"), suite: "r402s-1", covered: false },
      ]);

      // The creator's pin was bootstrapped BEFORE the incident, while the
      // vault was healthy — the SAME "documented residual" scenario the
      // migration test above already exercises (a vault that already has
      // ONE confirmed principal, later needing an urgent rotation while a
      // SECOND, not-yet-confirmed directory principal is pending).
      await bootstrapPin(vault, "principal_1", ownEk);

      // The incident: this vault's own epoch secret is declared exposed.
      await vault.transport.declareEpochSecretExposed({ repo_id: vault.repoId });

      // The confirmation ceremony for principal_2 already succeeded
      // server-side (owner + step-up; does not touch the ordinary-push gate).
      const receipt2 = await vault.transport.confirmRecipient({ repo_id: vault.repoId, principal_id: "principal_2", new_fingerprint: p2Ek });

      // The pre-fix deadlock — a STANDALONE publish of this SAME receipt
      // is itself refused `EPOCH_ROTATION_REQUIRED` while exposure is
      // outstanding — is pinned as its OWN negative test below (a fresh
      // vault instance: a failed `publishPinManifestUpdate` attempt still
      // uploads manifest bytes for that version before admission is
      // attempted, so replaying it here first would collide with THIS
      // test's own fold attempt at the identical `pin_manifest_version`).

      // THE FIX: fold the SAME receipt into the required rotation.
      const rotated = await vault.rotateEpoch({
        reason: "epoch_secret_exposed", recipient_state_version: "0", recipient_revocation_version: "0",
        pending_confirmations: [{ principal_id: "principal_2", ek_fingerprint: p2Ek, receipt: receipt2 }],
      });
      assert.equal(rotated.outcome, "admitted");
      assert.equal(rotated.included.length, 1, "only the already-predecessor-confirmed creator is included in THIS rotation");
      assert.equal(rotated.included[0]!.principal_id, "principal_1");
      // D196: folding does NOT self-authorize principal_2 for THIS rotation.
      assert.deepEqual(rotated.excluded_unconfirmed_principal_ids, ["principal_2"]);
      assert.ok(rotated.pin_manifest_published, "the receipted update WAS durably published on this same head");
      assert.deepEqual(rotated.pin_manifest_published!.principal_ids, ["principal_2"]);
      assert.equal(rotated.pin_manifest_published!.pin_manifest_version, "0000000000000002", "version 2 — principal_1's bootstrap publish was version 1");

      // The manifest is now the admitted predecessor: an ORDINARY push
      // succeeds with no separate publish call — the flag cleared.
      const c1 = await commitFile(repoDir, "a.txt", "a\n");
      const materialized = await vault.materialize();
      const push = await vault.push({ transaction: { updates: [{ ref: "refs/heads/main", new_oid: c1, expected_old_oid: null, force: false }] }, head_target: materialized.head_target });
      assert.equal(push.head.epoch, rotated.new_epoch);

      // AND: principal_2 is now confirmed for the NEXT rotation — the
      // deadlock is fully closed, not merely deferred.
      const rotated2 = await vault.rotateEpoch({ reason: "elective_rekey", recipient_state_version: "0", recipient_revocation_version: "0" });
      assert.equal(rotated2.outcome, "admitted");
      assert.equal(rotated2.included.length, 2);
      assert.ok(rotated2.included.some((p) => p.principal_id === "principal_2"));
      assert.equal(rotated2.excluded_unconfirmed_principal_ids.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PRE-FIX negative, pinned: a STANDALONE publishPinManifestUpdate for a receipt minted while an urgent condition is outstanding is refused EPOCH_ROTATION_REQUIRED — the deadlock the previous test's fold closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-rotate-fold-negative-"));
    try {
      const { transport, vault } = await makeVault(dir);
      const orgId = (await vault.transport.getVaultRecord({ repo_id: vault.repoId })).org_id;
      const identity = vault.keystore.ensureIdentity();
      const ownEk = ekFingerprint((vault.keystore.encryptionKeypair(identity)!).public_key);
      const p2 = generateEncryptionKeypair();
      const p2Ek = ekFingerprint(p2.public_key);
      transport.desiredRecipients.set(orgId, [
        { principal_id: "principal_1", display_name: "Creator", status: "active", ek_fingerprint: ownEk, public_key: Buffer.from((vault.keystore.encryptionKeypair(identity)!).public_key).toString("base64url"), suite: "r402s-1", covered: false },
        { principal_id: "principal_2", display_name: "Directory member", status: "active", ek_fingerprint: p2Ek, public_key: Buffer.from(p2.public_key).toString("base64url"), suite: "r402s-1", covered: false },
      ]);
      await bootstrapPin(vault, "principal_1", ownEk);
      await vault.transport.declareEpochSecretExposed({ repo_id: vault.repoId });
      const receipt2 = await vault.transport.confirmRecipient({ repo_id: vault.repoId, principal_id: "principal_2", new_fingerprint: p2Ek });

      // publishPinManifestUpdate carries `transition: null` — an ORDINARY
      // admission, refused by the SAME D193 gate as any other ordinary push
      // for as long as exposure stays outstanding. This is the exact
      // deadlock reproduced live in production 2026-08-27: the receipt
      // exists, but nothing can admit it standalone.
      await assert.rejects(
        vault.publishPinManifestUpdate({ principal_id: "principal_2", ek_fingerprint: p2Ek, confirmed_by: "operator_confirmation", receipt: receipt2 }),
        (e: unknown) => (e as { code?: string }).code === "EPOCH_ROTATION_REQUIRED",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Read back an admitted `rotate_epoch` head's own transition payload — the exact bytes that were signed and submitted. */
async function readAdmittedRotatePayload(transport: GitvaultMemoryTransport, repoId: string, generation: string) {
  const bytes = await transport.getObject({ repo_id: repoId, path: gitvaultPaths.head(generation) });
  assert.ok(bytes, `head ${generation} must be stored`);
  const head = parseGitvaultStrict(new TextDecoder().decode(bytes)) as GitvaultHead;
  return parseRotateEpochPayload(head);
}

/**
 * D209 (rev 44) — the round-5 closing brief's named client follow-up: every
 * `rotate_epoch` this SDK submits carries `self_open_attestation`, computed
 * by round-tripping THIS principal's own new-epoch `key_envelope` through
 * the REAL reader entry point (`openEpochRotationForRecipient`) BEFORE
 * submission — never a bare post-commit check reproducing the same logic by
 * hand. A rev-44 gateway refuses `EPOCH_ROTATION_SELF_OPEN_UNPROVEN` on any
 * admission missing this or whose claim disagrees with the server's own
 * writer-in-envelopes biconditional; these tests pin the CLIENT half —
 * exactly what gets baked into the signed payload before it ever reaches
 * the wire.
 */
describe("epoch rotation — D209 self_open_attestation (rev 44)", () => {
  it("'opened' branch: the writer is itself an included recipient — the admitted payload's self_open_attestation names its own fingerprint, the predecessor generation, and the admitted head's own generation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-self-open-opened-"));
    try {
      const { transport, vault } = await makeVault(dir);
      const orgId = (await vault.transport.getVaultRecord({ repo_id: vault.repoId })).org_id;
      const identity = vault.keystore.ensureIdentity();
      const ownEk = ekFingerprint((vault.keystore.encryptionKeypair(identity)!).public_key);
      transport.desiredRecipients.set(orgId, [
        { principal_id: "principal_1", display_name: "Creator", status: "active", ek_fingerprint: ownEk, public_key: Buffer.from((vault.keystore.encryptionKeypair(identity)!).public_key).toString("base64url"), suite: "r402s-1", covered: false },
      ]);
      await bootstrapPin(vault, "principal_1", ownEk);

      const result = await vault.rotateEpochForKeyRevocation("principal_1");
      assert.equal(result.outcome, "admitted");
      assert.equal(result.self_check, "passed");

      const payload = await readAdmittedRotatePayload(transport, vault.repoId, result.generation);
      assert.ok(payload.self_open_attestation, "self_open_attestation must ride the admitted payload — a rev-44 gateway refuses its absence");
      const attestation = payload.self_open_attestation!;
      assert.equal(attestation.outcome, "opened");
      assert.equal(attestation.chain_verified_to_generation, "0000000000000001", "the PREDECESSOR generation — this is generation 2's rotation, predecessor is 1");
      assert.equal(attestation.decryptable_to_generation, result.generation, "the admitted head's OWN generation");
      assert.equal(attestation.opened_fingerprint, ownEk, "this principal's own included pair's recipient_fingerprint");
      assert.ok(attestation.reader_entrypoint, "audit provenance must be present on the 'opened' branch");
      assert.match(attestation.reader_entrypoint!, /^run402@.+\/openEpochRotationForRecipient$/, "names the REAL reader entry point (D209's own named fix — not openKeyEnvelope, not a synthesized string)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("'writer_not_recipient' branch: the writer holds no included envelope — attestation carries ONLY outcome + chain_verified_to_generation, no opened_fingerprint/decryptable_to_generation/reader_entrypoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-self-open-writer-not-recipient-"));
    try {
      const { transport, vault } = await makeVault(dir);
      const orgId = (await vault.transport.getVaultRecord({ repo_id: vault.repoId })).org_id;
      // The desired-recipient set names ONLY a principal whose encryption
      // keypair is NOT the vault's own writer identity — the normal agent/
      // CI-writer shape (D1 of services/gitvault/desired-recipients.ts:
      // "agents hold their own vault keys in their CLI keystore").
      const other = generateEncryptionKeypair();
      const otherEk = ekFingerprint(other.public_key);
      transport.desiredRecipients.set(orgId, [
        { principal_id: "principal_other", display_name: "Other", status: "active", ek_fingerprint: otherEk, public_key: Buffer.from(other.public_key).toString("base64url"), suite: "r402s-1", covered: false },
      ]);
      await bootstrapPin(vault, "principal_other", otherEk);

      const result = await vault.rotateEpochForKeyRevocation("principal_other");
      assert.equal(result.outcome, "admitted");
      assert.equal(result.self_check, "not_a_recipient", "the writer's own identity has no included pair — nothing for this machine to self-check");
      assert.equal(result.included.length, 1);
      assert.equal(result.included[0]!.principal_id, "principal_other");

      const payload = await readAdmittedRotatePayload(transport, vault.repoId, result.generation);
      assert.ok(payload.self_open_attestation);
      const attestation = payload.self_open_attestation!;
      assert.equal(attestation.outcome, "writer_not_recipient");
      assert.equal(attestation.chain_verified_to_generation, "0000000000000001");
      assert.equal(attestation.decryptable_to_generation, undefined, "REQUIRED-absent on this branch (schema: present IFF outcome === 'opened')");
      assert.equal(attestation.opened_fingerprint, undefined);
      assert.equal(attestation.reader_entrypoint, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a round-trip failure (this principal's own committed envelope cannot be opened) aborts CLIENT-SIDE, before anything is submitted — never a false attestation, never a partially-committed rotation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-self-open-abort-"));
    try {
      const { transport, vault } = await makeVault(dir);
      const orgId = (await vault.transport.getVaultRecord({ repo_id: vault.repoId })).org_id;
      const identity = vault.keystore.ensureIdentity();
      const ownEk = ekFingerprint((vault.keystore.encryptionKeypair(identity)!).public_key);
      transport.desiredRecipients.set(orgId, [
        { principal_id: "principal_1", display_name: "Creator", status: "active", ek_fingerprint: ownEk, public_key: Buffer.from((vault.keystore.encryptionKeypair(identity)!).public_key).toString("base64url"), suite: "r402s-1", covered: false },
      ]);
      await bootstrapPin(vault, "principal_1", ownEk);

      assert.equal(transport.newestGeneration(vault.repoId), "0000000000000001", "sanity: bootstrapPin's pin-manifest publish is itself an ordinary admitted head");

      // Corrupt the NEXT read of this attempt's own new-epoch envelope — the
      // exact call openEpochRotationForRecipient's get_envelope_bytes
      // callback makes, BEFORE the head is ever built or submitted. This
      // models "the committed/uploaded envelope bytes are absent or
      // altered" — the honest failure openEpochRotationForRecipient itself
      // detects via its own stored_bytes_sha256 comparison, never a bare
      // AEAD auth failure.
      const realGetObject = transport.getObject.bind(transport);
      let corrupted = false;
      transport.getObject = async (req: { repo_id: string; path: string }) => {
        const bytes = await realGetObject(req);
        if (bytes && !corrupted && req.path.startsWith("envelopes/0000000000000002/")) {
          corrupted = true;
          return new Uint8Array([...bytes, 0]); // any byte change fails the stored_bytes_sha256 check
        }
        return bytes;
      };

      await assert.rejects(
        vault.rotateEpochForKeyRevocation("principal_1"),
        (e: unknown) => (e as { code?: string }).code === "GITVAULT_EPOCH_NOT_OPENABLE",
      );
      assert.equal(corrupted, true, "sanity: the corrupting read actually fired");

      // Nothing was ever submitted to the gateway: no new head, generation
      // unchanged. A pre-D209 client ran this exact check AFTER admit() —
      // this proves the fix moved it strictly before.
      assert.equal(transport.newestGeneration(vault.repoId), "0000000000000001", "no rotate_epoch head was admitted — the round-trip failure aborted before submission");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * gitvault-multi-writer (task 5.9, D6/D227) — the writer_set_update fold-in:
 * `rotateEpoch` checks `ineligible_members` (the vault record's own
 * gateway-blocked-writer read, mocked here via `transport.vaultRecord`) on
 * EVERY call and folds a `writer_set_update` in automatically whenever it is
 * non-empty — the SAME "self-healing" shape `pending_confirmations` already
 * gives the recipient-side EPOCH_ROTATION_REQUIRED deadlock.
 */
describe("epoch rotation — writer_set_update fold-in (gitvault-multi-writer task 5.9)", () => {
  it("an empty ineligible_members set is byte-identical to pre-5.9 behavior: no writer_set_update on the wire, writers_removed: [] on the result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-rotate-wsu-noop-"));
    try {
      const { transport, vault } = await makeVault(dir);
      const orgId = (await vault.transport.getVaultRecord({ repo_id: vault.repoId })).org_id;
      const identity = vault.keystore.ensureIdentity();
      const ownEk = ekFingerprint((vault.keystore.encryptionKeypair(identity)!).public_key);
      transport.desiredRecipients.set(orgId, [
        { principal_id: "principal_1", display_name: "Creator", status: "active", ek_fingerprint: ownEk, public_key: Buffer.from((vault.keystore.encryptionKeypair(identity)!).public_key).toString("base64url"), suite: "r402s-1", covered: false },
      ]);
      await bootstrapPin(vault, "principal_1", ownEk);

      const result = await vault.rotateEpochForKeyRevocation("principal_1");
      assert.equal(result.outcome, "admitted");
      assert.deepEqual(result.writers_removed, []);

      const payload = await readAdmittedRotatePayload(transport, vault.repoId, result.generation);
      assert.equal((payload as { writer_set_update?: unknown }).writer_set_update, undefined, "writer_set_update is OMITTED, never an empty object, when there is nothing to remove");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the sole writer's own key gateway-blocked: refused EPOCH_ROTATION_WOULD_LEAVE_VAULT_UNCOVERED without force_empty_writer_set; succeeds to an empty writer set WITH it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-rotate-wsu-sole-"));
    try {
      const { transport, vault } = await makeVault(dir);
      const orgId = (await vault.transport.getVaultRecord({ repo_id: vault.repoId })).org_id;
      const identity = vault.keystore.ensureIdentity();
      const ownEk = ekFingerprint((vault.keystore.encryptionKeypair(identity)!).public_key);
      transport.desiredRecipients.set(orgId, [
        { principal_id: "principal_1", display_name: "Creator", status: "active", ek_fingerprint: ownEk, public_key: Buffer.from((vault.keystore.encryptionKeypair(identity)!).public_key).toString("base64url"), suite: "r402s-1", covered: false },
      ]);
      await bootstrapPin(vault, "principal_1", ownEk);

      const myWriterKeyId = identity.signing_fingerprint;
      transport.vaultRecord = { ineligible_members: [{ principal_id: "principal_1", writer_key_id: myWriterKeyId, gateway_blocked_at: "2026-09-03T00:00:00.000Z", reason: "membership_revoked" }], writer_revocation_version: "3" };

      await assert.rejects(
        vault.rotateEpochForKeyRevocation("principal_1"),
        (e: unknown) => (e as { code?: string }).code === "EPOCH_ROTATION_WOULD_LEAVE_VAULT_UNCOVERED",
      );
      assert.equal(transport.newestGeneration(vault.repoId), "0000000000000001", "the refused attempt admitted no head");

      const result = await vault.rotateEpoch({ reason: "writer_key_revoked", recipient_state_version: "1", recipient_revocation_version: "1", force_empty_writer_set: true });
      assert.equal(result.outcome, "admitted");
      assert.deepEqual(result.writers_removed, [{ writer_key_id: myWriterKeyId, principal_id: "principal_1", reason: "member_removed" }]);

      const payload = await readAdmittedRotatePayload(transport, vault.repoId, result.generation);
      const wsu = (payload as { writer_set_update?: { writers: unknown[]; removed: unknown[] } }).writer_set_update;
      assert.ok(wsu, "writer_set_update is present on the wire");
      assert.deepEqual(wsu!.writers, [], "the next writer set is genuinely empty — the read-only terminal");

      // The local writer_set_pin advanced to reflect the empty set too.
      const pin = vault.keystore.readRepo(vault.repoId)!.writer_set_pin;
      assert.deepEqual(pin!.writers, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("epoch_secret_exposed carries its reason down to each removed writer entry; every other top-level reason collapses to member_removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-rotate-wsu-reason-"));
    try {
      const { transport, vault } = await makeVault(dir);
      const orgId = (await vault.transport.getVaultRecord({ repo_id: vault.repoId })).org_id;
      const identity = vault.keystore.ensureIdentity();
      const ownEk = ekFingerprint((vault.keystore.encryptionKeypair(identity)!).public_key);
      transport.desiredRecipients.set(orgId, [
        { principal_id: "principal_1", display_name: "Creator", status: "active", ek_fingerprint: ownEk, public_key: Buffer.from((vault.keystore.encryptionKeypair(identity)!).public_key).toString("base64url"), suite: "r402s-1", covered: false },
      ]);
      await bootstrapPin(vault, "principal_1", ownEk);
      const myWriterKeyId = identity.signing_fingerprint;
      transport.vaultRecord = { ineligible_members: [{ principal_id: "principal_1", writer_key_id: myWriterKeyId, gateway_blocked_at: "2026-09-03T00:00:00.000Z", reason: "encryption_key_revoked" }], writer_revocation_version: "1" };

      // Fresh counters the SAME way rotateEpochForKeyRevocation gets them
      // internally — an arbitrary literal "1" is what left this test racing
      // the fixture's own desired-recipient-state counter (RECIPIENT_SET_
      // MISMATCH), unrelated to the writer_set_update logic under test.
      const counters = await transport.declareRecipientKeyRevoked({ repo_id: vault.repoId, principal_id: "principal_1" });
      const result = await vault.rotateEpoch({ reason: "epoch_secret_exposed", recipient_state_version: counters.recipient_state_version, recipient_revocation_version: counters.recipient_revocation_version, force_empty_writer_set: true });
      assert.equal(result.writers_removed[0]!.reason, "epoch_secret_exposed", "the top-level reason's own security-incident signal reaches the per-entry reason");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
