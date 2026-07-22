import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PaymentBuyerError } from "../../sdk/dist/index.js";
import { handlePayUrl, payUrlSchema } from "./pay-url.js";

describe("pay_url", () => {
  it("exposes the bounded buyer inputs", () => {
    assert.deepEqual(Object.keys(payUrlSchema).sort(), [
      "body",
      "idempotency_key",
      "max_usd_micros",
      "method",
      "url",
    ]);
  });

  it("delegates to SDK pay.fetch and returns response plus payment metadata", async () => {
    let captured: Record<string, unknown> | undefined;
    const result = await handlePayUrl({
      url: "https://seller.example/resource",
      method: "POST",
      body: { hello: "world" },
      idempotency_key: "seller:1",
      max_usd_micros: 25_000,
    }, {
      getSdk: () => ({
        pay: {
          async fetch(url: string, init: RequestInit, options: unknown) {
            captured = { url, init, options };
            return {
              response: new Response("created", {
                status: 201,
                headers: { "content-type": "text/plain" },
              }),
              payment: null,
              outcome: "not_required" as const,
              replay: false,
            };
          },
        },
      }),
    });

    assert.equal(captured?.url, "https://seller.example/resource");
    assert.deepEqual(captured?.options, {
      idempotencyKey: "seller:1",
      maxUsdMicros: 25_000,
    });
    const text = result.content[0]!.text;
    assert.match(text, /"http_status": 201/);
    assert.match(text, /"body": "created"/);
    assert.match(text, /"outcome": "not_required"/);
  });

  it("preserves structured buyer errors, funds-moved truth, and next actions", async () => {
    const result = await handlePayUrl({ url: "https://seller.example/resource" }, {
      getSdk: () => ({
        pay: {
          async fetch() {
            throw new PaymentBuyerError({
              code: "PAYMENT_WALLET_UNFUNDED",
              message: "No funded x402 wallet is available for this payment.",
              fundsMoved: false,
              details: { challenge_networks: ["eip155:8453"] },
              nextActions: [{ type: "fund_wallet", why: "Fund USDC before retrying." }],
            });
          },
        },
      }),
    });

    assert.equal(result.isError, true);
    const text = result.content[0]!.text;
    assert.match(text, /Code: `PAYMENT_WALLET_UNFUNDED`/);
    assert.match(text, /"funds_moved": false/);
    assert.match(text, /Next actions:/);
    assert.match(text, /fund_wallet/);
  });
});
