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
  it("summarizes the runtime payload shape", async () => {
    globalThis.fetch = (async () => jsonResponse({
      status: "ok",
      uptime_seconds: 86400,
      deployment: { version: "1.0.4" },
      capabilities: ["x402", "siwx", "postgres", "functions"],
      operator: { name: "Run402", contact: "https://run402.com" },
    })) as typeof fetch;

    const result = await handleServiceStatus({} as Record<string, never>);
    const text = result.content[0]!.text;
    assert.equal(result.isError, undefined);
    assert.ok(text.includes("ok"), "includes status");
    assert.ok(text.includes("Run402"), "includes operator name");
    assert.match(text, /\(https:\/\/run402\.com\)/, "includes operator contact");
    assert.ok(text.includes("1.0.4"), "includes deployment version");
    assert.ok(text.includes("x402"), "includes capability");
    assert.ok(text.includes("24.0h"), "renders uptime in hours");
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
    globalThis.fetch = (async () => jsonResponse({
      status: "ok",
      uptime_seconds: 100,
      deployment: { version: "1.0.4" },
      capabilities: [],
      operator: { name: "Run402", contact: "https://run402.com" },
    })) as typeof fetch;

    const result = await handleServiceStatus({} as Record<string, never>);
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("ok"));
    assert.deepEqual(readdirSync(tempDir), []);
  });
});
