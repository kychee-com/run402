/**
 * gitvault prune — the client half of §7.3 (add-gitvault task 5.12a).
 *
 * These tests are organized around the four ways a prune client can silently
 * do damage:
 *
 *   1. delete something the vault still needs (the GC root set),
 *   2. attest something it did not verify (the two receipts),
 *   3. sign one thing and send another (the exact-bytes route),
 *   4. report as deleted something that is still there (`present_after_attempt`).
 *
 * Every one of those is a correctness property, not a formatting one, so each
 * gets a test that fails LOUDLY rather than a snapshot that drifts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GITVAULT_MAX_PRUNE_CANDIDATES,
  GITVAULT_SDK_VERIFIER_IMPLEMENTATION,
  GITVAULT_SDK_VERIFIER_VERSION,
  GITVAULT_VERIFIER_IMPLEMENTATIONS,
  assertPruneCoreStillCurrent,
  buildPruneIntent,
  buildPruneIntentCore,
  buildVerifierReceipt,
  checkRetentionEvolution,
  checkpointRecoveryBundle,
  collectPruneUniverse,
  computeGcRootSet,
  planPruneCandidates,
  pruneIntentBytes,
  pruneIntentCoreSha256,
  sortPruneReceipts,
  summarizePruneCompletion,
  verifierReceiptRef,
  type GitvaultChainEntry,
  type GitvaultPruneIntentRecord,
  type GitvaultPruneableReceipt,
  type GitvaultVerifierReceipt,
} from "./gitvault-prune.js";
import { generateSigningKeypair, jcsString, parseGitvaultStrict, storedBytesSha256, verifyGitvaultObject } from "../namespaces/gitvault.crypto.js";
import type { GitvaultCheckpointClaimSet, GitvaultHead, GitvaultSignedObject } from "../namespaces/gitvault.types.js";
import { commitFile, makeVault } from "./gitvault-memory-transport.test.js";
import { gitvaultPaths } from "./gitvault-publication.js";

const REPO = `src_${"1".repeat(32)}`;
const owner = generateSigningKeypair();

function hex32(seed: string): string {
  return seed.repeat(32).slice(0, 32);
}
function sha(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function wal(n: string, gen = "0000000000000001"): GitvaultPruneableReceipt {
  return { object_id: `wal_${hex32(n)}`, object_kind: "wal_pack", ciphertext_sha256: sha(n), size_bytes: "10", base_generation: gen };
}
function refs(n: string): GitvaultPruneableReceipt {
  return { object_id: `refs_${hex32(n)}`, object_kind: "ref_state", ciphertext_sha256: sha(n), size_bytes: "11" };
}
function rr(n: string): GitvaultPruneableReceipt {
  return { object_id: `rr_${hex32(n)}`, object_kind: "retention_roots", ciphertext_sha256: sha(n), size_bytes: "12" };
}
function ccs(n: string): GitvaultPruneableReceipt {
  return { object_id: `ccs_${hex32(n)}`, object_kind: "checkpoint_claim_set", stored_bytes_sha256: sha(n), size_bytes: "13" };
}
function chk(n: string): GitvaultPruneableReceipt {
  return { object_id: `chk_${hex32(n)}`, object_kind: "checkpoint_manifest", ciphertext_sha256: sha(n), size_bytes: "14" };
}
function ckp(n: string): GitvaultPruneableReceipt {
  return { object_id: `ckp_${hex32(n)}`, object_kind: "checkpoint_pack", ciphertext_sha256: sha(n), size_bytes: "15" };
}

/** A synthetic chain link. `checkpoint` builds the claim-set + bundle when given ids. */
function entry(
  generation: string,
  parts: { wal?: string[]; refs: string; rr: string; checkpoint?: { ccs: string; chk: string; ckp: string[]; cutoff?: boolean } },
): GitvaultChainEntry {
  const cp = parts.checkpoint;
  const head = {
    generation,
    wal_entries: (parts.wal ?? []).map((n) => wal(n, generation)),
    ref_state: refs(parts.refs),
    retention_roots: rr(parts.rr),
    checkpoint: cp
      ? {
          claim_set: ccs(cp.ccs),
          covers_through_generation: generation,
          git_object_format: "sha1",
          cutoff: cp.cutoff === false ? null : { ticket: { object_id: `rc_${hex32("9")}`, object_kind: "retention_cutoff", stored_bytes_sha256: sha("9"), size_bytes: "20" }, cutoff_at: "2026-06-01T00:00:00.000Z" },
        }
      : null,
  } as unknown as GitvaultHead;
  const claimSet = cp
    ? ({
        manifest_receipt: chk(cp.chk),
        ordered_pack_receipts: cp.ckp.map((n) => ckp(n)),
      } as unknown as GitvaultCheckpointClaimSet)
    : null;
  return { head, head_sha256: sha(generation.slice(-1)), claim_set: claimSet };
}

