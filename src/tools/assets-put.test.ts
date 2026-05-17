import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

describe("assets_put tool", () => {
  it("streams local files through upload sessions instead of SDK bytes source", async () => {
    const localPath = join(tempDir, "hello.txt");
    writeFileSync(localPath, "hello");
    const calls: Array<{ url: string; method: string; body: unknown }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ?? null });
      if (url === "https://test-api.run402.com/storage/v1/uploads" && method === "POST") {
        return new Response(
          JSON.stringify({
            upload_id: "upl_1",
            mode: "single",
            part_count: 1,
            parts: [
              {
                part_number: 1,
                url: "https://s3.example.test/upl_1/part_1",
                byte_start: 0,
                byte_end: 4,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://s3.example.test/upl_1/part_1" && method === "PUT") {
        return new Response("", { status: 200, headers: { etag: '"etag-1"' } });
      }
      if (url === "https://test-api.run402.com/storage/v1/uploads/upl_1/complete" && method === "POST") {
        return new Response(
          JSON.stringify({
            key: "hello.txt",
            size_bytes: 5,
            sha256: null,
            visibility: "public",
            content_type: "text/plain",
            immutable_suffix: null,
            url: "https://cdn.example/hello.txt",
            immutable_url: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "unexpected request", url, method }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await handleBlobPut({
      project_id: "prj_test",
      key: "hello.txt",
      local_path: localPath,
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Uploaded **hello.txt**"));
    assert.equal(calls[0]!.url, "https://test-api.run402.com/storage/v1/uploads");
    assert.equal(calls[1]!.url, "https://s3.example.test/upl_1/part_1");
    assert.equal(Buffer.compare(Buffer.from(calls[1]!.body as ArrayBuffer), Buffer.from("hello")), 0);
    assert.equal(calls[2]!.url, "https://test-api.run402.com/storage/v1/uploads/upl_1/complete");
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
