/**
 * gitvault push-gated deploy (task 5.6) — the §6.5 machine: a fresh
 * `capture_id` before both lanes, a deploy lane that builds from an ISOLATED
 * materialization of the snapshot commit, a `capture_binding` whose plan digest
 * may be null (capture-the-attempt), token exchange + binding check +
 * consumption, the CLOSED five outcomes, the always-printed `gitvault_commit`,
 * and the override journal (full contents, crash-safe, drained by equality on
 * EVERY field).
 *
 * Vector classes replayed here: `activation-token` (all four) and the
 * client-observable subset of `state-scenario`, with the server-only remainder
 * partitioned explicitly so the split cannot silently become a gap.
 */

import { describe, it } from "node:test";
import { loadGitvaultVectors, OPTOUT_SKIP_MESSAGE, type GitvaultVector } from "./gitvault-vectors.test-helper.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalError } from "../errors.js";
import { storedBytesSha256, verifyGitvaultObject } from "../namespaces/gitvault.crypto.js";
import type { GitvaultActivationToken, GitvaultCaptureReceipt, GitvaultSignedObject } from "../namespaces/gitvault.types.js";
import {
  GITVAULT_DEPLOY_OUTCOMES,
  checkActivationTokenBinding,
  checkAuthorizationEpoch,
  drainOverrideJournals,
  listPendingOverrideJournals,
  matchCaptureReceipt,
  overrideJournalPath,
  readOverrideJournal,
  runGitvaultDeploy,
  type GitvaultDeployLane,
  type GitvaultDeployLaneCommitInput,
  type GitvaultDeployLanePlan,
  type GitvaultDeployLanePlanInput,
} from "./gitvault-deploy.js";
import { GitvaultVault } from "./gitvault-publication.js";
import { GITVAULT_DEPLOY_REF } from "./gitvault-snapshot.js";
import { git, makeVault, type GitvaultMemoryTransport, type VaultFixture } from "./gitvault-memory-transport.test.js";

// ─── Vector loading (same contract as the crypto suite) ──────────────────────

// Task 5.6b: missing vectors FAIL; only GITVAULT_VECTORS_OPTOUT=1 skips.
const vectorSet = loadGitvaultVectors();
type Vector = GitvaultVector;
const vectorFile = vectorSet?.file ?? null;
const vectors = vectorFile ? describe : describe.skip;
if (!vectorFile) describe("gitvault deploy vectors", () => it.skip(OPTOUT_SKIP_MESSAGE, () => {}));
const byClass = (cls: string): Vector[] => (vectorFile?.vectors ?? []).filter((v) => v.class === cls);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function codeOf(e: unknown): string {
  assert.ok(e instanceof LocalError, `expected LocalError, got ${String(e)}`);
  return e.code ?? "no-code";
}
function throwsCode(fn: () => unknown, code: string, message?: string): void {
  try {
    fn();
  } catch (e) {
    assert.equal(codeOf(e), code, message);
    return;
  }
  assert.fail(message ?? `expected ${code}, nothing thrown`);
}
async function rejectsCode(p: Promise<unknown>, code: string, message?: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert.equal(codeOf(e), code, message);
    return;
  }
  assert.fail(message ?? `expected ${code}, nothing thrown`);
}

interface FakeLane extends GitvaultDeployLane {
  plans: GitvaultDeployLanePlanInput[];
  commits: GitvaultDeployLaneCommitInput[];
  /** What `plan` observed in the ISOLATED materialization. */
  seen: string[];
}

/**
 * A deploy lane that behaves like apply-v1: it builds from the materialization
 * it is handed, registers the operation row the token mint validates against,
 * and consumes the activation token at commit.
 */
