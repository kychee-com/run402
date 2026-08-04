import assert from "node:assert/strict";
import { describe, it } from "node:test";
import bolt11 from "bolt11";

import {
  Bolt11PolicyError,
  RUN402_LIGHTNING_BUYER_BOLT11_POLICY,
  verifyStrictBolt11,
} from "./lightning-bolt11.js";

const NETWORK = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] };
const SIGNER = "01".repeat(32);
const PAYMENT_HASH = "11".repeat(32);
const PAYMENT_SECRET = "22".repeat(32);
const TIMESTAMP = 1_785_500_000;

function featureBits() {
  return {
    var_onion_optin: { required: true, supported: false },
    payment_secret: { required: true, supported: false },
    basic_mpp: { required: false, supported: true },
    extra_bits: {
      start_bit: 20,
      bits: [false, false, false, false, false, true],
    },
  };
}

function invoice(options: { amountless?: boolean; route?: boolean; features?: Record<string, unknown> } = {}): string {
  const tags: Array<{ tagName: string; data: unknown }> = [
    { tagName: "payment_hash", data: PAYMENT_HASH },
    { tagName: "payment_secret", data: PAYMENT_SECRET },
    { tagName: "description", data: "Run402 Gate 5 charge" },
    { tagName: "expire_time", data: 300 },
    { tagName: "min_final_cltv_expiry", data: 40 },
    { tagName: "feature_bits", data: options.features ?? featureBits() },
  ];
  if (options.route) tags.push({ tagName: "routing_info", data: [{
    pubkey: "03" + "44".repeat(32), short_channel_id: "0000000000000001",
    fee_base_msat: 1, fee_proportional_millionths: 1, cltv_expiry_delta: 40,
  }] });
  const payload: Record<string, unknown> = { network: NETWORK, timestamp: TIMESTAMP, tags };
  if (!options.amountless) payload.satoshis = 1_000;
  return bolt11.sign(bolt11.encode(payload as never, false), SIGNER).paymentRequest;
}

function verify(value: string): ReturnType<typeof verifyStrictBolt11> {
  const payee = bolt11.decode(invoice()).payeeNodeKey!;
  return verifyStrictBolt11({
    paymentRequest: value,
    expectedPaymentHash: PAYMENT_HASH,
    expectedAmountMsat: 1_000_000n,
    policy: { ...RUN402_LIGHTNING_BUYER_BOLT11_POLICY, payeeNodePubkeys: [payee] },
    now: new Date((TIMESTAMP + 200) * 1_000),
  });
}

describe("strict buyer BOLT11 profile", () => {
  it("accepts the fixed regtest whole-satoshi invoice", () => {
    const result = verify(invoice());
    assert.equal(result.amountMsat, 1_000_000n);
    assert.deepEqual(result.featureBits, [8, 14, 17, 25]);
  });

  for (const fixture of [
    { id: "amountless", value: () => invoice({ amountless: true }), reason: "amount_required" },
    { id: "route hint", value: () => invoice({ route: true }), reason: "route_hints_not_allowed" },
    {
      id: "missing basic_mpp",
      value: () => invoice({ features: {
        var_onion_optin: { required: true, supported: false },
        payment_secret: { required: true, supported: false },
        extra_bits: {
          start_bit: 20,
          bits: [false, false, false, false, false, true],
        },
      } }),
      reason: "feature_bit_required:17",
    },
  ]) {
    it(`rejects ${fixture.id}`, () => {
      assert.throws(() => verify(fixture.value()), (error: unknown) =>
        error instanceof Bolt11PolicyError && error.errors.includes(fixture.reason));
    });
  }
});
