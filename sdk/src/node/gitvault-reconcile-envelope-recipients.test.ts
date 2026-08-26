/**
 * gitvault-human-envelopes task 4.1 — the ADD-path workaround's unit
 * coverage. Exercises `GitvaultVault.reconcileEnvelopeRecipients` against
 * the in-memory transport fixture (`gitvault-memory-transport.test.ts`):
 * the missing-recipient wrap (with a full HPKE round-trip proving the
 * sealed envelope actually opens to the vault's own `K_repo`), TOFU pinning
 * + the pinned-key-mismatch refusal (design D4 point 3), the two
 * data-quality skip reasons (`missing_public_key` / `invalid_public_key`),
 * idempotency on a second call, the benign-race tolerance on a create-only
 * conflict, and the `GITVAULT_READ_ONLY` refusal for a principal with no
 * local signing key.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { LocalError } from "../errors.js";
import {
  GITVAULT_GENESIS_EPOCH,
  bytesToHex,
  ekFingerprint,
  generateEncryptionKeypair,
  openKeyEnvelope,
  parseGitvaultStrict,
  toBase64url,
} from "../namespaces/gitvault.crypto.js";
import type { GitvaultKeyEnvelope } from "../namespaces/gitvault.types.js";
import { gitvaultPaths, type GitvaultOrgEncryptionKeyEntry } from "./gitvault-publication.js";
import { makeVault } from "./gitvault-memory-transport.test.js";

function codeOf(e: unknown): string {
  assert.ok(e instanceof LocalError, `expected LocalError, got ${String(e)}`);
  return e.code ?? "no-code";
}
async function rejectsCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert.equal(codeOf(e), code);
    return;
  }
  assert.fail(`expected ${code}, nothing thrown`);
}

function principalEntry(entry: { principal_id: string; ek_fingerprint: string; public_key?: string }): GitvaultOrgEncryptionKeyEntry {
  return { display_name: null, suite: "r402s-1", created_at: "2026-08-26T00:00:00.000Z", ...entry };
}

describe("GitvaultVault.reconcileEnvelopeRecipients — gitvault-human-envelopes task 4.1", () => {
  it("wraps a missing recipient and leaves an already-covered one alone; the sealed envelope opens to the SAME K_repo the vault holds", async () => {
    const v = await makeVault();
    const creatorIdentity = v.keystore.ensureIdentity();
    const b = generateEncryptionKeypair();
    const bFp = ekFingerprint(b.public_key);
    v.transport.orgEncryptionKeys.set("org_1", [
      // The genesis creator IS already an envelope recipient (their own
      // genesis envelope) — a directory listing them should be a no-op.
      // `encryption_pubkey` on the identity file is ALREADY base64url —
      // no decode/re-encode needed.
      principalEntry({ principal_id: "principal_creator", ek_fingerprint: creatorIdentity.encryption_fingerprint, public_key: creatorIdentity.encryption_pubkey }),
      principalEntry({ principal_id: "principal_b", ek_fingerprint: bFp, public_key: toBase64url(b.public_key) }),
    ]);

    const result = await v.vault.reconcileEnvelopeRecipients();

    assert.equal(result.repo_id, v.repoId);
    assert.equal(result.org_id, "org_1");
    assert.equal(result.epoch, GITVAULT_GENESIS_EPOCH);
    assert.deepEqual(result.wrapped, [{ principal_id: "principal_b", ek_fingerprint: bFp }]);
    assert.deepEqual(result.skipped, []);
    assert.ok(result.already_covered.includes(creatorIdentity.encryption_fingerprint), "the creator's own envelope was already there — no wrap needed");

    // Round-trip: B can open the freshly-wrapped envelope and recovers the
    // EXACT K_repo bytes this vault's keystore holds.
    const bytes = await v.transport.getObject({ repo_id: v.repoId, path: gitvaultPaths.envelope(result.epoch, bFp) });
    assert.ok(bytes, "the envelope was actually uploaded via the generic create-only route");
    const envelope = parseGitvaultStrict(new TextDecoder().decode(bytes!)) as GitvaultKeyEnvelope;
    assert.equal(envelope.object_kind, "key_envelope");
    assert.equal(envelope.recipient_fingerprint, bFp);
    assert.equal(envelope.repo_id, v.repoId);
    assert.equal(envelope.epoch, GITVAULT_GENESIS_EPOCH);
    const genesis = (await v.vault.genesis()).genesis;
    // In this fixture the same principal both created the genesis AND ran
    // reconcile, so `created_by` on the new envelope equals the genesis's
    // own `writer_key_id` — its public key is what verifies the signature.
    assert.equal(envelope.created_by, genesis.writer_key_id);
    const kRepo = await openKeyEnvelope({ envelope, recipient: b, signer_public_key: genesis.creator_signing_pubkey });
    const repoFile = v.keystore.readRepo(v.repoId)!;
    assert.equal(bytesToHex(kRepo), repoFile.k_repo_hex, "B recovers the SAME K_repo the vault's own keystore holds");

    // The pin was set for the freshly-wrapped recipient.
    assert.deepEqual(v.keystore.readRepo(v.repoId)!.envelope_recipient_pins, { principal_b: bFp });
  });

  it("pins a recipient's fingerprint at first wrap (TOFU), and REFUSES — never silently re-wraps — when the directory later names a different key for the same principal_id", async () => {
    const v = await makeVault();
    const b1 = generateEncryptionKeypair();
    const b1Fp = ekFingerprint(b1.public_key);
    v.transport.orgEncryptionKeys.set("org_1", [principalEntry({ principal_id: "principal_b", ek_fingerprint: b1Fp, public_key: toBase64url(b1.public_key) })]);

    const first = await v.vault.reconcileEnvelopeRecipients();
    assert.equal(first.wrapped.length, 1);
    assert.deepEqual(v.keystore.readRepo(v.repoId)!.envelope_recipient_pins, { principal_b: b1Fp });

    // B's key "rotates": the directory now names a DIFFERENT public key for
    // the SAME principal_id, and the vault has no envelope at the new
    // fingerprint's path — so this would otherwise look like a plain
    // missing recipient.
    const b2 = generateEncryptionKeypair();
    const b2Fp = ekFingerprint(b2.public_key);
    v.transport.orgEncryptionKeys.set("org_1", [principalEntry({ principal_id: "principal_b", ek_fingerprint: b2Fp, public_key: toBase64url(b2.public_key) })]);

    const second = await v.vault.reconcileEnvelopeRecipients();
    assert.deepEqual(second.wrapped, []);
    assert.equal(second.skipped.length, 1);
    assert.equal(second.skipped[0]!.principal_id, "principal_b");
    assert.equal(second.skipped[0]!.reason, "pinned_key_mismatch");
    assert.deepEqual(second.skipped[0]!.details, { pinned_fingerprint: b1Fp, directory_fingerprint: b2Fp });

    // Nothing was ever wrapped under the new key.
    const bytes = await v.transport.getObject({ repo_id: v.repoId, path: gitvaultPaths.envelope(second.epoch, b2Fp) });
    assert.equal(bytes, null);
    // The pin is unchanged — a refusal never advances it.
    assert.deepEqual(v.keystore.readRepo(v.repoId)!.envelope_recipient_pins, { principal_b: b1Fp });
  });

  it("skips a directory entry with no public_key on record (the gateway gap this method is already written to consume once fixed)", async () => {
    const v = await makeVault();
    v.transport.orgEncryptionKeys.set("org_1", [principalEntry({ principal_id: "principal_c", ek_fingerprint: `ek_${"c".repeat(32)}` })]);
    const result = await v.vault.reconcileEnvelopeRecipients();
    assert.deepEqual(result.wrapped, []);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]!.principal_id, "principal_c");
    assert.equal(result.skipped[0]!.reason, "missing_public_key");
  });

  it("skips a directory entry whose printed fingerprint disagrees with its own public_key — corrupt data, never sealed under a mismatched label", async () => {
    const v = await makeVault();
    const real = generateEncryptionKeypair();
    const wrongFp = `ek_${"d".repeat(32)}`;
    v.transport.orgEncryptionKeys.set("org_1", [principalEntry({ principal_id: "principal_d", ek_fingerprint: wrongFp, public_key: toBase64url(real.public_key) })]);
    const result = await v.vault.reconcileEnvelopeRecipients();
    assert.deepEqual(result.wrapped, []);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]!.reason, "invalid_public_key");
    assert.equal(result.skipped[0]!.details?.derived_fingerprint, ekFingerprint(real.public_key));
  });

  it("a second call is idempotent — an already-wrapped recipient reports already_covered, never a duplicate wrap", async () => {
    const v = await makeVault();
    const b = generateEncryptionKeypair();
    const bFp = ekFingerprint(b.public_key);
    v.transport.orgEncryptionKeys.set("org_1", [principalEntry({ principal_id: "principal_b", ek_fingerprint: bFp, public_key: toBase64url(b.public_key) })]);
    // makeVault()'s own genesis creation already issued one "upload:" call
    // (the creator's own envelope) — count the DELTA this reconcile call
    // itself produces, not an absolute total.
    const uploadsBefore = v.transport.calls.filter((c) => c.startsWith("upload:")).length;
    const first = await v.vault.reconcileEnvelopeRecipients();
    assert.equal(first.wrapped.length, 1);
    assert.equal(v.transport.calls.filter((c) => c.startsWith("upload:")).length, uploadsBefore + 1);

    const second = await v.vault.reconcileEnvelopeRecipients();
    assert.deepEqual(second.wrapped, []);
    assert.ok(second.already_covered.includes(bFp));
    assert.deepEqual(second.skipped, []);
    // No second upload attempt for a recipient already covered — the
    // fast-path (`covered.has`) skips sealing/uploading entirely.
    assert.equal(v.transport.calls.filter((c) => c.startsWith("upload:")).length, uploadsBefore + 1);
  });

  it("treats a concurrent writer's DIFFERENT valid wrap of the same recipient as a benign race, not a failure (HPKE seal is randomized, so two legitimate wraps never byte-match)", async () => {
    const v = await makeVault();
    const b = generateEncryptionKeypair();
    const bFp = ekFingerprint(b.public_key);
    v.transport.orgEncryptionKeys.set("org_1", [principalEntry({ principal_id: "principal_b", ek_fingerprint: bFp, public_key: toBase64url(b.public_key) })]);
    // A genuine TOCTOU race: the coverage READ (step 1 of reconcile) still
    // reports B as missing, but a CONCURRENT writer's own valid wrap for B
    // has already landed at the exact envelope path by the time THIS
    // call's own PUT gets there — modeled by under-reporting coverage while
    // a competing object already sits in the bucket.
    const realListEnvelopeRecipients = v.transport.listEnvelopeRecipients.bind(v.transport);
    v.transport.listEnvelopeRecipients = async (req: { repo_id: string }) => {
      const real = await realListEnvelopeRecipients(req);
      return { ...real, recipient_fingerprints: real.recipient_fingerprints.filter((fp) => fp !== bFp) };
    };
    v.transport.objects.set(`${v.repoId}/${gitvaultPaths.envelope(GITVAULT_GENESIS_EPOCH, bFp)}`, new TextEncoder().encode(JSON.stringify({ raced: true })));

    const result = await v.vault.reconcileEnvelopeRecipients();
    assert.deepEqual(result.wrapped, []);
    assert.ok(result.already_covered.includes(bFp));
    assert.deepEqual(result.skipped, []);
    // The pin still records — the recipient IS genuinely covered now, just
    // not by bytes this call produced.
    assert.deepEqual(v.keystore.readRepo(v.repoId)!.envelope_recipient_pins, { principal_b: bFp });
  });

  it("GITVAULT_READ_ONLY when this principal holds no local signing key — refused before any network read", async () => {
    const v = await makeVault();
    const identity = JSON.parse(readFileSync(v.keystore.identityPath, "utf8"));
    delete identity.signing_seed_hex;
    writeFileSync(v.keystore.identityPath, JSON.stringify(identity), { mode: 0o600 });
    await rejectsCode(v.vault.reconcileEnvelopeRecipients(), "GITVAULT_READ_ONLY");
    assert.equal(v.transport.calls.filter((c) => c === "org-encryption-keys" || c === "envelope-recipients").length, 0);
  });
});
