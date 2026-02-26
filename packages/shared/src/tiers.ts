import type { TierConfig, TierName } from "./types.js";

export const TIERS: Record<TierName, TierConfig> = {
  prototype: {
    price: "$0.10",
    leaseDays: 7,
    storageMb: 250,
    apiCalls: 500_000,
    description: "Prototype tier — 7-day lease, 250MB storage, 500k API calls",
  },
  hobby: {
    price: "$5.00",
    leaseDays: 30,
    storageMb: 1024,
    apiCalls: 5_000_000,
    description: "Hobby tier — 30-day lease, 1GB storage, 5M API calls",
  },
  team: {
    price: "$20.00",
    leaseDays: 30,
    storageMb: 10240,
    apiCalls: 50_000_000,
    description: "Team tier — 30-day lease, 10GB storage, 50M API calls",
  },
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
