import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

mock.module("../allowance-auth.js", {
  namedExports: {
    requireAllowanceAuth: () => ({ headers: { "SIGN-IN-WITH-X": "dGVzdA==" } }),
  },
});

mock.module("../paid-fetch.js", {
  namedExports: {
    paidApiRequest: async (path: string, opts: any) => {
      const { apiRequest } = await import("../client.js");
      return apiRequest(path, opts);
    },
  },
});

const { handleBundleDeploy } = await import("./bundle-deploy.js");

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-bundle-deploy-test-"));
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

describe("bundle_deploy tool", () => {
  it("sends inherit in body when true", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ project_id: "proj-001", site_url: "https://dpl-001.sites.run402.com" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleBundleDeploy({
      project_id: "proj-001",
      files: [{ file: "style.css", data: "body{}" }],
      inherit: true,
    });

    const parsed = JSON.parse(capturedBody!);
    assert.equal(parsed.inherit, true);
  });

  it("does not send inherit when omitted", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ project_id: "proj-001", site_url: "https://dpl-002.sites.run402.com" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleBundleDeploy({
      project_id: "proj-001",
      files: [{ file: "index.html", data: "<html></html>" }],
    });

    const parsed = JSON.parse(capturedBody!);
    assert.equal(parsed.inherit, undefined);
  });
});