function makeLane(transport: GitvaultMemoryTransport, options: { planFails?: string; commitFails?: string; overrideAuthorized?: boolean; onPlan?: () => void } = {}): FakeLane {
  let n = 0;
  const lane: FakeLane = {
    plans: [], commits: [], seen: [],
    async plan(input) {
      lane.plans.push(input);
      options.onPlan?.();
      // build from the materialized snapshot, never the work tree
      const appPath = join(input.materialized_dir, "app.js");
      lane.seen.push(existsSync(appPath) ? readFileSync(appPath, "utf8") : "<absent>");
      if (options.planFails) throw new LocalError("build failed before a plan existed", "planning apply", { code: options.planFails });
      n += 1;
      const operation_id = `op_${String(n).padStart(32, "0")}`;
      const plan: GitvaultDeployLanePlan = { plan_id: `pln_${n}`, operation_id, apply_plan_sha256: `${String(n).repeat(2)}${"ab".repeat(31)}` };
      transport.operations.set(operation_id, { operation_id, capture_id: input.capture_id, apply_plan_sha256: plan.apply_plan_sha256, snapshot_oid_hmac: input.snapshot_oid_hmac, override: null, activated_with: null });
      return plan;
    },
    async commit(input) {
      lane.commits.push(input);
      if (options.commitFails) throw new LocalError("apply commit failed", "committing apply", { code: options.commitFails });
      if (input.allow_unvaulted) {
        if (!options.overrideAuthorized) throw new LocalError("gitvault.override_unvaulted is required", "committing apply", { code: "OVERRIDE_NOT_AUTHORIZED" });
        transport.operations.get(input.operation_id)!.override = { cleared: false };
      }
      if (input.activation_token) transport.consumeToken(input.activation_token, input.operation_id);
      return { committed: true, operation_id: input.operation_id };
    },
  };
  return lane;
}

/** A fixture whose work tree carries `app.js` so the isolation check has something to read. */
async function deployFixture(): Promise<VaultFixture> {
  const f = await makeVault();
  writeFileSync(join(f.repoDir, "app.js"), "v1\n");
  await git(f.repoDir, ["add", "app.js"]);
  await git(f.repoDir, ["commit", "-q", "-m", "app"]);
  return f;
}

// ─── The five outcomes ───────────────────────────────────────────────────────

