/**
 * Bundle deploy routes — one-call full-stack app deployment.
 *
 * POST /v1/deploy — deploy a complete app (wallet auth, free with tier)
 * GET  /v1/deploy — info (free)
 */

import { Router, Request, Response } from "express";
import { TIERS } from "@run402/shared";
import type { TierName } from "@run402/shared";
import { deployBundle, validateBundle, BundleError } from "../services/bundle.js";
import { SubdomainError } from "../services/subdomains.js";
import { notifyNewProject } from "../services/telegram.js";
import { walletAuth } from "../middleware/wallet-auth.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";

const router = Router();

// GET /v1/deploy — info
router.get("/deploy/v1", (_req: Request, res: Response) => {
  const tiers: Record<string, { price: string; lease_days: number }> = {};
  for (const [name, config] of Object.entries(TIERS)) {
    tiers[name] = { price: config.price, lease_days: config.leaseDays };
  }
  res.json({
    description: "Bundle deploy — one-call full-stack app deployment (requires active tier)",
    tiers,
    method: "POST /deploy/v1",
    auth: "EIP-4361 wallet signature (tier from wallet subscription)",
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

// POST /v1/deploy — bundle deploy (wallet auth, tier from wallet)
router.post("/deploy/v1", walletAuth(true), asyncHandler(async (req: Request, res: Response) => {
  const tier = (req.walletTier as TierName) || "prototype";

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

  const walletAddress = req.walletAddress;
  const apiBase = `${req.protocol}://${req.get("host")}`;

  try {
    const result = await deployBundle(bundleReq, apiBase, undefined, walletAddress);

    notifyNewProject(bundleReq.name, tier, result.project_id);

    res.status(201).json(result);
  } catch (err: unknown) {
    if (err instanceof BundleError) {
      throw new HttpError(err.statusCode, err.message);
    }
    if (err instanceof SubdomainError) {
      throw new HttpError(err.statusCode, err.message);
    }
    throw err;
  }
}));

export default router;
