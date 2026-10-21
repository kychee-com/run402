import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "run402-push-cli-"));
const configDir = join(tempDir, "config");
const API = "https://test-api.run402.com";

process.env.RUN402_CONFIG_DIR = configDir;
process.env.RUN402_API_BASE = API;

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BASE = `${API}/projects/v1/prj_kiwi/push`;

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalCwd = process.cwd();

let calls = [];
let stdout = [];
let stderr = [];
let run;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const OUTCOMES = { queued: 0, retrying: 0, accepted: 2, removed: 0, failed: 0 };

const STATUS = {
  project_id: "prj_kiwi",
  subscriptions: {
    total: 2,
    users: [{
      user_id: "6f1c2b4e-0000-4000-8000-000000000001",
      phones: [
        { subscription_id: "psub_1", push_service: "web.push.apple.com", created_at: "2026-10-21T08:00:00.000Z", last_confirmed_at: "2026-10-21T08:00:00.000Z", last_accepted_at: null },
        { subscription_id: "psub_2", push_service: "fcm.googleapis.com", created_at: "2026-10-21T08:05:00.000Z", last_confirmed_at: "2026-10-21T08:05:00.000Z", last_accepted_at: "2026-10-21T09:00:01.000Z" },
      ],
    }],
    users_shown: 1,
    users_total: 1,
    has_more: false,
  },
  usage: { deliveries_today: 12, limit: 100, resets_at: "2026-10-22T00:00:00.000Z", scope: "organization", org_id: "5f0a7c2e-6f0a-4a7e-9d1a-1a2b3c4d5e6f" },
  messages: [{ message_id: "pmsg_1", created_at: "2026-10-21T09:00:00.000Z", status: "completed", devices: 2, outcomes: OUTCOMES }],
};

const MESSAGE = {
  message_id: "pmsg_1",
  project_id: "prj_kiwi",
  created_at: "2026-10-21T09:00:00.000Z",
  status: "completed",
  devices: 2,
  title: "Kiwi",
  body: "4 hours since the last pee",
  url: "/",
  tag: "potty",
  to: null,
  outcomes: OUTCOMES,
  deliveries: [
    { subscription_id: "psub_1", user_id: "6f1c2b4e-0000-4000-8000-000000000001", push_service: "web.push.apple.com", status: "accepted", attempts: 1, last_status: 201, last_error: null, updated_at: "2026-10-21T09:00:01.000Z" },
    { subscription_id: "psub_2", user_id: "6f1c2b4e-0000-4000-8000-000000000001", push_service: "fcm.googleapis.com", status: "accepted", attempts: 1, last_status: 201, last_error: null, updated_at: "2026-10-21T09:00:01.000Z" },
  ],
  deliveries_shown: 2,
  has_more: false,
};

const USDC_BALANCE_HEX = "0x" + "0".repeat(58) + "03d090";

async function mockFetch(input, init) {
  const isRequest = input instanceof Request;
  const url = isRequest ? input.url : String(input);
  const method = ((isRequest ? input.method : init?.method) || "GET").toUpperCase();
  const headers = Object.fromEntries(new Headers(isRequest ? input.headers : (init?.headers ?? {})).entries());
  if (!url.startsWith(API)) {
    return json({ jsonrpc: "2.0", id: 1, result: USDC_BALANCE_HEX });
  }
  calls.push({ url, method, headers });
  if (url === BASE && method === "GET") return json(STATUS);
  if (url === `${BASE}/messages/pmsg_1` && method === "GET") return json(MESSAGE);
  if (url === `${BASE}/messages/pmsg_gone` && method === "GET") {
    return json({ error: "RESOURCE_NOT_FOUND", code: "RESOURCE_NOT_FOUND", message: "No such push message in this project." }, 404);
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

async function runCaptured(sub, args) {
  captureStart();
  let threw = null;
  try {
    await run(sub, args);
  } catch (err) {
    threw = err;
  } finally {
    captureStop();
  }
  return { threw, out: stdout.join("\n"), err: stderr.join("\n") };
}

before(async () => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "wallet.json"), JSON.stringify({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }));
  process.chdir(tempDir);
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  ({ run } = await import("./cli/lib/push.mjs"));
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

describe("run402 push status", () => {
  it("prints the project's status read as JSON", async () => {
    const { threw, out, err } = await runCaptured("status", ["--project", "prj_kiwi"]);
    assert.equal(threw, null, err);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, BASE);
    assert.equal(calls[0].method, "GET");
    const printed = JSON.parse(out);
    assert.equal(printed.subscriptions.total, 2);
    assert.equal(printed.usage.deliveries_today, 12);
    assert.equal(printed.messages[0].message_id, "pmsg_1");
    assert.equal(err, "");
  });

  it("--message prints one message with its deliveries", async () => {
    const { threw, out } = await runCaptured("status", ["--project", "prj_kiwi", "--message", "pmsg_1"]);
    assert.equal(threw, null);
    assert.equal(calls[0].url, `${BASE}/messages/pmsg_1`);
    const printed = JSON.parse(out);
    assert.equal(printed.title, "Kiwi");
    assert.equal(printed.deliveries.length, 2);
    assert.equal(printed.deliveries[0].status, "accepted");
  });

  it("accepts --message=<id> and --json", async () => {
    const { threw, out } = await runCaptured("status", ["--project=prj_kiwi", "--message=pmsg_1", "--json"]);
    assert.equal(threw, null);
    assert.equal(JSON.parse(out).message_id, "pmsg_1");
  });

  it("an unknown message is the gateway's 404 envelope on stderr, exit 1", async () => {
    const { threw, out, err } = await runCaptured("status", ["--project", "prj_kiwi", "--message", "pmsg_gone"]);
    assert.equal(threw?.message, "process.exit(1)");
    assert.equal(out, "");
    assert.ok(/RESOURCE_NOT_FOUND/.test(err), `stderr: ${err}`);
  });

  it("rejects an unknown flag before calling the gateway", async () => {
    const { threw, err } = await runCaptured("status", ["--project", "prj_kiwi", "--msg", "pmsg_1"]);
    assert.equal(threw?.message, "process.exit(1)");
    assert.equal(calls.length, 0);
    assert.ok(/UNKNOWN_FLAG/.test(err), `stderr: ${err}`);
  });

  it("rejects a bare positional (a message id must be --message)", async () => {
    const { threw, err } = await runCaptured("status", ["--project", "prj_kiwi", "pmsg_1"]);
    assert.equal(threw?.message, "process.exit(1)");
    assert.equal(calls.length, 0);
    assert.ok(/BAD_USAGE/.test(err), `stderr: ${err}`);
    assert.ok(/--message/.test(err));
  });

  it("an unknown subcommand is UNKNOWN_SUBCOMMAND naming status", async () => {
    const { threw, err } = await runCaptured("stats", ["--project", "prj_kiwi"]);
    assert.equal(threw?.message, "process.exit(1)");
    const envelope = JSON.parse(err.split("\n").find((line) => line.startsWith("{")));
    assert.equal(envelope.code, "UNKNOWN_SUBCOMMAND");
    assert.deepEqual(envelope.details.known_subcommands, ["status"]);
    assert.deepEqual(envelope.details.closest, ["status"]);
  });
});
