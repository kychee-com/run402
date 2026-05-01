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
          identifier_type: "wallet",
          available_usd_micros: 2500000,
          email_credits_remaining: 42,
          tier: "prototype",
          lease_expires_at: "2026-05-07T14:49:10.884Z",
          auto_recharge_enabled: false,
          auto_recharge_threshold: 2000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleCheckBalance({ wallet: "0xABC" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("$2.50"));
    assert.ok(text.includes("prototype"));
    assert.ok(text.includes("42"));
    assert.equal(result.isError, undefined);
  });

  it("lowercases wallet address", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      capturedUrl = input instanceof Request ? input.url : String(input);
      return new Response(
        JSON.stringify({
          identifier_type: "wallet",
          available_usd_micros: 0,
          email_credits_remaining: 0,
          tier: null,
          lease_expires_at: null,
          auto_recharge_enabled: false,
          auto_recharge_threshold: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleCheckBalance({ wallet: "0xABCDEF" });
    assert.ok(capturedUrl.includes("0xabcdef"));
  });

  it("renders (none) when tier and lease are null", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          identifier_type: "wallet",
          available_usd_micros: 0,
          email_credits_remaining: 0,
          tier: null,
          lease_expires_at: null,
          auto_recharge_enabled: false,
          auto_recharge_threshold: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleCheckBalance({ wallet: "0xABC" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("(none)"));
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
