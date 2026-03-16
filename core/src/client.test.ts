import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
const originalApiBase = process.env.RUN402_API_BASE;

beforeEach(() => {
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiBase !== undefined) {
    process.env.RUN402_API_BASE = originalApiBase;
  } else {
    delete process.env.RUN402_API_BASE;
  }
});

describe("core client.apiRequest", () => {
  it("returns parsed JSON for 200 response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "proj-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const { apiRequest } = await import("./client.js");
    const result = await apiRequest("/projects/v1");
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { id: "proj-1" });
  });

  it("returns is402 for 402 response", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ x402: { price: "$0.10" } }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const { apiRequest } = await import("./client.js");
    const result = await apiRequest("/projects/v1");
    assert.equal(result.ok, false);
    assert.equal(result.is402, true);
    assert.equal(result.status, 402);
  });

  it("handles network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const { apiRequest } = await import("./client.js");
    const result = await apiRequest("/health");
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    const body = result.body as Record<string, string>;
    assert.ok(body.error.includes("ECONNREFUSED"));
  });
});