/**
 * Three generations, two of them checkpoint-bearing:
 *   g1  wal a,b   refs 1  rr 1
 *   g2  CHECKPOINT (ccs 2 / chk 2 / ckp 2)   refs 2  rr 2      ← the PRIOR checkpoint
 *   g3  CHECKPOINT (ccs 3 / chk 3 / ckp 3)   refs 3  rr 3      ← the LATEST checkpoint
 * so only g1's material is outside the GC root set.
 */
function twoCheckpointChain(): GitvaultChainEntry[] {
  return [
    entry("0000000000000001", { wal: ["a", "b"], refs: "1", rr: "1" }),
    entry("0000000000000002", { refs: "2", rr: "2", checkpoint: { ccs: "2", chk: "2", ckp: ["2"] } }),
    entry("0000000000000003", { refs: "3", rr: "3", checkpoint: { ccs: "3", chk: "3", ckp: ["3"] } }),
  ];
}

describe("the GC root set — what a prune may never touch", () => {
  it("protects a checkpoint's FULL recovery bundle: claim set, manifest, packs, AND its covers_through carriers", () => {
    const chain = twoCheckpointChain();
    const bundle = checkpointRecoveryBundle(chain[2]!).map((r) => r.object_id);
    assert.ok(bundle.includes(ccs("3").object_id), "the claim set");
    assert.ok(bundle.includes(chk("3").object_id), "the manifest");
    assert.ok(bundle.includes(ckp("3").object_id), "the pack");
    // The carriers are the half that is easy to forget: a checkpoint set with
    // no ref_state/retention_roots to interpret it is not a recovery path.
    assert.ok(bundle.includes(refs("3").object_id), "the covers_through ref_state carrier");
    assert.ok(bundle.includes(rr("3").object_id), "the covers_through retention_roots carrier");
  });

  it("leaves exactly the pre-prior-checkpoint material prunable", () => {
    const plan = planPruneCandidates(twoCheckpointChain());
    assert.equal(plan.root_set.blocked_reason, null);
    assert.deepEqual(
      plan.candidates.map((r) => r.object_id).sort(),
      [wal("a").object_id, wal("b").object_id, refs("1").object_id, rr("1").object_id].sort(),
      "only generation 1's WAL packs and carriers are superseded by two later checkpoints",
    );
  });

  it("refuses to prune ANYTHING with fewer than two checkpoints — the second recovery path is the WAL chain", () => {
    const noCheckpoint = [entry("0000000000000001", { wal: ["a"], refs: "1", rr: "1" })];
    const one = [...noCheckpoint, entry("0000000000000002", { refs: "2", rr: "2", checkpoint: { ccs: "2", chk: "2", ckp: ["2"] } })];
    for (const [label, chain] of [["no checkpoint", noCheckpoint], ["one checkpoint", one]] as const) {
      const plan = planPruneCandidates(chain);
      assert.equal(plan.candidates.length, 0, label);
      assert.ok(plan.root_set.blocked_reason, `${label} states WHY, rather than reading as "already clean"`);
    }
  });

  it("counts a shared object once and never emits it twice, however many heads name it", () => {
    const shared = refs("1");
    const chain = [
      entry("0000000000000001", { wal: ["a"], refs: "1", rr: "1" }),
      { ...entry("0000000000000002", { refs: "1", rr: "2" }), head_sha256: sha("2") },
      entry("0000000000000003", { refs: "3", rr: "3", checkpoint: { ccs: "3", chk: "3", ckp: ["3"] } }),
      entry("0000000000000004", { refs: "4", rr: "4", checkpoint: { ccs: "4", chk: "4", ckp: ["4"] } }),
    ];
    const universe = collectPruneUniverse(chain);
    assert.equal(universe.filter((r) => r.object_id === shared.object_id).length, 1);
  });

  it("sorts by object_id and nothing else — the schema's canonical order, not insertion order", () => {
    const sorted = sortPruneReceipts([rr("9"), wal("1"), refs("5")]).map((r) => r.object_id);
    assert.deepEqual(sorted, [...sorted].sort());
  });

  it("a candidate is never also a root — the two sets are disjoint by construction", () => {
    const plan = planPruneCandidates(twoCheckpointChain());
    const roots = new Set(plan.root_set.receipts.map((r) => r.object_id));
    for (const c of plan.candidates) assert.equal(roots.has(c.object_id), false, c.object_id);
  });
});

