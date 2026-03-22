import type { TierConfig, TierName } from "./types.js";

export const TIERS: Record<TierName, TierConfig> = {
  prototype: {
    price: "$0.10",
    priceUsdMicros: 100_000,
    leaseDays: 7,
    storageMb: 250,
    apiCalls: 500_000,
    maxFunctions: 8,
    functionTimeoutSec: 10,
    functionMemoryMb: 128,
    maxSecrets: 10,
    description: "Prototype tier (FREE) — 7-day lease, 250MB storage, 500k API calls. Uses testnet USDC to verify wallet setup ($0 real money).",
  },
  hobby: {
    price: "$5.00",
    priceUsdMicros: 5_000_000,
    leaseDays: 30,
    storageMb: 1024,
    apiCalls: 5_000_000,
    maxFunctions: 25,
    functionTimeoutSec: 30,
    functionMemoryMb: 256,
    maxSecrets: 50,
    description: "Hobby tier — 30-day lease, 1GB storage, 5M API calls",
  },
  team: {
    price: "$20.00",
    priceUsdMicros: 20_000_000,
    leaseDays: 30,
    storageMb: 10240,
    apiCalls: 50_000_000,
    maxFunctions: 100,
    functionTimeoutSec: 60,
    functionMemoryMb: 512,
    maxSecrets: 200,
    description: "Team tier — 30-day lease, 10GB storage, 50M API calls",
  },
};

/** Prices for per-call paid endpoints (micro-USD).
 * Most endpoints are now free with an active tier subscription.
 * Only generate-image remains per-call priced.
 */
export const SKU_PRICES: Record<string, number> = {
  image: 30_000,
};

export const TIER_NAMES = Object.keys(TIERS) as TierName[];

export function getTierLimits(tier: TierName) {
  const config = TIERS[tier];
  return {
    apiCalls: config.apiCalls,
    storageBytes: config.storageMb * 1024 * 1024,
  };
}

export function getLeaseDuration(tier: TierName): number {
  return TIERS[tier].leaseDays * 24 * 60 * 60 * 1000;
}
