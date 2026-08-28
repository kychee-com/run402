/**
 * gitvault epoch rotation — the READER half (D193-D203, rev 42, incident
 * follow-up to `gitvault-rotate.test.ts`'s producer-only coverage).
 *
 * The producer (`GitvaultVault.rotateEpoch`/`rotateEpochForKeyRevocation`,
 * `gitvault-rotate.test.ts`) shipped in 8ecd36c8 with no reader half: a
 * SECOND principal's keystore — one that is a genuine, included recipient of
 * a rotation but did not itself drive it — had no code path to open the
 * rotation's own `key_envelope` and decrypt anything past it. Every test
 * here drives a REAL rotation with the real producer code against the
 * project's own `GitvaultMemoryTransport` fixture, then exercises the
 * reader from a genuinely SEPARATE keystore:
 *
 *   - clone/materialize (`GitvaultVault.materialize`) reads through a
 *     rotation it never produced;
 *   - a keystore with no envelope for the new epoch fails CLOSED with
 *     `GITVAULT_EPOCH_NOT_OPENABLE`, never a bare AEAD failure;
 *   - `verifyToNewest({decryptValidate, strict:false})` — what
 *     `Gitvault.fsck()` calls — reports `generation` (chain-verified) equal
 *     to `decrypt.decryptable_to_generation` on a healthy vault, and honestly
 *     SPLITS them with a named `decrypt.failure` on the incident's own shape
 *     (a rotation this keystore cannot open);
 *   - `recoverGitvaultMirror` (the offline mirror path) traverses the SAME
 *     rotation and falls back at the epoch boundary — never a generic
 *     absence — when its own envelope is missing from the mirror.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ekFingerprint } from "../namespaces/gitvault.crypto.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { GitvaultMemoryTransport, commitFile, makeVault } from "./gitvault-memory-transport.test.js";
import { GitvaultVault } from "./gitvault-publication.js";
import { recoverGitvaultMirror, verifyGitvaultMirror } from "./gitvault-recover.js";
import { DirectoryMirrorBackend, type GitvaultMirrorBackend } from "./gitvault-mirror-backend.js";

function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * `GitvaultMemoryTransport` stores uploads under the SDK's own client-local
 * `path` string, which for `key_envelope` differs from the gateway's real §3
 * key — mirrors `gitvault-mirror-recover.test.ts`'s own
 * `toRepoRelativeGatewayKey`, EXTENDED for the rotation-attempt form
 * (`envelopes/<epoch>/<rotation_id>/<fp>` → `key-envelopes/<epoch>/<rotation_id>/<fp>.env`,
 * protocol §3, D195/rev 42) that file's original translation predates.
 */
function toRepoRelativeGatewayKey(key: string): string {
  const rotationForm = /^envelopes\/([0-9a-f]{16})\/([0-9a-f]{64})\/(ek_[0-9a-f]{32})$/.exec(key);
  if (rotationForm) return `key-envelopes/${rotationForm[1]}/${rotationForm[2]}/${rotationForm[3]}.env`;
  const genesisForm = /^envelopes\/([0-9a-f]{16})\/(ek_[0-9a-f]{32})$/.exec(key);
  if (genesisForm) return `key-envelopes/${genesisForm[1]}/${genesisForm[2]}.env`;
  return key;
}

function transportEntries(transport: { objects: Map<string, Uint8Array> }, repoId: string): Array<{ key: string; bytes: Uint8Array }> {
  const out: Array<{ key: string; bytes: Uint8Array }> = [];
  const prefix = `${repoId}/`;
  for (const [k, bytes] of transport.objects) {
    if (k.startsWith(prefix)) out.push({ key: toRepoRelativeGatewayKey(k.slice(prefix.length)), bytes });
  }
  return out;
}

async function seedBackend(backend: GitvaultMirrorBackend, entries: readonly { key: string; bytes: Uint8Array }[]): Promise<void> {
  for (const e of entries) await backend.putCreateOnly(e.key, e.bytes);
}

