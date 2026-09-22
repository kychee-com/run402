/**
 * The vault deploy lane — the supplier `add-vault` 5.6 never had
 * (change `vault-deploy-lane`, tasks 3.1–3.4).
 *
 * WHY EACH OUTCOME GETS A TEST. A lane that only proves its success path is
 * not proven: every refusal here is a path an agent will actually hit — a
 * vault that is unreachable, a build that fails, a token the platform revoked,
 * a tree that moved mid-deploy — and each one has a different correct answer.
 * The five outcomes are a CLOSED enum precisely so a caller can branch on them,
 * which is worth nothing if four of them are untested.
 *
 * The `Deploy` engine is faked (it is the thing under test's collaborator, not
 * its subject), but the vault half is REAL: a real git work tree, the real
 * `captureSnapshot`, the real push/mint/consume machine from the memory
 * transport. So the handshake between `Deploy.apply()`'s single call and
 * `runVaultDeploy`'s plan-then-commit shape is exercised end to end.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalError, Run402Error } from "../errors.js";
import type { Deploy } from "../namespaces/deploy.js";
import type { Repos } from "../namespaces/repos.js";
import type { ApplyOptions, DeployResult, VaultCommitDeclaration, VaultPlanDeclaration, ReleaseSpec } from "../namespaces/deploy.types.js";
import type { VaultRecord } from "./vault-publication.js";
import { applyWithVault, createApplyDeployLane, type ApplyWithVaultResult } from "./vault-apply.js";
import { runVaultDeploy, type VaultDeployOptions, type VaultDeployResult } from "./vault-deploy.js";
import { git, makeVault, type VaultFixture } from "./vault-memory-transport.test.js";

// ─── Fakes ───────────────────────────────────────────────────────────────────

const SPEC: ReleaseSpec = { project: "prj_test", site: { replace: { files: [] } } } as unknown as ReleaseSpec;

interface FakeEngineOptions {
  /** Fail before the plan exists — the "build failed" case. */
  failBeforePlan?: string;
  /** Fail at commit — the platform refused the activation (revoked/expired/bound elsewhere). */
  failAtCommit?: string;
  /** The digest the gateway answers with; `null` models a gateway that returned none. */
  applyPlanSha256?: string | null;
  /**
   * The control plane the operation row is registered with. The real gateway
   * creates it at plan time under the vault gate, and the token mint validates
   * against it — without it every mint is `VAULT_ACCESS_DENIED` and the
   * outcome tests would pass for the wrong reason.
   */
  transport?: { operations: Map<string, { operation_id: string; capture_id: string; apply_plan_sha256: string | null; snapshot_oid_hmac: string; override: unknown; activated_with: unknown }> };
}

interface FakeEngine {
  engine: Deploy;
  /** Every `apply()` call's options, so "the plain path is untouched" is checkable. */
  applies: ApplyOptions[];
  declarations: VaultPlanDeclaration[];
  commitBlocks: (VaultCommitDeclaration | undefined)[];
}

const DEPLOY_RESULT = { operation_id: "op_ready", status: "ready" } as unknown as DeployResult;

/**
 * A `Deploy` whose `apply()` reproduces the real one's vault handshake:
 * declare at plan time, call `authorize` once content is uploaded, then commit
 * with whatever it hands back.
 */
