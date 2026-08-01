import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LightningValuationError,
  authorizeLightningDebit,
  fetchLightningBuyerValuation,
  type LightningSellerQuote,
} from "./lightning-valuation.js";

const NOW = new Date("2026-07-31T12:00:00.000Z");

function quote(overrides: Partial<LightningSellerQuote> = {}): LightningSellerQuote {
  return {
    source: "coinbase_exchange_btc_usd_bid_v1",
    sourceReference: "coinbase-sequence-1",
    sourceObservationInstant: new Date("2026-07-31T11:59:59.000Z"),
    rateNumerator: 100_500_000_000n,
    rateDenominator: 1n,
    spreadBps: 50,
    quoteInstant: NOW,
    quoteExpiryInstant: new Date("2026-07-31T12:00:45.000Z"),
    ...overrides,
  };
}

describe("Lightning buyer valuation", () => {
  it("uses concurrent fresh Coinbase/Gemini observations and the conservative rate", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      return url.includes("coinbase")
        ? new Response(JSON.stringify({ bid: "100000.00", ask: "100100.00", time: "2026-07-31T11:59:59.000Z" }), { status: 200 })
        : new Response(JSON.stringify({ bid: "100150.00", ask: "100200.00" }), { status: 200 });
    };
    const value = await fetchLightningBuyerValuation({ retainedSellerQuote: quote(), fetchImpl, now: () => NOW });
    assert.equal(value.buyerRateUsdMicrosPerBtc, 100_200_000_000n);
    assert.equal(value.conservativeRateUsdMicrosPerBtc, 100_500_000_000n);
  });

  it("rejects expired or policy-mismatched retained quotes before source use", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls += 1; return new Response("{}"); };
    await assert.rejects(fetchLightningBuyerValuation({
      retainedSellerQuote: quote({ spreadBps: 0 }),
      fetchImpl,
      now: () => NOW,
    }), (error: unknown) => error instanceof LightningValuationError && error.code === "PAYMENT_QUOTE_EXPIRED");
    assert.equal(calls, 0);
  });

  it("enforces invoice-plus-fee against both native and conservative USD bounds", () => {
    assert.deepEqual(authorizeLightningDebit({
      invoiceAmountMsat: 80_000,
      authorizedMaxFeeMsat: 10_000,
      maxNativeAmountMsat: 90_000,
      canonicalAmountUsdMicros: 90_000,
      maxUsdMicros: 100_000,
      conservativeRateUsdMicrosPerBtc: 100_000_000_000n,
    }), { authorizedTotalMsat: 90_000, authorizedTotalUsdMicros: 90_000 });

    assert.throws(() => authorizeLightningDebit({
      invoiceAmountMsat: 80_000, authorizedMaxFeeMsat: 10_001,
      maxNativeAmountMsat: 90_000, canonicalAmountUsdMicros: 90_000,
      maxUsdMicros: 100_000, conservativeRateUsdMicrosPerBtc: 100_000_000_000n,
    }), (error: unknown) => error instanceof LightningValuationError &&
      error.code === "PAYMENT_NATIVE_AMOUNT_EXCEEDS_MAX");

    assert.throws(() => authorizeLightningDebit({
      invoiceAmountMsat: 80_000, authorizedMaxFeeMsat: 10_000,
      maxNativeAmountMsat: 100_000, canonicalAmountUsdMicros: 90_000,
      maxUsdMicros: 89_999, conservativeRateUsdMicrosPerBtc: 100_000_000_000n,
    }), (error: unknown) => error instanceof LightningValuationError &&
      error.code === "PAYMENT_USD_AMOUNT_EXCEEDS_MAX");
  });
});
