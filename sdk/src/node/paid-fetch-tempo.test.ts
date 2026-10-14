import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { X402BalanceError, orderTempoCandidates } from "./paid-fetch.js";
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
