/**
 * gitvault six-stage creation journal (task 5.3) — the ordering invariant
 * (ciphertext strictly after allocation), crash-between-stages replay from
 * every stage, read-and-compare (never re-encrypt), foreign-genesis and
 * superseded-allocation refusals, and the terminal-loss doctor text.
 *
 * The control plane is an in-memory transport that records every call so a
 * resumed run can be proved to have NOT re-sealed or re-PUT anything.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import {
  GITVAULT_CREATION_STAGES,
  GitvaultCreation,
  createGitvault,
  findResumableGitvaultJournal,
  gitvaultDoctorRecoveryText,
  listIncompleteGitvaultJournals,
  readGitvaultJournal,
  type GitvaultAdmitGenesisRequest,
  type GitvaultAllocateRequest,
  type GitvaultCreationStage,
  type GitvaultCreationTransport,
  type GitvaultPutObjectRequest,
} from "./gitvault-creation-journal.js";
import {
  GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT,
  GITVAULT_TERMINAL_LOSS_STATEMENT,
  checkGenesisKeyBindings,
  checkRecoveryReceipt,
  ekFingerprint,
  fromBase64url,
  generateSigningKeypair,
  isCanonicalBase64url,
  parseGitvaultStrict,
  sha256Hex,
  signGitvaultObject,
  storedBytesSha256,
  verifyGitvaultObject,
  vkFingerprint,
} from "../namespaces/gitvault.crypto.js";
import type { GitvaultAllocation, GitvaultKeyEnvelope, GitvaultSignedObject, GitvaultVaultGenesis } from "../namespaces/gitvault.types.js";
import { LocalError } from "../errors.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "run402-gitvault-journal-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An in-memory control plane + bucket with call accounting. */
class MemoryTransport implements GitvaultCreationTransport {
  readonly service = generateSigningKeypair();
  readonly objects = new Map<string, Uint8Array>();
  readonly genesis = new Map<string, Uint8Array>();
  readonly calls: string[] = [];
  allocations = new Map<string, GitvaultAllocation>();
  allocationsByRepoId = new Map<string, GitvaultAllocation>();
  /**
   * `"org_id/project_id"` -> `repo_id`, populated the FIRST time a genesis is
   * admitted for that project — simulates the real gateway's allocate route
   * being unique PER PROJECT, not per `client_creation_id`: a brand new
   * `client_creation_id` allocating against an already-completed project
   * 409s here instead of minting a second allocation.
   */
  completedProjects = new Map<string, string>();
  supersedeOnAllocate = false;
  supersedeOnAdmit = false;
  repoCounter = 0;

  /** Every allocate request this transport saw, verbatim — the wire-shape gate reads it. */
  readonly allocateRequests: GitvaultAllocateRequest[] = [];

