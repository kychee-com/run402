import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleUploadFile } from "./upload-file.js";
import { saveProject } from "../keystore.js";

const originalFetch = globalThis.fetch;
let tempDir: string;
let storePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-upload-test-"));
  storePath = join(tempDir, "projects.json");
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("upload_file tool", () => {
  it("uploads text content and returns key + size", async () => {
    saveProject("proj-u1", {
      anon_key: "ak-u1",
      service_key: "sk-u1",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: string | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ key: "data/test.csv", size: 42 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleUploadFile({
      project_id: "proj-u1",
      bucket: "data",
      path: "test.csv",
      content: "id,name\n1,Alice",
      content_type: "text/csv",
    });

    assert.ok(capturedUrl.includes("/storage/v1/object/data/test.csv"));
    assert.equal(capturedHeaders["Content-Type"], "text/csv");
    assert.equal(capturedHeaders["apikey"], "ak-u1");
    assert.equal(capturedBody, "id,name\n1,Alice");
    assert.ok(result.content[0]!.text.includes("data/test.csv"));
    assert.ok(result.content[0]!.text.includes("42 bytes"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleUploadFile({
      project_id: "no-proj",
      bucket: "data",
      path: "test.txt",
      content: "hello",
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });

  it("returns isError on upload failure", async () => {
    saveProject("proj-u2", {
      anon_key: "ak-u2",
      service_key: "sk-u2",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Upload failed" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleUploadFile({
      project_id: "proj-u2",
      bucket: "data",
      path: "fail.txt",
      content: "x",
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("uploading file"));
    assert.ok(result.content[0]!.text.includes("Upload failed"));
  });
});
