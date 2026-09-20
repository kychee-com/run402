/**
 * Spend controls are run402's, never inherited from the payment library.
 *
 * `@x402/core` 2.22+ ships a client-side default cap of $1 per payment. A
 * fresh `npm i -g run402` on 2026-09-20 resolved 2.26.0 through a caret range,
 * inherited that default, and refused to sign a $5 hobby or $20 team purchase
 * with an error the CLI could not even display. This file pins both halves:
 * the library's default really does refuse $20 (so the override is not
 * ceremony), and run402's configured client signs it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import {
  assertFirstPartyPaymentWithinCap,
  FIRST_PARTY_MAX_PAYMENT_USD_MICROS,
  PaymentBuyerCapError,
} from "./paid-fetch.js";

const TEAM_TIER_USD_MICROS = 20_000_000;

function requirement(amount: string, url = "https://api.run402.com/tiers/v1/team") {
  return {
    x402Version: 2,
    resource: { url },
    accepts: [{
      scheme: "exact",
      network: "eip155:84532",
      amount,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x000000000000000000000000000000000000dEaD",
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    }],
  };
}

function freshClient() {
  const account = privateKeyToAccount(generatePrivateKey());
  const pub = createPublicClient({ chain: baseSepolia, transport: http("http://127.0.0.1:9") });
  const client = new x402Client();
  client.register("eip155:84532", new ExactEvmScheme(toClientEvmSigner(account, pub)));
  return client;
}

describe("x402 client spend controls", () => {
  it("the library's own default refuses a $20 team purchase (why the override exists)", async () => {
    const client = freshClient();
    await assert.rejects(
      () => client.createPaymentPayload(requirement(String(TEAM_TIER_USD_MICROS)) as never),
      (err: Error) => /maxAmountPerPayment/.test(err.message),
    );
  });

  it("run402's configuration signs a $20 team purchase", async () => {
    const client = freshClient();
    assert.equal(typeof client.setSpendControls, "function", "the pinned library must expose setSpendControls");
    client.setSpendControls(false);
    const payload = await client.createPaymentPayload(requirement(String(TEAM_TIER_USD_MICROS)) as never);
    assert.equal(payload.x402Version, 2);
    assert.ok(payload.payload, "a signed payload must come back");
  });
});

describe("first-party payment cap", () => {
  it("lets every real gateway price through, including the largest", () => {
    for (const amount of ["100000", "5000000", String(TEAM_TIER_USD_MICROS)]) {
      assert.doesNotThrow(() => assertFirstPartyPaymentWithinCap(requirement(amount), "https://api.run402.com"));
    }
    assert.equal(FIRST_PARTY_MAX_PAYMENT_USD_MICROS, TEAM_TIER_USD_MICROS, "the cap is the team tier price");
  });

  it("refuses a first-party challenge above the largest known price", () => {
    assert.throws(
      () => assertFirstPartyPaymentWithinCap(requirement("20000001"), "https://api.run402.com"),
      (err: unknown) => err instanceof PaymentBuyerCapError && err.code === "X402_AMOUNT_EXCEEDS_FIRST_PARTY_CAP",
    );
  });

  it("does not bound arbitrary-URL purchases (pay.fetch carries its own maxUsdMicros)", () => {
    assert.doesNotThrow(() =>
      assertFirstPartyPaymentWithinCap(requirement("999000000", "https://merchant.example/item"), "https://api.run402.com"),
    );
  });
});
