/**
 * SIWxStorage adapter — wraps existing billing DB for the @x402/extensions SIWX interface.
 *
 * hasPaid()       → checks if wallet has an active tier via billing account
 * recordPayment() → records a wallet sighting with source "siwx"
 */

import type { SIWxStorage } from "@x402/extensions/sign-in-with-x";
import { getBillingAccount } from "./billing.js";
import { isWalletTierActive } from "./wallet-tiers.js";
import { recordWallet } from "../utils/wallet.js";

// LRU-style cache for wallet tier active status
const tierCache = new Map<string, { active: boolean; expires: number }>();
const CACHE_TTL_MS = 60_000;

export const siwxStorage: SIWxStorage = {
  async hasPaid(_resource: string, address: string): Promise<boolean> {
    const normalized = address.toLowerCase();

    const cached = tierCache.get(normalized);
    if (cached && cached.expires > Date.now()) {
      return cached.active;
    }

    const account = await getBillingAccount(normalized);
    const active = account ? isWalletTierActive(account) : false;

    tierCache.set(normalized, { active, expires: Date.now() + CACHE_TTL_MS });

    // Evict stale entries if cache grows too large
    if (tierCache.size > 10000) {
      const cutoff = Date.now();
      for (const [key, val] of tierCache) {
        if (val.expires < cutoff) tierCache.delete(key);
      }
    }

    return active;
  },

  async recordPayment(_resource: string, address: string): Promise<void> {
    recordWallet(address.toLowerCase(), "siwx");
  },
};

/**
 * Invalidate the SIWX tier cache for a wallet (call after setTier).
 */
export function invalidateSIWxTierCache(wallet: string): void {
  tierCache.delete(wallet.toLowerCase());
}
