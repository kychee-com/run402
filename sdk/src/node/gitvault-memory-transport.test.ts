/**
 * gitvault test fixture — an in-memory control plane + bucket implementing
 * the FULL {@link GitvaultTransport} (5.3 creation + 5.4 publication + 5.6
 * token/override routes) with the protocol's server-side rules a client must
 * survive: create-only objects, generation CAS (`HEAD_CAS_CONFLICT` + winner),
 * `TRANSITION_NOT_ACTIVE`, anchor/cursor-bound listings (`INVALID_CURSOR`),
 * capture receipts, activation-token mint rules (null digest → no token;
 * binding must match the operation row), override completion (equality on
 * every field), plus fault knobs (receipt tamper, read-back tamper, a
 * competing writer) the 5.4/5.6 suites use.
 *
 * Lives in a `.test.ts` so it never ships in `dist/`; the one test below keeps
 * the runner happy when the file is executed directly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalError } from "../errors.js";
import {
  GITVAULT_FORMAT,
  GITVAULT_GENESIS_GENERATION,
  GITVAULT_SUITE,
  formatGitvaultTimestamp,
  generateSigningKeypair,
  newGitvaultId,
  parseGitvaultStrict,
  sha256Hex,
  signGitvaultObject,
} from "../namespaces/gitvault.crypto.js";
import type { GitvaultActivationToken, GitvaultAllocation, GitvaultCaptureReceipt, GitvaultHead, GitvaultHeadsListingPage, GitvaultHeadsListingRequest, GitvaultRetentionCutoff } from "../namespaces/gitvault.types.js";
import type { GitvaultAdmitGenesisRequest, GitvaultAdmitGenesisResult, GitvaultAllocateRequest, GitvaultObjectReceipt, GitvaultPutObjectRequest } from "./gitvault-creation-journal.js";
import { createGitvault } from "./gitvault-creation-journal.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import type { GitvaultAdmitHeadRequest, GitvaultAdmitHeadResult, GitvaultMaintenanceLease, GitvaultMaintenanceLeaseRequest, GitvaultRetentionCutoffIssued, GitvaultTransport, GitvaultUploadObject, GitvaultUploadReceipt, GitvaultVaultRecord } from "./gitvault-publication.js";
import { GitvaultVault, generationToBigInt, bigIntToGeneration, gitvaultPaths } from "./gitvault-publication.js";
import { hardenedGit } from "./gitvault-snapshot.js";

function err(code: string, message: string, details?: unknown): LocalError {
  return new LocalError(message, "memory transport", { code, details });
}

export interface MemoryOperation {
  operation_id: string;
  capture_id: string;
  apply_plan_sha256: string;
  snapshot_oid_hmac: string;
  /** Set when the operation was activated unvaulted (the journaled advisory). */
  override: { cleared: boolean } | null;
  activated_with: string | null;
}

export class GitvaultMemoryTransport implements GitvaultTransport {
  readonly service = generateSigningKeypair();
  readonly objects = new Map<string, Uint8Array>();
  readonly allocations = new Map<string, GitvaultAllocation>();
  readonly operations = new Map<string, MemoryOperation>();
  readonly consumedTokens = new Map<string, string>();
  readonly calls: string[] = [];
  authorizationEpoch = "29ecd26abcb16d47cfd6b853a1c9130d";
  repoCounter = 0;
  // ── fault knobs ──
  /** Tamper every Nth receipt's hash (1-based index into the upload order); null = honest. */
  tamperReceiptAt: number | null = null;
  /** Store different bytes at head/<gen> than admitted (the read-back must catch it). */
  tamperReadback = false;
  /** A competing writer: before the NEXT admission, admit this head (bytes) at the same generation. */
  competitor: ((generation: string) => Promise<void>) | null = null;
  /** Refuse token minting with this code once. */
  refuseTokenOnce: string | null = null;
  pageLimit: number | null = null;

  private key(repoId: string, path: string): string { return `${repoId}/${path}`; }