  async allocate(req: GitvaultAllocateRequest): Promise<GitvaultAllocation> {
    this.calls.push("allocate");
    this.allocateRequests.push(req);
    // The gateway's `validateCreatorKeys`: the request carries raw PUBLIC KEYS,
    // canonical base64url decoding to exactly 32 bytes, and the record's
    // fingerprints are DERIVED here. A fingerprint sent in a pubkey field must
    // fail — that exact substitution reached production once.
    for (const [field, value] of [["creator_signing_pubkey", req.creator_signing_pubkey], ["creator_encryption_pubkey", req.creator_encryption_pubkey]] as const) {
      if (typeof value !== "string" || !isCanonicalBase64url(value) || fromBase64url(value, field).length !== 32) {
        throw new LocalError(`${field} must be a canonical base64url 32-byte public key`, "memory control plane", { code: "VALIDATION_FAILED", details: { field } });
      }
    }
    let a = this.allocations.get(req.client_creation_id);
    if (!a) {
      // Real-gateway behavior: the allocate route is unique PER PROJECT,
      // not per client_creation_id. A
      // brand new attempt against a project that already completed 409s
      // instead of quietly minting a second allocation.
      const projectKey = "org_id" in req ? `${req.org_id}/${req.project_id}` : null;
      const existingRepoId = projectKey ? this.completedProjects.get(projectKey) : undefined;
      if (existingRepoId) {
        throw new LocalError("a vault already exists for this project", "memory control plane allocate", {
          code: "VAULT_CREATION_CONFLICT",
          details: { repo_id: existingRepoId, genesis_exists: true },
          // Mirrors the gateway's own raw envelope shape — the SDK must
          // not depend on the gateway's own next_actions.
          next_actions: [{ type: "edit_request", why: "a foreign genesis exists; adopt it or choose a new project" }],
        });
      }
      this.repoCounter += 1;
      const unsigned = {
        format: "r402s/v0" as const,
        object_kind: "allocation" as const,
        suite: "r402s-1" as const,
        repo_id: `src_${String(this.repoCounter).padStart(32, "0")}`,
        service_key_id: "sk_test-1",
        org_id: req.org_id,
        project_id: req.project_id,
        principal_id: "principal_1",
        creator_signing_fingerprint: vkFingerprint(fromBase64url(req.creator_signing_pubkey, "creator_signing_pubkey")),
        creator_encryption_fingerprint: ekFingerprint(fromBase64url(req.creator_encryption_pubkey, "creator_encryption_pubkey")),
        client_creation_id: req.client_creation_id,
        allocation_nonce: "ab".repeat(16),
        allocation_generation: "0000000000000001",
        status: (this.supersedeOnAllocate ? "superseded" : "active") as "active" | "superseded",
        issued_at: "2026-08-22T12:00:00.000Z",
        created_at: "2026-08-22T12:00:00.000Z",
      };
      a = signGitvaultObject(unsigned, this.service.seed) as GitvaultAllocation;
      this.allocations.set(req.client_creation_id, a);
      this.allocationsByRepoId.set(a.repo_id, a);
    }
    return a;
  }
  async putObject(req: GitvaultPutObjectRequest) {
    this.calls.push(`put:${req.path}`);
    const key = `${req.repo_id}/${req.path}`;
    if (!this.objects.has(key)) this.objects.set(key, req.bytes);
    const stored = this.objects.get(key)!;
    return { stored_bytes_sha256: sha256Hex(stored), size_bytes: String(stored.length) };
  }
  async getObject(req: { repo_id: string; path: string }) {
    this.calls.push(`get:${req.path}`);
    return this.objects.get(`${req.repo_id}/${req.path}`) ?? null;
  }
  async admitGenesis(req: GitvaultAdmitGenesisRequest) {
    this.calls.push("admit");
    if (this.supersedeOnAdmit) return { outcome: "allocation_superseded" as const };
    const existing = this.genesis.get(req.repo_id);
    if (existing) return { outcome: "already_admitted" as const, admitted_sha256: sha256Hex(existing) };
    this.genesis.set(req.repo_id, req.stored_bytes);
    const alloc = this.allocationsByRepoId.get(req.repo_id);
    if (alloc) this.completedProjects.set(`${alloc.org_id}/${alloc.project_id}`, req.repo_id);
    return { outcome: "admitted" as const, admitted_sha256: req.stored_bytes_sha256 };
  }
  async getGenesis(req: { repo_id: string }) {
    this.calls.push("getGenesis");
    return this.genesis.get(req.repo_id) ?? null;
  }
}

const CCID = "c".repeat(32);

