import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_ON_CHAIN_BALANCE_KEYS,
  railBalanceKeys,
  readOnChainBalances,
  sumOnChainBalances,
  type OnChainBalanceKey,
} from "./onchain-balances.js";

describe("on-chain balances", () => {
  it("every key is snake_case", () => {
    for (const key of ALL_ON_CHAIN_BALANCE_KEYS) assert.match(key, /^[a-z0-9]+(_[a-z0-9]+)*$/);
  });

  it("mpp reads both Tempo chains; x402 and lightning read both Base chains", () => {
    assert.deepEqual(railBalanceKeys("mpp"), ["tempo_mainnet_pathusd_micros", "tempo_moderato_pathusd_micros"]);
    assert.deepEqual(railBalanceKeys("x402"), ["base_mainnet_usd_micros", "base_sepolia_usd_micros"]);
    assert.deepEqual(railBalanceKeys("lightning"), ["base_mainnet_usd_micros", "base_sepolia_usd_micros"]);
    assert.deepEqual(railBalanceKeys(undefined), ["base_mainnet_usd_micros", "base_sepolia_usd_micros"]);
  });

  it("reads only the requested networks, and a failed read is null, never 0", async () => {
    const asked: OnChainBalanceKey[] = [];
    const balances = await readOnChainBalances("0xabc", railBalanceKeys("mpp"), async (key) => {
      asked.push(key);
      if (key === "tempo_mainnet_pathusd_micros") throw new Error("rpc down");
      return 1_000_000;
    });
    assert.deepEqual(asked.sort(), ["tempo_mainnet_pathusd_micros", "tempo_moderato_pathusd_micros"]);
    assert.deepEqual(balances, { tempo_mainnet_pathusd_micros: null, tempo_moderato_pathusd_micros: 1_000_000 });
  });

  it("sums the known networks, and is null only when every one is unknown", () => {
    const keys = railBalanceKeys("mpp");
    assert.equal(sumOnChainBalances({ tempo_mainnet_pathusd_micros: 5_000_000, tempo_moderato_pathusd_micros: 7 }, keys), 5_000_007);
    assert.equal(sumOnChainBalances({ tempo_mainnet_pathusd_micros: null, tempo_moderato_pathusd_micros: 7 }, keys), 7);
    assert.equal(sumOnChainBalances({ tempo_mainnet_pathusd_micros: null, tempo_moderato_pathusd_micros: null }, keys), null);
  });
});
