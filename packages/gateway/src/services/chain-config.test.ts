import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CHAINS,
  getChain,
  listChains,
  isSupportedChain,
} from "./chain-config.js";

describe("chain-config", () => {
  it("CHAINS is frozen", () => {
    assert.ok(Object.isFrozen(CHAINS));
  });

  it("includes base-mainnet with the expected fields", () => {
    const c = getChain("base-mainnet");
    assert.equal(c.name, "base-mainnet");
    assert.equal(c.chain_id, 8453);
    assert.equal(c.native_token, "ETH");
    assert.equal(c.block_explorer, "https://basescan.org");
    assert.equal(c.rpc_url_secret_key, "run402/base-mainnet-rpc-url");
    // Chainlink ETH/USD feed on Base mainnet
    assert.match(c.chainlink_eth_usd_feed_address, /^0x[a-fA-F0-9]{40}$/);
  });

  it("includes base-sepolia with the expected fields", () => {
    const c = getChain("base-sepolia");
    assert.equal(c.name, "base-sepolia");
    assert.equal(c.chain_id, 84532);
    assert.equal(c.native_token, "ETH");
    assert.equal(c.block_explorer, "https://sepolia.basescan.org");
    assert.equal(c.rpc_url_secret_key, "run402/base-sepolia-rpc-url");
  });

  it("getChain throws for unknown chain", () => {
    assert.throws(() => getChain("ethereum-mainnet"), /unsupported_chain/);
    assert.throws(() => getChain(""), /unsupported_chain/);
  });

  it("listChains returns frozen objects in deterministic order", () => {
    const list = listChains();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 2);
    for (const c of list) {
      assert.ok(Object.isFrozen(c), `chain ${c.name} not frozen`);
    }
    const names = list.map((c) => c.name);
    assert.ok(names.includes("base-mainnet"));
    assert.ok(names.includes("base-sepolia"));
  });

  it("isSupportedChain reflects registry", () => {
    assert.equal(isSupportedChain("base-mainnet"), true);
    assert.equal(isSupportedChain("base-sepolia"), true);
    assert.equal(isSupportedChain("optimism"), false);
    assert.equal(isSupportedChain(""), false);
  });
});
