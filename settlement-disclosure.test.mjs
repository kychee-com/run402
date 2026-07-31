/**
 * #639 — a paid tool must not stay silent about what it just paid.
 *
 * `generate_image` returned exactly `Generated square image (image/png)` after
 * moving money. Because the documented quickstart faucet-funds Base Sepolia
 * (#628), a buyer could watch a payment succeed with no way to learn it was
 * test money — and our own claims wall would then refuse the transaction they
 * had just made. `pay_url`, in the same server, has always reported settlement.
 *
 * These assertions pin the two properties that make the disclosure trustworthy:
 *
 *  1. It is OBSERVED. The network comes from the seller's PAYMENT-RESPONSE
 *     receipt, never from local wallet config — a buyer holding mainnet funds
 *     makes a config-derived guess wrong, and reporting an inference as an
 *     observation is the error class this project keeps getting bitten by.
 *  2. It NEVER converts a successful purchase into a failure. A malformed or
 *     absent receipt yields null, not a throw; the image still comes back.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("#639 the tool discloses, and flags test money", () => {
  const source = readFileSync(join(import.meta.dirname, "src/tools/generate-image.ts"), "utf8");

  it("renders settlement onto the success text", () => {
    assert.match(
      source,
      /Generated \$\{body\.aspect\} image \(\$\{body\.content_type\}\)\$\{renderSettlement\(body\.payment\)\}/,
      "the success line must carry the settlement disclosure",
    );
  });

  it("keys the testnet warning on the OBSERVED network, not on config", () => {
    assert.match(source, /TESTNET_LABELS\[payment\.network\]/);
    // Target config READS, not the word "allowance" — the message text names
    // `allowance_export` as guidance, which is prose, not a data source. The
    // first version of this assertion failed on exactly that, which is the
    // reminder that a gate matching too broadly reports its own imprecision as
    // a defect.
    assert.doesNotMatch(
      source,
      /readAllowance\(|getConfigDir\(|process\.env\.RUN402_|\.rail\b/,
      "the warning must derive from the settlement receipt, never from local wallet config",
    );
  });

  it("says plainly that test money is not a real payment", () => {
    assert.match(source, /TEST money/);
    assert.match(source, /cannot appear on the wall/);
  });

  it("does not warn on mainnet", () => {
    assert.match(source, /"eip155:8453": "Base"/, "Base mainnet must render as an ordinary receipt");
  });
});
