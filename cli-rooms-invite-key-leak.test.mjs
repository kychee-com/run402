/**
 * add-room-invite — the key-never-leaks contract (task 6.5).
 *
 * `run402 rooms invite --json` must print the assembled `kri1_…` key to
 * stdout EXACTLY ONCE and NEVER to stderr, and `run402 rooms join <key>`
 * must never echo a `kri1_…` substring on either stream, on ANY error path
 * (a wrong-kind vault key, a malformed key, a funded-wallet failure, or a
 * gateway claim refusal after the wallet is funded).
 *
 * The SDK and the funded-wallet chain are mocked — this file proves the CLI
 * SURFACE (argument handling, output shaping, and the never-leaks property),
 * not the real x402 payment flow (covered elsewhere). `#sdk/node`'s real
 * key-format module is left UNMOCKED: the wrong-kind refusal itself is the
 * genuine cryptographic parse, run before any network call.
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

const ORG = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa";
const ROOM = "prj_leak_test";

let stdout = [];
let stderr = [];
let calls = [];
let impl = {};

function inviteMintResult(overrides = {}) {
  return {
    invite_id: "11111111-1111-4111-8111-111111111111",
    kind: "room",
    role: "viewer",
    room: { org_id: ORG, room_key: ROOM },
    expires_at: "2026-09-06T01:00:00.000Z",
    warning: "Whoever claims this key first becomes a viewer of this org, permanently, and can read every room in it. The key works once and expires at 2026-09-06T01:00:00.000Z.",
    warnings: [{ code: "ROOM_INVITE_KEY_CONFERS_SEAT", message: "Whoever claims this key first becomes a viewer of this org, permanently, and can read every room in it. The key works once and expires at 2026-09-06T01:00:00.000Z." }],
    ...overrides,
  };
}

function claimResult(overrides = {}) {
  return {
    invite_id: "22222222-2222-4222-8222-222222222222",
    kind: "room",
    deduplicated: false,
    org_id: ORG,
    membership: { org_id: ORG, role: "viewer", status: "active" },
    room: { org_id: ORG, room_key: ROOM },
    inviter: { presence_id: "prs_1", name: "Opus", program: "claude-code", model: "fable-5", state: "active", last_active: "2026-09-06T00:00:00.000Z" },
    live_presences: [],
    cursor: "mcr_1",
    recent_messages: [],
    note: null,
    seat: { sku: "room_seat", amount_usd_micros: 10_000, network: "base-sepolia", charge_id: "chg_1" },
    expires_at: "2026-09-06T01:00:00.000Z",
    ...overrides,
  };
}

mock.module("./cli/lib/sdk.mjs", {
  namedExports: {
    getSdk: () => ({
      rooms: {
        registerPresence: async (orgId, roomKey, opts) => {
          calls.push({ method: "rooms.registerPresence", orgId, roomKey, opts });
          return (impl.registerPresence ?? (async () => ({ presence_id: "prs_inviter", name: "Opus", task: null, program: null, model: null, state: "active", last_active: "2026-09-06T00:00:00.000Z", expires_at: "2026-09-06T01:00:00.000Z" })))();
        },
        getPresence: async () => { throw Object.assign(new Error("not found"), { status: 404 }); },
        sendMessage: async (orgId, roomKey, input) => {
          calls.push({ method: "rooms.sendMessage", orgId, roomKey, input });
          return (impl.sendMessage ?? (async () => ({ message_id: "msg_1", cursor: "mcr_fact_1" })))();
        },
        invite: async (orgId, roomKey, opts) => {
          calls.push({ method: "rooms.invite", orgId, roomKey, opts });
          return (impl.invite ?? (async () => ({ key: "kri1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", ...inviteMintResult() })))();
        },
        join: async (key) => {
          calls.push({ method: "rooms.join", key });
          return (impl.join ?? (async () => claimResult()))();
        },
      },
    }),
  },
});

mock.module("./cli/lib/cold-start.mjs", {
  namedExports: {
    ensureFundedWallet: async (announce) => {
      calls.push({ method: "ensureFundedWallet" });
      announce?.("mock: wallet already funded");
      return (impl.ensureFundedWallet ?? (async () => ({ allowance_created: false, faucet_requested: false, address: "0x0000000000000000000000000000000000000abc" })))();
    },
  },
});

const { run } = await import("./cli/lib/rooms.mjs");
const { assembleRoomInviteKey } = await import("./sdk/dist/node/bearer-claim-key.js");
const { assembleInviteKey, assembleHandoffKey } = await import("./sdk/dist/node/gitvault-handoff.js");

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

async function invoke(sub, args) {
  captureStart();
  try {
    await run(sub, args);
  } finally {
    captureStop();
  }
}

async function invokeExpectingExit(sub, args) {
  captureStart();
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  try {
    await assert.rejects(() => run(sub, args), /process\.exit/);
  } finally {
    captureStop();
    process.exit = originalExit;
  }
}

function countSubstring(lines, needle) {
  return lines.reduce((n, l) => n + (l.split(needle).length - 1), 0);
}

let scratch, configDir;
before(() => {
  scratch = mkdtempSync(join(tmpdir(), "run402-rooms-leak-"));
  configDir = mkdtempSync(join(tmpdir(), "run402-rooms-leak-config-"));
  process.env.RUN402_CONFIG_DIR = configDir;
});
after(() => {
  process.chdir(originalCwd);
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  rmSync(scratch, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});
beforeEach(() => {
  calls = [];
  impl = {};
  process.chdir(scratch);
  rmSync(join(scratch, ".run402"), { recursive: true, force: true });
  rmSync(join(scratch, ".run402.json"), { force: true });
});

const ROOM_ARGS = ["--org", ORG, "--room", ROOM];

describe("run402 rooms invite --json — the key is printed exactly once, never on stderr", () => {
  it("stdout carries the key exactly once; stderr carries zero occurrences", async () => {
    const KEY = "kri1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    impl.invite = async () => ({ key: KEY, ...inviteMintResult() });
    await invoke("invite", [...ROOM_ARGS, "--note", "working on #42", "--json"]);

    const stdoutText = stdout.join("\n");
    const stderrText = stderr.join("\n");
    assert.equal(countSubstring([stdoutText], KEY), 1, `expected exactly one occurrence of the key on stdout, got:\n${stdoutText}`);
    assert.equal(countSubstring([stderrText], "kri1_"), 0, `stderr must never contain a kri1_ substring, got:\n${stderrText}`);
    // Sanity: the warning (not the key) is what rides stderr.
    assert.ok(stderr.some((l) => l.includes("Whoever claims this key first")));
  });
});

describe("run402 rooms invite (no --json) — the key alone on stdout", () => {
  it("stdout is EXACTLY the key; stderr carries the warning and mint summary, never the key", async () => {
    const KEY = "kri1_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    impl.invite = async () => ({ key: KEY, ...inviteMintResult() });
    // Explicit --note: sidesteps the implicit stdin-note fallback (a non-TTY,
    // never-closed stdin under a test/harness process hangs forever waiting
    // for EOF — the same latent shape `repos invite`/`repos handoff` already
    // accept for their own mandatory notes).
    await invoke("invite", [...ROOM_ARGS, "--note", "hi"]);

    assert.equal(stdout.length, 1);
    assert.equal(stdout[0], KEY);
    assert.equal(countSubstring(stderr, "kri1_"), 0, `stderr must never contain a kri1_ substring, got:\n${stderr.join("\n")}`);
  });
});

describe("run402 rooms join <key> — every error path leaks nothing", () => {
  it("a kgi1_ (gitvault invite) key refuses by name, contacts nothing, and leaks nothing", async () => {
    const { key } = assembleInviteKey("33333333-3333-4333-8333-333333333333");
    await invokeExpectingExit("join", [key]);
    assert.equal(calls.find((c) => c.method === "ensureFundedWallet"), undefined, "ensureFundedWallet must never run for a wrong-kind key");
    assert.equal(calls.find((c) => c.method === "rooms.join"), undefined, "the gateway must never be contacted for a wrong-kind key");
    assert.equal(countSubstring(stdout, key), 0);
    assert.equal(countSubstring(stderr, key), 0);
    assert.ok(stderr.some((l) => l.includes("ROOM_INVITE_KEY_WRONG_KIND")));
  });

  it("a kgh1_ (gitvault handoff) key refuses by name, contacts nothing, and leaks nothing", async () => {
    const { key } = assembleHandoffKey("44444444-4444-4444-8444-444444444444");
    await invokeExpectingExit("join", [key]);
    assert.equal(calls.find((c) => c.method === "ensureFundedWallet"), undefined);
    assert.equal(calls.find((c) => c.method === "rooms.join"), undefined);
    assert.equal(countSubstring(stdout, key), 0);
    assert.equal(countSubstring(stderr, key), 0);
  });

  it("a malformed kri1_ key refuses locally and leaks nothing", async () => {
    const badKey = "kri1_not-valid-base64url-at-all!!";
    await invokeExpectingExit("join", [badKey]);
    assert.equal(calls.find((c) => c.method === "ensureFundedWallet"), undefined);
    assert.equal(countSubstring(stdout, badKey), 0);
    assert.equal(countSubstring(stderr, badKey), 0);
  });

  it("a funded-wallet failure (faucet throttled) leaks nothing", async () => {
    const { key } = assembleRoomInviteKey("55555555-5555-4555-8555-555555555555");
    impl.ensureFundedWallet = async () => {
      const err = new Error("faucet throttled");
      err.code = "FAUCET_THROTTLED";
      throw err;
    };
    await invokeExpectingExit("join", [key]);
    assert.equal(calls.find((c) => c.method === "rooms.join"), undefined, "the claim must never be attempted when funding fails");
    assert.equal(countSubstring(stdout, key), 0);
    assert.equal(countSubstring(stderr, key), 0);
  });

  it("a gateway claim refusal AFTER a settled payment (ALREADY_CLAIMED) leaks nothing", async () => {
    const { key } = assembleRoomInviteKey("66666666-6666-4666-8666-666666666666");
    impl.join = async () => {
      const err = new Error("this room invite was already claimed by a different principal");
      err.code = "ROOM_INVITE_KEY_ALREADY_CLAIMED";
      err.status = 409;
      throw err;
    };
    await invokeExpectingExit("join", [key]);
    assert.equal(countSubstring(stdout, key), 0);
    assert.equal(countSubstring(stderr, key), 0);
    assert.ok(stderr.some((l) => l.includes("ROOM_INVITE_KEY_ALREADY_CLAIMED")));
  });

  it("a PaymentRequired refusal (payment failed) leaks nothing", async () => {
    const { key } = assembleRoomInviteKey("77777777-7777-4777-8777-777777777777");
    impl.join = async () => {
      const err = new Error("payment required");
      err.code = "PAYMENT_REQUIRED";
      err.status = 402;
      err.nextActions = [{ type: "fund_wallet", why: "top up the wallet" }];
      throw err;
    };
    await invokeExpectingExit("join", [key]);
    assert.equal(countSubstring(stdout, key), 0);
    assert.equal(countSubstring(stderr, key), 0);
  });
});

describe("run402 rooms join <key> — the successful path leaks nothing beyond the user's own input", () => {
  it("a successful --json join never re-emits the key material", async () => {
    const { key } = assembleRoomInviteKey("88888888-8888-4888-8888-888888888888");
    impl.join = async () => claimResult();
    await invoke("join", [key, "--json"]);
    // The user's own argument is not "leaked" by re-typing it back — but the
    // CLI must never echo it a SECOND time anywhere in its own output.
    const stdoutText = stdout.join("\n");
    assert.equal(countSubstring([stdoutText], key), 0, "the claimed key must not be echoed back in the result");
    assert.equal(countSubstring(stderr, key), 0);
  });
});
