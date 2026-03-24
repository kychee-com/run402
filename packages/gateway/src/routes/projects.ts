import { Router, Request, Response } from "express";
import { TIERS } from "@run402/shared";
import type { TierName } from "@run402/shared";
import { createProject, archiveProject, projectCache } from "../services/projects.js";
import { notifyNewProject } from "../services/telegram.js";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { walletAuth } from "../middleware/wallet-auth.js";
import { serviceKeyOrAdmin, walletAuthOrAdmin } from "../middleware/admin-auth.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { pool } from "../db/pool.js";
import { sql, type SQL } from "../db/sql.js";

const router = Router();

// GET/POST /v1/projects/quote — return tier pricing (free, no auth)
function handleQuote(_req: Request, res: Response): void {
  const tiers: Record<string, { price: string; lease_days: number; storage_mb: number; api_calls: number }> = {};
  for (const [name, config] of Object.entries(TIERS)) {
    tiers[name] = {
      price: config.price,
      lease_days: config.leaseDays,
      storage_mb: config.storageMb,
      api_calls: config.apiCalls,
    };
  }
  res.json({ tiers });
}
router.post("/projects/v1/quote", handleQuote);

// GET /v1/projects — list projects (auth-scoped) or return pricing (no auth)
router.get("/projects/v1", asyncHandler(async (req: Request, res: Response) => {
  // No auth → return tier pricing (backwards-compatible)
  const hasAuth = req.headers.authorization || req.headers["sign-in-with-x"] || req.headers["x-admin-key"] || req.headers.cookie?.includes("run402_admin");
  if (!hasAuth) {
    handleQuote(req, res);
    return;
  }

  // Try wallet or admin auth
  await new Promise<void>((resolve, reject) => {
    walletAuthOrAdmin(req, res, (err?: unknown) => {
      if (err) reject(err); else resolve();
    });
  });

  // If auth failed, walletAuthOrAdmin already sent 401
  if (res.headersSent) return;

  // Pagination
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
  const after = req.query.after as string | undefined;

  let query: SQL;
  let params: unknown[];

  if (req.isAdmin) {
    query = after
      ? sql(`SELECT id, name, tier, status, wallet_address, created_at FROM internal.projects WHERE created_at < (SELECT created_at FROM internal.projects WHERE id = $1) ORDER BY created_at DESC LIMIT $2`)
      : sql(`SELECT id, name, tier, status, wallet_address, created_at FROM internal.projects ORDER BY created_at DESC LIMIT $1`);
    params = after ? [after, limit + 1] : [limit + 1];
  } else {
    const wallet = req.walletAddress;
    if (!wallet) { res.status(401).json({ error: "No wallet address" }); return; }
    query = after
      ? sql(`SELECT id, name, tier, status, wallet_address, created_at FROM internal.projects WHERE wallet_address = $1 AND created_at < (SELECT created_at FROM internal.projects WHERE id = $2) ORDER BY created_at DESC LIMIT $3`)
      : sql(`SELECT id, name, tier, status, wallet_address, created_at FROM internal.projects WHERE wallet_address = $1 ORDER BY created_at DESC LIMIT $2`);
    params = after ? [wallet, after, limit + 1] : [wallet, limit + 1];
  }

  const result = await pool.query(query, params);
  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

  res.json({
    projects: rows.map((r: Record<string, unknown>) => ({
      id: r.id,
      name: r.name,
      tier: r.tier,
      status: r.status,
      wallet_address: r.wallet_address,
      created_at: r.created_at,
    })),
    has_more: hasMore,
    next_cursor: hasMore ? rows[rows.length - 1].id : null,
  });
}));

// POST /v1/projects — create project (wallet auth, free with active tier)
router.post("/projects/v1", walletAuth(true), asyncHandler(async (req: Request, res: Response) => {
  const name = req.body?.name || `project-${Date.now()}`;
  // Tier comes from the wallet's subscription
  const tier = (req.walletTier as TierName) || "prototype";

  const walletAddress = req.walletAddress;

  const project = await createProject(name, tier, undefined, walletAddress);
  if (!project) {
    throw new HttpError(503, "No schema slots available");
  }

  console.log(`  Created project: ${project.id} (schema: ${project.schemaSlot}, tier: ${tier}, wallet: ${walletAddress})`);
  notifyNewProject(name, tier, project.id, walletAddress);

  res.status(201).json({
    project_id: project.id,
    anon_key: project.anonKey,
    service_key: project.serviceKey,
    schema_slot: project.schemaSlot,
  });
}));

// DELETE /v1/projects/:id — archive project (service_key or admin)
router.delete("/projects/v1/:id", serviceKeyOrAdmin, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.params["id"] as string;

  // Verify ownership unless admin
  if (!req.isAdmin && req.tokenPayload?.project_id !== projectId) {
    throw new HttpError(403, "Service key does not match project");
  }

  const archived = await archiveProject(projectId);
  if (!archived) {
    throw new HttpError(404, "Project not found or already archived");
  }

  console.log(`  Archived project: ${projectId}${req.isAdmin ? " (admin)" : ""}`);
  res.json({ status: "archived", project_id: projectId });
}));

export default router;
