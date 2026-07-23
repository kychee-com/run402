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
      "require_receipt",
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
              paymentId: "txp_result_1",
              deduplicated: true,
              fundsMoved: false,
              delivery: "replay" as const,
              settledAt: "2026-07-22T12:00:00.000Z",
              intentState: "settled",
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
    assert.match(text, /HTTP 201/);
    assert.match(text, /Payment: not required/);
    assert.deepEqual(result.structuredContent, {
      schema_version: "x402-commerce-result.v1",
      http_status: 201,
      body: "created",
      payment: null,
      outcome: "not_paid",
      replay: false,
      next_actions: [],
    });
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

  it("keeps portable evidence but never exposes payment proofs or secret headers", async () => {
    const result = await handlePayUrl({
      url: "https://seller.example/resource",
      require_receipt: true,
    }, {
      getSdk: () => ({
        pay: {
          async fetch() {
            return {
              response: new Response('{"ok":true}', {
                status: 200,
                headers: {
                  "content-type": "application/json",
                  "payment-signature": "secret-payment-proof",
                  authorization: "Bearer secret-token",
                  cookie: "session=secret-cookie",
                },
              }),
              payment: {
                amount_usd_micros: 10_000,
                pay_to: "0xfeed000000000000000000000000000000000000",
                network: "eip155:8453",
                tx_ref: "0xtransaction",
                url: "https://seller.example/resource",
                paymentId: "pay_123",
                amountUsdMicros: 10_000,
                asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                payer: "0xbuyer00000000000000000000000000000000000",
                payTo: "0xfeed000000000000000000000000000000000000",
                transaction: "0xtransaction",
                resourceUrl: "https://seller.example/resource",
                settlement: { status: "verified" as const },
                fundsMoved: true,
                deduplicated: false,
                delivery: { status: "fulfilled" as const, replay: false },
                offer: {
                  status: "verified" as const,
                  resourceUrl: "https://seller.example/resource",
                  validUntil: "2026-07-22T12:05:00.000Z",
                },
                merchantReceipt: {
                  status: "verified" as const,
                  claim: "service_delivered" as const,
                  issuedAt: "2026-07-22T12:00:01.000Z",
                },
                signerRelationship: {
                  kind: "direct" as const,
                  merchantRoot: "0xfeed000000000000000000000000000000000000",
                  signer: "0xfeed000000000000000000000000000000000000",
                  authorizationExpiresAt: null,
                },
                policy: {
                  requireReceipt: true,
                  status: "satisfied" as const,
                },
                evidence: {
                  offer: { signature: "portable-offer-signature" },
                  merchantReceipt: {
                    signature: "portable-receipt-signature",
                  },
                  signerAuthorization: null,
                },
              },
              outcome: "settled" as const,
              replay: false,
              nextActions: [],
            };
          },
        },
      }),
    });

    const serialized = JSON.stringify(result);
    assert.match(serialized, /portable-offer-signature/);
    assert.match(serialized, /portable-receipt-signature/);
    assert.doesNotMatch(serialized, /secret-payment-proof/);
    assert.doesNotMatch(serialized, /secret-token/);
    assert.doesNotMatch(serialized, /secret-cookie/);
  });
});