/** Bootstrap a principal's pin (D197) — needed before any rotation can validly include them. Mirrors `gitvault-rotate.test.ts`'s own helper. */
async function bootstrapPin(vault: GitvaultVault, principalId: string, ekFp: string): Promise<void> {
  const receipt = await vault.transport.confirmRecipient({ repo_id: vault.repoId, principal_id: principalId, new_fingerprint: ekFp });
  await vault.publishPinManifestUpdate({ principal_id: principalId, ek_fingerprint: ekFp, confirmed_by: "operator_confirmation", receipt });
}

interface TwoRecipientFixture {
  transport: GitvaultMemoryTransport;
  creatorVault: GitvaultVault;
  readerKeystore: GitvaultKeystore;
  repoDir: string;
  repoId: string;
  push2Generation: string;
  push2HeadEpoch: string;
  /** The rotation's own `rotation_id` (D195), straight off the producer's own result — never re-derived via a second walk (which, once local pins already sit at the newest, is exactly the "nothing new to walk" case this fold's own backward-catch-up exists for; using the producer's own answer keeps the fixture itself independent of that mechanism). */
  rotationId: string;
}

/**
 * Two principals at genesis-epoch parity, then a REAL rotation (produced by
 * `rotateEpochForKeyRevocation`) that includes BOTH, then one more ordinary
 * push at the new epoch — a chain spanning the rotation the way the incident
 * vault's generations 1..10 spanned its own rotation at generation 8.
 *
 * Genesis in this SDK stays single-recipient (D198's N-recipient genesis is
 * a separate, unscoped follow-up — see `gitvault-rotate.test.ts`'s own
 * `bootstrapPin` doc comment) — the second principal's epoch-1 state is
 * therefore SEEDED directly (`saveRepo`) rather than built through a real
 * genesis/ADD ceremony. This is a faithful stand-in for "already had epoch 1
 * some other way" (a real N-recipient genesis, or the ADD-workaround): the
 * READER code under test — everything from `materialize()` onward — cannot
 * tell the difference, and does not need to.
 */
async function makeTwoRecipientRotatedVault(dir: string): Promise<TwoRecipientFixture> {
  const { transport, vault, repoDir, repoId } = await makeVault(dir);
  const orgId = (await vault.transport.getVaultRecord({ repo_id: repoId })).org_id;

  const c1 = await commitFile(repoDir, "a.txt", "a\n");
  const m1 = await vault.materialize();
  await vault.push({ transaction: { updates: [{ ref: "refs/heads/main", new_oid: c1, expected_old_oid: null, force: false }] }, head_target: m1.head_target });

  const creatorIdentity = vault.keystore.ensureIdentity();
  const creatorEk = ekFingerprint(vault.keystore.encryptionKeypair(creatorIdentity)!.public_key);
  await bootstrapPin(vault, "principal_1", creatorEk);

  const readerKeystore = GitvaultKeystore.open({ rootDir: join(dir, "ks-reader") });
  const readerIdentity = readerKeystore.ensureIdentity();
  const readerEk = ekFingerprint(readerKeystore.encryptionKeypair(readerIdentity)!.public_key);
  const repo1 = vault.keystore.readRepo(repoId)!;
  readerKeystore.saveRepo({
    repo_id: repoId, org_id: repo1.org_id, project_id: repo1.project_id,
    k_repo_hex: repo1.k_repo_hex, epoch: repo1.epoch, genesis_sha256: repo1.genesis_sha256,
    head_pin: null, last_ref_transaction: null, provenance: "restored_from_envelope",
  });
  await bootstrapPin(vault, "principal_2", readerEk);

  transport.desiredRecipients.set(orgId, [
    { principal_id: "principal_1", display_name: "Creator", status: "active", ek_fingerprint: creatorEk, public_key: Buffer.from(vault.keystore.encryptionKeypair(creatorIdentity)!.public_key).toString("base64url"), suite: "r402s-1", covered: false },
    { principal_id: "principal_2", display_name: "Reader", status: "active", ek_fingerprint: readerEk, public_key: Buffer.from(readerKeystore.encryptionKeypair(readerIdentity)!.public_key).toString("base64url"), suite: "r402s-1", covered: false },
  ]);

  const rotation = await vault.rotateEpochForKeyRevocation("principal_1");
  assert.equal(rotation.outcome, "admitted");
  assert.equal(rotation.new_epoch, "0000000000000002");
  assert.equal(rotation.included.length, 2, "both principals must be included for this fixture's own tests to mean anything");
  assert.ok(rotation.included.some((p) => p.principal_id === "principal_2"));

  const c2 = await commitFile(repoDir, "b.txt", "b\n");
  const m2 = await vault.materialize();
  const push2 = await vault.push({ transaction: { updates: [{ ref: "refs/heads/main", new_oid: c2, expected_old_oid: c1, force: false }] }, head_target: m2.head_target });

  return { transport, creatorVault: vault, readerKeystore, repoDir, repoId, push2Generation: push2.generation, push2HeadEpoch: push2.head.epoch, rotationId: rotation.rotation_id };
}

