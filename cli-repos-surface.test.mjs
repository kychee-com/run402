/**
 * `run402 repos` — vault-only porcelain (repo-first-onramp D8, task 2.6).
 *
 * The SDK is mocked: what is under test is the CLI surface — that `create`
 * composes provision + gitvault.init with zero deploy ceremony, `list`
 * cross-references live projects against their live vault status and keeps
 * only vault-bearing ones, and `delete` refuses a vault holding generations
 * unless `--force` is passed. `create` touches REAL git state (it may
 * `git init` cwd), so every test runs from an isolated scratch directory —
 * the same isolation discipline `cli-projects-gitvault-scaffold.test.mjs`
 * documents for `projects provision`.
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

  it("provisions, allocates the vault via gitvault.init (NOT the lazy path), and scaffolds the remote", async () => {
    const payload = await ok("create", ["my-notes", "--org", ORG]);
    const provisionCall = calls.find((c) => c.method === "projects.provision");
    assert.ok(provisionCall, "must call projects.provision");
    assert.equal(provisionCall.input.name, "my-notes");
    assert.equal(provisionCall.input.orgId, ORG);
    const initCall = calls.find((c) => c.method === "gitvault.init");
    assert.ok(initCall, "must call gitvault.init directly — allocation is NOT deferred to lazy first-push for `repos create`");
    assert.equal(initCall.input.org_id, ORG);
    assert.equal(initCall.input.project_id, PROJECT);
    assert.equal(payload.project_id, PROJECT);
    assert.equal(payload.repo_id, REPO);
    assert.equal(payload.deployed, false);
    assert.equal(payload.remote.name, "origin");
  });

  it("never touches deploy — no plan, no release, no apply call of any kind", async () => {
    await ok("create", ["another-notes", "--org", ORG]);
    assert.equal(calls.find((c) => c.method?.startsWith("apply")), undefined);
    assert.equal(calls.find((c) => c.method?.includes("deploy")), undefined);
  });

  it("prints the recovery receipt, keystore location, and the terminal-loss statement to stderr", async () => {
    captureStart();
    try {
      await run("create", ["with-receipt", "--org", ORG]);
    } finally {
      captureStop();
    }
    const joined = stderr.join("\n");
    assert.match(joined, /TERMINAL LOSS STATEMENT/);
    assert.match(joined, /keystore:/);
    assert.match(joined, /nothing was deployed/);
  });

  it("reports a deduplicated allocation without implying a fresh one", async () => {
    impl.gitvaultInit = async (input) => ({
      repo_id: REPO, project_id: input.project_id, recovery_receipt: {}, genesis_sha256: "cafe",
      remote: null, deduplicated: true, terminal_loss_statement: "TERMINAL LOSS STATEMENT",
    });
    captureStart();
    try {
      await run("create", ["dedup-notes", "--org", ORG]);
    } finally {
      captureStop();
    }
    assert.match(stderr.join("\n"), /already existed — nothing was re-allocated/);
  });

  it("resolves the owning org from the freshly provisioned project when --org is omitted", async () => {
    const payload = await ok("create", ["cold-start-notes"]);
    const listCall = calls.find((c) => c.method === "projects.list");
    assert.ok(listCall, "org resolution falls back to projects.list the same way gitvault init's does");
    const initCall = calls.find((c) => c.method === "gitvault.init");
    assert.equal(initCall.input.org_id, ORG);
    assert.equal(payload.repo_id, REPO);
  });

  it("claims the address-form repo name and prints run402::<slug>/<name> when the owning org has a slug (design D6)", async () => {
    impl.orgGet = async (id) => ({ org_id: id, display_name: null, slug: "acme", tier: "prototype", lease_started_at: null, lease_expires_at: null });
    const payload = await ok("create", ["My Notes!", "--org", ORG]);
    const setNameCall = calls.find((c) => c.method === "projects.setRepoName");
    assert.ok(setNameCall, "must claim the address-form repo name when the org has a slug");
    assert.equal(setNameCall.id, PROJECT);
    assert.equal(setNameCall.repoName, "my-notes", "slugified from the free-text display name");
    assert.equal(payload.address, "run402::acme/my-notes");
  });

  it("never fails create when the repo-name claim errors (best-effort, non-fatal)", async () => {
    impl.orgGet = async (id) => ({ org_id: id, display_name: null, slug: "acme", tier: "prototype", lease_started_at: null, lease_expires_at: null });
    impl.setRepoName = async () => { throw new Error("REPO_NAME_TAKEN"); };
    const payload = await ok("create", ["taken-name", "--org", ORG]);
    assert.equal(payload.address, null);
    assert.equal(payload.project_id, PROJECT, "create itself still succeeded");
  });

  it("no address, but the org HAS a slug: next_actions points at 'repos name', not 'org slug' (kychee-com/run402#560)", async () => {
    impl.orgGet = async (id) => ({ org_id: id, display_name: null, slug: "acme", tier: "prototype", lease_started_at: null, lease_expires_at: null });
    impl.setRepoName = async () => { throw new Error("REPO_NAME_TAKEN"); };
    const payload = await ok("create", ["taken-name-2", "--org", ORG]);
    assert.equal(payload.address, null);
    assert.equal(payload.next_actions.length, 1);
    assert.equal(payload.next_actions[0].type, "claim_repo_name");
    assert.match(payload.next_actions[0].command, /^run402 repos name <name> --project /);
    assert.match(payload.next_actions[0].command, new RegExp(PROJECT));
    assert.doesNotMatch(stderr.join("\n"), /org slug/, "the org already has one — do not point there");
    assert.match(stderr.join("\n"), /no address claimed — run 'run402 repos name/);
  });

  it("claims no address when the owning org has no slug, and points at claiming one (kychee-com/run402#560)", async () => {
    const payload = await ok("create", ["no-slug-org", "--org", ORG]);
    assert.equal(calls.find((c) => c.method === "projects.setRepoName"), undefined);
    assert.equal(payload.address, null);
    assert.equal(payload.next_actions.length, 1);
    assert.equal(payload.next_actions[0].type, "claim_org_slug");
    assert.equal(payload.next_actions[0].command, "run402 org slug <slug>");
    assert.ok(payload.next_actions[0].why, "must say why");
    assert.match(
      stderr.join("\n"),
      /no named address yet — claim an org slug \(run402 org slug <slug>, one-time \$1\) to get run402::<slug>\/<name> addresses/,
    );
  });

  it("next_actions is empty when an address was actually claimed", async () => {
    impl.orgGet = async (id) => ({ org_id: id, display_name: null, slug: "acme", tier: "prototype", lease_started_at: null, lease_expires_at: null });
    const payload = await ok("create", ["clean-notes", "--org", ORG]);
    assert.equal(payload.address, "run402::acme/clean-notes");
    assert.deepEqual(payload.next_actions, []);
  });

  it("refuses an empty or over-long name before ever calling the SDK", async () => {
    const envelope = await expectFailure("create", [""]);
    assert.equal(envelope.code, "BAD_PROJECT_NAME");
    assert.equal(calls.length, 0);
  });

  it("requires exactly one positional name", async () => {
    const envelope = await expectFailure("create", []);
    assert.equal(envelope.code, "BAD_USAGE");
  });
});

describe("run402 repos list — the org's vault-bearing projects", () => {
  it("keeps only projects with an allocated vault", async () => {
    impl.projectsList = async () => ({ projects: [{ id: "prj_a", name: "a", org_id: ORG }, { id: "prj_b", name: "b", org_id: ORG }] });
    impl.gitvaultStatus = async (input) =>
      input.project_id === "prj_a"
        ? vaultStatus({ repo_id: "src_a", vault: vaultRecord({ repo_id: "src_a", project_id: "prj_a" }) })
        : vaultStatus({ vault: null });
    const payload = await ok("list", ["--org", ORG]);
    assert.equal(payload.repos.length, 1);
    assert.equal(payload.repos[0].project_id, "prj_a");
    assert.equal(payload.repos[0].repo_id, "src_a");
  });

  it("skips a project whose vault status cannot be read, rather than failing the whole listing", async () => {
    impl.projectsList = async () => ({ projects: [{ id: "prj_a", name: "a", org_id: ORG }, { id: "prj_b", name: "b", org_id: ORG }] });
    impl.gitvaultStatus = async (input) => {
      if (input.project_id === "prj_b") throw new Error("gateway unreachable for prj_b");
      return vaultStatus({ vault: vaultRecord({ project_id: "prj_a" }) });
    };
    const payload = await ok("list", ["--org", ORG]);
    assert.equal(payload.repos.length, 1);
    assert.equal(payload.repos[0].project_id, "prj_a");
  });

  it("carries generation count, source bytes, and policy per repo", async () => {
    impl.projectsList = async () => ({ projects: [{ id: PROJECT, name: "fresh", org_id: ORG }] });
    impl.gitvaultStatus = async () => vaultStatus({ vault: vaultRecord({ admitted_generations: "7", storage: { source_bytes: "4096", open_session_reserved_bytes: "0", objects: {} }, gitvault_policy: "required" }) });
    const payload = await ok("list", ["--org", ORG]);
    assert.equal(payload.repos[0].admitted_generations, 7);
    assert.equal(payload.repos[0].source_bytes, 4096);
    assert.equal(payload.repos[0].gitvault_policy, "required");
  });
});

describe("run402 repos delete — refuses while the vault holds generations", () => {
  it("refuses without --force when the vault holds admitted generations, naming what would be lost", async () => {
    impl.gitvaultStatus = async () => vaultStatus({ vault: vaultRecord({ admitted_generations: "12", storage: { source_bytes: "999999", open_session_reserved_bytes: "0", objects: {} } }) });
    const envelope = await expectFailure("delete", [PROJECT]);
    assert.equal(envelope.code, "CONFIRMATION_REQUIRED");
    assert.match(envelope.message, /12 admitted generation/);
    assert.match(envelope.message, /999999 bytes/);
    assert.equal(envelope.details.admitted_generations, 12);
    assert.equal(calls.find((c) => c.method === "projects.delete"), undefined, "must not delete without --force");
  });

  it("proceeds with --force, deleting the project and reporting what was lost", async () => {
    impl.gitvaultStatus = async () => vaultStatus({ vault: vaultRecord({ admitted_generations: "12" }) });
    const payload = await ok("delete", [PROJECT, "--force"]);
    assert.equal(payload.deleted, true);
    assert.equal(payload.vault.admitted_generations, 12);
    assert.ok(calls.find((c) => c.method === "projects.delete" && c.id === PROJECT));
  });

  it("proceeds WITHOUT --force when the vault holds zero generations (allocated but empty)", async () => {
    impl.gitvaultStatus = async () => vaultStatus({ vault: vaultRecord({ admitted_generations: "0" }) });
    const payload = await ok("delete", [PROJECT]);
    assert.equal(payload.deleted, true);
  });

  it("proceeds WITHOUT --force when there is no vault at all", async () => {
    impl.gitvaultStatus = async () => vaultStatus({ vault: null });
    const payload = await ok("delete", [PROJECT]);
    assert.equal(payload.deleted, true);
    assert.equal(payload.vault, null);
  });

  it("rejects a bare non-prj_ positional rather than silently targeting the active project", async () => {
    const envelope = await expectFailure("delete", ["not-a-project-id"]);
    assert.equal(envelope.code, "BAD_PROJECT_ID");
  });
});

describe("run402 repos name — the explicit address-form claim (design D6, task 4.2)", () => {
  it("claims the name for --project and prints the run402::<slug>/<name> address when the org has one", async () => {
    impl.orgGet = async (id) => ({ org_id: id, display_name: null, slug: "acme", tier: "prototype", lease_started_at: null, lease_expires_at: null });
    const payload = await ok("name", ["my-notes", "--project", PROJECT]);
    const setNameCall = calls.find((c) => c.method === "projects.setRepoName");
    assert.ok(setNameCall);
    assert.equal(setNameCall.id, PROJECT);
    assert.equal(setNameCall.repoName, "my-notes");
    assert.equal(payload.address, "run402::acme/my-notes");
    assert.equal(payload.repo_name, "my-notes");
  });

  it("reports address: null (with guidance) when the owning org has no slug yet", async () => {
    const payload = await ok("name", ["my-notes", "--project", PROJECT]);
    assert.equal(payload.address, null);
  });

  it("propagates a REPO_NAME_TAKEN refusal from the SDK", async () => {
    impl.setRepoName = async () => { const e = new Error("REPO_NAME_TAKEN"); e.code = "REPO_NAME_TAKEN"; throw e; };
    await expectFailure("name", ["taken", "--project", PROJECT]);
  });

  it("requires exactly one positional name", async () => {
    const envelope = await expectFailure("name", ["--project", PROJECT]);
    assert.equal(envelope.code, "BAD_USAGE");
  });
});