function fakeEngine(options: FakeEngineOptions = {}): FakeEngine {
  const state: FakeEngine = { engine: null as unknown as Deploy, applies: [], declarations: [], commitBlocks: [] };
  let n = 0;
  state.engine = {
    async apply(_spec: ReleaseSpec, opts: ApplyOptions = {}): Promise<DeployResult> {
      state.applies.push(opts);
      if (options.failBeforePlan) throw new LocalError("the build failed before a plan existed", "planning apply", { code: options.failBeforePlan });
      if (!opts.vault) return DEPLOY_RESULT;
      state.declarations.push(opts.vault.declaration);
      n += 1;
      const operationId = `op_${String(n).padStart(32, "0")}`;
      const digest = options.applyPlanSha256 === undefined ? `${String(n).repeat(2)}${"ab".repeat(31)}` : options.applyPlanSha256;
      options.transport?.operations.set(operationId, {
        operation_id: operationId,
        capture_id: opts.vault.declaration.capture_id,
        apply_plan_sha256: digest,
        snapshot_oid_hmac: opts.vault.declaration.snapshot_oid_hmac,
        override: null,
        activated_with: null,
      });
      const block = await opts.vault.authorize({ plan_id: `pln_${n}`, operation_id: operationId, apply_plan_sha256: digest });
      state.commitBlocks.push(block);
      if (options.failAtCommit) throw new Run402Error("the platform refused the commit", 409, { code: options.failAtCommit }, "committing deploy");
      return DEPLOY_RESULT;
    },
  } as unknown as Deploy;
  return state;
}

/** A `Repos` that answers the policy read and runs the REAL deploy machine. */
function fakeVault(fixture: VaultFixture, policy: VaultRecord["vault_policy"], overrides: { forProjectThrows?: unknown } = {}): {
  repos: Repos;
  forProjectCalls: string[];
  deployCalls: number;
} {
  const state = { forProjectCalls: [] as string[], deployCalls: 0 };
  const repos = {
    async forProject(projectId: string): Promise<VaultRecord> {
      state.forProjectCalls.push(projectId);
      if (overrides.forProjectThrows) throw overrides.forProjectThrows;
      return { repo_id: fixture.repoId, project_id: projectId, vault_policy: policy } as VaultRecord;
    },
    async deploy(opts: Omit<VaultDeployOptions, "vault">): Promise<VaultDeployResult> {
      state.deployCalls += 1;
      return runVaultDeploy({ ...opts, vault: fixture.vault, repo_dir: fixture.repoDir });
    },
  } as unknown as Repos;
  return { repos, ...state, get forProjectCalls() { return state.forProjectCalls; }, get deployCalls() { return state.deployCalls; } };
}

async function fixtureWithApp(): Promise<VaultFixture> {
  const f = await makeVault();
  writeFileSync(join(f.repoDir, "app.js"), "v1\n");
  await git(f.repoDir, ["add", "app.js"]);
  await git(f.repoDir, ["commit", "-q", "-m", "app"]);
  return f;
}

function outcomeOf(r: ApplyWithVaultResult): string {
  assert.ok(r.vault, "expected the vaulted path");
  return r.vault.outcome;
}

// ─── Grandfathered and vaultless projects (task 3.2) ─────────────────────────

/**
 * The regression that would break EVERY non-vault user. These projects are the
 * overwhelming majority, and the rule is not "roughly the same" — it is that
 * `apply()` receives the caller's own options object and nothing else, and
 * that the vault is never opened, never captured from, and never pushed to.
 */
describe("projects that are not `required` deploy exactly as they did before", () => {
  it("a vaultless project: one policy read, then the untouched apply", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const engine = fakeEngine();
    const vault = fakeVault(f, null, { forProjectThrows: new Run402Error("no vault", 404, { code: "RESOURCE_NOT_FOUND" }, "resolving") });

    const r = await applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC, apply: { idempotencyKey: "k1" } });

    assert.deepEqual(r.mode, { kind: "none", reason: "policy_unreadable" });
    assert.equal(r.vault, null);
    assert.equal(r.deploy, DEPLOY_RESULT);
    assert.equal(vault.deployCalls, 0, "no capture, no push, no token");
    assert.equal(engine.applies.length, 1);
    assert.deepEqual(engine.applies[0], { idempotencyKey: "k1" }, "the apply carries the caller's options and NO vault hooks");
    assert.equal(f.transport.calls.filter((c) => c.startsWith("admit:")).length, 0);
  });

  it("a grandfathered project: the escape hatch works, and adds nothing to the deploy", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const engine = fakeEngine();
    const vault = fakeVault(f, "grandfathered");

    const r = await applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC, apply: { allowWarnings: true } });

    assert.deepEqual(r.mode, { kind: "grandfathered", repo_id: f.repoId });
    assert.equal(r.vault, null);
    assert.equal(r.deploy, DEPLOY_RESULT);
    assert.equal(vault.deployCalls, 0);
    assert.deepEqual(engine.applies[0], { allowWarnings: true });
    assert.equal(vault.forProjectCalls.length, 1, "the ONLY added cost is determining the project is not `required`");
  });

  it("a Core target never even reads the policy — a self-hosted gateway has no vault gate", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const engine = fakeEngine({ transport: f.transport });
    const vault = fakeVault(f, "required");

    const r = await applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC, target: "core" });

    assert.equal(r.vault, null);
    assert.equal(vault.forProjectCalls.length, 0);
    assert.deepEqual(engine.applies[0], { target: "core" });
  });
});

