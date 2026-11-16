import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { X402BalanceError, guardTempoChallenges, offerNetworks, orderTempoCandidates, paymentNetworkUnsupportedError, withAllowanceRemedies } from "./paid-fetch.js";
import { PaymentBuyerError } from "../namespaces/pay.js";
import type { PaymentOffer } from "./payment-offers.js";
import { TEMPO_MAINNET, TEMPO_MODERATO, type TempoChain } from "./tempo.js";

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

function candidate(chainId: number, amount = "5000000") {
  return { challenge: { method: "tempo", intent: "charge", request: { amount, methodDetails: { chainId } } } };
}

/** The 402 for a paid SKU: mainnet first, then Moderato. */
const paid = () => [candidate(4217), candidate(42431)];

function balances(map: Partial<Record<number, bigint | Error>>) {
  return async (chain: TempoChain): Promise<bigint> => {
    const value = map[chain.id];
    if (value instanceof Error) throw value;
    return value ?? 0n;
  };
}

describe("orderTempoCandidates", () => {
  it("a faucet-funded wallet pays Moderato on a paid SKU", async () => {
    const ordered = await orderTempoCandidates(paid(), ADDRESS, balances({ 42431: 1_000_000_000_000n }));
    assert.deepEqual(ordered.map((c) => c.challenge.request.methodDetails.chainId), [42431]);
  });

  it("a wallet funded on both chains keeps the server's order, mainnet first", async () => {
    const ordered = await orderTempoCandidates(paid(), ADDRESS, balances({ 4217: 10_000_000n, 42431: 10_000_000n }));
    assert.deepEqual(ordered.map((c) => c.challenge.request.methodDetails.chainId), [4217, 42431]);
  });

  it("the free tier's Moderato-first order is kept", async () => {
    const prototype = [candidate(42431, "100000"), candidate(4217, "100000")];
    const ordered = await orderTempoCandidates(prototype, ADDRESS, balances({ 4217: 1_000_000n, 42431: 1_000_000n }));
    assert.deepEqual(ordered.map((c) => c.challenge.request.methodDetails.chainId), [42431, 4217]);
  });

  it("covering means the price plus the fee headroom", async () => {
    const exact = balances({ 4217: 5_000_000n, 42431: 5_004_999n });
    await assert.rejects(orderTempoCandidates(paid(), ADDRESS, exact), (err: unknown) =>
      err instanceof X402BalanceError && err.code === "X402_INSUFFICIENT_FUNDS");
    const enough = await orderTempoCandidates(paid(), ADDRESS, balances({ 4217: 5_005_000n }));
    assert.equal(enough.length, 1);
  });

  it("a failed read on one chain is skipped when another chain is covered", async () => {
    const ordered = await orderTempoCandidates(paid(), ADDRESS, balances({ 4217: new Error("rpc down"), 42431: 10_000_000n }));
    assert.deepEqual(ordered.map((c) => c.challenge.request.methodDetails.chainId), [42431]);
  });

  it("raises an RPC error, not a shortfall, when a read failed and nothing is covered", async () => {
    await assert.rejects(
      orderTempoCandidates(paid(), ADDRESS, balances({ 4217: new Error("rpc down"), 42431: 0n })),
      (err: unknown) => {
        assert.ok(err instanceof X402BalanceError);
        assert.equal(err.code, "X402_RPC_UNAVAILABLE");
        assert.equal(err.toJSON().safeToRetry, true);
        return true;
      },
    );
  });

  it("an empty wallet gets X402_INSUFFICIENT_FUNDS naming both chains, mainnet first, with both funding routes", async () => {
    await assert.rejects(orderTempoCandidates(paid(), ADDRESS, balances({})), (err: unknown) => {
      assert.ok(err instanceof X402BalanceError);
      assert.equal(err.code, "X402_INSUFFICIENT_FUNDS");
      const json = err.toJSON() as Record<string, any>;
      const details = json.details;
      assert.equal(details.token, "pathUSD");
      assert.deepEqual(details.requirements, [
        { network: TEMPO_MAINNET.network, amount: "5000000" },
        { network: TEMPO_MODERATO.network, amount: "5000000" },
      ]);
      assert.deepEqual(details.balances, { "eip155:4217": "0", "eip155:42431": "0" });
      assert.deepEqual(details.payers, { "eip155:4217": ADDRESS, "eip155:42431": ADDRESS });
      const actions = json.nextActions as Array<{ type: string; command?: string; why?: string }>;
      assert.deepEqual(actions.map((a) => a.type), ["fund_wallet", "fund_wallet"]);
      assert.match(actions[0]!.why!, /Tempo \(eip155:4217\)/);
      assert.equal(actions[1]!.command, "run402 wallets fund");
      return true;
    });
  });

  it("on the free tier the first funding route is the Moderato faucet", async () => {
    const prototype = [candidate(42431, "100000"), candidate(4217, "100000")];
    await assert.rejects(orderTempoCandidates(prototype, ADDRESS, balances({})), (err: unknown) => {
      const json = (err as X402BalanceError).toJSON() as Record<string, any>;
      const actions = json.nextActions as Array<{ type: string; command?: string }>;
      assert.equal(actions.length, 1);
      assert.equal(actions[0]!.command, "run402 wallets fund");
      return true;
    });
  });

  it("leaves candidates alone when none is a Tempo charge on a known chain", async () => {
    const other = [{ challenge: { method: "lightning", intent: "charge", request: {} } }, candidate(1)];
    let reads = 0;
    const ordered = await orderTempoCandidates(other, ADDRESS, async () => { reads++; return 0n; });
    assert.equal(ordered.length, 2);
    assert.equal(reads, 0);
  });
});

