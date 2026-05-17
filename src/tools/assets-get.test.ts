import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleBlobGet } from "./assets-get.js";
import { saveProject } from "../keystore.js";
import { _resetSdk } from "../sdk.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  _resetSdk();
  tempDir = mkdtempSync(join(tmpdir(), "run402-blob-get-test-"));
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

describe("assets_get tool", () => {
  it("returns structured errors when local output writing fails", async () => {
    globalThis.fetch = (async () =>
      new Response("hello", {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": "5",
        },
      })) as typeof fetch;

    const result = await handleBlobGet({
      project_id: "prj_test",
      key: "hello.txt",
      output_path: tempDir,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /Error writing blob to local file/);
  });
});