describe("§6.5 push-gated deploy — the closed five outcomes", () => {
  it("the outcome enum is closed at five", () => {
    assert.deepEqual([...GITVAULT_DEPLOY_OUTCOMES], ["DEPLOYED_AND_VAULTED", "DEPLOY_BLOCKED_PUSH_FAILED", "DEPLOY_FAILED_VAULTED", "DEPLOY_FAILED_UNVAULTED", "DEPLOYED_UNVAULTED_OVERRIDE"]);
  });

  it("DEPLOYED_AND_VAULTED: the snapshot is vaulted, the receipt is exchanged for a token bound to THIS deploy, and the token is consumed once", async (t) => {
    const f = await deployFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const lane = makeLane(f.transport);
    const lines: string[] = [];
    const head = await git(f.repoDir, ["rev-parse", "HEAD"]);

    const r = await runGitvaultDeploy({ vault: f.vault, lane, repo_dir: f.repoDir, onCommitLine: (l) => lines.push(l) });

    assert.equal(r.outcome, "DEPLOYED_AND_VAULTED");
    assert.equal(r.gitvault_commit, head, "a clean tree deploys HEAD itself");
    assert.deepEqual(lines, [`gitvault_commit ${head}`], "the gitvault_commit line is printed as soon as the snapshot exists");
    assert.equal(r.snapshot.kind, "head");
    assert.match(r.capture_id, /^[0-9a-f]{32}$/);
    if (r.outcome !== "DEPLOYED_AND_VAULTED") return;
    assert.equal(r.generation, "0000000000000001");
    assert.equal(r.capture_receipt.capture_id, r.capture_id);
    assert.equal(r.capture_receipt.apply_plan_sha256, r.apply_plan_sha256);
    assert.equal(r.activation_token.operation_id, r.operation_id);
    assert.deepEqual(r.next_actions, []);
    // the head carries the binding, and the deploy ref moved inside the vault
    const state = await f.vault.materialize();
    assert.deepEqual(state.refs, { [GITVAULT_DEPLOY_REF]: head });
    assert.deepEqual(state.head!.capture_binding, { capture_id: r.capture_id, apply_plan_sha256: r.apply_plan_sha256, snapshot_oid_hmac: r.snapshot_oid_hmac });
    // consumed exactly once, by this operation
    assert.equal(f.transport.consumedTokens.get(r.activation_token.object_id), r.operation_id);
    assert.equal(lane.commits.length, 1);
    assert.equal(lane.commits[0]!.activation_token?.object_id, r.activation_token.object_id);
  });

  it("commit ids never reach the platform: the binding carries a keyed commitment, not the oid", async (t) => {
    const f = await deployFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const r = await runGitvaultDeploy({ vault: f.vault, lane: makeLane(f.transport), repo_dir: f.repoDir });
    if (r.outcome !== "DEPLOYED_AND_VAULTED") return assert.fail(r.outcome);
    assert.notEqual(r.snapshot_oid_hmac, r.gitvault_commit);
    assert.match(r.snapshot_oid_hmac, /^[0-9a-f]{64}$/);
    const plaintextCarriers = [JSON.stringify(r.head_sha256), JSON.stringify(r.capture_receipt), JSON.stringify(r.activation_token)];
    for (const carrier of plaintextCarriers) assert.ok(!carrier.includes(r.gitvault_commit), "no plaintext control-plane message carries the commit id");
  });

  it("the deploy lane builds from an ISOLATED materialization — mid-deploy edits cannot skew provenance", async (t) => {
    const f = await deployFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const lane = makeLane(f.transport, { onPlan: () => writeFileSync(join(f.repoDir, "app.js"), "v2 (edited mid-deploy)\n") });
    const r = await runGitvaultDeploy({ vault: f.vault, lane, repo_dir: f.repoDir });
    assert.equal(r.outcome, "DEPLOYED_AND_VAULTED");
    assert.deepEqual(lane.seen, ["v1\n"], "the build read the snapshot, not the mutating work tree");
    assert.notEqual(lane.plans[0]!.materialized_dir, f.repoDir);
    assert.equal(existsSync(lane.plans[0]!.materialized_dir), false, "the isolated build dir is removed unless kept");
  });

  it("DEPLOY_FAILED_VAULTED: a build that fails before a plan exists still captures the attempt — with a NULL digest, from which no token is mintable", async (t) => {
    const f = await deployFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const lane = makeLane(f.transport, { planFails: "BUILD_FAILED" });
    const r = await runGitvaultDeploy({ vault: f.vault, lane, repo_dir: f.repoDir });

    assert.equal(r.outcome, "DEPLOY_FAILED_VAULTED");
    if (r.outcome !== "DEPLOY_FAILED_VAULTED") return;
    assert.equal(r.apply_plan_sha256, null);
    assert.equal(r.operation_id, null);
    assert.equal(r.deploy_error.code, "BUILD_FAILED");
    assert.equal(r.generation, "0000000000000001", "the push is never gated on deploy success");
    const state = await f.vault.materialize();
    assert.deepEqual(state.head!.capture_binding, { capture_id: r.capture_id, apply_plan_sha256: null, snapshot_oid_hmac: r.snapshot_oid_hmac });
    assert.equal(r.capture_receipt!.apply_plan_sha256, null);
    assert.equal(lane.commits.length, 0, "nothing is activated");
    // and the mint refuses it
    f.transport.operations.set("op_null", { operation_id: "op_null", capture_id: r.capture_id, apply_plan_sha256: "x", snapshot_oid_hmac: r.snapshot_oid_hmac, override: null, activated_with: null });
    await rejectsCode(f.transport.exchangeActivationToken({ repo_id: f.repoId, operation_id: "op_null", capture_receipt: r.capture_receipt! }), "GITVAULT_TOKEN_NOT_MINTABLE");
  });

  it("DEPLOY_BLOCKED_PUSH_FAILED: the previous release keeps serving, and the override is offered WITH its capability", async (t) => {
    const f = await deployFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    f.transport.tamperReceiptAt = 1;
    const lane = makeLane(f.transport);
    const r = await runGitvaultDeploy({ vault: f.vault, lane, repo_dir: f.repoDir });

    assert.equal(r.outcome, "DEPLOY_BLOCKED_PUSH_FAILED");
    if (r.outcome !== "DEPLOY_BLOCKED_PUSH_FAILED") return;
    assert.equal(r.previous_release_keeps_serving, true);
    assert.equal(r.push_error.code, "GITVAULT_RECEIPT_MISMATCH");
    assert.ok(r.apply_plan_sha256, "the build succeeded; only the vault push did not");
    assert.equal(lane.commits.length, 0, "no activation without a vaulted capture");
    assert.equal(r.next_actions.find((a) => a.requires)?.requires, "gitvault.override_unvaulted");
    assert.deepEqual(listPendingOverrideJournals(f.keystore, f.repoId), [], "no override was asked for, so nothing is journaled");
  });

  it("DEPLOY_FAILED_UNVAULTED: neither lane landed", async (t) => {
    const f = await deployFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    f.transport.tamperReceiptAt = 1;
    const r = await runGitvaultDeploy({ vault: f.vault, lane: makeLane(f.transport, { planFails: "BUILD_FAILED" }), repo_dir: f.repoDir, allow_unvaulted: { reason: "prod is down" } });
    assert.equal(r.outcome, "DEPLOY_FAILED_UNVAULTED");
    if (r.outcome !== "DEPLOY_FAILED_UNVAULTED") return;
    assert.equal(r.push_error.code, "GITVAULT_RECEIPT_MISMATCH");
    assert.equal(r.deploy_error.code, "BUILD_FAILED");
    assert.deepEqual(listPendingOverrideJournals(f.keystore, f.repoId), [], "an override with no plan has nothing to complete");
  });

  it("DEPLOYED_UNVAULTED_OVERRIDE: the journal is written BEFORE the commit, carrying the full §6.5 contents", async (t) => {
    const f = await deployFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    f.transport.tamperReceiptAt = 1;
    const lane = makeLane(f.transport, { overrideAuthorized: true });
    const head = await git(f.repoDir, ["rev-parse", "HEAD"]);
    const r = await runGitvaultDeploy({ vault: f.vault, lane, repo_dir: f.repoDir, allow_unvaulted: { reason: "hotfix while the vault is unreachable" } });

    assert.equal(r.outcome, "DEPLOYED_UNVAULTED_OVERRIDE");
    if (r.outcome !== "DEPLOYED_UNVAULTED_OVERRIDE") return;
    const j = r.override_journal;
    assert.deepEqual(
      { repo_id: j.repo_id, operation_id: j.operation_id, capture_id: j.capture_id, apply_plan_sha256: j.apply_plan_sha256, snapshot: j.snapshot, snapshot_oid_hmac: j.snapshot_oid_hmac, publication_state: j.publication_state, reason: j.reason },
      {
        repo_id: f.repoId, operation_id: r.operation_id!, capture_id: r.capture_id, apply_plan_sha256: r.apply_plan_sha256!,
        snapshot: { ref: GITVAULT_DEPLOY_REF, oid: head, head_target: { kind: "symref", ref: "refs/heads/main" } },
        snapshot_oid_hmac: r.snapshot_oid_hmac, publication_state: "pending", reason: "hotfix while the vault is unreachable",
      },
    );
    // durable, and visible to doctor
    assert.deepEqual(readOverrideJournal(f.keystore, r.operation_id!)!.publication_state, "pending");
    assert.deepEqual(listPendingOverrideJournals(f.keystore, f.repoId).map((x) => x.operation_id), [r.operation_id]);
    assert.equal(lane.commits[0]!.allow_unvaulted?.reason, "hotfix while the vault is unreachable");
    assert.equal(lane.commits[0]!.activation_token, undefined, "an unvaulted activation presents no token");
  });

  it("an unauthorized override throws OVERRIDE_NOT_AUTHORIZED and leaves NO advisory (nothing activated)", async (t) => {
    const f = await deployFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    f.transport.tamperReceiptAt = 1;
    await rejectsCode(runGitvaultDeploy({ vault: f.vault, lane: makeLane(f.transport, { overrideAuthorized: false }), repo_dir: f.repoDir, allow_unvaulted: { reason: "nope" } }), "OVERRIDE_NOT_AUTHORIZED");
    assert.deepEqual(listPendingOverrideJournals(f.keystore, f.repoId), []);
  });

  it("a snapshot refusal precedes both lanes: nothing is planned, pushed, or journaled", async (t) => {
    const f = await deployFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    await git(f.repoDir, ["checkout", "-q", "-b", "other"]);
    writeFileSync(join(f.repoDir, "c.txt"), "other\n");
    await git(f.repoDir, ["add", "c.txt"]);
    await git(f.repoDir, ["commit", "-q", "-m", "other"]);
    await git(f.repoDir, ["checkout", "-q", "main"]);
    writeFileSync(join(f.repoDir, "c.txt"), "main\n");
    await git(f.repoDir, ["add", "c.txt"]);
    await git(f.repoDir, ["commit", "-q", "-m", "main"]);
    await git(f.repoDir, ["merge", "other"]).catch(() => undefined);
    const lane = makeLane(f.transport);
    await rejectsCode(runGitvaultDeploy({ vault: f.vault, lane, repo_dir: f.repoDir }), "SNAPSHOT_CONFLICTED_INDEX");
    assert.deepEqual(lane.plans, []);
    assert.equal(f.transport.calls.filter((c) => c.startsWith("admit:")).length, 0);
  });
});