describe("gitvault epoch rotation — reader traversal (Part A: clone/materialize)", () => {
  it("a keystore that did NOT drive the rotation opens the new epoch's own envelope and decrypts through it", async () => {
    const dir = scratchDir("run402-gitvault-epoch-reader-");
    try {
      const f = await makeTwoRecipientRotatedVault(dir);
      const before = f.readerKeystore.readRepo(f.repoId)!;
      assert.equal(before.epoch, "0000000000000001", "sanity: the reader never opened the rotation yet");

      const readerVault = GitvaultVault.open({ keystore: f.readerKeystore, transport: f.transport, repo_id: f.repoId, repo_dir: null });
      const materialized = await readerVault.materialize();

      assert.equal(materialized.generation, f.push2Generation);
      assert.equal(materialized.head?.epoch, f.push2HeadEpoch);
      assert.equal(materialized.refs["refs/heads/main"], (await f.creatorVault.materialize()).refs["refs/heads/main"]);

      const after = f.readerKeystore.readRepo(f.repoId)!;
      assert.equal(after.epoch, "0000000000000002", "materialize() advanced the local epoch pointer by opening the rotation envelope");
      assert.ok(after.epoch_keys?.["0000000000000001"], "the pre-rotation epoch key stays retained");
      assert.ok(after.epoch_keys?.["0000000000000002"], "the new epoch key is recorded");
      assert.notEqual(after.epoch_keys!["0000000000000001"], after.epoch_keys!["0000000000000002"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chains through MULTIPLE sequential rotations", async () => {
    const dir = scratchDir("run402-gitvault-epoch-reader-multi-");
    try {
      const f = await makeTwoRecipientRotatedVault(dir);
      const orgId = (await f.creatorVault.transport.getVaultRecord({ repo_id: f.repoId })).org_id;

      // A second rotation, still covering both principals.
      const rotation2 = await f.creatorVault.rotateEpochForKeyRevocation("principal_1");
      assert.equal(rotation2.new_epoch, "0000000000000003");
      assert.equal(rotation2.included.length, 2);
      const c3 = await commitFile(f.repoDir, "c.txt", "c\n");
      const m3 = await f.creatorVault.materialize();
      const push3 = await f.creatorVault.push({ transaction: { updates: [{ ref: "refs/heads/main", new_oid: c3, expected_old_oid: m3.refs["refs/heads/main"]!, force: false }] }, head_target: m3.head_target });
      void orgId;

      const readerVault = GitvaultVault.open({ keystore: f.readerKeystore, transport: f.transport, repo_id: f.repoId, repo_dir: null });
      const materialized = await readerVault.materialize();
      assert.equal(materialized.generation, push3.generation);
      assert.equal(materialized.head?.epoch, "0000000000000003");
      const after = f.readerKeystore.readRepo(f.repoId)!;
      assert.equal(after.epoch, "0000000000000003");
      assert.ok(after.epoch_keys?.["0000000000000001"]);
      assert.ok(after.epoch_keys?.["0000000000000002"]);
      assert.ok(after.epoch_keys?.["0000000000000003"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GITVAULT_EPOCH_NOT_OPENABLE: a keystore excluded from the rotation fails CLOSED, naming epoch/rotation/fingerprint — never a bare AEAD failure", async () => {
    const dir = scratchDir("run402-gitvault-epoch-reader-excluded-");
    try {
      const { transport, vault, repoDir, repoId } = await makeVault(dir);
      const orgId = (await vault.transport.getVaultRecord({ repo_id: repoId })).org_id;
      const c1 = await commitFile(repoDir, "a.txt", "a\n");
      const m1 = await vault.materialize();
      await vault.push({ transaction: { updates: [{ ref: "refs/heads/main", new_oid: c1, expected_old_oid: null, force: false }] }, head_target: m1.head_target });

      const creatorIdentity = vault.keystore.ensureIdentity();
      const creatorEk = ekFingerprint(vault.keystore.encryptionKeypair(creatorIdentity)!.public_key);
      await bootstrapPin(vault, "principal_1", creatorEk);

      // A third principal that is a genuine local keystore (so it CAN
      // decrypt if given a key) but never appears in desired_recipients at
      // all — never included, never wrapped.
      const outsiderKeystore = GitvaultKeystore.open({ rootDir: join(dir, "ks-outsider") });
      const outsiderIdentity = outsiderKeystore.ensureIdentity();
      const outsiderEk = ekFingerprint(outsiderKeystore.encryptionKeypair(outsiderIdentity)!.public_key);
      const repo1 = vault.keystore.readRepo(repoId)!;
      outsiderKeystore.saveRepo({
        repo_id: repoId, org_id: repo1.org_id, project_id: repo1.project_id,
        k_repo_hex: repo1.k_repo_hex, epoch: repo1.epoch, genesis_sha256: repo1.genesis_sha256,
        head_pin: null, last_ref_transaction: null, provenance: "restored_from_envelope",
      });
      void outsiderEk;

      transport.desiredRecipients.set(orgId, [
        { principal_id: "principal_1", display_name: "Creator", status: "active", ek_fingerprint: creatorEk, public_key: Buffer.from(vault.keystore.encryptionKeypair(creatorIdentity)!.public_key).toString("base64url"), suite: "r402s-1", covered: false },
      ]);
      const rotation = await vault.rotateEpochForKeyRevocation("principal_1");
      assert.equal(rotation.included.length, 1, "the outsider is never in desired_recipients, so H excludes them structurally — not this test's own concern");

      const c2 = await commitFile(repoDir, "b.txt", "b\n");
      const m2 = await vault.materialize();
      await vault.push({ transaction: { updates: [{ ref: "refs/heads/main", new_oid: c2, expected_old_oid: c1, force: false }] }, head_target: m2.head_target });

      const outsiderVault = GitvaultVault.open({ keystore: outsiderKeystore, transport, repo_id: repoId, repo_dir: null });
      await assert.rejects(
        outsiderVault.materialize(),
        (e: unknown) => {
          const err = e as { code?: string; details?: { epoch?: string; rotation_id?: string; recipient_fingerprint?: string; reason?: string } };
          assert.equal(err.code, "GITVAULT_EPOCH_NOT_OPENABLE");
          assert.equal(err.details?.epoch, "0000000000000002");
          assert.equal(err.details?.rotation_id, rotation.rotation_id);
          assert.equal(err.details?.reason, "not_included");
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gitvault epoch rotation — reader traversal (Part C: fsck's chain_verified_to vs decryptable_to)", () => {
  it("healthy vault: verifyToNewest({decryptValidate, strict:false}) reports chain_verified_to == decryptable_to, no failure", async () => {
    const dir = scratchDir("run402-gitvault-epoch-reader-fsck-healthy-");
    try {
      const f = await makeTwoRecipientRotatedVault(dir);
      const readerVault = GitvaultVault.open({ keystore: f.readerKeystore, transport: f.transport, repo_id: f.repoId, repo_dir: null });
      const state = await readerVault.verifyToNewest({ decryptValidate: true, strict: false });
      assert.equal(state.generation, f.push2Generation, "chain-verified reaches the true newest");
      assert.ok(state.decrypt);
      assert.equal(state.decrypt!.decryptable_to_generation, state.generation, "the healthy case: decryptable_to == chain_verified_to");
      assert.equal(state.decrypt!.failure, null);
      assert.equal(state.rotations.length, 1);
      assert.equal(state.rotations[0]!.epoch, "0000000000000002");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the incident's own shape: a keystore whose rotation envelope is absent reports chain_verified_to > decryptable_to, GITVAULT_EPOCH_NOT_OPENABLE named exactly", async () => {
    const dir = scratchDir("run402-gitvault-epoch-reader-fsck-split-");
    try {
      const f = await makeTwoRecipientRotatedVault(dir);
      const readerVault = GitvaultVault.open({ keystore: f.readerKeystore, transport: f.transport, repo_id: f.repoId, repo_dir: null });

      // Simulate the incident: this keystore's own rotation-attempt
      // envelope is present in `envelopes[]` (it IS a genuine recipient —
      // the rotation payload names it) but the object bytes are missing
      // from storage — the exact "reader gap" the shipped producer left:
      // "clone/materialize still derives object keys from the pre-rotation
      // epoch" manifests, at the object layer, as an absent/altered envelope.
      const readerIdentity = f.readerKeystore.readIdentity()!;
      const readerEk = readerIdentity.encryption_fingerprint;
      // Chain-verify FIRST, WITHOUT decrypt-validating — advances head_pin to
      // the newest via a purely structural walk, exactly the "an earlier
      // plain verify() already ran" scenario the backward catch-up below
      // must handle (nothing left to walk FORWARD by the time the decrypt
      // call below runs).
      await readerVault.verifyToNewest({});
      const envelopeKey = `${f.repoId}/envelopes/0000000000000002/${f.rotationId}/${readerEk}`;
      assert.ok(f.transport.objects.has(envelopeKey), "sanity: the envelope really was uploaded for this recipient");
      f.transport.objects.delete(envelopeKey);

      const state = await readerVault.verifyToNewest({ decryptValidate: true, strict: false });
      assert.equal(state.generation, f.push2Generation, "chain verification is unaffected — it never opens an envelope");
      assert.ok(state.decrypt);
      assert.notEqual(state.decrypt!.decryptable_to_generation, state.generation, "decryptable_to falls SHORT of chain_verified_to");
      assert.equal(state.decrypt!.decryptable_to_generation, "0000000000000003", "capped at the last generation before the rotation head (generation 4) — two pin-manifest-bootstrap heads precede it at generations 2/3");
      assert.ok(state.decrypt!.failure);
      assert.equal(state.decrypt!.failure!.code, "GITVAULT_EPOCH_NOT_OPENABLE");
      assert.equal(state.decrypt!.failure!.epoch, "0000000000000002");
      assert.equal(state.decrypt!.failure!.rotation_id, f.rotationId);

      // The ordinary (strict) read path fails CLOSED on the exact same cause — never falls through to a bare AEAD failure.
      await assert.rejects(readerVault.materialize(), (e: unknown) => (e as { code?: string }).code === "GITVAULT_EPOCH_NOT_OPENABLE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gitvault epoch rotation — reader traversal (Part B: offline mirror recovery)", () => {
  // `recoverGitvaultMirror` derives `K_1` purely from `vault_genesis.envelopes[]`
  // (this SDK's genesis stays single-recipient — D198's N-recipient genesis
  // is a separate, unscoped follow-up, `gitvault-rotate.test.ts`'s own
  // `bootstrapPin` doc comment), so only the CREATOR's own identity can
  // exercise this path today — a limitation of genesis-envelope resolution
  // this task does not touch. Using the creator's keystore still fully
  // exercises what THIS task fixed: `recoverGitvaultMirror` is a from-scratch
  // OFFLINE derivation (genesis K_1, then every rotation envelope, all
  // re-opened from the mirror alone) that shares NO in-memory state with the
  // live `vault.rotateEpoch()` call that produced the rotation.
  it("recoverGitvaultMirror traverses a real rotation offline, using the mirrored rotation envelope", async () => {
    const dir = scratchDir("run402-gitvault-epoch-reader-recover-");
    const mirrorRoot = scratchDir("run402-gitvault-epoch-reader-mirror-");
    const outDir = scratchDir("run402-gitvault-epoch-reader-out-");
    try {
      const f = await makeTwoRecipientRotatedVault(dir);
      const backend = new DirectoryMirrorBackend(mirrorRoot);
      await seedBackend(backend, transportEntries(f.transport, f.repoId));

      const result = await recoverGitvaultMirror({ backend, out_dir: outDir, keystore: f.creatorVault.keystore });
      assert.equal(result.mode, "recovered");
      assert.equal(result.chain_break, null);
      assert.equal(result.chain_verified_to_generation, f.push2Generation);
      assert.equal(result.recovered_generation, f.push2Generation);
      assert.equal(result.epoch_decrypt_failure, null);
      assert.equal(result.data_loss_detected, false);
      assert.equal(result.refs["refs/heads/main"], (await f.creatorVault.materialize()).refs["refs/heads/main"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(mirrorRoot, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("keyless verifyGitvaultMirror walks the FULL chain through the rotation (structural only) — the transition no longer stops it", async () => {
    const dir = scratchDir("run402-gitvault-epoch-reader-mirror-verify-");
    const mirrorRoot = scratchDir("run402-gitvault-epoch-reader-mirror-verify-root-");
    try {
      const f = await makeTwoRecipientRotatedVault(dir);
      const backend = new DirectoryMirrorBackend(mirrorRoot);
      await seedBackend(backend, transportEntries(f.transport, f.repoId));

      const report = await verifyGitvaultMirror(backend, { keystore: f.readerKeystore });
      assert.equal(report.mode, "keyless_verify");
      assert.equal(report.chain_break, null);
      assert.equal(report.chain_verified_to_generation, f.push2Generation);
      assert.equal(report.recovered_generation, f.push2Generation);
      assert.equal(report.epoch_decrypt_failure, null, "the keyless path never opens a key, so this always reads null");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(mirrorRoot, { recursive: true, force: true });
    }
  });

  it("synthetic missing-envelope: recover falls back at the EPOCH BOUNDARY (never a generic absence), naming the same GITVAULT_EPOCH_NOT_OPENABLE detail fsck would report", async () => {
    const dir = scratchDir("run402-gitvault-epoch-reader-recover-fallback-");
    const mirrorRoot = scratchDir("run402-gitvault-epoch-reader-mirror-fallback-");
    const outDir = scratchDir("run402-gitvault-epoch-reader-out-fallback-");
    try {
      const f = await makeTwoRecipientRotatedVault(dir);
      // Same genesis-envelope-resolution caveat as the healthy-path test
      // above: only the CREATOR can drive `recoverGitvaultMirror` at all in
      // this SDK today, so the "missing envelope" this test removes is the
      // CREATOR's own rotation envelope.
      const creatorIdentity = f.creatorVault.keystore.readIdentity()!;
      const creatorEk = creatorIdentity.encryption_fingerprint;

      const backend = new DirectoryMirrorBackend(mirrorRoot);
      const entries = transportEntries(f.transport, f.repoId).filter((e) => e.key !== `key-envelopes/0000000000000002/${f.rotationId}/${creatorEk}.env`);
      await seedBackend(backend, entries);

      const result = await recoverGitvaultMirror({ backend, out_dir: outDir, keystore: f.creatorVault.keystore });
      assert.equal(result.mode, "recovered");
      assert.equal(result.chain_break, null, "the STRUCTURAL chain walk is entirely unaffected by a missing key envelope");
      assert.equal(result.chain_verified_to_generation, f.push2Generation);
      assert.equal(result.recovered_generation, "0000000000000003", "capped at the last generation before the rotation head (generation 4) — never past the un-openable rotation");
      assert.notEqual(result.recovered_generation, result.chain_verified_to_generation);
      assert.ok(result.epoch_decrypt_failure, "named, not a generic absence");
      assert.equal(result.epoch_decrypt_failure!.code, "GITVAULT_EPOCH_NOT_OPENABLE");
      assert.equal(result.epoch_decrypt_failure!.epoch, "0000000000000002");
      assert.equal(result.epoch_decrypt_failure!.rotation_id, f.rotationId);
      assert.equal(result.absences.length, 0, "this is an epoch-decrypt cap, never folded into the generic unexplained_absence vocabulary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(mirrorRoot, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