// ─── D3 (repo-first-onramp task 2.3) — a vaulted, ungated project ────────────
//
// Allocating a vault no longer sets `vault_policy` (design D3), so a vault
// whose policy is `null` is the ORDINARY post-allocation shape, not a
// weakened one. The deploy must never block or prompt on this — it takes the
// exact same untouched plain path as `grandfathered` — but the result offers
// the gate as a typed next_action and names the drift as a standing warning,
// on EVERY such deploy (the client holds no local state to distinguish a
// "first" deploy from a "subsequent" one, and the spec's two scenarios are
// both satisfied by attaching both every time: scenario one only requires the
// offer to be present, scenario two only requires the warning to be present).

describe("D3 — a vaulted, ungated project deploys ungated and says so", () => {
  it("carries the policy-required offer and a standing warning naming the vault", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const engine = fakeEngine();
    const vault = fakeVault(f, null);

    const r = await applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC });

    assert.deepEqual(r.mode, { kind: "ungated", repo_id: f.repoId });
    assert.equal(r.vault, null, "no capture, no token — this is not the vaulted lane");
    assert.equal(vault.deployCalls, 0, "no capture, no push");
    assert.equal(engine.applies.length, 1);
    assert.deepEqual(engine.applies[0], {}, "the apply carries the caller's own options and NO vault hooks — byte-identical to the untouched path");

    assert.ok(r.deploy);
    assert.equal(r.deploy!.next_actions?.length, 1);
    assert.equal(r.deploy!.next_actions?.[0]?.type, "vault_policy_required");
    assert.equal(r.deploy!.next_actions?.[0]?.command, "run402 repos policy required");
    assert.equal(r.deploy!.warnings.length, 1);
    assert.equal(r.deploy!.warnings[0]?.code, "VAULT_POLICY_UNSET");
    assert.deepEqual((r.deploy!.warnings[0] as { affected?: string[] }).affected, [f.repoId]);
  });

  it("a second ungated deploy carries the same offer and warning again — nothing is ever blocked or prompted", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const engine = fakeEngine();
    const vault = fakeVault(f, null);

    const first = await applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC });
    const second = await applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC });

    for (const r of [first, second]) {
      assert.deepEqual(r.mode, { kind: "ungated", repo_id: f.repoId });
      assert.equal(r.deploy!.next_actions?.length, 1, "the offer to gate stays present — never escalates into a block or a prompt");
      assert.equal(r.deploy!.warnings.length, 1, "the drift warning names the same vault every time the policy stays unset");
    }
  });

  it("preserves the deploy's own plan warnings and next_actions alongside D3's own", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const ownWarning = { code: "SOME_OTHER_WARNING", severity: "low" as const, requires_confirmation: false, message: "unrelated" };
    const engine: FakeEngine = {
      engine: { async apply() { return { operation_id: "op_x", status: "ready", warnings: [ownWarning], diff: {} } as unknown as DeployResult; } } as unknown as Deploy,
      applies: [],
      declarations: [],
      commitBlocks: [],
    };
    const vault = fakeVault(f, null);

    const r = await applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC });

    assert.equal(r.deploy!.warnings.length, 2);
    assert.deepEqual(r.deploy!.warnings[0], ownWarning);
    assert.equal(r.deploy!.warnings[1]?.code, "VAULT_POLICY_UNSET");
  });

  it("a `grandfathered` project is unaffected: no offer, no D3 warning — the explicit choice already made", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const engine = fakeEngine();
    const vault = fakeVault(f, "grandfathered");

    const r = await applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC });

    assert.deepEqual(r.mode, { kind: "grandfathered", repo_id: f.repoId });
    assert.equal(r.deploy!.next_actions, undefined);
  });
});

