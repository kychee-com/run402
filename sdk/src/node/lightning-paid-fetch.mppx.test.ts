/**
 * The Lightning buyer against the real `mppx` codecs (the optional peer the
 * production path loads): a challenge serialized the way the gateway does
 * it round-trips through `readLightningChallenge`, and the credential the
 * buyer presents deserializes back to the same challenge with the preimage.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { Challenge, Credential } from "mppx";

import { loadLightningStack } from "./_paid-stack.js";
import { createLightningFetch, readLightningChallenge } from "./lightning-paid-fetch.js";

const PREIMAGE = "33".repeat(32);
const HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const URI = `nostr+walletconnect://${"2".repeat(64)}?relay=wss%3A%2F%2Frelay.example&secret=${"1".repeat(64)}`;

function gatewayChallengeHeader(): string {
  const challenge = Challenge.from({
    id: "3f0b2f1e-2f7a-4d1a-9c1b-7d2f1e3a4b5c",
    realm: "api.run402.com",
    method: "lightning",
    intent: "charge",
    request: {
      amount: "130",
      currency: "sat",
      description: "Run402 prototype tier",
      methodDetails: { invoice: "lnbc1300n1fixture", paymentHash: HASH, network: "mainnet" },
    },
    digest: "sha-256=AAAA",
    expires: "2030-01-01T00:00:00.000Z",
    meta: { intent: "pi_x", attempt: "pa_x", operation: "b".repeat(64), contract: "c".repeat(64), quote: "d".repeat(64) },
  });
  return Challenge.serialize(challenge);
}

describe("Lightning buyer with the real mppx codecs", () => {
  it("reads a gateway-shaped challenge and presents a credential that deserializes to it", async () => {
    const stack = await loadLightningStack();
    const header = gatewayChallengeHeader();
    const parsed = readLightningChallenge(new Response("", { status: 402, headers: { "www-authenticate": header } }), stack);
    assert.equal(parsed?.invoice, "lnbc1300n1fixture");
    assert.equal(parsed?.paymentHash, HASH);
    assert.equal(parsed?.amountSats, 130);

    const seen: string[] = [];
    const baseFetch: typeof globalThis.fetch = async (_input, init) => {
      const authorization = new Headers(init?.headers ?? {}).get("authorization");
      if (!authorization) return new Response("{}", { status: 402, headers: { "www-authenticate": header } });
      seen.push(authorization);
      return new Response("{}", { status: 200 });
    };
    const fetch = createLightningFetch({
      pairingUri: URI, baseFetch, stack: loadLightningStack, fallback: async () => null,
      wallet: {
        async getBudgetSats() { return null; },
        async getBalanceSats() { return 1_000; },
        async payInvoice() { return { preimage: PREIMAGE }; },
        async lookupInvoice() { return null; },
      },
    });
    const response = await fetch("https://api.run402.com/tiers/v1/prototype", { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    const credential = Credential.deserialize<{ preimage: string }>(seen[0]!);
    assert.equal(credential.payload.preimage, PREIMAGE);
    assert.equal(Challenge.serialize(credential.challenge), header, "the credential carries the retained challenge byte for byte");
  });
});
