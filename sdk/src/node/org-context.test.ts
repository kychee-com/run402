/**
 * Organization context on `@run402/sdk/node` (code-mode MCP, task 1.6): the
 * one resolver (`r.orgs.resolve`) and the `use | current | clear | bind |
 * unbind` verbs. Ported from the CLI's `cli-org-context.test.mjs`, which now
 * drives the same implementation through `run402 orgs …`. The class table is
 * pinned here: a reordering fails loudly instead of silently changing which
 * organization a command acts on.
 */

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run402, type NodeRun402 } from "./index.js";
import type { LocalError } from "../errors.js";

const A = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb";
const BOUND = "cccccccc-3333-3333-3333-cccccccccccc";
const SELECTED = "dddddddd-4444-4444-4444-dddddddddddd";
const PROJECT_ORG = "eeeeeeee-5555-5555-5555-eeeeeeeeeeee";
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const saved: Record<string, string | undefined> = {};
const KEYS = ["RUN402_CONFIG_DIR", "RUN402_API_BASE", "RUN402_WALLET", "RUN402_ORG", "RUN402_ROOM", "RUN402_PROJECT_ID"];
let tempDir: string;
let bindingDir: string;
let deepDir: string;
let bareDir: string;
let responder: (url: string) => Response = defaultResponder;
let orgListing: Array<{ org_id: string; display_name?: string; role?: string }> = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function defaultResponder(url: string): Response {
  if (url.includes("/projects/v1/")) return json({ org_id: PROJECT_ORG });
  if (/\/orgs\/v1(\?|$)/.test(url)) return json({ orgs: orgListing });
  return json({});
}

const fetchImpl = (async (input: RequestInfo | URL) => responder(String(input))) as typeof globalThis.fetch;
let r: NodeRun402;

before(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  tempDir = mkdtempSync(join(tmpdir(), "run402-sdk-orgctx-"));
  const configDir = join(tempDir, "config");
  process.env.RUN402_CONFIG_DIR = configDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  delete process.env.RUN402_WALLET;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "wallet.json"), JSON.stringify({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }));
  bindingDir = join(tempDir, "checkout");
  deepDir = join(bindingDir, "packages", "api");
  bareDir = join(tempDir, "bare");
  mkdirSync(deepDir, { recursive: true });
  mkdirSync(bareDir, { recursive: true });
  writeFileSync(join(bindingDir, ".run402.json"), JSON.stringify({ org: BOUND, room: "my-repo", wallet: "bound-wallet" }));
  r = run402({ surface: "cli", fetch: fetchImpl, apiBase: "https://test-api.run402.com" });
});

after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  responder = defaultResponder;
  orgListing = [];
  await r.orgs.clear();
});

async function rejectsWith(p: Promise<unknown>, code: string): Promise<LocalError> {
  let caught: unknown;
  await assert.rejects(p, (err: unknown) => {
    caught = err;
    return (err as LocalError)?.code === code;
  });
  return caught as LocalError;
}

describe("r.orgs.resolve — class precedence", () => {
  it("a directly named org outranks every lower class", async () => {
    await r.orgs.use(SELECTED);
    assert.deepEqual(await r.orgs.resolve({ org: A }, { cwd: deepDir, env: { RUN402_ORG: B } }), { orgId: A, source: "flag", sourceDetail: "--org" });
  });

  it("an explicitly named project decides the org over the profile selection", async () => {
    await r.orgs.use(SELECTED);
    assert.deepEqual(await r.orgs.resolve({ project: "prj_x" }, { cwd: bareDir, env: {} }), { orgId: PROJECT_ORG, source: "flag", sourceDetail: "--project" });
  });

  it("environment outranks the profile, and RUN402_ORG outranks RUN402_ROOM's org half", async () => {
    await r.orgs.use(SELECTED);
    assert.equal((await r.orgs.resolve({}, { cwd: bareDir, env: { RUN402_ORG: A } }))?.sourceDetail, "RUN402_ORG");
    assert.deepEqual(await r.orgs.resolve({}, { cwd: bareDir, env: { RUN402_ROOM: `${A}/some-room` } }), { orgId: A, source: "env", sourceDetail: "RUN402_ROOM" });
    assert.equal((await r.orgs.resolve({}, { cwd: bareDir, env: { RUN402_ORG: A, RUN402_ROOM: `${B}/r` } }))?.orgId, A);
  });

  it("the binding walks up from a nested directory and outranks the profile selection", async () => {
    await r.orgs.use(SELECTED);
    const got = await r.orgs.resolve({}, { cwd: deepDir, env: {} });
    assert.equal(got?.orgId, BOUND);
    assert.equal(got?.source, "binding");
  });

  it("falls through to the profile selection, then derives from the env-named project", async () => {
    await r.orgs.use(SELECTED);
    assert.deepEqual(await r.orgs.resolve({}, { cwd: bareDir, env: {} }), { orgId: SELECTED, source: "profile", sourceDetail: "orgs use" });
    await r.orgs.clear();
    assert.deepEqual(await r.orgs.resolve({}, { cwd: bareDir, env: { RUN402_PROJECT_ID: "prj_env" } }), { orgId: PROJECT_ORG, source: "env", sourceDetail: "RUN402_PROJECT_ID" });
  });
});