  // ── creation (5.3) ──
  async allocate(req: GitvaultAllocateRequest): Promise<GitvaultAllocation> {
    this.calls.push("allocate");
    let a = this.allocations.get(req.client_creation_id);
    if (!a) {
      this.repoCounter += 1;
      const unsigned = {
        format: GITVAULT_FORMAT, object_kind: "allocation" as const, suite: GITVAULT_SUITE,
        repo_id: `src_${String(this.repoCounter).padStart(32, "0")}`, service_key_id: "sk_test-1", org_id: req.org_id, project_id: req.project_id, principal_id: "principal_1",
        creator_signing_fingerprint: req.creator_signing_fingerprint, creator_encryption_fingerprint: req.creator_encryption_fingerprint, client_creation_id: req.client_creation_id,
        allocation_nonce: "ab".repeat(16), allocation_generation: "0000000000000001", status: "active" as const, issued_at: "2026-08-22T12:00:00.000Z", created_at: "2026-08-22T12:00:00.000Z",
      };
      a = signGitvaultObject(unsigned, this.service.seed) as GitvaultAllocation;
      this.allocations.set(req.client_creation_id, a);
    }
    return a;
  }
  async putObject(req: GitvaultPutObjectRequest): Promise<GitvaultObjectReceipt> {
    const [r] = await this.uploadObjects({ repo_id: req.repo_id, objects: [{ path: req.path, object_kind: "key_envelope", object_id: null, bytes: req.bytes, sha256: req.expected_sha256, size_bytes: req.expected_size_bytes }] });
    return { stored_bytes_sha256: r!.sha256, size_bytes: r!.size_bytes };
  }
  async getObject({ repo_id, path }: { repo_id: string; path: string }): Promise<Uint8Array | null> {
    this.calls.push(`get:${path}`);
    return this.objects.get(this.key(repo_id, path)) ?? null;
  }
  async admitGenesis(req: GitvaultAdmitGenesisRequest): Promise<GitvaultAdmitGenesisResult> {
    const k = this.key(req.repo_id, gitvaultPaths.head(GITVAULT_GENESIS_GENERATION));
    const existing = this.objects.get(k);
    if (existing) return { outcome: "already_admitted", admitted_sha256: sha256Hex(existing) };
    this.objects.set(k, req.stored_bytes);
    return { outcome: "admitted", admitted_sha256: req.stored_bytes_sha256 };
  }
  getGenesis({ repo_id }: { repo_id: string }): Promise<Uint8Array | null> {
    return this.getObject({ repo_id, path: gitvaultPaths.head(GITVAULT_GENESIS_GENERATION) });
  }

  // ── listing (D186) ──
  newestGeneration(repoId: string): string {
    let newest = 0n;
    for (const k of this.objects.keys()) {
      const m = new RegExp(`^${repoId}/head/([0-9a-f]{16})$`).exec(k);
      if (m) { const g = generationToBigInt(m[1]!); if (g > newest) newest = g; }
    }
    return bigIntToGeneration(newest);
  }
  async listHeads(request: GitvaultHeadsListingRequest & { repo_id: string }): Promise<GitvaultHeadsListingPage> {
    this.calls.push("listHeads");
    const anchor = generationToBigInt(request.after_generation);
    let start = anchor + 1n;
    if (request.cursor !== undefined) {
      const m = /^hc_([0-9a-f]{16})_([0-9a-f]{16})_([0-9a-f]{8})$/.exec(request.cursor);
      const bound = m ? sha256Hex(new TextEncoder().encode(`${request.repo_id}|${m[1]}|${m[2]}`)).slice(0, 8) : null;
      if (!m || m[1] !== request.after_generation || bound !== m[3]) throw err("INVALID_CURSOR", "cursor not minted for this vault under this after_generation");
      start = generationToBigInt(m[2]!) + 1n;
    }
    const newest = generationToBigInt(this.newestGeneration(request.repo_id));
    const limit = BigInt(this.pageLimit ?? Number(request.limit));
    const heads: GitvaultHeadsListingPage["heads"] = [];
    let g = start;
    for (; g <= newest && BigInt(heads.length) < limit; g++) {
      const gen = bigIntToGeneration(g);
      heads.push({ generation: gen, stored_bytes_sha256: sha256Hex(this.objects.get(this.key(request.repo_id, gitvaultPaths.head(gen)))!) });
    }
    const hasMore = g <= newest;
    const last = heads.length > 0 ? heads[heads.length - 1]!.generation : request.after_generation;
    const cursor = `hc_${request.after_generation}_${last}_${sha256Hex(new TextEncoder().encode(`${request.repo_id}|${request.after_generation}|${last}`)).slice(0, 8)}`;
    return { format: GITVAULT_FORMAT, repo_id: request.repo_id, after_generation: request.after_generation, heads, has_more: hasMore, next_cursor: hasMore ? cursor : null, total: hasMore ? null : String(newest > anchor ? newest - anchor : 0n) };
  }

