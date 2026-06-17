import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleDeployFunction } from "./deploy-function.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

// Bodies posted to /apply/v1/plans, for spec-shape assertions.
let planBodies: string[] = [];

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A URL-aware `globalThis.fetch` that drives the unified-apply engine to
 * terminal success for a single `functions.patch.set` deploy: `/tiers/v1/status`
 * returns an empty tier (so the function preflight bails), `/apply/v1/plans`
 * reports no missing content (so the CAS upload dance is skipped) and records
 * the posted body, and the commit returns a terminal `"ready"` (so the poll is
 * skipped). Function deploy re-points onto this path — the legacy
 * `POST /projects/v1/admin/:id/functions` route was removed gateway-side.
 */
function applyOkFetch(): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.endsWith("/tiers/v1/status")) return jsonRes({ tier: "" });
    if (u.endsWith("/apply/v1/plans")) {
      planBodies.push(init?.body as string);
      return jsonRes({
        plan_id: "plan_1",
        operation_id: "op_1",
        base_release_id: null,
        manifest_digest: "d",
        missing_content: [],
        diff: { resources: {} },
        warnings: [],
      });
    }
    if (u.endsWith("/apply/v1/plans/plan_1/commit")) {
      return jsonRes({ operation_id: "op_1", status: "ready", release_id: "rel_1", urls: {} });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}

/** The `spec` from the most recent /apply/v1/plans body. */
function lastPlanSpec(): Record<string, any> {
  return JSON.parse(planBodies.at(-1)!).spec;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-deploy-fn-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  planBodies = [];

  const store = {
    projects: {
      "proj-001": {
        anon_key: "ak-123",
        service_key: "sk-456",
        tier: "prototype",
        lease_expires_at: "2030-01-01T00:00:00Z",
      },
    },
  };
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(store));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("deploy_function tool", () => {
  it("renders the deployed function on a successful apply", async () => {
    globalThis.fetch = applyOkFetch();

    const result = await handleDeployFunction({
      project_id: "proj-001",
      name: "my-func",
      code: 'export default async (req) => new Response("hello")',
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Function Deployed"));
    assert.ok(result.content[0]!.text.includes("my-func"));
    // url is derived from the project's API base when apply returns no urls map.
    assert.ok(result.content[0]!.text.includes("functions/v1/my-func"));

    // Routed through unified apply — never the deleted admin route.
    assert.equal(lastPlanSpec().project_id, "proj-001");
    assert.ok(lastPlanSpec().functions.patch.set["my-func"], "functions.patch.set entry present");
  });

  it("returns error on an invalid name (client-side, before any apply)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch must not be called for an invalid function name");
    }) as typeof fetch;

    const result = await handleDeployFunction({
      project_id: "proj-001",
      name: "Bad Name!",
      code: "export default async (req) => new Response('hi')",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("lowercase"));
    assert.equal(planBodies.length, 0, "no apply plan was attempted");
  });

  it("returns payment info (NOT isError) on 402 from the plan", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/apply/v1/plans")) {
        return jsonRes({ error: "Lease expired", renew_url: "/tiers/v1/prototype" }, 402);
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof fetch;

    const result = await handleDeployFunction({
      project_id: "proj-001",
      name: "my-func",
      code: "export default async (req) => new Response('hi')",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Payment Required"));
  });

  it("returns isError on 403 (quota exceeded) from the plan", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/apply/v1/plans")) {
        return jsonRes({ error: "Function limit reached (5 for your tier)" }, 403);
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof fetch;

    const result = await handleDeployFunction({
      project_id: "proj-001",
      name: "my-func",
      code: "export default async (req) => new Response('hi')",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("limit"));
  });

  it("carries the schedule under functions.patch.set and shows it in the output", async () => {
    globalThis.fetch = applyOkFetch();

    const result = await handleDeployFunction({
      project_id: "proj-001",
      name: "send-reminders",
      code: 'export default async (req) => new Response("ok")',
      schedule: "*/15 * * * *",
    });

    assert.equal(result.isError, undefined);
    assert.equal(lastPlanSpec().functions.patch.set["send-reminders"].schedule, "*/15 * * * *");
    assert.ok(result.content[0]!.text.includes("*/15 * * * *"));
  });

  it("forwards schedule: null in the spec to remove a schedule", async () => {
    globalThis.fetch = applyOkFetch();

    await handleDeployFunction({
      project_id: "proj-001",
      name: "send-reminders",
      code: 'export default async (req) => new Response("ok")',
      schedule: null,
    });

    const fn = lastPlanSpec().functions.patch.set["send-reminders"];
    assert.equal(Object.prototype.hasOwnProperty.call(fn, "schedule"), true);
    assert.equal(fn.schedule, null);
  });

  it("omits schedule/config/deps from the spec when not provided", async () => {
    globalThis.fetch = applyOkFetch();

    await handleDeployFunction({
      project_id: "proj-001",
      name: "my-func",
      code: 'export default async (req) => new Response("ok")',
    });

    const fn = lastPlanSpec().functions.patch.set["my-func"];
    assert.equal("schedule" in fn, false);
    assert.equal("config" in fn, false);
    assert.equal("deps" in fn, false);
  });

  it("carries user deps under functions.patch.set", async () => {
    globalThis.fetch = applyOkFetch();

    await handleDeployFunction({
      project_id: "proj-001",
      name: "with-deps",
      code: 'export default async (req) => new Response("ok")',
      deps: ["lodash"],
    });

    assert.deepEqual(lastPlanSpec().functions.patch.set["with-deps"].deps, ["lodash"]);
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleDeployFunction({
      project_id: "nonexistent",
      name: "my-func",
      code: "export default async (req) => new Response('hi')",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
