/**
 * `run402 gitvault` — the verbs a user needs to START and to UN-BLOCK.
 *
 * THE DEFECTS (gitvault dogfood #1, finding A). The published CLI exposed
 * `status · push · compact · prune · verify` and nothing else:
 *
 *   - NO verb allocated a vault. `gitvault status` told you to run
 *     `run402 init`, which by design does not allocate; `gitvault push` and
 *     `git push run402` both 404'd and handed you a raw
 *     `POST /gitvault/v1/vaults`. The only working path was the vendored SDK.
 *   - NO verb un-gated one. The gateway's own 409 names
 *     `run402 gitvault policy grandfathered --reason <why>` as the way out of
 *     a blocked deploy; running it returned UNKNOWN_SUBCOMMAND. A user could
 *     allocate themselves into an undeployable project with no way back.
 *   - `run402 init` resolved its project with `getActiveProjectId()` alone, so
 *     with `RUN402_PROJECT_ID` exported it did nothing at all, silently, and
 *     said nothing about `run402 projects use` being a prerequisite.
 *
 * The SDK is mocked: what is under test is the CLI surface — that the verbs
 * exist, validate their arguments, and call the SDK method they claim to.
 */

import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalCwd = process.cwd();
const originalConfigDir = process.env.RUN402_CONFIG_DIR;
const originalProjectId = process.env.RUN402_PROJECT_ID;
const originalNoUpdateCheck = process.env.RUN402_NO_UPDATE_CHECK;

const PROJECT = "prj_1777547828162_1049";
const ORG = "57035b1e-ec41-4ce6-a7a5-a5b2560efdd7";
const REPO = "src_49bd64c263e83be776930478f609a317";

let stdout = [];
let stderr = [];
let calls = [];
/** Per-test overrides for the mocked SDK methods. */
let impl = {};

const KEYSTORE_ROOT = "/home/agent/.config/run402/gitvault";

/** A healthy allocated vault this machine can sign for. */
function vaultStatus(overrides = {}) {
  return {
    repo_id: REPO,
    project_id: PROJECT,
    vault: { repo_id: REPO, project_id: PROJECT, gitvault_policy: "required" },
    keystore: {
      present: true, identity_fingerprint: "vk_abc", can_sign: true, holds_repo_key: true,
      root: KEYSTORE_ROOT,
      paths: { identity: `${KEYSTORE_ROOT}/identity.json`, repos: `${KEYSTORE_ROOT}/repos`, receipts: `${KEYSTORE_ROOT}/receipts`, journal: `${KEYSTORE_ROOT}/journal`, audit_log: `${KEYSTORE_ROOT}/audit.log`, repo: null, recovery_receipt: null },
    },
    remote: null,
    refs: null,
    head_target: null,
    pins: { highest_authenticated: "0000000000000003", highest_materialized: "0000000000000003" },
    gitvault_policy: "required",
    pending_overrides: 0,
    terminal_loss_statement: "TERMINAL LOSS STATEMENT",
    terminal_loss_detail: "TERMINAL LOSS DETAIL",
    warnings: [],
    next_actions: [],
    ...overrides,
  };
}

