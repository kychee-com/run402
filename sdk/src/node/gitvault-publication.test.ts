/**
 * gitvault publication (task 5.4) — the §6.1 ref-transaction semantics and
 * cardinality refusals, §4.5 retention-root evolution, the §6.3/D186 heads
 * listing contract, §6.4 dual pins + the RESUMABLE verification budget, the
 * §6.2 push (receipt-compare, head read-back, 409 re-apply-and-retry), §4.7
 * checkpoint build + acceptance, §4.3 repair, and the client-side
 * transition fail-closed rule.
 *
 * Vector classes replayed here (generated in the private repo, see the crypto
 * suite's loader note): `heads_listing_pagination`, `retention-schedule`,
 * `transition-fail-closed`, `request-to-c1-binding`, plus `chain-005` — the one
 * `chain` vector the crypto suite deferred, because it is a PIN comparison, not
 * a signature check.
 */

import { describe, it } from "node:test";
import { loadGitvaultVectors, OPTOUT_SKIP_MESSAGE, type GitvaultVector } from "./gitvault-vectors.test-helper.js";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalError } from "../errors.js";
import { sha256Hex } from "../namespaces/gitvault.crypto.js";
import type { GitvaultHead, GitvaultHeadsListingPage, GitvaultHeadsListingRequest, GitvaultRetentionRoot } from "../namespaces/gitvault.types.js";
import {
  GITVAULT_MAX_CANONICAL_REFS,
  GITVAULT_MAX_REF_UPDATES_PER_TRANSACTION,
  GITVAULT_RETAIN_REF_PREFIX,
  GitvaultVault,
  assertNoTransition,
  assertRefMapCardinality,
  checkClaimSetEquality,
  checkGenerationRegression,
  checkOpenBinding,
  deployRefTransaction,
  effectiveAdmittedAt,
  evaluateRefTransaction,
  evolveRetentionRoots,
  generationToBigInt,
  gitvaultPaths,
  gitvaultRetainedRefName,
  isRootEligibleForRemoval,
  nextGeneration,
  nextListingRequest,
  openBindingDigest,
  readGitvaultRestoreMarker,
  reconcileRetainedTipRefs,
  validateHeadsListingRequest,
  verifyHeadsListingPage,
  type GitvaultListingProgress,
  type GitvaultRefMap,
} from "./gitvault-publication.js";
import { GITVAULT_DEPLOY_REF, hasObject } from "./gitvault-snapshot.js";
import { commitFile, git, makeVault, type VaultFixture } from "./gitvault-memory-transport.test.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";

// ─── Vector loading (same contract as the crypto suite) ──────────────────────

// Task 5.6b: missing vectors FAIL; only GITVAULT_VECTORS_OPTOUT=1 skips.
const vectorSet = loadGitvaultVectors();
type Vector = GitvaultVector;
const vectorFile = vectorSet?.file ?? null;
const vectors = vectorFile ? describe : describe.skip;
if (!vectorFile) describe("gitvault publication vectors", () => it.skip(OPTOUT_SKIP_MESSAGE, () => {}));

const replayed = new Map<string, Set<string>>();
function byClass(cls: string): Vector[] {
  return (vectorFile?.vectors ?? []).filter((v) => v.class === cls);
}
function mark(v: Vector): void {
  let s = replayed.get(v.class);
  if (!s) replayed.set(v.class, (s = new Set()));
  s.add(v.id);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function codeOf(e: unknown): string {
  assert.ok(e instanceof LocalError, `expected LocalError, got ${String(e)}`);
  return e.code ?? "no-code";
}
function throwsCode(fn: () => unknown, code: string, message?: string): void {
  try {
    fn();
  } catch (e) {
    assert.equal(codeOf(e), code, message ?? `expected ${code}`);
    return;
  }
  assert.fail(message ?? `expected ${code}, nothing thrown`);
}
async function rejectsCode(p: Promise<unknown>, code: string, message?: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert.equal(codeOf(e), code, message ?? `expected ${code}`);
    return;
  }
  assert.fail(message ?? `expected ${code}, nothing thrown`);
}
const OID = (n: number): string => n.toString(16).padStart(40, "0");
const never = () => {
  throw new Error("the ancestry oracle must not be consulted on this path");
};

// ─── §6.1 ref transactions ───────────────────────────────────────────────────

describe("§6.1 ref transactions", () => {
  const ff = { isAncestor: () => true };
  const notFf = { isAncestor: () => false };

  it("creation needs a null expected-old; a non-null expected-old on an absent ref is a mismatch", async () => {
    const created = await evaluateRefTransaction({}, { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: OID(1), force: false }] }, ff);
    assert.deepEqual(created, { refs: { "refs/heads/main": OID(1) }, dropped: [] });
    await rejectsCode(evaluateRefTransaction({}, { updates: [{ ref: "refs/heads/main", expected_old_oid: OID(9), new_oid: OID(1), force: false }] }, ff), "REF_EXPECTED_OLD_MISMATCH");
  });

  it("a non-force branch update must be BOTH fast-forward and expected-old-matching", async () => {
    const cur: GitvaultRefMap = { "refs/heads/main": OID(1) };
    const okFf = await evaluateRefTransaction(cur, { updates: [{ ref: "refs/heads/main", expected_old_oid: OID(1), new_oid: OID(2), force: false }] }, ff);
    assert.deepEqual(okFf.refs, { "refs/heads/main": OID(2) });
    assert.deepEqual(okFf.dropped, [], "a fast-forward displaces nothing");
    await rejectsCode(evaluateRefTransaction(cur, { updates: [{ ref: "refs/heads/main", expected_old_oid: OID(1), new_oid: OID(2), force: false }] }, notFf), "REF_EXPECTED_OLD_MISMATCH");
    await rejectsCode(evaluateRefTransaction(cur, { updates: [{ ref: "refs/heads/main", expected_old_oid: OID(7), new_oid: OID(2), force: false }] }, ff), "REF_EXPECTED_OLD_MISMATCH");
  });

  it("a non-fast-forward refusal names the working force spelling; a bare expected-old mismatch does not (gitvault-force-spelling-and-pin-fold)", async () => {
    const cur: GitvaultRefMap = { "refs/heads/main": OID(1) };
    const forceHintOf = (e: unknown): { action?: string; why?: string } | undefined => {
      const actions = ((e as { body?: { next_actions?: { action?: string; why?: string }[] } }).body?.next_actions ?? []);
      return actions.find((a) => a.action === "git push --force");
    };
    // The `--force-with-lease` shape: git ran its lease locally and handed the
    // helper a NON-force update for a rebased (non-FF) tip.
    const nonFf = await evaluateRefTransaction(cur, { updates: [{ ref: "refs/heads/main", expected_old_oid: OID(1), new_oid: OID(2), force: false }] }, notFf).then(() => null, (e: unknown) => e);
    assert.ok(nonFf, "sanity: the non-FF update was refused");
    const hint = forceHintOf(nonFf);
    assert.ok(hint, "the refusal carries the git push --force next_action");
    assert.match(hint!.why ?? "", /force-with-lease/, "the why explains the with-lease safety and the helper-boundary limitation");
    // A pure expected-old mismatch (a raced push, not a rewrite) carries NO
    // force hint — suggesting force there would be exactly the wrong advice.
    const raced = await evaluateRefTransaction(cur, { updates: [{ ref: "refs/heads/main", expected_old_oid: OID(7), new_oid: OID(2), force: false }] }, ff).then(() => null, (e: unknown) => e);
    assert.ok(raced, "sanity: the mismatched update was refused");
    assert.equal(forceHintOf(raced), undefined);
  });

  it("force is force-WITH-LEASE: it skips ancestry but still needs expected-old, and the displaced tip is dropped", async () => {
    const cur: GitvaultRefMap = { "refs/heads/main": OID(1) };
    const forced = await evaluateRefTransaction(cur, { updates: [{ ref: "refs/heads/main", expected_old_oid: OID(1), new_oid: OID(2), force: true }] }, notFf);
    assert.deepEqual(forced.refs, { "refs/heads/main": OID(2) });
    assert.deepEqual(forced.dropped, [{ ref: "refs/heads/main", oid: OID(1), reason: "force_displaced" }]);
    await rejectsCode(evaluateRefTransaction(cur, { updates: [{ ref: "refs/heads/main", expected_old_oid: OID(5), new_oid: OID(2), force: true }] }, notFf), "REF_EXPECTED_OLD_MISMATCH");
  });

  it("tags are immutable without force — and the ancestry oracle is never consulted for a tag", async () => {
    const cur: GitvaultRefMap = { "refs/tags/v1": OID(1) };
    await rejectsCode(evaluateRefTransaction(cur, { updates: [{ ref: "refs/tags/v1", expected_old_oid: OID(1), new_oid: OID(2), force: false }] }, { isAncestor: never }), "REF_EXPECTED_OLD_MISMATCH");
    const forced = await evaluateRefTransaction(cur, { updates: [{ ref: "refs/tags/v1", expected_old_oid: OID(1), new_oid: OID(2), force: true }] }, { isAncestor: never });
    assert.deepEqual(forced.dropped, [{ ref: "refs/tags/v1", oid: OID(1), reason: "force_displaced" }]);
  });

  it("a delete needs expected-old (grammar refusal), and drops the tip", async () => {
    await rejectsCode(evaluateRefTransaction({}, { updates: [{ ref: "refs/heads/x", expected_old_oid: null, new_oid: null, force: false }] }, ff), "REF_TRANSACTION_INVALID");
    const deleted = await evaluateRefTransaction({ "refs/heads/x": OID(3) }, { updates: [{ ref: "refs/heads/x", expected_old_oid: OID(3), new_oid: null, force: false }] }, ff);
    assert.deepEqual(deleted.refs, {});
    assert.deepEqual(deleted.dropped, [{ ref: "refs/heads/x", oid: OID(3), reason: "deleted" }]);
  });

  it("two updates naming the same ref are refused BEFORE evaluation, never last-wins", async () => {
    await rejectsCode(
      evaluateRefTransaction(
        { "refs/heads/main": OID(1) },
        { updates: [{ ref: "refs/heads/main", expected_old_oid: OID(1), new_oid: OID(2), force: false }, { ref: "refs/heads/main", expected_old_oid: OID(2), new_oid: OID(3), force: false }] },
        { isAncestor: never },
      ),
      "REF_TRANSACTION_DUPLICATE_REF",
    );
  });

  it("every failing update rides ONE REF_EXPECTED_OLD_MISMATCH, never a silent revert", async () => {
    try {
      await evaluateRefTransaction(
        { "refs/heads/a": OID(1), "refs/heads/b": OID(2), "refs/tags/t": OID(3) },
        {
          updates: [
            { ref: "refs/heads/a", expected_old_oid: OID(9), new_oid: OID(4), force: false },
            { ref: "refs/heads/b", expected_old_oid: OID(2), new_oid: OID(5), force: false },
            { ref: "refs/tags/t", expected_old_oid: OID(3), new_oid: OID(6), force: false },
          ],
        },
        notFf,
      );
      assert.fail("expected REF_EXPECTED_OLD_MISMATCH");
    } catch (e) {
      assert.equal(codeOf(e), "REF_EXPECTED_OLD_MISMATCH");
      const failures = (e as LocalError & { details?: { failures?: Array<{ ref: string; reason: string }> } }).details!.failures!;
      assert.deepEqual(failures.map((f) => [f.ref, f.reason]), [["refs/heads/a", "expected_old_mismatch"], ["refs/heads/b", "non_fast_forward"], ["refs/tags/t", "tag_immutable"]]);
    }
  });

  it("a no-op update (new == current) is legal and drops nothing", async () => {
    const r = await evaluateRefTransaction({ "refs/heads/main": OID(1) }, { updates: [{ ref: "refs/heads/main", expected_old_oid: OID(1), new_oid: OID(1), force: false }] }, { isAncestor: never });
    assert.deepEqual(r, { refs: { "refs/heads/main": OID(1) }, dropped: [] });
  });

  it("refs/run402/* is protocol-owned: user pushes refuse, the protocol's own deploy move is allowed", async () => {
    const tx = deployRefTransaction({}, OID(1));
    assert.deepEqual(tx, { updates: [{ ref: GITVAULT_DEPLOY_REF, expected_old_oid: null, new_oid: OID(1), force: false }] });
    await rejectsCode(evaluateRefTransaction({}, tx, ff), "REFNAME_UNSUPPORTED");
    const allowed = await evaluateRefTransaction({}, tx, { ...ff, protocol_refs: "allow" });
    assert.deepEqual(allowed.refs, { [GITVAULT_DEPLOY_REF]: OID(1) });
    // the SECOND capture force-moves with a lease on the current tip; the displaced tip is dropped
    const move = deployRefTransaction(allowed.refs, OID(2));
    assert.deepEqual(move.updates[0], { ref: GITVAULT_DEPLOY_REF, expected_old_oid: OID(1), new_oid: OID(2), force: true });
    const moved = await evaluateRefTransaction(allowed.refs, move, { isAncestor: () => false, protocol_refs: "allow" });
    assert.deepEqual(moved.dropped, [{ ref: GITVAULT_DEPLOY_REF, oid: OID(1), reason: "force_displaced" }]);
  });

  /**
   * The rule above is only half the guarantee. `deployRefTransaction` is the
   * ONLY builder in the SDK that emits a protocol-owned ref, so every lane that
   * calls it MUST opt in with `protocol_refs: "allow"` — and a lane that forgets
   * refuses its own transaction LOCALLY, with `REFNAME_UNSUPPORTED` and no
   * trace_id, because the request never reaches the control plane.
   *
   * That is exactly what `gitvault.push()` did: it built the deploy-ref move and
   * left the option off, making `run402 gitvault push` a dead command while the
   * deploy lane — the identical move, one `protocol_refs` richer — worked. Unit
   * suites were green throughout: the rule was tested, the call sites were not.
   *
   * The remote helper is the deliberate NON-caller. It builds its transaction
   * from git's refspec, so its refnames are USER-supplied and it must keep the
   * `"refuse"` default — otherwise a user could squat `refs/run402/*`.
   */
  it("every deployRefTransaction call site opts into protocol refs (the push() defect, pinned)", () => {
    const sdkSrc = join(fileURLToPath(new URL(".", import.meta.url)), "..");
    const files = (function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (full.endsWith(".ts") && !full.endsWith(".test.ts") && !full.endsWith(".test-helper.ts")) out.push(full);
      }
      return out;
    })(sdkSrc);

    const callSites: Array<{ file: string; ok: boolean }> = [];
    for (const file of files) {
      // Comment-stripped, whitespace-collapsed: a gate a reformat can defeat is
      // not a gate (and this repo has been bitten by exactly that before).
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
        .replace(/\s+/g, " ");
      const re = /deployRefTransaction\s*\(/g;
      for (let m = re.exec(src); m !== null; m = re.exec(src)) {
        // the declaration itself is not a call site
        if (/function\s*$/.test(src.slice(0, m.index))) continue;
        // the enclosing push-options object literal, generously bounded
        const window = src.slice(m.index, m.index + 400);
        callSites.push({ file: relative(sdkSrc, file), ok: /protocol_refs\s*:\s*"allow"/.test(window) });
      }
    }

    assert.ok(callSites.length >= 2, `expected the capture lanes to be found, got ${callSites.length}`);
    assert.deepEqual(
      callSites.filter((c) => !c.ok).map((c) => c.file),
      [],
      "a deployRefTransaction call site with no `protocol_refs: \"allow\"` — that lane refuses its own transaction before it ever reaches the gateway",
    );
  });

  it("unsupported refnames are refused by name", async () => {
    for (const ref of ["refs/remotes/origin/main", "HEAD", "refs/heads/", "refs/heads/a..b", "refs/heads/a//b", "refs/heads/a@{0}", "refs/heads/a b", "refs/heads/a~1", "refs/heads/[x]"]) {
      await rejectsCode(evaluateRefTransaction({}, { updates: [{ ref, expected_old_oid: null, new_oid: OID(1), force: false }] }, ff), "REFNAME_UNSUPPORTED", `expected ${ref} refused`);
    }
  });

  it("cardinality bounds (§6.5 H10) refuse BEFORE acceptance: >1000 updates, >10 000 resulting refs", async () => {
    const many = Array.from({ length: GITVAULT_MAX_REF_UPDATES_PER_TRANSACTION + 1 }, (_v, i) => ({ ref: `refs/heads/b${i}`, expected_old_oid: null, new_oid: OID(1), force: false }));
    await rejectsCode(evaluateRefTransaction({}, { updates: many }, ff), "REF_STATE_LIMIT_EXCEEDED");
    const full: GitvaultRefMap = {};
    for (let i = 0; i < GITVAULT_MAX_CANONICAL_REFS; i++) full[`refs/heads/b${i}`] = OID(1);
    assertRefMapCardinality(full);
    await rejectsCode(evaluateRefTransaction(full, { updates: [{ ref: "refs/heads/one-too-many", expected_old_oid: null, new_oid: OID(1), force: false }] }, ff), "REF_STATE_LIMIT_EXCEEDED");
  });
});

