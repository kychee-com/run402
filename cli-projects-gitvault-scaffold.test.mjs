/**
 * `run402 projects provision` is the provisioning PRIMITIVE and has no local
 * side effects (first-deploy-agent-dx): it never inspects or mutates git.
 * Historically it folded in the gitvault remote scaffold
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

describe("projects provision — never touches git (first-deploy-agent-dx)", () => {
  let repoDir;
  before(async () => {
    repoDir = join(scratch, "repo");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-q", "-b", "main", "."]);
    git(repoDir, ["remote", "add", "origin", "https://github.com/kychee-com/example.git"]);
    process.env.RUN402_CONFIG_DIR = join(scratch, "repo-cfg");
    process.chdir(repoDir);
    await createLocalAllowance();
  });

  it("provisions and stops: no scaffoldRemote call, no gitvault keys, remotes byte-identical", async () => {
    const before = git(repoDir, ["remote", "-v"]);
    const payload = await ok("provision", []);
    assert.equal(payload.project_id, PROJECT);
    assert.ok(calls.find((c) => c.method === "projects.provision"), "provision must still call projects.provision");
    assert.equal(calls.find((c) => c.method === "gitvault.scaffoldRemote"), undefined, "provision never scaffolds a remote");
    assert.equal(git(repoDir, ["remote", "-v"]), before, "git remotes are untouched");
    for (const key of ["gitvault", "gitvault_skipped", "gitvault_error"]) {
      assert.equal(key in payload, false, `provision output carries no ${key} key`);
    }
  });
});

describe("projects provision — outside any repository", () => {
  let dir;
  before(async () => {
    dir = join(scratch, "plain");
    mkdirSync(dir, { recursive: true });
    process.env.RUN402_CONFIG_DIR = join(scratch, "plain-cfg");
    process.chdir(dir);
    await createLocalAllowance();
  });

  it("never git-inits the directory", async () => {
    const payload = await ok("provision", []);
    assert.equal(payload.project_id, PROJECT);
    assert.throws(() => git(dir, ["rev-parse", "--is-inside-work-tree"]), "provision must not create a repository");
    assert.equal(calls.find((c) => c.method === "gitvault.scaffoldRemote"), undefined);
  });
});