// ─── Draining the override advisory ──────────────────────────────────────────

describe("§6.5 override completion — equality on EVERY field or no clear", () => {
  it("a later push of the JOURNALED snapshot completes the operation and clears the advisory", async (t) => {
    const f = await deployFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    f.transport.tamperReceiptAt = 1;
    const r = await runGitvaultDeploy({ vault: f.vault, lane: makeLane(f.transport, { overrideAuthorized: true }), repo_dir: f.repoDir, allow_unvaulted: { reason: "vault unreachable" } });
    assert.equal(r.outcome, "DEPLOYED_UNVAULTED_OVERRIDE");

    const report = await drainOverrideJournals(f.vault);
    assert.deepEqual(report.remaining, []);
    assert.deepEqual(report.completed.map((j) => j.publication_state), ["completed"]);
    assert.equal(report.completed[0]!.generation, "0000000000000001");
    assert.equal(f.transport.operations.get(r.operation_id!)!.override!.cleared, true);
    assert.deepEqual(listPendingOverrideJournals(f.keystore, f.repoId), [], "the advisory is gone once the platform accepted the completion");
    // the journaled snapshot is what was published — not whatever the tree looks like now
    assert.deepEqual((await f.vault.materialize()).refs, { [GITVAULT_DEPLOY_REF]: r.gitvault_commit });
    // draining again is a no-op
    assert.deepEqual(await drainOverrideJournals(f.vault), { completed: [], remaining: [] });
  });

  it("a receipt that differs on ANY field never clears the advisory", async (t) => {
    const f = await deployFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    f.transport.tamperReceiptAt = 1;
    const r = await runGitvaultDeploy({ vault: f.vault, lane: makeLane(f.transport, { overrideAuthorized: true }), repo_dir: f.repoDir, allow_unvaulted: { reason: "vault unreachable" } });
    if (r.outcome !== "DEPLOYED_UNVAULTED_OVERRIDE") return assert.fail(r.outcome);
    // the operation row moved on (a different capture answered it) — completion must refuse
    f.transport.operations.get(r.operation_id!)!.capture_id = "f".repeat(32);
    const report = await drainOverrideJournals(f.vault);
    assert.deepEqual(report.completed, []);
    assert.equal(report.remaining[0]!.error.code, "GITVAULT_OVERRIDE_COMPLETION_REFUSED");
    assert.equal(listPendingOverrideJournals(f.keystore, f.repoId).length, 1, "the advisory persists until equality");
    assert.equal(readOverrideJournal(f.keystore, r.operation_id!)!.publication_state, "published", "the push half is recorded so it is never repeated");
  });

  it("matchCaptureReceipt names every field that differs", () => {
    const receipt = { repo_id: "src_1", capture_id: "a".repeat(32), apply_plan_sha256: "b".repeat(64), snapshot_oid_hmac: "c".repeat(64), head_sha256: "d".repeat(64) } as GitvaultCaptureReceipt;
    const expected = { repo_id: "src_1", capture_id: "a".repeat(32), apply_plan_sha256: "b".repeat(64), snapshot_oid_hmac: "c".repeat(64), head_sha256: "d".repeat(64) };
    assert.deepEqual(matchCaptureReceipt(receipt, expected), { equal: true, mismatched_fields: [] });
    assert.deepEqual(matchCaptureReceipt({ ...receipt, capture_id: "e".repeat(32) }, expected).mismatched_fields, ["capture_id"]);
    assert.deepEqual(matchCaptureReceipt({ ...receipt, apply_plan_sha256: null }, expected).mismatched_fields, ["apply_plan_sha256"]);
    assert.deepEqual(matchCaptureReceipt({ ...receipt, repo_id: "src_2", head_sha256: "0".repeat(64) }, expected).mismatched_fields, ["repo_id", "head_sha256"]);
  });

  it("an operation_id that is not a safe file name never becomes a path", () => {
    const ks = { journalDir: "/tmp/does-not-matter" } as never;
    throwsCode(() => overrideJournalPath(ks, "../../etc/passwd"), "GITVAULT_BAD_ID");
    throwsCode(() => overrideJournalPath(ks, "op/with/slash"), "GITVAULT_BAD_ID");
  });
});

