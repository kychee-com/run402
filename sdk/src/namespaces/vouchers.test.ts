/**
 * Unit tests for the `vouchers` namespace.
 *
 * The namespace is deliberately thin, so the things worth pinning are the ones
 * a future "improvement" would most plausibly break:
 *
 *   - the code goes to the wire VERBATIM (the gateway owns the grammar; a
 *     client-side normalization or format check would reject codes the server
 *     accepts, and would do it offline where the user cannot see why);
 *   - a replay is reported as a replay, not laundered into a fresh credit.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";

const creds: CredentialsProvider = {
  async getAuth() {
    return { headers: { "SIGN-IN-WITH-X": "stub" } };
  },
  async getProject() {
    return null;
  },
};

function sdkCapturing(
  body: unknown,
  captured: { path?: string; method?: string; body?: unknown },
  status = 201,
): Run402 {
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    captured.path = typeof input === "string" ? input : String(input);
    captured.method = init?.method;
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return new Run402({ apiBase: "https://api.test", credentials: creds, fetch: fetchImpl });
}

const REDEEMED = {
  voucher_id: "11111111-1111-1111-1111-111111111111",
  amount_usd_micros: 1_000_000,
  balance_usd_micros: 1_000_000,
  organization_id: "22222222-2222-2222-2222-222222222222",
  redeemed_at: "2026-08-09T20:00:00.000Z",
  already_redeemed: false,
  promo_lifetime_ceiling_usd_micros: 1_000_000,
  next_actions: [
    { type: "set_tier", method: "POST", path: "/tiers/v1/prototype", cli: "run402 tier set prototype" },
  ],
};

describe("vouchers.redeem", () => {
  it("POSTs the code to the redemption route and returns the result", async () => {
    const captured: { path?: string; method?: string; body?: unknown } = {};
    const result = await sdkCapturing(REDEEMED, captured).vouchers.redeem("R402-K8F3-Q2W9");

    assert.match(captured.path ?? "", /\/vouchers\/v1\/redemptions$/);
    assert.equal(captured.method, "POST");
    assert.deepEqual(captured.body, { code: "R402-K8F3-Q2W9" });
    assert.equal(result.amount_usd_micros, 1_000_000);
    assert.equal(result.already_redeemed, false);
    assert.equal(result.next_actions[0]?.cli, "run402 tier set prototype");
  });

  it("sends the code verbatim — no client-side normalization", async () => {
    // The gateway canonicalizes (case, hyphens, Crockford confusables). If the
    // SDK also normalized, the two would eventually disagree and the client
    // would start rejecting codes the server would have honored.
    for (const raw of ["r402k8f3q2w9", "  R402-K8F3-Q2W9  ", "R4O2-K8F3-Q2W9"]) {
      const captured: { body?: unknown } = {};
      await sdkCapturing(REDEEMED, captured).vouchers.redeem(raw);
      assert.deepEqual(captured.body, { code: raw });
    }
  });

  it("reports a replay as a replay", async () => {
    const replay = { ...REDEEMED, already_redeemed: true };
    const result = await sdkCapturing(replay, {}, 200).vouchers.redeem("R402-K8F3-Q2W9");
    assert.equal(result.already_redeemed, true);
    assert.equal(result.balance_usd_micros, 1_000_000, "the balance is the original, not a doubled one");
  });

  it("rejects an empty code locally instead of spending a round-trip on it", async () => {
    let called = false;
    const fetchImpl: typeof globalThis.fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    const r = new Run402({ apiBase: "https://api.test", credentials: creds, fetch: fetchImpl });
    await assert.rejects(() => r.vouchers.redeem(""), /code must be a non-empty string/);
    assert.equal(called, false);
  });

  it("exposes redeemCode as an alias of redeem", async () => {
    const captured: { path?: string } = {};
    await sdkCapturing(REDEEMED, captured).vouchers.redeemCode("R402-K8F3-Q2W9");
    assert.match(captured.path ?? "", /\/vouchers\/v1\/redemptions$/);
  });
});