// ─── The five terminal outcomes, through the real lane (task 3.4) ────────────

describe("the deploy lane reaches every one of the closed five", () => {
  it("DEPLOYED_AND_VAULTED: the plan declares the capture, the commit presents the token", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const engine = fakeEngine({ transport: f.transport });
    const vault = fakeVault(f, "required");
    const lines: string[] = [];

    const r = await applyWithVault({
      sdk: { _applyEngine: engine.engine, repos: vault.repos },
      spec: SPEC,
      repo_dir: f.repoDir,
      onCommitLine: (l) => lines.push(l),
    });

    assert.equal(outcomeOf(r), "DEPLOYED_AND_VAULTED");
    assert.deepEqual(r.mode, { kind: "vaulted", repo_id: f.repoId });
    assert.equal(r.deploy, DEPLOY_RESULT, "the caller still gets the DeployResult a plain apply would return");
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^vault_commit [0-9a-f]{40}$/);
    // the wire shape the production smoke proved
    assert.equal(engine.declarations.length, 1);
    assert.equal(engine.declarations[0]!.capture_id, r.vault!.capture_id);
    assert.equal(engine.declarations[0]!.snapshot_oid_hmac, r.vault!.snapshot_oid_hmac);
    if (r.vault!.outcome !== "DEPLOYED_AND_VAULTED") return;
    assert.deepEqual(engine.commitBlocks[0], { activation_token_id: r.vault!.activation_token.object_id });
  });

  it("a dirty work tree refuses SNAPSHOT_DIRTY_TREE before capture, and allowDirty threads through to capture it", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    writeFileSync(join(f.repoDir, "app.js"), "uncommitted work\n");
    const engine = fakeEngine({ transport: f.transport });
    const vault = fakeVault(f, "required");

    await assert.rejects(
      applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC, repo_dir: f.repoDir }),
      (e: unknown) => (e as { code?: string }).code === "SNAPSHOT_DIRTY_TREE",
    );
    assert.equal(engine.commitBlocks.length, 0, "nothing committed on the refusal path");

    const r = await applyWithVault({
      sdk: { _applyEngine: engine.engine, repos: vault.repos },
      spec: SPEC,
      repo_dir: f.repoDir,
      allowDirty: true,
    });
    assert.equal(outcomeOf(r), "DEPLOYED_AND_VAULTED");
  });

  it("DEPLOY_BLOCKED_PUSH_FAILED: nothing commits, the previous release keeps serving", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    f.transport.tamperReceiptAt = 1;
    const engine = fakeEngine({ transport: f.transport });
    const vault = fakeVault(f, "required");

    const r = await applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC, repo_dir: f.repoDir });

    assert.equal(outcomeOf(r), "DEPLOY_BLOCKED_PUSH_FAILED");
    assert.equal(r.deploy, null, "there is no DeployResult because there was no commit");
    assert.deepEqual(engine.commitBlocks, [], "the in-flight apply was unwound, not committed");
    // and the offer of the override names the capability it needs
    assert.equal(r.vault!.next_actions.find((a) => a.requires)?.requires, "gitvault.override_unvaulted");
  });

  it("DEPLOY_FAILED_VAULTED: the build failed, the attempt is still in the vault with a null digest", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const engine = fakeEngine({ failBeforePlan: "R402_AUTH_PREFLIGHT_FAILED", transport: f.transport });
    const vault = fakeVault(f, "required");

    const r = await applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC, repo_dir: f.repoDir });

    assert.equal(outcomeOf(r), "DEPLOY_FAILED_VAULTED");
    if (r.vault!.outcome !== "DEPLOY_FAILED_VAULTED") return;
    assert.equal(r.vault!.deploy_error.code, "R402_AUTH_PREFLIGHT_FAILED", "the build's own failure, not a synthesized one");
    assert.equal(r.vault!.apply_plan_sha256, null, "no digest, so no token is mintable from this capture");
    assert.equal(r.vault!.generation, "0000000000000001", "the push is never gated on deploy success");
  });

  it("DEPLOY_FAILED_UNVAULTED: neither lane landed", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    f.transport.tamperReceiptAt = 1;
    const engine = fakeEngine({ failBeforePlan: "MANIFEST_EMPTY", transport: f.transport });
    const vault = fakeVault(f, "required");

    const r = await applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC, repo_dir: f.repoDir });

    assert.equal(outcomeOf(r), "DEPLOY_FAILED_UNVAULTED");
    if (r.vault!.outcome !== "DEPLOY_FAILED_UNVAULTED") return;
    assert.equal(r.vault!.deploy_error.code, "MANIFEST_EMPTY");
    assert.equal(r.vault!.push_error.code, "VAULT_RECEIPT_MISMATCH");
  });

  it("DEPLOYED_UNVAULTED_OVERRIDE: the commit carries the audited override, never a token", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    f.transport.tamperReceiptAt = 1;
    const engine = fakeEngine({ transport: f.transport });
    const vault = fakeVault(f, "required");

    const r = await applyWithVault({
      sdk: { _applyEngine: engine.engine, repos: vault.repos },
      spec: SPEC,
      repo_dir: f.repoDir,
      allow_unvaulted: { reason: "the vault is unreachable and prod is down" },
    });

    assert.equal(outcomeOf(r), "DEPLOYED_UNVAULTED_OVERRIDE");
    assert.equal(r.deploy, DEPLOY_RESULT);
    assert.deepEqual(engine.commitBlocks[0], { allow_unvaulted: true, override_reason: "the vault is unreachable and prod is down" });
  });
});