// ─── §4.5 retention roots ────────────────────────────────────────────────────

vectors("§4.5 retention roots — vector class `retention-schedule`", () => {
  it("the ≥90-day lane runs from effective_admitted_at = max(prepared_at, record storage creation); removal is STRICT", () => {
    for (const v of byClass("retention-schedule")) {
      if (!v.inputs.retention_cutoff_ticket_cutoff_at) continue;
      mark(v);
      const effective = effectiveAdmittedAt(v.inputs.admission_prepared_at, v.inputs.admission_record_storage_created_at);
      assert.equal(effective, v.expected.effective_admitted_at, v.id);
      assert.equal(String(isRootEligibleForRemoval(effective, v.inputs.retention_cutoff_ticket_cutoff_at, Number(v.inputs.retention_days))), v.expected.eligible_for_removal, `${v.id}: ${v.description}`);
    }
  });

  it("evolution: roots(g+1) = roots(g) ∪ dropped (RENEWING an existing (ref,oid) key), sorted; expiry only at a checkpoint", () => {
    for (const v of byClass("retention-schedule")) {
      if (v.inputs.retention_cutoff_ticket_cutoff_at) continue;
      mark(v);
      const out = evolveRetentionRoots(v.inputs.roots_g as GitvaultRetentionRoot[], { generation: v.inputs.g_plus_1 ?? "0000000000000002", dropped: v.inputs.dropped_by_g_plus_1 ?? [] });
      assert.deepEqual(out, v.expected.roots_g_plus_1, `${v.id}: ${v.description}`);
    }
  });

  it("a non-checkpoint generation can never remove a root, however expired", () => {
    const roots: GitvaultRetentionRoot[] = [{ ref: "refs/heads/old", oid: OID(1), dropped_at_generation: "0000000000000001" }];
    assert.deepEqual(evolveRetentionRoots(roots, { generation: "0000000000000009", dropped: [] }), roots);
  });

  it("at a checkpoint expiry is PERMISSIVE: an unresolvable effective_admitted_at RETAINS the root", () => {
    const roots: GitvaultRetentionRoot[] = [
      { ref: "refs/heads/expired", oid: OID(1), dropped_at_generation: "0000000000000001" },
      { ref: "refs/heads/unknown", oid: OID(2), dropped_at_generation: "0000000000000002" },
    ];
    const kept = evolveRetentionRoots(roots, {
      generation: "0000000000000003",
      dropped: [],
      checkpoint_cutoff: { cutoff_at: "2026-06-01T00:00:00.000Z", effectiveAdmittedAt: (g) => (g === "0000000000000001" ? "2026-01-01T00:00:00.000Z" : null) },
    });
    assert.deepEqual(kept.map((r) => r.ref), ["refs/heads/unknown"]);
  });

  it("more than 50 000 roots is refused before acceptance", () => {
    const roots: GitvaultRetentionRoot[] = Array.from({ length: 50_000 }, (_v, i) => ({ ref: `refs/heads/r${i}`, oid: OID(i + 1), dropped_at_generation: "0000000000000001" }));
    assert.equal(evolveRetentionRoots(roots, { generation: "0000000000000002", dropped: [] }).length, 50_000);
    throwsCode(() => evolveRetentionRoots(roots, { generation: "0000000000000002", dropped: [{ ref: "refs/heads/extra", oid: OID(999_999), }] }), "REF_STATE_LIMIT_EXCEEDED");
  });
});

// ─── §6.3 / D186 heads listing ───────────────────────────────────────────────

