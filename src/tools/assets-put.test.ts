import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { handleBlobPut } from "./assets-put.js";
import { saveProject } from "../keystore.js";
import { _resetSdk } from "../sdk.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  _resetSdk();
  tempDir = mkdtempSync(join(tmpdir(), "run402-blob-put-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  saveProject("prj_test", { anon_key: "anon", service_key: "service" });
});

afterEach(() => {
  _resetSdk();
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

function installApplyMock() {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });

    if (url.endsWith("/apply/v1/plans") && method === "POST") {
      const body = JSON.parse(init!.body as string);
      const putEntries = body.spec.assets.put as Array<{
        key: string;
        sha256: string;
        size_bytes: number;
        content_type: string;
        visibility: "public" | "private";
        immutable: boolean;
      }>;
      const missing_content = putEntries.map((e) => ({
        sha256: e.sha256,
        size: e.size_bytes,
        content_type: e.content_type,
        present: false,
      }));
      const asset_entries = putEntries.map((e) => {
        const suffix = e.sha256.slice(0, 8);
        const dotIdx = e.key.lastIndexOf(".");
        const suffixedKey = dotIdx > 0
          ? `${e.key.slice(0, dotIdx)}-${suffix}${e.key.slice(dotIdx)}`
          : `${e.key}-${suffix}`;
        const host = "pr-abc.run402.com";
        const url = e.visibility === "public" ? `https://${host}/_blob/${e.key}` : null;
        const immutableUrl = e.visibility === "public" && e.immutable ? `https://${host}/_blob/${suffixedKey}` : null;
        const sri = e.immutable ? `sha256-${Buffer.from(e.sha256, "hex").toString("base64")}` : null;
        return {
          key: e.key,
          sha256: e.sha256,
          size_bytes: e.size_bytes,
          content_type: e.content_type,
          visibility: e.visibility,
          immutable: e.immutable,
          status: "upload_pending",
          asset_ref: {
            key: e.key,
            sha256: e.sha256,
            size_bytes: e.size_bytes,
            content_type: e.content_type,
            visibility: e.visibility,
            immutable: e.immutable,
            url,
            immutable_url: immutableUrl,
            cdn_url: url,
            cdn_immutable_url: immutableUrl,
            sri,
            etag: `"sha256-${e.sha256}"`,
            content_digest: `sha-256=:${Buffer.from(e.sha256, "hex").toString("base64")}:`,
          },
        };
      });
      return new Response(
        JSON.stringify({
          plan_id: "plan_x",
          operation_id: "op_x",
          base_release_id: null,
          manifest_digest: "digest_x",
          missing_content,
          asset_entries,
          diff: { resources: {} },
          warnings: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/content/v1/plans") && method === "POST") {
      const body = JSON.parse(init!.body as string);
      const content = body.content as Array<{ sha256: string; size: number }>;
      return new Response(
        JSON.stringify({
          plan_id: "cplan_x",
          expires_at: "2030-01-01T00:00:00Z",
          missing: content.map((c) => ({
            sha256: c.sha256,
            mode: "single",
            part_size_bytes: c.size,
            part_count: 1,
            parts: [{ part_number: 1, url: `https://s3.test/${c.sha256}/p1`, byte_start: 0, byte_end: c.size - 1 }],
            upload_id: `u_${c.sha256.slice(0, 8)}`,
            staging_key: `_staging/u/${c.sha256}`,
            expires_at: "2030-01-01T00:00:00Z",
          })),
          entries: content.map((c) => ({ sha256: c.sha256, missing: true })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.startsWith("https://s3.test/") && method === "PUT") {
      return new Response("", { status: 200, headers: { etag: '"e"' } });
    }
    if (url.match(/\/content\/v1\/plans\/[^/]+\/commit$/) && method === "POST") {
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.match(/\/apply\/v1\/plans\/[^/]+\/commit$/) && method === "POST") {
      return new Response(
        JSON.stringify({
          operation_id: "op_x",
          status: "ready",
          release_id: "rel_x",
          urls: { project: "https://prj.run402.test", project_public_id: "abc" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "unexpected request", url, method }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

describe("assets_put tool", () => {
  it("routes a local file through the apply hero (SDK is the substrate)", async () => {
    const localPath = join(tempDir, "hello.txt");
    writeFileSync(localPath, "hello");
    const calls = installApplyMock();

    const result = await handleBlobPut({
      project_id: "prj_test",
      key: "hello.txt",
      local_path: localPath,
    });

    assert.equal(result.isError, undefined, `expected success; got: ${result.content[0]?.text}`);
    assert.ok(result.content[0]!.text.includes("Uploaded **hello.txt**"));
    const sigs = calls.map((c) => `${c.method} ${c.url}`);
    assert.ok(sigs.some((s) => s.endsWith("/apply/v1/plans") && s.startsWith("POST ")));
    assert.ok(sigs.some((s) => s.endsWith("/content/v1/plans") && s.startsWith("POST ")));
    assert.ok(sigs.some((s) => s.startsWith("PUT ") && s.includes("s3.test")));
    assert.ok(sigs.some((s) => s.startsWith("POST ") && /\/apply\/v1\/plans\/[^/]+\/commit$/.test(s.slice(5))));
    // Sanity-check the SHA computed by the SDK matches what we expect for "hello".
    const expectedSha = createHash("sha256").update("hello").digest("hex");
    assert.ok(result.content[0]!.text.includes(expectedSha.slice(0, 8)));
  });

  it("returns structured errors for non-file local paths", async () => {
    const dirPath = join(tempDir, "not-a-file");
    mkdirSync(dirPath);
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as typeof fetch;

    const result = await handleBlobPut({
      project_id: "prj_test",
      key: "bad",
      local_path: dirPath,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /regular file/);
    assert.equal(fetchCalled, false);
  });
});
