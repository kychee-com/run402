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
import { GitvaultKeystore, getGitvaultKeystoreRoot, writeFileAtomic0600, GITVAULT_OBJECT_STORE_ORIGINS_CAP } from "./gitvault-keystore.js";
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
  toBase64url,
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

describe("gitvault keystore — recordObjectStoreOrigins (gitvault-object-host-predial task 1.2)", () => {
  function freshKs() {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    ks.saveRepo({ repo_id: REPO, org_id: "o", project_id: "p", k_repo_hex: "00".repeat(32), epoch: GITVAULT_GENESIS_EPOCH, genesis_sha256: "a".repeat(64), head_pin: null, last_ref_transaction: null, provenance: "created" });
    return ks;
  }

  it("a repo file with nothing recorded yet reads back `undefined` — byte-identical to before this field existed", () => {
    const ks = freshKs();
    assert.equal(ks.readRepo(REPO)!.object_store_origins, undefined);
  });

  it("persists the first observed origin(s)", () => {
    const ks = freshKs();
    ks.recordObjectStoreOrigins(REPO, ["https://bucket.s3.amazonaws.com", "https://edge.run402.com"]);
    assert.deepEqual(ks.readRepo(REPO)!.object_store_origins, ["https://bucket.s3.amazonaws.com", "https://edge.run402.com"]);
  });

  it("re-observing the SAME set is a true no-op — no write, `updated_at` untouched", () => {
    const ks = freshKs();
    ks.recordObjectStoreOrigins(REPO, ["https://bucket.s3.amazonaws.com"]);
    const before = ks.readRepo(REPO)!;
    ks.recordObjectStoreOrigins(REPO, ["https://bucket.s3.amazonaws.com"]);
    const after = ks.readRepo(REPO)!;
    assert.deepEqual(after, before);
    assert.equal(after.updated_at, before.updated_at);
  });

  it("a newly observed origin moves to the front; the previously-known one survives, deduped", () => {
    const ks = freshKs();
    ks.recordObjectStoreOrigins(REPO, ["https://old.example.com"]);
    ks.recordObjectStoreOrigins(REPO, ["https://new.example.com"]);
    assert.deepEqual(ks.readRepo(REPO)!.object_store_origins, ["https://new.example.com", "https://old.example.com"]);
    // re-observing the OLD one again just re-orders — nothing is ever lost short of the cap
    ks.recordObjectStoreOrigins(REPO, ["https://old.example.com"]);
    assert.deepEqual(ks.readRepo(REPO)!.object_store_origins, ["https://old.example.com", "https://new.example.com"]);
  });

  it("caps at GITVAULT_OBJECT_STORE_ORIGINS_CAP, evicting the least-recently-observed", () => {
    const ks = freshKs();
    for (let i = 0; i < GITVAULT_OBJECT_STORE_ORIGINS_CAP + 2; i += 1) ks.recordObjectStoreOrigins(REPO, [`https://origin-${i}.example.com`]);
    const origins = ks.readRepo(REPO)!.object_store_origins!;
    assert.equal(origins.length, GITVAULT_OBJECT_STORE_ORIGINS_CAP);
    // most-recently-observed survive; the earliest ones were evicted
    assert.deepEqual(origins, [`https://origin-${GITVAULT_OBJECT_STORE_ORIGINS_CAP + 1}.example.com`, `https://origin-${GITVAULT_OBJECT_STORE_ORIGINS_CAP}.example.com`, `https://origin-${GITVAULT_OBJECT_STORE_ORIGINS_CAP - 1}.example.com`, `https://origin-${GITVAULT_OBJECT_STORE_ORIGINS_CAP - 2}.example.com`]);
  });

  it("an empty observation is a no-op", () => {
    const ks = freshKs();
    ks.recordObjectStoreOrigins(REPO, []);
    assert.equal(ks.readRepo(REPO)!.object_store_origins, undefined);
  });

  it("a missing repo file is swallowed — never throws (best-effort learning, D4)", () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    assert.doesNotThrow(() => ks.recordObjectStoreOrigins(REPO, ["https://bucket.s3.amazonaws.com"]));
    assert.equal(ks.readRepo(REPO), null);
  });

  it("saveRepo/readRepo tolerate a HAND-WRITTEN repo file that already carries the field — additive-schema forward compat", () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    const saved = ks.saveRepo({ repo_id: REPO, org_id: "o", project_id: "p", k_repo_hex: "00".repeat(32), epoch: GITVAULT_GENESIS_EPOCH, genesis_sha256: "a".repeat(64), head_pin: null, last_ref_transaction: null, provenance: "created", object_store_origins: ["https://pre-existing.example.com"] });
    assert.deepEqual(saved.object_store_origins, ["https://pre-existing.example.com"]);
    assert.deepEqual(ks.readRepo(REPO)!.object_store_origins, ["https://pre-existing.example.com"]);
  });
});