describe("the intent core — the acyclic base BOTH receipts sign", () => {
  const coreInput = {
    repo_id: REPO,
    gc_epoch: "0000000000000001",
    authorizing_head_sha256: sha("a"),
    checkpoint_claim_set_sha256: sha("c"),
    gc_root_set_hmac: sha("d"),
    retention_state_hmac: sha("e"),
    delete_set: [wal("b"), wal("a")],
  };

  it("sorts the delete set and signs the whole core", () => {
    const core = buildPruneIntentCore(coreInput, owner.seed);
    assert.deepEqual(core.delete_set.map((r) => r.object_id), [wal("a").object_id, wal("b").object_id].sort());
    assert.ok(verifyGitvaultObject(core as unknown as GitvaultSignedObject, owner.public_key));
  });

  it("`intent_core_sha256` hashes the COMPLETE signed core, signature included", () => {
    const core = buildPruneIntentCore(coreInput, owner.seed);
    assert.equal(pruneIntentCoreSha256(core), storedBytesSha256(core as unknown as GitvaultSignedObject));
    // and it therefore changes if any member changes, including the signature
    const tampered = { ...core, nonce: hex32("f") };
    assert.notEqual(storedBytesSha256(tampered as unknown as GitvaultSignedObject), pruneIntentCoreSha256(core));
  });

  it("all five cycle fields are null for an ordinary prune (non-null together only for a cycle batch)", () => {
    const core = buildPruneIntentCore(coreInput, owner.seed);
    assert.deepEqual(
      [core.maintenance_cycle_id, core.maintenance_prune_role, core.stage_claim_set_sha256, core.batch_index, core.batch_count],
      [null, null, null, null, null],
    );
    const batch = buildPruneIntentCore(
      { ...coreInput, cycle: { maintenance_cycle_id: `mc_${hex32("7")}`, maintenance_prune_role: "intermediate", stage_claim_set_sha256: sha("7"), batch_index: "1", batch_count: "2" } },
      owner.seed,
    );
    assert.equal(batch.maintenance_cycle_id, `mc_${hex32("7")}`);
    assert.equal(batch.batch_index, "1");
  });

  it("refuses an empty or oversized delete set rather than letting the gateway reject a wasted round trip", () => {
    assert.throws(() => buildPruneIntentCore({ ...coreInput, delete_set: [] }, owner.seed), (e: unknown) => (e as { code?: string }).code === "UPGRADE_REQUIRED");
    const many = Array.from({ length: GITVAULT_MAX_PRUNE_CANDIDATES + 1 }, (_, i) => ({
      object_id: `wal_${String(i).padStart(32, "0")}`,
      object_kind: "wal_pack" as const,
      ciphertext_sha256: sha("1"),
      size_bytes: "1",
      base_generation: "0000000000000001",
    }));
    assert.throws(() => buildPruneIntentCore({ ...coreInput, delete_set: many }, owner.seed), (e: unknown) => (e as { code?: string }).code === "UPGRADE_REQUIRED");
  });

  it("refuses duplicate candidates — a repeated id is a reject, not a dedup", () => {
    assert.throws(
      () => buildPruneIntentCore({ ...coreInput, delete_set: [wal("a"), wal("a")] }, owner.seed),
      (e: unknown) => (e as { code?: string }).code === "UPGRADE_REQUIRED",
    );
  });
});

