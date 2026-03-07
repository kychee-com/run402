/**
 * Publish & Fork routes.
 *
 * POST /admin/v1/projects/:id/publish  — publish app version (service_key auth)
 * GET  /admin/v1/projects/:id/versions — list versions (service_key auth)
 * GET  /v1/apps/:versionId             — get public app info (free)
 * POST /v1/fork/:tier                  — fork an app version (x402-gated)
 */

import { Router, Request, Response } from "express";
import { TIERS } from "@run402/shared";
import type { TierName } from "@run402/shared";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import {
  publishAppVersion,
  listVersions,
  getAppVersion,
  listPublicApps,
  PublishError,
} from "../services/publish.js";
import { forkApp, validateForkRequest, ForkError } from "../services/fork.js";
import { extractWalletFromPaymentHeader } from "../utils/wallet.js";
import { getWalletSubscription } from "../services/stripe-subscriptions.js";
import { notifyNewProject } from "../services/telegram.js";

const router = Router();

// POST /admin/v1/projects/:id/publish — publish app version
router.post(
  "/admin/v1/projects/:id/publish",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const project = req.project!;
    if (project.id !== req.params.id) {
      throw new HttpError(403, "Token project_id mismatch");
    }

    const options = req.body || {};

    try {
      const version = await publishAppVersion(
        project.id,
        project.name,
        project.schemaSlot,
        project.walletAddress,
        options,
      );
      res.status(201).json(version);
    } catch (err: unknown) {
      if (err instanceof PublishError) {
        throw new HttpError(err.statusCode, err.message);
      }
      throw err;
    }
  }),
);

// GET /admin/v1/projects/:id/versions — list published versions
router.get(
  "/admin/v1/projects/:id/versions",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const project = req.project!;
    if (project.id !== req.params.id) {
      throw new HttpError(403, "Token project_id mismatch");
    }

    const versions = await listVersions(project.id);
    res.json({ versions });
  }),
);

// GET /v1/apps — list all public forkable apps (free, no auth)
router.get(
  "/v1/apps",
  asyncHandler(async (_req: Request, res: Response) => {
    const apps = await listPublicApps();

    const forkPricing: Record<string, string> = {};
    for (const [tierName, tierConfig] of Object.entries(TIERS)) {
      forkPricing[tierName] = tierConfig.price;
    }

    res.json({
      apps: apps.map((app) => ({
        ...app,
        fork_pricing: app.fork_allowed ? forkPricing : undefined,
      })),
      total: apps.length,
    });
  }),
);

// GET /v1/apps/:versionId — public app info (free, no auth)
router.get(
  "/v1/apps/:versionId",
  asyncHandler(async (req: Request, res: Response) => {
    const version = await getAppVersion(req.params.versionId as string);
    if (!version) {
      throw new HttpError(404, "App version not found");
    }
    // Only show public or unlisted versions
    if (version.visibility === "private") {
      throw new HttpError(404, "App version not found");
    }

    // Build fork pricing info
    const forkPricing: Record<string, string> = {};
    for (const [tierName, tierConfig] of Object.entries(TIERS)) {
      forkPricing[tierName] = tierConfig.price;
    }

    res.json({
      ...version,
      fork_pricing: forkPricing,
    });
  }),
);

// GET /v1/fork — info
router.get("/v1/fork", (_req: Request, res: Response) => {
  const tiers: Record<string, { price: string }> = {};
  for (const [name, config] of Object.entries(TIERS)) {
    tiers[name] = { price: config.price };
  }
  res.json({
    description: "Fork a published app version into a new project",
    tiers,
    method: "POST /v1/fork/:tier",
    body: {
      version_id: "string (required)",
      name: "string (required)",
      subdomain: "string (optional)",
    },
  });
});

// POST /v1/fork/:tier — fork an app version (x402-gated)
router.post(
  "/v1/fork/:tier",
  asyncHandler(async (req: Request, res: Response) => {
    let tier = req.params.tier as TierName;
    if (!TIERS[tier]) {
      throw new HttpError(400, `Unknown tier: ${tier}`);
    }

    const body = req.body || {};

    try {
      validateForkRequest(body);
    } catch (err: unknown) {
      if (err instanceof ForkError) {
        throw new HttpError(err.statusCode, err.message);
      }
      throw err;
    }

    const txHash = res.getHeader("x-402-transaction") as string | undefined;
    const paymentHeader = req.headers["x-402-payment"] as string | undefined;
    const walletAddress = paymentHeader ? extractWalletFromPaymentHeader(paymentHeader) : undefined;

    if (walletAddress) {
      const sub = await getWalletSubscription(walletAddress);
      if (sub?.status === "active") {
        tier = sub.tier;
      }
    }

    const apiBase = `${req.protocol}://${req.get("host")}`;

    try {
      const result = await forkApp(body, tier, apiBase, txHash, walletAddress || undefined);
      notifyNewProject(`fork:${body.name}`, tier, result.project_id);
      res.status(201).json(result);
    } catch (err: unknown) {
      if (err instanceof ForkError) {
        throw new HttpError(err.statusCode, err.message);
      }
      throw err;
    }
  }),
);

export default router;