mock.module("./cli/lib/sdk.mjs", {
  namedExports: {
    getSdk: () => ({
      projects: {
        list: async () => {
          calls.push({ method: "projects.list" });
          return { projects: [{ id: PROJECT, org_id: ORG }] };
        },
      },
      // Doctor's other checks, stubbed so the gitvault check is what is under
      // test rather than the whole report.
      service: { status: async () => ({ ok: true }) },
      tier: { status: async () => ({ tier: "prototype", active: true, organization_lifecycle_state: "active" }) },
      admin: { getOperatorStatus: async () => ({ operator_contact: { email_status: "verified", passkey_status: "verified" }, runtime: { stale_function_count: 0 } }) },
      gitvault: {
        status: async (input) => {
          calls.push({ method: "gitvault.status", input });
          return (impl.status ?? (async () => vaultStatus()))(input);
        },
        init: async (input) => {
          calls.push({ method: "gitvault.init", input });
          return (impl.init ?? (async () => ({
            repo_id: REPO,
            project_id: PROJECT,
            recovery_receipt: { format: "r402s/v0", object_kind: "recovery_receipt" },
            genesis_sha256: "d1277eb4",
            remote: null,
            deduplicated: false,
            terminal_loss_statement: "TERMINAL LOSS STATEMENT",
          })))(input);
        },
        forProject: async (projectId) => {
          calls.push({ method: "gitvault.forProject", projectId });
          return { repo_id: REPO, project_id: projectId };
        },
        setPolicy: async (repoId, input) => {
          calls.push({ method: "gitvault.setPolicy", repoId, input });
          return { gitvault_policy: input.gitvault_policy, gitvault_policy_version: "2", changed: true, warnings: [] };
        },
        push: async (input) => {
          calls.push({ method: "gitvault.push", input });
          return (impl.push ?? (async () => ({
            generation: "0000000000000004",
            form: "wal",
            head_sha256: "e5f6",
            snapshot: { oid: "aaaa000011112222333344445555666677778888", head: { kind: "symref", ref: "refs/heads/main" } },
            gitvault_commit: "aaaa000011112222333344445555666677778888",
            gitvault_commit_line: "gitvault_commit aaaa000011112222333344445555666677778888",
          })))(input);
        },
        // kychee-com/run402#565 — the dry-run companion `snapshot --dry-run`
        // calls INSTEAD OF `push`. The CLI surface under test here is which
        // SDK method gets called with what, not the SDK's own real sizing
        // (that is pinned at the SDK level against GitvaultMemoryTransport).
        planPush: async (input) => {
          calls.push({ method: "gitvault.planPush", input });
          return (impl.planPush ?? (async () => ({
            allocation_needed: false,
            base_generation: "0000000000000003",
            would_admit_generation: "0000000000000004",
            would_admit_generation_decimal: "4",
            form: "wal",
            refs: { "refs/run402/deploys/latest": "aaaa000011112222333344445555666677778888" },
            head_target: { kind: "symref", ref: "refs/heads/main" },
            objects: [{ object_kind: "ref_state", size_bytes: "512" }, { object_kind: "retention_roots", size_bytes: "128" }, { object_kind: "wal_pack", size_bytes: "2048" }],
            object_count: 3,
            encrypted_bytes: "2688",
            raw_bytes: "2000",
            snapshot: { oid: "aaaa000011112222333344445555666677778888", head: { kind: "symref", ref: "refs/heads/main" } },
            gitvault_commit: "aaaa000011112222333344445555666677778888",
            gitvault_commit_line: "gitvault_commit aaaa000011112222333344445555666677778888",
          })))(input);
        },
      },
    }),
  },
});

const { run } = await import("./cli/lib/gitvault.mjs");
const { resolveScaffoldProject } = await import("./cli/lib/init.mjs");

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

/** Run a subcommand expecting success; returns the parsed JSON payload. */
async function ok(sub, args = []) {
  captureStart();
  try {
    await run(sub, args);
  } finally {
    captureStop();
  }
  return JSON.parse(stdout.join("\n"));
}

/** Run a subcommand expecting `fail()`; returns the error envelope. */
async function expectFailure(sub, args = []) {
  let threw = null;
  captureStart();
  try {
    await run(sub, args);
  } catch (err) {
    threw = err;
  } finally {
    captureStop();
  }
  assert.equal(threw?.message, "process.exit(1)", `expected a failure exit; stdout=${stdout.join("\n")} stderr=${stderr.join("\n")}`);
  const line = stderr.find((s) => s.trim().startsWith("{"));
  assert.ok(line, `expected a JSON error envelope on stderr, got: ${stderr.join("\n")}`);
  return JSON.parse(line);
}

let scratch;

before(() => {
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  scratch = mkdtempSync(join(tmpdir(), "run402-gv-surface-"));
  process.env.RUN402_CONFIG_DIR = join(scratch, "cfg");
  process.env.RUN402_PROJECT_ID = PROJECT;
  // `run402 doctor`'s cli_update check now self-refreshes a missing/expired
  // cache automatically (kychee-com/run402#561) — this file's `getSdk()` is
  // mocked, but `doctorUpdateCheck` is not reached through it and would
  // otherwise hit the REAL npm registry with the real `globalThis.fetch` on
  // every scratch-dir doctor call here (none of this file's assertions read
  // `cli_update` at all, so there is nothing to lose by opting out).
  process.env.RUN402_NO_UPDATE_CHECK = "1";
  // Not a git repository: `gitvault init` must allocate anyway and say the
  // remote was skipped, and no test here may touch the developer's checkout.
  process.chdir(scratch);
});

