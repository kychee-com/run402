/**
 * Bundle deploy routes — one-call full-stack app deployment.
 *
 * POST /deploy/v1 — deploy a complete app (wallet auth, free with tier)
 * GET  /deploy/v1 — info (free)
 */

import { Router, Request, Response } from "express";
import { TIERS } from "@run402/shared";
import { deployBundle, validateBundle, BundleError } from "../services/bundle.js";
import { invokeBootstrap } from "../services/functions.js";
import { deriveProjectKeys } from "../services/projects.js";
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
    description: "Bundle deploy — deploy to an existing project (requires active tier)",
    tiers,
    method: "POST /deploy/v1",
    auth: "EIP-4361 wallet signature (tier from wallet subscription)",
    body: {
      project_id: "string (required — from POST /projects/v1)",
      migrations: "string (optional SQL)",
      rls: "{ template, tables } (optional)",
      secrets: "[{ key, value }] (optional)",
      functions: "[{ name, code, config? }] (optional)",
      files: "[{ file, data, encoding? }] (optional)",
      subdomain: "string (optional)",
      bootstrap: "object (optional — variables passed to the bootstrap function after deploy)",
    },
  });
});

// POST /v1/deploy — bundle deploy (wallet auth, tier from wallet)
router.post("/deploy/v1", walletAuth(true), asyncHandler(async (req: Request, res: Response) => {
  const body = req.body || {};
  const bundleReq = { ...body };

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
    const result = await deployBundle(bundleReq, apiBase, walletAddress);

    // Invoke bootstrap function if it exists
    const bootstrapVars = body.bootstrap && typeof body.bootstrap === "object" ? body.bootstrap : {};
    const tier = (req.walletTier || "prototype") as import("@run402/shared").TierName;
    const { anonKey, serviceKey } = deriveProjectKeys(result.project_id, tier);
    const bootstrap = await invokeBootstrap(
      result.project_id, serviceKey, anonKey, bootstrapVars, apiBase,
    );

    const response: Record<string, unknown> = { ...result, bootstrap_result: bootstrap.result };
    if (bootstrap.error) {
      response.bootstrap_error = bootstrap.error;
      delete response.bootstrap_result;
    }
    res.status(200).json(response);
  } catch (err: unknown) {
    if (err instanceof Error && "statusCode" in err) {
      throw new HttpError((err as { statusCode: number }).statusCode, err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(500, msg);
  }
}));

export default router;
