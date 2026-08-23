// Precedence, ambiguity, and provenance for the shared org resolver
// (add-cli-current-org). The chain is four INTENT CLASSES — flag, environment,
// binding, profile state — and inside each class a directly named org outranks
// one derived from a project named in that same class.
//
// This file pins the class table: a future reordering fails here loudly rather
// than silently changing which organization a command acts on.

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "run402-orgctx-"));
const configDir = join(tempDir, "config");
const API = "https://test-api.run402.com";

process.env.RUN402_CONFIG_DIR = configDir;
process.env.RUN402_API_BASE = API;

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const A = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb";
const BOUND = "cccccccc-3333-3333-3333-cccccccccccc";
const SELECTED = "dddddddd-4444-4444-4444-dddddddddddd";
const PROJECT_ORG = "eeeeeeee-5555-5555-5555-eeeeeeeeeeee";

const originalFetch = globalThis.fetch;
const originalError = console.error;
const originalExit = process.exit;

// Directory layout: bindingDir/.run402.json carries org+room; deep/ has none,
// so resolution must WALK UP to find it.
const bindingDir = join(tempDir, "checkout");
const deepDir = join(bindingDir, "packages", "api");
const bareDir = join(tempDir, "bare");

let orgCtx;
let errors = [];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function mockFetch(input) {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  if (url.includes("/projects/v1/")) return json({ org_id: PROJECT_ORG });
  return json({});
}

/** Run a resolution that is expected to call fail() → captures the envelope. */
async function expectFailure(fn) {
  errors = [];
  console.error = (...a) => errors.push(a.join(" "));
  try {
    await fn();
    return null;
  } catch (err) {
    if (!/process\.exit/.test(String(err?.message))) throw err;
    return JSON.parse(errors[errors.length - 1]);
  } finally {
    console.error = originalError;
  }
}

before(async () => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "allowance.json"), JSON.stringify({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }));
  mkdirSync(deepDir, { recursive: true });
  mkdirSync(bareDir, { recursive: true });
  writeFileSync(join(bindingDir, ".run402.json"), JSON.stringify({ org: BOUND, room: "my-repo", wallet: "bound-wallet" }));
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  orgCtx = await import("./cli/lib/org-context.mjs");
});

