import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { TIERS } from "@run402/shared";
import type { TierName, TokenPayload } from "@run402/shared";
import { createProject, archiveProject, renewLease, projectCache } from "../services/projects.js";
import { notifyNewProject } from "../services/telegram.js";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { walletAuth } from "../middleware/wallet-auth.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { JWT_SECRET } from "../config.js";

const router = Router();

// GET/POST /v1/projects/quote — return tier pricing (free, no auth)
// GET /v1/projects — same (enables `purl inspect` on the POST route)
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
router.get("/projects/v1", handleQuote);
router.post("/projects/v1/quote", handleQuote);

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

// POST /v1/projects/:id/renew — renew project lease (service_key auth, allows expired leases)
router.post("/projects/v1/:id/renew", asyncHandler(async (req: Request, res: Response) => {
  // Inline auth — same as serviceKeyAuth but without the lease expiry guard
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HttpError(401, "Missing Bearer token");
  }
  let payload: TokenPayload;
  try {
    payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as TokenPayload;
  } catch {
    throw new HttpError(401, "Invalid token");
  }
  if (payload.role !== "service_role") {
    throw new HttpError(403, "Requires service_role key");
  }

  const projectId = req.params["id"] as string;
  if (payload.project_id !== projectId) {
    throw new HttpError(403, "Service key does not match project");
  }

  const project = projectCache.get(projectId);
  if (!project || project.status === "archived" || project.status === "deleted") {
    throw new HttpError(404, "Project not found or already archived");
  }

  const newExpiry = await renewLease(projectId, project.tier);
  if (!newExpiry) {
    throw new HttpError(404, "Project not found");
  }

  console.log(`  Renewed lease: ${projectId} (tier: ${project.tier}, expires: ${newExpiry.toISOString()})`);
  res.json({
    status: "renewed",
    project_id: projectId,
    tier: project.tier,
    lease_expires_at: newExpiry.toISOString(),
  });
}));

// DELETE /v1/projects/:id — archive project (requires service_key)
router.delete("/projects/v1/:id", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.params["id"] as string;

  // Verify the service_key belongs to this project
  if (req.tokenPayload?.project_id !== projectId) {
    throw new HttpError(403, "Service key does not match project");
  }

  const archived = await archiveProject(projectId);
  if (!archived) {
    throw new HttpError(404, "Project not found or already archived");
  }

  console.log(`  Archived project: ${projectId}`);
  res.json({ status: "archived", project_id: projectId });
}));

export default router;
