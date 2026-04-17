import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleServiceHealth } from "./service-health.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-service-health-test-"));
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

describe("service_health tool", () => {
  it("summarizes a healthy payload", async () => {
    globalThis.fetch = (async () => jsonResponse({
      status: "healthy",
      checks: { postgres: "ok", postgrest: "ok", s3: "ok", cloudfront: "ok" },
      version: "1.0.4",
    })) as typeof fetch;

    const result = await handleServiceHealth({} as Record<string, never>);
    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.ok(text.includes("healthy"));
    assert.ok(text.includes("1.0.4"));
    assert.ok(text.includes("postgres"));
    assert.ok(text.includes("cloudfront"));
  });

  it("returns isError on non-2xx response", async () => {
    globalThis.fetch = (async () => new Response("down", { status: 500 })) as typeof fetch;
    const result = await handleServiceHealth({} as Record<string, never>);
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("500"));
  });

  it("returns isError on network failure", async () => {
    globalThis.fetch = (async () => { throw new Error("dns failure"); }) as typeof fetch;
    const result = await handleServiceHealth({} as Record<string, never>);
    assert.equal(result.isError, true);
    const text = result.content[0]!.text;
    assert.ok(text.includes("network error"));
    assert.ok(text.includes("dns failure"));
  });

  it("works with no allowance file (fresh install)", async () => {
    globalThis.fetch = (async () => jsonResponse({
      status: "healthy",
      checks: { postgres: "ok" },
      version: "1.0.0",
    })) as typeof fetch;

    const result = await handleServiceHealth({} as Record<string, never>);
    assert.equal(result.isError, undefined);
    assert.deepEqual(readdirSync(tempDir), []);
  });
});