  // ── uploads (create-only) ──
  async uploadObjects({ repo_id, objects }: { repo_id: string; objects: GitvaultUploadObject[] }): Promise<GitvaultUploadReceipt[]> {
    this.calls.push(`upload:${objects.length}`);
    const receipts: GitvaultUploadReceipt[] = [];
    objects.forEach((o, i) => {
      const k = this.key(repo_id, o.path);
      const existing = this.objects.get(k);
      if (existing && sha256Hex(existing) !== o.sha256) throw err("GITVAULT_OBJECT_EXISTS_DIFFERENT", `${o.path} exists with different bytes`);
      if (sha256Hex(o.bytes) !== o.sha256 || String(o.bytes.length) !== o.size_bytes) throw err("GITVAULT_CHECKSUM_MISMATCH", `${o.path}: bytes do not match the declared checksum`);
      this.objects.set(k, o.bytes);
      const tampered = this.tamperReceiptAt === i + 1;
      receipts.push({ path: o.path, object_id: o.object_id, sha256: tampered ? "00".repeat(32) : o.sha256, size_bytes: o.size_bytes });
    });
    if (this.tamperReceiptAt !== null) this.tamperReceiptAt = null;
    return receipts;
  }

  // ── admission (§5A, client-visible half) ──
  async admitHead(req: GitvaultAdmitHeadRequest): Promise<GitvaultAdmitHeadResult> {
    this.calls.push(`admit:${req.generation}`);
    if (this.competitor) { const c = this.competitor; this.competitor = null; await c(req.generation); }
    const head = parseGitvaultStrict(new TextDecoder().decode(req.stored_bytes)) as GitvaultHead;
    if (head.transition !== null) throw err("TRANSITION_NOT_ACTIVE", "V0 admission rejects every non-null transition");
    const newest = this.newestGeneration(req.repo_id);
    const expected = bigIntToGeneration(generationToBigInt(newest) + 1n);
    if (req.generation !== expected || head.generation !== expected) {
      const winnerBytes = this.objects.get(this.key(req.repo_id, gitvaultPaths.head(newest)))!;
      return { outcome: "conflict", winner: { generation: newest, stored_bytes_sha256: sha256Hex(winnerBytes) } };
    }
    const receipted = [head.ref_state.object_id, head.retention_roots.object_id, ...head.wal_entries.map((w) => w.object_id)];
    for (const id of receipted) {
      const path = id.startsWith("refs_") ? gitvaultPaths.refState(id) : id.startsWith("rr_") ? gitvaultPaths.retentionRoots(id) : gitvaultPaths.wal(id);
      if (!this.objects.has(this.key(req.repo_id, path))) throw err("GITVAULT_RECEIPT_UNKNOWN", `receipted object ${id} was never finalized`);
    }
    if (head.checkpoint && !this.objects.has(this.key(req.repo_id, gitvaultPaths.claimSet(head.checkpoint.claim_set.object_id)))) throw err("GITVAULT_RECEIPT_UNKNOWN", "claim set never finalized");
    const stored = this.tamperReadback ? new TextEncoder().encode(new TextDecoder().decode(req.stored_bytes) + " ") : req.stored_bytes;
    this.objects.set(this.key(req.repo_id, gitvaultPaths.head(req.generation)), stored);
    const record = new TextEncoder().encode(JSON.stringify({ admission: req.generation, admitted_sha256: req.stored_bytes_sha256 }));
    this.objects.set(this.key(req.repo_id, gitvaultPaths.admission(req.generation)), record);
    let capture_receipt: GitvaultCaptureReceipt | null = null;
    if (head.capture_binding) {
      capture_receipt = signGitvaultObject({
        format: GITVAULT_FORMAT, object_kind: "capture_receipt" as const, suite: GITVAULT_SUITE, repo_id: req.repo_id, service_key_id: "sk_test-1", generation: req.generation,
        head_sha256: req.stored_bytes_sha256, capture_id: head.capture_binding.capture_id, apply_plan_sha256: head.capture_binding.apply_plan_sha256, snapshot_oid_hmac: head.capture_binding.snapshot_oid_hmac,
        admission_record_sha256: sha256Hex(record), issued_at: formatGitvaultTimestamp(), effective_admitted_at: formatGitvaultTimestamp(), authorization_epoch: this.authorizationEpoch,
      }, this.service.seed) as GitvaultCaptureReceipt;
    }
    return { outcome: "admitted", admission_record_sha256: sha256Hex(record), capture_receipt };
  }

