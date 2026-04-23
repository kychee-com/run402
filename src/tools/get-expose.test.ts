import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleGetExpose } from "./get-expose.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-get-expose-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";

  const store = {
    projects: {
      "proj-001": { anon_key: "ak-123", service_key: "sk-456" },
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

describe("handleGetExpose", () => {
  it("GETs /projects/v1/admin/:id/expose with bearer auth and renders the manifest", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    let capturedAuth: string | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedMethod = init?.method || "GET";
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth = headers?.Authorization;
      return new Response(
        JSON.stringify({
          status: "ok",
          project_id: "proj-001",
          source: "applied",
          manifest: {
            version: "1",
            tables: [{ name: "posts", expose: true, policy: "user_owns_rows", owner_column: "user_id" }],
            views: [],
            rpcs: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await handleGetExpose({ project_id: "proj-001" });

    assert.equal(res.isError, undefined);
    assert.match(capturedUrl!, /\/projects\/v1\/admin\/proj-001\/expose$/);
    assert.equal(capturedMethod, "GET");
    assert.equal(capturedAuth, "Bearer sk-456");
    assert.match(res.content[0].text, /source: applied/);
    assert.match(res.content[0].text, /"posts"/);
  });

  it("notes when the manifest is introspected from live DB state", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          project_id: "proj-001",
          source: "introspected",
          manifest: { version: "1", tables: [], views: [], rpcs: [] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const res = await handleGetExpose({ project_id: "proj-001" });

    assert.match(res.content[0].text, /source: introspected/);
    assert.match(res.content[0].text, /no manifest has ever been applied/);
  });

  it("returns project-not-found when the project is not in the key store", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const res = await handleGetExpose({ project_id: "missing" });

    assert.equal(res.isError, true);
    assert.equal(fetchCalled, false);
    assert.match(res.content[0].text, /not found in key store/);
  });

  it("returns an isError result on a non-200 from the API", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "forbidden" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const res = await handleGetExpose({ project_id: "proj-001" });

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /fetching expose manifest/);
    assert.match(res.content[0].text, /HTTP 403/);
  });
});
