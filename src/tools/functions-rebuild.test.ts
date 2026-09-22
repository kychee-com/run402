import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleFunctionsRebuild } from "./functions-rebuild.js";
import { _resetSdk } from "../sdk.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  // functions rebuild is wallet-authed (project ownership) and makes NO
  // keystore lookup — unlike the service-key function tools, so no
  // projects.json is written here. The temp config dir just keeps the test
  // off any real local wallet/keystore.
  tempDir = mkdtempSync(join(tmpdir(), "run402-fn-rebuild-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  _resetSdk();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetSdk();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("functions_rebuild tool", () => {
  it("rebuilds a single function by name (POST :name/rebuild)", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = String(url);
      capturedMethod = init.method || "";
      return new Response(
        JSON.stringify({
          name: "my-func",
          rebuilt: true,
          old_fingerprint: "fp-old",
          new_fingerprint: "fp-new",
          runtime_version_before: "1.68.0",
          runtime_version_after: "1.69.0",
          code_hash: "sha256:abc123",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleFunctionsRebuild({ project_id: "proj-001", name: "my-func" });

    assert.equal(capturedMethod, "POST");
    assert.ok(capturedUrl.endsWith("/projects/v1/proj-001/functions/my-func/rebuild"));
    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.ok(text.includes("Function Rebuilt"));
    assert.ok(text.includes("`my-func`"));
    // runtime version transition is rendered before → after
    assert.ok(text.includes("`1.68.0` → `1.69.0`"));
    assert.ok(text.includes("`sha256:abc123`"));
  });

  it("rebuilds every function when name is omitted (POST /rebuild)", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = String(url);
      capturedMethod = init.method || "";
      return new Response(
        JSON.stringify({
          rebuilt_count: 1,
          total: 2,
          results: [
            {
              name: "api",
              rebuilt: true,
              old_fingerprint: "a0",
              new_fingerprint: "a1",
              runtime_version_before: "1.68.0",
              runtime_version_after: "1.69.0",
              code_hash: "sha256:aaa",
            },
            {
              name: "legacy",
              rebuilt: false,
              code: "CANNOT_REBUILD_UNLOCKED_DEPS",
              error: "deployed before dependency locking",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleFunctionsRebuild({ project_id: "proj-001" });

    assert.equal(capturedMethod, "POST");
    assert.ok(capturedUrl.endsWith("/projects/v1/proj-001/functions/rebuild"));
    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.ok(text.includes("Functions Rebuilt"));
    assert.ok(text.includes("Rebuilt 1 of 2 functions"));
    assert.ok(text.includes("**api** ✅"));
    assert.ok(text.includes("**legacy** ❌"));
    assert.ok(text.includes("CANNOT_REBUILD_UNLOCKED_DEPS"));
    // batch failures never throw; the unlocked-deps remediation points at deploy
    assert.ok(text.includes("deploy_function"));
  });

  it("maps single-function 409 CANNOT_REBUILD_UNLOCKED_DEPS to a redeploy-from-source message", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: "CANNOT_REBUILD_UNLOCKED_DEPS",
          error: "Function was deployed before dependency locking.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleFunctionsRebuild({ project_id: "proj-001", name: "legacy" });

    assert.equal(result.isError, true);
    const text = result.content[0]!.text;
    assert.ok(text.includes("409"));
    assert.ok(text.includes("CANNOT_REBUILD_UNLOCKED_DEPS"));
    assert.ok(text.includes("deploy_function"));
    assert.ok(/redeploy/i.test(text));
    // the misleading generic 409 "reserved name" guidance must NOT leak through
    assert.ok(!text.includes("already in use or reserved"));
  });

  it("returns isError on 403 (wallet does not own the project)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const result = await handleFunctionsRebuild({ project_id: "proj-001", name: "my-func" });

    assert.equal(result.isError, true);
  });
});