  async requestRetentionCutoff({ repo_id, base_head_sha256 }: { repo_id: string; base_head_sha256: string }): Promise<GitvaultRetentionCutoffIssued> {
    const ticket = signGitvaultObject({ format: GITVAULT_FORMAT, object_kind: "retention_cutoff" as const, suite: GITVAULT_SUITE, repo_id, object_id: newGitvaultId("rc"), service_key_id: "sk_test-1", base_head_sha256, cutoff_at: formatGitvaultTimestamp(), expires_at: formatGitvaultTimestamp(new Date(Date.now() + 3600_000)), authorization_epoch: this.authorizationEpoch }, this.service.seed) as GitvaultRetentionCutoff;
    const bytes = new TextEncoder().encode(JSON.stringify(ticket));
    this.objects.set(this.key(repo_id, gitvaultPaths.cutoffTicket(ticket.object_id)), bytes);
    return { ticket, receipt: { object_id: ticket.object_id, object_kind: "retention_cutoff", stored_bytes_sha256: sha256Hex(bytes), size_bytes: String(bytes.length) } };
  }

  // ── §6.5 token exchange: only from a non-null digest that matches the operation row ──
  async exchangeActivationToken({ repo_id, operation_id, capture_receipt }: { repo_id: string; operation_id: string; capture_receipt: GitvaultCaptureReceipt }): Promise<GitvaultActivationToken> {
    this.calls.push("mint");
    if (this.refuseTokenOnce) { const c = this.refuseTokenOnce; this.refuseTokenOnce = null; throw err(c, "token mint refused"); }
    const op = this.operations.get(operation_id);
    if (!op) throw err("GITVAULT_ACCESS_DENIED", "unknown operation");
    if (capture_receipt.apply_plan_sha256 === null) throw err("GITVAULT_TOKEN_NOT_MINTABLE", "no token is mintable from a null plan digest");
    if (capture_receipt.repo_id !== repo_id || capture_receipt.capture_id !== op.capture_id || capture_receipt.apply_plan_sha256 !== op.apply_plan_sha256 || capture_receipt.snapshot_oid_hmac !== op.snapshot_oid_hmac) throw err("GITVAULT_TOKEN_BINDING_MISMATCH", "receipt does not bind the operation row");
    if (capture_receipt.authorization_epoch !== this.authorizationEpoch) throw err("AUTHORIZATION_EPOCH_STALE", "stale epoch");
    return signGitvaultObject({
      format: GITVAULT_FORMAT, object_kind: "activation_token" as const, suite: GITVAULT_SUITE, repo_id, object_id: newGitvaultId("ct"), service_key_id: "sk_test-1", operation_id,
      generation: capture_receipt.generation, head_sha256: capture_receipt.head_sha256, capture_id: op.capture_id, apply_plan_sha256: op.apply_plan_sha256, snapshot_oid_hmac: op.snapshot_oid_hmac,
      issued_at: formatGitvaultTimestamp(), authorization_epoch: this.authorizationEpoch,
    }, this.service.seed) as GitvaultActivationToken;
  }

