import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handleCheckBalance } from "./check-balance.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.RUN402_API_BASE;
});

describe("check_balance tool", () => {
  it("returns formatted balance for existing account", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          wallet: "0xabc",
          exists: true,
          available_usd_micros: 2500000,
          held_usd_micros: 100000,
          status: "active",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleCheckBalance({ wallet: "0xABC" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("$2.50"));
    assert.ok(text.includes("$0.10"));
    assert.ok(text.includes("active"));
    assert.equal(result.isError, undefined);
  });

  it("lowercases wallet address", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      // Handle Request instances (paid-fetch wrapper may normalize args).
      capturedUrl = input instanceof Request ? input.url : String(input);
      return new Response(
        JSON.stringify({ wallet: "0xabc", exists: true, available_usd_micros: 0, held_usd_micros: 0, status: "active" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleCheckBalance({ wallet: "0xABCDEF" });
    assert.ok(capturedUrl.includes("0xabcdef"));
  });

  it("returns guidance when no billing account exists", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ wallet: "0xabc", exists: false, available_usd_micros: 0, held_usd_micros: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleCheckBalance({ wallet: "0xABC" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("No billing account found"));
    assert.equal(result.isError, undefined);
  });

  it("returns isError on API failure", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "internal error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleCheckBalance({ wallet: "0xABC" });
    assert.equal(result.isError, true);
  });
});
