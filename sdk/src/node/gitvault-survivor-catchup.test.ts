/**
 * gitvault-multi-writer rev 47 — THE SURVIVOR THAT DID NOT ROTATE.
 *
 * The live-only failure this file reproduces on the in-memory transport
 * (`docs/runbooks/gitvault-live-rehearsal.md`, "Both survivors, not only the
 * rotator"): after a member removal, the rotating writer holds the new epoch
 * key by construction, so every rotation-family test that drives the ROTATOR
 * is blind to the OTHER survivor's read path. That other survivor must:
 *
 *   1. open the new epoch's `key_envelope` under the ROTATOR's key (never
 *      unconditionally the genesis creator's), and
 *   2. re-read the catch-up BOUNDARY head — routinely the REMOVED writer's
 *      last head, since a removal rotation lands directly on top of it —
 *      which verifies only under that writer's RETIRED key, and
 *   3. materialize from there.
 *
 * Before the fix (2) died `CHAIN_UNUSABLE` because `writer_set_pin` forgot a
 * removed writer's key the instant the `writer_set_update` retired it. The
 * fix keeps `retired_writers` on the persisted pin (local bookkeeping outside
 * the JCS-hashed writer set — admission of a NEW head still consults the
 * active set alone), and a pin written before that field existed re-walks
 * from genesis ONCE rather than refusing.
 *
 * Cast: A creates the vault and rotates; B is a second writer admitted
 * through the writer door and is the one REMOVED; C is a keyed, pinned
 * desired recipient that never writes — the survivor whose pin was advanced
 * DECRYPT-BLIND past the rotation while its materialized pin still sat at B's
 * last head. That decrypt-blind/materialized split is what forces
 * `verifyToNewest`'s BACKWARD catch-up walk (rather than the forward
 * per-head decrypt), which is exactly the path the live failure took.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ekFingerprint, parseGitvaultStrict, parseRotateEpochPayload } from "../namespaces/gitvault.crypto.js";
import type { GitvaultHead } from "../namespaces/gitvault.types.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { GitvaultMemoryTransport, commitFile, makeVault } from "./gitvault-memory-transport.test.js";
import { GitvaultVault, gitvaultPaths } from "./gitvault-publication.js";

const A_PRINCIPAL = "principal_1"; // the fixture's own creator principal id
const B_PRINCIPAL = "principal_b";
const C_PRINCIPAL = "principal_c";

async function readAdmittedRotatePayload(transport: GitvaultMemoryTransport, repoId: string, generation: string) {
  const bytes = await transport.getObject({ repo_id: repoId, path: gitvaultPaths.head(generation) });
  assert.ok(bytes, `head ${generation} must be stored`);
  const head = parseGitvaultStrict(new TextDecoder().decode(bytes)) as GitvaultHead;
  return parseRotateEpochPayload(head);
}

/** D197's confirmation ceremony for one principal — a non-writer recipient is only ever `included` in a rotation on a confirmed pin. */
async function bootstrapPin(vault: GitvaultVault, principalId: string, ekFp: string): Promise<void> {
  const receipt = await vault.transport.confirmRecipient({ repo_id: vault.repoId, principal_id: principalId, new_fingerprint: ekFp });
  await vault.publishPinManifestUpdate({ principal_id: principalId, ek_fingerprint: ekFp, confirmed_by: "operator_confirmation", receipt });
}