vectors("§6.3 heads listing — vector class `heads_listing_pagination`", () => {
  const anchorOf = (v: Vector): string => v.inputs.request?.after_generation ?? v.inputs.response?.after_generation ?? "0000000000000002";

  /** The platform's cursor rule, modelled from the vector's declared binding: a cursor is valid only when it was minted FOR THIS VAULT under THIS anchor. */
  function serverCursorCheck(v: Vector): void {
    const req = v.inputs.request as GitvaultHeadsListingRequest | null;
    if (!req?.cursor) return;
    const binding = v.inputs.cursor_binding as { after_generation: string; repo_id: string } | null;
    if (!binding || binding.repo_id !== v.inputs.vault_repo_id || binding.after_generation !== req.after_generation) {
      throw new LocalError("cursor was not minted for this vault under this after_generation", "listing heads", { code: "INVALID_CURSOR" });
    }
  }

  function progressThroughPriorPages(v: Vector): GitvaultListingProgress {
    const anchor = anchorOf(v);
    let progress: GitvaultListingProgress = { after_generation: anchor, last_generation: anchor, delivered: 0 };
    for (const page of (v.inputs.prior_pages ?? []) as GitvaultHeadsListingPage[]) {
      progress = verifyHeadsListingPage(page, { after_generation: anchor, limit: "1000" }, progress, v.inputs.vault_repo_id);
    }
    return progress;
  }

  it("replays every pagination vector: request validation, cursor binding, coupling, gaplessness, truthful total", () => {
    for (const v of byClass("heads_listing_pagination")) {
      mark(v);
      const anchor = anchorOf(v);
      const req = v.inputs.request as GitvaultHeadsListingRequest | null;

      if (v.expected.request_schema_valid === "false") {
        assert.ok(req, `${v.id} has no request to refuse`);
        throwsCode(() => validateHeadsListingRequest(req!), v.reject_code ?? "GITVAULT_LISTING_REQUEST_INVALID", `${v.id}: ${v.description}`);
        continue;
      }
      if (req) validateHeadsListingRequest(req);
      if (v.reject_code === "INVALID_CURSOR") {
        throwsCode(() => serverCursorCheck(v), "INVALID_CURSOR", `${v.id}: ${v.description}`);
        continue;
      }
      if (req) serverCursorCheck(v);

      const progress = progressThroughPriorPages(v);
      const page = v.inputs.response as GitvaultHeadsListingPage | null;
      assert.ok(page, `${v.id} has no response page`);
      const verify = () => verifyHeadsListingPage(page!, { after_generation: anchor, limit: req?.limit ?? "1000" }, progress, v.inputs.vault_repo_id);
      if (v.expect_reject === "true") {
        const expected = v.reject_code ?? (v.reject_reason === "generation-not-above-anchor" ? "GENERATION_REGRESSION" : v.reject_reason === "total-untruthful" ? "CHAIN_BROKEN" : "GITVAULT_LISTING_PAGE_INVALID");
        throwsCode(verify, expected, `${v.id}: ${v.description}`);
        continue;
      }
      const advanced = verify();
      assert.deepEqual(page!.heads.map((h) => h.generation), v.expected.generations ?? page!.heads.map((h) => h.generation), `${v.id} generations`);
      if (v.expected.delivered_count) assert.equal(String(advanced.delivered), v.expected.delivered_count, `${v.id} delivered`);
      assert.equal(advanced.after_generation, anchor, `${v.id}: the anchor is CONSTANT across the sequence`);
      if (v.expected.continues_from) assert.equal(progress.last_generation, v.expected.continues_from, `${v.id} continues_from`);
    }
  });

  it("the continuation echoes the cursor UNCHANGED and never re-anchors (the 007/008 refusals are what editing earns)", () => {
    const page1 = byClass("heads_listing_pagination").find((v) => v.id === "heads-page-001")!.inputs.response as GitvaultHeadsListingPage;
    const drift = byClass("heads_listing_pagination").find((v) => v.id === "heads-page-007")!.inputs.request as GitvaultHeadsListingRequest;
    const tampered = byClass("heads_listing_pagination").find((v) => v.id === "heads-page-008")!.inputs.request as GitvaultHeadsListingRequest;
    const next = nextListingRequest({ after_generation: "0000000000000002", limit: "2" }, page1)!;
    assert.deepEqual(next, { after_generation: "0000000000000002", cursor: page1.next_cursor, limit: "2" });
    assert.notEqual(next.after_generation, drift.after_generation, "the SDK never re-anchors a continuation");
    assert.notEqual(next.cursor, tampered.cursor, "the SDK never edits a cursor byte");
    const final = byClass("heads_listing_pagination").find((v) => v.id === "heads-page-003")!.inputs.response as GitvaultHeadsListingPage;
    assert.equal(nextListingRequest({ after_generation: "0000000000000002", limit: "2" }, final), null);
  });
});

// ─── §6.4 pins + the transition rule ─────────────────────────────────────────

vectors("§6.4 pins + transitions — vector classes `chain` (005) and `transition-fail-closed`", () => {
  it("chain-005: a listing whose newest generation is BELOW the pin is GENERATION_REGRESSION", () => {
    const v = byClass("chain").find((x) => x.id === "chain-005")!;
    mark(v);
    assert.equal(String(generationToBigInt(v.inputs.listed_newest_generation) < generationToBigInt(v.inputs.pinned_generation)), v.expected.below_pin);
    throwsCode(() => checkGenerationRegression(v.inputs.listed_newest_generation, v.inputs.pinned_generation), "GENERATION_REGRESSION", v.description);
    checkGenerationRegression(v.inputs.pinned_generation, v.inputs.pinned_generation); // equal is not a regression
  });

  it("an ADMITTED non-null transition fails a V0 client CLOSED with UPGRADE_REQUIRED; an unknown kind is a closed-enum reject — EXCEPT rotate_epoch, ACTIVATED at rev 42 (D193) after this frozen vector set was authored", () => {
    for (const v of byClass("transition-fail-closed")) {
      mark(v);
      if (v.id === "transition-007") {
        // the vector is the rule itself, stated over a kind rather than an
        // object. This frozen vector set predates D193's rev-42 activation
        // of `rotate_epoch` — its OWN kind is the one exception this test
        // carves out (protocol-v0.md §4.3/D193): every other kind's
        // fail-closed assertion is unchanged and still exercised verbatim.
        const rotationHead = { generation: "0000000000000002", transition: { kind: v.inputs.admitted_head_transition_kind, payload_format: "base64url-jcs", payload: "e30", payload_sha256: "0".repeat(64) } } as unknown as GitvaultHead;
        if (v.inputs.admitted_head_transition_kind === "rotate_epoch") {
          assertNoTransition(rotationHead); // no throw — D193 activation
        } else {
          throwsCode(() => assertNoTransition(rotationHead), "UPGRADE_REQUIRED", v.description);
        }
        continue;
      }
      const head = v.inputs.object as GitvaultHead;
      if (head.transition === null) {
        assertNoTransition(head); // transition:null is the only V0-admissible value
        continue;
      }
      if (head.transition.kind === "rotate_epoch") {
        assertNoTransition(head); // D193, rev 42: no longer fail-closed — this vector predates activation
        continue;
      }
      const expected = v.reject_reason === "schema" ? "CHAIN_BROKEN" : "UPGRADE_REQUIRED";
      throwsCode(() => assertNoTransition(head), expected, `${v.id}: ${v.description}`);
    }
  });
});

// ─── §7.2 request→C1 binding ─────────────────────────────────────────────────

vectors("§7.2 request→C1 binding — vector class `request-to-c1-binding`", () => {
  it("the fence recomputes the binding from the record's OWN fields; a same-open-id retry with a different binding is CLIENT_OPEN_ID_CONFLICT", () => {
    for (const v of byClass("request-to-c1-binding")) {
      mark(v);
      if (v.inputs.c1_record) {
        const recomputed = openBindingDigest(v.inputs.client_open_id, v.inputs.c1_record);
        assert.equal(recomputed, v.expected.recomputed_open_binding_sha256, `${v.id} recomputed digest`);
        assert.equal(String(recomputed === v.inputs.issuance_open_binding_sha256), v.expected.equal, `${v.id} equality`);
        if (v.expected.equal === "true") checkOpenBinding(v.inputs.client_open_id, v.inputs.c1_record, v.inputs.issuance_open_binding_sha256);
        else throwsCode(() => checkOpenBinding(v.inputs.client_open_id, v.inputs.c1_record, v.inputs.issuance_open_binding_sha256), "GITVAULT_OPEN_BINDING_MISMATCH", `${v.id}: ${v.description}`);
        continue;
      }
      // 005/006: the retry converges on the winner, or conflicts
      assert.equal(String(v.inputs.retry_open_binding_sha256 === v.inputs.winner_open_binding_sha256), v.expected.equal, `${v.id}`);
      if (v.reject_code === "CLIENT_OPEN_ID_CONFLICT") {
        throwsCode(
          () => checkOpenBinding("cccccccccccccccccccccccccccccccc", { base_head_sha256: "a".repeat(64), prior_checkpoint_claim_set_sha256: "b".repeat(64), r2_cap_size_bytes: "1000" }, v.inputs.winner_open_binding_sha256, { retry: true }),
          "CLIENT_OPEN_ID_CONFLICT",
          v.description,
        );
      }
    }
  });
});

// ─── The vault, end to end, against the in-memory control plane ──────────────