describe("the allocate REQUEST wire shape (the field pair that differs from the allocation RECORD)", () => {
  // Production defect: the SDK sent `creator_signing_fingerprint` /
  // `creator_encryption_fingerprint` — the names the signed `allocation`
  // RECORD carries — and `POST /gitvault/v1/vaults` answered
  // `400 VALIDATION_FAILED field=creator_signing_pubkey`, because the route
  // reads only the PUBKEY fields and never looks at fingerprints at all. The
  // record and the request differ on exactly these two names, so reading
  // `schemas/allocation.json` to build the request produces the broken body.
  // These tests make that class fail here instead of in production.

  it("sends raw PUBLIC KEYS, and never the fingerprints", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    await createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, service_public_key: t.service.public_key });
    const req = t.allocateRequests[0]!;
    assert.deepEqual(Object.keys(req).sort(), ["client_creation_id", "creator_encryption_pubkey", "creator_signing_pubkey", "org_id", "project_id"]);
    const identity = ks.readIdentity()!;
    assert.equal(req.creator_signing_pubkey, identity.signing_pubkey);
    assert.equal(req.creator_encryption_pubkey, identity.encryption_pubkey);
  });

  it("sends values that satisfy the gateway's OWN rule — canonical base64url decoding to exactly 32 bytes", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    await createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, service_public_key: t.service.public_key });
    const req = t.allocateRequests[0]!;
    for (const [field, value] of [["creator_signing_pubkey", req.creator_signing_pubkey], ["creator_encryption_pubkey", req.creator_encryption_pubkey]] as const) {
      assert.equal(isCanonicalBase64url(value), true, field);
      assert.equal(fromBase64url(value, field).length, 32, field);
    }
  });

  it("a FINGERPRINT in a pubkey field is refused — the exact substitution that broke production", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    await createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, service_public_key: t.service.public_key });
    const identity = ks.readIdentity()!;
    // `vk_<32 hex>` is neither canonical base64url nor 32 bytes — assert against
    // the gateway's real rule, not a loose regex that the broken value passes.
    await assert.rejects(
      t.allocate({ client_creation_id: "d".repeat(32), org_id: "o", project_id: "p", creator_signing_pubkey: identity.signing_fingerprint, creator_encryption_pubkey: identity.encryption_pubkey }),
      (e: unknown) => e instanceof LocalError && e.code === "VALIDATION_FAILED" && (e.details as { field?: string }).field === "creator_signing_pubkey",
    );
    await assert.rejects(
      t.allocate({ client_creation_id: "e".repeat(32), org_id: "o", project_id: "p", creator_signing_pubkey: identity.signing_pubkey, creator_encryption_pubkey: identity.encryption_fingerprint }),
      (e: unknown) => e instanceof LocalError && e.code === "VALIDATION_FAILED" && (e.details as { field?: string }).field === "creator_encryption_pubkey",
    );
  });

  it("the RECORD's fingerprints are DERIVED by the control plane, and the client checks them back", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    const result = await createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, service_public_key: t.service.public_key });
    const identity = ks.readIdentity()!;
    const allocation = [...t.allocations.values()][0]!;
    // The round trip is the proof: we sent keys, it returned fingerprints, and
    // they recompute to ours — which is what `checkAllocation` enforces.
    assert.equal(allocation.creator_signing_fingerprint, identity.signing_fingerprint);
    assert.equal(allocation.creator_encryption_fingerprint, identity.encryption_fingerprint);
    assert.ok(result.repo_id.startsWith("src_"));
  });
});

describe("gitvault creation journal — happy path + ordering", () => {
  it("walks the six stages, emits the recovery receipt, and pins the repo file", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    const stages: GitvaultCreationStage[] = [];
    const result = await createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, service_public_key: t.service.public_key, onStage: (s) => { stages.push(s); } });
    assert.deepEqual(stages, GITVAULT_CREATION_STAGES.slice(1));
    assert.equal(result.how, "created");
    assert.equal(result.repo_id, `src_${"1".padStart(32, "0")}`);
    const repo = ks.readRepo(result.repo_id)!;
    assert.equal(repo.genesis_sha256, result.genesis_sha256);
    assert.equal(repo.k_repo_hex, result.journal.k_repo_hex);
    assert.equal(repo.provenance, "created");
    const receipt = ks.readRecoveryReceipt(result.repo_id)!;
    assert.deepEqual(receipt, result.recovery_receipt);
    const genesis = result.journal.genesis!;
    assert.deepEqual(checkRecoveryReceipt(receipt, genesis), []);
    assert.equal(verifyGitvaultObject(genesis as unknown as GitvaultSignedObject, genesis.creator_signing_pubkey), true);
    // the stored envelope binds to the genesis and the bucket holds exactly the journaled bytes
    const envBytes = t.objects.get(`${result.repo_id}/${result.journal.objects[0]!.path}`)!;
    const env = parseGitvaultStrict(new TextDecoder().decode(envBytes)) as GitvaultKeyEnvelope;
    assert.deepEqual(checkGenesisKeyBindings(genesis, env), []);
    assert.equal(sha256Hex(t.genesis.get(result.repo_id)!), result.genesis_sha256);
    assert.deepEqual(t.calls, ["allocate", `get:${result.journal.objects[0]!.path}`, `put:${result.journal.objects[0]!.path}`, "getGenesis", "admit"]);
    assert.deepEqual(listIncompleteGitvaultJournals(ks), []);
  });

  it("no ciphertext, object id, or K_repo exists before ALLOCATED (repo_id is a KDF input)", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    const c = GitvaultCreation.open({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID });
    const j = readGitvaultJournal(ks, CCID)!;
    assert.equal(j.stage, "LOCAL_KEYS_PREPARED");
    assert.equal(j.allocation, null);
    assert.equal(j.k_repo_hex, null);
    assert.deepEqual(j.objects, []);
    assert.deepEqual(t.calls, [], "nothing on the wire before run()");
    let sawAllocatedWithoutCiphertext = false;
    await c.run().catch(() => undefined);
    // re-open and replay the journal history through onStage ordering
    const order: Array<[GitvaultCreationStage, boolean]> = [];
    const ks2 = GitvaultKeystore.open({ rootDir: mkdtempSync(join(tmpdir(), "run402-gitvault-order-")) });
    await createGitvault({ keystore: ks2, transport: new MemoryTransport(), org_id: "o", project_id: "p", client_creation_id: CCID, onStage: (s, jj) => { order.push([s, jj.k_repo_hex !== null || jj.objects.length > 0]); } });
    sawAllocatedWithoutCiphertext = order[0]![0] === "ALLOCATED" && order[0]![1] === false && order[1]![0] === "OBJECTS_PREPARED" && order[1]![1] === true;
    assert.ok(sawAllocatedWithoutCiphertext, JSON.stringify(order));
    assert.ok(order.every(([s, has]) => (s === "ALLOCATED" ? !has : has)));
  });
});