describe("gitvault-multi-writer rev 47 — the survivor that did NOT rotate opens the vault after a removal", () => {
  it("C (a keyed, pinned recipient pinned decrypt-blind past the rotation) materializes across a removal: the new epoch opens under the ROTATOR's key and B's last head re-verifies under B's RETIRED key", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "run402-gitvault-survivor-catchup-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    // ── A: creator, writer, and (later) the rotator ──────────────────────
    const { transport, vault: vaultA, repoDir: repoDirA, repoId } = await makeVault(root);
    const orgId = (await transport.getVaultRecord({ repo_id: repoId })).org_id;
    const identityA = vaultA.keystore.ensureIdentity();
    const ekA = vaultA.keystore.encryptionKeypair(identityA)!;

    // gen 1 — A's ordinary push.
    const c1 = await commitFile(repoDirA, "a.txt", "a\n");
    const m1 = await vaultA.materialize();
    const gen1 = await vaultA.push({ transaction: { updates: [{ ref: "refs/heads/main", new_oid: c1, expected_old_oid: null, force: false }] }, head_target: m1.head_target });
    assert.equal(gen1.generation, "0000000000000001");
    assert.equal(gen1.head.writer_key_id, identityA.signing_fingerprint);

    // ── B: a second principal, admitted as a writer through the writer door ──
    const ksB = GitvaultKeystore.open({ rootDir: join(root, "ksB") });
    const identityB = ksB.ensureIdentity();
    const ekB = ksB.encryptionKeypair(identityB)!;

    // gen 2 — A (an active writer) admits B's OWN key. No copied seed: B
    // signs its own heads below under the key admitted here.
    const admitted = await vaultA.admitPendingWriter({ addedWriterKeyId: identityB.signing_fingerprint, addedSigningPubkeyB64u: identityB.signing_pubkey, addedPrincipalId: B_PRINCIPAL });
    assert.equal(admitted.outcome, "activated");
    assert.equal(admitted.outcome === "activated" ? admitted.result.generation : null, "0000000000000002");

    // ── C: a keyed desired recipient that never writes ───────────────────
    const ksC = GitvaultKeystore.open({ rootDir: join(root, "ksC") });
    const identityC = ksC.ensureIdentity();
    const ekC = ksC.encryptionKeypair(identityC)!;
    const fpC = ekFingerprint(ekC.public_key);

    const b64u = (k: Uint8Array): string => Buffer.from(k).toString("base64url");
    transport.desiredRecipients.set(orgId, [
      { principal_id: A_PRINCIPAL, display_name: "A (creator, rotator)", status: "active", ek_fingerprint: ekFingerprint(ekA.public_key), public_key: b64u(ekA.public_key), suite: "r402s-1", covered: true },
      { principal_id: B_PRINCIPAL, display_name: "B (second writer)", status: "active", ek_fingerprint: ekFingerprint(ekB.public_key), public_key: b64u(ekB.public_key), suite: "r402s-1", covered: true },
      { principal_id: C_PRINCIPAL, display_name: "C (reader)", status: "active", ek_fingerprint: fpC, public_key: b64u(ekC.public_key), suite: "r402s-1", covered: true },
    ]);

    // gen 3 — C's confirmation pin (an ordinary head by A). A itself needs
    // none: it is a SURVIVING WRITER, included on its directory fingerprint.
    await bootstrapPin(vaultA, C_PRINCIPAL, fpC);
    assert.equal(vaultA.keystore.readRepo(repoId)!.known_pin_manifest!.pin_manifest_version, "0000000000000001");

    // The chain's active writer set, as the gateway reports it. Both A and B
    // are surviving writers, so both are included on their directory
    // fingerprints with no pin of their own.
    const writerPinBeforeRemoval = vaultA.keystore.readRepo(repoId)!.writer_set_pin!;
    const writerSetRecord = {
      version: writerPinBeforeRemoval.version, sha256: writerPinBeforeRemoval.sha256,
      writers: [
        { writer_key_id: identityA.signing_fingerprint, principal_id: A_PRINCIPAL, authorization_kind: "writer" as const, admitted_generation: "0", admitted_head_sha256: "0".repeat(64) },
        { writer_key_id: identityB.signing_fingerprint, principal_id: B_PRINCIPAL, authorization_kind: "writer" as const, admitted_generation: "2", admitted_head_sha256: "0".repeat(64) },
      ],
    };
    transport.vaultRecord = { writer_set: writerSetRecord };

    const repoA = vaultA.keystore.readRepo(repoId)!;
    const genesisEpoch = repoA.epoch;
    ksB.saveRepo({
      repo_id: repoId, org_id: repoA.org_id, project_id: repoA.project_id,
      k_repo_hex: repoA.k_repo_hex, epoch: repoA.epoch, genesis_sha256: repoA.genesis_sha256,
      head_pin: null, last_ref_transaction: null, provenance: "restored_from_envelope",
    });
    cpSync(repoDirA, join(root, "repoB"), { recursive: true });
    const repoDirB = realpathSync(join(root, "repoB"));
    const vaultB = GitvaultVault.open({ keystore: ksB, transport, repo_id: repoId, repo_dir: repoDirB });

    // gen 4 — a rotation driven by B: a NON-CREATOR writer. Every envelope
    // it seals verifies only under B's key, so a reader that resolves the
    // rotation's signer as "the genesis creator" dies GITVAULT_SIGNATURE_INVALID
    // here — the other half of the live failure, on the FORWARD walk.
    const rotatedByB = await vaultB.rotateEpoch({ reason: "elective_rekey", recipient_state_version: "0", recipient_revocation_version: "0" });
    assert.equal(rotatedByB.outcome, "admitted");
    assert.equal(rotatedByB.generation, "0000000000000004");
    assert.deepEqual(rotatedByB.included.map((p) => p.principal_id).sort(), [A_PRINCIPAL, B_PRINCIPAL, C_PRINCIPAL]);

    // gen 5 — B pushes UNDER ITS OWN KEY. This head is the one the removal
    // rotation lands directly on top of, so it is the catch-up boundary C
    // must later re-read with B already retired.
    const c2 = await commitFile(repoDirB, "b.txt", "b\n");
    const mB = await vaultB.materialize();
    const gen5 = await vaultB.push({ transaction: { updates: [{ ref: "refs/heads/main", new_oid: c2, expected_old_oid: c1, force: false }] }, head_target: mB.head_target });
    assert.equal(gen5.generation, "0000000000000005");
    assert.equal(gen5.head.writer_key_id, identityB.signing_fingerprint, "B signed its own head — not A's key, not a copied seed");
    assert.equal(gen5.head.epoch, rotatedByB.new_epoch);

    // ── C opens the vault cold and materializes at B's head ──────────────
    // This first read walks FORWARD from genesis with decrypt-validation on,
    // so it opens B's rotation envelope through the forward walk's own
    // per-head writer resolution.
    ksC.saveRepo({
      repo_id: repoId, org_id: repoA.org_id, project_id: repoA.project_id,
      k_repo_hex: repoA.k_repo_hex, epoch: repoA.epoch, genesis_sha256: repoA.genesis_sha256,
      head_pin: null, last_ref_transaction: null, provenance: "restored_from_envelope",
    });
    const vaultC = GitvaultVault.open({ keystore: ksC, transport, repo_id: repoId, repo_dir: null });
    const mC1 = await vaultC.materialize();
    assert.equal(mC1.generation, gen5.generation);
    assert.equal(mC1.head!.epoch, rotatedByB.new_epoch, "C opened an epoch a NON-CREATOR writer rotated into");
    assert.deepEqual(mC1.refs, { "refs/heads/main": c2 });
    assert.equal(ksC.readRepo(repoId)!.head_pin!.generation, gen5.generation);
    assert.equal(ksC.readRepo(repoId)!.materialized_pin!.generation, gen5.generation, "C's materialized pin sits at B's last head");
    assert.deepEqual(
      [...ksC.readRepo(repoId)!.writer_set_pin!.writers].map((w) => w.writer_key_id).sort(),
      [identityA.signing_fingerprint, identityB.signing_fingerprint].sort(),
      "C's chain-replayed writer set holds both writers while B is still active",
    );

    // ── A removes B: the gateway-side facts a real `org member rm` sets ───
    transport.desiredRecipients.set(orgId, [
      { principal_id: A_PRINCIPAL, display_name: "A (creator, rotator)", status: "active", ek_fingerprint: ekFingerprint(ekA.public_key), public_key: b64u(ekA.public_key), suite: "r402s-1", covered: true },
      { principal_id: B_PRINCIPAL, display_name: "B (removed)", status: "pending_removal", ek_fingerprint: ekFingerprint(ekB.public_key), public_key: b64u(ekB.public_key), suite: "r402s-1", covered: true },
      { principal_id: C_PRINCIPAL, display_name: "C (reader)", status: "active", ek_fingerprint: fpC, public_key: b64u(ekC.public_key), suite: "r402s-1", covered: true },
    ]);
    const counters = transport.counters(orgId);
    counters.state += 1n;
    counters.revocation += 1n;
    transport.vaultRecord = {
      writer_set: writerSetRecord,
      ineligible_members: [{ principal_id: B_PRINCIPAL, writer_key_id: identityB.signing_fingerprint, gateway_blocked_at: null, reason: "membership_revoked" }],
      writer_revocation_version: "1",
    };

    // gen 6 — the removal rotation, driven by A.
    const rotated = await vaultA.rotateEpochForMemberRemoval();
    assert.equal(rotated.outcome, "admitted");
    assert.equal(rotated.generation, "0000000000000006");
    assert.deepEqual(rotated.included.map((p) => p.principal_id).sort(), [A_PRINCIPAL, C_PRINCIPAL], "the new epoch is wrapped to the surviving writer AND to C — the survivor that did not rotate must be able to open it");
    assert.deepEqual(rotated.writers_removed.map((w) => w.writer_key_id), [identityB.signing_fingerprint]);
    const rotatePayload = await readAdmittedRotatePayload(transport, repoId, rotated.generation);
    assert.equal((rotatePayload as { reason?: string }).reason, "member_removed");
    assert.deepEqual(
      (rotatePayload.writer_set_update?.removed ?? []).map((r) => r.writer_key_id),
      [identityB.signing_fingerprint],
      "the admitted rotate_epoch payload's writer_set_update removes exactly B",
    );
    assert.deepEqual(
      ((rotatePayload as { envelopes?: { principal_id: string }[] }).envelopes ?? []).map((p) => p.principal_id).sort(),
      [A_PRINCIPAL, C_PRINCIPAL],
    );

    // ── THE REGRESSION: C catches up. Decrypt-blind FIRST (so the pin is
    // already at the rotation head and the forward walk decrypts nothing),
    // then materialize — which drives the BACKWARD catch-up: open the new
    // epoch under A's key, then re-read B's now-RETIRED head at the boundary.
    const blind2 = await vaultC.verifyToNewest({ persist: true });
    assert.equal(blind2.generation, rotated.generation, "C's head_pin is advanced past the rotation decrypt-blind");
    assert.equal(ksC.readRepo(repoId)!.materialized_pin!.generation, gen5.generation, "…while C's materialized pin still sits at the removed writer's last head — the exact split the live failure needed");
    // The exact state the legacy-pin arm at the end replays from: pinned past
    // the rotation, materialized before it, no key for the new epoch yet.
    const { version: _v, updated_at: _u, ...blindRepoC } = ksC.readRepo(repoId)!;
    assert.equal(blindRepoC.epoch_keys?.[rotated.new_epoch], undefined, "the blind walk decrypted nothing — no new-epoch key yet");

    const mC2 = await vaultC.materialize();
    assert.equal(mC2.generation, rotated.generation, "C materialized ACROSS the rotation it did not drive");
    assert.equal(mC2.head!.epoch, rotated.new_epoch, "C advanced to the new epoch");
    assert.notEqual(mC2.head!.epoch, genesisEpoch);
    assert.notEqual(mC2.head!.epoch, rotatedByB.new_epoch);
    assert.deepEqual(mC2.refs, { "refs/heads/main": c2 }, "C's refs equal the vault's");
    const mA = await vaultA.materialize();
    assert.deepEqual(mC2.refs, mA.refs, "the two survivors agree on the vault's refs");
    assert.equal(ksC.readRepo(repoId)!.epoch_keys![rotated.new_epoch], mA.epoch_keys_hex[rotated.new_epoch], "C opened the SAME new epoch key the rotator sealed");

    const pinAfter = ksC.readRepo(repoId)!.writer_set_pin!;
    assert.deepEqual([...pinAfter.writers].map((w) => w.writer_key_id), [identityA.signing_fingerprint], "B is no longer an ACTIVE writer for C");
    assert.deepEqual(
      [...(pinAfter.retired_writers ?? [])],
      [{ writer_key_id: identityB.signing_fingerprint, signing_pubkey: identityB.signing_pubkey }],
      "…but B's key is kept in retired_writers with its signing_pubkey — the only thing that can verify the boundary head B signed while active",
    );

    // ── Legacy pin: the SAME catch-up, replayed by a checkout whose
    // `writer_set_pin` was written before `retired_writers` existed. Rewind C
    // to the post-blind-walk state captured above — pinned past the rotation,
    // writer set already narrowed to A, materialized at B's head — and strip
    // the field. Such a pin cannot vouch for the boundary head B signed, and
    // it must NOT refuse: the walk starts over from genesis ONCE (the same
    // walk a fresh clone runs) and re-pins with the complete bookkeeping.
    const blindPin = blindRepoC.writer_set_pin!;
    ksC.saveRepo(blindRepoC);
    ksC.updateRepo(repoId, { writer_set_pin: { version: blindPin.version, sha256: blindPin.sha256, writers: [...blindPin.writers], pinned_at: blindPin.pinned_at } });
    const legacyRepo = ksC.readRepo(repoId)!;
    assert.equal(legacyRepo.writer_set_pin!.retired_writers, undefined, "the simulated legacy pin genuinely lacks the field");
    assert.deepEqual([...legacyRepo.writer_set_pin!.writers].map((w) => w.writer_key_id), [identityA.signing_fingerprint], "…and has already forgotten B, exactly as a pre-fix client's pin would");
    assert.equal(legacyRepo.head_pin!.generation, rotated.generation);
    assert.equal(legacyRepo.materialized_pin!.generation, gen5.generation);

    const legacyVault = GitvaultVault.open({ keystore: ksC, transport, repo_id: repoId, repo_dir: null });
    const mC3 = await legacyVault.materialize();
    assert.equal(mC3.generation, rotated.generation, "the legacy-pin re-walk succeeds instead of refusing CHAIN_UNUSABLE");
    assert.deepEqual(mC3.refs, { "refs/heads/main": c2 });
    assert.deepEqual(
      [...(ksC.readRepo(repoId)!.writer_set_pin!.retired_writers ?? [])],
      [{ writer_key_id: identityB.signing_fingerprint, signing_pubkey: identityB.signing_pubkey }],
      "…and re-pins with retired_writers populated, so the next call takes the fast path again",
    );
  });
});
