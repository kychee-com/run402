/**
 * #639 — a paid call must not stay silent about what it just paid.
 *
 * The SDK decodes the seller's PAYMENT-RESPONSE settlement receipt so every
 * surface can say what settled and on which network. These assertions pin the
 * two properties that make that disclosure trustworthy:
 *
 *  1. It is OBSERVED. The network comes from the seller's receipt, never from
 *     local wallet config — a buyer holding mainnet funds makes a
 *     config-derived guess wrong.
 *  2. It NEVER converts a successful purchase into a failure. A malformed or
 *     absent receipt yields null, not a throw.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeSettlementReceipt } from "./sdk/dist/kernel.js";

const headersOf = (map) => ({ headers: { get: (n) => map[n] ?? map[n.toLowerCase()] ?? null } });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

// The exact receipt observed from production on 2026-07-31.
const REAL = {
  success: true,
  payer: "0x58f3d844b9ffe8EB299afE3B49b2A634Ab7a3c4f",
  transaction: "0x42cca848cc8b412178deb8abc1583af6f08c177086919b70993829a48e8fda46",
  network: "eip155:84532",
};

describe("#639 settlement receipt decoding", () => {
  it("decodes a real production receipt", () => {
    const s = decodeSettlementReceipt(headersOf({ "PAYMENT-RESPONSE": b64(REAL) }));
    assert.equal(s.network, "eip155:84532");
    assert.equal(s.transaction, REAL.transaction);
    assert.equal(s.payer, REAL.payer);
    assert.equal(s.success, true);
  });

  it("accepts the X- prefixed spelling too", () => {
    assert.ok(decodeSettlementReceipt(headersOf({ "X-PAYMENT-RESPONSE": b64(REAL) })));
  });

  it("returns null when no payment was made — NOT an error", () => {
    // Absent receipt means this request moved no money (e.g. prepaid), which
    // must read as "nothing to disclose", never as a failed payment.
    assert.equal(decodeSettlementReceipt(headersOf({})), null);
  });

  for (const [label, header] of [
    ["not base64", "!!!!not-base64!!!!"],
    ["base64 of non-JSON", Buffer.from("hello").toString("base64")],
    ["JSON missing network", b64({ success: true, transaction: "0xabc" })],
    ["JSON missing transaction", b64({ success: true, network: "eip155:8453" })],
  ]) {
    it(`returns null for a malformed receipt (${label}) rather than throwing`, () => {
      // A reporting concern must never turn a SUCCESSFUL purchase into an error.
      assert.equal(decodeSettlementReceipt(headersOf({ "PAYMENT-RESPONSE": header })), null);
    });
  }
});
