/**
 * Tier routes — wallet-level tier subscription management.
 *
 * GET    /tiers/v1          — list tiers + pricing (free)
 * POST   /tiers/v1/:tier    — subscribe, renew, or upgrade (x402-gated, auto-detected)
 * GET    /tiers/v1/status   — get wallet tier status (wallet auth, free)
 */

import { Router, Request, Response } from "express";
import { TIERS } from "@run402/shared";
import type { TierName } from "@run402/shared";
import { setTier, getWalletTier } from "../services/wallet-tiers.js";
import { extractWalletFromPaymentHeader, getPaymentHeader } from "../utils/wallet.js";
import { walletAuth, invalidateWalletTierCache } from "../middleware/wallet-auth.js";
import { invalidateSIWxTierCache } from "../services/siwx-storage.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";

const router = Router();

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
      method: "SIWX (Sign-In-With-X, CAIP-122)",
      headers: ["SIGN-IN-WITH-X"],
      docs: "https://docs.x402.org/extensions/sign-in-with-x",
    },
  });
});

// POST /tiers/v1/:tier — subscribe, renew, or upgrade (x402-gated, auto-detected)
router.post("/tiers/v1/:tier", asyncHandler(async (req: Request, res: Response) => {
  const tier = req.params["tier"] as TierName;
  if (!TIERS[tier]) {
    throw new HttpError(400, `Unknown tier: ${tier}. Valid tiers: ${Object.keys(TIERS).join(", ")}`);
  }

  const paymentHeader = getPaymentHeader(req.headers as Record<string, string | string[] | undefined>);
  const wallet = paymentHeader ? extractWalletFromPaymentHeader(paymentHeader) : null;
  if (!wallet) {
    throw new HttpError(401, "Could not extract wallet from payment header");
  }

  try {
    const result = await setTier(wallet, tier);
    invalidateWalletTierCache(wallet);
    invalidateSIWxTierCache(wallet);

    console.log(`  Tier ${result.action}: ${wallet} → ${tier} (expires ${result.lease_expires_at?.toISOString()})`);

    const status = result.action === "subscribe" ? 201 : 200;
    res.status(status).json({
      wallet,
      action: result.action,
      tier: result.tier,
      previous_tier: result.previous_tier ?? null,
      lease_started_at: result.lease_started_at?.toISOString(),
      lease_expires_at: result.lease_expires_at?.toISOString(),
      allowance_remaining_usd_micros: result.available_usd_micros,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Cannot downgrade")) {
      throw new HttpError(400, err.message);
    }
    throw err;
  }
}));

// GET /tiers/v1/status — get wallet's current tier info (wallet auth, free)
router.get("/tiers/v1/status", walletAuth(false), asyncHandler(async (req: Request, res: Response) => {
  const wallet = req.walletAddress!;
  const tierInfo = await getWalletTier(wallet);
  res.json(tierInfo);
}));

export default router;
