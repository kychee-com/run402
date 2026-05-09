import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleApplyExpose } from "./apply-expose.js";
import { _resetSdk } from "../sdk.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  _resetSdk();
  tempDir = mkdtempSync(join(tmpdir(), "run402-apply-expose-test-"));
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
  _resetSdk();
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("handleApplyExpose", () => {
  it("POSTs the manifest to /projects/v1/admin/:id/expose with bearer auth", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    let capturedAuth: string | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedBody = init?.body as string;
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth = headers?.Authorization;
      return new Response(
        JSON.stringify({
          status: "ok",
          project_id: "proj-001",
          applied: { tables: ["posts"], views: [], rpcs: [] },
          dropped: { tables: [], views: [], rpcs: [] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const manifest = {
      version: "1" as const,
      tables: [{ name: "posts", expose: true, policy: "user_owns_rows", owner_column: "user_id" }],
      views: [],
      rpcs: [],
    };

    const res = await handleApplyExpose({ project_id: "proj-001", manifest });

    assert.equal(res.isError, undefined);
    assert.match(capturedUrl!, /\/projects\/v1\/admin\/proj-001\/expose$/);
    assert.equal(capturedAuth, "Bearer sk-456");
    const parsed = JSON.parse(capturedBody!);
    assert.equal(parsed.version, "1");
    assert.equal(parsed.tables[0].name, "posts");
    assert.match(res.content[0].text, /Applied/);
    assert.match(res.content[0].text, /`posts`/);
  });

  it("returns an isError result when the API returns a non-200 (e.g. invalid manifest)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "manifest.version: expected \"1\"" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const res = await handleApplyExpose({
      project_id: "proj-001",
      manifest: { version: "1", tables: [], views: [], rpcs: [] },
    });

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /applying expose manifest/);
    assert.match(res.content[0].text, /HTTP 400/);
  });

  it("returns project-not-found when the project is not in the key store", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const res = await handleApplyExpose({
      project_id: "missing",
      manifest: { version: "1", tables: [], views: [], rpcs: [] },
    });

    assert.equal(res.isError, true);
    assert.equal(fetchCalled, false);
    assert.match(res.content[0].text, /not found in key store/);
  });

  it("shows dropped items in the success output", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          project_id: "proj-001",
          applied: { tables: ["posts"], views: [], rpcs: [] },
          dropped: { tables: ["old_table"], views: ["old_view"], rpcs: [] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const res = await handleApplyExpose({
      project_id: "proj-001",
      manifest: { version: "1", tables: [{ name: "posts", expose: true }], views: [], rpcs: [] },
    });

    assert.match(res.content[0].text, /`old_table`/);
    assert.match(res.content[0].text, /`old_view`/);
  });
});
