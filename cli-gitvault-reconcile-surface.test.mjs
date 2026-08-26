/**
 * `run402 gitvault reconcile` — CLI surface test (gitvault-human-envelopes
 * task 4.1, `ff594ada`). That commit shipped the verb + the SDK method it
 * shims, but no dedicated CLI surface test — this closes that gap using the
 * exact harness `cli-gitvault-mirror-surface.test.mjs` established: the SDK
 * is mocked, so what is under test is the CLI adapter — that the verb
 * exists, validates its arguments, calls `gitvault.reconcileEnvelopeRecipients`
 * with the arguments it claims to, and reports the per-recipient breakdown
 * honestly on stderr. Protocol correctness (TOFU pinning, the HPKE
 * round-trip, the two skip reasons) is
 * `gitvault-reconcile-envelope-recipients.test.ts`'s job, not this file's.
 */
import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalCwd = process.cwd();
const originalConfigDir = process.env.RUN402_CONFIG_DIR;
const originalProjectId = process.env.RUN402_PROJECT_ID;

const PROJECT = "prj_1777547828162_1050";
const REPO = "src_49bd64c263e83be776930478f609a318";

let stdout = [];
let stderr = [];
let calls = [];
let impl = {};

mock.module("./cli/lib/sdk.mjs", {
  namedExports: {
    getSdk: () => ({
      gitvault: {
        reconcileEnvelopeRecipients: async (input) => {
          calls.push({ method: "gitvault.reconcileEnvelopeRecipients", input });
          return (impl.reconcileEnvelopeRecipients ?? (async () => ({
            repo_id: REPO, org_id: "org_test", epoch: "0", wrapped: [], already_covered: [], skipped: [],
          })))(input);
        },
      },
    }),
  },
});

const { run } = await import("./cli/lib/gitvault.mjs");

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
  scratch = mkdtempSync(join(tmpdir(), "run402-gv-reconcile-surface-"));
  process.env.RUN402_CONFIG_DIR = join(scratch, "cfg");
  process.env.RUN402_PROJECT_ID = PROJECT;
  process.chdir(scratch);
});
after(() => {
  process.chdir(originalCwd);
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  if (originalConfigDir === undefined) delete process.env.RUN402_CONFIG_DIR; else process.env.RUN402_CONFIG_DIR = originalConfigDir;
  if (originalProjectId === undefined) delete process.env.RUN402_PROJECT_ID; else process.env.RUN402_PROJECT_ID = originalProjectId;
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  calls = [];
  impl = {};
});

describe("run402 gitvault reconcile", () => {
  it("reaches gitvault.reconcileEnvelopeRecipients with the resolved target and reports the result", async () => {
    const payload = await ok("reconcile", ["--repo", REPO]);
    const call = calls.find((c) => c.method === "gitvault.reconcileEnvelopeRecipients");
    assert.ok(call, `reconcile did not reach the SDK; calls=${JSON.stringify(calls)}`);
    assert.equal(call.input.repo_id, REPO);
    assert.equal(payload.repo_id, REPO);
  });

  it("threads --project through when --repo is omitted", async () => {
    await ok("reconcile", ["--project", PROJECT]);
    const call = calls.find((c) => c.method === "gitvault.reconcileEnvelopeRecipients");
    assert.equal(call.input.project_id, PROJECT);
  });

  it("reports newly-wrapped recipients on stderr with the epoch", async () => {
    impl.reconcileEnvelopeRecipients = async () => ({
      repo_id: REPO, org_id: "org_test", epoch: "0",
      wrapped: [{ principal_id: "prn_alice", ek_fingerprint: "ek_aaaa" }, { principal_id: "prn_bob", ek_fingerprint: "ek_bbbb" }],
      already_covered: [], skipped: [],
    });
    captureStart();
    try {
      await run("reconcile", ["--repo", REPO]);
    } finally {
      captureStop();
    }
    assert.match(stderr.join("\n"), /wrapped 2 new recipient\(s\) at epoch 0/);
  });

  it("reports already-covered recipients on stderr", async () => {
    impl.reconcileEnvelopeRecipients = async () => ({
      repo_id: REPO, org_id: "org_test", epoch: "0", wrapped: [], already_covered: ["ek_aaaa"], skipped: [],
    });
    captureStart();
    try {
      await run("reconcile", ["--repo", REPO]);
    } finally {
      captureStop();
    }
    assert.match(stderr.join("\n"), /1 recipient\(s\) already covered/);
  });

  it("names a pinned-key mismatch loudly, distinct from an ordinary skip", async () => {
    impl.reconcileEnvelopeRecipients = async () => ({
      repo_id: REPO, org_id: "org_test", epoch: "0", wrapped: [], already_covered: [],
      skipped: [{ principal_id: "prn_eve", ek_fingerprint: "ek_cccc", reason: "pinned_key_mismatch", details: { pinned_fingerprint: "ek_old", directory_fingerprint: "ek_new" } }],
    });
    captureStart();
    try {
      await run("reconcile", ["--repo", REPO]);
    } finally {
      captureStop();
    }
    const joined = stderr.join("\n");
    assert.match(joined, /SKIPPED prn_eve/);
    assert.match(joined, /will not silently re-wrap/);
    assert.match(joined, /ek_old/);
    assert.match(joined, /ek_new/);
  });

  it("reports a missing-public-key skip distinctly", async () => {
    impl.reconcileEnvelopeRecipients = async () => ({
      repo_id: REPO, org_id: "org_test", epoch: "0", wrapped: [], already_covered: [],
      skipped: [{ principal_id: "prn_carol", ek_fingerprint: "ek_dddd", reason: "missing_public_key" }],
    });
    captureStart();
    try {
      await run("reconcile", ["--repo", REPO]);
    } finally {
      captureStop();
    }
    assert.match(stderr.join("\n"), /skipped prn_carol: the org directory has no public key on record yet/);
  });

  it("says plainly when there was nothing to reconcile", async () => {
    const payload = await ok("reconcile", ["--repo", REPO]);
    assert.deepEqual(payload.wrapped, []);
    captureStart();
    try {
      await run("reconcile", ["--repo", REPO]);
    } finally {
      captureStop();
    }
    assert.match(stderr.join("\n"), /nothing to reconcile — the org directory has no envelope-capable members yet/);
  });

  it("rejects a stray positional argument with BAD_USAGE", async () => {
    const envelope = await expectFailure("reconcile", ["extra-arg", "--repo", REPO]);
    assert.equal(envelope.code, "BAD_USAGE");
    assert.equal(calls.find((c) => c.method === "gitvault.reconcileEnvelopeRecipients"), undefined);
  });

  it("rejects an unknown flag", async () => {
    const envelope = await expectFailure("reconcile", ["--bogus-flag", "--repo", REPO]);
    assert.equal(envelope.code, "UNKNOWN_FLAG");
    assert.equal(calls.find((c) => c.method === "gitvault.reconcileEnvelopeRecipients"), undefined);
  });
});
