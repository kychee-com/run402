/**
 * Room addressing for the MCP tools, including the ambient fallback.
 *
 * Two properties matter beyond the precedence itself:
 *
 *   1. Nothing here may exit. The CLI's equivalent resolver calls `fail()`,
 *      which is `process.exit(1)` — correct for a one-shot command, fatal in a
 *      long-lived MCP server where it would kill every subsequent tool call.
 *      That is why this is a separate implementation rather than a reuse, and
 *      the reason is worth a test rather than only a comment.
 *   2. Explicit addressing keeps outranking the ambient chain. A tool call that
 *      names a room must reach that room even in a bound checkout, or a harness
 *      wired for one room silently starts talking in another.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRoomArgs } from "./rooms-shared.js";

const ORG_A = "57035b1e-ec41-4ce6-a7a5-a5b2560efdd7";
const ORG_B = "11111111-1111-4111-8111-111111111111";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "r402-rooms-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const bind = (obj: Record<string, string>, at = dir, file = ".run402.json") =>
  writeFileSync(join(at, file), JSON.stringify(obj));

/** No RUN402_* leaking in from the real environment, and no profile selection. */
const CLEAN: NodeJS.ProcessEnv = {};

describe("resolveRoomArgs — explicit addressing", () => {
  it("org_id + room_key wins outright", async () => {
    bind({ org: ORG_B, room: "bound-room" });
    const r = await resolveRoomArgs(
      { org_id: ORG_A, room_key: "named" },
      { cwd: dir, env: { RUN402_ROOM: `${ORG_B}/env-room` } },
    );
    assert.deepEqual(r, { ok: true, room: { orgId: ORG_A, roomKey: "named" } });
  });

  it("half a pair is still an error, not an ambient fallback", async () => {
    // Passing only room_key reads as an incomplete explicit address, not as
    // "use my binding" — guessing which the caller meant would be worse.
    bind({ org: ORG_A, room: "bound-room" });
    const r = await resolveRoomArgs({ room_key: "named" }, { cwd: dir, env: CLEAN });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /go together/);
  });

  it("project_id together with either half is refused", async () => {
    const r = await resolveRoomArgs({ project_id: "prj_1", org_id: ORG_A }, { cwd: dir, env: CLEAN });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /not both/);
  });
});