after(() => {
  console.error = originalError;
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => { orgCtx.clearSelectedOrgId(); });

describe("resolveOrg — class precedence", () => {
  it("a directly named org outranks every lower class", async () => {
    orgCtx.setSelectedOrgId(SELECTED);
    const r = await orgCtx.resolveOrg({ org: A }, { cwd: deepDir, env: { RUN402_ORG: B } });
    assert.equal(r.orgId, A);
    assert.equal(r.source, "flag");
    assert.equal(r.sourceDetail, "--org");
  });

  it("an explicitly addressed project decides the org over a profile selection", async () => {
    orgCtx.setSelectedOrgId(SELECTED);
    const r = await orgCtx.resolveOrg({ project: "prj_x" }, { cwd: bareDir, env: {} });
    assert.equal(r.orgId, PROJECT_ORG);
    assert.equal(r.source, "flag");
    assert.equal(r.sourceDetail, "--project");
  });

  it("a directly named org outranks a project in the SAME class", async () => {
    const r = await orgCtx.resolveOrg({ org: A, project: "prj_x" }, { cwd: bareDir, env: {} });
    assert.equal(r.orgId, A);
    assert.equal(r.sourceDetail, "--org");
  });

  it("environment outranks the profile selection", async () => {
    orgCtx.setSelectedOrgId(SELECTED);
    const r = await orgCtx.resolveOrg({}, { cwd: bareDir, env: { RUN402_ORG: A } });
    assert.equal(r.orgId, A);
    assert.equal(r.source, "env");
    assert.equal(r.sourceDetail, "RUN402_ORG");
  });

  it("reads the org half of the compound RUN402_ROOM form", async () => {
    const r = await orgCtx.resolveOrg({}, { cwd: bareDir, env: { RUN402_ROOM: `${A}/some-room` } });
    assert.equal(r.orgId, A);
    assert.equal(r.sourceDetail, "RUN402_ROOM");
  });

  it("RUN402_ORG outranks RUN402_ROOM's org half inside the env class", async () => {
    const r = await orgCtx.resolveOrg({}, { cwd: bareDir, env: { RUN402_ORG: A, RUN402_ROOM: `${B}/r` } });
    assert.equal(r.orgId, A);
    assert.equal(r.sourceDetail, "RUN402_ORG");
  });

  it("the binding walks up from a nested directory and outranks the profile selection", async () => {
    orgCtx.setSelectedOrgId(SELECTED);
    const r = await orgCtx.resolveOrg({}, { cwd: deepDir, env: {} });
    assert.equal(r.orgId, BOUND);
    assert.equal(r.source, "binding");
    assert.match(r.sourceDetail, /\.run402\.json$/);
  });

  it("falls through to the profile selection when nothing above supplies one", async () => {
    orgCtx.setSelectedOrgId(SELECTED);
    const r = await orgCtx.resolveOrg({}, { cwd: bareDir, env: {} });
    assert.equal(r.orgId, SELECTED);
    assert.equal(r.source, "profile");
    assert.equal(r.sourceDetail, "org use");
  });

  it("derives from the env-named project when no org is named directly", async () => {
    const r = await orgCtx.resolveOrg({}, { cwd: bareDir, env: { RUN402_PROJECT_ID: "prj_env" } });
    assert.equal(r.orgId, PROJECT_ORG);
    assert.equal(r.source, "env");
    assert.equal(r.sourceDetail, "RUN402_PROJECT_ID");
  });
});

describe("resolveOrg — ambiguity", () => {
  it("errors when the env and the binding name different orgs, naming both and their sources", async () => {
    const envelope = await expectFailure(() =>
      orgCtx.resolveOrg({}, { cwd: deepDir, env: { RUN402_ORG: A } }),
    );
    assert.equal(envelope.code, "AMBIGUOUS_ORG");
    const ids = envelope.details.candidates.map((c) => c.org_id);
    assert.deepEqual(ids.sort(), [A, BOUND].sort());
    const sources = envelope.details.candidates.map((c) => c.source).sort();
    assert.deepEqual(sources, ["binding", "env"]);
  });

  it("the flag resolves the conflict", async () => {
    const r = await orgCtx.resolveOrg({ org: B }, { cwd: deepDir, env: { RUN402_ORG: A } });
    assert.equal(r.orgId, B);
  });

  it("agreement is not a conflict", async () => {
    const r = await orgCtx.resolveOrg({}, { cwd: deepDir, env: { RUN402_ORG: BOUND } });
    assert.equal(r.orgId, BOUND);
    assert.equal(r.source, "env");
  });

  it("the org command family stays usable while ambiguous", async () => {
    const r = await orgCtx.resolveOrg({}, { cwd: deepDir, cmd: "org", env: { RUN402_ORG: A } });
    assert.equal(r.orgId, A);
  });

  it("a binding beats the profile selection SILENTLY — that is what a binding is for", async () => {
    orgCtx.setSelectedOrgId(SELECTED);
    const r = await orgCtx.resolveOrg({}, { cwd: deepDir, env: {} });
    assert.equal(r.orgId, BOUND);
  });
});

describe("resolveOrg — failure and validation", () => {
  it("fails with ORG_REQUIRED naming every way to supply one", async () => {
    const envelope = await expectFailure(() => orgCtx.resolveOrg({}, { cwd: bareDir, env: {} }));
    assert.equal(envelope.code, "ORG_REQUIRED");
    const commands = envelope.next_actions.map((n) => n.command).join(" | ");
    for (const form of ["org use", "--org", "RUN402_ORG", ".run402.json", "projects use"]) {
      assert.ok(commands.includes(form), `next_actions should offer ${form}, got: ${commands}`);
    }
  });

  it("does not infer the org from a sole membership", async () => {
    // The mock would happily answer GET /orgs/v1 with one org; resolution must
    // never consult memberships, so this is still ORG_REQUIRED.
    const envelope = await expectFailure(() => orgCtx.resolveOrg({}, { cwd: bareDir, env: {} }));
    assert.equal(envelope.code, "ORG_REQUIRED");
  });

  it("returns null instead of failing when optional", async () => {
    const r = await orgCtx.resolveOrg({}, { cwd: bareDir, env: {}, optional: true });
    assert.equal(r, null);
  });

  it("rejects a malformed org id, naming the offending source", async () => {
    const envelope = await expectFailure(() =>
      orgCtx.resolveOrg({ org: "not-a-uuid" }, { cwd: bareDir, env: {} }),
    );
    assert.equal(envelope.code, "BAD_ORG_ID");
    assert.equal(envelope.details.origin, "--org");
  });

  it("rejects a malformed org id in a binding file, naming the file", async () => {
    const badDir = join(tempDir, "badbinding");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, ".run402.json"), JSON.stringify({ org: "nope" }));
    const envelope = await expectFailure(() => orgCtx.resolveOrg({}, { cwd: badDir, env: {} }));
    assert.equal(envelope.code, "BAD_ORG_ID");
    assert.match(envelope.details.origin, /badbinding\/\.run402\.json$/);
  });
});

