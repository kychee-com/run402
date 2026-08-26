/**
 * `attachGitvaultDeployHooks` — the fix for a confirmed defect found while
 * reviewing gitvault-human-envelopes task 4.1 (`ff594ada`): that commit wired
 * `Gitvault.push()`'s `#tryReconcileEnvelopeRecipients` hook (design D5's
 * "deploy time" reconcile cadence) but `Gitvault.deploy()` — `run402 deploy`,
 * the PRIMARY hook per D5's own "the same 'one command every agent runs'
 * argument" — went through `runGitvaultDeploy(...)` directly and never ran
 * either hook. `Gitvault.push()`'s mirror hook (`#tryMirrorPush`, design D6)
 * had the identical bypass for the identical reason: `runGitvaultDeploy`
 * calls `vault.push(...)` on the raw protocol object, not the `Gitvault`
 * class wrapper the hooks live on.
 *
 * The fix routes `Gitvault.deploy()`'s result through this function
 * (`sdk/src/namespaces/gitvault.ts`) instead of inlining the gating in the
 * method body, so the outcome-gating is testable here without a live vault —
 * the real hooks (`#tryMirrorPush` / `#tryReconcileEnvelopeRecipients`) are
 * private class methods that already catch everything and never reject (see
 * `gitvault.ts`'s doc comments on both), so this function's own contract is
 * narrow: call them ONLY when a new generation landed, in the SAME order
 * `push()` uses, and merge whatever they resolve to onto the result without
 * touching anything else on it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachGitvaultDeployHooks } from "./gitvault.js";
import type { GitvaultMirrorPushResult } from "../node/gitvault-mirror.js";
import type { GitvaultDeployOutcome, GitvaultDeployResult } from "../node/gitvault-deploy.js";
import type { GitvaultReconcileEnvelopeRecipientsPushResult } from "./gitvault.js";

const COMMON = {
  gitvault_commit: "abc123",
  gitvault_commit_line: "gitvault-commit: abc123",
  snapshot: {} as unknown as GitvaultDeployResult["snapshot"],
  capture_id: "cap_test",
  snapshot_oid_hmac: "hmac_test",
  apply_plan_sha256: "sha_test",
  operation_id: "op_test",
  next_actions: [],
};

/** A minimally-shaped result for every outcome — only the fields the gate cares about are load-bearing; the rest are filler for the type. */
function resultFor(outcome: GitvaultDeployOutcome): GitvaultDeployResult {
  switch (outcome) {
    case "DEPLOYED_AND_VAULTED":
      return { ...COMMON, outcome, generation: "g1", head_sha256: "h1", capture_receipt: {} as never, activation_token: {} as never, commit: {} } as unknown as GitvaultDeployResult;
    case "DEPLOY_FAILED_VAULTED":
      return { ...COMMON, outcome, generation: "g1", head_sha256: "h1", capture_receipt: null, deploy_error: { code: "X", message: "m", retryable: false } } as unknown as GitvaultDeployResult;
    case "DEPLOY_BLOCKED_PUSH_FAILED":
      return { ...COMMON, outcome, push_error: { code: "X", message: "m", retryable: true }, previous_release_keeps_serving: true } as unknown as GitvaultDeployResult;
    case "DEPLOY_FAILED_UNVAULTED":
      return { ...COMMON, outcome, push_error: { code: "X", message: "m", retryable: true }, deploy_error: { code: "Y", message: "m", retryable: false } } as unknown as GitvaultDeployResult;
    case "DEPLOYED_UNVAULTED_OVERRIDE":
      return { ...COMMON, outcome, push_error: { code: "X", message: "m", retryable: true }, override_journal: {} as never, commit: {} } as unknown as GitvaultDeployResult;
  }
}

