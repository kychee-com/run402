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

const { handleBundleDeploy, bundleDeployRlsRefined } = await import("./bundle-deploy.js");

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

  it("rejects the deprecated `public_read_write` RLS template", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const res = await handleBundleDeploy({
      project_id: "proj-001",
      rls: {
        template: "public_read_write",
        tables: [{ table: "guestbook" }],
      } as unknown as { template: string; tables: Array<{ table: string }> },
      files: [{ file: "index.html", data: "<html></html>" }],
    });

    assert.equal(res.isError, true);
    assert.equal(fetchCalled, false, "must not call gateway when schema rejects template");
  });

  it("rejects UNRESTRICTED rls template without the ACK flag", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const res = await handleBundleDeploy({
      project_id: "proj-001",
      rls: {
        template: "public_read_write_UNRESTRICTED",
        tables: [{ table: "guestbook" }],
      },
      files: [{ file: "index.html", data: "<html></html>" }],
    });

    assert.equal(res.isError, true);
    assert.equal(fetchCalled, false, "must not call gateway when ACK is missing");
    assert.match(res.content[0].text, /i_understand_this_is_unrestricted/);
  });

  it("forwards UNRESTRICTED rls + ACK flag to the deploy endpoint", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ project_id: "proj-001", site_url: "https://dpl-003.sites.run402.com" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await handleBundleDeploy({
      project_id: "proj-001",
      rls: {
        template: "public_read_write_UNRESTRICTED",
        tables: [{ table: "guestbook" }],
        i_understand_this_is_unrestricted: true,
      },
      files: [{ file: "index.html", data: "<html></html>" }],
    });

    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(capturedBody!);
    assert.equal(parsed.rls.template, "public_read_write_UNRESTRICTED");
    assert.equal(parsed.rls.i_understand_this_is_unrestricted, true);
  });
});

describe("bundleDeployRlsRefined schema", () => {
  it("accepts public_read_authenticated_write without ACK", () => {
    const result = bundleDeployRlsRefined.safeParse({
      template: "public_read_authenticated_write",
      tables: [{ table: "announcements" }],
    });
    assert.equal(result.success, true);
  });

  it("rejects the deprecated `public_read` name", () => {
    const result = bundleDeployRlsRefined.safeParse({
      template: "public_read",
      tables: [{ table: "announcements" }],
    });
    assert.equal(result.success, false);
  });

  it("rejects UNRESTRICTED without ACK", () => {
    const result = bundleDeployRlsRefined.safeParse({
      template: "public_read_write_UNRESTRICTED",
      tables: [{ table: "guestbook" }],
    });
    assert.equal(result.success, false);
    if (!result.success) {
      const ackIssue = result.error.issues.find((i) =>
        i.path.includes("i_understand_this_is_unrestricted"),
      );
      assert.ok(ackIssue);
    }
  });
});
