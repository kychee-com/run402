import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleServiceStatus } from "./service-status.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-service-status-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("service_status tool", () => {
  it("summarizes a full run402-status-v1 payload", async () => {
    globalThis.fetch = (async () => jsonResponse({
      schema_version: "run402-status-v1",
      service: "Run402",
      current_status: "operational",
      operator: { legal_name: "Kychee LLC" },
      availability: {
        last_24h: { uptime_pct: 100 },
        last_7d: { uptime_pct: 99.99 },
        last_30d: { uptime_pct: 99.95 },
      },
      capabilities: {
        database_api: "operational",
        file_storage: "operational",
      },
      deployment: { cloud: "AWS", region: "us-east-1" },
      links: { health: "https://api.run402.com/health" },
    })) as typeof fetch;

    const result = await handleServiceStatus({} as Record<string, never>);
    const text = result.content[0]!.text;
    assert.equal(result.isError, undefined);
    assert.ok(text.includes("operational"), "includes current_status");
    assert.ok(text.includes("Kychee LLC"), "includes operator");
    assert.ok(text.includes("99.95%"), "includes 30d uptime");
    assert.ok(text.includes("AWS"), "includes deployment");
    assert.ok(text.includes("database_api"), "includes capability");
    assert.ok(text.includes("https://api.run402.com/health"), "includes health link");
  });

  it("falls back to minimal view on unknown schema_version", async () => {
    globalThis.fetch = (async () => jsonResponse({
      schema_version: "some-future-v7",
      current_status: "operational",
    })) as typeof fetch;

    const result = await handleServiceStatus({} as Record<string, never>);
    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.ok(text.includes("operational"));
    assert.ok(text.includes("Unrecognized schema_version"));
    assert.ok(text.includes("some-future-v7"));
  });

  it("returns isError on non-2xx response", async () => {
    globalThis.fetch = (async () => new Response("upstream down", { status: 503 })) as typeof fetch;
    const result = await handleServiceStatus({} as Record<string, never>);
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("503"));
  });

  it("returns isError on network failure", async () => {
    globalThis.fetch = (async () => { throw new Error("connection refused"); }) as typeof fetch;
    const result = await handleServiceStatus({} as Record<string, never>);
    assert.equal(result.isError, true);
    const text = result.content[0]!.text;
    assert.ok(text.includes("network error"));
    assert.ok(text.includes("connection refused"));
  });

  it("works with no allowance file (fresh install)", async () => {
    // tempDir is empty — no allowance.json, no projects.json
    globalThis.fetch = (async () => jsonResponse({
      schema_version: "run402-status-v1",
      current_status: "operational",
      operator: { legal_name: "Kychee LLC" },
      availability: { last_30d: { uptime_pct: 99.9 } },
    })) as typeof fetch;

    const result = await handleServiceStatus({} as Record<string, never>);
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("operational"));
    // Config dir stays empty — tool wrote nothing
    assert.deepEqual(readdirSync(tempDir), []);
  });
});
