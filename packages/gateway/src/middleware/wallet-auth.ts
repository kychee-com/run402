/**
 * EIP-4361 wallet auth middleware.
 *
 * Verifies identity from signed message headers:
 *   X-Run402-Wallet:    0x... (wallet address)
 *   X-Run402-Signature: 0x... (signature of `run402:{timestamp}`)
 *   X-Run402-Timestamp: Unix timestamp (seconds)
 *
 * The message format is `run402:{timestamp}` — no path, so the signature
 * proves wallet identity only. Tier controls access.
 *
 * Freshness: signature must be within 30 seconds.
 * Caches active tier lookups for 60 seconds per wallet.
 */

import type { Request, Response, NextFunction } from "express";
import { verifyMessage } from "viem";
import { getBillingAccount } from "../services/billing.js";
import { isWalletTierActive } from "../services/wallet-tiers.js";
import { recordWallet } from "../utils/wallet.js";
import type { TierName } from "@run402/shared";

const MAX_TIMESTAMP_DRIFT_SEC = 30;

// LRU-style cache for wallet tier active status
const tierCache = new Map<string, { active: boolean; tier: string | null; expires: number }>();
const CACHE_TTL_MS = 60_000;

declare module "express-serve-static-core" {
  interface Request {
    walletAddress?: string;
    walletTier?: TierName | null;
  }
}

/**
 * Wallet auth middleware. Validates EIP-4361 headers and attaches
 * req.walletAddress and req.walletTier.
 *
 * @param requireTier If true (default), rejects requests without an active tier.
 *                    If false, allows requests without a tier (free endpoints).
 */
export function walletAuth(requireTier = true) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const wallet = req.headers["x-run402-wallet"] as string | undefined;
    const signature = req.headers["x-run402-signature"] as string | undefined;
    const timestamp = req.headers["x-run402-timestamp"] as string | undefined;

    if (!wallet || !signature || !timestamp) {
      res.status(401).json({
        error: "Missing wallet auth headers",
        required: ["X-Run402-Wallet", "X-Run402-Signature", "X-Run402-Timestamp"],
      });
      return;
    }

    // Validate timestamp freshness
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts)) {
      res.status(401).json({ error: "Invalid X-Run402-Timestamp" });
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > MAX_TIMESTAMP_DRIFT_SEC) {
      res.status(401).json({
        error: "Signature expired",
        message: `Timestamp drift exceeds ${MAX_TIMESTAMP_DRIFT_SEC}s. Current server time: ${nowSec}`,
      });
      return;
    }

    // Verify signature: message = `run402:{timestamp}`
    const message = `run402:${timestamp}`;
    try {
      const valid = await verifyMessage({
        address: wallet as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });

      if (!valid) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }
    } catch {
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    const normalized = wallet.toLowerCase();
    recordWallet(normalized, "wallet-auth");

    // Check tier (with caching)
    let tierInfo = tierCache.get(normalized);
    if (!tierInfo || tierInfo.expires < Date.now()) {
      const account = await getBillingAccount(normalized);
      const active = account ? isWalletTierActive(account) : false;
      tierInfo = {
        active,
        tier: account?.tier || null,
        expires: Date.now() + CACHE_TTL_MS,
      };
      tierCache.set(normalized, tierInfo);

      // Evict stale entries if cache grows too large
      if (tierCache.size > 10000) {
        const cutoff = Date.now();
        for (const [key, val] of tierCache) {
          if (val.expires < cutoff) tierCache.delete(key);
        }
      }
    }

    if (requireTier && !tierInfo.active) {
      res.status(402).json({
        error: "No active tier subscription",
        message: "Subscribe to a tier first: POST /tiers/v1/subscribe/:tier",
        subscribe_url: "/tiers/v1",
      });
      return;
    }

    req.walletAddress = normalized;
    req.walletTier = tierInfo.tier as TierName | null;
    next();
  };
}

/**
 * Invalidate the tier cache for a wallet (call after subscribe/renew/upgrade).
 */
export function invalidateWalletTierCache(wallet: string): void {
  tierCache.delete(wallet.toLowerCase());
}
