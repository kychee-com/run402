/**
 * Bundle deploy routes — one-call full-stack app deployment.
 *
 * POST /v1/deploy/:tier — deploy a complete app (x402-gated, tier-priced)
 * GET  /v1/deploy       — info (free)
 */

import { Router, Request, Response } from "express";
import { TIERS } from "@run402/shared";
import type { TierName } from "@run402/shared";
import { deployBundle, validateBundle, BundleError } from "../services/bundle.js";
import { notifyNewProject } from "../services/telegram.js";
import { extractWalletFromPaymentHeader } from "../utils/wallet.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";

const router = Router();

// GET /v1/deploy — info (enables `purl inspect` on the x402-gated POST routes)
router.get("/v1/deploy", (_req: Request, res: Response) => {
  const tiers: Record<string, { price: string; lease_days: number }> = {};
  for (const [name, config] of Object.entries(TIERS)) {
    tiers[name] = { price: config.price, lease_days: config.leaseDays };
  }
  res.json({
    description: "Bundle deploy — one-call full-stack app deployment",
    tiers,
    method: "POST /v1/deploy/:tier",
    body: {
      name: "string (required)",
      migrations: "string (optional SQL)",
      rls: "{ template, tables } (optional)",
      secrets: "[{ key, value }] (optional)",
      functions: "[{ name, code, config? }] (optional)",
      site: "[{ file, data, encoding? }] (optional)",
      subdomain: "string (optional)",
    },
  });
});

// POST /v1/deploy/:tier — bundle deploy (x402-gated per tier)
router.post("/v1/deploy/:tier", asyncHandler(async (req: Request, res: Response) => {
  const tier = req.params["tier"] as TierName;
  if (!TIERS[tier]) {
    throw new HttpError(400, `Unknown tier: ${tier}. Valid tiers: ${Object.keys(TIERS).join(", ")}`);
  }

  const body = req.body || {};
  const bundleReq = { ...body, tier };

  // Validate
  try {
    validateBundle(bundleReq);
  } catch (err: unknown) {
    if (err instanceof BundleError) {
      throw new HttpError(err.statusCode, err.message);
    }
    throw err;
  }

  // Extract x402 transaction hash and wallet address
  const txHash = res.getHeader("x-402-transaction") as string | undefined;
  const paymentHeader = req.headers["x-402-payment"] as string | undefined;
  const walletAddress = paymentHeader ? extractWalletFromPaymentHeader(paymentHeader) : undefined;

  const apiBase = `${req.protocol}://${req.get("host")}`;

  try {
    const result = await deployBundle(bundleReq, apiBase, txHash, walletAddress || undefined);

    notifyNewProject(bundleReq.name, tier, result.project_id);

    res.status(201).json(result);
  } catch (err: unknown) {
    if (err instanceof BundleError) {
      throw new HttpError(err.statusCode, err.message);
    }
    throw err;
  }
}));

export default router;