describe("r.orgs.resolve — ambiguity, failure, validation", () => {
  it("env vs binding naming different orgs is AMBIGUOUS_ORG naming both, unless allowed", async () => {
    const err = await rejectsWith(r.orgs.resolve({}, { cwd: deepDir, env: { RUN402_ORG: A } }), "AMBIGUOUS_ORG");
    const candidates = (err.details as { candidates: Array<{ org_id: string; source: string }> }).candidates;
    assert.deepEqual(candidates.map((c) => c.source), ["env", "binding"]);
    assert.ok(err.nextActions?.some((a) => a.command?.includes("--org")));
    assert.equal((await r.orgs.resolve({}, { cwd: deepDir, env: { RUN402_ORG: A }, allowConflict: true }))?.orgId, A);
    assert.equal((await r.orgs.resolve({ org: BOUND }, { cwd: deepDir, env: { RUN402_ORG: A } }))?.orgId, BOUND);
    assert.equal((await r.orgs.resolve({}, { cwd: deepDir, env: { RUN402_ORG: BOUND } }))?.orgId, BOUND);
  });

  it("ORG_REQUIRED names every way to supply one, and never infers a sole membership", async () => {
    orgListing = [{ org_id: A }];
    const err = await rejectsWith(r.orgs.resolve({}, { cwd: bareDir, env: {} }), "ORG_REQUIRED");
    const commands = (err.nextActions ?? []).map((n) => n.command).join(" | ");
    for (const form of ["orgs use", "--org", "RUN402_ORG", ".run402.json", "projects use"]) {
      assert.ok(commands.includes(form), `next_actions should offer ${form}, got: ${commands}`);
    }
    assert.equal(await r.orgs.resolve({}, { cwd: bareDir, env: {}, optional: true }), null);
  });

  it("rejects a malformed org id naming its source, redacting a secret-shaped one", async () => {
    const flag = await rejectsWith(r.orgs.resolve({ org: "not-a-uuid" }, { cwd: bareDir, env: {} }), "BAD_ORG_ID");
    assert.equal((flag.details as { origin: string; org_id: string }).origin, "--org");
    assert.equal((flag.details as { org_id: string }).org_id, "not-a-uuid");
    const badDir = join(tempDir, "badbinding");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, ".run402.json"), JSON.stringify({ org: "nope" }));
    const bound = await rejectsWith(r.orgs.resolve({}, { cwd: badDir, env: {} }), "BAD_ORG_ID");
    assert.match((bound.details as { origin: string }).origin, /badbinding\/\.run402\.json$/);
    const privateKey = "0x" + "22a3f0".repeat(11);
    const secret = await rejectsWith(r.orgs.resolve({ org: privateKey }, { cwd: bareDir, env: {} }), "BAD_ORG_ID");
    assert.ok(!JSON.stringify({ ...secret.toJSON(), message: secret.message }).includes("22a3f0"));
  });

  it("a named project the caller cannot read stops the chain; an implicit one falls through", async () => {
    await r.orgs.use(SELECTED);
    responder = () => json({ error: "forbidden" }, 403);
    await assert.rejects(r.orgs.resolve({ project: "prj_forbidden" }, { cwd: bareDir, env: {} }));
    assert.deepEqual(await r.orgs.resolve({}, { cwd: bareDir, env: { RUN402_PROJECT_ID: "prj_stale" } }), { orgId: SELECTED, source: "profile", sourceDetail: "orgs use" });
  });
});

