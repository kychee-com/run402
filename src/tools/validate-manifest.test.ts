import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleValidateManifest } from "./validate-manifest.js";
import { _resetSdk } from "../sdk.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  _resetSdk();
  tempDir = mkdtempSync(join(tmpdir(), "run402-validate-manifest-test-"));
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

describe("handleValidateManifest", () => {
  it("validates object manifests without project context", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ hasErrors: false, errors: [], warnings: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await handleValidateManifest({
      manifest: { version: "1", tables: [] },
    });

    assert.equal(res.isError, undefined);
    assert.match(capturedUrl!, /\/projects\/v1\/expose\/validate$/);
    assert.deepEqual(JSON.parse(capturedBody!), {
      manifest: { version: "1", tables: [] },
    });
    const json = extractFencedJson(res.content[0]!.text);
    assert.equal(json.hasErrors, false);
  });

  it("validates string manifests with project context and migration SQL", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    let capturedAuth: string | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedBody = init?.body as string;
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(
        JSON.stringify({
          hasErrors: true,
          errors: [{ type: "missing-table", severity: "error", detail: "missing table" }],
          warnings: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await handleValidateManifest({
      project_id: "proj-001",
      manifest: "{\"version\":\"1\",\"tables\":[{\"name\":\"posts\"}]}",
      migration_sql: "create table posts (id bigint primary key);",
    });

    assert.equal(res.isError, undefined);
    assert.match(capturedUrl!, /\/projects\/v1\/admin\/proj-001\/expose\/validate$/);
    assert.equal(capturedAuth, "Bearer sk-456");
    assert.deepEqual(JSON.parse(capturedBody!), {
      manifest: { version: "1", tables: [{ name: "posts" }] },
      migration_sql: "create table posts (id bigint primary key);",
    });
    const json = extractFencedJson(res.content[0]!.text);
    assert.equal(json.hasErrors, true);
    assert.equal(json.errors[0].type, "missing-table");
  });

  it("returns invalid JSON as a validation result without hitting the gateway", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const res = await handleValidateManifest({ manifest: "{ bad json" });

    assert.equal(fetchCalled, false);
    assert.equal(res.isError, undefined);
    const json = extractFencedJson(res.content[0]!.text);
    assert.equal(json.hasErrors, true);
    assert.equal(json.errors[0].type, "schema-shape");
  });

  it("maps SDK errors for missing project credentials", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const res = await handleValidateManifest({
      project_id: "missing",
      manifest: { version: "1" },
    });

    assert.equal(fetchCalled, false);
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /not found in key store/);
  });
});

function extractFencedJson(text: string): any {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, `expected fenced JSON in:\n${text}`);
  return JSON.parse(match[1]!);
}
