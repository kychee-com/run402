/**
 * SIWX (Sign-In-With-X) wallet auth middleware.
 *
 * Verifies identity from the standard SIGN-IN-WITH-X header (CAIP-122 / EIP-4361).
 * Replaces the custom X-Run402-Wallet/Signature/Timestamp headers.
 *
 * The header is a base64-encoded JSON payload containing a signed CAIP-122 message
 * with domain binding, temporal validation, and cryptographic signature verification.
 * Supports both EVM (eip155:*) and Solana wallets.
 *
 * Caches active tier lookups for 60 seconds per wallet.
 */

import type { Request, Response, NextFunction } from "express";
import { parseSIWxHeader, verifySIWxSignature } from "@x402/extensions/sign-in-with-x";
import { getBillingAccount } from "../services/billing.js";
import { isWalletTierActive } from "../services/wallet-tiers.js";
import { recordWallet } from "../utils/wallet.js";
import type { TierName } from "@run402/shared";

const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

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
 * Wallet auth middleware. Validates SIWX header and attaches
 * req.walletAddress and req.walletTier.
 *
 * @param requireTier If true (default), rejects requests without an active tier.
 *                    If false, allows requests without a tier (free endpoints).
 */
export function walletAuth(requireTier = true) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const siwxHeader = req.headers["sign-in-with-x"] as string | undefined;

    if (!siwxHeader) {
      res.status(401).json({
        error: "Missing SIGN-IN-WITH-X header",
        hint: "Sign a CAIP-122 message and send it as the SIGN-IN-WITH-X header (base64-encoded JSON). See https://docs.x402.org/extensions/sign-in-with-x",
      });
      return;
    }

    // Parse the SIWX header
    let payload;
    try {
      payload = parseSIWxHeader(siwxHeader);
    } catch {
      res.status(401).json({ error: "Invalid SIGN-IN-WITH-X header" });
      return;
    }

    // Validate temporal fields
    if (payload.expirationTime) {
      const expiry = new Date(payload.expirationTime);
      if (expiry.getTime() < Date.now()) {
        res.status(401).json({ error: "SIWX message expired" });
        return;
      }
    }

    if (payload.issuedAt) {
      const issued = new Date(payload.issuedAt);
      if (Date.now() - issued.getTime() > MAX_AGE_MS) {
        res.status(401).json({
          error: "SIWX message too old",
          message: `Message issued more than ${MAX_AGE_MS / 1000}s ago. Generate a fresh SIWX message.`,
        });
        return;
      }
    }

    // Validate domain binding
    const expectedDomain = req.hostname;
    if (payload.domain && payload.domain !== expectedDomain) {
      res.status(401).json({
        error: "SIWX domain mismatch",
        expected: expectedDomain,
        got: payload.domain,
      });
      return;
    }

    // Verify cryptographic signature
    let verification;
    try {
      verification = await verifySIWxSignature(payload);
    } catch {
      res.status(401).json({ error: "SIWX signature verification failed" });
      return;
    }

    if (!verification.valid || !verification.address) {
      res.status(401).json({
        error: "Invalid SIWX signature",
        details: verification.error,
      });
      return;
    }

    const normalized = verification.address.toLowerCase();
    recordWallet(normalized, "siwx");

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
        message: "Subscribe to a tier first: POST /tiers/v1/:tier",
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
 * Invalidate the tier cache for a wallet (call after setTier).
 */
export function invalidateWalletTierCache(wallet: string): void {
  tierCache.delete(wallet.toLowerCase());
}
