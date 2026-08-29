/**
 * `run402 repos` — the consolidated encrypted-repository family
 * (repo-surface-consolidation). Replaces the old `cli-repos-surface.test.mjs`
 * (which covered `create`/`list`/`delete`/`name` under the pre-consolidation
 * three-verb porcelain) with coverage for the full 12-verb surface.
 *
 * The SDK is mocked: what is under test is the CLI surface — argument
 * parsing, dispatch to the right SDK call, output shaping, and the D9/D3/D4
 * behavioral contracts the design requires. `create` touches REAL git state
 * (it may `git init` cwd), so every test runs from an isolated scratch
 * directory.
 */

import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalCwd = process.cwd();
const originalConfigDir = process.env.RUN402_CONFIG_DIR;

const PROJECT = "prj_fresh";
const ORG = "57035b1e-ec41-4ce6-a7a5-a5b2560efdd7";
const REPO = "src_49bd64c263e83be776930478f609a317";

let stdout = [];
let stderr = [];
let calls = [];
let impl = {};

function vaultStatus(overrides = {}) {
  return {
    repo_id: REPO,
    project_id: PROJECT,
    vault: null,
    keystore: { present: false, identity_fingerprint: null, can_sign: false, holds_repo_key: false, root: "/keystore", paths: {} },
    remote: null,
    pinned: null,
    refs: null,
    head_target: null,
    pins: { highest_authenticated: null, highest_materialized: null },
    gitvault_policy: null,
    pending_overrides: 0,
    terminal_loss_statement: "TERMINAL LOSS STATEMENT",
    terminal_loss_detail: "TERMINAL LOSS DETAIL",
    warnings: [],
    next_actions: [],
    ...overrides,
  };
}