after(() => {
  process.chdir(originalCwd);
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  if (originalConfigDir === undefined) delete process.env.RUN402_CONFIG_DIR;
  else process.env.RUN402_CONFIG_DIR = originalConfigDir;
  if (originalProjectId === undefined) delete process.env.RUN402_PROJECT_ID;
  else process.env.RUN402_PROJECT_ID = originalProjectId;
  if (originalNoUpdateCheck === undefined) delete process.env.RUN402_NO_UPDATE_CHECK;
  else process.env.RUN402_NO_UPDATE_CHECK = originalNoUpdateCheck;
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  impl = {};
});

describe("run402 gitvault init — the verb that allocates", () => {
  it("allocates through gitvault.init with the project's resolved org", async () => {
    const payload = await ok("init", []);
    const call = calls.find((c) => c.method === "gitvault.init");
    assert.ok(call, `gitvault init did not reach the SDK; calls=${JSON.stringify(calls)}`);
    assert.equal(call.input.org_id, ORG);
    assert.equal(call.input.project_id, PROJECT);
    assert.equal(payload.repo_id, REPO);
  });

  it("outside a repository it allocates and says the remote was skipped, rather than 'git init'-ing your cwd", async () => {
    const payload = await ok("init", []);
    const call = calls.find((c) => c.method === "gitvault.init");
    assert.equal(call.input.scaffold_git, false, "must not scaffold git in a directory that is not a repository");
    assert.match(payload.remote_skipped, /not a git repository/);
    assert.match(payload.remote_skipped, /--git-remote/);
  });

  it("prints the keystore path with the terminal-loss statement", async () => {
    captureStart();
    try {
      await run("init", []);
    } finally {
      captureStop();
    }
    const joined = stderr.join("\n");
    assert.match(joined, /keystore: .*gitvault/, joined);
    assert.match(joined, /back this up/, joined);
    assert.match(joined, /TERMINAL LOSS STATEMENT/, joined);
  });

  it("reports an existing vault as deduplicated instead of implying a fresh allocation", async () => {
    impl.init = async () => ({
      repo_id: REPO, project_id: PROJECT, recovery_receipt: {}, genesis_sha256: "d1277eb4",
      remote: null, deduplicated: true, terminal_loss_statement: "TERMINAL LOSS STATEMENT",
    });
    captureStart();
    try {
      await run("init", []);
    } finally {
      captureStop();
    }
    assert.match(stderr.join("\n"), /already existed — nothing was re-allocated/);
  });

  it("refuses --git-remote together with --no-remote", async () => {
    const envelope = await expectFailure("init", ["--git-remote", "--no-remote"]);
    assert.equal(envelope.code, "BAD_USAGE");
  });

  it("takes an explicit --org without a project lookup", async () => {
    await ok("init", ["--org", "org_explicit"]);
    assert.equal(calls.find((c) => c.method === "projects.list"), undefined, "an explicit --org must not trigger a project listing");
    assert.equal(calls.find((c) => c.method === "gitvault.init").input.org_id, "org_explicit");
  });
});