describe("r.orgs.use / current / clear", () => {
  it("use persists, current reports with provenance, clear empties it truthfully", async () => {
    assert.deepEqual(await r.orgs.use(SELECTED), { org_id: SELECTED, selected: true, scope: "wallet_profile" });
    assert.deepEqual(await r.orgs.current({ cwd: bareDir, env: {} }), {
      org_id: SELECTED, org_source: "profile", org_source_detail: "orgs use", selected_org_id: SELECTED,
    });
    assert.deepEqual(await r.orgs.clear(), { org_id: null, selected: false, previous_org_id: SELECTED });
    assert.deepEqual(await r.orgs.current({ cwd: bareDir, env: {} }), {
      org_id: null, org_source: null, org_source_detail: null, selected_org_id: null,
    });
    await rejectsWith(r.orgs.use("not-a-uuid"), "BAD_ORG_ID");
  });

  it("current stays usable while the selection is ambiguous", async () => {
    const cur = await r.orgs.current({ cwd: deepDir, env: { RUN402_ORG: A } });
    assert.equal(cur.org_id, A);
    assert.equal(cur.org_source, "env");
  });
});

describe("r.orgs.bind / unbind — the bootstrap, not the chain", () => {
  it("merges org and room into the binding file without clobbering a wallet key", async () => {
    const dir = join(tempDir, "bind-merge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".run402.json"), JSON.stringify({ wallet: "w" }));
    const bound = await r.orgs.bind(A, { room: "dev", cwd: dir });
    assert.equal(bound.org_source, "flag");
    assert.equal(bound.room_key, "dev");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".run402.json"), "utf8")), { wallet: "w", org: A, room: "dev" });
    const unbound = await r.orgs.unbind({ cwd: dir });
    assert.equal(unbound.unbound, true);
    assert.deepEqual(unbound.binding, { wallet: "w" });
  });

  it("with no org, binds the sole membership and derives the room from the directory", async () => {
    const dir = join(tempDir, "My Repo!");
    mkdirSync(dir, { recursive: true });
    orgListing = [{ org_id: B, display_name: "b", role: "owner" }];
    const bound = await r.orgs.bind(null, { cwd: dir });
    assert.equal(bound.org_id, B);
    assert.equal(bound.org_source, "sole_membership");
    assert.equal(bound.room_key, "my-repo-");
    assert.equal((await r.orgs.resolve({}, { cwd: dir, env: {} }))?.orgId, B, "what bind writes is what the chain reads");
    const cleared = await r.orgs.unbind({ cwd: dir });
    assert.equal(cleared.removed, true);
    assert.ok(!existsSync(join(dir, ".run402.json")));
  });

  it("refuses to pick among several memberships, or none", async () => {
    const dir = join(tempDir, "bind-refuse");
    mkdirSync(dir, { recursive: true });
    orgListing = [{ org_id: A }, { org_id: B }];
    const ambiguous = await rejectsWith(r.orgs.bind(null, { cwd: dir }), "AMBIGUOUS_ORG");
    assert.equal((ambiguous.details as { orgs: unknown[] }).orgs.length, 2);
    orgListing = [];
    await rejectsWith(r.orgs.bind(null, { cwd: dir }), "NO_ORGS");
    assert.ok(!existsSync(join(dir, ".run402.json")));
  });
});

describe("r.orgs.selectFromProject / owningOrgOf", () => {
  it("stamps a project's owning org as the profile selection", async () => {
    assert.equal(await r.orgs.selectFromProject("prj_x"), PROJECT_ORG);
    assert.equal(r.orgs.selected(), PROJECT_ORG);
  });

  it("finds a project's owner in the listing, exactly", async () => {
    responder = (url) => (url.includes("/projects/v1") ? json({ projects: [{ id: "prj_owned", org_id: A }, { id: "prj_owned_2", org_id: B }] }) : json({}));
    assert.equal(await r.orgs.owningOrgOf("prj_owned"), A);
    assert.equal(await r.orgs.owningOrgOf("prj_owned_"), null);
  });
});