function vaultRecord(overrides = {}) {
  return {
    repo_id: REPO,
    project_id: PROJECT,
    org_id: ORG,
    gitvault_policy: null,
    gitvault_policy_version: "1",
    gitvault_policy_changed_at: null,
    allocation_generation: "0",
    allocation_sha256: null,
    newest_generation: null,
    genesis_admitted_at: "2026-08-01T00:00:00.000Z",
    latest_effective_admitted_at: null,
    admitted_generations: "0",
    gc_epoch: "0",
    repair_version: "0",
    repair_fence_state: "none",
    storage: { source_bytes: "0", open_session_reserved_bytes: "0", objects: {} },
    maintenance: { lease: null, open_cycle: null, pending_repair_attempt_id: null },
    warnings: [],
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function notFound(message = "not found") {
  const e = new Error(message);
  e.status = 404;
  return e;
}

mock.module("./cli/lib/sdk.mjs", {
  namedExports: {
    getSdk: () => ({
      projects: {
        provision: async (input) => {
          calls.push({ method: "projects.provision", input });
          return (impl.provision ?? (async () => ({ project_id: PROJECT, anon_key: "anon", service_key: "svc", schema_slot: "s1" })))(input);
        },
        list: async (input) => {
          calls.push({ method: "projects.list", input });
          return (impl.projectsList ?? (async () => ({ projects: [{ id: PROJECT, name: "fresh", org_id: ORG }] })))(input);
        },
        delete: async (id) => {
          calls.push({ method: "projects.delete", id });
          return (impl.projectsDelete ?? (async () => undefined))(id);
        },
        setRepoName: async (id, repoName) => {
          calls.push({ method: "projects.setRepoName", id, repoName });
          return (impl.setRepoName ?? (async () => ({ project_id: id, repo_name: repoName, previous_repo_name: null })))(id, repoName);
        },
        get: async (id) => {
          calls.push({ method: "projects.get", id });
          return (impl.projectsGet ?? (async () => ({ project_id: id, mailbox: [], custom_domains: [] })))(id);
        },
        getSchema: async (id) => {
          calls.push({ method: "projects.getSchema", id });
          return (impl.projectsGetSchema ?? (async () => ({ schema: "public", tables: [] })))(id);
        },
      },
      functions: {
        list: async (id) => {
          calls.push({ method: "functions.list", id });
          return (impl.functionsList ?? (async () => ({ functions: [] })))(id);
        },
      },
      secrets: {
        list: async (id) => {
          calls.push({ method: "secrets.list", id });
          return (impl.secretsList ?? (async () => ({ secrets: [] })))(id);
        },
      },
      subdomains: {
        list: async (id) => {
          calls.push({ method: "subdomains.list", id });
          return (impl.subdomainsList ?? (async () => []))(id);
        },
      },
      org: (id) => ({
        get: async () => {
          calls.push({ method: "org.get", id });
          return (impl.orgGet ?? (async () => ({ org_id: id, display_name: null, slug: null, tier: "prototype", lease_started_at: null, lease_expires_at: null })))(id);
        },
      }),
      gitvault: {
        init: async (input) => {
          calls.push({ method: "gitvault.init", input });
          return (impl.gitvaultInit ?? (async () => ({
            repo_id: REPO,
            project_id: input.project_id,
            recovery_receipt: { format: "r402s/v0", object_kind: "recovery_receipt" },
            genesis_sha256: "d1277eb4",
            remote: { name: "origin", url: `run402::${input.org_id}/${input.project_id}`, created_repository: true, already_present: false, existing_url: null, reason: "no existing 'origin' remote — claimed it" },
            deduplicated: false,
            terminal_loss_statement: "TERMINAL LOSS STATEMENT",
          })))(input);
        },
        status: async (input) => {
          calls.push({ method: "gitvault.status", input });
          return (impl.gitvaultStatus ?? (async () => vaultStatus()))(input);
        },
        get: async (repoId) => {
          calls.push({ method: "gitvault.get", repoId });
          return (impl.gitvaultGet ?? (async () => vaultRecord()))(repoId);
        },
        forProject: async (projectId) => {
          calls.push({ method: "gitvault.forProject", projectId });
          return (impl.gitvaultForProject ?? (async () => vaultRecord({ project_id: projectId })))(projectId);
        },
        listByOrg: async (orgId) => {
          calls.push({ method: "gitvault.listByOrg", orgId });
          return (impl.gitvaultListByOrg ?? (async () => { throw notFound("bulk route not shipped"); }))(orgId);
        },
        mirrorStatus: async (target) => {
          calls.push({ method: "gitvault.mirrorStatus", target });
          return (impl.mirrorStatus ?? (async () => ({
            repo_id: REPO, configured: false, destination: null, credential_kind: null,
            mirrored_generation: null, newest_generation: null, is_current: null, closing_command: null,
            validity_not_freshness: "VALIDITY NOT FRESHNESS", keystore_still_required: "KEYSTORE STILL REQUIRED",
          })))(target);
        },
        mirrorSet: async (input) => {
          calls.push({ method: "gitvault.mirrorSet", input });
          return (impl.mirrorSet ?? (async () => ({ repo_id: REPO, configured: true, destination: { kind: "s3", bucket: "acme", prefix: REPO }, credential_kind: "profile" })))(input);
        },
        mirrorRemove: async (target) => {
          calls.push({ method: "gitvault.mirrorRemove", target });
          return (impl.mirrorRemove ?? (async () => ({ repo_id: REPO, removed: true })))(target);
        },
        mirrorSync: async (target) => {
          calls.push({ method: "gitvault.mirrorSync", target });
          return (impl.mirrorSync ?? (async () => ({ repo_id: REPO, objects_copied: 0, objects_already_present: 0, objects_skipped_foreign_recipient: 0, objects_failed: 0, bytes_copied: "0", errors: [] })))(target);
        },
        setPolicy: async (repoId, input) => {
          calls.push({ method: "gitvault.setPolicy", repoId, input });
          return (impl.setPolicy ?? (async () => ({ gitvault_policy: input.gitvault_policy, gitvault_policy_version: "2", changed: true, warnings: [] })))(repoId, input);
        },
        push: async (input) => {
          calls.push({ method: "gitvault.push", input });
          return (impl.push ?? (async () => ({ generation: "0000000000000001", form: "wal" })))(input);
        },
        planPush: async (input) => {
          calls.push({ method: "gitvault.planPush", input });
          return (impl.planPush ?? (async () => ({ allocation_needed: false, would_admit_generation: "0000000000000001", would_admit_generation_decimal: "1", form: "wal", object_count: 1, encrypted_bytes: "10", raw_bytes: "8" })))(input);
        },
        fsck: async (input) => {
          calls.push({ method: "gitvault.fsck", input });
          return (impl.fsck ?? (async () => ({
            repo_id: REPO, write: input.write ?? true, verified_from_generation: null, verified_to_generation: "0000000000000001",
            local_state_changed: input.write ?? true, pin_before: { highest_authenticated: null, highest_materialized: null },
            pin_after: { highest_authenticated: "0000000000000001", highest_materialized: "0000000000000001" },
            refs: {}, head_target: null, mirror: null,
          })))(input);
        },
        compact: async (target) => {
          calls.push({ method: "gitvault.compact", target });
          return (impl.compact ?? (async () => ({ generation: "0000000000000001", head_sha256: "aa", form: "checkpoint", maintenance_lease_id: null, cutoff_bound: true, covered_refs: 1, covered_roots: 0 })))(target);
        },
        prune: async (opts) => {
          calls.push({ method: "gitvault.prune", opts });
          return (impl.prune ?? (async () => ({
            candidates: [], eligible_count: 0, retained_count: 0, object_candidates: [], deferred_object_count: 0,
            blocked_reason: "nothing eligible yet", intent_core: null, intent_core_sha256: null, attestation: null,
            submitted: false, intent: null, confirmation: null, note: "no root past its window",
          })))(opts);
        },
        access: async (target) => {
          calls.push({ method: "gitvault.access", target });
          return (impl.access ?? (async () => ({
            repo_id: REPO, org_id: ORG, recipients: [], unmatched_covered_fingerprints: [], stale_access: [],
            envelope_state_available: false, history_scope_available: false, gap: "GAP STATEMENT",
          })))(target);
        },
        rotateEpoch: async (input) => {
          calls.push({ method: "gitvault.rotateEpoch", input });
          return (impl.rotateEpoch ?? (async () => ({
            outcome: "admitted", generation: "0000000000000002", head_sha256: "aa".repeat(32), new_epoch: "0000000000000002",
            rotation_id: "bb".repeat(32), reason: input.reason, included: [{ principal_id: "prn_1", ek_fingerprint: "ek_" + "aa".repeat(16) }],
            excluded_keyless_principal_ids: [], excluded_unconfirmed_principal_ids: [], admission_record_sha256: "cc".repeat(32),
            capture_receipt: null, self_check: "passed",
          })))(input);
        },
        rotateEpochForKeyRevocation: async (principalId, input) => {
          calls.push({ method: "gitvault.rotateEpochForKeyRevocation", principalId, input });
          return (impl.rotateEpochForKeyRevocation ?? (async () => ({
            outcome: "admitted", generation: "0000000000000002", head_sha256: "aa".repeat(32), new_epoch: "0000000000000002",
            rotation_id: "bb".repeat(32), reason: "recipient_key_revoked", included: [],
            excluded_keyless_principal_ids: [], excluded_unconfirmed_principal_ids: [], admission_record_sha256: "cc".repeat(32),
            capture_receipt: null, self_check: "not_a_recipient",
          })))(principalId, input);
        },
        declareEpochSecretExposed: async (repoId) => {
          calls.push({ method: "gitvault.declareEpochSecretExposed", repoId });
          return (impl.declareEpochSecretExposed ?? (async () => ({ epoch_secret_exposure_version: "1" })))(repoId);
        },
        recover: async (input) => {
          calls.push({ method: "gitvault.recover", input });
          return (impl.recover ?? (async () => ({
            repo_id: REPO, recovered_generation: "0000000000000001", chain_break: null, absences: [], data_loss_detected: false,
            validity_not_freshness: "VALIDITY NOT FRESHNESS", keystore_still_required: "KEYSTORE STILL REQUIRED",
            layout: "bare",
            next_actions: [{ action: "the recovered repository is bare (no working files) — clone it to get a working tree", command: `git clone ${input.out_dir} ${input.out_dir}-worktree` }],
          })))(input);
        },
      },
    }),
  },
});

const { run } = await import("./cli/lib/repos.mjs");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function captureStart() {
  stdout = [];
  stderr = [];
  console.log = (...args) => stdout.push(args.map(String).join(" "));
  console.error = (...args) => stderr.push(args.map(String).join(" "));
}
function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

async function ok(sub, args = []) {
  captureStart();
  try {
    await run(sub, args);
  } finally {
    captureStop();
  }
  return JSON.parse(stdout.join("\n"));
}

/** Like `ok`, but for `--human` output: raw (non-JSON) stdout text. */
async function human(sub, args = []) {
  captureStart();
  try {
    await run(sub, args);
  } finally {
    captureStop();
  }
  return stdout.join("\n");
}

async function expectFailure(sub, args = []) {
  captureStart();
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  try {
    await assert.rejects(() => run(sub, args), /process\.exit/);
  } finally {
    captureStop();
    process.exit = originalExit;
  }
  return JSON.parse(stderr.join("\n"));
}

async function createLocalAllowance() {
  const { saveAllowance } = await import("./cli/lib/config.mjs");
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  saveAllowance({ address: account.address, privateKey, created: new Date().toISOString(), funded: false, rail: "x402" });
}

let scratch;
before(() => {
  scratch = mkdtempSync(join(tmpdir(), "run402-repos-surface-"));
});
after(() => {
  process.chdir(originalCwd);
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  if (originalConfigDir === undefined) delete process.env.RUN402_CONFIG_DIR;
  else process.env.RUN402_CONFIG_DIR = originalConfigDir;
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  calls = [];
  impl = {};
});

describe("run402 repos create — provision + allocate + scaffold, zero deploy ceremony", () => {
  let repoDir;
  before(async () => {
    repoDir = join(scratch, "create-repo");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-q", "-b", "main", "."]);
    process.env.RUN402_CONFIG_DIR = join(scratch, "create-cfg");
    process.chdir(repoDir);
    await createLocalAllowance();
  });

  it("provisions, allocates via gitvault.init, and scaffolds the remote", async () => {
    const payload = await ok("create", ["my-notes", "--org", ORG]);
    const provisionCall = calls.find((c) => c.method === "projects.provision");
    assert.ok(provisionCall);
    assert.equal(provisionCall.input.name, "my-notes");
    const initCall = calls.find((c) => c.method === "gitvault.init");
    assert.ok(initCall);
    assert.equal(initCall.input.project_id, PROJECT);
    assert.equal(payload.repo_id, REPO);
    assert.equal(payload.deployed, false);
  });

  it("the response's next_action is the exact git push to run (design D10)", async () => {
    const payload = await ok("create", ["push-notes", "--org", ORG]);
    const pushAction = payload.next_actions.find((a) => a.type === "push_repo");
    assert.ok(pushAction, "must carry a push_repo next_action");
    assert.equal(pushAction.command, "git push -u origin HEAD");
  });

  it("infers the name from the directory basename when no name is given", async () => {
    const inferDir = join(scratch, "inferred-repo-name");
    mkdirSync(inferDir, { recursive: true });
    git(inferDir, ["init", "-q", "-b", "main", "."]);
    const prevCwd = process.cwd();
    process.chdir(inferDir);
    try {
      const payload = await ok("create", ["--org", ORG]);
      const provisionCall = calls.find((c) => c.method === "projects.provision");
      assert.equal(provisionCall.input.name, "inferred-repo-name");
      assert.equal(payload.project_id, PROJECT);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("--project adopts an existing project instead of provisioning (absorbs the old `gitvault init`)", async () => {
    const payload = await ok("create", ["--project", PROJECT, "--org", ORG]);
    assert.equal(calls.find((c) => c.method === "projects.provision"), undefined, "must not provision a new project");
    const initCall = calls.find((c) => c.method === "gitvault.init");
    assert.ok(initCall);
    assert.equal(initCall.input.project_id, PROJECT);
    assert.equal(payload.repo_id, REPO);
  });

  it("rejects a name positional together with --project", async () => {
    const envelope = await expectFailure("create", ["a-name", "--project", PROJECT]);
    assert.equal(envelope.code, "BAD_USAGE");
  });

  it("rejects --tier/--idempotency-key together with --project", async () => {
    const envelope = await expectFailure("create", ["--project", PROJECT, "--tier", "prototype"]);
    assert.equal(envelope.code, "BAD_USAGE");
  });

  it("claims the address-form repo name and prints run402::<slug>/<name> when the owning org has a slug", async () => {
    impl.orgGet = async (id) => ({ org_id: id, display_name: null, slug: "acme", tier: "prototype", lease_started_at: null, lease_expires_at: null });
    const payload = await ok("create", ["My Notes!", "--org", ORG]);
    const setNameCall = calls.find((c) => c.method === "projects.setRepoName");
    assert.ok(setNameCall);
    assert.equal(setNameCall.repoName, "my-notes");
    assert.equal(payload.address, "run402::acme/my-notes");
  });

  it("claims no address and points at claiming an org slug when the org has none", async () => {
    const payload = await ok("create", ["no-slug-org", "--org", ORG]);
    assert.equal(payload.address, null);
    assert.ok(payload.next_actions.find((a) => a.type === "claim_org_slug"));
  });

  it("refuses an empty name before ever calling the SDK", async () => {
    const envelope = await expectFailure("create", [""]);
    assert.equal(envelope.code, "BAD_PROJECT_NAME");
    assert.equal(calls.length, 0);
  });
});

describe("run402 repos list — bulk read with graceful fallback", () => {
  it("uses the bulk vaults-by-org read when the gateway has it", async () => {
    impl.gitvaultListByOrg = async (orgId) => ({
      vaults: [{ repo_id: REPO, project_id: PROJECT, project_name: "fresh", repo_name: "fresh", org_slug: "acme", gitvault_policy: null, newest_generation: null, source_bytes: "0", genesis_admitted_at: null, created_at: "2026-01-01T00:00:00.000Z" }],
    });
    const payload = await ok("list", ["--org", ORG]);
    assert.equal(calls.find((c) => c.method === "projects.list"), undefined, "the fallback N+1 must not run when the bulk read succeeds");
    assert.equal(payload.repos.length, 1);
    assert.equal(payload.org_slug, "acme");
  });

  it("falls back to the per-project walk when the bulk route 404s, and says so", async () => {
    impl.projectsList = async () => ({ projects: [{ id: "prj_a", name: "a", org_id: ORG }, { id: "prj_b", name: "b", org_id: ORG }] });
    impl.gitvaultStatus = async (input) =>
      input.project_id === "prj_a"
        ? vaultStatus({ repo_id: "src_a", vault: vaultRecord({ repo_id: "src_a", project_id: "prj_a" }) })
        : vaultStatus({ vault: null });
    const payload = await ok("list", ["--org", ORG]);
    assert.ok(calls.find((c) => c.method === "gitvault.listByOrg"));
    assert.ok(calls.find((c) => c.method === "projects.list"), "fallback must have run");
    assert.equal(payload.repos.length, 1);
    assert.equal(payload.repos[0].project_id, "prj_a");
  });

  it("does not fail the whole listing when one bulk row's org has no slug lookup issue", async () => {
    impl.gitvaultListByOrg = async () => ({ vaults: [] });
    const payload = await ok("list", ["--org", ORG]);
    assert.deepEqual(payload.repos, []);
  });

  it("every JSON result carries a stats block, always on (Observability)", async () => {
    impl.gitvaultListByOrg = async () => ({ vaults: [] });
    const payload = await ok("list", ["--org", ORG]);
    assert.deepEqual(payload.stats, { round_trips: 0, wire_ms: 0, bytes_up: 0, bytes_down: 0 });
  });

  it("--human renders a compact roster instead of JSON, and is rejected with --json", async () => {
    impl.gitvaultListByOrg = async () => ({
      vaults: [{ repo_id: REPO, project_id: PROJECT, project_name: "fresh", repo_name: "fresh", org_slug: "acme", gitvault_policy: "required", newest_generation: null, source_bytes: "0", genesis_admitted_at: null, created_at: "2026-01-01T00:00:00.000Z" }],
    });
    const text = await human("list", ["--org", ORG, "--human"]);
    assert.throws(() => JSON.parse(text), "human output must not itself be valid JSON");
    assert.match(text, /run402::acme\/fresh/);
    assert.match(text, /policy=required/);

    const envelope = await expectFailure("list", ["--org", ORG, "--human", "--json"]);
    assert.equal(envelope.code, "BAD_USAGE");
  });
});

describe("run402 repos view — side-effect-free (design D3)", () => {
  it("never passes refs:true to gitvault.status", async () => {
    await ok("view", ["--project", PROJECT]);
    const statusCall = calls.find((c) => c.method === "gitvault.status");
    assert.ok(statusCall);
    assert.equal(statusCall.input.refs, undefined);
  });

  it("reports refs as {known:false, reason:'not_materialized'} with a verify_refs next_action", async () => {
    impl.gitvaultStatus = async () => vaultStatus({ vault: vaultRecord() });
    const payload = await ok("view", ["--project", PROJECT]);
    assert.deepEqual(payload.refs, { known: false, reason: "not_materialized" });
    const verifyRefs = payload.next_actions.find((a) => a.type === "verify_refs");
    assert.ok(verifyRefs);
    assert.equal(verifyRefs.command, "run402 repos fsck");
  });

  it("no verify_refs next_action when there is no vault to fsck", async () => {
    impl.gitvaultStatus = async () => vaultStatus({ vault: null });
    const payload = await ok("view", ["--project", PROJECT]);
    assert.equal(payload.next_actions.find((a) => a.type === "verify_refs"), undefined);
  });

  it("folds in the mirror summary when one is configured", async () => {
    impl.gitvaultStatus = async () => vaultStatus({ vault: vaultRecord() });
    impl.mirrorStatus = async () => ({ repo_id: REPO, configured: true, destination: "s3://acme/prefix", credential_kind: "profile", mirrored_generation: "0000000000000001", newest_generation: "0000000000000001", is_current: true, closing_command: null, validity_not_freshness: "V", keystore_still_required: "K" });
    const payload = await ok("view", ["--project", PROJECT]);
    assert.equal(payload.mirror.configured, true);
    assert.equal(payload.mirror.destination, "s3://acme/prefix");
  });

  it("--human renders a summary instead of JSON, and is rejected with --json", async () => {
    const envelope = await expectFailure("view", ["--project", PROJECT, "--human", "--json"]);
    assert.equal(envelope.code, "BAD_USAGE");
  });

  it("prints the terminal-loss statement verbatim when the SDK reports a single (or unknown) covering principal", async () => {
    impl.gitvaultStatus = async () => vaultStatus({ vault: vaultRecord() });
    await ok("view", ["--project", PROJECT]);
    assert.ok(stderr.some((line) => line === "TERMINAL LOSS STATEMENT"));
    assert.ok(stderr.some((line) => line === "TERMINAL LOSS DETAIL"));
  });

  it("prints the durability sentence instead — never the terminal-loss claim — once the SDK reports >= 2 covering recipients (dogfood item 2)", async () => {
    impl.gitvaultStatus = async () => vaultStatus({
      vault: vaultRecord(),
      terminal_loss_statement: null,
      terminal_loss_detail: null,
      durability_statement: "The vault protects source history from host-side loss while a principal keystore survives.",
      covering_recipients: 2,
    });
    await ok("view", ["--project", PROJECT]);
    assert.ok(stderr.some((line) => line === "The vault protects source history from host-side loss while a principal keystore survives."));
    assert.ok(stderr.some((line) => line.includes("covering_recipients: 2")));
    assert.equal(stderr.some((line) => line.includes("terminal for vault history")), false, "must never print the terminal-loss claim for a vault with a proven second recipient");
  });
});

describe("run402 repos rename — absorbs the old `repos name`", () => {
  it("addresses by --project and claims the name", async () => {
    impl.orgGet = async (id) => ({ org_id: id, display_name: null, slug: "acme", tier: "prototype", lease_started_at: null, lease_expires_at: null });
    const payload = await ok("rename", ["my-notes", "--project", PROJECT]);
    const setNameCall = calls.find((c) => c.method === "projects.setRepoName");
    assert.equal(setNameCall.id, PROJECT);
    assert.equal(payload.address, "run402::acme/my-notes");
  });

  it("addresses by --repo, resolving project_id via gitvault.get first", async () => {
    impl.gitvaultGet = async (repoId) => vaultRecord({ repo_id: repoId, project_id: PROJECT });
    const payload = await ok("rename", ["my-notes", "--repo", REPO]);
    assert.ok(calls.find((c) => c.method === "gitvault.get" && c.repoId === REPO));
    const setNameCall = calls.find((c) => c.method === "projects.setRepoName");
    assert.equal(setNameCall.id, PROJECT);
    assert.equal(payload.repo_name, "my-notes");
  });

  it("rejects --repo and --project together", async () => {
    const envelope = await expectFailure("rename", ["my-notes", "--repo", REPO, "--project", PROJECT]);
    assert.equal(envelope.code, "BAD_USAGE");
  });
});

describe("run402 repos delete — design D9 guard + vault-history confirmation", () => {
  it("refuses PROJECT_HAS_NON_REPO_RESOURCES when functions are materialized — --force does NOT override it", async () => {
    impl.functionsList = async () => ({ functions: [{ name: "fn1" }] });
    const envelope = await expectFailure("delete", ["--project", PROJECT, "--force"]);
    assert.equal(envelope.code, "PROJECT_HAS_NON_REPO_RESOURCES");
    assert.ok(envelope.details.refused_resources.find((r) => r.resource === "functions"));
    assert.equal(calls.find((c) => c.method === "projects.delete"), undefined);
  });

  it("treats a genuinely absent (404) resource as absent, not unknown", async () => {
    impl.projectsGetSchema = async () => { throw notFound(); };
    const payload = await ok("delete", ["--project", PROJECT]);
    assert.equal(payload.deleted, true);
  });

  it("refuses as unknown when a guard read fails for a reason other than 404 — never guesses yes", async () => {
    impl.secretsList = async () => { throw new Error("gateway unreachable"); };
    const envelope = await expectFailure("delete", ["--project", PROJECT, "--force"]);
    assert.equal(envelope.code, "PROJECT_HAS_NON_REPO_RESOURCES");
    assert.ok(envelope.details.refused_resources.find((r) => r.resource === "secrets" && r.status === "unknown"));
  });

  it("refuses without --force when the repo holds admitted generations", async () => {
    impl.gitvaultStatus = async () => vaultStatus({ vault: vaultRecord({ admitted_generations: "12" }) });
    const envelope = await expectFailure("delete", ["--project", PROJECT]);
    assert.equal(envelope.code, "CONFIRMATION_REQUIRED");
    assert.equal(calls.find((c) => c.method === "projects.delete"), undefined);
  });

  it("--force proceeds when the repo is repo-only, enumerating deleted_resources", async () => {
    impl.gitvaultStatus = async () => vaultStatus({ vault: vaultRecord({ admitted_generations: "12" }) });
    const payload = await ok("delete", ["--project", PROJECT, "--force"]);
    assert.equal(payload.deleted, true);
    assert.deepEqual(payload.deleted_resources, ["project", "vault_history"]);
  });

  it("addresses by --repo, resolving project_id via gitvault.get first", async () => {
    impl.gitvaultGet = async (repoId) => vaultRecord({ repo_id: repoId, project_id: PROJECT });
    const payload = await ok("delete", ["--repo", REPO]);
    assert.equal(payload.deleted, true);
    assert.ok(calls.find((c) => c.method === "projects.delete" && c.id === PROJECT));
  });
});

describe("run402 repos snapshot — thin passthrough to gitvault.push", () => {
  it("publishes via gitvault.push", async () => {
    const payload = await ok("snapshot", ["--project", PROJECT]);
    assert.ok(calls.find((c) => c.method === "gitvault.push"));
    assert.equal(payload.generation, "0000000000000001");
  });

  it("a snapshot-only publish (no branch heads) carries the restore_snapshot_ref next_action (blind-acceptance finding)", async () => {
    impl.push = async () => ({
      generation: "0000000000000001", form: "wal", refs: { "refs/run402/deploys/latest": "c".repeat(40) },
      head_target: { kind: "detached", oid: "c".repeat(40) }, objects: [], object_count: 1,
      encrypted_bytes: "10", raw_bytes: "8", gitvault_commit: "c".repeat(40), gitvault_commit_line: "line",
      snapshot: { kind: "head", oid: "c".repeat(40), captured_digest: "d" },
      mirror_push: { outcome: "skipped" }, reconcile_recipients: { outcome: "noop" },
    });
    const payload = await ok("snapshot", ["--project", PROJECT]);
    const na = (payload.next_actions ?? []).find((n) => n.type === "restore_snapshot_ref");
    assert.ok(na, "restore_snapshot_ref next_action present");
    assert.match(na.command, /refs\/run402\/deploys\/latest/);
    assert.ok(stderr.some((l) => l.includes("plain clone looks empty")));
  });

  it("--dry-run previews via planPush and publishes nothing", async () => {
    const payload = await ok("snapshot", ["--project", PROJECT, "--dry-run"]);
    assert.ok(calls.find((c) => c.method === "gitvault.planPush"));
    assert.equal(calls.find((c) => c.method === "gitvault.push"), undefined);
    assert.equal(payload.allocation_needed, false);
  });

  it("--allow-dirty threads opts.snapshot.allowDirty through to gitvault.push, and discloses what was captured", async () => {
    impl.push = async (input) => ({
      generation: "0000000000000001", form: "wal",
      snapshot: { modified_captured: ["app.js"], untracked_captured: ["scratch.txt"] },
    });
    await ok("snapshot", ["--project", PROJECT, "--allow-dirty"]);
    const pushCall = calls.find((c) => c.method === "gitvault.push");
    assert.equal(pushCall.input.snapshot.allowDirty, true);
    assert.ok(stderr.some((line) => line === "captured (modified): app.js"));
    assert.ok(stderr.some((line) => line === "captured (untracked): scratch.txt"));
  });

  it("--message and --allow-dirty combine into a single opts.snapshot object", async () => {
    await ok("snapshot", ["--project", PROJECT, "--message", "wip", "--allow-dirty"]);
    const pushCall = calls.find((c) => c.method === "gitvault.push");
    assert.deepEqual(pushCall.input.snapshot, { message: "wip", allowDirty: true });
  });

  it("-v prints a stats summary line to stderr", async () => {
    await ok("snapshot", ["--project", PROJECT, "-v"]);
    assert.ok(stderr.some((line) => line.startsWith("stats: round_trips=")));
  });
});

describe("run402 repos snapshot --dry-run — flood fix (dogfood item 1)", () => {
  function bigCaptured(n) {
    return Array.from({ length: n }, (_, i) => ({ path: `file${i}.txt`, mode: "100644", oid: "a".repeat(40) }));
  }

  it("default output summarizes instead of inlining the full captured-file inventory", async () => {
    impl.planPush = async () => ({
      allocation_needed: false, would_admit_generation: "0000000000000002", would_admit_generation_decimal: "2",
      form: "wal", object_count: 1, encrypted_bytes: "1284", raw_bytes: "1180",
      snapshot: {
        kind: "head", oid: "deadbeef", tree_oid: "treeoid", head: { kind: "symref", ref: "refs/heads/main" },
        head_oid: "deadbeef", captured: bigCaptured(3042), captured_digest: "digest123",
        modified_captured: [], untracked_captured: [], paths: [], top_level: "/repo", global_excludes_path: null,
      },
    });
    const payload = await ok("snapshot", ["--project", PROJECT, "--dry-run"]);
    assert.equal(payload.files_total, 3042);
    assert.equal(payload.files_changed, 0);
    assert.equal(payload.files_new, 0);
    assert.deepEqual(payload.changed_paths, []);
    assert.equal(payload.changed_more, 0);
    assert.equal(payload.manifest_path, null);
    // the flood is gone: no raw captured/paths arrays in the default snapshot object
    assert.equal(payload.snapshot.captured, undefined);
    assert.equal(payload.snapshot.paths, undefined);
    assert.equal(payload.snapshot.modified_captured, undefined);
    assert.equal(payload.snapshot.untracked_captured, undefined);
    // generation/commitment fields survive untouched
    assert.equal(payload.would_admit_generation, "0000000000000002");
    assert.equal(payload.form, "wal");
    assert.equal(payload.object_count, 1);
    assert.equal(payload.encrypted_bytes, "1284");
    assert.equal(payload.raw_bytes, "1180");
    assert.equal(payload.snapshot.oid, "deadbeef");
    assert.equal(payload.snapshot.captured_digest, "digest123");
  });

  it("changed_paths caps at 200 with an explicit changed_more overflow, never silent truncation", async () => {
    const untracked = Array.from({ length: 250 }, (_, i) => `new${String(i).padStart(4, "0")}.txt`);
    impl.planPush = async () => ({
      allocation_needed: false, would_admit_generation: "0000000000000002", would_admit_generation_decimal: "2",
      form: "wal", object_count: 1, encrypted_bytes: "1284", raw_bytes: "1180",
      snapshot: {
        kind: "head", oid: "deadbeef", tree_oid: "treeoid", head: { kind: "symref", ref: "refs/heads/main" },
        head_oid: "deadbeef", captured: bigCaptured(300), captured_digest: "digest123",
        modified_captured: [], untracked_captured: untracked, paths: [], top_level: "/repo", global_excludes_path: null,
      },
    });
    const payload = await ok("snapshot", ["--project", PROJECT, "--dry-run"]);
    assert.equal(payload.files_new, 250);
    assert.equal(payload.changed_paths.length, 200);
    assert.equal(payload.changed_more, 50);
  });

  it("--manifest-out writes the complete untouched inventory to a file and names it in manifest_path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-manifest-out-"));
    const outPath = join(dir, "plan.json");
    impl.planPush = async () => ({
      allocation_needed: false, would_admit_generation: "0000000000000002", would_admit_generation_decimal: "2",
      form: "wal", object_count: 1, encrypted_bytes: "1284", raw_bytes: "1180",
      snapshot: {
        kind: "head", oid: "deadbeef", tree_oid: "treeoid", head: { kind: "symref", ref: "refs/heads/main" },
        head_oid: "deadbeef", captured: bigCaptured(10), captured_digest: "digest123",
        modified_captured: [], untracked_captured: [], paths: [], top_level: "/repo", global_excludes_path: null,
      },
    });
    const payload = await ok("snapshot", ["--project", PROJECT, "--dry-run", "--manifest-out", outPath]);
    assert.equal(payload.manifest_path, outPath);
    assert.equal(payload.snapshot.captured, undefined); // stdout still summarized
    const written = JSON.parse(readFileSync(outPath, "utf-8"));
    assert.equal(written.snapshot.captured.length, 10); // the file holds the FULL inventory
    rmSync(dir, { recursive: true, force: true });
  });

  it("-v/--verbose inlines the full inventory in the JSON in addition to the stats line", async () => {
    impl.planPush = async () => ({
      allocation_needed: false, would_admit_generation: "0000000000000002", would_admit_generation_decimal: "2",
      form: "wal", object_count: 1, encrypted_bytes: "1284", raw_bytes: "1180",
      snapshot: {
        kind: "head", oid: "deadbeef", tree_oid: "treeoid", head: { kind: "symref", ref: "refs/heads/main" },
        head_oid: "deadbeef", captured: bigCaptured(10), captured_digest: "digest123",
        modified_captured: [], untracked_captured: [], paths: [], top_level: "/repo", global_excludes_path: null,
      },
    });
    const payload = await ok("snapshot", ["--project", PROJECT, "--dry-run", "-v"]);
    assert.equal(payload.snapshot.captured.length, 10); // fully inlined under -v
    assert.equal(payload.files_total, 10); // summary fields compose, they don't disappear
    assert.ok(stderr.some((line) => line.startsWith("stats: round_trips=")));
  });

  it("a real (non-dry-run) snapshot gets the same summarize-by-default treatment", async () => {
    impl.push = async () => ({
      generation: "0000000000000001", form: "wal",
      snapshot: {
        kind: "head", oid: "deadbeef", tree_oid: "treeoid", head: { kind: "symref", ref: "refs/heads/main" },
        head_oid: "deadbeef", captured: bigCaptured(3042), captured_digest: "digest123",
        modified_captured: [], untracked_captured: [], paths: [], top_level: "/repo", global_excludes_path: null,
      },
    });
    const payload = await ok("snapshot", ["--project", PROJECT]);
    assert.equal(payload.files_total, 3042);
    assert.equal(payload.snapshot.captured, undefined);
  });
});

describe("run402 repos policy", () => {
  it("requires --reason for grandfathered", async () => {
    const envelope = await expectFailure("policy", ["grandfathered", "--project", PROJECT]);
    assert.equal(envelope.code, "BAD_USAGE");
  });

  it("required needs no reason and calls setPolicy", async () => {
    const payload = await ok("policy", ["required", "--project", PROJECT]);
    assert.ok(calls.find((c) => c.method === "gitvault.setPolicy"));
    assert.equal(payload.gitvault_policy, "required");
  });
});

describe("run402 repos mirror — one flag-driven verb (design D4)", () => {
  it("no-arg reads (mirrorStatus)", async () => {
    await ok("mirror", ["--project", PROJECT]);
    assert.ok(calls.find((c) => c.method === "gitvault.mirrorStatus"));
  });

  it("<destination> upserts (mirrorSet)", async () => {
    await ok("mirror", ["s3://acme-bucket", "--profile", "acme", "--project", PROJECT]);
    const setCall = calls.find((c) => c.method === "gitvault.mirrorSet");
    assert.ok(setCall);
    assert.equal(setCall.input.destination_url, "s3://acme-bucket");
  });

  it("--off removes config only (mirrorRemove)", async () => {
    await ok("mirror", ["--off", "--project", PROJECT]);
    assert.ok(calls.find((c) => c.method === "gitvault.mirrorRemove"));
  });

  it("--backfill syncs (mirrorSync)", async () => {
    await ok("mirror", ["--backfill", "--project", PROJECT]);
    assert.ok(calls.find((c) => c.method === "gitvault.mirrorSync"));
  });

  it("rejects combining <destination> with --off", async () => {
    const envelope = await expectFailure("mirror", ["s3://acme-bucket", "--off", "--project", PROJECT]);
    assert.equal(envelope.code, "BAD_USAGE");
  });

  it("rejects combining --off with --backfill", async () => {
    const envelope = await expectFailure("mirror", ["--off", "--backfill", "--project", PROJECT]);
    assert.equal(envelope.code, "BAD_USAGE");
  });
});

describe("run402 repos fsck — absorbs verify + mirror verify (design D2/D3)", () => {
  it("writes by default and reports local_state_changed", async () => {
    const payload = await ok("fsck", ["--project", PROJECT]);
    const fsckCall = calls.find((c) => c.method === "gitvault.fsck");
    assert.equal(fsckCall.input.write, true);
    assert.equal(payload.local_state_changed, true);
  });

  it("--no-write passes write:false through", async () => {
    impl.fsck = async (input) => ({
      repo_id: REPO, write: input.write, verified_from_generation: null, verified_to_generation: "0000000000000001",
      local_state_changed: false, pin_before: { highest_authenticated: null, highest_materialized: null },
      pin_after: { highest_authenticated: null, highest_materialized: null }, refs: {}, head_target: null, mirror: null,
    });
    const payload = await ok("fsck", ["--project", PROJECT, "--no-write"]);
    const fsckCall = calls.find((c) => c.method === "gitvault.fsck");
    assert.equal(fsckCall.input.write, false);
    assert.equal(payload.local_state_changed, false);
  });

  it("--mirror requests the keyless mirror probe too", async () => {
    await ok("fsck", ["--project", PROJECT, "--mirror"]);
    const fsckCall = calls.find((c) => c.method === "gitvault.fsck");
    assert.equal(fsckCall.input.mirror, true);
  });

  it("--budget threads through as verification_budget", async () => {
    await ok("fsck", ["--project", PROJECT, "--budget", "50"]);
    const fsckCall = calls.find((c) => c.method === "gitvault.fsck");
    assert.equal(fsckCall.input.verification_budget, 50);
  });

  it("--human renders a short summary instead of JSON, and is rejected with --json", async () => {
    const text = await human("fsck", ["--project", PROJECT, "--human"]);
    assert.throws(() => JSON.parse(text));
    assert.match(text, /Repo: /);

    const envelope = await expectFailure("fsck", ["--project", PROJECT, "--human", "--json"]);
    assert.equal(envelope.code, "BAD_USAGE");
  });
});

describe("run402 repos gc — absorbs compact + prune, never described as exactly git gc (design D2)", () => {
  it("plans by default: compact then prune, no submit", async () => {
    const payload = await ok("gc", ["--project", PROJECT]);
    assert.ok(calls.find((c) => c.method === "gitvault.compact"));
    const pruneCall = calls.find((c) => c.method === "gitvault.prune");
    assert.ok(pruneCall);
    assert.equal(pruneCall.opts.submit, undefined);
    assert.equal(payload.phase, "planned");
  });

  it("the submit next_action carries destructive/requires_approval/safe_to_auto_execute as additive fields", async () => {
    impl.prune = async () => ({
      candidates: [], eligible_count: 1, retained_count: 0,
      object_candidates: [{ object_id: "obj_1", object_kind: "wal_pack", size_bytes: "10" }],
      deferred_object_count: 0, blocked_reason: null, intent_core: { nonce: "n" }, intent_core_sha256: "abc",
      attestation: null, submitted: false, intent: null, confirmation: null, note: "ready to submit",
    });
    const payload = await ok("gc", ["--project", PROJECT]);
    const submitAction = payload.next_actions.find((a) => a.type === "submit_gc");
    assert.ok(submitAction);
    assert.equal(submitAction.destructive, true);
    assert.equal(submitAction.requires_approval, true);
    assert.equal(submitAction.safe_to_auto_execute, false);
  });

  it("--submit needs both --intent-core and --verifier-receipt", async () => {
    const envelope = await expectFailure("gc", ["--project", PROJECT, "--submit"]);
    assert.equal(envelope.code, "BAD_USAGE");
  });

  it("--submit skips compact entirely and submits prune only", async () => {
    const { writeFileSync } = await import("node:fs");
    const corePath = join(scratch, "core.json");
    const receiptPath = join(scratch, "receipt.json");
    writeFileSync(corePath, JSON.stringify({ nonce: "n" }));
    writeFileSync(receiptPath, JSON.stringify({ verifier: "r402s-verify" }));
    impl.prune = async () => ({
      candidates: [], eligible_count: 0, retained_count: 0, object_candidates: [], deferred_object_count: 0,
      blocked_reason: null, intent_core: null, intent_core_sha256: null, attestation: null,
      submitted: true, intent: { id: "int_1" }, confirmation: null, note: "submitted",
    });
    const payload = await ok("gc", ["--project", PROJECT, "--submit", "--intent-core", corePath, "--verifier-receipt", receiptPath]);
    assert.equal(calls.find((c) => c.method === "gitvault.compact"), undefined, "must not compact during --submit");
    const pruneCall = calls.find((c) => c.method === "gitvault.prune");
    assert.ok(pruneCall.opts.submit.core);
    assert.ok(pruneCall.opts.submit.verifier_receipt);
    assert.equal(payload.phase, "submitted");
  });
});

describe("run402 repos access — read-only; repair/revoke-key/declare-exposure drive real epoch rotation (D193-D203, rev 42)", () => {
  it("reads recipients + coverage, never mutates", async () => {
    impl.access = async () => ({
      repo_id: REPO, org_id: ORG,
      recipients: [{ principal_id: "prn_1", display_name: "Alice", fingerprint: "ek_abc", covered: true, tofu_pin: null }],
      unmatched_covered_fingerprints: [], envelope_state_available: false, history_scope_available: false, gap: "GAP STATEMENT",
    });
    const payload = await ok("access", ["--project", PROJECT]);
    assert.equal(payload.recipients.length, 1);
    assert.equal(payload.envelope_state_available, false);
    assert.equal(calls.find((c) => c.method === "gitvault.reconcileEnvelopeRecipients"), undefined, "access must never wrap a key");
  });

  it("--human renders a compact roster instead of JSON, and is rejected with --json", async () => {
    impl.access = async () => ({
      repo_id: REPO, org_id: ORG,
      recipients: [{ principal_id: "prn_1", display_name: "Alice", fingerprint: "ek_abc", covered: true, tofu_pin: null }],
      unmatched_covered_fingerprints: [], envelope_state_available: false, history_scope_available: false, gap: "GAP STATEMENT",
    });
    const text = await human("access", ["--project", PROJECT, "--human"]);
    assert.throws(() => JSON.parse(text));
    assert.match(text, /Alice/);

    const envelope = await expectFailure("access", ["--project", PROJECT, "--human", "--json"]);
    assert.equal(envelope.code, "BAD_USAGE");
  });

  it("labels this machine's own covering fingerprint distinctly from orphaned/external (dogfood item 4)", async () => {
    impl.access = async () => ({
      repo_id: REPO, org_id: ORG,
      recipients: [{ principal_id: "prn_1", display_name: "Alice", fingerprint: "ek_abc", covered: true, tofu_pin: null }],
      unmatched_covered_fingerprints: ["ek_truly_orphan"],
      this_keystore: { fingerprint: "ek_this_machine", covered: true },
      envelope_state_available: false, history_scope_available: false, gap: "GAP STATEMENT",
    });
    const payload = await ok("access", ["--project", PROJECT]);
    assert.deepEqual(payload.this_keystore, { fingerprint: "ek_this_machine", covered: true });
    assert.ok(stderr.some((line) => line.includes("ek_this_machine") && line.includes("this machine's own keystore")));
    assert.ok(stderr.some((line) => line.includes("ek_truly_orphan") && line.includes("orphaned/external")));
    assert.equal(stderr.some((line) => line.includes("ek_this_machine") && line.includes("orphaned/external")), false, "this machine's own fingerprint must never be labeled orphaned/external");
  });

  it("summarizes stale_access on stderr when the gateway ships desired-recipient state", async () => {
    impl.access = async () => ({
      repo_id: REPO, org_id: ORG,
      recipients: [{ principal_id: "prn_1", display_name: "Alice", fingerprint: "ek_abc", covered: true, envelope_state: "converged", tofu_pin: null }],
      unmatched_covered_fingerprints: [],
      stale_access: [{ principal_id: "prn_2", display_name: "Charlie", fingerprint: "ek_charlie" }],
      envelope_state_available: true, history_scope_available: false, gap: "GAP STATEMENT",
    });
    const payload = await ok("access", ["--project", PROJECT]);
    assert.equal(payload.stale_access.length, 1);
    assert.ok(stderr.some((line) => line.includes("Charlie") && line.includes("STILL decrypt")), "must call out a removed member who still has access");
  });

  it("access repair refuses cleanly, naming the missing rotation counters, when the two flags are omitted", async () => {
    const envelope = await expectFailure("access", ["repair", "--project", PROJECT]);
    assert.equal(envelope.code, "ROTATION_COUNTERS_REQUIRED");
    assert.ok(envelope.next_actions.some((a) => a.command === "run402 repos access revoke-key <principal_id>"));
  });

  it("access repair drives gitvault.rotateEpoch with reason:elective_rekey when the two counter flags are supplied", async () => {
    const payload = await ok("access", ["repair", "--project", PROJECT, "--recipient-state-version", "3", "--recipient-revocation-version", "1"]);
    assert.equal(payload.outcome, "admitted");
    const call = calls.find((c) => c.method === "gitvault.rotateEpoch");
    assert.equal(call.input.reason, "elective_rekey");
    assert.equal(call.input.recipient_state_version, "3");
    assert.equal(call.input.recipient_revocation_version, "1");
  });

  it("access revoke-key <principal_id> drives gitvault.rotateEpochForKeyRevocation — no flags needed", async () => {
    const payload = await ok("access", ["revoke-key", "prn_compromised", "--project", PROJECT]);
    assert.equal(payload.outcome, "admitted");
    const call = calls.find((c) => c.method === "gitvault.rotateEpochForKeyRevocation");
    assert.equal(call.principalId, "prn_compromised");
  });

  it("access revoke-key requires the principal_id positional", async () => {
    const envelope = await expectFailure("access", ["revoke-key", "--project", PROJECT]);
    assert.equal(envelope.code, "BAD_USAGE");
  });

  it("access declare-exposure drives gitvault.declareEpochSecretExposed and names the follow-up rotation is not automatic", async () => {
    const payload = await ok("access", ["declare-exposure", "--project", PROJECT]);
    assert.equal(payload.epoch_secret_exposure_version, "1");
    assert.ok(stderr.some((line) => line.includes("DOES NOT ROTATE")));
    const call = calls.find((c) => c.method === "gitvault.declareEpochSecretExposed");
    assert.equal(call.repoId, REPO);
  });
});

describe("run402 repos recover — kept, D10 confirms the name", () => {
  it("requires --out", async () => {
    const envelope = await expectFailure("recover", ["s3://acme-bucket"]);
    assert.equal(envelope.code, "BAD_USAGE");
  });

  it("passes source + out_dir through to gitvault.recover", async () => {
    const payload = await ok("recover", ["s3://acme-bucket", "--out", join(scratch, "restored")]);
    const recoverCall = calls.find((c) => c.method === "gitvault.recover");
    assert.equal(recoverCall.input.source, "s3://acme-bucket");
    assert.equal(payload.repo_id, REPO);
  });

  it("names the bare layout and the exact git clone command to materialize working files (dogfood item 3)", async () => {
    const outDir = join(scratch, "restored");
    const payload = await ok("recover", ["s3://acme-bucket", "--out", outDir]);
    assert.equal(payload.layout, "bare");
    assert.equal(payload.next_actions[0].command, `git clone ${outDir} ${outDir}-worktree`);
    assert.ok(stderr.some((line) => line.includes("layout: bare")));
    assert.ok(stderr.some((line) => line.includes(`git clone ${outDir} ${outDir}-worktree`)));
  });

  it("--human renders a short summary instead of JSON, and is rejected with --json", async () => {
    const outDir = join(scratch, "restored-human");
    const text = await human("recover", ["s3://acme-bucket", "--out", outDir, "--human"]);
    assert.throws(() => JSON.parse(text));
    assert.match(text, /Repo: /);

    const envelope = await expectFailure("recover", ["s3://acme-bucket", "--out", outDir, "--human", "--json"]);
    assert.equal(envelope.code, "BAD_USAGE");
  });
});

describe("run402 repos snapshot — compact_advised next_action (gitvault-clone-scaling P3)", () => {
  it("an advised staleness on the publish result surfaces as a compact_advised next_action naming repos gc", async () => {
    impl.push = async () => ({
      generation: "000000000000001b", form: "wal", refs: { "refs/heads/main": "c".repeat(40) },
      checkpoint_staleness: { generations_since_checkpoint: 27, advised: true },
      snapshot: { kind: "head", oid: "c".repeat(40), captured_digest: "d" },
      mirror_push: { outcome: "skipped" }, reconcile_recipients: { outcome: "noop" },
    });
    const payload = await ok("snapshot", ["--project", PROJECT]);
    const na = (payload.next_actions ?? []).find((n) => n.type === "compact_advised");
    assert.ok(na, "compact_advised next_action present");
    assert.equal(na.command, "run402 repos gc");
    assert.match(na.why, /27 generations/);
  });

  it("under-threshold (or unknown) staleness adds nothing — the advisory never fires quietly wrong", async () => {
    impl.push = async () => ({
      generation: "0000000000000002", form: "wal", refs: { "refs/heads/main": "c".repeat(40) },
      checkpoint_staleness: { generations_since_checkpoint: 2, advised: false },
      snapshot: { kind: "head", oid: "c".repeat(40), captured_digest: "d" },
      mirror_push: { outcome: "skipped" }, reconcile_recipients: { outcome: "noop" },
    });
    const payload = await ok("snapshot", ["--project", PROJECT]);
    assert.equal((payload.next_actions ?? []).find((n) => n.type === "compact_advised"), undefined);
  });
});
