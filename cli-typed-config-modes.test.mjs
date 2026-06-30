import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "run402-typed-cli-"));
const API = "https://test-api.run402.com";
process.env.RUN402_CONFIG_DIR = tempDir;
process.env.RUN402_API_BASE = API;

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
let stdout = [];
let stderr = [];
let calls = [];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestInfo(input, init) {
  const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
  const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
  const parsed = new URL(url);
  const path = parsed.origin === API ? `${parsed.pathname}${parsed.search}` : url;
  return { url, method, path, init };
}

function mockFetch(input, init) {
  const info = requestInfo(input, init);
  calls.push(info);
  return Promise.resolve(json({ ok: true }));
}

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

function stdoutJson() {
  const text = stdout.join("\n");
  assert.ok(text.trim().startsWith("{"), `expected JSON stdout, got: ${text}`);
  return JSON.parse(text);
}

function stderrJson() {
  const jsonLines = stderr.filter((s) => s.trim().startsWith("{"));
  const line = jsonLines.find((s) => {
    try {
      return JSON.parse(s).status === "error";
    } catch {
      return false;
    }
  }) ?? jsonLines[0];
  assert.ok(line, `expected JSON stderr, got: ${stderr.join("\n")}`);
  return JSON.parse(line);
}

async function captureSuccess(fn) {
  captureStart();
  try {
    await fn();
    return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), json: stdoutJson() };
  } catch (err) {
    err.message = `${err.message}\nstdout:\n${stdout.join("\n")}\nstderr:\n${stderr.join("\n")}`;
    throw err;
  } finally {
    captureStop();
  }
}

async function expectExit1(fn) {
  let threw = null;
  captureStart();
  try {
    await fn();
  } catch (err) {
    threw = err;
  } finally {
    captureStop();
  }
  assert.equal(threw?.message, "process.exit(1)");
  return stderrJson();
}

async function seedDeployAllowance() {
  const { saveAllowance } = await import("./cli/lib/config.mjs");
  saveAllowance({
    address: "0x0000000000000000000000000000000000000001",
    privateKey: "0x" + "11".repeat(32),
    rail: "x402",
    funded: true,
    created: "2026-06-30T00:00:00.000Z",
  });
}

function writeTypedDeployConfig(root, bodyText = "hello") {
  const manifestPath = join(root, "run402.deploy.ts");
  writeFileSync(manifestPath, `
    export default {
      project: "prj_test123",
      site: { replace: { "index.html": { data: ${JSON.stringify(bodyText)} } } },
    };
  `);
  return manifestPath;
}

function reviewedPlanPayload(
  planId = "plan_reviewed_smoke",
  fingerprint = "run402-reviewed-plan-v1:" + "a".repeat(64),
  operationId = null,
) {
  return {
    kind: "plan_response",
    schema_version: "agent-deploy-observability.v1",
    plan_id: planId,
    operation_id: operationId,
    base_release_id: null,
    manifest_digest: "b".repeat(64),
    plan_fingerprint: fingerprint,
    plan_expires_at: "2026-06-30T13:00:00.000Z",
    planner_semantics_version: "run402.release_planner.v1",
    base_identity: "empty",
    is_noop: false,
    summary: "reviewed typed config",
    warnings: [],
    expected_events: [],
    missing_content: [],
    payment_required: null,
    migrations: { new: [], noop: [] },
    site: { added: [{ path: "index.html" }], removed: [], changed: [] },
    functions: { added: [], removed: [], changed: [] },
    secrets: { added: [], removed: [] },
    subdomains: { added: [], removed: [] },
    routes: { added: [], removed: [], changed: [] },
    diff: { resources: { site: { added: ["index.html"] } } },
    next_actions: [{
      action: "retry",
      command: `run402 deploy apply --require-plan ${planId} --plan-fingerprint ${fingerprint}`,
      argv: ["run402", "deploy", "apply", "--require-plan", planId, "--plan-fingerprint", fingerprint],
      why: "Apply exactly this reviewed plan before it expires.",
    }],
  };
}

