import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "run402-snapshots-cli-"));
const configDir = join(tempDir, "config");
const API = "https://test-api.run402.com";

process.env.RUN402_CONFIG_DIR = configDir;
process.env.RUN402_API_BASE = API;

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BASE = `${API}/projects/v1/prj_snap/snapshots`;

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalCwd = process.cwd();

let calls = [];
let stdout = [];
let stderr = [];
let run;

const RESULT = {
  operation_id: "rst_1",
  restore_id: "rst_1",
  project_id: "prj_snap",
  snapshot_id: "snap_1",
  pre_restore_snapshot_id: "snap_pre",
  old_schema_slot: "p0001",
  new_schema_slot: "p0002",
  migration_registry_rows: 1,
  invalidated_plan_count: 0,
  release_mode: "snapshot",
  live_release_id: "rel_old",
  message: "Restore completed",
  status: "ready",
  next_actions: [],
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const USDC_BALANCE_HEX = "0x" + "0".repeat(58) + "03d090";

async function mockFetch(input, init) {
  const isRequest = input instanceof Request;
  const url = isRequest ? input.url : String(input);
  const method = ((isRequest ? input.method : init?.method) || "GET").toUpperCase();
  const rawBody = isRequest ? await input.clone().text() : init?.body;
  const body = rawBody ? JSON.parse(String(rawBody)) : null;
  if (!url.startsWith(API)) {
    // Wallet balance preflight against public Base RPCs.
    return json({ jsonrpc: "2.0", id: body?.id ?? 1, result: USDC_BALANCE_HEX });
  }
  calls.push({ url, method, body });

  if (url === BASE && method === "POST") {
    return json({ snapshot_id: "snap_1", status: "ready", label: body.label ?? null, metadata: body.metadata ?? null }, 201);
  }
  if (url === `${BASE}/snap_1/restore` && method === "POST") {
    if (!body.confirm) {
      return json({
        restore_plan: {
          snapshot_id: "snap_1",
          release: { mode: body.release ?? "keep", restorable: true, reason: "restorable", warnings: [] },
          confirm: { token: "tok_1", expires_at: "2026-10-06T10:15:00.000Z" },
          next_actions: [],
        },
      });
    }
    return json({
      operation_id: "rst_1", restore_id: "rst_1", project_id: "prj_snap", snapshot_id: "snap_1",
      release_mode: body.release ?? "keep", include_auth: false, status: "running", retry_after_seconds: 1,
      next_actions: [{ type: "poll", message: "poll" }],
    }, 202);
  }
  if (url === `${BASE}/snap_1/restores/rst_1` && method === "GET") {
    return json({
      operation_id: "rst_1", restore_id: "rst_1", project_id: "prj_snap", snapshot_id: "snap_1",
      status: "ready", release_mode: "snapshot", include_auth: false, pre_restore_snapshot_id: "snap_pre",
      live_release_id: "rel_old", started_at: "2026-10-06T10:00:00.000Z", completed_at: "2026-10-06T10:01:00.000Z",
      updated_at: "2026-10-06T10:01:00.000Z", error: null, result: RESULT, next_actions: [],
    });
  }
  return json({ error: `unexpected ${method} ${url}` }, 500);
}

function captureStart() {
  stdout = [];
  stderr = [];
  console.log = (...args) => stdout.push(args.join(" "));
  console.error = (...args) => stderr.push(args.join(" "));
}

function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

before(async () => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "wallet.json"), JSON.stringify({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }));
  process.chdir(tempDir);
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  ({ run } = await import("./cli/lib/snapshots.mjs"));
});

after(() => {
  process.chdir(originalCwd);
  captureStop();
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  captureStop();
});

describe("run402 snapshots", () => {
  it("creates a labelled snapshot with metadata", async () => {
    captureStart();
    await run("create", ["--project", "prj_snap", "--label", "before engine upgrade", "--metadata", '{"engine_to":"1.5.0"}']);
    captureStop();
    assert.deepEqual(calls[0].body, { label: "before engine upgrade", metadata: { engine_to: "1.5.0" } });
    const out = JSON.parse(stdout.join("\n"));
    assert.equal(out.snapshot.label, "before engine upgrade");
  });

  it("refuses invalid --metadata before any request", async () => {
    captureStart();
    await assert.rejects(() => run("create", ["--project", "prj_snap", "--metadata", "[1,2]"]), /process\.exit\(1\)/);
    captureStop();
    assert.equal(calls.length, 0);
    assert.match(stderr.join("\n"), /BAD_FLAG/);
  });

  it("plans with --release and prints a confirm command that repeats it", async () => {
    captureStart();
    await run("restore", ["snap_1", "--project", "prj_snap", "--release", "snapshot"]);
    captureStop();
    assert.deepEqual(calls[0].body, { release: "snapshot" });
    const out = JSON.parse(stdout.join("\n"));
    assert.match(out.confirm_command, /--confirm "tok_1" --release snapshot --json$/);
  });

  it("refuses an unknown --release value", async () => {
    captureStart();
    await assert.rejects(() => run("restore", ["snap_1", "--project", "prj_snap", "--release", "latest"]), /process\.exit\(1\)/);
    captureStop();
    assert.equal(calls.length, 0);
  });

  it("confirms, waits for the result, and prints the live release", async () => {
    captureStart();
    await run("restore", ["snap_1", "--project", "prj_snap", "--release", "snapshot", "--confirm", "tok_1"]);
    captureStop();
    assert.deepEqual(calls[0].body, { release: "snapshot", confirm: "tok_1", wait: false });
    const out = JSON.parse(stdout.join("\n"));
    assert.equal(out.ok, true);
    assert.equal(out.restore.live_release_id, "rel_old");
  });

  it("reads a restore by id", async () => {
    captureStart();
    await run("restore-status", ["snap_1", "rst_1", "--project", "prj_snap"]);
    captureStop();
    assert.equal(calls[0].url, `${BASE}/snap_1/restores/rst_1`);
    const out = JSON.parse(stdout.join("\n"));
    assert.equal(out.restore.status, "ready");
  });
});
