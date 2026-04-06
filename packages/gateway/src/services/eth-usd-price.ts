/**
 * ETH→USD price feed via Chainlink, read through our own contract-read
 * service. 5-minute cache per chain. Falls back to a hard-coded $2000
 * if Chainlink is unreachable so gas accounting never breaks entirely.
 */

import { getChain } from "./chain-config.js";

interface CacheEntry { price_usd: number; cached_at: number }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const FALLBACK_PRICE = 2000;

// Chainlink AggregatorV3 fragment
const AGGREGATOR_V3_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export async function getCachedEthUsdPrice(chainName: string): Promise<number> {
  const now = Date.now();
  const cached = cache.get(chainName);
  if (cached && now - cached.cached_at < CACHE_TTL_MS) {
    return cached.price_usd;
  }
  try {
    // Lazy import to avoid a cycle (contract-read depends on viem just like us).
    const { readContract } = await import("./contract-read.js");
    const cfg = getChain(chainName);
    const round = await readContract({
      chain: chainName,
      contractAddress: cfg.chainlink_eth_usd_feed_address,
      abiFragment: AGGREGATOR_V3_ABI as unknown as Parameters<typeof readContract>[0]["abiFragment"],
      functionName: "latestRoundData",
      args: [],
    });
    const decimals = await readContract({
      chain: chainName,
      contractAddress: cfg.chainlink_eth_usd_feed_address,
      abiFragment: AGGREGATOR_V3_ABI as unknown as Parameters<typeof readContract>[0]["abiFragment"],
      functionName: "decimals",
      args: [],
    });
    // round = [roundId, answer, ...]; answer is int256
    const answer = (round as unknown as bigint[])[1];
    const dec = Number(decimals as unknown as number | bigint);
    const price = Number(answer) / 10 ** dec;
    cache.set(chainName, { price_usd: price, cached_at: now });
    return price;
  } catch (err) {
    console.error("[eth-usd-price] Chainlink read failed, falling back:", err);
    cache.set(chainName, { price_usd: FALLBACK_PRICE, cached_at: now });
    return FALLBACK_PRICE;
  }
}

export function _resetEthUsdPriceCacheForTests(): void {
  cache.clear();
}