describe("guardTempoChallenges", () => {
  const x402Only = () => new Response(JSON.stringify({ code: "PAYMENT_REQUIRED" }), {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify({ accepts: [{ scheme: "exact", network: "eip155:8453" }] })).toString("base64url"),
    },
  });
  const unsupported = (offers: PaymentOffer[]) =>
    paymentNetworkUnsupportedError(offerNetworks(offers), [TEMPO_MAINNET.network, TEMPO_MODERATO.network], {}, offers, "mpp");

  it("a 402 that offers only x402 is PAYMENT_NETWORK_UNSUPPORTED naming the x402 rail, not a retryable mppx failure", async () => {
    const guarded = guardTempoChallenges(async () => x402Only(), unsupported);
    await assert.rejects(guarded("https://api.run402.com/tiers/v1/hobby", { method: "POST" }), (err: unknown) => {
      assert.ok(err instanceof PaymentBuyerError);
      const json = err.toJSON() as Record<string, any>;
      assert.equal(json.code, "PAYMENT_NETWORK_UNSUPPORTED");
      assert.equal(json.retryable, false);
      assert.equal(json.details.configured_rail, "mpp");
      assert.deepEqual(json.details.challenge_networks, ["eip155:8453"]);
      assert.equal(json.nextActions[0].command, "run402 init x402 --switch-rail");
      return true;
    });
  });

  it("a 402 with a Tempo charge challenge goes to mppx untouched", async () => {
    const tempo = new Response(null, {
      status: 402,
      headers: { "WWW-Authenticate": 'Payment id="c1", method="tempo", intent="charge", request="e30"' },
    });
    const guarded = guardTempoChallenges(async () => tempo, unsupported);
    assert.equal(await guarded("https://api.run402.com/tiers/v1/prototype"), tempo);
  });

  it("a 402 that offers nothing, and any non-402, pass through", async () => {
    const bare = new Response("{}", { status: 402 });
    assert.equal(await guardTempoChallenges(async () => bare, unsupported)("https://x.test/"), bare);
    const ok = new Response("{}", { status: 200 });
    assert.equal(await guardTempoChallenges(async () => ok, unsupported)("https://x.test/"), ok);
  });

  it("the paid retry is never guarded", async () => {
    const guarded = guardTempoChallenges(async () => x402Only(), unsupported);
    const res = await guarded("https://x.test/", { headers: { Authorization: "Payment abc" } });
    assert.equal(res.status, 402);
  });
});

describe("withAllowanceRemedies", () => {
  it("a signed-in mpp buyer of a paid tier sees the allowance shortfall beside the rail switch", async () => {
    const res = new Response(JSON.stringify({
      code: "PAYMENT_REQUIRED",
      allowance: { allowance_usd_micros: 5_000_000, price_usd_micros: 20_000_000, shortfall_usd_micros: 15_000_000 },
    }), {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify({ accepts: [{ scheme: "exact", network: "eip155:8453" }] })).toString("base64url"),
      },
    });
    const unsupported = (offers: PaymentOffer[], body: Record<string, unknown> | null) => withAllowanceRemedies(
      paymentNetworkUnsupportedError(offerNetworks(offers), [TEMPO_MAINNET.network, TEMPO_MODERATO.network], {}, offers, "mpp"),
      body,
    );
    await assert.rejects(guardTempoChallenges(async () => res, unsupported)("https://api.run402.com/tiers/v1/team", { method: "POST" }), (err: unknown) => {
      assert.ok(err instanceof PaymentBuyerError);
      const json = err.toJSON() as Record<string, any>;
      assert.equal(json.code, "PAYMENT_NETWORK_UNSUPPORTED");
      assert.equal(json.retryable, false);
      assert.deepEqual(json.details.allowance, { allowance_usd_micros: 5_000_000, price_usd_micros: 20_000_000, shortfall_usd_micros: 15_000_000 });
      assert.equal(json.details.configured_rail, "mpp");
      assert.deepEqual(json.nextActions.map((a: { type: string }) => a.type), ["run_command", "edit_request", "redeem_voucher", "top_up"]);
      assert.match(json.message, /\$15\.00 short/);
      return true;
    });
  });

  it("a 402 without an allowance block keeps the plain wrong-rail error", () => {
    const plain = paymentNetworkUnsupportedError(["eip155:8453"], [], {}, [], "mpp");
    assert.equal(withAllowanceRemedies(plain, { code: "PAYMENT_REQUIRED" }), plain);
  });
});