describe("§6.2 push — the complete publication path", () => {
  const fixtures: VaultFixture[] = [];
  const open = async (): Promise<VaultFixture> => {
    const f = await makeVault();
    fixtures.push(f);
    return f;
  };
  const cleanup = () => {
    for (const f of fixtures.splice(0)) rmSync(f.root, { recursive: true, force: true });
  };

  it("first push: ref_state + retention_roots + a WAL pack_set, a read-back head, and BOTH pins advanced", async (t) => {
    t.after(cleanup);
    const f = await open();
    const main = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const r = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: main, force: false }] } });
    assert.equal(r.generation, "0000000000000001");
    assert.equal(r.form, "wal");
    assert.equal(r.conflicts_retried, 0);
    assert.deepEqual(r.refs, { "refs/heads/main": main });
    assert.equal(r.head.prev_sha256, f.keystore.readRepo(f.repoId)!.genesis_sha256, "generation 1 links to the genesis stored bytes");
    assert.equal(r.head.epoch, "0000000000000001");
    assert.equal(r.head.checkpoint, null);
    assert.equal(r.head.checkpoint_purpose, null);
    assert.equal(r.head.wal_entries.length, 1);
    assert.equal(r.head.wal_entries[0]!.base_generation, "0000000000000000");
    const repo = f.keystore.readRepo(f.repoId)!;
    assert.deepEqual([repo.head_pin?.generation, repo.materialized_pin?.generation], ["0000000000000001", "0000000000000001"]);
    assert.equal(repo.verified_prefix ?? null, null);
    // materializing again round-trips the encrypted carriers
    const state = await f.vault.materialize();
    assert.deepEqual(state.refs, { "refs/heads/main": main });
    assert.deepEqual(state.head_target, { kind: "symref", ref: "refs/heads/main" });
    assert.deepEqual(state.roots, []);
  });

  it("a second push chains onto the first and carries the complete canonical map", async (t) => {
    t.after(cleanup);
    const f = await open();
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const first = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    const second = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });
    assert.equal(second.generation, nextGeneration(first.generation));
    assert.equal(second.head.prev_sha256, first.head_sha256);
    const state = await f.vault.materialize();
    assert.deepEqual(state.refs, { "refs/heads/main": c2 });
    assert.equal(state.ref_state!.generation, second.generation, "the ref_state carries the COMPLETE map at its generation");
  });

  it("a dropped tip enters retention_roots in the SAME generation", async (t) => {
    t.after(cleanup);
    const f = await open();
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await git(f.repoDir, ["checkout", "-q", "-b", "feature"]);
    const c2 = await commitFile(f.repoDir, "f.txt", "f\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }, { ref: "refs/heads/feature", expected_old_oid: null, new_oid: c2, force: false }] } });
    const dropped = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/feature", expected_old_oid: c2, new_oid: null, force: false }] } });
    const state = await f.vault.materialize();
    assert.deepEqual(state.refs, { "refs/heads/main": c1 });
    assert.deepEqual(state.roots, [{ ref: "refs/heads/feature", oid: c2, dropped_at_generation: dropped.generation }]);
    assert.equal(state.retention_roots!.cutoff, null, "a non-checkpoint generation binds no cutoff ticket");
  });

  it("a finalization receipt that does not match the local manifest refuses BEFORE the head is signed", async (t) => {
    t.after(cleanup);
    const f = await open();
    const main = await git(f.repoDir, ["rev-parse", "HEAD"]);
    f.transport.tamperReceiptAt = 1;
    await rejectsCode(f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: main, force: false }] } }), "GITVAULT_RECEIPT_MISMATCH");
    assert.ok(!f.transport.calls.includes("admit:0000000000000001"), "no head is admitted over receipts we did not verify");
    assert.equal(f.keystore.readRepo(f.repoId)!.head_pin!.generation, "0000000000000000", "the pin stays at the genesis — nothing was published");
  });

  it("an admitted head that does not read back is NOT reported as landed and advances no pin", async (t) => {
    t.after(cleanup);
    const f = await open();
    const main = await git(f.repoDir, ["rev-parse", "HEAD"]);
    f.transport.tamperReadback = true;
    await rejectsCode(f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: main, force: false }] } }), "GITVAULT_HEAD_READBACK_MISMATCH");
    assert.equal(f.keystore.readRepo(f.repoId)!.head_pin!.generation, "0000000000000000", "no pin advances past the genesis");
  });

  it("a lost admission race re-verifies from storage, re-applies to the WINNER's map, and retries", async (t) => {
    t.after(cleanup);
    const f = await open();
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    // a second machine, same principal, lands `refs/heads/other` while our push is in flight
    const other = new GitvaultVault({ keystore: f.keystore, transport: f.transport, repo_id: f.repoId, repo_dir: f.repoDir });
    f.transport.competitor = async () => {
      await other.push({ transaction: { updates: [{ ref: "refs/heads/other", expected_old_oid: null, new_oid: c1, force: false }] } });
    };
    const r = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });
    assert.equal(r.conflicts_retried, 1);
    assert.equal(r.generation, "0000000000000003");
    assert.deepEqual(r.refs, { "refs/heads/main": c2, "refs/heads/other": c1 }, "the winner's ref survives the retry — never a silent revert");
  });

  it("design D1: a supplied base skips push's own materialize entirely on a clean first attempt", async (t) => {
    t.after(cleanup);
    const f = await open();
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    // The SAME snapshot a `list` call would have produced and handed to `push` (one materialize, shared).
    const base = await f.vault.materialize();

    const { GitvaultOpCounter, countingGitvaultTransport } = await import("./gitvault-transport-counter.test-helper.js");
    const counter = new GitvaultOpCounter();
    const counted = new GitvaultVault({ keystore: f.keystore, transport: countingGitvaultTransport(f.transport, counter), repo_id: f.repoId, repo_dir: f.repoDir });
    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    const published = await counted.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] }, base });
    assert.equal(published.conflicts_retried, 0);
    // No generation-read (genesis/readHead), no listHeads, no carrier batch —
    // a clean first attempt with a supplied base does none of materialize's
    // own work; only the upload + admit + readback a publish needs.
    const kinds = counter.byKind();
    assert.equal(kinds["generation-read"] ?? 0, 1, `only the post-admit readback — never readHead's own live pin check, since materialize itself never ran: ${JSON.stringify(kinds)}`);
    assert.equal(kinds["listHeads"] ?? 0, 0, `no listHeads call: ${JSON.stringify(kinds)}`);
    assert.ok(!("object-reads-batch(presign)" in kinds), `no carrier batch fetch: ${JSON.stringify(kinds)}`);
  });

  it("design D1: a conflict on a supplied (now-stale) base still re-materializes from storage and retries cleanly — never a local expected_old mismatch", async (t) => {
    t.after(cleanup);
    const f = await open();
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    // The base a `list` call observed BEFORE a concurrent publisher lands.
    const staleBase = await f.vault.materialize();
    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    const other = new GitvaultVault({ keystore: f.keystore, transport: f.transport, repo_id: f.repoId, repo_dir: f.repoDir });
    f.transport.competitor = async () => {
      await other.push({ transaction: { updates: [{ ref: "refs/heads/feature", expected_old_oid: null, new_oid: c1, force: false }] } });
    };
    // The transaction's expected_old_oid is derived from the SAME staleBase
    // (exactly what the remote helper does — one shared snapshot for both) —
    // so there is no LOCAL mismatch to raise; a race can only surface as the
    // CAS conflict-retry loop already handles, one clean conflict.
    const published = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: staleBase.refs["refs/heads/main"] ?? null, new_oid: c2, force: false }] }, base: staleBase });
    assert.equal(published.conflicts_retried, 1, "the stale base cost exactly one conflict, re-verified from storage — not a refused local mismatch");
    assert.deepEqual(published.refs, { "refs/heads/main": c2, "refs/heads/feature": c1 });
  });

  it("a transaction whose expected-old no longer matches the winner surfaces, it does not silently rebase", async (t) => {
    t.after(cleanup);
    const f = await open();
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    const c3 = await commitFile(f.repoDir, "c.txt", "c\n");
    const other = new GitvaultVault({ keystore: f.keystore, transport: f.transport, repo_id: f.repoId, repo_dir: f.repoDir });
    f.transport.competitor = async () => {
      await other.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c3, force: false }] } });
    };
    await rejectsCode(f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } }), "REF_EXPECTED_OLD_MISMATCH");
  });

  it("the verification budget is RESUMABLE: the verified prefix persists and the next call continues", async (t) => {
    t.after(cleanup);
    const f = await open();
    let tip = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: tip, force: false }] } });
    for (let i = 0; i < 2; i++) {
      const next = await commitFile(f.repoDir, `n${i}.txt`, `${i}\n`);
      await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: tip, new_oid: next, force: false }] } });
      tip = next;
    }
    // a fresh client with the same keystore but no pin (restored backup) verifies from the genesis
    f.keystore.updateRepo(f.repoId, { head_pin: null, materialized_pin: null, verified_prefix: null });
    const budgeted = new GitvaultVault({ keystore: f.keystore, transport: f.transport, repo_id: f.repoId, repo_dir: f.repoDir, verification_budget: 1 });
    await rejectsCode(budgeted.verifyToNewest(), "VERIFICATION_BUDGET_EXCEEDED");
    assert.equal(f.keystore.readRepo(f.repoId)!.verified_prefix?.generation, "0000000000000001");
    await rejectsCode(budgeted.verifyToNewest(), "VERIFICATION_BUDGET_EXCEEDED");
    assert.equal(f.keystore.readRepo(f.repoId)!.verified_prefix?.generation, "0000000000000002");
    const done = await budgeted.verifyToNewest();
    assert.equal(done.generation, "0000000000000003");
    assert.equal(f.keystore.readRepo(f.repoId)!.verified_prefix ?? null, null, "a completed verification clears the resumption watermark");
    assert.equal(f.keystore.readRepo(f.repoId)!.head_pin?.generation, "0000000000000003");
  });

  it("an authenticated-but-undecryptable carrier is CHAIN_UNUSABLE (read-only at the materialized pin)", async (t) => {
    t.after(cleanup);
    const f = await open();
    const main = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const r = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: main, force: false }] } });
    f.transport.objects.delete(`${f.repoId}/${gitvaultPaths.refState(r.head.ref_state.object_id)}`);
    await rejectsCode(f.vault.materialize(), "CHAIN_UNUSABLE");
  });

  it("a vault that lost a generation this client authenticated is a GENERATION_REGRESSION, not a broken link", async (t) => {
    t.after(cleanup);
    const f = await open();
    const main = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: main, force: false }] } });
    f.transport.objects.delete(`${f.repoId}/${gitvaultPaths.head("0000000000000001")}`);
    await rejectsCode(f.vault.verifyToNewest(), "GENERATION_REGRESSION");
  });

  it("a head whose stored bytes were substituted after admission is CHAIN_BROKEN", async (t) => {
    t.after(cleanup);
    const f = await open();
    const main = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: main, force: false }] } });
    const key = `${f.repoId}/${gitvaultPaths.head("0000000000000001")}`;
    f.transport.objects.set(key, new TextEncoder().encode(new TextDecoder().decode(f.transport.objects.get(key)!) + " "));
    await rejectsCode(f.vault.verifyToNewest(), "CHAIN_BROKEN");
  });

  it("detached HEAD is representable end to end and its commit is covered", async (t) => {
    t.after(cleanup);
    const f = await open();
    const main = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const r = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: main, force: false }] }, head_target: { kind: "detached", oid: main } });
    assert.deepEqual((await f.vault.materialize()).head_target, { kind: "detached", oid: main });
    assert.deepEqual(GitvaultVault.coverageTips(r.refs, [], { kind: "detached", oid: main }), [main]);
  });
});

// ─── planPush — the REAL dry run (kychee-com/run402#565) ─────────────────────
//
// The claim under test: planPush computes EXACTLY what push WOULD compute at
// the same base — same generation, same form, same refs, same object sizes —
// by running the identical local pipeline, and never calls the transport's
// two mutating routes (upload:*, admit:*). Proven two ways: (1) the memory
// transport's own `calls` log never gains an upload/admit entry across a
// planPush; (2) a planPush immediately followed by a REAL push over the SAME
// transaction reports the SAME generation/form/refs/object sizes the plan
// predicted — a plan that lied would diverge from the push it predicted.