describe("the two verifier receipts — one per implementation, never both from us", () => {
  const core = buildPruneIntentCore(
    { repo_id: REPO, gc_epoch: "0000000000000001", authorizing_head_sha256: sha("a"), checkpoint_claim_set_sha256: sha("c"), gc_root_set_hmac: sha("d"), retention_state_hmac: sha("e"), delete_set: [wal("a")] },
    owner.seed,
  );
  const coreSha = pruneIntentCoreSha256(core);
  const receipt = (over: Partial<Parameters<typeof buildVerifierReceipt>[0]> = {}): GitvaultVerifierReceipt =>
    buildVerifierReceipt(
      {
        repo_id: REPO,
        intent_core_sha256: coreSha,
        checkpoint_head_sha256: sha("h"),
        cutoff_ticket_sha256: sha("9"),
        restored_object_set_hmac: sha("o"),
        retention_evolution_ok: true,
        candidates_outside_roots_ok: true,
        implementation_id: "run402-cli",
        implementation_version: GITVAULT_SDK_VERIFIER_VERSION,
        ...over,
      },
      owner.seed,
    );

  it("derives `result` from the attestations — a caller cannot claim a pass it did not observe", () => {
    assert.equal(receipt().result, "restored_and_verified");
    assert.equal(receipt({ retention_evolution_ok: false }).result, "failed");
    assert.equal(receipt({ candidates_outside_roots_ok: false }).result, "failed");
  });

  it("this SDK is `run402-cli`, and the CLOSED set names exactly two identities", () => {
    assert.equal(GITVAULT_SDK_VERIFIER_IMPLEMENTATION, "run402-cli");
    assert.deepEqual([...GITVAULT_VERIFIER_IMPLEMENTATIONS], ["run402-cli", "r402s-verify"]);
  });

  it("refuses two receipts from the SAME lineage — the whole point is differential verification", () => {
    const a = receipt();
    const b = receipt({ object_id: `vr_${hex32("2")}` });
    assert.throws(
      () => buildPruneIntent(core, [a, b], owner.seed),
      (e: unknown) => (e as { code?: string }).code === "UPGRADE_REQUIRED" && /one verifier receipt per implementation/.test((e as Error).message),
    );
  });

  it("refuses a receipt that signs a DIFFERENT core — the binding is the attestation", () => {
    const ours = receipt();
    const theirs = receipt({ implementation_id: "r402s-verify", object_id: `vr_${hex32("2")}`, intent_core_sha256: sha("z") });
    assert.throws(
      () => buildPruneIntent(core, [ours, theirs], owner.seed),
      (e: unknown) => (e as { code?: string }).code === "UPGRADE_REQUIRED" && /signs a different intent core/.test((e as Error).message),
    );
  });

  it("refuses a `failed` receipt instead of submitting an attestation nobody stands behind", () => {
    const ours = receipt();
    const theirs = receipt({ implementation_id: "r402s-verify", object_id: `vr_${hex32("2")}`, retention_evolution_ok: false });
    assert.throws(
      () => buildPruneIntent(core, [ours, theirs], owner.seed),
      (e: unknown) => (e as { code?: string }).code === "UPGRADE_REQUIRED" && /restored_and_verified/.test((e as Error).message),
    );
  });

  it("refuses receipts that are distinct objects but identical bytes", () => {
    // Same content, same id ⇒ same hash. The gateway's rule is distinct ids AND
    // distinct hashes, so a copy renamed at the id level must still refuse.
    const ours = receipt();
    const clone = { ...ours, implementation_id: "r402s-verify" as const };
    assert.throws(() => buildPruneIntent(core, [ours, clone], owner.seed), (e: unknown) => (e as { code?: string }).code === "UPGRADE_REQUIRED");
  });

  it("builds the ref the intent carries — never the receipt body", () => {
    // ONE receipt: each `receipt()` call mints a fresh random object_id, so
    // hashing a second one would compare two different objects.
    const one = receipt();
    const ref = verifierReceiptRef(one);
    assert.deepEqual(Object.keys(ref).sort(), ["implementation_id", "object_id", "object_kind", "size_bytes", "stored_bytes_sha256"]);
    assert.equal(ref.stored_bytes_sha256, storedBytesSha256(one as unknown as GitvaultSignedObject));
    assert.equal("intent_core_sha256" in ref, false, "the ref names the receipt; it never carries its attestations");
  });

  it("accepts exactly one receipt per identity and signs the wrapper", () => {
    const ours = receipt();
    const theirs = receipt({ implementation_id: "r402s-verify", object_id: `vr_${hex32("2")}`, implementation_version: "r402s-verify/0.1.0" });
    const intent = buildPruneIntent(core, [ours, theirs], owner.seed);
    assert.equal(intent.object_id, core.object_id, "wrapper and core agree on object_id");
    assert.equal(intent.intent_core_sha256, coreSha);
    assert.equal(intent.verifier_receipts.length, 2);
    assert.ok(verifyGitvaultObject(intent as unknown as GitvaultSignedObject, owner.public_key), "the wrapper is signed too — the double signature of §7.3");
  });
});