function trackedHooks(): {
  mirror: () => Promise<GitvaultMirrorPushResult>;
  reconcile: () => Promise<GitvaultReconcileEnvelopeRecipientsPushResult>;
  mirrorCalls: number;
  reconcileCalls: number;
  order: string[];
} {
  const state = { mirrorCalls: 0, reconcileCalls: 0, order: [] as string[] };
  return {
    ...state,
    get mirrorCalls() { return state.mirrorCalls; },
    get reconcileCalls() { return state.reconcileCalls; },
    get order() { return state.order; },
    mirror: async () => { state.mirrorCalls += 1; state.order.push("mirror"); return { attempted: true, outcome: "pushed" }; },
    reconcile: async () => { state.reconcileCalls += 1; state.order.push("reconcile"); return { attempted: true, outcome: "reconciled" }; },
  };
}

describe("attachGitvaultDeployHooks — the deploy-time reconcile/mirror gate", () => {
  it("fires both hooks, in mirror-then-reconcile order, when a new generation landed (DEPLOYED_AND_VAULTED)", async () => {
    const hooks = trackedHooks();
    const out = await attachGitvaultDeployHooks(resultFor("DEPLOYED_AND_VAULTED"), hooks.mirror, hooks.reconcile);
    assert.equal(hooks.mirrorCalls, 1);
    assert.equal(hooks.reconcileCalls, 1);
    assert.deepEqual(hooks.order, ["mirror", "reconcile"], "same ordering push() uses");
    assert.deepEqual(out.mirror_push, { attempted: true, outcome: "pushed" });
    assert.deepEqual(out.reconcile_recipients, { attempted: true, outcome: "reconciled" });
    // Nothing else about the result is disturbed.
    assert.equal(out.outcome, "DEPLOYED_AND_VAULTED");
    assert.equal(out.gitvault_commit, "abc123");
  });

  it("fires both hooks when the push landed but activation later failed (DEPLOY_FAILED_VAULTED) — a generation exists to mirror/reconcile against even though the deploy itself did not activate", async () => {
    const hooks = trackedHooks();
    const out = await attachGitvaultDeployHooks(resultFor("DEPLOY_FAILED_VAULTED"), hooks.mirror, hooks.reconcile);
    assert.equal(hooks.mirrorCalls, 1);
    assert.equal(hooks.reconcileCalls, 1);
    assert.ok(out.mirror_push);
    assert.ok(out.reconcile_recipients);
  });

  for (const outcome of ["DEPLOY_BLOCKED_PUSH_FAILED", "DEPLOY_FAILED_UNVAULTED", "DEPLOYED_UNVAULTED_OVERRIDE"] as const) {
    it(`never calls either hook, and OMITS both fields (never a faked skipped_* value), when no vault push landed (${outcome})`, async () => {
      const hooks = trackedHooks();
      const out = await attachGitvaultDeployHooks(resultFor(outcome), hooks.mirror, hooks.reconcile);
      assert.equal(hooks.mirrorCalls, 0, "no new generation exists to mirror");
      assert.equal(hooks.reconcileCalls, 0, "no new generation exists to reconcile against");
      assert.equal("mirror_push" in out, false, "omitted, not present-and-false/null");
      assert.equal("reconcile_recipients" in out, false, "omitted, not present-and-false/null");
      // The original result is returned untouched (same outcome, same fields).
      assert.equal(out.outcome, outcome);
    });
  }

  it("a reconcile hook that resolves to its own error shape (the hook's own try/catch contract) never fails the deploy — the deploy outcome is unaffected", async () => {
    const failingReconcile = async (): Promise<GitvaultReconcileEnvelopeRecipientsPushResult> => ({ attempted: false, outcome: "skipped_error", error: "read-only principal, no signing key" });
    const out = await attachGitvaultDeployHooks(resultFor("DEPLOYED_AND_VAULTED"), async () => ({ attempted: false, outcome: "skipped_no_mirror" }), failingReconcile);
    assert.equal(out.outcome, "DEPLOYED_AND_VAULTED", "the deploy's own outcome is untouched by a reconcile failure");
    assert.deepEqual(out.reconcile_recipients, { attempted: false, outcome: "skipped_error", error: "read-only principal, no signing key" });
    assert.deepEqual(out.mirror_push, { attempted: false, outcome: "skipped_no_mirror" });
  });
});
