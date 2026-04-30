/**
 * Unit tests for the `allowance` namespace — focused on `status()` output
 * shape. Regression test for GH-109: `status()` must surface a
 * `faucet_used` boolean rather than `funded`, because the on-disk `funded`
 * flag only tracks "faucet was invoked on this allowance," not "account can
 * pay right now." Users wanting real pay-readiness should call
 * `allowance balance`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import type { AllowanceData, CredentialsProvider } from "../credentials.js";

function makeCreds(allowance: AllowanceData | null, opts: { saveAllowance?: boolean } = {}): CredentialsProvider {
  const provider: CredentialsProvider = {
    async getAuth() { return null; },
    async getProject() { return null; },
    async readAllowance() { return allowance; },
    getAllowancePath() { return "/tmp/allowance.json"; },
  };
  if (opts.saveAllowance) {
    provider.saveAllowance = async () => {};
  }
  return provider;
}

function sdk(creds: CredentialsProvider): Run402 {
  // `fetch` is unused here because `status()` is fully local.
  const stubFetch: typeof globalThis.fetch = async () => new Response("{}", { status: 200 });
  return new Run402({ apiBase: "https://api.test", credentials: creds, fetch: stubFetch });
}

function sdkWithFetch(creds: CredentialsProvider, fetchImpl: typeof globalThis.fetch): Run402 {
  return new Run402({ apiBase: "https://api.test", credentials: creds, fetch: fetchImpl });
}

describe("allowance.status", () => {
  it("returns faucet_used=true when the on-disk allowance's internal funded marker is set", async () => {
    const result = await sdk(makeCreds({
      address: "0xAbC",
      privateKey: "0xpk",
      created: "2026-01-01T00:00:00.000Z",
      funded: true,
      lastFaucet: "2026-01-02T00:00:00.000Z",
    })).allowance.status();

    assert.equal(result.configured, true);
    assert.equal(result.address, "0xAbC");
    assert.equal((result as Record<string, unknown>).faucet_used, true,
      "status() must surface faucet_used (not funded) so callers don't mistake it for a balance check");
    // Regression: the misleading `funded` field must not appear in the output.
    assert.ok(!Object.prototype.hasOwnProperty.call(result, "funded"),
      "status() must not expose a `funded` key — that name is misleading (see GH-109)");
  });

  it("returns faucet_used=false (never undefined) when the allowance has never hit the faucet", async () => {
    const result = await sdk(makeCreds({
      address: "0xAbC",
      privateKey: "0xpk",
      created: "2026-01-01T00:00:00.000Z",
      funded: false,
    })).allowance.status();

    assert.equal(result.configured, true);
    assert.equal((result as Record<string, unknown>).faucet_used, false);
  });

  it("returns configured=false with no faucet_used when no allowance is configured", async () => {
    const result = await sdk(makeCreds(null)).allowance.status();
    assert.equal(result.configured, false);
    assert.equal(result.address, "");
    assert.ok(!Object.prototype.hasOwnProperty.call(result, "funded"));
  });
});

describe("allowance.faucet", () => {
  // Regression test for GH-163: the live gateway responds with snake_case keys
  // and `amount_usd_micros` (number). The SDK must normalize to the typed
  // camelCase shape so callers don't see `undefined` for transactionHash/amount.
  it("normalizes the snake_case + micros wire shape into the typed camelCase result", async () => {
    const wireBody = {
      transaction_hash: "0xabc123",
      amount_usd_micros: 250000,
      token: "USDC",
      network: "base-sepolia",
    };
    const fetchImpl: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify(wireBody), { status: 200, headers: { "Content-Type": "application/json" } });

    const creds = makeCreds({
      address: "0xAbC",
      privateKey: "0xpk",
      created: "2026-01-01T00:00:00.000Z",
    }, { saveAllowance: true });

    const result = await sdkWithFetch(creds, fetchImpl).allowance.faucet();

    assert.equal(result.transactionHash, "0xabc123",
      "wire's `transaction_hash` must surface as `transactionHash`");
    assert.equal(result.amountUsdMicros, 250000,
      "wire's `amount_usd_micros` must surface as `amountUsdMicros`");
    assert.equal(result.amount, "0.25",
      "amount must be a display-formatted string derived from micros");
    assert.equal(result.token, "USDC");
    assert.equal(result.network, "base-sepolia");
  });
});