describe("planPush — a real, non-mutating preview of push (kychee-com/run402#565)", () => {
  const fixtures: VaultFixture[] = [];
  const open = async (): Promise<VaultFixture> => {
    const f = await makeVault();
    fixtures.push(f);
    return f;
  };
  const cleanup = () => {
    for (const f of fixtures.splice(0)) rmSync(f.root, { recursive: true, force: true });
  };

  it("publishes NOTHING: no upload or admit call reaches the transport", async (t) => {
    t.after(cleanup);
    const f = await open();
    const main = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const before = f.transport.calls.length;
    await f.vault.planPush({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: main, force: false }] } });
    const after = f.transport.calls.slice(before);
    assert.ok(after.every((c) => !c.startsWith("upload:") && !c.startsWith("admit:")), `planPush must never upload or admit; saw: ${JSON.stringify(after)}`);
    // The pin stays at the GENESIS generation (materialize()'s ordinary
    // bookkeeping for a heads-less vault) — nothing beyond genesis was ever
    // admitted, i.e. no generation advanced past "0000000000000000".
    assert.equal(f.keystore.readRepo(f.repoId)!.head_pin?.generation, "0000000000000000");
  });

  it("reports plausible, REAL sizes: a plan's generation/form/refs/objects match the push it predicted", async (t) => {
    t.after(cleanup);
    const f = await open();
    const main = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const transaction = { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: main, force: false }] };
    const plan = await f.vault.planPush({ transaction });
    assert.equal(plan.base_generation, "0000000000000000");
    assert.equal(plan.would_admit_generation, "0000000000000001");
    assert.equal(plan.would_admit_generation_decimal, "1");
    assert.equal(plan.form, "wal");
    assert.deepEqual(plan.refs, { "refs/heads/main": main });
    assert.equal(plan.object_count, plan.objects.length);
    assert.ok(plan.object_count >= 2, "at least ref_state + retention_roots");
    assert.ok(BigInt(plan.encrypted_bytes) > 0n);
    assert.ok(BigInt(plan.raw_bytes) > 0n);
    assert.ok(plan.objects.some((o) => o.object_kind === "ref_state"));
    assert.ok(plan.objects.some((o) => o.object_kind === "retention_roots"));

    // A SECOND, independent vault instance (same transport/keystore — a
    // fresh open, the same way a second CLI invocation would be) runs the
    // REAL push over the identical transaction and must land at exactly
    // what the plan predicted.
    const real = await f.vault.push({ transaction });
    assert.equal(real.generation, plan.would_admit_generation);
    assert.equal(real.form, plan.form);
    assert.deepEqual(real.refs, plan.refs);
  });

  it("a checkpoint-forcing plan reports form: checkpoint, matching a real forced push", async (t) => {
    t.after(cleanup);
    const f = await open();
    const main = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const transaction = { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: main, force: false }] };
    const plan = await f.vault.planPush({ transaction, checkpoint: true });
    assert.equal(plan.form, "checkpoint");
    assert.ok(plan.objects.some((o) => o.object_kind === "checkpoint_manifest"));
    const real = await f.vault.push({ transaction, checkpoint: true });
    assert.equal(real.form, "checkpoint");
    assert.equal(real.generation, plan.would_admit_generation);
  });

  it("a plan against a non-fast-forward transaction refuses the SAME way a real push would — never a fake ok", async (t) => {
    t.after(cleanup);
    const f = await open();
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    // expected_old_oid is stale (null — a CREATE — but the ref already exists via the push above) — same shape a real push refuses.
    await rejectsCode(
      f.vault.planPush({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c2, force: false }] } }),
      "REF_EXPECTED_OLD_MISMATCH",
    );
  });

  it("running planPush repeatedly against an unchanged base is idempotent — no local state drift", async (t) => {
    t.after(cleanup);
    const f = await open();
    const main = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const transaction = { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: main, force: false }] };
    const first = await f.vault.planPush({ transaction });
    const second = await f.vault.planPush({ transaction });
    assert.equal(first.would_admit_generation, second.would_admit_generation);
    assert.equal(first.encrypted_bytes, second.encrypted_bytes);
  });
});

describe("§4.7 checkpoint sets", () => {
  it("a forced checkpoint head carries an EMPTY WAL set, an owner-signed claim set, and passes acceptance from the set ALONE", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const r = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] }, checkpoint: true });
    assert.equal(r.form, "checkpoint");
    assert.deepEqual(r.head.wal_entries, []);
    assert.equal(r.head.checkpoint_purpose, "ordinary_push");
    assert.equal(r.head.checkpoint!.covers_through_generation, r.generation);
    assert.equal(r.head.checkpoint!.cutoff, null, "no removals ⇒ the no-removal form may omit the ticket");
    assert.equal(r.head.checkpoint!.claim_set.object_kind, "checkpoint_claim_set");
    // the claim set is stored as plaintext-structured JSON and receipted by its STORED bytes
    const stored = f.transport.objects.get(`${f.repoId}/${gitvaultPaths.claimSet(r.head.checkpoint!.claim_set.object_id)}`)!;
    assert.equal(sha256Hex(stored), r.head.checkpoint!.claim_set.stored_bytes_sha256);
    const claimSet = JSON.parse(new TextDecoder().decode(stored));
    assert.equal(claimSet.writer_key_id, f.keystore.readIdentity()!.signing_fingerprint);
    assert.equal(BigInt(claimSet.total_stored_size_bytes), BigInt(claimSet.manifest_receipt.size_bytes) + claimSet.ordered_pack_receipts.reduce((a: bigint, p: { size_bytes: string }) => a + BigInt(p.size_bytes), 0n));
  });

  it("cross-field equality is normative: a claim set that disagrees with its manifest fails acceptance", () => {
    const manifest = { object_id: "chk_" + "1".repeat(32), covers_through_generation: "0000000000000002", packs: [{ object_id: "ckp_" + "2".repeat(32), plaintext_sha256: "a".repeat(64), plaintext_size_bytes: "10", ciphertext_sha256: "b".repeat(64), size_bytes: "42" }] };
    const claim = {
      object_id: "ccs_" + "3".repeat(32), covers_through_generation: "0000000000000002",
      manifest_receipt: { object_id: manifest.object_id, object_kind: "checkpoint_manifest", ciphertext_sha256: "c".repeat(64), size_bytes: "100" },
      ordered_pack_receipts: [{ object_id: manifest.packs[0]!.object_id, object_kind: "checkpoint_pack", ciphertext_sha256: "b".repeat(64), size_bytes: "42" }],
      total_stored_size_bytes: "142",
    };
    /* eslint-disable @typescript-eslint/no-explicit-any */
    checkClaimSetEquality(claim as any, manifest as any, "0000000000000002");
    throwsCode(() => checkClaimSetEquality(claim as any, manifest as any, "0000000000000003"), "CHECKPOINT_INCOMPLETE");
    throwsCode(() => checkClaimSetEquality({ ...claim, total_stored_size_bytes: "143" } as any, manifest as any, "0000000000000002"), "CHECKPOINT_INCOMPLETE");
    throwsCode(() => checkClaimSetEquality({ ...claim, ordered_pack_receipts: [{ ...claim.ordered_pack_receipts[0]!, size_bytes: "43" }] } as any, manifest as any, "0000000000000002"), "CHECKPOINT_INCOMPLETE");
    throwsCode(() => checkClaimSetEquality({ ...claim, ordered_pack_receipts: [] } as any, manifest as any, "0000000000000002"), "CHECKPOINT_INCOMPLETE");
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  it("publishCheckpoint binds a fresh cutoff ticket and retains roots it cannot prove expired", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await git(f.repoDir, ["checkout", "-q", "-b", "feature"]);
    const c2 = await commitFile(f.repoDir, "f.txt", "f\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }, { ref: "refs/heads/feature", expected_old_oid: null, new_oid: c2, force: false }] } });
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/feature", expected_old_oid: c2, new_oid: null, force: false }] } });

    const kept = await f.vault.publishCheckpoint();
    assert.equal(kept.form, "checkpoint");
    assert.ok(kept.head.checkpoint!.cutoff, "the head binds the ticket it evaluated expiry against");
    assert.equal(kept.head.checkpoint!.cutoff!.cutoff_at, (await f.vault.materialize()).retention_roots!.cutoff!.cutoff_at);
    assert.deepEqual((await f.vault.materialize()).roots.map((r) => r.ref), ["refs/heads/feature"], "unresolvable effective_admitted_at RETAINS");
    assert.deepEqual((await f.vault.materialize()).refs, { "refs/heads/main": c1 }, "a checkpoint-only generation changes no ref");

    // with a resolver that puts the drop well past its lane, the same root leaves the map
    const swept = await f.vault.publishCheckpoint({ cutoff: { effectiveAdmittedAt: () => "2000-01-01T00:00:00.000Z" } });
    assert.equal(swept.form, "checkpoint");
    assert.deepEqual((await f.vault.materialize()).roots, []);
  });

  it("a covered tip missing from the local repository refuses the checkpoint rather than shipping an unrestorable set", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const absent = `${"0".repeat(39)}1`; // well-formed, and no such object exists here
    await rejectsCode(f.vault.push({ transaction: { updates: [{ ref: "refs/heads/ghost", expected_old_oid: null, new_oid: absent, force: false }] }, checkpoint: true }), "CHECKPOINT_INCOMPLETE");
  });
});

describe("§4.3 repair + restore", () => {
  it("a repair head supersedes an interval, preserves every unreachable superseded tip as a root, and carries a mandatory checkpoint", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const g1 = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    await git(f.repoDir, ["checkout", "-q", "-b", "feature"]);
    const c2 = await commitFile(f.repoDir, "f.txt", "f\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/feature", expected_old_oid: null, new_oid: c2, force: false }] } });

    const repaired = await f.vault.repair({ base_generation: g1.generation, reason: "unusable_ref_state" });
    assert.equal(repaired.generation, "0000000000000003");
    assert.equal(repaired.form, "checkpoint");
    assert.equal(repaired.head.checkpoint_purpose, "repair");
    assert.ok(repaired.head.checkpoint, "a repair head MUST carry a freshly accepted self-contained checkpoint");
    assert.deepEqual(repaired.head.repair, { base_generation: g1.generation, base_head_sha256: g1.head_sha256, supersedes_from: "0000000000000002", supersedes_through: "0000000000000002", reason: "unusable_ref_state" });
    const state = await f.vault.materialize();
    assert.deepEqual(state.refs, { "refs/heads/main": c1 }, "the repaired state is the base generation's map");
    assert.deepEqual(state.roots, [{ ref: "refs/heads/feature", oid: c2, dropped_at_generation: repaired.generation }], "the superseded tip is preserved with a FRESH lane");
  });

  it("a repair cannot base on the genesis or on the newest generation", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const g1 = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    await rejectsCode(f.vault.repair({ base_generation: g1.generation, reason: "corrupt_referenced_object" }), "REPAIR_TARGET_UNPRESERVABLE");
    await rejectsCode(f.vault.repair({ base_generation: "0000000000000000", reason: "corrupt_referenced_object" }), "REPAIR_TARGET_UNPRESERVABLE");
  });

  it("restore pulls the newest checkpoint plus every later WAL pack and proves the whole coverage set resolves", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] }, checkpoint: true });
    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });

    const target = mkdtempSync(join(tmpdir(), "run402-gitvault-restore-"));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    mkdirSync(target, { recursive: true });
    await git(target, ["init", "-q", "--bare", "."]);
    const restored = await f.vault.restoreObjectsInto(target);
    assert.deepEqual(restored.refs, { "refs/heads/main": c2 });
    assert.equal(await hasObject(target, c1), true);
    assert.equal(await hasObject(target, c2), true);
  });
});