describe("selection is per wallet profile", () => {
  it("round-trips through the profile state", () => {
    orgCtx.setSelectedOrgId(SELECTED);
    assert.equal(orgCtx.getSelectedOrgId(), SELECTED);
    orgCtx.clearSelectedOrgId();
    assert.equal(orgCtx.getSelectedOrgId(), null);
  });

  it("never writes the selection to the base-level config.json", () => {
    orgCtx.setSelectedOrgId(SELECTED);
    let raw = "";
    try { raw = require("node:fs").readFileSync(join(configDir, "config.json"), "utf8"); } catch { raw = ""; }
    assert.ok(!raw.includes(SELECTED), "the org selection must live in per-profile state, not config.json");
  });

  it("reports provenance as a bounded pair", async () => {
    orgCtx.setSelectedOrgId(SELECTED);
    const resolved = await orgCtx.resolveOrg({}, { cwd: bareDir, env: {} });
    assert.deepEqual(Object.keys(orgCtx.orgProvenance(resolved)).sort(), ["org_id", "org_source", "org_source_detail"]);
    assert.deepEqual(orgCtx.orgProvenance(null), { org_id: null, org_source: null, org_source_detail: null });
  });
});

describe("binding keys resolve independently", () => {
  it("a file carrying only org leaves wallet resolution to its own chain", async () => {
    const orgOnly = join(tempDir, "orgonly");
    mkdirSync(orgOnly, { recursive: true });
    writeFileSync(join(orgOnly, ".run402.json"), JSON.stringify({ org: A }));
    const { findBindingKey } = await import("./cli/lib/wallet-context.mjs");
    assert.equal(findBindingKey(orgOnly, "org").value, A);
    assert.equal(findBindingKey(orgOnly, "wallet"), null);
  });

  it("each key resolves at the nearest file carrying it", async () => {
    const { findBindingKey } = await import("./cli/lib/wallet-context.mjs");
    const child = join(bindingDir, "child");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, ".run402.json"), JSON.stringify({ wallet: "child-wallet" }));
    assert.equal(findBindingKey(child, "wallet").value, "child-wallet");
    assert.equal(findBindingKey(child, "org").value, BOUND); // walked up past the child
  });

  it(".run402.local.json overrides the committed binding", async () => {
    const { findBindingKey } = await import("./cli/lib/wallet-context.mjs");
    const overridden = join(tempDir, "overridden");
    mkdirSync(overridden, { recursive: true });
    writeFileSync(join(overridden, ".run402.json"), JSON.stringify({ org: A }));
    writeFileSync(join(overridden, ".run402.local.json"), JSON.stringify({ org: B }));
    assert.equal(findBindingKey(overridden, "org").value, B);
  });
});

