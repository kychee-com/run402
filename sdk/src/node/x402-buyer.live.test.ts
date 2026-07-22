/**
 * Opt-in live settlement smoke test.
 *
 * Required:
 *   RUN402_X402_BUYER_LIVE_URL=https://...   funded local allowance/signer
 * Optional:
 *   RUN402_X402_BUYER_LIVE_METHOD=POST
 *   RUN402_X402_BUYER_LIVE_BODY='{"ping":true}'
 *   RUN402_X402_BUYER_LIVE_MAX_USD_MICROS=100000
 *   RUN402_X402_BUYER_LIVE_IDEMPOTENCY_KEY=stable-intent-key
 */
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { run402 } from "./index.js";

const url = process.env.RUN402_X402_BUYER_LIVE_URL;

describe("pay.fetch live paid route", { skip: !url }, () => {
  it("settles and returns a transaction-backed receipt", async () => {
    const body = process.env.RUN402_X402_BUYER_LIVE_BODY;
    const method = process.env.RUN402_X402_BUYER_LIVE_METHOD ?? (body ? "POST" : "GET");
    const maxUsdMicros = Number(process.env.RUN402_X402_BUYER_LIVE_MAX_USD_MICROS ?? 100_000);
    assert.ok(Number.isSafeInteger(maxUsdMicros) && maxUsdMicros >= 0);

    const r = run402();
    const result = await r.pay.fetch(url!, {
      method,
      ...(body !== undefined
        ? { body, headers: { "content-type": "application/json" } }
        : {}),
    }, {
      maxUsdMicros,
      idempotencyKey:
        process.env.RUN402_X402_BUYER_LIVE_IDEMPOTENCY_KEY ?? `run402-live-${randomUUID()}`,
    });

    assert.equal(result.response.ok, true);
    assert.equal(result.outcome, "settled");
    assert.ok(result.payment);
    assert.ok(result.payment.amount_usd_micros > 0);
    assert.ok(result.payment.tx_ref.length > 0);
    assert.equal(result.payment.url, new URL(url!).toString());
  });
});