// ─── Token discipline (task 3.3) ─────────────────────────────────────────────

describe("token discipline", () => {
  /**
   * The client half of "spent once": ONE token is minted, it binds THIS
   * operation, and exactly one commit presents it by id. (The server-side
   * single-consumption invariant is pinned against the memory control plane
   * in `vault-deploy.test.ts`, where the lane fake performs the consume.)
   */
  it("one token, bound to this operation, presented by exactly one commit", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const engine = fakeEngine({ transport: f.transport });
    const vault = fakeVault(f, "required");

    const r = await applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC, repo_dir: f.repoDir });
    if (r.vault?.outcome !== "DEPLOYED_AND_VAULTED") return assert.fail(String(r.vault?.outcome));

    const token = r.vault.activation_token;
    assert.equal(token.operation_id, r.vault.operation_id);
    assert.equal(token.capture_id, r.vault.capture_id);
    assert.equal(token.apply_plan_sha256, r.vault.apply_plan_sha256);
    assert.equal(engine.commitBlocks.length, 1);
    assert.deepEqual(engine.commitBlocks[0], { activation_token_id: token.object_id });
    assert.equal(engine.applies.length, 1, "one operation, one token");
  });

  /**
   * A revoked/expired/bound-elsewhere token is the platform telling you
   * something true. Retrying under a fresh capture would paper over it — and
   * would also mint a second generation for a deploy the owner may have
   * deliberately fenced (`REVOKED_BY_REPAIR`).
   */
  it("a platform refusal at commit surfaces as ITSELF, with no retry under a fresh token", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const engine = fakeEngine({ failAtCommit: "VAULT_ACTIVATION_TOKEN_REVOKED", transport: f.transport });
    const vault = fakeVault(f, "required");

    const r = await applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC, repo_dir: f.repoDir });

    assert.equal(outcomeOf(r), "DEPLOY_FAILED_VAULTED");
    if (r.vault!.outcome !== "DEPLOY_FAILED_VAULTED") return;
    assert.equal(r.vault!.deploy_error.code, "VAULT_ACTIVATION_TOKEN_REVOKED", "the platform's code, not a client substitution");
    assert.equal(engine.applies.length, 1, "one apply attempt — a retry would plan a NEW operation the token cannot answer for");
    assert.equal(engine.declarations.length, 1, "and would need a fresh capture, which is the caller's call to make");
  });

  it("a gateway that answers a capture-bearing plan with no digest fails the binding check rather than inventing one", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const engine = fakeEngine({ applyPlanSha256: null, transport: f.transport });
    const vault = fakeVault(f, "required");

    const r = await applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC, repo_dir: f.repoDir });

    assert.equal(outcomeOf(r), "DEPLOY_FAILED_VAULTED");
    if (r.vault!.outcome !== "DEPLOY_FAILED_VAULTED") return;
    assert.equal(r.vault!.deploy_error.code, "VAULT_PLAN_DIGEST_MISSING");
    assert.equal(r.vault!.apply_plan_sha256, null, "recorded as absent, not as a placeholder the token could be checked against");
    assert.deepEqual(engine.commitBlocks, [], "nothing was committed under a digest the platform never issued");
  });
});

