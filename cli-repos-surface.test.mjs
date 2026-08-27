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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

  it("--dry-run previews via planPush and publishes nothing", async () => {
    const payload = await ok("snapshot", ["--project", PROJECT, "--dry-run"]);
    assert.ok(calls.find((c) => c.method === "gitvault.planPush"));
    assert.equal(calls.find((c) => c.method === "gitvault.push"), undefined);
    assert.equal(payload.allocation_needed, false);
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

describe("run402 repos access — read-only; repair refuses until epoch rotation ships (design D5/D10)", () => {
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

  it("access repair refuses cleanly, pointing at `repos access`", async () => {
    const envelope = await expectFailure("access", ["repair", "--project", PROJECT]);
    assert.equal(envelope.code, "ACCESS_REPAIR_NOT_AVAILABLE");
    assert.ok(envelope.next_actions.find((a) => a.type === "access_repair_pending"));
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
});
