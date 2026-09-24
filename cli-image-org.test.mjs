// `run402 image generate` and the paying organization on the Lightning rail.
//
// The gateway's `POST /generate-image/v1` over MPP Lightning refuses a
// principal that belongs to several organizations with
// `400 ORGANIZATION_SELECTION_REQUIRED` unless the body names `org_id`. The
// CLI derives it from the ONE shared org chain when `--org` is absent
// (`resolveOrg`: env, binding, `orgs use`, the active project's owning org) and
// never refuses an x402 purchase for lacking one. This file pins:
//   - no --org, a current org (`orgs use`)          → body carries org_id
//   - no --org, an active project with a cached org → body carries that org
//   - no --org, no context                          → body carries NO org_id
//   - --org                                         → the flag wins
//   - a selection refusal the SDK could not resolve → hint names --org and
//     lists the candidates, one request only

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "run402-image-org-"));
const configDir = join(tempDir, "config");
const bareDir = join(tempDir, "bare");
const API = "https://test-api.run402.com";

process.env.RUN402_CONFIG_DIR = configDir;
process.env.RUN402_API_BASE = API;
delete process.env.RUN402_ORG;
delete process.env.RUN402_ROOM;
delete process.env.RUN402_PROJECT_ID;

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const ORG_A = "2002f5ec-69af-4b3c-a576-5c1fe6d1bdfe";
const ORG_B = "57035b1e-ec41-4ce6-a7a5-a5b2560efdd7";
const ORG_FLAG = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalCwd = process.cwd();

let imageCalls = [];
let stdout = [];
let stderr = [];
let imageResponder = () => imageOk();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function imageOk() {
  return json({ image: "aW1n", content_type: "image/png", aspect: "square" });
}

function selectionRequired(ids) {
  return json({
    error: "org_id is required for this principal",
    message: "org_id is required for this principal",
    code: "ORGANIZATION_SELECTION_REQUIRED",
    category: "billing",
    details: { org_ids: ids, funds_moved: false },
    next_actions: [{ type: "edit_request", why: "Correct the request and retry before payment." }],
  }, 400);
}

async function mockFetch(input, init) {
  const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
  const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
  let rawBody = init?.body;
  if (rawBody === undefined && input instanceof Request) {
    try { rawBody = await input.clone().text(); } catch { rawBody = undefined; }
  }
  const body = typeof rawBody === "string" && rawBody.length > 0 ? JSON.parse(rawBody) : null;
  const path = url.startsWith(API) ? url.slice(API.length) : url;
  if (path === "/generate-image/v1" && method === "POST") {
    imageCalls.push(body);
    return imageResponder(imageCalls.length);
  }
  if (path.startsWith("/projects/v1/")) return json({ org_id: ORG_A });
  return json({});
}

function captureStart() {
  stdout = [];
  stderr = [];
  console.log = (...a) => stdout.push(a.join(" "));
  console.error = (...a) => stderr.push(a.join(" "));
}

function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

/** Run the command; a `fail()` exit is captured and its envelope returned, success returns null. */
async function runImage(args) {
  const { run } = await import("./cli/lib/image.mjs");
  captureStart();
  try {
    await run("generate", args);
    return null;
  } catch (err) {
    if (!/process\.exit/.test(String(err?.message))) throw err;
    return JSON.parse(stderr[stderr.length - 1]);
  } finally {
    captureStop();
  }
}

let orgs;
let config;
let keystore;

before(async () => {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(bareDir, { recursive: true });
  writeFileSync(join(configDir, "wallet.json"), JSON.stringify({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }));
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  process.chdir(bareDir);
  const { getSdk } = await import("./cli/lib/sdk.mjs");
  orgs = () => getSdk().orgs;
  config = await import("./cli/lib/config.mjs");
  keystore = await import("./cli/core-dist/keystore.js");
});

after(() => {
  process.chdir(originalCwd);
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  imageCalls = [];
  imageResponder = () => imageOk();
  await orgs().clear();
  for (const id of ["prj_active", "prj_other"]) {
    try { config.removeProject(id); } catch { /* absent */ }
    try { keystore.clearActiveProjectId(id); } catch { /* absent */ }
  }
});

