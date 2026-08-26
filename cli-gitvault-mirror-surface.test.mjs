/**
 * `run402 gitvault mirror` / `run402 gitvault recover` — CLI surface tests
 * (gitvault-mirror-and-recover, task 4.4).
 *
 * Mirrors `cli-gitvault-surface.test.mjs`'s own harness pattern: the SDK is
 * mocked, so what is under test is the CLI adapter — that the verbs exist,
 * validate their arguments, and call the SDK method they claim to with the
 * arguments they claim to. Protocol correctness (torn-mirror, absence
 * adjudication, etc.) is `gitvault-mirror-recover.test.ts`'s job, not this
 * file's.
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

const PROJECT = "prj_1777547828162_1049";
const REPO = "src_49bd64c263e83be776930478f609a317";

const HONESTY_A = "this recovery proves validity, never freshness";
const HONESTY_B = "recovers nothing";

let stdout = [];
let stderr = [];
let calls = [];
let impl = {};

mock.module("./cli/lib/sdk.mjs", {
  namedExports: {
    getSdk: () => ({
      gitvault: {
        mirrorSet: async (input) => {
          calls.push({ method: "gitvault.mirrorSet", input });
          return (impl.mirrorSet ?? (async () => ({
            version: 1, repo_id: REPO, destination: { kind: "s3", bucket: "acme-vault-mirror", prefix: "", region: "us-east-1" },
            credential: { kind: "profile", profile: "acme" }, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
          })))(input);
        },
        mirrorRemove: async (input) => {
          calls.push({ method: "gitvault.mirrorRemove", input });
          return (impl.mirrorRemove ?? (async () => ({ repo_id: REPO, removed: true })))(input);
        },
        mirrorStatus: async (input) => {
          calls.push({ method: "gitvault.mirrorStatus", input });
          return (impl.mirrorStatus ?? (async () => ({
            repo_id: REPO, configured: true, destination: "s3://acme-vault-mirror/", credential_kind: "profile",
            mirrored_generation: "0000000000000003", newest_generation: "0000000000000003", is_current: true, closing_command: null,
            validity_not_freshness: HONESTY_A, keystore_still_required: HONESTY_B,
          })))(input);
        },
        mirrorSync: async (input) => {
          calls.push({ method: "gitvault.mirrorSync", input });
          return (impl.mirrorSync ?? (async () => ({
            repo_id: REPO, destination: "s3://acme-vault-mirror/", objects_listed: 5, objects_copied: 5, objects_already_present: 0,
            objects_failed: 0, bytes_copied: "1024", errors: [], validity_not_freshness: HONESTY_A, keystore_still_required: HONESTY_B,
          })))(input);
        },
        mirrorVerify: async (input) => {
          calls.push({ method: "gitvault.mirrorVerify", input });
          return (impl.mirrorVerify ?? (async () => ({
            mode: "keyless_verify", repo_id: REPO, genesis_sha256: "abc", pin_trust: "receipt", recovered_generation: "0000000000000003",
            chain_break: null, absences: [], data_loss_detected: false, inventory: { ref_state: 1 },
            validity_not_freshness: HONESTY_A, keystore_still_required: HONESTY_B,
          })))(input);
        },
        recover: async (input) => {
          calls.push({ method: "gitvault.recover", input });
          return (impl.recover ?? (async () => ({
            mode: "recovered", repo_id: REPO, genesis_sha256: "abc", pin_trust: "receipt", recovered_generation: "0000000000000003",
            chain_break: null, absences: [], data_loss_detected: false, refs: { "refs/heads/main": "a".repeat(40) },
            head_target: { kind: "symref", ref: "refs/heads/main" }, out_dir: "./restored",
            validity_not_freshness: HONESTY_A, keystore_still_required: HONESTY_B,
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
  scratch = mkdtempSync(join(tmpdir(), "run402-gv-mirror-surface-"));
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

describe("run402 gitvault mirror set", () => {
  it("passes the destination + credential through to gitvault.mirrorSet", async () => {
    const payload = await ok("mirror", ["set", "s3://acme-vault-mirror", "--profile", "acme", "--repo", REPO]);
    const call = calls.find((c) => c.method === "gitvault.mirrorSet");
    assert.ok(call, `mirror set did not reach the SDK; calls=${JSON.stringify(calls)}`);
    assert.equal(call.input.destination_url, "s3://acme-vault-mirror");
    assert.deepEqual(call.input.credential, { kind: "profile", profile: "acme" });
    assert.equal(call.input.repo_id, REPO);
    assert.equal(payload.repo_id, REPO);
  });

  it("--profile and --ambient contradict each other", async () => {
    const envelope = await expectFailure("mirror", ["set", "s3://acme-vault-mirror", "--profile", "acme", "--ambient", "--repo", REPO]);
    assert.equal(envelope.code, "BAD_USAGE");
  });

  it("--ambient alone is accepted", async () => {
    await ok("mirror", ["set", "s3://acme-vault-mirror", "--ambient", "--repo", REPO]);
    const call = calls.find((c) => c.method === "gitvault.mirrorSet");
    assert.deepEqual(call.input.credential, { kind: "ambient" });
  });

  it("a directory destination needs no credential flag at all", async () => {
    await ok("mirror", ["set", "/tmp/my-mirror", "--repo", REPO]);
    const call = calls.find((c) => c.method === "gitvault.mirrorSet");
    assert.equal(call.input.credential, undefined);
    assert.equal(call.input.destination_url, "/tmp/my-mirror");
  });

  it("refuses a missing destination with BAD_USAGE", async () => {
    const envelope = await expectFailure("mirror", ["set", "--repo", REPO]);
    assert.equal(envelope.code, "BAD_USAGE");
  });
});

describe("run402 gitvault mirror remove/status/sync/verify", () => {
  it("remove reaches gitvault.mirrorRemove and reports removal honestly", async () => {
    const payload = await ok("mirror", ["remove", "--repo", REPO]);
    assert.ok(calls.find((c) => c.method === "gitvault.mirrorRemove"));
    assert.equal(payload.removed, true);
  });

  it("status prints both honesty statements to stderr and reports currency", async () => {
    captureStart();
    try {
      await run("mirror", ["status", "--repo", REPO]);
    } finally {
      captureStop();
    }
    const joined = stderr.join("\n");
    assert.match(joined, /current/);
    assert.match(joined, new RegExp(HONESTY_A));
    assert.match(joined, new RegExp(HONESTY_B));
  });

  it("status names the closing command when the mirror is STALE", async () => {
    impl.mirrorStatus = async () => ({
      repo_id: REPO, configured: true, destination: "s3://acme-vault-mirror/", credential_kind: "profile",
      mirrored_generation: "0000000000000002", newest_generation: "0000000000000003", is_current: false,
      closing_command: "run402 gitvault mirror sync", validity_not_freshness: HONESTY_A, keystore_still_required: HONESTY_B,
    });
    captureStart();
    try {
      await run("mirror", ["status", "--repo", REPO]);
    } finally {
      captureStop();
    }
    assert.match(stderr.join("\n"), /STALE — run402 gitvault mirror sync/);
  });

  it("status on an unconfigured mirror names the setup command, informationally — never a failure", async () => {
    impl.mirrorStatus = async () => ({
      repo_id: REPO, configured: false, destination: null, credential_kind: null, mirrored_generation: null,
      newest_generation: null, is_current: null, closing_command: null, validity_not_freshness: HONESTY_A, keystore_still_required: HONESTY_B,
    });
    const payload = await ok("mirror", ["status", "--repo", REPO]);
    assert.equal(payload.configured, false);
  });

  it("sync reaches gitvault.mirrorSync and reports faithful counts on stderr", async () => {
    captureStart();
    try {
      await run("mirror", ["sync", "--repo", REPO]);
    } finally {
      captureStop();
    }
    assert.ok(calls.find((c) => c.method === "gitvault.mirrorSync"));
    assert.match(stderr.join("\n"), /5 copied, 0 already present/);
  });

  it("sync surfaces per-object failures on stderr, one line each", async () => {
    impl.mirrorSync = async () => ({
      repo_id: REPO, destination: "s3://acme-vault-mirror/", objects_listed: 2, objects_copied: 1, objects_already_present: 0,
      objects_failed: 1, bytes_copied: "10", errors: [{ key: "wal/wal_x.pack.enc", error: "hash mismatch" }],
      validity_not_freshness: HONESTY_A, keystore_still_required: HONESTY_B,
    });
    captureStart();
    try {
      await run("mirror", ["sync", "--repo", REPO]);
    } finally {
      captureStop();
    }
    const joined = stderr.join("\n");
    assert.match(joined, /1 FAILED/);
    assert.match(joined, /failed: wal\/wal_x\.pack\.enc — hash mismatch/);
  });

  it("verify reaches gitvault.mirrorVerify and never mints a decrypted result", async () => {
    const payload = await ok("mirror", ["verify", "--repo", REPO]);
    assert.ok(calls.find((c) => c.method === "gitvault.mirrorVerify"));
    assert.equal(payload.mode, "keyless_verify");
  });

  it("verify names data loss loudly on stderr when detected", async () => {
    impl.mirrorVerify = async () => ({
      mode: "keyless_verify", repo_id: REPO, genesis_sha256: "abc", pin_trust: "receipt", recovered_generation: "0000000000000001",
      chain_break: null, absences: [{ object_id: "wal_x", key: "wal/wal_x.pack.enc", adjudication: "unexplained_absence", prune_intent_object_id: null }],
      data_loss_detected: true, inventory: {}, validity_not_freshness: HONESTY_A, keystore_still_required: HONESTY_B,
    });
    captureStart();
    try {
      await run("mirror", ["verify", "--repo", REPO]);
    } finally {
      captureStop();
    }
    assert.match(stderr.join("\n"), /DATA LOSS DETECTED: 1 object/);
  });

  it("an unknown mirror action fails UNKNOWN_SUBCOMMAND", async () => {
    const envelope = await expectFailure("mirror", ["bogus"]);
    assert.equal(envelope.code, "UNKNOWN_SUBCOMMAND");
  });
});

describe("run402 gitvault recover", () => {
  it("passes source + out_dir through to gitvault.recover", async () => {
    const payload = await ok("recover", ["s3://acme-vault-mirror", "--out", "./restored"]);
    const call = calls.find((c) => c.method === "gitvault.recover");
    assert.ok(call, `recover did not reach the SDK; calls=${JSON.stringify(calls)}`);
    assert.equal(call.input.source, "s3://acme-vault-mirror");
    assert.equal(call.input.out_dir, "./restored");
    assert.equal(payload.recovered_generation, "0000000000000003");
  });

  it("requires --out — refuses with BAD_USAGE, never a silent default directory", async () => {
    const envelope = await expectFailure("recover", ["s3://acme-vault-mirror"]);
    assert.equal(envelope.code, "BAD_USAGE");
    assert.equal(calls.find((c) => c.method === "gitvault.recover"), undefined);
  });

  it("threads --repo, --profile, --region, --endpoint through", async () => {
    await ok("recover", ["s3://acme-vault-mirror", "--out", "./restored", "--repo", REPO, "--profile", "acme", "--region", "us-west-2", "--endpoint", "https://s3.example.com"]);
    const call = calls.find((c) => c.method === "gitvault.recover");
    assert.equal(call.input.repo_id, REPO);
    assert.deepEqual(call.input.credential, { kind: "profile", profile: "acme" });
    assert.equal(call.input.region, "us-west-2");
    assert.equal(call.input.endpoint, "https://s3.example.com");
  });

  it("prints both honesty statements verbatim on success", async () => {
    captureStart();
    try {
      await run("recover", ["s3://acme-vault-mirror", "--out", "./restored"]);
    } finally {
      captureStop();
    }
    const joined = stderr.join("\n");
    assert.match(joined, new RegExp(HONESTY_A));
    assert.match(joined, new RegExp(HONESTY_B));
  });

  it("names data loss loudly on stderr when the recovered generation carries an unexplained absence", async () => {
    impl.recover = async () => ({
      mode: "recovered", repo_id: REPO, genesis_sha256: "abc", pin_trust: "receipt", recovered_generation: "0000000000000001",
      chain_break: { generation: "0000000000000002", reason: "signature failed" },
      absences: [{ object_id: "wal_x", key: "wal/wal_x.pack.enc", adjudication: "unexplained_absence", prune_intent_object_id: null }],
      data_loss_detected: true, refs: {}, head_target: { kind: "symref", ref: "refs/heads/main" }, out_dir: "./restored",
      validity_not_freshness: HONESTY_A, keystore_still_required: HONESTY_B,
    });
    captureStart();
    try {
      await run("recover", ["s3://acme-vault-mirror", "--out", "./restored"]);
    } finally {
      captureStop();
    }
    const joined = stderr.join("\n");
    assert.match(joined, /chain break at 0000000000000002/);
    assert.match(joined, /DATA LOSS DETECTED: 1 object/);
  });
});