describe("one resolver serves every org-scoped family", () => {
  it("rooms and escalations resolve identically from identical inputs", async () => {
    const { resolveRoom } = await import("./cli/lib/rooms-context.mjs");
    const prevCwd = process.cwd();
    process.chdir(bindingDir); // resolveRoom reads the binding from process.cwd()
    try {
      const viaRooms = await resolveRoom({});
      const viaEscalations = await orgCtx.resolveOrg([], { cwd: bindingDir, env: {} });
      assert.equal(viaRooms.orgId, viaEscalations.orgId);
      assert.equal(viaRooms.orgSource, viaEscalations.source);
      // ...and the room half came from the SAME binding file.
      assert.equal(viaRooms.roomKey, "my-repo");
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("a room key alone reaches a named room once the org resolves", async () => {
    const { resolveRoom } = await import("./cli/lib/rooms-context.mjs");
    const prevCwd = process.cwd();
    process.chdir(bareDir); // no binding here: the org comes from the profile
    orgCtx.setSelectedOrgId(SELECTED);
    try {
      const room = await resolveRoom({ room: "named-room" });
      assert.equal(room.orgId, SELECTED);
      assert.equal(room.roomKey, "named-room");
      assert.equal(room.orgSource, "profile");
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("the compound RUN402_ROOM form still outranks the chain", async () => {
    const { resolveRoom } = await import("./cli/lib/rooms-context.mjs");
    const prevCwd = process.cwd();
    process.chdir(bindingDir);
    process.env.RUN402_ROOM = `${A}/from-env`;
    try {
      const room = await resolveRoom({});
      assert.equal(room.orgId, A, "RUN402_ROOM must beat the binding file");
      assert.equal(room.roomKey, "from-env");
    } finally {
      delete process.env.RUN402_ROOM;
      process.chdir(prevCwd);
    }
  });
});

describe("org use / current / clear", () => {
  it("use persists, current reports with provenance, clear empties it truthfully", async () => {
    const { run: runOrg } = await import("./cli/lib/org.mjs");
    const out = [];
    const originalLog = console.log;
    console.log = (...a) => out.push(a.join(" "));
    const prevCwd = process.cwd();
    process.chdir(bareDir);
    try {
      await runOrg("use", [SELECTED]);
      assert.equal(JSON.parse(out[0]).org_id, SELECTED);
      assert.equal(JSON.parse(out[0]).scope, "wallet_profile");

      await runOrg("current", []);
      const current = JSON.parse(out[1]);
      assert.equal(current.org_id, SELECTED);
      assert.equal(current.org_source, "profile");
      assert.equal(current.selected_org_id, SELECTED);

      await runOrg("clear", []);
      assert.equal(JSON.parse(out[2]).org_id, null);
      assert.equal(JSON.parse(out[2]).previous_org_id, SELECTED);

      // An empty selection is an explicit null state, never an invented default.
      await runOrg("current", []);
      const empty = JSON.parse(out[3]);
      assert.equal(empty.org_id, null);
      assert.equal(empty.selected_org_id, null);
    } finally {
      console.log = originalLog;
      process.chdir(prevCwd);
    }
  });
});

describe("the Agent Trace recovery paths, end to end", () => {
  it("ORG_REQUIRED -> org use -> the same call succeeds", async () => {
    // 1. Nothing configured: the wall names every way forward.
    const envelope = await expectFailure(() => orgCtx.resolveOrg({}, { cwd: bareDir, env: {} }));
    assert.equal(envelope.code, "ORG_REQUIRED");
    const recovery = envelope.next_actions.find((n) => n.command?.startsWith("run402 org use"));
    assert.ok(recovery, "the wall must offer `org use` as a recovery action");

    // 2. Take the offered action.
    orgCtx.setSelectedOrgId(SELECTED);

    // 3. The ORIGINAL call now succeeds, unchanged.
    const r = await orgCtx.resolveOrg({}, { cwd: bareDir, env: {} });
    assert.equal(r.orgId, SELECTED);
  });

  it("stale RUN402_ORG vs a binding -> AMBIGUOUS_ORG -> --org resolves it", async () => {
    // 1. A shell exported for another repo, inside a bound checkout.
    const envelope = await expectFailure(() =>
      orgCtx.resolveOrg({}, { cwd: deepDir, env: { RUN402_ORG: A } }),
    );
    assert.equal(envelope.code, "AMBIGUOUS_ORG");
    const flagAction = envelope.next_actions.find((n) => n.command?.includes("--org"));
    assert.ok(flagAction, "the conflict must name the flag as the resolver");

    // 2. Take the offered action; provenance confirms which source won.
    const r = await orgCtx.resolveOrg({ org: BOUND }, { cwd: deepDir, env: { RUN402_ORG: A } });
    assert.equal(r.orgId, BOUND);
    assert.equal(r.source, "flag");
  });
});

describe("an authorization failure is the server's answer, not a retry", () => {
  it("an explicitly named project that the caller cannot read stops the chain", async () => {
    orgCtx.setSelectedOrgId(SELECTED); // a LOWER class that could paper over the failure
    const previous = globalThis.fetch;
    globalThis.fetch = async () => json({ error: "forbidden" }, 403);
    try {
      await assert.rejects(
        () => orgCtx.resolveOrg({ project: "prj_forbidden" }, { cwd: bareDir, env: {} }),
        "a named project the caller cannot read must surface, not fall through to the profile selection",
      );
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("an IMPLICITLY selected project that no longer resolves falls through, as designed", async () => {
    // The asymmetry is deliberate: a project the caller NAMED is a hard stop; a
    // stale active project is just a class that supplies nothing.
    const previous = globalThis.fetch;
    globalThis.fetch = async () => json({ error: "forbidden" }, 403);
    try {
      orgCtx.setSelectedOrgId(SELECTED);
      const r = await orgCtx.resolveOrg({}, { cwd: bareDir, env: { RUN402_PROJECT_ID: "prj_stale" } });
      assert.equal(r.orgId, SELECTED);
      assert.equal(r.source, "profile");
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe("state.json stays readable by an older CLI", () => {
  it("the new key does not disturb the active-project state an older reader uses", async () => {
    const { loadProfileState, setActiveProjectId, getActiveProjectId } =
      await import("./cli/core-dist/profile-state.js");
    setActiveProjectId("prj_older");
    orgCtx.setSelectedOrgId(SELECTED);

    // An older binary reads active_projects / active_project_id and knows
    // nothing about active_orgs — that must still resolve.
    assert.equal(getActiveProjectId(), "prj_older");
    const raw = loadProfileState();
    assert.ok(raw.active_orgs, "the new key is written");
    assert.ok(raw.active_projects || raw.active_project_id, "the old keys are untouched");

    // And the reverse: a state.json written by an OLDER CLI (no active_orgs)
    // reads back as simply having no selection, never as a crash.
    const { saveProfileState } = await import("./cli/core-dist/profile-state.js");
    saveProfileState({ active_project_id: "prj_from_old_cli" });
    assert.equal(orgCtx.getSelectedOrgId(), null);
    assert.equal(getActiveProjectId(), "prj_from_old_cli");
  });
});