describe("gitvault creation journal — crash-between-stages replay", () => {
  for (const crashAfter of GITVAULT_CREATION_STAGES.slice(1, -1)) {
    it(`crash after ${crashAfter} is reconciled on restart without re-sealing or re-PUTting`, async () => {
      const ks = GitvaultKeystore.open({ rootDir: root });
      const t = new MemoryTransport();
      const crash = new Error(`simulated crash after ${crashAfter}`);
      await assert.rejects(
        createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, onStage: (s) => { if (s === crashAfter) throw crash; } }),
        (e: unknown) => e === crash,
      );
      const durable = readGitvaultJournal(ks, CCID)!;
      assert.equal(durable.stage, crashAfter);
      assert.deepEqual(listIncompleteGitvaultJournals(ks).map((j) => j.client_creation_id), [CCID]);
      const callsBefore = t.calls.slice();
      const objectsBefore = durable.objects.map((o) => o.stored_bytes_sha256);
      const result = await createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID });
      assert.equal(result.how, "reconciled");
      assert.equal(result.journal.stage, "ACTIVE");
      if (objectsBefore.length > 0) {
        assert.deepEqual(result.journal.objects.map((o) => o.stored_bytes_sha256), objectsBefore, "the same sealed bytes — never re-encrypted under the id");
        assert.equal(result.journal.k_repo_hex, durable.k_repo_hex);
      }
      const after = t.calls.slice(callsBefore.length);
      assert.equal(after.filter((c) => c === "allocate").length, crashAfter === "ALLOCATED" ? 0 : 0, "allocation is journaled, never re-requested");
      assert.equal(t.calls.filter((c) => c.startsWith("put:")).length, 1, "exactly one PUT across both runs");
      assert.equal(t.calls.filter((c) => c === "admit").length, 1, "exactly one admission across both runs");
      assert.equal(ks.readRepo(result.repo_id)!.genesis_sha256, result.genesis_sha256);
      assert.ok(ks.readRecoveryReceipt(result.repo_id));
    });
  }

  it("a crash between the PUT and the OBJECTS_FINALIZED write is a read-and-compare on resume", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    // run to OBJECTS_PREPARED, crash; then simulate the PUT having landed before the crash
    await assert.rejects(createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, onStage: (s) => { if (s === "OBJECTS_PREPARED") throw new Error("crash"); } }));
    const j = readGitvaultJournal(ks, CCID)!;
    const obj = j.objects[0]!;
    t.objects.set(`${j.allocation!.repo_id}/${obj.path}`, new Uint8Array(Buffer.from(obj.stored_bytes_b64u, "base64url")));
    const result = await createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID });
    assert.equal(result.how, "reconciled");
    assert.equal(t.calls.filter((c) => c.startsWith("put:")).length, 0, "present + equal bytes → finalized by read-and-compare, no PUT");
  });
});

