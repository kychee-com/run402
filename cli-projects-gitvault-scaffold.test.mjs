/**
 * `run402 projects provision` folds in the gitvault remote scaffold
 * (repo-first-onramp D4, task 2.4): provisioning inside a git repository
 * scaffolds the run402 remote automatically, reporting through the exact
 * same `gitvault` / `gitvault_skipped` / `gitvault_error` summary keys
 * `run402 init`'s own scaffold uses — a pure Anticipatory fold, since
 * provision already knows the project and (usually) the org.
 *
 * The SDK is mocked: what is under test is that provision calls the
 * scaffold with the resolved project/org, reports the SDK's answer
 * faithfully, and never fails the provision itself when the scaffold can't
 * complete. Every test chdirs into an ISOLATED scratch directory — this
 * command touches real git state (git init / git remote add), so it must
 * never run against the developer's own checkout (the same isolation
 * discipline cli-e2e.test.mjs documents for `run402 init`).
 */

import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalLog = console.log;
const originalCwd = process.cwd();
const originalConfigDir = process.env.RUN402_CONFIG_DIR;

const PROJECT = "prj_fresh";
const ORG = "57035b1e-ec41-4ce6-a7a5-a5b2560efdd7";

let stdout = [];
let calls = [];
let impl = {};

mock.module("./cli/lib/sdk.mjs", {
  namedExports: {
    getSdk: () => ({
      projects: {
        provision: async (input) => {
          calls.push({ method: "projects.provision", input });
          return { project_id: PROJECT, anon_key: "anon", service_key: "svc", schema_slot: "s1" };
        },
        list: async () => {
          calls.push({ method: "projects.list" });
          return (impl.projectsList ?? (async () => ({ projects: [{ id: PROJECT, org_id: ORG }] })))();
        },
      },
      gitvault: {
        scaffoldRemote: async (input) => {
          calls.push({ method: "gitvault.scaffoldRemote", input });
          return (impl.scaffoldRemote ?? (async () => ({
            name: "origin", url: `run402::${input.org_id}/${input.project_id}`,
            created_repository: false, already_present: false, existing_url: null,
            reason: "no existing 'origin' remote — claimed it",
          })))(input);
        },
      },
    }),
  },
});

const { run } = await import("./cli/lib/projects.mjs");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function captureStart() {
  stdout = [];
  console.log = (...args) => stdout.push(args.map(String).join(" "));
}
function captureStop() {
  console.log = originalLog;
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

let scratch;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "run402-provision-scaffold-"));
});
after(() => {
  process.chdir(originalCwd);
  console.log = originalLog;
  if (originalConfigDir === undefined) delete process.env.RUN402_CONFIG_DIR;
  else process.env.RUN402_CONFIG_DIR = originalConfigDir;
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  calls = [];
  impl = {};
});

/**
 * `provision` requires a local agent allowance to exist before it will run
 * at all. Written directly (mirroring what `run402 init` does locally) —
 * going through `allowance create` would call the MOCKED SDK's
 * `allowance.create`, which this file has no reason to fake.
 */
async function createLocalAllowance() {
  const { saveAllowance } = await import("./cli/lib/config.mjs");
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  saveAllowance({ address: account.address, privateKey, created: new Date().toISOString(), funded: false, rail: "x402" });
}

describe("projects provision — inside a git repository", () => {
  let repoDir;
  before(async () => {
    repoDir = join(scratch, "repo");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-q", "-b", "main", "."]);
    process.env.RUN402_CONFIG_DIR = join(scratch, "repo-cfg");
    process.chdir(repoDir);
    await createLocalAllowance();
  });

  it("scaffolds the remote with the project it just provisioned and the resolved org", async () => {
    const payload = await ok("provision", []);
    assert.equal(payload.project_id, PROJECT);
    const provisionCall = calls.find((c) => c.method === "projects.provision");
    assert.ok(provisionCall, "provision must still call projects.provision");
    const listCall = calls.find((c) => c.method === "projects.list");
    assert.ok(listCall, "org resolution runs the same way gitvault init does it");
    const scaffoldCall = calls.find((c) => c.method === "gitvault.scaffoldRemote");
    assert.ok(scaffoldCall, `gitvault.scaffoldRemote was not reached; calls=${JSON.stringify(calls)}`);
    assert.equal(scaffoldCall.input.project_id, PROJECT);
    assert.equal(scaffoldCall.input.org_id, ORG);
    assert.equal(payload.gitvault.name, "origin");
    assert.equal(payload.gitvault.allocated, false, "provision never allocates a vault — only the remote is scaffolded");
  });

  it("uses an explicit --org without a project lookup, same as gitvault init", async () => {
    const payload = await ok("provision", ["--org", "org_explicit"]);
    assert.equal(calls.find((c) => c.method === "projects.list"), undefined, "an explicit --org must not trigger a project listing");
    assert.equal(calls.find((c) => c.method === "gitvault.scaffoldRemote").input.org_id, "org_explicit");
    assert.equal(payload.gitvault.name, "origin");
  });

  it("is non-fatal when the scaffold itself fails — provision still succeeds", async () => {
    impl.scaffoldRemote = async () => { throw Object.assign(new Error("network unreachable"), { code: "NETWORK_ERROR" }); };
    const payload = await ok("provision", []);
    assert.equal(payload.project_id, PROJECT, "the provision result is unaffected by a scaffold failure");
    assert.equal(payload.gitvault, null);
    assert.equal(payload.gitvault_error.code, "NETWORK_ERROR");
    assert.match(payload.gitvault_error.message, /network unreachable/);
  });

  it("reports gitvault_skipped, not an error, when the owning org cannot be resolved", async () => {
    impl.projectsList = async () => ({ projects: [] });
    const payload = await ok("provision", []);
    assert.equal(payload.project_id, PROJECT);
    assert.equal(payload.gitvault, null);
    assert.match(payload.gitvault_skipped, /could not resolve the owning org/);
    assert.equal(calls.find((c) => c.method === "gitvault.scaffoldRemote"), undefined, "no remote is added without a resolved org");
  });
});

describe("projects provision — outside a git repository", () => {
  before(async () => {
    const notARepo = join(scratch, "not-a-repo");
    mkdirSync(notARepo, { recursive: true });
    process.env.RUN402_CONFIG_DIR = join(scratch, "not-a-repo-cfg");
    process.chdir(notARepo);
    await createLocalAllowance();
  });

  it("reports gitvault_skipped and never runs git init on its own — provision has no --git-remote opt-in", async () => {
    const payload = await ok("provision", []);
    assert.equal(payload.project_id, PROJECT);
    assert.equal(payload.gitvault, null);
    assert.match(payload.gitvault_skipped, /not a git repository/);
    assert.equal(calls.find((c) => c.method === "gitvault.scaffoldRemote"), undefined);
  });
});