// ─── Activation tokens ───────────────────────────────────────────────────────

describe("§4.10 activation tokens — client-side binding checks", () => {
  const bound = {
    repo_id: "src_" + "1".repeat(32), operation_id: "op_1", generation: "0000000000000002", head_sha256: "d".repeat(64),
    capture_id: "a".repeat(32), apply_plan_sha256: "b".repeat(64), snapshot_oid_hmac: "c".repeat(64),
  };
  const token = { object_kind: "activation_token", object_id: "ct_" + "9".repeat(32), authorization_epoch: "e".repeat(32), ...bound } as GitvaultActivationToken;

  it("a token bound to exactly this deploy passes; every rebinding is named", () => {
    assert.deepEqual(checkActivationTokenBinding(token, bound), []);
    assert.deepEqual(checkActivationTokenBinding({ ...token, operation_id: "op_2" }, bound), ["operation_id"]);
    assert.deepEqual(checkActivationTokenBinding({ ...token, generation: "0000000000000003", head_sha256: "0".repeat(64) }, bound), ["generation", "head_sha256"]);
    assert.deepEqual(checkActivationTokenBinding({ ...token, object_id: "tok_x" }, bound), ["object_id"]);
    assert.deepEqual(checkActivationTokenBinding({ ...token, authorization_epoch: "not-hex" }, bound), ["authorization_epoch"]);
  });

  it("a mint that hands back a token bound to a DIFFERENT operation is refused before it is ever presented", async (t) => {
    const f = await deployFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const lane = makeLane(f.transport);
    const real = f.transport.exchangeActivationToken.bind(f.transport);
    f.transport.exchangeActivationToken = async (req) => ({ ...(await real(req)), operation_id: "op_somebody_else" });
    const r = await runGitvaultDeploy({ vault: f.vault, lane, repo_dir: f.repoDir });
    assert.equal(r.outcome, "DEPLOY_FAILED_VAULTED");
    if (r.outcome !== "DEPLOY_FAILED_VAULTED") return;
    assert.equal(r.deploy_error.code, "GITVAULT_TOKEN_BINDING_MISMATCH");
    assert.equal(lane.commits.length, 0, "a token we could not verify is never presented to a commit");
  });

  it("a stale authorization epoch fails the deploy with a re-authorize next action", async (t) => {
    const f = await deployFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    f.transport.refuseTokenOnce = "AUTHORIZATION_EPOCH_STALE";
    const r = await runGitvaultDeploy({ vault: f.vault, lane: makeLane(f.transport), repo_dir: f.repoDir });
    assert.equal(r.outcome, "DEPLOY_FAILED_VAULTED");
    if (r.outcome !== "DEPLOY_FAILED_VAULTED") return;
    assert.equal(r.deploy_error.code, "AUTHORIZATION_EPOCH_STALE");
    assert.match(r.next_actions[0]!.action, /current epoch/);
  });
});