// ─── Correspondence, through the lane (task 2.4) ─────────────────────────────

describe("a tree that moves under a lane-driven deploy refuses, and unwinds the apply", () => {
  it("SNAPSHOT_MOVED_DURING_DEPLOY: the apply is abandoned with nothing committed", async (t) => {
    const f = await fixtureWithApp();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const engine = fakeEngine({ transport: f.transport });
    const vault = fakeVault(f, "required");
    // Edit from inside `apply()`, where a build step would run — the mid-flight
    // window the whole check exists for.
    const original = engine.engine.apply.bind(engine.engine);
    (engine.engine as unknown as { apply: Deploy["apply"] }).apply = async (spec, opts) => {
      writeFileSync(join(f.repoDir, "app.js"), "v2 (written by the build)\n");
      return original(spec, opts);
    };

    await assert.rejects(
      applyWithVault({ sdk: { _applyEngine: engine.engine, repos: vault.repos }, spec: SPEC, repo_dir: f.repoDir }),
      (e: unknown) => {
        assert.equal((e as LocalError).code, "SNAPSHOT_MOVED_DURING_DEPLOY");
        assert.deepEqual(((e as LocalError).details as { modified: string[] }).modified, ["app.js"]);
        return true;
      },
    );
    assert.deepEqual(engine.commitBlocks, [], "the apply unwound before its commit");
    assert.equal(f.transport.consumedTokens.size, 0, "and no token was spent");
  });
});

// ─── The lane in isolation ───────────────────────────────────────────────────

describe("createApplyDeployLane", () => {
  it("abandon() unwinds an apply that will never be committed, and is idempotent", async () => {
    const engine = fakeEngine();
    const lane = createApplyDeployLane({ engine: engine.engine, spec: SPEC });
    await lane.plan({ source_dir: "/tmp/whatever", capture_id: "a".repeat(32), snapshot_oid_hmac: "b".repeat(64) });
    lane.abandon(new LocalError("push failed", "test", { code: "VAULT_TEST" }));
    lane.abandon(new LocalError("again", "test", { code: "VAULT_TEST" }));
    assert.equal(lane.result(), null);
    assert.deepEqual(engine.commitBlocks, []);
  });

  it("a commit without a token and without an override refuses rather than committing unvaulted", async () => {
    const engine = fakeEngine();
    const lane = createApplyDeployLane({ engine: engine.engine, spec: SPEC });
    await lane.plan({ source_dir: "/tmp/whatever", capture_id: "a".repeat(32), snapshot_oid_hmac: "b".repeat(64) });
    await assert.rejects(
      lane.commit({ plan_id: "pln_1", operation_id: "op_1" }),
      (e: unknown) => (e as LocalError).code === "VAULT_ACTIVATION_TOKEN_MISSING",
    );
    assert.deepEqual(engine.commitBlocks, []);
  });
});
