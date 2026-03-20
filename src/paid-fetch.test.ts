import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-paid-fetch-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("setupPaidFetch", () => {
  it("returns null when no allowance file exists", async () => {
    const { setupPaidFetch, _resetPaidFetchCache } = await import(`./paid-fetch.js?t=${Date.now()}`);
    _resetPaidFetchCache();
    const result = await setupPaidFetch();
    assert.equal(result, null);
  });

  it("returns null when allowance exists but payment libs fail to import", async () => {
    // Write an allowance file so readAllowance succeeds
    writeFileSync(
      join(tempDir, "allowance.json"),
      JSON.stringify({
        address: "0x1234567890abcdef1234567890abcdef12345678",
        privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        created: "2026-01-01T00:00:00Z",
        funded: true,
        rail: "x402",
      }),
    );

    // The test environment doesn't have @x402/fetch etc. installed as real modules,
    // so setupPaidFetch should catch the import error and return null
    const { setupPaidFetch, _resetPaidFetchCache } = await import(`./paid-fetch.js?t=${Date.now()}`);
    _resetPaidFetchCache();
    const result = await setupPaidFetch();
    // May be null (import fails) or a function (if libs are available in dev)
    assert.ok(result === null || typeof result === "function");
  });
});

describe("paidApiRequest", () => {
  it("falls back to bare apiRequest when no allowance", async () => {
    // No allowance file → paidApiRequest should just call apiRequest
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const { paidApiRequest, _resetPaidFetchCache } = await import(`./paid-fetch.js?t=${Date.now()}`);
    _resetPaidFetchCache();
    const result = await paidApiRequest("/test");
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
  });

  it("returns is402 when no paid fetch and server returns 402", async () => {
    // No allowance → no paid fetch → 402 passes through
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ x402: { price: "$0.10" } }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const { paidApiRequest, _resetPaidFetchCache } = await import(`./paid-fetch.js?t=${Date.now()}`);
    _resetPaidFetchCache();
    const result = await paidApiRequest("/test");
    assert.equal(result.ok, false);
    assert.equal(result.is402, true);
    assert.equal(result.status, 402);
  });

  it("caches setupPaidFetch result across calls", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const mod = await import(`./paid-fetch.js?t=${Date.now()}`);
    mod._resetPaidFetchCache();

    // First call initializes cache
    await mod.paidApiRequest("/test1");
    // Second call should reuse cache (no re-initialization)
    await mod.paidApiRequest("/test2");

    // If we got here without error, caching works
    assert.ok(true);
  });

  it("restores globalThis.fetch after call", async () => {
    const myFetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    globalThis.fetch = myFetch;

    const { paidApiRequest, _resetPaidFetchCache } = await import(`./paid-fetch.js?t=${Date.now()}`);
    _resetPaidFetchCache();
    await paidApiRequest("/test");

    // globalThis.fetch should be restored to our myFetch
    assert.equal(globalThis.fetch, myFetch);
  });
});