vectors("§4.10 activation tokens — vector class `activation-token`", () => {
  it("replays all four: the signed token's stored bytes, the CONSUMED terminal state, and bytewise epoch comparison", async (t) => {
    const seen = new Set<string>();
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    for (const v of byClass("activation-token")) {
      seen.add(v.id);
      if (v.id === "token-001") {
        const object = v.inputs.object as GitvaultActivationToken;
        assert.equal(storedBytesSha256(object as unknown as GitvaultSignedObject), v.expected.stored_bytes_sha256, v.id);
        assert.equal(verifyGitvaultObject(object as unknown as GitvaultSignedObject, v.inputs.service_pubkey), true, `${v.id} service signature`);
        assert.deepEqual(checkActivationTokenBinding(object, { repo_id: object.repo_id, operation_id: object.operation_id, generation: object.generation, head_sha256: object.head_sha256, capture_id: object.capture_id, apply_plan_sha256: object.apply_plan_sha256, snapshot_oid_hmac: object.snapshot_oid_hmac }), []);
        continue;
      }
      if (v.id === "token-004") {
        // two concurrent commits: the loser sees CONSUMED for a DIFFERENT operation — no edge out
        const tok = { object_id: "ct_" + "4".repeat(32), authorization_epoch: f.transport.authorizationEpoch } as GitvaultActivationToken;
        f.transport.consumeToken(tok, v.inputs.consumed_by_operation_id);
        throwsCode(() => f.transport.consumeToken(tok, v.inputs.attempting_operation_id), "GITVAULT_TOKEN_CONSUMED", v.description);
        assert.equal(String(v.inputs.consumed_by_operation_id === v.inputs.attempting_operation_id), v.expected.same_operation);
        continue;
      }
      // token-007 / token-008: bytewise epoch comparison
      const equal = v.inputs.token_authorization_epoch === v.inputs.installed_authorization_epoch;
      assert.equal(String(equal), v.expected.equal, v.id);
      if (equal) checkAuthorizationEpoch(v.inputs.token_authorization_epoch, v.inputs.installed_authorization_epoch);
      else throwsCode(() => checkAuthorizationEpoch(v.inputs.token_authorization_epoch, v.inputs.installed_authorization_epoch), "AUTHORIZATION_EPOCH_STALE", v.description);
    }
    assert.equal(seen.size, Number(vectorFile!.counts_by_class["activation-token"]), "every activation-token vector replayed");
  });
});