describe("run402 gitvault snapshot — the capture lane, D2 lazy allocation (repo-first-onramp task 2.2)", () => {
  it("resolves the project's owning org exactly like init does, and threads it into gitvault.push", async () => {
    const payload = await ok("snapshot", []);
    const call = calls.find((c) => c.method === "gitvault.push");
    assert.ok(call, `gitvault snapshot did not reach the SDK; calls=${JSON.stringify(calls)}`);
    assert.equal(call.input.org_id, ORG);
    assert.equal(call.input.project_id, PROJECT);
    assert.equal(payload.generation, "0000000000000004");
  });

  it("prints the recovery receipt and keystore path the moment the SDK reports the vault was created", async () => {
    impl.push = async (input) => {
      // Exactly what a lazily-creating push() reports: onVaultCreated fires
      // before this resolves.
      await input.onVaultCreated?.({
        deduplicated: false,
        recovery_receipt: { format: "r402s/v0", object_kind: "recovery_receipt" },
        genesis_sha256: "cafe1234",
      });
      return { generation: "0000000000000000", form: "wal", head_sha256: "abc", snapshot: {}, gitvault_commit: "x", gitvault_commit_line: "gitvault_commit x" };
    };
    captureStart();
    try {
      await run("snapshot", []);
    } finally {
      captureStop();
    }
    const joined = stderr.join("\n");
    assert.match(joined, /vault allocated \(genesis cafe1234\)/, joined);
    assert.match(joined, /one-shot recovery receipt/, joined);
    assert.match(joined, /keystore: .*gitvault/, joined);
  });

  it("prints nothing extra about allocation for an ordinary snapshot against an already-existing vault", async () => {
    captureStart();
    try {
      await run("snapshot", []);
    } finally {
      captureStop();
    }
    assert.doesNotMatch(stderr.join("\n"), /vault allocated/);
  });

  it("--repo addresses the vault directly and skips org resolution entirely — nothing to create FROM", async () => {
    await ok("snapshot", ["--repo", REPO]);
    assert.equal(calls.find((c) => c.method === "projects.list"), undefined, "--repo alone must not trigger a project lookup");
    const call = calls.find((c) => c.method === "gitvault.push");
    assert.equal(call.input.org_id, undefined);
    assert.equal(call.input.repo_id, REPO);
  });

  it("still carries --message and --checkpoint through, unaffected by the org resolution", async () => {
    await ok("snapshot", ["--message", "wip", "--checkpoint"]);
    const call = calls.find((c) => c.method === "gitvault.push");
    assert.equal(call.input.snapshot.message, "wip");
    assert.equal(call.input.checkpoint, true);
  });

  // ─── --dry-run (kychee-com/run402#565) — a REAL preview, JSON on stdout ────
  describe("--dry-run", () => {
    it("calls gitvault.planPush INSTEAD of gitvault.push — nothing is published", async () => {
      const payload = await ok("snapshot", ["--dry-run"]);
      assert.equal(calls.find((c) => c.method === "gitvault.push"), undefined, "a dry run must never reach gitvault.push");
      const call = calls.find((c) => c.method === "gitvault.planPush");
      assert.ok(call, `gitvault snapshot --dry-run did not reach planPush; calls=${JSON.stringify(calls)}`);
      // The JSON report IS the payload — same stdout convention as every
      // other gitvault verb.
      assert.equal(payload.would_admit_generation, "0000000000000004");
      assert.equal(payload.would_admit_generation_decimal, "4");
      assert.equal(payload.object_count, 3);
      assert.equal(payload.encrypted_bytes, "2688");
    });

    it("skips org resolution entirely — a dry run never allocates, so it needs no org to allocate from", async () => {
      await ok("snapshot", ["--dry-run"]);
      const call = calls.find((c) => c.method === "gitvault.planPush");
      assert.equal(call.input.org_id, undefined, "planPush was called with an org_id it should never have needed to resolve");
      assert.equal(calls.find((c) => c.method === "projects.list"), undefined, "--dry-run must not trigger the org-resolving project lookup");
    });

    it("prints a stderr summary naming the generation, form, and object/byte counts", async () => {
      captureStart();
      try {
        await run("snapshot", ["--dry-run"]);
      } finally {
        captureStop();
      }
      const joined = stderr.join("\n");
      assert.match(joined, /dry-run/i, joined);
      assert.match(joined, /0000000000000004/, joined);
      assert.match(joined, /\bwal\b/, joined);
      assert.match(joined, /3 object/, joined);
      assert.match(joined, /2688 encrypted byte/, joined);
    });

    it("reports allocation_needed instead of a fake generation when there is no vault to preview against", async () => {
      impl.planPush = async () => ({
        allocation_needed: true,
        base_generation: null, would_admit_generation: null, would_admit_generation_decimal: null,
        form: null, refs: {}, head_target: { kind: "symref", ref: "refs/heads/main" }, objects: [], object_count: null,
        encrypted_bytes: null, raw_bytes: null,
        snapshot: { oid: "aaaa000011112222333344445555666677778888", head: { kind: "symref", ref: "refs/heads/main" } },
        gitvault_commit: "aaaa000011112222333344445555666677778888", gitvault_commit_line: "gitvault_commit aaaa000011112222333344445555666677778888",
      });
      const payload = await ok("snapshot", ["--dry-run"]);
      assert.equal(payload.allocation_needed, true);
      assert.equal(payload.would_admit_generation, null);
    });

    it("still carries --message and --checkpoint through to planPush", async () => {
      await ok("snapshot", ["--dry-run", "--message", "wip", "--checkpoint"]);
      const call = calls.find((c) => c.method === "gitvault.planPush");
      assert.equal(call.input.snapshot.message, "wip");
      assert.equal(call.input.checkpoint, true);
    });

    it("composes with --repo, same as an ordinary snapshot", async () => {
      await ok("snapshot", ["--dry-run", "--repo", REPO]);
      const call = calls.find((c) => c.method === "gitvault.planPush");
      assert.equal(call.input.repo_id, REPO);
    });
  });
});