describe("a stale core is refused BEFORE the receipts are burned", () => {
  const core = buildPruneIntentCore(
    { repo_id: REPO, gc_epoch: "0000000000000001", authorizing_head_sha256: sha("a"), checkpoint_claim_set_sha256: sha("c"), gc_root_set_hmac: sha("d"), retention_state_hmac: sha("e"), delete_set: [wal("a")] },
    owner.seed,
  );
  const current = { repo_id: REPO, gc_epoch: "0000000000000001", checkpoint_claim_set_sha256: sha("c") };

  it("accepts a core the chain has not moved past", () => {
    assert.doesNotThrow(() => assertPruneCoreStillCurrent(core, current));
  });

  it("refuses a foreign vault with the registry's access code", () => {
    assert.throws(
      () => assertPruneCoreStillCurrent(core, { ...current, repo_id: `src_${"2".repeat(32)}` }),
      (e: unknown) => (e as { code?: string }).code === "GITVAULT_ACCESS_DENIED",
    );
  });

  it("refuses a moved gc_epoch with `GC_EPOCH_STALE` — the same code the gateway's fence uses", () => {
    assert.throws(
      () => assertPruneCoreStillCurrent(core, { ...current, gc_epoch: "0000000000000002" }),
      (e: unknown) => (e as { code?: string }).code === "GC_EPOCH_STALE",
    );
  });

  it("refuses a core naming a superseded checkpoint — a compaction landed after the plan", () => {
    assert.throws(
      () => assertPruneCoreStillCurrent(core, { ...current, checkpoint_claim_set_sha256: sha("z") }),
      (e: unknown) => (e as { code?: string }).code === "GC_EPOCH_STALE" && /no longer the latest/.test((e as Error).message),
    );
  });
});

describe("the wire — the route reads EXACT BYTES", () => {
  const core = buildPruneIntentCore(
    { repo_id: REPO, gc_epoch: "0000000000000001", authorizing_head_sha256: sha("a"), checkpoint_claim_set_sha256: sha("c"), gc_root_set_hmac: sha("d"), retention_state_hmac: sha("e"), delete_set: [wal("a")] },
    owner.seed,
  );
  const mk = (id: "run402-cli" | "r402s-verify", n: string) =>
    buildVerifierReceipt(
      { repo_id: REPO, intent_core_sha256: pruneIntentCoreSha256(core), checkpoint_head_sha256: sha("h"), cutoff_ticket_sha256: sha("9"), restored_object_set_hmac: sha("o"), retention_evolution_ok: true, candidates_outside_roots_ok: true, implementation_id: id, implementation_version: n, object_id: `vr_${hex32(n)}` },
      owner.seed,
    );
  const intent = buildPruneIntent(core, [mk("run402-cli", "1"), mk("r402s-verify", "2")], owner.seed);

  it("serializes to its own JCS, so the bytes the gateway strict-parses are the bytes we signed", () => {
    const bytes = pruneIntentBytes(intent);
    const text = new TextDecoder().decode(bytes);
    assert.equal(text, jcsString(intent), "byte-identical to canonical JSON — anything else is a strict-parse reject");
    // and it survives the round trip the route performs
    const reparsed = parseGitvaultStrict(text) as typeof intent;
    assert.equal(storedBytesSha256(reparsed as unknown as GitvaultSignedObject), storedBytesSha256(intent as unknown as GitvaultSignedObject));
    assert.ok(verifyGitvaultObject(reparsed as unknown as GitvaultSignedObject, owner.public_key));
  });

  it("a re-serialized body with a different key order is DIFFERENT bytes — which is why the serializer is the contract", () => {
    const canonical = jcsString(intent);
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()));
    // Same VALUE, different bytes. The route strict-parses and verifies the
    // owner signature over the bytes as sent, so "equal JSON" is not a defence.
    assert.deepEqual(JSON.parse(reordered), parsed);
    assert.notEqual(reordered, canonical);
  });
});

