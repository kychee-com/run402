/**
 * gitvault-agent-envelopes design D4 — the COLD OPEN, against the in-memory
 * transport fixture: a second keystore that is a directory recipient but has
 * no repo file for the vault (1) fails `GITVAULT_ENVELOPE_PENDING` with the
 * key-holders named while nobody has wrapped it, (2) restores `K_repo` from
 * its OWN envelope once the creator's reconcile has wrapped it — labelled
 * `platform_attested` / `first_seen` / `independently_verified: false`
 * (the fixture's signed allocation vouches for genesis; no receipt is held)
 * — and can then open + verify the chain like any reader, (3) is a no-op on
 * the next open (repo file present → `null`), and (4) refuses a genesis that
 * differs from the one it pinned.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalError } from "../errors.js";
import { toBase64url } from "../namespaces/gitvault.crypto.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { GitvaultVault } from "./gitvault-publication.js";
import { makeVault } from "./gitvault-memory-transport.test.js";

async function rejectsCode(p: Promise<unknown>, code: string): Promise<LocalError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof LocalError, `expected LocalError, got ${String(e)}`);
    assert.equal(e.code, code);
    return e;
  }
  assert.fail(`expected rejection ${code}`);
}

describe("GitvaultVault.ensureRepoState — cold open from own envelope (gitvault-agent-envelopes D4)", () => {
  it("pending until wrapped → restored platform_attested/first_seen → no-op thereafter", async () => {
    const a = await makeVault();
    // B: a second keystore with its own identity, directory-listed as an
    // agent member of the org, but no repo file for this vault.
    const bRoot = mkdtempSync(join(tmpdir(), "gitvault-cold-open-b-"));
    const bKeystore = GitvaultKeystore.open({ rootDir: bRoot });
    const bIdentity = bKeystore.ensureIdentity();
    a.transport.orgEncryptionKeys.set("org_1", [
      { principal_id: "principal_b", display_name: "0xbeef", public_key: bIdentity.encryption_pubkey, ek_fingerprint: bIdentity.encryption_fingerprint, suite: "r402s-1", created_at: "2026-08-30T00:00:00.000Z" },
    ]);

    // (1) Nobody has wrapped B yet.
    const pending = await rejectsCode(
      GitvaultVault.openOrRestore({ keystore: bKeystore, transport: a.transport, repo_id: a.repoId }),
      "GITVAULT_ENVELOPE_PENDING",
    );
    const d = pending.details as { own_fingerprint: string; key_holders: Array<{ principal_id: string }>; covering_recipient_count: number };
    assert.equal(d.own_fingerprint, bIdentity.encryption_fingerprint);
    assert.ok(d.covering_recipient_count >= 1, "the creator's own genesis envelope covers the vault");
    assert.equal(bKeystore.readRepo(a.repoId), null, "nothing written to B's keystore on a pending verdict");

    // The creator's next ordinary operation wraps B (D5).
    const reconciled = await a.vault.reconcileEnvelopeRecipients();
    assert.deepEqual(reconciled.wrapped.map((w) => w.principal_id), ["principal_b"]);

    // (2) B restores from its own envelope.
    const opened = await GitvaultVault.openOrRestore({ keystore: bKeystore, transport: a.transport, repo_id: a.repoId });
    assert.ok(opened.restored, "a cold keystore restores");
    assert.equal(opened.restored!.provenance, "restored_from_envelope");
    assert.equal(opened.restored!.trust, "platform_attested");
    assert.equal(opened.restored!.continuity, "first_seen");
    assert.equal(opened.restored!.independently_verified, false);
    assert.equal(opened.restored!.recipient_fingerprint, bIdentity.encryption_fingerprint);
    const bRepo = bKeystore.readRepo(a.repoId);
    assert.ok(bRepo);
    assert.equal(bRepo!.provenance, "restored_from_envelope");
    assert.equal(bRepo!.k_repo_hex, a.keystore.readRepo(a.repoId)!.k_repo_hex, "B holds the SAME K_repo the creator holds");
    assert.equal(bRepo!.genesis_sha256, a.keystore.readRepo(a.repoId)!.genesis_sha256, "genesis pinned to the creator's genesis");
    // …and reads the vault like any recipient.
    const state = await opened.vault.verifyToNewest({ persist: false, decryptValidate: true, strict: true });
    assert.equal(state.generation, a.keystore.readRepo(a.repoId)!.head_pin?.generation ?? state.generation);

    // (3) A later open is a plain open — nothing to restore.
    const again = await GitvaultVault.openOrRestore({ keystore: bKeystore, transport: a.transport, repo_id: a.repoId });
    assert.equal(again.restored, null);
  });

  it("refuses a genesis whose creator keys disagree with the signed allocation (substituted genesis)", async () => {
    const a = await makeVault();
    const bRoot = mkdtempSync(join(tmpdir(), "gitvault-cold-open-sub-"));
    const bKeystore = GitvaultKeystore.open({ rootDir: bRoot });
    const bIdentity = bKeystore.ensureIdentity();
    a.transport.orgEncryptionKeys.set("org_1", [
      { principal_id: "principal_b", display_name: null, public_key: bIdentity.encryption_pubkey, ek_fingerprint: bIdentity.encryption_fingerprint, suite: "r402s-1", created_at: "2026-08-30T00:00:00.000Z" },
    ]);
    await a.vault.reconcileEnvelopeRecipients();
    // Tamper the control plane's allocation record so it names a different
    // creator encryption key than the served genesis carries.
    const alloc = [...a.transport.allocations.values()].find((x) => x.repo_id === a.repoId)!;
    (alloc as { creator_encryption_fingerprint: string }).creator_encryption_fingerprint = `ek_${"f".repeat(32)}`;
    await rejectsCode(GitvaultVault.openOrRestore({ keystore: bKeystore, transport: a.transport, repo_id: a.repoId }), "VAULT_CREATION_CONFLICT");
    assert.equal(bKeystore.readRepo(a.repoId), null, "nothing written on a refused anchor");
    void toBase64url;
  });
});
