import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

mock.module("../allowance-auth.js", {
  namedExports: {
    requireAllowanceAuth: () => ({ headers: { "SIGN-IN-WITH-X": "dGVzdA==" } }),
  },
});

const { handleDeploySiteDir } = await import("./deploy-site-dir.js");
const { _resetSdk } = await import("../sdk.js");

const originalFetch = globalThis.fetch;
let configDir: string;
let siteDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "run402-deploy-site-dir-cfg-"));
  siteDir = mkdtempSync(join(tmpdir(), "run402-deploy-site-dir-src-"));
  process.env.RUN402_CONFIG_DIR = configDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  _resetSdk();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(configDir, { recursive: true, force: true });
  rmSync(siteDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("deploy_site_dir tool", () => {
  it("walks the directory, posts a manifest, and returns the URL", async () => {
    writeFileSync(join(siteDir, "index.html"), "<html><body>hello</body></html>");
    writeFileSync(join(siteDir, "style.css"), "body { color: red; }");

    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          deployment_id: "dpl_dir_001",
          url: "https://dpl-dir-001.sites.run402.com",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleDeploySiteDir({
      project: "prj_abc",
      dir: siteDir,
    });

    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.match(text, /dpl_dir_001/);
    assert.match(text, /sites\.run402\.com/);

    const parsed = JSON.parse(capturedBody!);
    assert.equal(parsed.project, "prj_abc");
    assert.equal(parsed.files.length, 2);
    const paths = parsed.files.map((f: { file: string }) => f.file).sort();
    assert.deepEqual(paths, ["index.html", "style.css"]);
  });

  it("forwards inherit to the request body when true", async () => {
    writeFileSync(join(siteDir, "index.html"), "<html></html>");

    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          deployment_id: "dpl_dir_002",
          url: "https://dpl-dir-002.sites.run402.com",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleDeploySiteDir({ project: "prj_abc", dir: siteDir, inherit: true });

    const parsed = JSON.parse(capturedBody!);
    assert.equal(parsed.inherit, true);
  });

  it("returns an MCP error shape when the directory does not exist", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await handleDeploySiteDir({
      project: "prj_abc",
      dir: join(tmpdir(), "run402-does-not-exist-" + Date.now()),
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /deploying site directory/);
    assert.equal(fetchCalled, false, "must not issue a deploy request on LocalError");
  });
});