describe("image generate — the paying organization", () => {
  it("sends no org_id when nothing names one (x402 behaviour unchanged)", async () => {
    const envelope = await runImage(["a cat"]);
    assert.equal(envelope, null, stderr.join("\n"));
    assert.deepEqual(imageCalls, [{ prompt: "a cat", aspect: "square" }]);
    assert.match(stdout.join("\n"), /"content_type":"image\/png"/);
  });

  it("derives org_id from the profile's current organization (org use)", async () => {
    await orgs().use(ORG_B);
    const envelope = await runImage(["a cat"]);
    assert.equal(envelope, null, stderr.join("\n"));
    assert.deepEqual(imageCalls, [{ prompt: "a cat", aspect: "square", org_id: ORG_B }]);
  });

  it("derives org_id from the active project's cached owning org", async () => {
    config.saveProject("prj_active", { anon_key: "a", service_key: "s", org_id: ORG_A });
    config.setActiveProjectId("prj_active");
    const envelope = await runImage(["a cat"]);
    assert.equal(envelope, null, stderr.join("\n"));
    assert.deepEqual(imageCalls, [{ prompt: "a cat", aspect: "square", org_id: ORG_A }]);
  });

  it("resolves the active project's owning org over the wire when it is not cached", async () => {
    config.saveProject("prj_active", { anon_key: "a", service_key: "s" });
    config.setActiveProjectId("prj_active");
    const envelope = await runImage(["a cat"]);
    assert.equal(envelope, null, stderr.join("\n"));
    assert.deepEqual(imageCalls, [{ prompt: "a cat", aspect: "square", org_id: ORG_A }]);
  });

  it("--org outranks every derived context", async () => {
    await orgs().use(ORG_B);
    const envelope = await runImage(["a cat", "--org", ORG_FLAG]);
    assert.equal(envelope, null, stderr.join("\n"));
    assert.deepEqual(imageCalls, [{ prompt: "a cat", aspect: "square", org_id: ORG_FLAG }]);
  });

  it("a malformed --org is refused before any request", async () => {
    const envelope = await runImage(["a cat", "--org", "not-a-uuid"]);
    assert.equal(envelope.code, "BAD_ORG_ID");
    assert.equal(imageCalls.length, 0);
  });

  it("an unresolved selection refusal names --org and lists the candidates", async () => {
    imageResponder = () => selectionRequired([ORG_A, ORG_B]);
    const envelope = await runImage(["a cat"]);
    assert.equal(envelope.code, "ORGANIZATION_SELECTION_REQUIRED");
    assert.deepEqual(envelope.details.org_ids, [ORG_A, ORG_B]);
    assert.match(envelope.hint, /--org <org_id>/);
    assert.match(envelope.hint, new RegExp(ORG_A));
    assert.ok(envelope.next_actions.some((a) => /--org <org_id>/.test(a.command ?? "")), "next action names --org");
    assert.equal(imageCalls.length, 1, "no blind retry without a matching local context");
  });

  it("the SDK retry lands on a stored project's org the CLI chain does not consult", async () => {
    // No current org and no active project, so the CLI sends nothing; the
    // gateway refuses, and the SDK's fallback finds exactly one candidate
    // among the locally stored projects' owning orgs.
    config.saveProject("prj_other", { anon_key: "a", service_key: "s", org_id: ORG_B });
    imageResponder = (n) => (n === 1 ? selectionRequired([ORG_A, ORG_B]) : imageOk());
    const envelope = await runImage(["a cat"]);
    assert.equal(envelope, null, stderr.join("\n"));
    assert.deepEqual(imageCalls, [
      { prompt: "a cat", aspect: "square" },
      { prompt: "a cat", aspect: "square", org_id: ORG_B },
    ]);
  });

  it("a billing refusal on a derived org says where the org came from", async () => {
    await orgs().use(ORG_B);
    imageResponder = () => json({
      error: "Organization billing role required",
      message: "Organization billing role required",
      code: "FORBIDDEN",
      details: { org_id: ORG_B, funds_moved: false },
      next_actions: [],
    }, 403);
    const envelope = await runImage(["a cat"]);
    assert.equal(envelope.code, "FORBIDDEN");
    assert.equal(envelope.details.org_source, "profile");
    assert.equal(envelope.details.org_source_detail, "orgs use");
    assert.match(envelope.hint, /--org <org_id>/);
  });
});
