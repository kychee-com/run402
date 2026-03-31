import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

mock.module("../allowance-auth.js", {
  namedExports: {
    requireAllowanceAuth: () => ({ headers: { "SIGN-IN-WITH-X": "dGVzdA==" } }),
  },
});

const { handleDeploySite } = await import("./deploy-site.js");

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-deploy-site-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("deploy_site tool", () => {
  it("sends inherit in body when true", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ deployment_id: "dpl_001", url: "https://dpl-001.sites.run402.com" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleDeploySite({
      project: "proj-001",
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
        JSON.stringify({ deployment_id: "dpl_002", url: "https://dpl-002.sites.run402.com" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleDeploySite({
      project: "proj-001",
      files: [{ file: "index.html", data: "<html></html>" }],
    });

    const parsed = JSON.parse(capturedBody!);
    assert.equal(parsed.inherit, undefined);
  });
});
