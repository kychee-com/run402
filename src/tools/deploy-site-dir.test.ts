import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

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

function shaHex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

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

describe("deploy_site_dir tool (plan/commit transport)", () => {
  it("walks the dir, plans, uploads only missing files, and commits", async () => {
    const indexHtml = "<html><body>hello</body></html>";
    const styleCss = "body { color: red; }";
    writeFileSync(join(siteDir, "index.html"), indexHtml);
    writeFileSync(join(siteDir, "style.css"), styleCss);

    const indexSha = shaHex(indexHtml);
    const styleSha = shaHex(styleCss);

    const seenPaths: string[] = [];
    let planBody: { manifest_digest?: string; manifest?: { files: Array<{ path: string; sha256: string }> } } = {};
    const s3Puts: Array<{ url: string; checksum: string | null; size: number }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace("https://test-api.run402.com", "");
      seenPaths.push(`${init?.method ?? "GET"} ${path}`);

      if (path === "/deploy/v1/plan" && init?.method === "POST") {
        planBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({
          plan_id: "plan_dir_001",
          files: [
            // index.html — missing, needs single-PUT
            {
              sha256: indexSha,
              missing: true,
              upload_id: "u_idx",
              mode: "single",
              key: "cas/idx",
              staging_key: "_staging/plan_dir_001/" + indexSha,
              part_size_bytes: indexHtml.length,
              part_count: 1,
              parts: [{ part_number: 1, url: "https://s3.example/cas/idx?sig=1", byte_start: 0, byte_end: indexHtml.length - 1 }],
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
            },
            // style.css — already on the project, skip
            { sha256: styleSha, present: true, size: styleCss.length, content_type: "text/css; charset=utf-8" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (path === "/deploy/v1/commit" && init?.method === "POST") {
        return new Response(JSON.stringify({
          deployment_id: "dpl_dir_001",
          url: "https://dpl-dir-001.sites.run402.com",
          status: "applied",
          bytes_total: indexHtml.length + styleCss.length,
          bytes_uploaded: indexHtml.length,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("https://s3.example/")) {
        const headers = new Headers(init?.headers ?? undefined);
        const body = init?.body as Buffer;
        s3Puts.push({ url, checksum: headers.get("x-amz-checksum-sha256"), size: body.byteLength });
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch ${path}`);
    }) as typeof fetch;

    const result = await handleDeploySiteDir({ project: "prj_abc", dir: siteDir });

    assert.ok(!result.isError, JSON.stringify(result));
    assert.match(result.content[0].text, /dpl_dir_001/);
    assert.match(result.content[0].text, /sites\.run402\.com/);
    // Surface bytes_total/bytes_uploaded in the table now that the SDK returns them.
    assert.match(result.content[0].text, /bytes_total/);
    assert.match(result.content[0].text, /bytes_uploaded/);

    // Plan body uses the gateway-compatible canonical manifest.
    assert.ok(planBody.manifest_digest, "plan body must include manifest_digest");
    assert.deepEqual(
      (planBody.manifest?.files ?? []).map((f) => f.path),
      ["index.html", "style.css"],
      "manifest files must be sorted by path",
    );
    const sentShas = (planBody.manifest?.files ?? []).map((f) => f.sha256).sort();
    assert.deepEqual(sentShas, [indexSha, styleSha].sort());

    // Exactly one S3 PUT — for the missing index.html — with whole-object SHA in base64.
    assert.equal(s3Puts.length, 1, "should upload exactly the missing file");
    assert.equal(s3Puts[0].size, indexHtml.length);
    assert.equal(s3Puts[0].checksum, createHash("sha256").update(indexHtml).digest("base64"));

    // Plan -> PUT -> commit ordering.
    assert.equal(seenPaths[0], "POST /deploy/v1/plan");
    assert.equal(seenPaths[seenPaths.length - 1], "POST /deploy/v1/commit");
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

  it("appends a progress events block to the success response", async () => {
    const html = "<html>events</html>";
    writeFileSync(join(siteDir, "index.html"), html);
    const sha = shaHex(html);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace("https://test-api.run402.com", "");
      if (path === "/deploy/v1/plan" && init?.method === "POST") {
        return new Response(JSON.stringify({
          plan_id: "plan_ev",
          files: [{
            sha256: sha,
            missing: true,
            upload_id: "u",
            mode: "single",
            key: "cas/ev",
            staging_key: "_staging/plan_ev/" + sha,
            part_size_bytes: html.length,
            part_count: 1,
            parts: [{ part_number: 1, url: "https://s3.example/ev?sig=1", byte_start: 0, byte_end: html.length - 1 }],
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (path === "/deploy/v1/commit" && init?.method === "POST") {
        return new Response(JSON.stringify({
          deployment_id: "dpl_ev",
          url: "https://dpl-ev.sites.run402.com",
          status: "applied",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("https://s3.example/")) {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch ${path}`);
    }) as typeof fetch;

    const result = await handleDeploySiteDir({ project: "prj_ev", dir: siteDir });
    assert.ok(!result.isError);
    assert.equal(result.content.length, 2, "expected URL entry + events entry");

    // Second content entry is a fenced JSON code block; extract and parse.
    const eventsText = result.content[1].text;
    assert.match(eventsText, /### Progress events/);
    const fenceMatch = eventsText.match(/```json\n([\s\S]+?)\n```/);
    assert.ok(fenceMatch, "events block must contain a ```json fenced block");
    const events = JSON.parse(fenceMatch![1]) as Array<{ phase: string }>;
    const phases = events.map((e) => e.phase);
    assert.deepEqual(phases, ["plan", "upload", "commit"]);
  });

  it("appends partial events to the error response when deploy fails mid-flight", async () => {
    const html = "<html>fail</html>";
    writeFileSync(join(siteDir, "index.html"), html);
    const sha = shaHex(html);

    // Plan succeeds (events buffered: plan); commit returns failed (no upload
    // because all entries are present-after-plan? Actually, simpler — make plan
    // return all-present, commit returns failed. That gives us plan + commit
    // events buffered before the ApiError.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace("https://test-api.run402.com", "");
      if (path === "/deploy/v1/plan" && init?.method === "POST") {
        return new Response(JSON.stringify({
          plan_id: "plan_fail",
          files: [{ sha256: sha, present: true, size: html.length, content_type: "text/html; charset=utf-8" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (path === "/deploy/v1/commit" && init?.method === "POST") {
        return new Response(JSON.stringify({
          deployment_id: "dpl_fail",
          url: "https://dpl-fail.sites.run402.com",
          status: "failed",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${path}`);
    }) as typeof fetch;

    const result = await handleDeploySiteDir({ project: "prj_fail", dir: siteDir });
    assert.equal(result.isError, true);
    // The last content entry should be the events block — error message in
    // earlier entries.
    const last = result.content[result.content.length - 1].text;
    assert.match(last, /### Progress events/);
    const fenceMatch = last.match(/```json\n([\s\S]+?)\n```/);
    assert.ok(fenceMatch, "error response should still surface the partial event log");
    const events = JSON.parse(fenceMatch![1]) as Array<{ phase: string }>;
    // plan event fires before the commit fail; commit event fires immediately
    // before the commit POST; both should be in the buffer.
    assert.ok(events.some((e) => e.phase === "plan"));
    assert.ok(events.some((e) => e.phase === "commit"));
  });
});