// ─── local object cache (gitvault-client-round-trips design D3) ──────────────

describe("local immutable-object cache — re-verified on every use", () => {
  it("a tampered cached head is discarded and refetched — the refetch is verified exactly as a cold read", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    await git(f.repoDir, ["checkout", "-q", "-b", "feature"]);
    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    const g2 = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/feature", expected_old_oid: null, new_oid: c2, force: false }] } });
    const c3 = await commitFile(f.repoDir, "c.txt", "c\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/feature", expected_old_oid: c2, new_oid: c3, force: false }] } });

    // A first restore's downward walk fetches AND caches generation 2's
    // head (readCachedHeadBytes writes on every network hit, regardless of
    // caller) on its way from generation 3 down to genesis.
    const targetA = mkdtempSync(join(tmpdir(), "run402-gitvault-cache-tamper-a-"));
    t.after(() => rmSync(targetA, { recursive: true, force: true }));
    mkdirSync(targetA, { recursive: true });
    await git(targetA, ["init", "-q", "--bare", "."]);
    await f.vault.restoreObjectsInto(targetA);

    // Tamper the LOCAL cache entry for generation 2 directly — bytes that
    // no longer hash to anything the chain would accept.
    f.keystore.writeCachedHead(f.repoId, g2.generation, "00".repeat(32), new TextEncoder().encode("tampered"));

    // A second, INDEPENDENT restore (fresh target, no marker) re-walks the
    // SAME wholesale range — its downward walk hits the tampered cache
    // entry for generation 2, must discard it (the recomputed hash does not
    // match the chain-verified expectation), and fetch it from the network
    // instead — landing the CORRECT final state, not a corrupted one.
    const targetB = mkdtempSync(join(tmpdir(), "run402-gitvault-cache-tamper-b-"));
    t.after(() => rmSync(targetB, { recursive: true, force: true }));
    mkdirSync(targetB, { recursive: true });
    await git(targetB, ["init", "-q", "--bare", "."]);
    const restored = await f.vault.restoreObjectsInto(targetB);
    assert.deepEqual(restored.refs, { "refs/heads/main": c1, "refs/heads/feature": c3 });
    assert.equal(await hasObject(targetB, c1), true);
    assert.equal(await hasObject(targetB, c2), true);
    assert.equal(await hasObject(targetB, c3), true);

    // The cache now holds the CORRECT bytes again (refetch re-verified and re-cached), not the tampered ones.
    const healed = f.keystore.readCachedHead(f.repoId, g2.generation);
    assert.notEqual(healed?.sha256, "00".repeat(32));
  });

  it("a cold cache (nothing ever cached) degrades to plain network reads with no user-visible failure", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    // A SEPARATE vault instance sharing the same keystore/repo but never
    // having warmed anything itself — its very first read is a cold cache.
    const fresh = new GitvaultVault({ keystore: f.keystore, transport: f.transport, repo_id: f.repoId, repo_dir: f.repoDir });
    const state = await fresh.materialize();
    assert.deepEqual(state.refs, { "refs/heads/main": c1 });
  });
});

// ─── incremental restore (gitvault-client-round-trips design D5) ─────────────

describe("restoreObjectsInto — incremental above restored_through", () => {
  it("a one-generation pull replays only the new generation's pack, and advances the marker", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const g1 = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });

    const target = mkdtempSync(join(tmpdir(), "run402-gitvault-restore-incr-"));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    mkdirSync(target, { recursive: true });
    await git(target, ["init", "-q", "--bare", "."]);

    const first = await f.vault.restoreObjectsInto(target);
    assert.deepEqual(first.refs, { "refs/heads/main": c1 });
    const markerAfterFirst = await readGitvaultRestoreMarker(target);
    assert.deepEqual(markerAfterFirst, { generation: g1.generation, head_sha256: g1.head_sha256 });

    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    const g2 = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });

    const callsBefore = f.transport.calls.length;
    const second = await f.vault.restoreObjectsInto(target);
    assert.deepEqual(second.refs, { "refs/heads/main": c2 });
    assert.equal(await hasObject(target, c2), true);
    // The batched WAL-pack read (design D2's restore pack set) names exactly
    // ONE object — generation 2's own pack — never generation 1's (already
    // applied and covered by the marker).
    const newCalls = f.transport.calls.slice(callsBefore);
    const walPathsFetched = newCalls.filter((c) => c.startsWith("get-batch:")).flatMap((c) => c.split(":")[2]?.split(",").filter((p) => p.startsWith("wal/")) ?? []);
    assert.equal(walPathsFetched.length, 1, `expected exactly one WAL pack fetched, saw: ${JSON.stringify(newCalls)}`);
    const markerAfterSecond = await readGitvaultRestoreMarker(target);
    assert.deepEqual(markerAfterSecond, { generation: g2.generation, head_sha256: g2.head_sha256 });
  });

  it("a fetch that is already up to date makes no pack read, and only ONE state read (gitvault-composite-state-read D1)", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const target = mkdtempSync(join(tmpdir(), "run402-gitvault-restore-uptodate-"));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    mkdirSync(target, { recursive: true });
    await git(target, ["init", "-q", "--bare", "."]);
    await f.vault.restoreObjectsInto(target);

    f.transport.calls.length = 0;
    const again = await f.vault.restoreObjectsInto(target);
    assert.deepEqual(again.refs, { "refs/heads/main": c1 });
    // No pack read at all — the marker fast path skips the walk entirely.
    assert.equal(f.transport.calls.filter((c) => c.startsWith("get-batch:")).length, 0, "no batched pack/carrier read for an up-to-date target");
    // Pre-gitvault-composite-state-read, the "server still holds the pin"
    // liveness check was a DEDICATED `get:head/<generation>` call
    // (`readHead`) on every `verifyToNewest`. Design D1 folds that check
    // into the SAME `GET …/state` read the pin-current fast path already
    // needs: the state response's own head bytes serve as the live
    // confirmation (hash-checked against the pin — see
    // `GitvaultVault.tryStateFastPath`), so a dedicated head read is no
    // longer issued for this case, and a fresh regression is still caught
    // exactly as loudly (see the CHAIN_BROKEN/GENERATION_REGRESSION tests
    // above and below, unaffected by this fold).
    assert.equal(f.transport.calls.filter((c) => c.startsWith("get:head/")).length, 0, "no dedicated pin-verification head read — folded into the state read");
    assert.equal(f.transport.calls.filter((c) => c === "state").length, 1, "exactly one state read serves both the pin-verification and pin-current checks");
  });

  it("a repair landing above the marker forces the wholesale path, and still restores the correct state", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const g1 = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });

    const target = mkdtempSync(join(tmpdir(), "run402-gitvault-restore-repair-"));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    mkdirSync(target, { recursive: true });
    await git(target, ["init", "-q", "--bare", "."]);
    await f.vault.restoreObjectsInto(target); // marker now at generation 2, plain WAL

    // A repair based on generation 1 supersedes generation 2 and lands a
    // checkpoint-bearing head ABOVE the marker — exactly the shape design D5
    // says must force wholesale.
    const repaired = await f.vault.repair({ base_generation: g1.generation, reason: "unusable_ref_state" });
    assert.equal(repaired.form, "checkpoint");

    const second = await f.vault.restoreObjectsInto(target);
    // Ground truth: what a completely fresh (wholesale, no marker at all) restore produces.
    const fresh = mkdtempSync(join(tmpdir(), "run402-gitvault-restore-fresh-"));
    t.after(() => rmSync(fresh, { recursive: true, force: true }));
    mkdirSync(fresh, { recursive: true });
    await git(fresh, ["init", "-q", "--bare", "."]);
    const wholesale = await f.vault.restoreObjectsInto(fresh);
    assert.deepEqual(second.refs, wholesale.refs);
    assert.deepEqual(second.refs, { "refs/heads/main": c1 });
    assert.equal(await hasObject(target, c1), true);
    const markerAfter = await readGitvaultRestoreMarker(target);
    assert.deepEqual(markerAfter, { generation: repaired.generation, head_sha256: repaired.head_sha256 });
  });

  it("an interrupted restore leaves the marker unadvanced, and the next fetch heals", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const target = mkdtempSync(join(tmpdir(), "run402-gitvault-restore-interrupt-"));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    mkdirSync(target, { recursive: true });
    await git(target, ["init", "-q", "--bare", "."]);
    await f.vault.restoreObjectsInto(target); // marker at generation 1

    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });

    // Simulate a crash mid-restore: the generation-2 WAL pack batch read
    // fails exactly once, then behaves normally.
    const originalGetObjects = f.transport.getObjects.bind(f.transport);
    let failNext = true;
    f.transport.getObjects = async (req: { repo_id: string; paths: string[] }) => {
      if (failNext && req.paths.some((p) => p.startsWith("wal/"))) {
        failNext = false;
        throw new Error("simulated network interruption");
      }
      return originalGetObjects(req);
    };
    await assert.rejects(f.vault.restoreObjectsInto(target), /simulated network interruption/);
    f.transport.getObjects = originalGetObjects;

    // The marker is UNCHANGED from before the failed attempt (still
    // generation 1, the only successful restore so far) — the failure was
    // never reported as landed.
    const markerAfterFailure = await readGitvaultRestoreMarker(target);
    assert.equal(markerAfterFailure!.generation, "0000000000000001");
    const healed = await f.vault.restoreObjectsInto(target);
    assert.deepEqual(healed.refs, { "refs/heads/main": c2 });
    assert.equal(await hasObject(target, c2), true);
  });
});

// ─── clone-installs-retained-refs (D1-D5): refs/r402/retain/* ────────────────

/** A root, unrelated commit — never an ancestor of anything else built this way (no `-p` parent). */
async function orphanCommit(dir: string, label: string): Promise<string> {
  const blob = await git(dir, ["hash-object", "-w", "-t", "blob", "--stdin"], `${label}\n`);
  const tree = await git(dir, ["mktree"], `100644 blob ${blob}\t${label}.txt\n`);
  return git(dir, ["commit-tree", tree, "-m", `orphan ${label}`]);
}

async function makeRetainTestRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-retain-repo-"));
  mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main", "."]);
  return dir;
}

