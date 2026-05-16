import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleCheckBalance } from "./check-balance.js";
import { _resetSdk } from "../sdk.js";

const originalFetch = globalThis.fetch;
const WALLET_UPPER = "0xABCDEF0123456789ABCDEF0123456789ABCDEF01";
const WALLET_LOWER = "0xabcdef0123456789abcdef0123456789abcdef01";

let tempDir: string;

beforeEach(() => {
  // Isolate from the developer's real ~/.config/run402/allowance.json so
  // the Node SDK's createLazyPaidFetch() resolves to the no-allowance
  // fallback path. Without this, `setupPaidFetch()` builds an x402-wrapped
  // fetch around the FIRST mocked globalThis.fetch and caches it on the
  // SDK singleton — subsequent tests' mocks never get called.
  tempDir = mkdtempSync(join(tmpdir(), "run402-check-balance-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  _resetSdk();
});

afterEach(() => {
  _resetSdk();
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
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

    const result = await handleCheckBalance({ wallet: WALLET_UPPER });
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

    await handleCheckBalance({ wallet: WALLET_UPPER });
    assert.ok(capturedUrl.includes(WALLET_LOWER));
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

    const result = await handleCheckBalance({ wallet: WALLET_UPPER });
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

    const result = await handleCheckBalance({ wallet: WALLET_UPPER });
    assert.equal(result.isError, true);
  });
});
