/**
 * gitvault keystore (task 5.2) — layout, permissions, atomic writes, locks,
 * the audit log, and the §5.1 partial-loss transitions. Every test runs in a
 * temp root; the host user's real keystore is never touched.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitvaultKeystore, getGitvaultKeystoreRoot, writeFileAtomic0600 } from "./gitvault-keystore.js";
import {
  GITVAULT_GENESIS_EPOCH,
  GITVAULT_TERMINAL_LOSS_STATEMENT,
  buildRecoveryReceipt,
  buildVaultGenesis,
  bytesToHex,
  ekFingerprint,
  generateEncryptionKeypair,
  generateSigningKeypair,
  hexToBytes,
  sealKeyEnvelope,
  storedBytesSha256,
  vkFingerprint,
} from "../namespaces/gitvault.crypto.js";
import type { GitvaultSignedObject } from "../namespaces/gitvault.types.js";
import { LocalError } from "../errors.js";

let root: string;
const originalConfigDir = process.env.RUN402_CONFIG_DIR;
const REPO = `src_${"1".repeat(32)}`;
const fixedNow = () => new Date("2026-08-22T12:00:00.000Z");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "run402-gitvault-ks-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (originalConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = originalConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

async function sealedVault(ks: GitvaultKeystore) {
  const identity = ks.ensureIdentity();
  const signer = ks.signingKeypair(identity)!;
  const recipient = ks.encryptionKeypair(identity)!;
  const kRepo = hexToBytes("6aa22dbd1e63f523e006e117a4d6bb1c14b09da3c55fa179388a947c9931a6cd");
  const sealed = await sealKeyEnvelope({ k_repo: kRepo, repo_id: REPO, epoch: GITVAULT_GENESIS_EPOCH, recipient_public_key: recipient.public_key, signer, created_at: "2026-08-22T12:00:00.000Z" });
  const genesis = buildVaultGenesis({ repo_id: REPO, org_id: "o", project_id: "p", allocation_nonce: "f".repeat(32), creator_signing: signer, creator_encryption_public_key: recipient.public_key, envelope_receipt: sealed.receipt, created_at: "2026-08-22T12:00:00.000Z" });
  const genesisSha = storedBytesSha256(genesis as unknown as GitvaultSignedObject);
  const receipt = buildRecoveryReceipt({ repo_id: REPO, org_id: "o", project_id: "p", genesis_sha256: genesisSha, creator_signing: signer, creator_encryption_public_key: recipient.public_key });
  return { identity, signer, recipient, kRepo, envelope: sealed.envelope, genesis, genesisSha, receipt };
}

describe("gitvault keystore — layout + discipline", () => {
  it("defaults to <config dir>/gitvault and honors RUN402_CONFIG_DIR", () => {
    process.env.RUN402_CONFIG_DIR = root;
    assert.equal(getGitvaultKeystoreRoot(), join(root, "gitvault"));
  });

  it("open() creates 0700 directories; identity.json is 0600 and idempotent", () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    for (const d of [ks.rootDir, ks.reposDir, ks.receiptsDir, ks.journalDir]) assert.equal(mode(d), 0o700, d);
    const a = ks.ensureIdentity();
    const b = ks.ensureIdentity();
    assert.deepEqual(a, b);
    assert.equal(mode(ks.identityPath), 0o600);
    assert.match(a.signing_fingerprint, /^vk_[0-9a-f]{32}$/);
    assert.match(a.encryption_fingerprint, /^ek_[0-9a-f]{32}$/);
    const signer = ks.signingKeypair(a)!;
    assert.equal(vkFingerprint(signer.public_key), a.signing_fingerprint);
    assert.equal(ekFingerprint(ks.encryptionKeypair(a)!.public_key), a.encryption_fingerprint);
    const events = ks.readAuditLog().map((e) => e.event);
    assert.deepEqual(events, ["keystore_opened", "identity_created"]);
    assert.equal(mode(ks.auditLogPath), 0o600);
  });

  it("writes are atomic (no partial file is ever visible) and refuse symlinks", () => {
    const target = join(root, "a.json");
    writeFileAtomic0600(target, '{"ok":true}');
    assert.equal(readFileSync(target, "utf8"), '{"ok":true}');
    assert.equal(mode(target), 0o600);
    // no temp files left behind
    assert.deepEqual(readdirNoTmp(root), ["a.json"]);
    const link = join(root, "link.json");
    symlinkSync(target, link);
    assert.throws(() => writeFileAtomic0600(link, "{}"), (e: unknown) => e instanceof LocalError && e.code === "GITVAULT_KEYSTORE_SYMLINK");
  });

  it("the permission audit names a world-readable identity and a symlinked repo file", () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    ks.ensureIdentity();
    chmodSync(ks.identityPath, 0o644);
    const findings = ks.auditPermissions();
    assert.ok(findings.some((f) => f.path === ks.identityPath && f.problem === "world_or_group_accessible"), JSON.stringify(findings));
    assert.ok(ks.readAuditLog().some((e) => e.event === "permission_finding"));
    assert.throws(() => GitvaultKeystore.open({ rootDir: root, strictPermissions: true }), (e: unknown) => e instanceof LocalError && e.code === "GITVAULT_KEYSTORE_PERMISSIONS");
    chmodSync(ks.identityPath, 0o600);
    const real = join(root, "elsewhere.json");
    writeFileSync(real, "{}");
    symlinkSync(real, ks.repoPath(REPO));
    assert.ok(ks.auditPermissions().some((f) => f.problem === "symlink"));
    assert.throws(() => ks.readRepo(REPO), (e: unknown) => e instanceof LocalError && e.code === "GITVAULT_KEYSTORE_SYMLINK");
  });
});

describe("gitvault keystore — repo files + locks", () => {
  it("saveRepo/readRepo/updateRepo round-trip under the per-repo lock and are audited", () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    const saved = ks.saveRepo({ repo_id: REPO, org_id: "o", project_id: "p", k_repo_hex: "00".repeat(32), epoch: GITVAULT_GENESIS_EPOCH, genesis_sha256: "a".repeat(64), head_pin: null, last_ref_transaction: null, provenance: "created" });
    assert.equal(saved.version, 1);
    assert.deepEqual(ks.readRepo(REPO), saved);
    assert.equal(mode(ks.repoPath(REPO)), 0o600);
    const updated = ks.updateRepo(REPO, { head_pin: { generation: "0000000000000001", head_sha256: "b".repeat(64), pinned_at: "2026-08-22T12:00:00.000Z" } });
    assert.equal(ks.readRepo(REPO)!.head_pin!.generation, "0000000000000001");
    assert.equal(updated.k_repo_hex, "00".repeat(32));
    assert.deepEqual(ks.listRepoIds(), [REPO]);
    assert.ok(!existsSync(`${ks.repoPath(REPO)}.lock`), "lock released");
    const events = ks.readAuditLog().map((e) => e.event);
    assert.ok(events.includes("lock_acquired") && events.includes("lock_released") && events.includes("repo_saved"));
  });

  it("withRepoLock is re-entrant, times out on a live foreign lock, and reclaims a stale one", () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    const nested = ks.withRepoLock(REPO, () => ks.withRepoLock(REPO, () => "inner"));
    assert.equal(nested, "inner");
    const lockDir = `${ks.repoPath(REPO)}.lock`;
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, at: "now" }));
    assert.throws(() => ks.withRepoLock(REPO, () => 1, { timeoutMs: 60, staleAfterMs: 60_000 }), (e: unknown) => e instanceof LocalError && e.code === "GITVAULT_KEYSTORE_LOCKED");
    // stale: old mtime → reclaimed
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lockDir, old, old);
    assert.equal(ks.withRepoLock(REPO, () => 2, { timeoutMs: 500, staleAfterMs: 1_000 }), 2);
    assert.ok(ks.readAuditLog().some((e) => e.event === "lock_stale_reclaimed"));
    // dead owner pid → reclaimed regardless of age
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: 2 ** 22 - 1, at: "now" }));
    assert.equal(ks.withRepoLock(REPO, () => 3, { timeoutMs: 500 }), 3);
  });
});

describe("gitvault keystore — §5.1 transitions", () => {
  it("whole-keystore loss is VAULT_UNRECOVERABLE with the verbatim statement", () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    const s = ks.assess(REPO);
    assert.equal(s.state, "unrecoverable");
    if (s.state === "unrecoverable") {
      assert.equal(s.code, "VAULT_UNRECOVERABLE");
      assert.equal(s.statement, GITVAULT_TERMINAL_LOSS_STATEMENT);
      assert.match(s.doctor_text, /terminal for vault history \(VAULT_UNRECOVERABLE\) until human envelopes ship/);
      assert.doesNotMatch(s.doctor_text, /receipt (can|will) decrypt/);
    }
  });

  it("repo file lost + identity intact → restore K_repo from the principal's own envelope (trusted via receipt)", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    const v = await sealedVault(ks);
    ks.saveRecoveryReceipt(v.receipt);
    assert.equal(ks.assess(REPO).state, "repo_state_lost_identity_intact");
    const { repo, trust } = await ks.restoreRepoFromEnvelope({ genesis: v.genesis, envelope: v.envelope });
    assert.equal(trust, "receipt");
    assert.equal(repo.k_repo_hex, bytesToHex(v.kRepo));
    assert.equal(repo.genesis_sha256, v.genesisSha);
    assert.equal(repo.provenance, "restored_from_envelope");
    assert.equal(ks.assess(REPO).state, "ready");
    assert.ok(ks.readAuditLog().some((e) => e.event === "repo_restored_from_envelope"));
  });

  it("a restore without any receipt or pin is labeled unauthenticated salvage; a substituted vault is refused", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    const v = await sealedVault(ks);
    const { trust } = await ks.restoreRepoFromEnvelope({ genesis: v.genesis, envelope: v.envelope });
    assert.equal(trust, "unauthenticated_salvage");
    // fabricated vault: a receipt pinning OTHER genesis bytes
    unlinkSync(ks.repoPath(REPO));
    const other = buildVaultGenesis({ repo_id: REPO, org_id: "o", project_id: "p", allocation_nonce: "e".repeat(32), creator_signing: v.signer, creator_encryption_public_key: v.recipient.public_key, envelope_receipt: v.genesis.envelopes[0]!, created_at: "2026-08-22T12:00:01.000Z" });
    const badReceipt = buildRecoveryReceipt({ repo_id: REPO, org_id: "o", project_id: "p", genesis_sha256: storedBytesSha256(other as unknown as GitvaultSignedObject), creator_signing: v.signer, creator_encryption_public_key: v.recipient.public_key });
    await assert.rejects(ks.restoreRepoFromEnvelope({ genesis: v.genesis, envelope: v.envelope, recovery_receipt: badReceipt }), (e: unknown) => e instanceof LocalError && e.code === "VAULT_CREATION_CONFLICT");
    assert.equal(ks.readRepo(REPO), null, "nothing written on refusal");
  });

  it("signing key lost with K_repo held → read_only; stale pin → reverify", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    const v = await sealedVault(ks);
    ks.saveRepo({ repo_id: REPO, org_id: "o", project_id: "p", k_repo_hex: bytesToHex(v.kRepo), epoch: GITVAULT_GENESIS_EPOCH, genesis_sha256: v.genesisSha, head_pin: null, last_ref_transaction: null, provenance: "created" });
    assert.equal(ks.assess(REPO, v.genesisSha).state, "ready");
    assert.equal(ks.assess(REPO, "0".repeat(64)).state, "stale_pin");
    const identity = JSON.parse(readFileSync(ks.identityPath, "utf8"));
    delete identity.signing_seed_hex;
    writeFileSync(ks.identityPath, JSON.stringify(identity), { mode: 0o600 });
    const s = ks.assess(REPO);
    assert.equal(s.state, "read_only");
    assert.equal(ks.signingKeypair(), null);
    assert.equal(ks.identitySummary()!.signing_key_present, false);
    // ensureIdentity never "repairs" a partial identity by minting a new seed
    assert.equal(ks.ensureIdentity().signing_seed_hex, undefined);
  });

  it("a tampered identity (seed ≠ fingerprint) is reported as corrupt, never silently used", () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    const id = ks.ensureIdentity();
    const other = generateSigningKeypair();
    writeFileSync(ks.identityPath, JSON.stringify({ ...id, signing_seed_hex: bytesToHex(other.seed) }), { mode: 0o600 });
    assert.throws(() => ks.signingKeypair(), (e: unknown) => e instanceof LocalError && e.code === "GITVAULT_KEYSTORE_CORRUPT");
    const enc = generateEncryptionKeypair();
    writeFileSync(ks.identityPath, JSON.stringify({ ...id, encryption_private_key_hex: bytesToHex(enc.private_key) }), { mode: 0o600 });
    assert.throws(() => ks.encryptionKeypair(), (e: unknown) => e instanceof LocalError && e.code === "GITVAULT_KEYSTORE_CORRUPT");
  });
});

function readdirNoTmp(dir: string): string[] {
  return readdirSync(dir).filter((n) => !n.startsWith("."));
}