async function withApplyGatewayMock(handler, fn) {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const info = requestInfo(input, init);
    const rawBody =
      input instanceof Request
        ? await input.clone().text().catch(() => undefined)
        : init?.body;
    const body = typeof rawBody === "string" && rawBody.length > 0
      ? JSON.parse(rawBody)
      : rawBody;
    calls.push({ ...info, body });
    const handled = await handler(info, body);
    if (handled) return handled;
    return prevFetch(input, init);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
  }
}

before(async () => {
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  const { saveProject, setActiveProjectId } = await import("./cli/core-dist/keystore.js");
  saveProject("prj_test123", {
    anon_key: "anon_test_key",
    service_key: "svc_test_key",
  });
  setActiveProjectId("prj_test123");
});

after(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  captureStop();
});

describe("typed release config CLI modes", () => {
  it("smoke-tests deploy apply check, print-spec, plan, mismatch, and successful require-plan", async () => {
    await seedDeployAllowance();
    const root = mkdtempSync(join(tmpdir(), "run402-cli-typed-smoke-"));
    try {
      const manifestPath = writeTypedDeployConfig(root, "v1");
      const { run } = await import("./cli/lib/deploy.mjs");
      const planId = "plan_reviewed_smoke";
      const fingerprint = "run402-reviewed-plan-v1:" + "c".repeat(64);

      const check = await captureSuccess(() =>
        run(["apply", "--manifest", manifestPath, "--check"]),
      );
      assert.equal(check.json.ok, true);
      assert.equal(check.json.mode, "check");
      assert.equal(check.json.project_id, "prj_test123");
      assert.equal(check.json.manifest_path, manifestPath);
      assert.equal(calls.some((call) => call.path === "/apply/v1/plans"), false, "--check must stay local-only");

      calls = [];
      const printed = await captureSuccess(() =>
        run(["apply", "--manifest", manifestPath, "--print-spec"]),
      );
      assert.equal(printed.json.project, "prj_test123");
      assert.equal(printed.json.site.replace["index.html"], "v1");
      assert.equal(calls.some((call) => call.path === "/apply/v1/plans"), false, "--print-spec must stay local-only");

      await withApplyGatewayMock((info, body) => {
        if (info.path === "/apply/v1/plans" && info.method === "POST") {
          assert.equal(body.mode, "reviewed_plan");
          return json(reviewedPlanPayload(planId, fingerprint), 201);
        }
        return null;
      }, async () => {
        calls = [];
        const planned = await captureSuccess(() =>
          run(["apply", "--manifest", manifestPath, "--plan"]),
        );
        assert.equal(planned.json.plan_id, planId);
        assert.equal(planned.json.plan_fingerprint, fingerprint);
        assert.deepEqual(planned.json.next_actions[0].argv.slice(0, 4), ["run402", "deploy", "apply", "--require-plan"]);
        assert.equal(calls.filter((call) => call.path === "/apply/v1/plans").length, 1);
        assert.equal(calls.some((call) => /\/commit$/.test(call.path)), false, "--plan must not commit");
      });

      writeTypedDeployConfig(root, "v2");
      await withApplyGatewayMock((info, body) => {
        if (info.path === "/apply/v1/plans" && info.method === "POST" && body.required_plan) {
          return json({
            code: "PLAN_APPROVAL_MISMATCH",
            message: "reviewed plan no longer matches this config",
            plan_id: body.required_plan.plan_id,
            next_actions: [{
              action: "retry",
              command: `run402 deploy apply --manifest ${manifestPath} --plan`,
              argv: ["run402", "deploy", "apply", "--manifest", manifestPath, "--plan"],
              why: "Create a fresh reviewed plan.",
            }],
          }, 409);
        }
        return null;
      }, async () => {
        calls = [];
        const err = await expectExit1(() =>
          run(["apply", "--manifest", manifestPath, "--require-plan", planId, "--plan-fingerprint", fingerprint]),
        );
        assert.equal(err.code, "PLAN_APPROVAL_MISMATCH");
        assert.equal(err.next_actions[0].argv.at(-1), "--plan");
        assert.equal(calls.filter((call) => call.path === "/apply/v1/plans").length, 1);
        assert.equal(calls.some((call) => /\/commit$/.test(call.path)), false, "mismatch must fail before commit");
      });

      writeTypedDeployConfig(root, "v1");
      await withApplyGatewayMock((info, body) => {
        if (info.path === "/apply/v1/plans" && info.method === "POST" && body.required_plan) {
          assert.deepEqual(body.required_plan, { plan_id: planId, plan_fingerprint: fingerprint });
          return json(reviewedPlanPayload(planId, fingerprint, "op_reviewed_smoke"), 201);
        }
        if (info.path === `/apply/v1/plans/${planId}/commit` && info.method === "POST") {
          assert.deepEqual(body.required_plan, { plan_id: planId, plan_fingerprint: fingerprint });
          return json({
            operation_id: "op_reviewed_smoke",
            status: "ready",
            release_id: "rel_reviewed_smoke",
            urls: { site: "https://typed-smoke.run402.test" },
          });
        }
        return null;
      }, async () => {
        calls = [];
        const applied = await captureSuccess(() =>
          run(["apply", "--manifest", manifestPath, "--require-plan", planId, "--plan-fingerprint", fingerprint, "--quiet"]),
        );
        assert.equal(applied.json.release_id, "rel_reviewed_smoke");
        assert.equal(calls.filter((call) => call.path === "/apply/v1/plans").length, 1);
        assert.equal(calls.filter((call) => call.path === `/apply/v1/plans/${planId}/commit`).length, 1);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("up --plan preserves the up surface in reviewed-plan next actions", async () => {
    await seedDeployAllowance();
    const root = mkdtempSync(join(tmpdir(), "run402-cli-up-plan-"));
    try {
      const manifestPath = writeTypedDeployConfig(root, "up-plan");
      const { run } = await import("./cli/lib/up.mjs");
      const planId = "plan_up_reviewed";
      const fingerprint = "run402-reviewed-plan-v1:" + "d".repeat(64);
      await withApplyGatewayMock((info, body) => {
        if (info.path === "/apply/v1/plans" && info.method === "POST") {
          assert.equal(body.mode, "reviewed_plan");
          return json(reviewedPlanPayload(planId, fingerprint), 201);
        }
        return null;
      }, async () => {
        calls = [];
        const planned = await captureSuccess(() =>
          run(["--manifest", manifestPath, "--plan", "--quiet"]),
        );
        assert.equal(planned.json.result.plan.plan_id, planId);
        assert.equal(planned.json.result.plan.next_actions[0].argv[1], "up");
        assert.deepEqual(planned.json.result.plan.next_actions[0].argv.slice(0, 5), [
          "run402",
          "up",
          "--manifest",
          manifestPath,
          "--require-plan",
        ]);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deploy apply rejects warning flags with --require-plan before SDK/network work", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-cli-require-plan-warning-"));
    try {
      const manifestPath = writeTypedDeployConfig(root);
      const { run } = await import("./cli/lib/deploy.mjs");
      const err = await expectExit1(() =>
        run(["apply", "--manifest", manifestPath, "--require-plan", "plan_1", "--allow-warnings"]),
      );
      assert.equal(err.code, "BAD_USAGE");
      assert.equal(err.details.flag, "--require-plan");
      assert.equal(calls.length, 0, "flag conflict must fail before network");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("up refuses executable auto-discovery until --manifest explicitly trusts it", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-cli-exec-trust-"));
    try {
      writeTypedDeployConfig(root);
      const { run } = await import("./cli/lib/up.mjs");
      const err = await expectExit1(() => run(["--dir", root, "--check"]));
      assert.equal(err.code, "EXECUTABLE_CONFIG_REQUIRES_EXPLICIT_MANIFEST");
      assert.equal(err.details.manifest_path, join(root, "run402.deploy.ts"));
      assert.deepEqual(err.details.next_actions[0].argv, [
        "run402",
        "up",
        "--manifest",
        join(root, "run402.deploy.ts"),
        "--check",
      ]);
      assert.equal(calls.length, 0, "trust refusal must not reach the gateway");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