describe("gitvault creation journal — refusals (never destructive)", () => {
  it("an object already present with DIFFERENT bytes → VAULT_CREATION_CONFLICT, refusal persisted", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    await assert.rejects(createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, onStage: (s) => { if (s === "OBJECTS_PREPARED") throw new Error("crash"); } }));
    const j = readGitvaultJournal(ks, CCID)!;
    t.objects.set(`${j.allocation!.repo_id}/${j.objects[0]!.path}`, new TextEncoder().encode("{\"foreign\":true}"));
    await assert.rejects(createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID }), (e: unknown) => e instanceof LocalError && e.code === "VAULT_CREATION_CONFLICT");
    assert.equal(readGitvaultJournal(ks, CCID)!.refusal?.code, "VAULT_CREATION_CONFLICT");
    // a refused journal stays refused
    await assert.rejects(createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID }), (e: unknown) => e instanceof LocalError && e.code === "VAULT_CREATION_CONFLICT");
    assert.equal(t.calls.filter((c) => c.startsWith("put:")).length, 0);
  });

  it("a foreign genesis already admitted → VAULT_CREATION_CONFLICT, never overwritten", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    await assert.rejects(createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, onStage: (s) => { if (s === "GENESIS_PREPARED") throw new Error("crash"); } }));
    const j = readGitvaultJournal(ks, CCID)!;
    const foreign = new TextEncoder().encode("{\"foreign\":\"genesis\"}");
    t.genesis.set(j.allocation!.repo_id, foreign);
    await assert.rejects(createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID }), (e: unknown) => e instanceof LocalError && e.code === "VAULT_CREATION_CONFLICT");
    assert.deepEqual(t.genesis.get(j.allocation!.repo_id), foreign, "the foreign genesis is untouched");
    assert.equal(t.calls.filter((c) => c === "admit").length, 0);
    assert.equal(ks.readRepo(j.allocation!.repo_id), null, "no pin written");
  });

  it("a superseded allocation (reclaimed by the owner) → ALLOCATION_SUPERSEDED at allocate AND at admit", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    t.supersedeOnAllocate = true;
    await assert.rejects(createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID }), (e: unknown) => e instanceof LocalError && e.code === "ALLOCATION_SUPERSEDED");
    assert.equal(readGitvaultJournal(ks, CCID)!.objects.length, 0, "no ciphertext was ever produced");
    const t2 = new MemoryTransport();
    const ks2 = GitvaultKeystore.open({ rootDir: mkdtempSync(join(tmpdir(), "run402-gitvault-sup-")) });
    await assert.rejects(createGitvault({ keystore: ks2, transport: t2, org_id: "o", project_id: "p", client_creation_id: CCID, onStage: (s) => { if (s === "GENESIS_PREPARED") throw new Error("crash"); } }));
    t2.supersedeOnAdmit = true;
    await assert.rejects(createGitvault({ keystore: ks2, transport: t2, org_id: "o", project_id: "p", client_creation_id: CCID }), (e: unknown) => e instanceof LocalError && e.code === "ALLOCATION_SUPERSEDED");
    assert.equal(t2.genesis.size, 0, "the old client did not publish");
  });

  it("an allocation that does not match this attempt (or a bad service signature) is refused before anything is journaled as ALLOCATED", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    const wrongService = generateSigningKeypair();
    await assert.rejects(createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, service_public_key: wrongService.public_key }), (e: unknown) => e instanceof LocalError && e.code === "GITVAULT_ALLOCATION_INVALID");
    assert.equal(readGitvaultJournal(ks, CCID)!.stage, "LOCAL_KEYS_PREPARED");
  });

  it("a journal from another identity or org/project is never resumed", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    GitvaultCreation.open({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID });
    assert.throws(() => GitvaultCreation.open({ keystore: ks, transport: t, org_id: "other", project_id: "p", client_creation_id: CCID }), (e: unknown) => e instanceof LocalError && e.code === "VAULT_CREATION_CONFLICT");
  });

  it("the admitted genesis read back must hash to the journaled bytes (substitution is named)", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    const result = await createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID });
    const g = result.journal.genesis as GitvaultVaultGenesis;
    assert.equal(storedBytesSha256(g as unknown as GitvaultSignedObject), result.genesis_sha256);
  });
});

