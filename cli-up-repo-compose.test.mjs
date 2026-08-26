/**
 * `run402 up` composes git init + provision + remote scaffold + first push
 * (+ deploy unless --repo-only) — repo-first-onramp D4, task 2.4.
 *
 * The SDK is mocked; what is under test is the CLI-level composition: that a
 * plain local-directory apply attaches a best-effort `result.repo` after a
 * successful deploy, that `--repo-only` skips deploy entirely and does its
 * own minimal provision+scaffold+push, and that a git-URL source never
 * touches local git state at all. Every test chdirs into an ISOLATED scratch
 * directory — these commands touch real git (git init / git remote add), so
 * they must never run against the developer's own checkout.
 */

import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalLog = console.log;
const originalExit = process.exit;
const originalCwd = process.cwd();
const originalConfigDir = process.env.RUN402_CONFIG_DIR;

const PROJECT = "prj_up_compose";
const ORG = "57035b1e-ec41-4ce6-a7a5-a5b2560efdd7";

let stdout = [];
let calls = [];
let impl = {};

mock.module("./cli/lib/sdk.mjs", {
  namedExports: {
    getSdk: () => ({
      up: async (input, options) => {
        calls.push({ method: "up", input, options });
        return (impl.up ?? (async () => ({
          action: "up",
          mode: "apply",
          dry_run: false,
          result: { project_id: PROJECT, deploy: { release_id: "rel_1", urls: { site: "https://example.run402.com" } } },
        })))(input, options);
      },
      projects: {
        provision: async (input) => {
          calls.push({ method: "projects.provision", input });
          return (impl.provision ?? (async () => ({ project_id: PROJECT, anon_key: "a", service_key: "s", schema_slot: "s1" })))(input);
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
        push: async (input) => {
          calls.push({ method: "gitvault.push", input });
          return (impl.push ?? (async () => ({
            generation: "0000000000000000", form: "wal", head_sha256: "abc",
            snapshot: {}, gitvault_commit: "x".repeat(40), gitvault_commit_line: "gitvault_commit " + "x".repeat(40),
          })))(input);
        },
      },
    }),
  },
});

const { run } = await import("./cli/lib/up.mjs");

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

async function runJson(args) {
  captureStart();
  try {
    await run(args);
  } finally {
    captureStop();
  }
  return JSON.parse(stdout.join("\n"));
}

let scratch;
before(() => {
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  scratch = mkdtempSync(join(tmpdir(), "run402-up-compose-"));
});
after(() => {
  process.chdir(originalCwd);
  console.log = originalLog;
  process.exit = originalExit;
  if (originalConfigDir === undefined) delete process.env.RUN402_CONFIG_DIR;
  else process.env.RUN402_CONFIG_DIR = originalConfigDir;
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  calls = [];
  impl = {};
});

describe("run402 up — default apply composes the repo as a best-effort addition", () => {
  let dir;
  before(() => {
    dir = join(scratch, "fresh-app");
    mkdirSync(dir, { recursive: true });
    process.env.RUN402_CONFIG_DIR = join(scratch, "fresh-app-cfg");
    process.chdir(dir);
  });

  it("git-inits a fresh directory, then provisions, scaffolds, and pushes after a successful deploy", async () => {
    const payload = await runJson(["-y", "--json"]);
    assert.equal(payload.result.project_id, PROJECT);
    // git init happened — this directory is now a repository.
    assert.equal(git(dir, ["rev-parse", "--is-inside-work-tree"]), "true");
    // kychee-com/run402 second dogfood: `up`'s own git-init path must yield
    // branch `main`, not git's own hardcoded default — the docs teach
    // `git push origin main`, and a first push of any other branch leaves
    // HEAD naming a ref that does not exist yet.
    assert.equal(git(dir, ["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert.ok(calls.find((c) => c.method === "up"), "the existing deploy flow still ran unchanged");
    assert.ok(calls.find((c) => c.method === "gitvault.scaffoldRemote"), "the remote was scaffolded after deploy");
    assert.ok(calls.find((c) => c.method === "gitvault.push"), "the first push ran after deploy");
    assert.equal(payload.result.repo.gitvault.name, "origin");
    assert.ok(payload.result.repo.first_push, "first_push is attached to the result");
    // gitvault.scaffoldRemote is mocked (returns canned data, touches no real
    // git config); what is under test is that the CLI called it with the
    // right target and reported its answer, not the SDK's own git plumbing
    // (that is sdk/src/namespaces/gitvault-scaffold-remote.test.ts's job).
    const scaffoldCall = calls.find((c) => c.method === "gitvault.scaffoldRemote");
    assert.equal(scaffoldCall.input.org_id, ORG);
    assert.equal(scaffoldCall.input.project_id, PROJECT);
  });

  it("a second run against the now-existing repository does not re-run git init", async () => {
    await runJson(["-y", "--json"]);
    const scaffoldCall = calls.find((c) => c.method === "gitvault.scaffoldRemote");
    assert.ok(scaffoldCall);
  });

  it("a scaffold/push failure never fails an otherwise-successful deploy", async () => {
    impl.scaffoldRemote = async () => { throw new Error("network unreachable"); };
    const payload = await runJson(["-y", "--json"]);
    assert.equal(payload.result.project_id, PROJECT, "the deploy result is unaffected");
    assert.equal(payload.result.repo.gitvault, null);
    assert.match(payload.result.repo.gitvault_error.message, /network unreachable/);
  });
});

describe("run402 up — a remote git-URL source never touches local git state", () => {
  let dir;
  before(() => {
    dir = join(scratch, "url-source-cwd");
    mkdirSync(dir, { recursive: true });
    process.env.RUN402_CONFIG_DIR = join(scratch, "url-source-cfg");
    process.chdir(dir);
  });

  it("skips git init and the repo compose entirely for a repo URL source", async () => {
    await runJson(["https://github.com/kychee-com/example", "-y", "--json"]);
    assert.equal(calls.find((c) => c.method === "gitvault.scaffoldRemote"), undefined);
    assert.equal(calls.find((c) => c.method === "gitvault.push"), undefined);
    assert.throws(() => git(dir, ["rev-parse", "--is-inside-work-tree"]), "cwd must not have been git-init'd");
  });
});

describe("run402 up --repo-only — vault-only, zero deploy ceremony", () => {
  let dir;
  before(async () => {
    dir = join(scratch, "repo-only-app");
    mkdirSync(dir, { recursive: true });
    process.env.RUN402_CONFIG_DIR = join(scratch, "repo-only-cfg");
    process.chdir(dir);
    // --repo-only calls projects.provision directly (bypassing sdk.up()'s
    // own auto-prerequisite flow), so it needs a local allowance to exist —
    // written directly rather than through `allowance create`, which would
    // call this same mocked SDK's (absent) `allowance.create`.
    const { saveAllowance } = await import("./cli/lib/config.mjs");
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    saveAllowance({ address: account.address, privateKey, created: new Date().toISOString(), funded: false, rail: "x402" });
  });

  it("provisions, scaffolds, and pushes, but never calls the deploy flow", async () => {
    const payload = await runJson(["--repo-only", "-y", "--json"]);
    assert.equal(payload.mode, "repo-only");
    assert.equal(payload.result.project_id, PROJECT);
    assert.equal(calls.find((c) => c.method === "up"), undefined, "--repo-only must never invoke the deploy action");
    assert.ok(calls.find((c) => c.method === "projects.provision"));
    assert.ok(calls.find((c) => c.method === "gitvault.scaffoldRemote"));
    assert.ok(calls.find((c) => c.method === "gitvault.push"));
    assert.equal(git(dir, ["rev-parse", "--is-inside-work-tree"]), "true", "git init ran for --repo-only too");
  });

  it("rejects --repo-only combined with --check", async () => {
    let threw = null;
    captureStart();
    try {
      await run(["--repo-only", "--check"]);
    } catch (err) {
      threw = err;
    } finally {
      captureStop();
    }
    assert.equal(threw?.message, "process.exit(1)");
  });
});
