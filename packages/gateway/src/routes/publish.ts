/**
 * Publish & Fork routes.
 *
 * POST /admin/v1/projects/:id/publish  — publish app version (service_key auth)
 * GET  /admin/v1/projects/:id/versions — list versions (service_key auth)
 * GET  /v1/apps/:version_id             — get public app info (free)
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
import { deleteAppVersion } from "../services/publish.js";
import { createDemoProject, findDemoProject, updateDemoVersion, teardownDemoProject } from "../services/demo.js";
import { ADMIN_KEY } from "../config.js";
import { extractWalletFromPaymentHeader } from "../utils/wallet.js";
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

      // Auto-create or update demo project for public forkable apps
      if (version.visibility === "public" && version.fork_allowed) {
        const apiBase = `${req.protocol}://${req.get("host")}`;
        try {
          const existingDemoId = await findDemoProject(project.id);
          if (existingDemoId) {
            // Update existing demo to new version (triggers immediate reset)
            await updateDemoVersion(existingDemoId, version.id);
            console.log(`  Demo project ${existingDemoId} updated to version ${version.id}`);
          } else {
            // Create new demo project
            const demoId = await createDemoProject(version.id, project.name, apiBase);
            console.log(`  Demo project ${demoId} created for ${project.id}`);
          }
        } catch (demoErr) {
          // Demo creation failure should not block the publish
          console.error("  Failed to create/update demo project:", demoErr);
        }
      }

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

// PATCH /admin/v1/projects/:id/versions/:version_id — update version metadata (service_key auth)
router.patch(
  "/admin/v1/projects/:id/versions/:version_id",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const project = req.project!;
    if (project.id !== req.params.id) {
      throw new HttpError(403, "Token project_id mismatch");
    }

    const { tags, description, fork_allowed, visibility } = req.body || {};
    const updates: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (tags !== undefined) {
      const { validateTags: vt } = await import("../services/publish.js");
      const tagError = vt(tags);
      if (tagError) throw new HttpError(400, tagError);
      updates.push(`tags = $${paramIdx++}`);
      params.push(tags);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIdx++}`);
      params.push(description);
    }
    if (fork_allowed !== undefined) {
      updates.push(`fork_allowed = $${paramIdx++}`);
      params.push(fork_allowed);
    }
    if (visibility !== undefined) {
      updates.push(`visibility = $${paramIdx++}`);
      params.push(visibility);
    }

    if (updates.length === 0) {
      throw new HttpError(400, "No fields to update");
    }

    params.push(req.params.version_id);
    params.push(project.id);

    const { pool: dbPool } = await import("../db/pool.js");
    const result = await dbPool.query(
      `UPDATE internal.app_versions SET ${updates.join(", ")}
       WHERE id = $${paramIdx++} AND project_id = $${paramIdx}`,
      params,
    );

    if (result.rowCount === 0) {
      throw new HttpError(404, "Version not found");
    }

    const { getAppVersion: getVer } = await import("../services/publish.js");
    const updated = await getVer(req.params.version_id as string);
    res.json(updated);
  }),
);

// DELETE /admin/v1/projects/:id/versions/:version_id — delete a published version (service_key auth)
router.delete(
  "/admin/v1/projects/:id/versions/:version_id",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const project = req.project!;
    if (project.id !== req.params.id) {
      throw new HttpError(403, "Token project_id mismatch");
    }

    const { deleteAppVersion: delVer } = await import("../services/publish.js");
    const deleted = await delVer(req.params.version_id as string, project.id);
    if (!deleted) {
      throw new HttpError(404, "Version not found");
    }

    // Teardown demo project if this was a published version with a demo
    try {
      await teardownDemoProject(project.id);
    } catch (err) {
      console.error("  Failed to teardown demo project:", err);
    }

    res.json({ status: "deleted", version_id: req.params.version_id });
  }),
);

// DELETE /v1/admin/app-versions/:version_id — admin-only version deletion (no service_key needed)
router.delete(
  "/v1/admin/app-versions/:version_id",
  asyncHandler(async (req: Request, res: Response) => {
    const adminKey = req.headers["x-admin-key"] as string | undefined;
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      throw new HttpError(403, "Requires platform admin key");
    }

    const { pool: dbPool } = await import("../db/pool.js");
    const result = await dbPool.query(
      `DELETE FROM internal.app_versions WHERE id = $1 RETURNING id`,
      [req.params.version_id],
    );
    if (!result.rowCount || result.rowCount === 0) {
      throw new HttpError(404, "Version not found");
    }
    console.log(`  Admin deleted app version: ${req.params.version_id}`);
    res.json({ status: "deleted", version_id: req.params.version_id });
  }),
);

// GET /v1/apps — list all public forkable apps (free, no auth)
// Supports ?tag=auth&tag=rls for filtering
router.get(
  "/v1/apps",
  asyncHandler(async (req: Request, res: Response) => {
    const tagParam = req.query.tag;
    const filterTags = tagParam
      ? (Array.isArray(tagParam) ? tagParam as string[] : [tagParam as string])
      : undefined;
    const apps = await listPublicApps(filterTags);

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

// GET /v1/apps/:version_id — public app info (free, no auth)
router.get(
  "/v1/apps/:version_id",
  asyncHandler(async (req: Request, res: Response) => {
    const version = await getAppVersion(req.params.version_id as string);
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
    const tier = req.params.tier as TierName;
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