vectors("§5A / §4.10 state machines — vector class `state-scenario` (the client-observable half)", () => {
  /** The scenarios whose transitions happen inside the gateway's own database; a client can only observe their REFUSAL, which the classes above already pin. */
  const SERVER_ONLY = new Map<string, string>([
    ["fence-001", "the admission reconciler's late-PUT-after-negative-read loop is entirely server-side"],
    ["fence-003", "ABORT from PREPARED_NO_IO is a server-side timeout with no I/O issued"],
    ["fence-004", "an illegal CONFLICTED-from-RECORD_WON edge exists only in the gateway's machine"],
    ["fence-005", "an illegal ABORTED-from-RECORD_PUT_ISSUED edge exists only in the gateway's machine"],
    ["fence-006", "the P-credit abort guard is a maintenance-admission edge guard"],
    ["fence-007", "the P-credit composite cut subfence is a maintenance-admission machine"],
    ["token-005", "REVOKED_BY_REPAIR is applied by the repair fence inside the gateway"],
  ]);

  it("fence-002: a DIFFERENT canonical winner surfaces to the client as HEAD_CAS_CONFLICT and re-applies", async (t) => {
    const f = await deployFixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const noRetry = new GitvaultVault({ keystore: f.keystore, transport: f.transport, repo_id: f.repoId, repo_dir: f.repoDir, conflict_retries: 0 });
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    f.transport.competitor = async () => {
      await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/winner", expected_old_oid: null, new_oid: c1, force: false }] } });
    };
    await rejectsCode(noRetry.push({ transaction: { updates: [{ ref: "refs/heads/mine", expected_old_oid: null, new_oid: c1, force: false }] } }), "HEAD_CAS_CONFLICT");
  });

  it("token-002 / token-003: consumption is atomic, and a replay for the SAME operation is a READ of the terminal state", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const tok = { object_id: "ct_" + "2".repeat(32), authorization_epoch: f.transport.authorizationEpoch } as GitvaultActivationToken;
    f.transport.consumeToken(tok, "op_same");
    f.transport.consumeToken(tok, "op_same"); // idempotent — NOT a new transition
    assert.equal(f.transport.consumedTokens.get(tok.object_id), "op_same");
  });

  it("token-006: a DR gate that installs a fresh epoch invalidates an already-issued token", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const tok = { object_id: "ct_" + "6".repeat(32), authorization_epoch: f.transport.authorizationEpoch } as GitvaultActivationToken;
    f.transport.authorizationEpoch = "0".repeat(32);
    throwsCode(() => f.transport.consumeToken(tok, "op_x"), "AUTHORIZATION_EPOCH_STALE");
    throwsCode(() => checkAuthorizationEpoch(tok.authorization_epoch, f.transport.authorizationEpoch), "AUTHORIZATION_EPOCH_STALE");
  });

  it("the client-observable / server-only partition covers the whole class", () => {
    const clientSide = ["fence-002", "token-002", "token-003", "token-006"];
    const all = byClass("state-scenario").map((v) => v.id).sort();
    assert.deepEqual([...clientSide, ...SERVER_ONLY.keys()].sort(), all, "every state-scenario vector is either replayed here or named server-only with a reason");
    // eslint-disable-next-line no-console
    console.log(`gitvault deploy vectors rev ${vectorFile!["x-r402s-revision"]}: activation-token ${vectorFile!.counts_by_class["activation-token"]}/${vectorFile!.counts_by_class["activation-token"]}, state-scenario ${clientSide.length}/${all.length} client-side (${SERVER_ONLY.size} server-only)`);
  });
});