describe("the completion — only `deleted` means gone", () => {
  const ids = ["wal_a", "wal_b", "wal_c"];
  const record = (perObject: Array<{ object_id: string; result: "deleted" | "present_not_attempted" | "present_after_attempt" }> | null): GitvaultPruneIntentRecord =>
    ({
      object_id: "pi_x", repo_id: REPO, state: "COMPLETED", gc_epoch: "0000000000000001",
      intent_sha256: null, intent_core_sha256: null, candidate_count: ids.length, next_candidate_index: ids.length,
      maintenance_cycle_id: null, maintenance_prune_role: null, stage_claim_set_sha256: null, batch_index: null, batch_count: null,
      completion: perObject
        ? { object_id: "pc_x", sha256: null, per_object: perObject, deleted_count: 0, present_after_attempt_count: 0, present_not_attempted_count: 0, gc_epoch_at_completion: "0000000000000001", cycle_event_seq: null, completed_at: null }
        : null,
      prepared_at: null, intent_put_issued_at: null, intent_stored_at: null, deleting_started_at: null,
    }) as GitvaultPruneIntentRecord;

  it("NEVER counts `present_after_attempt` as a deletion — the failure that looks most like a success", () => {
    const c = summarizePruneCompletion(ids, record([
      { object_id: "wal_a", result: "deleted" },
      { object_id: "wal_b", result: "present_after_attempt" },
      { object_id: "wal_c", result: "present_not_attempted" },
    ]));
    assert.deepEqual(c.deleted, ["wal_a"]);
    assert.deepEqual(c.present.map((o) => o.object_id).sort(), ["wal_b", "wal_c"]);
    assert.equal(c.outcome, "superseded_partial_delete");
  });

  it("reports `completed` only when EVERY candidate is deleted", () => {
    const c = summarizePruneCompletion(ids, record(ids.map((object_id) => ({ object_id, result: "deleted" as const }))));
    assert.equal(c.outcome, "completed");
    assert.deepEqual(c.deleted, ids);
  });

  it("reports `superseded_no_delete` when nothing was attempted", () => {
    const c = summarizePruneCompletion(ids, record(ids.map((object_id) => ({ object_id, result: "present_not_attempted" as const }))));
    assert.equal(c.outcome, "superseded_no_delete");
    assert.deepEqual(c.deleted, []);
  });

  it("a candidate with no entry is `unadjudicated`, never inferred deleted", () => {
    const c = summarizePruneCompletion(ids, record([{ object_id: "wal_a", result: "deleted" }]));
    assert.deepEqual(c.unadjudicated.sort(), ["wal_b", "wal_c"]);
    assert.notEqual(c.outcome, "completed", "a missing verdict can never complete the intent");
  });

  it("no completion yet ⇒ nothing deleted and nothing claimed", () => {
    const c = summarizePruneCompletion(ids, record(null));
    assert.equal(c.outcome, null);
    assert.deepEqual(c.deleted, []);
    assert.deepEqual(c.unadjudicated, ids);
    assert.deepEqual(summarizePruneCompletion(ids, null), c, "an absent record reads the same as an uncompleted one");
  });
});

describe("retention-root evolution — an unprovable departure is `false`, not `true`", () => {
  const chain = twoCheckpointChain();
  const dropped = { ref: "refs/heads/gone", oid: "a".repeat(40), dropped_at_generation: "0000000000000001" };
  const rootsAt = (present: Record<string, boolean>) => (e: GitvaultChainEntry) => (present[e.head.generation] ? [dropped] : []);

  it("accepts a departure at a checkpoint bound to a cutoff whose window has closed", () => {
    const r = checkRetentionEvolution(chain, rootsAt({ "0000000000000001": true, "0000000000000002": true }), () => "2020-01-01T00:00:00.000Z", () => true);
    assert.equal(r.ok, true);
  });

  it("refuses a departure at a generation carrying no checkpoint", () => {
    const noCp = [chain[0]!, { ...chain[1]!, head: { ...chain[1]!.head, checkpoint: null } as GitvaultHead }];
    const r = checkRetentionEvolution(noCp, rootsAt({ "0000000000000001": true }), () => "2020-01-01T00:00:00.000Z", () => true);
    assert.equal(r.ok, false);
    assert.match(r.unproven[0]!.reason, /no checkpoint/);
  });

  it("refuses when this client cannot resolve `effective_admitted_at` — permissive expiry, not a convenient true", () => {
    const r = checkRetentionEvolution(chain, rootsAt({ "0000000000000001": true, "0000000000000002": true }), () => null, () => true);
    assert.equal(r.ok, false);
    assert.match(r.unproven[0]!.reason, /effective_admitted_at/);
  });

  it("refuses a departure inside the window", () => {
    const r = checkRetentionEvolution(chain, rootsAt({ "0000000000000001": true, "0000000000000002": true }), () => "2026-05-31T00:00:00.000Z", () => false);
    assert.equal(r.ok, false);
    assert.match(r.unproven[0]!.reason, /before its retention window closed/);
  });
});

