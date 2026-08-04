import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseUsdMicros, run } from "./pay.mjs";

describe("run402 pay", () => {
  it("converts decimal USD to micros without floating-point rounding", () => {
    assert.equal(parseUsdMicros("0.05"), 50_000);
    assert.equal(parseUsdMicros("1.000001"), 1_000_001);
    assert.equal(parseUsdMicros("0"), 0);
  });

  it("delegates to SDK pay.fetch and prints the receipt", async () => {
    let captured;
    const output = [];
    await run([
      "https://seller.example/translate",
      "--method", "POST",
      "--body", '{"text":"hello"}',
      "--max-usd", "0.05",
      "--idempotency-key", "translation:1",
      "--require-receipt",
    ], {
      getSdk: () => ({
        pay: {
          async fetch(url, init, options) {
            captured = { url, init, options };
            return {
              response: new Response('{"translated":"hola"}', {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
              payment: {
                amount_usd_micros: 10_000,
                pay_to: "0xseller",
                network: "eip155:8453",
                tx_ref: "0xtx",
                url,
                paymentId: "txp_cli_1",
                amountUsdMicros: 10_000,
                asset: "USDC",
                payer: "0xbuyer",
                payTo: "0xseller",
                transaction: "0xtx",
                resourceUrl: url,
                settlement: { status: "verified" },
                fundsMoved: true,
                deduplicated: false,
                delivery: { status: "fulfilled", replay: false },
                offer: {
                  status: "verified",
                  resourceUrl: url,
                  validUntil: "2026-07-22T12:05:00.000Z",
                },
                merchantReceipt: {
                  status: "verified",
                  claim: "service_delivered",
                  issuedAt: "2026-07-22T12:00:03.000Z",
                },
                signerRelationship: {
                  kind: "direct",
                  merchantRoot: "0xseller",
                  signer: "0xseller",
                  authorizationExpiresAt: null,
                },
                policy: {
                  requireReceipt: true,
                  status: "satisfied",
                },
                evidence: {
                  offer: { signature: "0xoffer" },
                  merchantReceipt: { signature: "0xreceipt" },
                  signerAuthorization: null,
                },
              },
              outcome: "settled",
              replay: false,
              paymentId: "txp_cli_1",
              deduplicated: false,
              fundsMoved: true,
              delivery: "first",
              settledAt: "2026-07-22T12:00:00.000Z",
              intentState: "settled",
            };
          },
        },
      }),
      write: (value) => output.push(value),
    });

    assert.equal(captured.url, "https://seller.example/translate");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.body, '{"text":"hello"}');
    assert.equal(new Headers(captured.init.headers).get("content-type"), "application/json");
    assert.deepEqual(captured.options, {
      maxUsdMicros: 50_000,
      idempotencyKey: "translation:1",
      requireReceipt: true,
    });
    assert.deepEqual(JSON.parse(output[0]), {
      schema_version: "x402-commerce-result.v1",
      http_status: 200,
      body: { translated: "hola" },
      payment: {
        amount_usd_micros: 10_000,
        asset: "USDC",
        deduplicated: false,
        delivery: { replay: false, status: "fulfilled" },
        evidence: {
          merchant_receipt: { signature: "0xreceipt" },
          offer: { signature: "0xoffer" },
          signer_authorization: null,
        },
        funds_moved: true,
        merchant_receipt: {
          claim: "service_delivered",
          issued_at: "2026-07-22T12:00:03.000Z",
          status: "verified",
        },
        pay_to: "0xseller",
        payer: "0xbuyer",
        payment_id: "txp_cli_1",
        policy: { require_receipt: true, status: "satisfied" },
        resource_url: "https://seller.example/translate",
        settlement: { status: "verified" },
        signer_relationship: {
          authorization_expires_at: null,
          kind: "direct",
          merchant_root: "0xseller",
          signer: "0xseller",
        },
        network: "eip155:8453",
        transaction: "0xtx",
        offer: {
          resource_url: "https://seller.example/translate",
          status: "verified",
          valid_until: "2026-07-22T12:05:00.000Z",
        },
      },
      payment_result: {
        protocol: "x402",
        method: "exact",
        intent: "charge",
        profile: null,
        intent_id: "txp_cli_1",
        attempt_id: null,
        amount_usd_micros: 10_000,
        invoice_amount_msat: null,
        received_amount_msat: null,
        excess_amount_msat: null,
        payment_hash: null,
        funds_moved: true,
        raw_node_state: null,
        terminality: "terminal_paid",
        settlement_role: null,
        operation_state: "fulfilled",
        recovery_state: null,
        replay: false,
        payment_receipt: null,
        settlement_attestation: null,
        outcome_attestations: [],
        merchant_fulfillment: {
          status: "verified",
          claim: "service_delivered",
          issuedAt: "2026-07-22T12:00:03.000Z",
        },
        current_status: null,
        credits: [],
      },
      outcome: "paid",
      replay: false,
      next_actions: [],
    });
  });

  it("passes ordered Lightning preferences, exact profile, and native bounds", async () => {
    let captured;
    await run([
      "https://api.run402.test/tiers/v1/prototype",
      "--method", "POST",
      "--body", "{}",
      "--max-usd", "0.20",
      "--idempotency-key", "tier:lightning:1",
      "--payment-preferences", '[{"protocol":"mpp","method":"lightning","intent":"charge","wallet":"nwc:deploy-bot"}]',
      "--payment-profile", "run402-mpp-lightning-charge-draft00-safety-v1",
      "--max-native-msat", "1100000",
      "--max-routing-fee-msat", "10000",
      "--evidence-policy", "run402_settlement",
    ], {
      getSdk: () => ({
        pay: {
          async fetch(_url, _init, options) {
            captured = options;
            return {
              response: new Response("ok", { status: 200 }),
              payment: null, outcome: "not_required", replay: false,
            };
          },
        },
      }),
      write: () => {},
    });
    assert.deepEqual(captured, {
      maxUsdMicros: 200_000,
      idempotencyKey: "tier:lightning:1",
      paymentPreferences: [{
        protocol: "mpp", method: "lightning", intent: "charge", wallet: "nwc:deploy-bot",
      }],
      profile: "run402-mpp-lightning-charge-draft00-safety-v1",
      maxNativeAmountMsat: 1_100_000,
      maxRoutingFeeMsat: 10_000,
      evidencePolicy: "run402_settlement",
    });
  });
});