describe("run402 gitvault push — D5 deprecation alias for `snapshot` (repo-first-onramp task 2.5)", () => {
  it("still publishes — a deprecation-warning alias is not a removal", async () => {
    const payload = await ok("push", []);
    const call = calls.find((c) => c.method === "gitvault.push");
    assert.ok(call, `gitvault push did not reach the SDK; calls=${JSON.stringify(calls)}`);
    assert.equal(payload.generation, "0000000000000004");
  });

  it("warns on stderr that it is deprecated and names the replacement, without touching stdout", async () => {
    captureStart();
    try {
      await run("push", []);
    } finally {
      captureStop();
    }
    assert.match(stderr.join("\n"), /`run402 gitvault push` is deprecated.*use `run402 gitvault snapshot`/);
    // stdout stays the JSON payload alone — the deprecation notice is a
    // human/agent-readable line, never mixed into the piped result.
    assert.doesNotThrow(() => JSON.parse(stdout.join("")));
  });
});

describe("run402 gitvault policy — the way out of a blocked deploy", () => {
  it("runs the exact command the gateway's 409 next_action names", async () => {
    // Verbatim from GITVAULT_CLIENT_UPGRADE_REQUIRED:
    //   run402 gitvault policy grandfathered --reason <why>
    const payload = await ok("policy", ["grandfathered", "--reason", "migrating CI to a vaulted client"]);
    const call = calls.find((c) => c.method === "gitvault.setPolicy");
    assert.ok(call, `policy did not reach the SDK; calls=${JSON.stringify(calls)}`);
    assert.equal(call.repoId, REPO);
    assert.deepEqual(call.input, { gitvault_policy: "grandfathered", reason: "migrating CI to a vaulted client" });
    assert.equal(payload.gitvault_policy, "grandfathered");
  });

  it("addresses the vault directly with --repo, skipping the project lookup", async () => {
    await ok("policy", ["required", "--repo", REPO]);
    assert.equal(calls.find((c) => c.method === "gitvault.forProject"), undefined);
    assert.equal(calls.find((c) => c.method === "gitvault.setPolicy").repoId, REPO);
  });

  it("returning to `required` needs no reason", async () => {
    await ok("policy", ["required"]);
    assert.deepEqual(calls.find((c) => c.method === "gitvault.setPolicy").input, { gitvault_policy: "required" });
  });

  it("refuses `grandfathered` with no --reason, because it weakens the guarantee and is audited", async () => {
    const envelope = await expectFailure("policy", ["grandfathered"]);
    assert.equal(envelope.code, "BAD_USAGE");
    assert.match(envelope.message, /--reason/);
    assert.equal(calls.find((c) => c.method === "gitvault.setPolicy"), undefined, "nothing may be sent for a refused invocation");
  });

  it("refuses an unknown policy by name and lists the two that exist", async () => {
    const envelope = await expectFailure("policy", ["disabled"]);
    assert.equal(envelope.code, "BAD_USAGE");
    assert.deepEqual(envelope.details.known_policies, ["required", "grandfathered"]);
  });

  it("refuses a missing policy with BAD_USAGE, not UNKNOWN_SUBCOMMAND", async () => {
    const envelope = await expectFailure("policy", []);
    assert.equal(envelope.code, "BAD_USAGE");
  });
});

describe("run402 gitvault — the subcommand surface", () => {
  it("no longer answers UNKNOWN_SUBCOMMAND for init or policy", async () => {
    for (const sub of ["init", "policy"]) {
      const envelope = await expectFailure(sub, ["--not-a-flag"]);
      assert.notEqual(envelope.code, "UNKNOWN_SUBCOMMAND", `${sub} is still unrouted`);
    }
  });

  it("still refuses a genuinely unknown subcommand, and lists init + policy among the known ones", async () => {
    const envelope = await expectFailure("allocate", []);
    assert.equal(envelope.code, "UNKNOWN_SUBCOMMAND");
    assert.ok(envelope.details.known_subcommands.includes("init"), JSON.stringify(envelope.details.known_subcommands));
    assert.ok(envelope.details.known_subcommands.includes("policy"), JSON.stringify(envelope.details.known_subcommands));
  });
});