  /** Atomic + idempotent consumption (the apply-activation side, modelled for the fake lane). */
  consumeToken(token: GitvaultActivationToken, operationId: string): void {
    const prior = this.consumedTokens.get(token.object_id);
    if (prior !== undefined) {
      if (prior === operationId) return; // idempotent same-operation replay = a READ of the terminal state
      throw err("GITVAULT_TOKEN_CONSUMED", "token consumed by a different operation");
    }
    if (token.authorization_epoch !== this.authorizationEpoch) throw err("AUTHORIZATION_EPOCH_STALE", "stale epoch");
    this.consumedTokens.set(token.object_id, operationId);
    const op = this.operations.get(operationId);
    if (op) op.activated_with = token.object_id;
  }

  async submitOverrideCompletion({ repo_id, operation_id, capture_receipt }: { repo_id: string; operation_id: string; capture_receipt: GitvaultCaptureReceipt }): Promise<{ cleared: boolean }> {
    this.calls.push("override-completion");
    const op = this.operations.get(operation_id);
    if (!op || !op.override) throw err("GITVAULT_ACCESS_DENIED", "no unvaulted operation to complete");
    const headBytes = this.objects.get(this.key(repo_id, gitvaultPaths.head(capture_receipt.generation)));
    const equal = capture_receipt.repo_id === repo_id && capture_receipt.capture_id === op.capture_id && capture_receipt.apply_plan_sha256 === op.apply_plan_sha256 && capture_receipt.snapshot_oid_hmac === op.snapshot_oid_hmac && headBytes !== undefined && sha256Hex(headBytes) === capture_receipt.head_sha256;
    if (!equal) return { cleared: false };
    op.override.cleared = true;
    return { cleared: true };
  }

  // ── control-plane reads + the maintenance lease (5.6c) ──
  vaultRecord: Partial<GitvaultVaultRecord> = {};
  leases = new Map<string, { holder_token: string; released: boolean }>();

  async getVaultRecord({ repo_id }: { repo_id: string }): Promise<GitvaultVaultRecord> {
    this.calls.push("vault-record");
    const generations = [...this.objects.keys()].filter((k) => k.startsWith(`${repo_id}|head/`)).map((k) => k.slice(`${repo_id}|head/`.length)).sort();
    return {
      repo_id, project_id: "prj_memory", org_id: "org_memory",
      gitvault_policy: "required", gitvault_policy_version: "1", gitvault_policy_changed_at: null,
      allocation_generation: "1", allocation_sha256: null,
      newest_generation: generations.at(-1) ?? null, genesis_admitted_at: null, latest_effective_admitted_at: null,
      admitted_generations: String(generations.length), gc_epoch: "0", repair_version: "0", repair_fence_state: "none",
      storage: { source_bytes: "0", open_session_reserved_bytes: "0", objects: {} },
      maintenance: { lease: null, open_cycle: null, pending_repair_attempt_id: null },
      warnings: [], created_at: null,
      ...this.vaultRecord,
    };
  }

  async findVaultByProject({ project_id }: { project_id: string }): Promise<GitvaultVaultRecord> {
    this.calls.push("find-vault");
    const repoId = this.vaultRecord.repo_id ?? [...this.objects.keys()][0]?.split("|")[0];
    if (!repoId) throw err("RESOURCE_NOT_FOUND", `no gitvault for ${project_id}`);
    return { ...(await this.getVaultRecord({ repo_id: repoId })), project_id };
  }

