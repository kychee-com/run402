/**
 * Tier routes — wallet-level tier subscription management.
 *
 * GET    /tiers/v1                   — list tiers + pricing (free)
 * POST   /tiers/v1/subscribe/:tier   — subscribe to a tier (x402-gated)
 * POST   /tiers/v1/renew/:tier       — renew tier subscription (x402-gated)
 * POST   /tiers/v1/upgrade/:tier     — upgrade to higher tier (x402-gated)
 * GET    /tiers/v1/status            — get wallet tier status (wallet auth, free)
 */

import { Router, Request, Response } from "express";
import { TIERS } from "@run402/shared";
import type { TierName } from "@run402/shared";
import { subscribeTier, renewTier, upgradeTier, getWalletTier, canDowngrade } from "../services/wallet-tiers.js";
import { extractWalletFromPaymentHeader, getPaymentHeader } from "../utils/wallet.js";
import { walletAuth, invalidateWalletTierCache } from "../middleware/wallet-auth.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";

const router = Router();

const TIER_ORDER: TierName[] = ["prototype", "hobby", "team"];

// GET /tiers/v1 — list tiers + pricing (free, no auth)
router.get("/tiers/v1", (_req: Request, res: Response) => {
  const tiers: Record<string, {
    price: string;
    lease_days: number;
    storage_mb: number;
    api_calls: number;
    max_functions: number;
    description: string;
  }> = {};
  for (const [name, config] of Object.entries(TIERS)) {
    tiers[name] = {
      price: config.price,
      lease_days: config.leaseDays,
      storage_mb: config.storageMb,
      api_calls: config.apiCalls,
      max_functions: config.maxFunctions,
      description: config.description,
    };
  }
  res.json({
    tiers,
    auth: {
      method: "EIP-4361 wallet signature",
      headers: ["X-Run402-Wallet", "X-Run402-Signature", "X-Run402-Timestamp"],
      message_format: "run402:{unix_timestamp}",
    },
  });
});

// POST /tiers/v1/subscribe/:tier — subscribe to a tier (x402-gated)
router.post("/tiers/v1/subscribe/:tier", asyncHandler(async (req: Request, res: Response) => {
  const tier = req.params["tier"] as TierName;
  if (!TIERS[tier]) {
    throw new HttpError(400, `Unknown tier: ${tier}. Valid tiers: ${Object.keys(TIERS).join(", ")}`);
  }

  const paymentHeader = getPaymentHeader(req.headers as Record<string, string | string[] | undefined>);
  const wallet = paymentHeader ? extractWalletFromPaymentHeader(paymentHeader) : null;
  if (!wallet) {
    throw new HttpError(401, "Could not extract wallet from payment header");
  }

  const account = await subscribeTier(wallet, tier);
  invalidateWalletTierCache(wallet);

  console.log(`  Tier subscribe: ${wallet} → ${tier} (expires ${account.lease_expires_at?.toISOString()})`);

  res.status(201).json({
    wallet,
    tier: account.tier,
    lease_started_at: account.lease_started_at?.toISOString(),
    lease_expires_at: account.lease_expires_at?.toISOString(),
    allowance_remaining_usd_micros: account.available_usd_micros,
  });
}));

// POST /tiers/v1/renew/:tier — renew tier subscription (x402-gated)
router.post("/tiers/v1/renew/:tier", asyncHandler(async (req: Request, res: Response) => {
  const tier = req.params["tier"] as TierName;
  if (!TIERS[tier]) {
    throw new HttpError(400, `Unknown tier: ${tier}. Valid tiers: ${Object.keys(TIERS).join(", ")}`);
  }

  const paymentHeader = getPaymentHeader(req.headers as Record<string, string | string[] | undefined>);
  const wallet = paymentHeader ? extractWalletFromPaymentHeader(paymentHeader) : null;
  if (!wallet) {
    throw new HttpError(401, "Could not extract wallet from payment header");
  }

  const account = await renewTier(wallet, tier);
  invalidateWalletTierCache(wallet);

  console.log(`  Tier renew: ${wallet} → ${tier} (expires ${account.lease_expires_at?.toISOString()})`);

  res.json({
    wallet,
    tier: account.tier,
    lease_started_at: account.lease_started_at?.toISOString(),
    lease_expires_at: account.lease_expires_at?.toISOString(),
    allowance_remaining_usd_micros: account.available_usd_micros,
  });
}));

// POST /tiers/v1/upgrade/:tier — upgrade to higher tier (x402-gated)
router.post("/tiers/v1/upgrade/:tier", asyncHandler(async (req: Request, res: Response) => {
  const newTier = req.params["tier"] as TierName;
  if (!TIERS[newTier]) {
    throw new HttpError(400, `Unknown tier: ${newTier}. Valid tiers: ${Object.keys(TIERS).join(", ")}`);
  }

  const paymentHeader = getPaymentHeader(req.headers as Record<string, string | string[] | undefined>);
  const wallet = paymentHeader ? extractWalletFromPaymentHeader(paymentHeader) : null;
  if (!wallet) {
    throw new HttpError(401, "Could not extract wallet from payment header");
  }

  // Verify this is actually an upgrade (new tier must be higher)
  const tierInfo = await getWalletTier(wallet);
  if (tierInfo.tier) {
    const currentIdx = TIER_ORDER.indexOf(tierInfo.tier as TierName);
    const newIdx = TIER_ORDER.indexOf(newTier);
    if (newIdx <= currentIdx) {
      const downgradeCheck = canDowngrade(
        { tier: tierInfo.tier, lease_expires_at: tierInfo.lease_expires_at ? new Date(tierInfo.lease_expires_at) : null } as Parameters<typeof canDowngrade>[0],
        newTier,
      );
      if (!downgradeCheck.allowed) {
        throw new HttpError(400, downgradeCheck.reason!);
      }
    }
  }

  const account = await upgradeTier(wallet, newTier);
  invalidateWalletTierCache(wallet);

  console.log(`  Tier upgrade: ${wallet} → ${newTier} (expires ${account.lease_expires_at?.toISOString()})`);

  res.json({
    wallet,
    tier: account.tier,
    previous_tier: tierInfo.tier,
    lease_started_at: account.lease_started_at?.toISOString(),
    lease_expires_at: account.lease_expires_at?.toISOString(),
    allowance_remaining_usd_micros: account.available_usd_micros,
  });
}));

// GET /tiers/v1/status — get wallet's current tier info (wallet auth, free)
router.get("/tiers/v1/status", walletAuth(false), asyncHandler(async (req: Request, res: Response) => {
  const wallet = req.walletAddress!;
  const tierInfo = await getWalletTier(wallet);
  res.json(tierInfo);
}));

export default router;