describe("kychee-com/run402#563 — init idempotence against a COMPLETED vault (no local journal to resume)", () => {
  it("a fresh attempt (new client_creation_id, no resumable journal) reconciles: deduplicated, zero re-mint, exactly one allocate probe", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    const original = await createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, service_public_key: t.service.public_key });
    assert.equal(original.how, "created");
    const repoBefore = ks.readRepo(original.repo_id)!;
    const callsBefore = t.calls.slice();

    // The ORIGINAL journal is gone (as it would be after `rm -rf` of a stale
    // journal, or simply because enough time passed that nobody kept it) —
    // simulate that by never resuming CCID: this call gets a BRAND NEW
    // random client_creation_id (none passed), which is exactly the
    // dogfood repro (`gitvault init` on an already-provisioned project).
    const fresh = await createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", service_public_key: t.service.public_key });

    assert.equal(fresh.how, "reconciled");
    assert.equal(fresh.repo_id, original.repo_id);
    assert.equal(fresh.genesis_sha256, original.genesis_sha256);
    assert.deepEqual(fresh.recovery_receipt, original.recovery_receipt);

    // No new key material: the repo file (K_repo, genesis pin) is BYTE
    // IDENTICAL to before this second call.
    assert.deepEqual(ks.readRepo(original.repo_id), repoBefore);

    // Exactly one allocate() call happened on this second attempt (the
    // unavoidable probe that surfaces the 409) — and NOTHING else: no
    // second put, no second admit.
    const callsAfter = t.calls.slice(callsBefore.length);
    assert.deepEqual(callsAfter, ["allocate", "getGenesis"]);
    assert.equal(t.calls.filter((c) => c === "allocate").length, 2, "one probe on the fresh attempt, on top of the original creation's own allocate");
    assert.equal(t.calls.filter((c) => c.startsWith("put:")).length, 1, "never re-sealed or re-PUT");
    assert.equal(t.calls.filter((c) => c === "admit").length, 1, "never re-admitted");
  });

  it("the CLI-facing dedupe shape matches gitvault init's already-rendered case (result.how drives result.deduplicated one level up)", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    await createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, service_public_key: t.service.public_key });
    const fresh = await createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", service_public_key: t.service.public_key });
    // `Gitvault.init()` (sdk/src/namespaces/gitvault.ts) sets
    // `deduplicated: created.how === "reconciled"` verbatim — this is the
    // one field the CLI's `init()` branches its dedupe message on.
    assert.equal(fresh.how === "reconciled", true);
  });

  it("a machine whose keystore does NOT hold the key gets a truthful, enriched refusal — never the word 'foreign'", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    await createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, service_public_key: t.service.public_key });

    // A DIFFERENT machine/keystore (own identity, no repo file for this
    // repo_id) reaches the SAME project/transport — e.g. an org-mate who
    // never held this vault's key, or a moved/reformatted machine.
    const ks2 = GitvaultKeystore.open({ rootDir: mkdtempSync(join(tmpdir(), "run402-gitvault-nonholder-")) });
    let caught: unknown;
    try {
      await createGitvault({ keystore: ks2, transport: t, org_id: "o", project_id: "p", service_public_key: t.service.public_key });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof LocalError);
    const err = caught as LocalError;
    assert.equal(err.code, "VAULT_CREATION_CONFLICT");
    assert.doesNotMatch(err.message.toLowerCase(), /foreign/, "never call the org's own vault 'foreign'");
    assert.match(err.message, /does not hold/);
    const details = err.details as { repo_id?: string; org_id?: string; project_id?: string };
    assert.equal(details.repo_id?.startsWith("src_"), true, "names the real repo_id, not a synthesized one");
    assert.equal(details.org_id, "o");
    assert.equal(details.project_id, "p");
    const actions = (err.nextActions ?? []) as { action: string }[];
    assert.ok(actions.length > 0, "carries real remedies, not a bare refusal");
    assert.ok(actions.some((a) => /restore the gitvault keystore/.test(a.action)));
  });

  it("no allocate() retry and no key material minted on the non-holder path", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    const original = await createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, service_public_key: t.service.public_key });
    const callsBefore = t.calls.slice();

    const ks2 = GitvaultKeystore.open({ rootDir: mkdtempSync(join(tmpdir(), "run402-gitvault-nonholder2-")) });
    await assert.rejects(createGitvault({ keystore: ks2, transport: t, org_id: "o", project_id: "p", service_public_key: t.service.public_key }));

    assert.equal(ks2.readRepo(original.repo_id), null, "the non-holder keystore never gained a repo file");
    const callsAfter = t.calls.slice(callsBefore.length);
    // No local repo file at all → nothing to verify, so the non-holder
    // refusal short-circuits before even reading the genesis back: one
    // probe, no retry, no put, no admit.
    assert.deepEqual(callsAfter, ["allocate"], "no retry, no put, no admit, no wasted genesis read");
  });
});