describe("clone-installs-retained-refs — refs/r402/retain/* reconciliation", () => {
  it("restoreObjectsInto installs a retained ref for a branch-unreachable, force-displaced tip; git fsck is silent", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] }, checkpoint: true });
    // An unrelated (orphan) commit force-displaces c1 off main — the same
    // shape a deploy re-capture produces against refs/run402/deploys/latest,
    // generalized to any force-updated branch (D2's own wording is "the
    // vault's admitted history", not "deploy captures" specifically).
    const c2 = await orphanCommit(f.repoDir, "unrelated");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: true }] } });

    const target = mkdtempSync(join(tmpdir(), "run402-gitvault-retain-clone-"));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    mkdirSync(target, { recursive: true });
    await git(target, ["init", "-q", "--bare", "."]);
    const restored = await f.vault.restoreObjectsInto(target);

    assert.deepEqual(restored.refs, { "refs/heads/main": c2 });
    const retainRef = gitvaultRetainedRefName(c1);
    assert.deepEqual(restored.retained_refs, { written: [retainRef], deleted: [], retained_count: 1, warning: null });
    assert.equal(await git(target, ["rev-parse", retainRef]), c1);

    // `restoreObjectsInto` restores OBJECTS only — canonical branch refs are
    // git's OWN job in the real remote-helper protocol (`list` advertises
    // them, git writes them; see git-remote-run402.mjs's own header comment).
    // Reproduce that one step so `git fsck` sees exactly what a real `git
    // clone` leaves behind, and assert the spec's own acceptance scenario:
    // a fresh clone is fsck-silent.
    for (const [ref, oid] of Object.entries(restored.refs)) await git(target, ["update-ref", ref, oid]);
    const fsckOut = await git(target, ["fsck", "--full"]);
    assert.doesNotMatch(fsckOut, /dangling commit/);
  });

  it("skips a retained tip already reachable from a canonical ref — no redundant ref (D2)", async (t) => {
    const repoDir = await makeRetainTestRepo();
    t.after(() => rmSync(repoDir, { recursive: true, force: true }));
    const c1 = await commitFile(repoDir, "a.txt", "a\n");
    const c2 = await commitFile(repoDir, "b.txt", "b\n"); // c2 is a descendant of c1

    const result = await reconcileRetainedTipRefs(repoDir, {
      refs: { "refs/heads/main": c2 },
      // c1 is named as a retention root (as if some OTHER, now-deleted ref
      // once pointed at it) but is still reachable through main's own history.
      roots: [{ ref: "refs/heads/old", oid: c1, dropped_at_generation: "0000000000000002" }],
      head_target: { kind: "symref", ref: "refs/heads/main" },
    });
    assert.deepEqual(result, { written: [], deleted: [], retained_count: 0, warning: null });
    const listed = await git(repoDir, ["for-each-ref", GITVAULT_RETAIN_REF_PREFIX]);
    assert.equal(listed, "");
  });

  it("a vault-canonical protocol ref's tip (refs/run402/*) joins the retain set — git never writes it locally (live-acceptance catch)", async (t) => {
    const repoDir = await makeRetainTestRepo();
    t.after(() => rmSync(repoDir, { recursive: true, force: true }));
    const c1 = await commitFile(repoDir, "a.txt", "a\n");
    // A capture commit off to the side, as the deploy lane produces: present
    // in the object db, named only by a refs/run402/* ref in the vault map.
    await git(repoDir, ["checkout", "-q", "--detach", c1]);
    const capture = await commitFile(repoDir, "capture.txt", "wip\n");
    await git(repoDir, ["checkout", "-q", "main"]);

    const result = await reconcileRetainedTipRefs(repoDir, {
      refs: { "refs/heads/main": c1, "refs/run402/deploys/latest": capture },
      roots: [],
      head_target: { kind: "symref", ref: "refs/heads/main" },
    });
    assert.equal(result.warning, null);
    assert.equal(result.retained_count, 1);
    assert.equal(await git(repoDir, ["rev-parse", `${GITVAULT_RETAIN_REF_PREFIX}${capture}`]), capture);
    // And main's own tip gained no redundant ref.
    const listed = await git(repoDir, ["for-each-ref", "--format=%(refname)", GITVAULT_RETAIN_REF_PREFIX]);
    assert.deepEqual(listed.split("\n").filter(Boolean), [`${GITVAULT_RETAIN_REF_PREFIX}${capture}`]);
  });

  it("adds refs for every retained tip, then retracts one on the next reconcile — namespace-scoped, nothing else touched", async (t) => {
    const repoDir = await makeRetainTestRepo();
    t.after(() => rmSync(repoDir, { recursive: true, force: true }));
    const oidX = await orphanCommit(repoDir, "x");
    const oidY = await orphanCommit(repoDir, "y");
    const oidDecoy = await orphanCommit(repoDir, "decoy");
    await git(repoDir, ["update-ref", "refs/heads/decoy", oidDecoy]);

    const rootsWithX = [
      { ref: "refs/heads/x", oid: oidX, dropped_at_generation: "0000000000000002" },
      { ref: "refs/heads/y", oid: oidY, dropped_at_generation: "0000000000000003" },
    ];
    const first = await reconcileRetainedTipRefs(repoDir, { refs: {}, roots: rootsWithX, head_target: { kind: "symref", ref: "refs/heads/main" } });
    assert.deepEqual(new Set(first.written), new Set([gitvaultRetainedRefName(oidX), gitvaultRetainedRefName(oidY)]));
    assert.deepEqual(first.deleted, []);
    assert.equal(first.retained_count, 2);
    assert.equal(first.warning, null);

    // The vault has since pruned X (X's own root is gone from the materialized set) — reconcile again.
    const second = await reconcileRetainedTipRefs(repoDir, {
      refs: {},
      roots: [{ ref: "refs/heads/y", oid: oidY, dropped_at_generation: "0000000000000003" }],
      head_target: { kind: "symref", ref: "refs/heads/main" },
    });
    assert.deepEqual(second.written, []);
    assert.deepEqual(second.deleted, [gitvaultRetainedRefName(oidX)]);
    assert.equal(second.retained_count, 1);

    assert.equal(await git(repoDir, ["rev-parse", gitvaultRetainedRefName(oidY)]), oidY, "Y's ref survives — only X's own root was pruned");
    await assert.rejects(git(repoDir, ["rev-parse", "--verify", gitvaultRetainedRefName(oidX)]), "X's ref was retracted");
    assert.equal(await git(repoDir, ["rev-parse", "refs/heads/decoy"]), oidDecoy, "reconcile is namespace-scoped — a ref outside refs/r402/ is never touched");
  });

  it("degrades to a warning and touches nothing further on a ref-write failure — never throws (D3)", async (t) => {
    if (process.getuid?.() === 0) return; // root ignores file modes — the failure this test injects cannot occur
    const repoDir = await makeRetainTestRepo();
    t.after(() => rmSync(repoDir, { recursive: true, force: true }));
    const oidX = await orphanCommit(repoDir, "x");
    const refsDir = join(repoDir, ".git", "refs");
    chmodSync(refsDir, 0o500); // read + execute, no write — update-ref cannot create refs/r402/retain/*
    try {
      const result = await reconcileRetainedTipRefs(repoDir, {
        refs: {},
        roots: [{ ref: "refs/heads/x", oid: oidX, dropped_at_generation: "0000000000000002" }],
        head_target: { kind: "symref", ref: "refs/heads/main" },
      });
      assert.deepEqual(result.written, []);
      assert.deepEqual(result.deleted, []);
      assert.match(result.warning ?? "", /refs\/r402\/retain bookkeeping failed/);
    } finally {
      chmodSync(refsDir, 0o700);
    }
  });

  it("is a silent no-op — not a warning — when repoDir names no git repository at all", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gitvault-retain-norepo-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const result = await reconcileRetainedTipRefs(dir, {
      refs: {},
      roots: [{ ref: "refs/heads/x", oid: OID(1), dropped_at_generation: "0000000000000002" }],
      head_target: { kind: "symref", ref: "refs/heads/main" },
    });
    assert.deepEqual(result, { written: [], deleted: [], retained_count: 0, warning: null });
  });
});

// ─── Coverage tally ──────────────────────────────────────────────────────────

vectors("vector coverage tally", () => {
  it("every vector of each fully-replayed class was exercised", () => {
    const summary: Record<string, string> = {};
    for (const cls of ["heads_listing_pagination", "retention-schedule", "transition-fail-closed", "request-to-c1-binding"]) {
      const have = replayed.get(cls)?.size ?? 0;
      const want = Number(vectorFile!.counts_by_class[cls]);
      summary[cls] = `${have}/${want}`;
      assert.equal(have, want, `class ${cls}: replayed ${have} of ${want}`);
    }
    // `chain` is split: the crypto suite owns the four signature/linkage vectors, this suite owns
    // chain-005 (a PIN comparison). Assert the split explicitly so it cannot drift into a gap.
    assert.deepEqual([...(replayed.get("chain") ?? [])], ["chain-005"]);
    summary.chain = "1/5 (chain-001..004 are the crypto suite's)";
    // eslint-disable-next-line no-console
    console.log(`gitvault publication vectors rev ${vectorFile!["x-r402s-revision"]}: ${JSON.stringify(summary)}`);
  });
});

// ─── gitvault-clone-scaling: page-batched walk fidelity + checkpoint staleness ─