  async acquireMaintenanceLease(request: GitvaultMaintenanceLeaseRequest): Promise<GitvaultMaintenanceLease> {
    this.calls.push("lease-acquire");
    const id = `ml_${"1".repeat(32)}`;
    const holder = "00000000-0000-4000-8000-000000000000";
    this.leases.set(id, { holder_token: holder, released: false });
    return {
      maintenance_lease_id: id, repo_id: request.repo_id, base_head_sha256: request.base_head_sha256,
      current_checkpoint_hash: request.current_checkpoint_hash ?? null,
      reservation_size_bytes: request.r1_size_bytes, maintenance_headroom_bytes: request.r2_cap_size_bytes,
      holder_token: holder, expires_at: null, hard_deadline_at: null,
    };
  }

  async heartbeatMaintenanceLease({ maintenance_lease_id, holder_token }: { repo_id: string; maintenance_lease_id: string; holder_token: string }) {
    this.calls.push("lease-heartbeat");
    const l = this.leases.get(maintenance_lease_id);
    if (!l || l.holder_token !== holder_token || l.released) throw err("MAINTENANCE_LEASE_HELD", "not the holder");
    return { maintenance_lease_id, expires_at: null };
  }

  async releaseMaintenanceLease({ maintenance_lease_id, holder_token }: { repo_id: string; maintenance_lease_id: string; holder_token: string }) {
    this.calls.push("lease-release");
    const l = this.leases.get(maintenance_lease_id);
    if (!l || l.holder_token !== holder_token) throw err("MAINTENANCE_LEASE_HELD", "not the holder");
    l.released = true;
    return { maintenance_lease_id, status: "released" };
  }
}

// ─── Shared fixtures ─────────────────────────────────────────────────────────

export async function git(dir: string, args: string[], input?: string): Promise<string> {
  return (await hardenedGit(dir, args, input !== undefined ? { input } : {})).text().trim();
}

/** A fresh working repository with one commit on `main`. Returns the REAL path — git reports
 * `--show-toplevel` resolved, and on macOS `/var/folders/...` is a symlink to `/private/var/...`. */
export async function makeRepo(root: string, name = "repo"): Promise<string> {
  mkdirSync(join(root, name), { recursive: true });
  const dir = realpathSync(join(root, name));
  await git(dir, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

export async function commitFile(dir: string, file: string, content: string, message = `edit ${file}`): Promise<string> {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), content);
  await git(dir, ["add", file]);
  await git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

export interface VaultFixture {
  root: string;
  keystore: GitvaultKeystore;
  transport: GitvaultMemoryTransport;
  repoDir: string;
  repoId: string;
  vault: GitvaultVault;
}

/** Keystore + memory control plane + a created (ACTIVE) vault + a local repo. */
export async function makeVault(root?: string): Promise<VaultFixture> {
  const r = root ?? mkdtempSync(join(tmpdir(), "run402-gitvault-fixture-"));
  const keystore = GitvaultKeystore.open({ rootDir: join(r, "ks") });
  const transport = new GitvaultMemoryTransport();
  const repoDir = await makeRepo(r);
  const created = await createGitvault({ keystore, transport, org_id: "org_1", project_id: "proj_1", service_public_key: transport.service.public_key });
  const vault = GitvaultVault.open({ keystore, transport, repo_id: created.repo_id, repo_dir: repoDir });
  return { root: r, keystore, transport, repoDir, repoId: created.repo_id, vault };
}

describe("gitvault memory transport (fixture self-check)", () => {
  it("lists nothing above the genesis on a fresh vault", async () => {
    const t = new GitvaultMemoryTransport();
    t.objects.set("src_x/head/0000000000000000", new Uint8Array([1]));
    const page = await t.listHeads({ repo_id: "src_x", after_generation: "0000000000000000", limit: "10" });
    assert.deepEqual(page.heads, []);
    assert.equal(page.has_more, false);
    assert.equal(page.next_cursor, null);
    assert.equal(page.total, "0");
  });
});