describe("end to end against the memory control plane", () => {
  it("plans from a real chain, submits exact bytes, and believes only the signed completion", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "run402-gitvault-prune-e2e-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const f = await makeVault(root);

    // Three generations, two of them checkpoint-bearing, so a prune is
    // structurally possible: g1 WAL, g2 checkpoint, g3 checkpoint.
    const c1 = await commitFile(f.repoDir, "a.txt", "one");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    await f.vault.publishCheckpoint();
    const c2 = await commitFile(f.repoDir, "b.txt", "two");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });
    await f.vault.publishCheckpoint();

    const entries = await f.vault.chainEntries();
    assert.ok(entries.length >= 4, "the walk returns every generation, not just the newest");
    const plan = planPruneCandidates(entries);
    assert.equal(plan.root_set.blocked_reason, null, "two checkpoints ⇒ a prune is possible");
    assert.ok(plan.candidates.length > 0, "the pre-prior-checkpoint material is superseded");

    // Everything the latest checkpoint's recovery bundle needs must survive the plan.
    const bundle = new Set(checkpointRecoveryBundle(plan.root_set.latest_checkpoint!).map((r) => r.object_id));
    for (const c of plan.candidates) assert.equal(bundle.has(c.object_id), false, `${c.object_id} is in the latest recovery bundle`);

    // The attestation is produced by RESTORING the stored checkpoint, not asserted.
    const latest = plan.root_set.latest_checkpoint!;
    const attestation = await f.vault.verifyStoredCheckpoint(latest.head, latest.head_sha256);
    assert.equal(attestation.object_set_matches, true, "the restored object set matches the manifest's commitment");
    assert.equal(attestation.ref_state_matches, true);
    assert.equal(attestation.retention_roots_matches, true);
    assert.deepEqual(attestation.missing_tips, []);

    const record = await f.transport.getVaultRecord({ repo_id: f.repoId });
    const core = buildPruneIntentCore(
      {
        repo_id: f.repoId,
        gc_epoch: record.gc_epoch,
        authorizing_head_sha256: entries.at(-1)!.head_sha256,
        checkpoint_claim_set_sha256: attestation.claim_set_sha256,
        gc_root_set_hmac: f.vault.keyedDigest("gcrootset", { receipts: plan.root_set.receipts }),
        retention_state_hmac: attestation.retention_state_hmac,
        delete_set: plan.candidates,
      },
      f.vault.signer(),
    );
    const coreSha = pruneIntentCoreSha256(core);
    const mk = (id: "run402-cli" | "r402s-verify", n: string) =>
      buildVerifierReceipt(
        {
          repo_id: f.repoId, intent_core_sha256: coreSha, checkpoint_head_sha256: attestation.checkpoint_head_sha256,
          cutoff_ticket_sha256: attestation.cutoff_ticket_sha256, restored_object_set_hmac: attestation.restored_object_set_hmac,
          retention_evolution_ok: true, candidates_outside_roots_ok: true, implementation_id: id, implementation_version: n,
        },
        f.vault.signer(),
      );
    const receipts = [mk("run402-cli", GITVAULT_SDK_VERIFIER_VERSION), mk("r402s-verify", "r402s-verify/0.1.0")];

    // Both receipts must be STORED before the intent may name them.
    const { storedBytes, sha256Hex } = await import("../namespaces/gitvault.crypto.js");
    await f.transport.uploadObjects({
      repo_id: f.repoId,
      objects: receipts.map((r) => {
        const bytes = storedBytes(r as unknown as GitvaultSignedObject);
        return { path: gitvaultPaths.verifierReceipt(r.object_id), object_kind: "verifier_receipt", object_id: r.object_id, bytes, sha256: sha256Hex(bytes), size_bytes: String(bytes.length) };
      }),
    });

    const intent = buildPruneIntent(core, receipts, f.vault.signer());
    const bytes = pruneIntentBytes(intent);
    const submitted = await f.transport.submitPruneIntent({ repo_id: f.repoId, intent_bytes: bytes });
    assert.equal(submitted.stored, true);
    // The fixture kept the bytes as sent: a client that re-serialized anywhere
    // between signing and sending is caught here, not in production.
    assert.deepEqual(f.transport.pruneIntents.get(intent.object_id)!.bytes, bytes);

    const confirmation = summarizePruneCompletion(core.delete_set.map((r) => r.object_id), submitted);
    assert.equal(confirmation.outcome, "completed");
    assert.deepEqual(confirmation.deleted.sort(), core.delete_set.map((r) => r.object_id).sort());
    // and the bytes really are gone from the bucket
    for (const id of confirmation.deleted) {
      assert.equal([...f.transport.objects.keys()].some((k) => k.includes(id)), false, `${id} still in the bucket`);
    }
  });

  it("reports a partially-failed prune as partial — never as a success", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "run402-gitvault-prune-partial-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const f = await makeVault(root);
    const c1 = await commitFile(f.repoDir, "a.txt", "one");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    await f.vault.publishCheckpoint();
    await f.vault.publishCheckpoint();

    const entries = await f.vault.chainEntries();
    const plan = planPruneCandidates(entries);
    assert.ok(plan.candidates.length > 0);
    const stubborn = plan.candidates[0]!.object_id;
    f.transport.pruneOutcomes = { [stubborn]: "present_after_attempt" };

    const attestation = await f.vault.verifyStoredCheckpoint(plan.root_set.latest_checkpoint!.head, plan.root_set.latest_checkpoint!.head_sha256);
    const core = buildPruneIntentCore(
      {
        repo_id: f.repoId, gc_epoch: (await f.transport.getVaultRecord({ repo_id: f.repoId })).gc_epoch,
        authorizing_head_sha256: entries.at(-1)!.head_sha256, checkpoint_claim_set_sha256: attestation.claim_set_sha256,
        gc_root_set_hmac: f.vault.keyedDigest("gcrootset", { receipts: plan.root_set.receipts }),
        retention_state_hmac: attestation.retention_state_hmac, delete_set: plan.candidates,
      },
      f.vault.signer(),
    );
    const coreSha = pruneIntentCoreSha256(core);
    const { storedBytes, sha256Hex } = await import("../namespaces/gitvault.crypto.js");
    const receipts = (["run402-cli", "r402s-verify"] as const).map((id, i) =>
      buildVerifierReceipt(
        { repo_id: f.repoId, intent_core_sha256: coreSha, checkpoint_head_sha256: attestation.checkpoint_head_sha256, cutoff_ticket_sha256: attestation.cutoff_ticket_sha256, restored_object_set_hmac: attestation.restored_object_set_hmac, retention_evolution_ok: true, candidates_outside_roots_ok: true, implementation_id: id, implementation_version: `v${i}` },
        f.vault.signer(),
      ),
    );
    await f.transport.uploadObjects({
      repo_id: f.repoId,
      objects: receipts.map((r) => {
        const b = storedBytes(r as unknown as GitvaultSignedObject);
        return { path: gitvaultPaths.verifierReceipt(r.object_id), object_kind: "verifier_receipt", object_id: r.object_id, bytes: b, sha256: sha256Hex(b), size_bytes: String(b.length) };
      }),
    });
    const submitted = await f.transport.submitPruneIntent({ repo_id: f.repoId, intent_bytes: pruneIntentBytes(buildPruneIntent(core, receipts, f.vault.signer())) });
    const confirmation = summarizePruneCompletion(core.delete_set.map((r) => r.object_id), submitted);
    assert.equal(confirmation.outcome, "superseded_partial_delete");
    assert.equal(confirmation.deleted.includes(stubborn), false, "a present_after_attempt candidate is never reported deleted");
    assert.equal([...f.transport.objects.keys()].some((k) => k.includes(stubborn)), true, "and its bytes are still there");
  });
});