// ─── remote.matches tri-state rendering (kychee-com/run402#562) ───────────
//
// `gitvault.status()`'s `remote.matches` is `boolean | null` — see the SDK's
// own doc comment on `GitvaultStatus.remote`. `false` is a real mismatch;
// `null` means a slug-form remote has not resolved on this machine yet, and
// is NOT evidence of anything wrong. `cli/lib/gitvault.mjs`'s `status`
// renders the mismatch suffix ONLY for `matches === false` — before this
// fix, `matches ? "" : "..."` treated `null` exactly like `false` and would
// have printed a false-alarm "DIFFERENT project" warning for a perfectly
// healthy, simply-not-yet-resolved slug-form remote.
describe("run402 gitvault status — remote.matches tri-state rendering (kychee-com/run402#562)", () => {
  it("matches: false prints the DIFFERENT-project warning", async () => {
    impl.status = async () => vaultStatus({ remote: { name: "origin", url: "run402::other/prj_other", matches: false, reason: null } });
    captureStart();
    try {
      await run("status", []);
    } finally {
      captureStop();
    }
    assert.match(stderr.join("\n"), /remote 'origin':.*← points at a DIFFERENT project than this status/);
  });

  it("matches: null prints a neutral not-yet-resolved note — NEVER the mismatch warning", async () => {
    impl.status = async () => vaultStatus({
      remote: { name: "origin", url: "run402::acme/my-notes", matches: null, reason: "name-form remote, not yet resolved on this machine" },
    });
    captureStart();
    try {
      await run("status", []);
    } finally {
      captureStop();
    }
    const joined = stderr.join("\n");
    assert.doesNotMatch(joined, /DIFFERENT project/, "null must never render as a mismatch");
    assert.match(joined, /remote 'origin':.*\(name-form remote, not yet resolved on this machine\)/);
  });

  it("matches: true prints the remote line with no suffix at all", async () => {
    impl.status = async () => vaultStatus({ remote: { name: "origin", url: "run402::acme/my-notes", matches: true, reason: null } });
    captureStart();
    try {
      await run("status", []);
    } finally {
      captureStop();
    }
    const line = stderr.find((s) => s.startsWith("remote 'origin':"));
    assert.ok(line, `expected a remote line, got: ${stderr.join("\n")}`);
    assert.equal(line, "remote 'origin': run402::acme/my-notes");
  });
});

describe("run402 init — which project the gitvault scaffold acts on", () => {
  it("honours RUN402_PROJECT_ID, the way every other project-scoped command does", () => {
    assert.deepEqual(
      resolveScaffoldProject({ RUN402_PROJECT_ID: PROJECT }, undefined),
      { projectId: PROJECT, skipped: null },
    );
  });

  it("falls back to the active project when the env names none", () => {
    assert.deepEqual(
      resolveScaffoldProject({}, "prj_active"),
      { projectId: "prj_active", skipped: null },
    );
  });

  it("prefers the env var over the active project (an explicit address wins)", () => {
    assert.equal(resolveScaffoldProject({ RUN402_PROJECT_ID: PROJECT }, "prj_active").projectId, PROJECT);
  });

  it("with no project at all it SAYS SO — a silent no-op is worse than an error", () => {
    const { projectId, skipped } = resolveScaffoldProject({}, undefined);
    assert.equal(projectId, null);
    assert.match(skipped, /run402 projects use/);
    assert.match(skipped, /RUN402_PROJECT_ID/);
  });

  it("treats a whitespace-only env var as unset rather than as a project id", () => {
    assert.equal(resolveScaffoldProject({ RUN402_PROJECT_ID: "   " }, undefined).projectId, null);
  });
});