describe("findResumableGitvaultJournal (repo-first-onramp D2 — client-side resumability)", () => {
  it("finds an incomplete journal matching the exact (org, project) pair", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    await assert.rejects(createGitvault({ keystore: ks, transport: t, org_id: "org_a", project_id: "proj_a", client_creation_id: CCID, onStage: (s) => { if (s === "ALLOCATED") throw new Error("crash"); } }));
    const found = findResumableGitvaultJournal(ks, "org_a", "proj_a");
    assert.equal(found?.client_creation_id, CCID);
  });

  it("never matches a different org or a different project", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    await assert.rejects(createGitvault({ keystore: ks, transport: t, org_id: "org_a", project_id: "proj_a", client_creation_id: CCID, onStage: (s) => { if (s === "ALLOCATED") throw new Error("crash"); } }));
    assert.equal(findResumableGitvaultJournal(ks, "org_b", "proj_a"), null);
    assert.equal(findResumableGitvaultJournal(ks, "org_a", "proj_b"), null);
  });

  it("never resumes a REFUSED journal — that would only reproduce the refusal", async () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    const t = new MemoryTransport();
    await assert.rejects(createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID, onStage: (s) => { if (s === "OBJECTS_PREPARED") throw new Error("crash"); } }));
    const j = readGitvaultJournal(ks, CCID)!;
    t.objects.set(`${j.allocation!.repo_id}/${j.objects[0]!.path}`, new TextEncoder().encode("{\"foreign\":true}"));
    await assert.rejects(createGitvault({ keystore: ks, transport: t, org_id: "o", project_id: "p", client_creation_id: CCID }), (e: unknown) => e instanceof LocalError && e.code === "VAULT_CREATION_CONFLICT");
    assert.equal(readGitvaultJournal(ks, CCID)!.refusal?.code, "VAULT_CREATION_CONFLICT");

    assert.equal(findResumableGitvaultJournal(ks, "o", "p"), null, "a refused attempt is never offered up for reuse");
  });

  it("returns null when nothing is incomplete (a fresh call gets a fresh id)", () => {
    const ks = GitvaultKeystore.open({ rootDir: root });
    assert.equal(findResumableGitvaultJournal(ks, "o", "p"), null);
  });
});

describe("gitvault creation journal — doctor text", () => {
  it("carries the V0-A terminal-loss statement verbatim and the CAS-restore pointer, never implying a receipt decrypts", () => {
    const d = gitvaultDoctorRecoveryText();
    assert.equal(d.statement, GITVAULT_TERMINAL_LOSS_STATEMENT);
    assert.equal(d.statement, "whole-machine or whole-keystore loss is terminal for vault history until human envelopes ship");
    assert.equal(d.doctor_text, GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT);
    assert.match(d.doctor_text, /^In V0-A, whole-machine or whole-keystore loss is terminal for vault history \(VAULT_UNRECOVERABLE\) until human envelopes ship\./);
    assert.match(d.cas_restore_pointer, /custodial restore/);
    assert.match(d.doctor_text, /cannot decrypt anything/);
  });
});