describe("gitvault-clone-scaling — the batched page walk keeps unbatched failure fidelity", () => {
  /** A vault with 3 generations (main + two ref-only branches) and a COLD second keystore — the clone shape, and enough heads that the page prefetch engages (single-miss pages skip it). */
  const coldFixture = async () => {
    const f = await makeVault();
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/b1", expected_old_oid: null, new_oid: c1, force: false }] } });
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/b2", expected_old_oid: null, new_oid: c1, force: false }] } });
    const repo = f.keystore.readRepo(f.repoId)!;
    const coldKeystore = GitvaultKeystore.open({ rootDir: join(f.root, "ks-cold") });
    coldKeystore.ensureIdentity();
    coldKeystore.saveRepo({
      repo_id: f.repoId, org_id: repo.org_id, project_id: repo.project_id,
      k_repo_hex: repo.k_repo_hex, epoch: repo.epoch, genesis_sha256: repo.genesis_sha256,
      head_pin: null, last_ref_transaction: null, provenance: "restored_from_envelope",
    });
    return { ...f, coldKeystore };
  };

  it("a head whose stored bytes were substituted fails CHAIN_BROKEN through the batch, exactly as unbatched", async (t) => {
    const f = await coldFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    // Parse-valid tamper (flip one signature character) so the failure
    // lands in checkChainLink — the ordered walk's own envelope — rather
    // than strict-parse. The listing recomputes the tampered hash, so the
    // batch dutifully caches these bytes and the LOOP is what rejects them,
    // byte-identically to the unbatched walk.
    const key = `${f.repoId}/${gitvaultPaths.head("0000000000000002")}`;
    const text = new TextDecoder().decode(f.transport.objects.get(key)!);
    const sig = /"signature":"([A-Za-z0-9_-]+)"/.exec(text)!;
    const flipped = (sig[1]![0] === "A" ? "B" : "A") + sig[1]!.slice(1);
    f.transport.objects.set(key, new TextEncoder().encode(text.replace(sig[1]!, flipped)));
    const cold = GitvaultVault.open({ keystore: f.coldKeystore, transport: f.transport, repo_id: f.repoId, repo_dir: null });
    await rejectsCode(cold.materialize(), "CHAIN_BROKEN");
  });

  it("a prefetch that LIES about one head (bytes ≠ the listing's hash) self-heals: the entry stays unserved and the ordered walk's own read succeeds", async (t) => {
    const f = await coldFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    // Lie exactly ONCE, on the FIRST read of generation 2's head — the
    // prefetch's own concurrent single. The walkPrefetch insert sha-checks
    // against the listing and drops it; the ordered loop's later honest
    // re-read succeeds. (Heads ride direct getObject reads, never the
    // carrier-only getObjects batch — this is the per-path lying-read
    // shape that can actually occur on the wire.)
    //
    // Pinned to the pre-`head-reads` FALLBACK path
    // (gitvault-batched-head-reads): on a gateway serving the batch, the
    // prefetch never issues these singles at all, so the lie would never
    // fire and the assertion below would pass vacuously. The batch path's
    // own lying case is covered in `gitvault-round-trip-budgets.test.ts`.
    f.transport.headReadsUnsupported = true;
    const lyingPath = gitvaultPaths.head("0000000000000002");
    let lied = false;
    const lying = new Proxy(f.transport, {
      get(target, prop, receiver) {
        if (prop === "getObject") {
          return async (req: { repo_id: string; path: string }) => {
            const bytes = await target.getObject(req);
            if (req.path !== lyingPath || !bytes || lied) return bytes;
            lied = true;
            const corrupt = new Uint8Array(bytes);
            corrupt[0] = corrupt[0]! ^ 0xff;
            return corrupt;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const cold = GitvaultVault.open({ keystore: f.coldKeystore, transport: lying, repo_id: f.repoId, repo_dir: null });
    f.transport.calls.length = 0;
    const m = await cold.materialize();
    assert.equal(lied, true, "the lie was actually served to the prefetch");
    assert.deepEqual(Object.keys(m.refs).sort(), ["refs/heads/b1", "refs/heads/b2", "refs/heads/main"]);
    assert.ok(
      f.transport.calls.filter((c) => c === `get:${lyingPath}`).length >= 2,
      `the ordered loop re-read the lied-about head itself — calls: ${f.transport.calls.filter((c) => c.startsWith("get:")).join(", ")}`,
    );
  });

  it("a completed genesis-anchored walk persists genesis checkpoint coverage; push results carry the staleness; a checkpoint push resets it", async (t) => {
    const f = await coldFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    // The cold walk saw no checkpoint but anchored at genesis — that IS
    // proof of coverage, and the keystore learns it.
    const cold = GitvaultVault.open({ keystore: f.coldKeystore, transport: f.transport, repo_id: f.repoId, repo_dir: null });
    await cold.materialize();
    assert.equal(f.coldKeystore.readRepo(f.repoId)!.checkpoint_covers_through, "0000000000000000");

    // WAL pushes climb the staleness against that coverage…
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const r4 = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/b3", expected_old_oid: null, new_oid: c1, force: false }] } });
    assert.equal(r4.form, "wal");
    assert.deepEqual(r4.checkpoint_staleness, { generations_since_checkpoint: 4, advised: false });

    // …and a checkpoint-form push is fresh first-hand coverage: staleness 0.
    const r5 = await f.vault.push({ checkpoint: true, transaction: { updates: [{ ref: "refs/heads/b4", expected_old_oid: null, new_oid: c1, force: false }] } });
    assert.equal(r5.form, "checkpoint");
    assert.deepEqual(r5.checkpoint_staleness, { generations_since_checkpoint: 0, advised: false });
    assert.equal(f.keystore.readRepo(f.repoId)!.checkpoint_covers_through, r5.generation);
  });
});

describe("gitvault-clone-scaling — the restore walk's stop is first-hand coverage", () => {
  it("a wholesale restore stopping at a checkpoint head records its coverage, so the next walk's window is exact", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/b1", expected_old_oid: null, new_oid: c1, force: false }] } });
    const chk = await f.vault.push({ checkpoint: true, transaction: { updates: [{ ref: "refs/heads/b2", expected_old_oid: null, new_oid: c1, force: false }] } });
    assert.equal(chk.form, "checkpoint");

    // A second cold principal (keys, no pins, no coverage) restores into a
    // fresh bare target: its backward walk stops AT the checkpoint head and
    // learns that head's covers_through — no listing walk involved.
    const repo = f.keystore.readRepo(f.repoId)!;
    const ks2 = GitvaultKeystore.open({ rootDir: join(f.root, "ks-restorer") });
    ks2.ensureIdentity();
    ks2.saveRepo({
      repo_id: f.repoId, org_id: repo.org_id, project_id: repo.project_id,
      k_repo_hex: repo.k_repo_hex, epoch: repo.epoch, genesis_sha256: repo.genesis_sha256,
      head_pin: null, last_ref_transaction: null, provenance: "restored_from_envelope",
    });
    const target = mkdtempSync(join(tmpdir(), "run402-gitvault-coverage-restore-"));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    await git(target, ["init", "-q", "--bare", "."]);
    const restorer = GitvaultVault.open({ keystore: ks2, transport: f.transport, repo_id: f.repoId, repo_dir: null });
    await restorer.restoreObjectsInto(target);
    assert.equal(ks2.readRepo(f.repoId)!.checkpoint_covers_through, chk.head.checkpoint!.covers_through_generation);
  });
});

// ─── pipelined restore (gitvault-pipelined-restore) ──────────────────────────

describe("pipelined restore — per-object settlement (gitvault-pipelined-restore 3.1)", () => {
  /**
   * Wrap a transport with a `getObjectsSettled` that settles the per-index
   * promises in REVERSE arrival order — the adversarial delivery shape. The
   * consumer must still apply in order and land the identical final state.
   */
  function outOfOrderSettled(inner: VaultFixture["transport"], corruptIndex: number | null = null): VaultFixture["transport"] {
    const wrapped = Object.create(inner) as VaultFixture["transport"] & {
      getObjectsSettled?: (req: { repo_id: string; paths: string[] }) => Promise<Array<Promise<Uint8Array | null>>>;
    };
    wrapped.getObjectsSettled = async (req) => {
      const frames = await inner.getObjects(req);
      const deferreds = frames.map(() => {
        let resolve!: (v: Uint8Array | null) => void;
        const promise = new Promise<Uint8Array | null>((res) => {
          resolve = res;
        });
        void promise.catch(() => {});
        return { promise, resolve };
      });
      // Deliver LAST-first, asynchronously, so an in-order consumer must
      // genuinely wait on index 0 while later indexes are already settled.
      void (async () => {
        for (let i = frames.length - 1; i >= 0; i--) {
          await new Promise((r) => setTimeout(r, 1));
          let bytes = frames[i] ?? null;
          if (bytes && i === corruptIndex) {
            bytes = new Uint8Array(bytes);
            bytes[bytes.length - 1]! ^= 0xff;
          }
          deferreds[i]!.resolve(bytes);
        }
      })();
      return deferreds.map((d) => d.promise);
    };
    return wrapped;
  }

  it("applies in order and lands the identical state when objects settle out of order", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] }, checkpoint: true });
    const c2 = await commitFile(f.repoDir, "p1.txt", "p1\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });
    const c3 = await commitFile(f.repoDir, "p2.txt", "p2\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c2, new_oid: c3, force: false }] } });

    const piped = new GitvaultVault({ keystore: f.keystore, transport: outOfOrderSettled(f.transport), repo_id: f.repoId, repo_dir: f.repoDir });
    const target = mkdtempSync(join(tmpdir(), "run402-gitvault-piped-"));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    mkdirSync(target, { recursive: true });
    await git(target, ["init", "-q", "--bare", "."]);
    const restored = await piped.restoreObjectsInto(target);
    assert.deepEqual(restored.refs, { "refs/heads/main": c3 });
    for (const oid of [c1, c2, c3]) assert.equal(await hasObject(target, oid), true, oid);
  });

  it("a corrupted middle pack fails with the SAME envelope as the barrier path", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const c2 = await commitFile(f.repoDir, "q1.txt", "q1\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });
    const c3 = await commitFile(f.repoDir, "q2.txt", "q2\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c2, new_oid: c3, force: false }] } });

    // Barrier reference: corrupt WAL pack index 1 through plain getObjects.
    const corruptBarrier = Object.create(f.transport) as VaultFixture["transport"];
    corruptBarrier.getObjects = async (req) => {
      const frames = await f.transport.getObjects(req);
      if (frames[1]) {
        const b = new Uint8Array(frames[1]);
        b[b.length - 1]! ^= 0xff;
        frames[1] = b;
      }
      return frames;
    };
    const barrierVault = new GitvaultVault({ keystore: f.keystore, transport: corruptBarrier, repo_id: f.repoId, repo_dir: f.repoDir });
    const targetA = mkdtempSync(join(tmpdir(), "run402-gitvault-piped-corrupt-a-"));
    t.after(() => rmSync(targetA, { recursive: true, force: true }));
    mkdirSync(targetA, { recursive: true });
    await git(targetA, ["init", "-q", "--bare", "."]);
    let barrierCode = "";
    try {
      await barrierVault.restoreObjectsInto(targetA);
    } catch (e) {
      barrierCode = (e as { code?: string }).code ?? "";
    }
    assert.ok(barrierCode, "the barrier path must refuse the corrupted pack");

    const pipedVault = new GitvaultVault({ keystore: f.keystore, transport: outOfOrderSettled(f.transport, 1), repo_id: f.repoId, repo_dir: f.repoDir });
    const targetB = mkdtempSync(join(tmpdir(), "run402-gitvault-piped-corrupt-b-"));
    t.after(() => rmSync(targetB, { recursive: true, force: true }));
    mkdirSync(targetB, { recursive: true });
    await git(targetB, ["init", "-q", "--bare", "."]);
    let pipedCode = "";
    try {
      await pipedVault.restoreObjectsInto(targetB);
    } catch (e) {
      pipedCode = (e as { code?: string }).code ?? "";
    }
    assert.equal(pipedCode, barrierCode, "pipelined and barrier corruption envelopes must match");
  });
});
