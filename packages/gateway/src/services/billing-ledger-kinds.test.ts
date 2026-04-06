import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isAllowedLedgerKind,
  assertAllowedLedgerKind,
  ALLOWED_LEDGER_KINDS,
} from "./billing-ledger-kinds.js";

describe("billing ledger kind allowlist", () => {
  it("includes the three new kms-wallet-contracts kinds", () => {
    assert.ok(isAllowedLedgerKind("kms_wallet_rental"));
    assert.ok(isAllowedLedgerKind("kms_sign_fee"));
    assert.ok(isAllowedLedgerKind("contract_call_gas"));
  });

  it("includes pre-existing kinds (back-compat)", () => {
    assert.ok(isAllowedLedgerKind("admin_credit"));
    assert.ok(isAllowedLedgerKind("admin_debit"));
  });

  it("rejects unknown kinds", () => {
    assert.equal(isAllowedLedgerKind("not_a_real_kind"), false);
    assert.equal(isAllowedLedgerKind(""), false);
  });

  it("assertAllowedLedgerKind throws for unknown kinds", () => {
    assert.throws(() => assertAllowedLedgerKind("nope"), /unknown ledger kind/i);
  });

  it("assertAllowedLedgerKind passes for known kinds", () => {
    assert.doesNotThrow(() => assertAllowedLedgerKind("kms_sign_fee"));
  });

  it("ALLOWED_LEDGER_KINDS is a frozen set", () => {
    assert.ok(Object.isFrozen(ALLOWED_LEDGER_KINDS));
  });
});
