/**
 * add-room-invite design D10 — arrival state after a key-form
 * `run402 rooms join <kri1_…>`, tested in BOTH directory shapes (task 6.4):
 *
 *   - outside a git repository: `org`/`room` land in `.run402.json`
 *   - inside one: `r402.orgId`/`r402.room` are pinned in LOCAL git config
 *     (never committed) and `.run402/` is appended to `.git/info/exclude`
 *
 * Either way: the wallet's current org is set, the returned cursor is
 * persisted into `.run402/messaging.json`, and a `wait_room` next action
 * names `run402 messages wait`.
 *
 * The SDK and the funded-wallet chain are mocked; what is under test is the
 * CLI's own arrival-state wiring.
 */
import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalCwd = process.cwd();

const ORG = "bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb";
const ROOM = "prj_arrival_test";

let impl = {};

function claimResult(overrides = {}) {
  return {
    invite_id: "99999999-9999-4999-8999-999999999999",
    kind: "room",
    deduplicated: false,
    org_id: ORG,
    membership: { org_id: ORG, role: "viewer", status: "active" },
    room: { org_id: ORG, room_key: ROOM },
    inviter: null,
    live_presences: [],
    cursor: "mcr_arrival_1",
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
        join: async (key) => (impl.join ?? (async () => claimResult()))(key),
      },
    }),
  },
});

mock.module("./cli/lib/cold-start.mjs", {
  namedExports: {
    ensureFundedWallet: async () => ({ allowance_created: false, faucet_requested: false, address: "0xabc" }),
  },
});

const { run } = await import("./cli/lib/rooms.mjs");
const { assembleRoomInviteKey } = await import("./sdk/dist/node/bearer-claim-key.js");
const { getSelectedOrgId, clearSelectedOrgId } = await import("./cli/lib/org-context.mjs");
const { readBindingFile, bindingFilePath } = await import("./cli/lib/wallet-context.mjs");
const { getRoomState } = await import("./cli/lib/rooms-context.mjs");

function captureStart() {
  console.log = () => {};
  console.error = () => {};
}
function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

let configDir;
const createdDirs = [];
before(() => {
  configDir = mkdtempSync(join(tmpdir(), "run402-arrival-config-"));
  process.env.RUN402_CONFIG_DIR = configDir;
});
after(() => {
  process.chdir(originalCwd);
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
  for (const d of createdDirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  impl = {};
  try { clearSelectedOrgId(); } catch { /* fine if nothing was selected */ }
});

describe("arrival outside a git repository", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run402-arrival-plain-"));
    createdDirs.push(dir);
    process.chdir(dir);
  });

  it("writes org/room into .run402.json, sets the current org, and persists the cursor", async () => {
    const { key } = assembleRoomInviteKey("aaaaaaaa-1111-4111-8111-111111111111");
    captureStart();
    try {
      await run("join", [key]);
    } finally {
      captureStop();
    }

    // .run402.json carries org + room.
    const bound = readBindingFile(dir);
    assert.equal(bound.org, ORG);
    assert.equal(bound.room, ROOM);
    assert.ok(existsSync(bindingFilePath(dir)), ".run402.json must exist outside a git repository");

    // The current org is set (org use semantics).
    assert.equal(getSelectedOrgId(), ORG);

    // The returned cursor is persisted for messages wait/list.
    const state = getRoomState(ORG, ROOM, { cwd: dir });
    assert.equal(state.cursor, "mcr_arrival_1");
  });

  it("no .run402.json is left behind on a wrong-kind-key refusal (arrival never runs)", async () => {
    const { assembleInviteKey } = await import("./sdk/dist/node/gitvault-handoff.js");
    const { key } = assembleInviteKey("bbbbbbbb-2222-4222-8222-222222222222");
    process.exit = (code) => { throw new Error(`process.exit(${code})`); };
    captureStart();
    try {
      await assert.rejects(() => run("join", [key]), /process\.exit/);
    } finally {
      captureStop();
      process.exit = originalExit;
    }
    assert.equal(existsSync(bindingFilePath(dir)), false);
  });
});

describe("arrival inside a git repository", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run402-arrival-git-"));
    createdDirs.push(dir);
    const init = spawnSync("git", ["init", "-q", dir], { encoding: "utf-8" });
    assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
    // A repo needs identity configured locally for some git operations in CI images.
    spawnSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    spawnSync("git", ["-C", dir, "config", "user.name", "Test"]);
    process.chdir(dir);
  });

  it("pins r402.orgId/r402.room in LOCAL git config, excludes .run402/, and never writes .run402.json", async () => {
    const { key } = assembleRoomInviteKey("cccccccc-3333-4333-8333-333333333333");
    captureStart();
    try {
      await run("join", [key]);
    } finally {
      captureStop();
    }

    // No .run402.json committed into the tracked tree.
    assert.equal(existsSync(bindingFilePath(dir)), false, "a git checkout must never get a .run402.json arrival write");

    // The pin lands in LOCAL git config.
    const orgPin = spawnSync("git", ["-C", dir, "config", "--local", "--get", "r402.orgId"], { encoding: "utf-8" });
    const roomPin = spawnSync("git", ["-C", dir, "config", "--local", "--get", "r402.room"], { encoding: "utf-8" });
    assert.equal(orgPin.stdout.trim(), ORG);
    assert.equal(roomPin.stdout.trim(), ROOM);

    // .run402/ is excluded from git via .git/info/exclude, never .gitignore.
    const excludePath = join(dir, ".git", "info", "exclude");
    const excludeContents = readFileSync(excludePath, "utf-8");
    assert.match(excludeContents, /^\.run402\/$/m);
    assert.equal(existsSync(join(dir, ".gitignore")), false, "the captured/tracked tree's .gitignore must never be touched");

    // The current org is set the same way as the non-git case.
    assert.equal(getSelectedOrgId(), ORG);

    // The cursor is persisted the same way as the non-git case.
    const state = getRoomState(ORG, ROOM, { cwd: dir });
    assert.equal(state.cursor, "mcr_arrival_1");
  });
});