describe("gitvault keystore — findRepoByProject (gitvault-offline-clone-resolve task 1.1)", () => {
  const REPO_A = `src_${"a".repeat(32)}`;
  const REPO_B = `src_${"b".repeat(32)}`;

  function repo(overrides: Partial<Parameters<GitvaultKeystore["saveRepo"]>[0]>) {
    return {
      repo_id: REPO_A,
      org_id: "org_1",
      project_id: "prj_1",
      k_repo_hex: "00".repeat(32),
      epoch: GITVAULT_GENESIS_EPOCH,
      genesis_sha256: "a".repeat(64),
      head_pin: null,
      last_ref_transaction: null,
      provenance: "created" as const,
      ...overrides,
    };
  }

  it("finds a repo file whose project_id matches", () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    ks.saveRepo(repo({}));
    const found = ks.findRepoByProject("prj_1");
    assert.equal(found?.repo_id, REPO_A);
  });

  it("no matching project_id anywhere → null (never throws)", () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    ks.saveRepo(repo({}));
    assert.equal(ks.findRepoByProject("prj_nonexistent"), null);
  });

  it("an empty keystore (no repos/ directory yet) → null", () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    assert.equal(ks.findRepoByProject("prj_1"), null);
  });

  it("org_id, when supplied, is a hard filter — a project_id match under a DIFFERENT org is a miss, never a guess", () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    ks.saveRepo(repo({ org_id: "org_1", project_id: "prj_1" }));
    assert.equal(ks.findRepoByProject("prj_1", "org_1")?.repo_id, REPO_A);
    assert.equal(ks.findRepoByProject("prj_1", "org_OTHER"), null, "mismatched org must miss, not guess");
    assert.equal(ks.findRepoByProject("prj_1")?.repo_id, REPO_A, "omitting org_id still matches on project_id alone");
  });

  it("a corrupt repo file is skipped silently, not thrown", () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    ks.saveRepo(repo({ repo_id: REPO_B, project_id: "prj_1" }));
    // Hand-corrupt REPO_A's file (wrong version) without ever creating it
    // through saveRepo — mirrors a partially-written or foreign-tool file.
    writeFileSync(ks.repoPath(REPO_A), JSON.stringify({ version: 2, repo_id: REPO_A, project_id: "prj_1" }));
    assert.doesNotThrow(() => ks.findRepoByProject("prj_1"));
    assert.equal(ks.findRepoByProject("prj_1")?.repo_id, REPO_B, "the corrupt file is skipped; the valid match still answers");
  });

  it("multiple repo files matching the same project — the most-recently-modified file wins", () => {
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    ks.saveRepo(repo({ repo_id: REPO_A, project_id: "prj_1" }));
    ks.saveRepo(repo({ repo_id: REPO_B, project_id: "prj_1" }));
    // Force an unambiguous mtime order — REPO_A older, REPO_B newer — since
    // two back-to-back synchronous writes can otherwise share a filesystem
    // mtime tick on some filesystems.
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    utimesSync(ks.repoPath(REPO_A), older, older);
    utimesSync(ks.repoPath(REPO_B), newer, newer);
    assert.equal(ks.findRepoByProject("prj_1")?.repo_id, REPO_B);
    // Touch REPO_A again (a re-save, as a re-vaulted project's old file being
    // re-touched would do) — it should now win instead.
    const newest = new Date(Date.now() + 60_000);
    utimesSync(ks.repoPath(REPO_A), newest, newest);
    assert.equal(ks.findRepoByProject("prj_1")?.repo_id, REPO_A);
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

  it("rev 47: a MEMBER's envelope wrapped by an ADMITTED non-genesis writer restores; without the admitted set it is refused as stored_envelope_created_by", async () => {
    // creator (genesis writer) = ks; a second admitted writer = ks2; the restoring member = ks3 (its own recipient key).
    const ks = GitvaultKeystore.open({ rootDir: root, now: fixedNow });
    const v = await sealedVault(ks);
    const ks2 = GitvaultKeystore.open({ rootDir: mkdtempSync(join(tmpdir(), "run402-ks2-")), now: fixedNow });
    const writer2 = ks2.signingKeypair(ks2.ensureIdentity())!;
    const ks3 = GitvaultKeystore.open({ rootDir: mkdtempSync(join(tmpdir(), "run402-ks3-")), now: fixedNow });
    const member = ks3.encryptionKeypair(ks3.ensureIdentity())!;
    const wrapped = await sealKeyEnvelope({ k_repo: v.kRepo, repo_id: REPO, epoch: GITVAULT_GENESIS_EPOCH, recipient_public_key: member.public_key, signer: writer2, created_at: "2026-09-04T00:00:00.000Z" });
    const admitted = [{ writer_key_id: vkFingerprint(writer2.public_key), signing_pubkey: toBase64url(writer2.public_key) }];
    await assert.rejects(
      ks3.restoreRepoFromEnvelope({ genesis: v.genesis, envelope: wrapped.envelope }),
      (e: unknown) => e instanceof LocalError && e.code === "VAULT_CREATION_CONFLICT" && JSON.stringify(e.details).includes("stored_envelope_created_by"),
    );
    const { repo } = await ks3.restoreRepoFromEnvelope({ genesis: v.genesis, envelope: wrapped.envelope, admitted_writers: admitted });
    assert.equal(repo.k_repo_hex, bytesToHex(v.kRepo));
    assert.equal(repo.provenance, "restored_from_envelope");
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