describe("run402 doctor — gitvault is no longer invisible", () => {
  async function runDoctor() {
    const { run } = await import("./cli/lib/doctor.mjs");
    let threw = null;
    captureStart();
    try {
      await run("--no-scan", []);
    } catch (err) {
      threw = err;
    } finally {
      captureStop();
    }
    assert.match(threw?.message ?? "", /^process\.exit\(/, `doctor should exit; stderr:\n${stderr.join("\n")}`);
    const report = JSON.parse(stdout.join("\n"));
    return report.checks.find((c) => c.name === "gitvault");
  }

  it("reports the vault at all — policy, pins, and where the keystore lives", async () => {
    const check = await runDoctor();
    assert.ok(check, "doctor emitted no gitvault check");
    assert.equal(check.status, "ok");
    assert.equal(check.value.gitvault_policy, "required");
    assert.equal(check.value.keystore_root, KEYSTORE_ROOT);
    // The warning that is stated three times across this surface is only
    // actionable with a path.
    assert.match(check.hint, new RegExp(KEYSTORE_ROOT));
    assert.match(check.hint, /terminal/i);
  });

  it("WARNS when the policy is `required` and this machine cannot produce a capture", async () => {
    impl.status = async () => vaultStatus({
      keystore: { ...vaultStatus().keystore, holds_repo_key: false },
    });
    const check = await runDoctor();
    assert.equal(check.status, "warning");
    const gaps = check.value.gaps.join("\n");
    assert.match(gaps, /GITVAULT_CLIENT_UPGRADE_REQUIRED/);
    assert.match(gaps, /run402 gitvault init/);
    assert.match(gaps, /run402 gitvault policy grandfathered/);
  });

  it("WARNS on open unvaulted-override journals", async () => {
    impl.status = async () => vaultStatus({ pending_overrides: 2 });
    const check = await runDoctor();
    assert.equal(check.status, "warning");
    assert.match(check.value.gaps.join("\n"), /2 unvaulted-override journal\(s\)/);
  });

  it("WARNS when the local run402 remote points at a different project", async () => {
    impl.status = async () => vaultStatus({ remote: { name: "run402", url: "run402::other_org/prj_other", matches: false, reason: null } });
    const check = await runDoctor();
    assert.equal(check.status, "warning");
    assert.match(check.value.gaps.join("\n"), /points at a different project/);
  });

  it("does NOT warn when remote.matches is null — a slug-form remote not yet resolved on this machine is not a mismatch (kychee-com/run402#562)", async () => {
    impl.status = async () => vaultStatus({
      remote: { name: "origin", url: "run402::acme/my-notes", matches: null, reason: "name-form remote, not yet resolved on this machine" },
    });
    const check = await runDoctor();
    assert.equal(check.status, "ok");
    assert.doesNotMatch(JSON.stringify(check.value), /different project/i);
  });

  it("echoes the SDK's own advisories verbatim, including the grandfathered one", async () => {
    impl.status = async () => vaultStatus({
      gitvault_policy: "grandfathered",
      warnings: [{ kind: "policy_grandfathered", message: "activation does not require vault admission on this project" }],
    });
    const check = await runDoctor();
    assert.equal(check.status, "warning");
    assert.match(check.value.gaps.join("\n"), /policy_grandfathered: activation does not require vault admission/);
  });

  it("D7 (repo-first-onramp task 2.7): a tripped terminal_loss_risk warning surfaces the same way, with no doctor-side threshold logic of its own", async () => {
    impl.status = async () => vaultStatus({
      warnings: [{ kind: "terminal_loss_risk", message: "this vault has accrued real value at risk (≥10 generations) while only one principal can open it." }],
    });
    const check = await runDoctor();
    assert.equal(check.status, "warning");
    assert.match(check.value.gaps.join("\n"), /terminal_loss_risk: this vault has accrued real value at risk/);
  });

  it("a project with NO vault is a normal shape, not a problem", async () => {
    impl.status = async () => vaultStatus({ vault: null, repo_id: null, gitvault_policy: null, keystore: { ...vaultStatus().keystore, holds_repo_key: false } });
    const check = await runDoctor();
    assert.equal(check.status, "ok");
    assert.match(check.hint, /No vault for this project \(that is a normal shape\)/);
    assert.match(check.hint, /run402 gitvault init/);
  });

  it("a gateway that does not know gitvault is skipped, never a doctor failure", async () => {
    impl.status = async () => { throw Object.assign(new Error("Not Found"), { code: "ROUTE_NOT_FOUND" }); };
    const check = await runDoctor();
    assert.equal(check.status, "skipped");
  });
});

// ─── targeting order for a verb run inside a repository (repo-first-onramp
// follow-up, kychee-com/run402#559) ─────────────────────────────────────
//
// The dogfood: `run402 gitvault snapshot` (and `status`, and `doctor`)
// resolved the profile's ACTIVE project instead of the repo it was standing
// in — a stale pointer to a DIFFERENT project the wallet was not even
// authorized on. `RUN402_PROJECT_ID` is set to the STALE `PROJECT` for every
// test below (the outer suite's own env, left in place on purpose — env is
// tier 4, beneath the repo's own remote at tier 3); a real git repository
// with an `origin` remote naming `PROJECT_REMOTE` must win instead.
const PROJECT_REMOTE = "prj_remote_target_559";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

describe("gitvault verb targeting — the repo's own remote outranks a stale active/env project (kychee-com/run402#559b)", () => {
  let repoDir;
  before(() => {
    repoDir = mkdtempSync(join(tmpdir(), "run402-gv-target-repo-"));
    git(repoDir, ["init", "-q", "-b", "main", "."]);
    git(repoDir, ["remote", "add", "origin", `run402::${ORG}/${PROJECT_REMOTE}`]);
    process.chdir(repoDir);
  });
  after(() => {
    process.chdir(scratch);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("status targets the repo's remote project, not the stale RUN402_PROJECT_ID env", async () => {
    assert.notEqual(PROJECT_REMOTE, process.env.RUN402_PROJECT_ID, "test setup sanity: the remote and env must actually disagree");
    await ok("status", []);
    const call = calls.find((c) => c.method === "gitvault.status");
    assert.ok(call, "status did not reach the SDK");
    assert.equal(call.input.project_id, PROJECT_REMOTE, "must target the repo's own remote, not the stale env-selected project");
  });

  it("snapshot targets the repo's remote project too (id-form, non-push-to-create path)", async () => {
    await ok("snapshot", []);
    const call = calls.find((c) => c.method === "gitvault.push");
    assert.ok(call, "snapshot did not reach the SDK");
    assert.equal(call.input.project_id, PROJECT_REMOTE);
  });

  it("an explicit --project flag disagreeing with the repo's remote wins, but prints a one-line mismatch warning naming both", async () => {
    const explicit = "prj_explicit_override";
    captureStart();
    try {
      await run("status", ["--project", explicit]);
    } finally {
      captureStop();
    }
    const call = calls.find((c) => c.method === "gitvault.status");
    assert.equal(call.input.project_id, explicit, "the explicit flag must win");
    const joined = stderr.join("\n");
    assert.match(joined, /warning/i, joined);
    assert.match(joined, new RegExp(explicit), joined);
    assert.match(joined, new RegExp(PROJECT_REMOTE), joined);
  });

  it("no warning when an explicit --project agrees with the repo's remote", async () => {
    captureStart();
    try {
      await run("status", ["--project", PROJECT_REMOTE]);
    } finally {
      captureStop();
    }
    assert.doesNotMatch(stderr.join("\n"), /warning: --project/);
  });

  it("the 4.38.0 pin outranks the remote when both exist — addresses the vault by repo_id, no project lookup", async () => {
    const PINNED_REPO = "src_pinned_wins_over_remote";
    git(repoDir, ["config", "--local", "r402.repoId", PINNED_REPO]);
    try {
      await ok("status", []);
      const call = calls.find((c) => c.method === "gitvault.status");
      assert.equal(call.input.repo_id, PINNED_REPO, "the pin must win over the remote");
      assert.equal(call.input.project_id, undefined, "a pinned repo_id addresses the vault directly — no project resolution needed");
    } finally {
      git(repoDir, ["config", "--local", "--unset", "r402.repoId"]);
    }
  });

  it("run402 doctor's gitvault check targets the repo's remote vault too, not the stale active/env project", async () => {
    const { run: runDoctor } = await import("./cli/lib/doctor.mjs");
    captureStart();
    try {
      await runDoctor("--no-scan", []);
    } catch {
      // doctor always exits; only the report matters here.
    } finally {
      captureStop();
    }
    const report = JSON.parse(stdout.join("\n"));
    const check = report.checks.find((c) => c.name === "gitvault");
    assert.ok(check, "doctor emitted no gitvault check");
    const call = calls.find((c) => c.method === "gitvault.status");
    assert.ok(call, "doctor's gitvault check did not reach the SDK");
    assert.equal(call.input.project_id, PROJECT_REMOTE, "doctor must target the repo's own vault, not the active project");
  });
});