describe("resolveRoomArgs — the ambient chain (#550)", () => {
  it("RUN402_ROOM names both halves and outranks the binding", async () => {
    bind({ org: ORG_A, room: "bound-room" });
    const r = await resolveRoomArgs({}, { cwd: dir, env: { RUN402_ROOM: `${ORG_B}/env-room` } });
    assert.deepEqual(r, { ok: true, room: { orgId: ORG_B, roomKey: "env-room" } });
  });

  it("a malformed RUN402_ROOM is a returned error, never a guess", async () => {
    const r = await resolveRoomArgs({}, { cwd: dir, env: { RUN402_ROOM: "no-slash" } });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /<org_id>\/<room_key>/);
    // Short, plainly-not-a-secret values are still shown in full.
    assert.match((r as { error: string }).error, /no-slash/);
  });

  // RUN402_WALLET took a name field and got a
  // private key by mistake. RUN402_ROOM is the same shape of risk — a value
  // that fails this check must never be echoed, however long or key-shaped.
  it("never echoes a secret-shaped RUN402_ROOM", async () => {
    const privateKey = "0x" + "22a3f0".repeat(11); // 66 chars, no slash — malformed
    const r = await resolveRoomArgs({}, { cwd: dir, env: { RUN402_ROOM: privateKey } });
    assert.equal(r.ok, false);
    const error = (r as { error: string }).error;
    assert.ok(!error.includes(privateKey));
    assert.ok(!error.includes("22a3f0"));
  });

  it("a bound checkout reaches its room with no parameters at all", async () => {
    // The driving case: two agents in one repo, neither passing anything.
    bind({ org: ORG_A, room: "run402-dev" });
    const r = await resolveRoomArgs({}, { cwd: dir, env: CLEAN });
    assert.deepEqual(r, { ok: true, room: { orgId: ORG_A, roomKey: "run402-dev" } });
  });

  it("the binding walks UP, so a worktree inherits its parent's binding", async () => {
    bind({ org: ORG_A, room: "run402-dev" });
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    const r = await resolveRoomArgs({}, { cwd: nested, env: CLEAN });
    assert.deepEqual(r, { ok: true, room: { orgId: ORG_A, roomKey: "run402-dev" } });
  });

  it(".run402.local.json overrides the committed binding", async () => {
    bind({ org: ORG_A, room: "committed" });
    bind({ room: "personal" }, dir, ".run402.local.json");
    const r = await resolveRoomArgs({}, { cwd: dir, env: CLEAN });
    assert.deepEqual(r, { ok: true, room: { orgId: ORG_A, roomKey: "personal" } });
  });

  it("RUN402_ORG supplies the org half for a bound room key", async () => {
    bind({ room: "run402-dev" });
    const r = await resolveRoomArgs({}, { cwd: dir, env: { RUN402_ORG: ORG_A } });
    assert.deepEqual(r, { ok: true, room: { orgId: ORG_A, roomKey: "run402-dev" } });
  });

  it("an env org contradicting a bound org STOPS rather than picking one", async () => {
    // An ambient variable disagreeing with a committed file is the surprise
    // worth refusing. A binding outranking the profile stays silent — that is
    // what a binding is for — but this pair is a genuine ambiguity.
    bind({ org: ORG_A, room: "run402-dev" });
    const r = await resolveRoomArgs({}, { cwd: dir, env: { RUN402_ORG: ORG_B } });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /Ambiguous organization/);
    // A normal (if wrong) org id is still shown in full — that's what makes
    // the error useful for spotting an actual mismatch.
    assert.match((r as { error: string }).error, new RegExp(ORG_B));
  });

  // This resolver does no shape validation on RUN402_ORG (unlike the CLI's
  // assertOrgIdShape) — it only compares against the binding — so a
  // secret-shaped env value reaches this echo completely unvalidated.
  it("never echoes a secret-shaped RUN402_ORG via the ambiguity path", async () => {
    bind({ org: ORG_A, room: "run402-dev" });
    const privateKey = "0x" + "22a3f0".repeat(11); // 66 chars, disagrees with ORG_A
    const r = await resolveRoomArgs({}, { cwd: dir, env: { RUN402_ORG: privateKey } });
    assert.equal(r.ok, false);
    const error = (r as { error: string }).error;
    assert.match(error, /Ambiguous organization/);
    assert.ok(!error.includes(privateKey));
    assert.ok(!error.includes("22a3f0"));
  });

  it("naming the room explicitly resolves that ambiguity", async () => {
    bind({ org: ORG_A, room: "run402-dev" });
    const r = await resolveRoomArgs(
      { org_id: ORG_B, room_key: "explicit" },
      { cwd: dir, env: { RUN402_ORG: ORG_B } },
    );
    assert.deepEqual(r, { ok: true, room: { orgId: ORG_B, roomKey: "explicit" } });
  });

  it("a room key with no resolvable org reports how to address one", async () => {
    bind({ room: "run402-dev" });
    const r = await resolveRoomArgs({}, { cwd: dir, env: CLEAN });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /Address the room/);
    assert.match((r as { error: string }).error, /\.run402\.json/);
  });

  it("nothing bound anywhere still returns the addressing hint", async () => {
    const r = await resolveRoomArgs({}, { cwd: dir, env: CLEAN });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /project_id/);
    assert.match((r as { error: string }).error, /RUN402_ROOM/);
  });
});

describe("resolveRoomArgs never exits the server", () => {
  it("every failing shape RETURNS — a long-lived server survives all of them", async () => {
    // The CLI's resolver would process.exit on several of these. In an MCP
    // server that is not a failed call, it is a dead server.
    const original = process.exit;
    let exited = false;
    // @ts-expect-error deliberately replacing for the duration of the check
    process.exit = () => { exited = true; throw new Error("process.exit was called"); };
    try {
      for (const [args, env] of [
        [{}, CLEAN],
        [{ room_key: "x" }, CLEAN],
        [{ org_id: ORG_A }, CLEAN],
        [{ project_id: "p", org_id: ORG_A }, CLEAN],
        [{}, { RUN402_ROOM: "malformed" }],
      ] as Array<[Record<string, string>, NodeJS.ProcessEnv]>) {
        const r = await resolveRoomArgs(args, { cwd: dir, env });
        assert.equal(r.ok, false);
        assert.ok(typeof (r as { error: string }).error === "string");
      }
      // And the ambiguity case, which is the one the CLI hard-stops on.
      bind({ org: ORG_A, room: "r" });
      const amb = await resolveRoomArgs({}, { cwd: dir, env: { RUN402_ORG: ORG_B } });
      assert.equal(amb.ok, false);
    } finally {
      process.exit = original;
    }
    assert.equal(exited, false, "resolveRoomArgs must never call process.exit");
  });
});
