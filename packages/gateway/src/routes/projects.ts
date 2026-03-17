import { Router, Request, Response } from "express";
import { TIERS } from "@run402/shared";
import type { TierName } from "@run402/shared";
import { createProject, archiveProject } from "../services/projects.js";
import { notifyNewProject } from "../services/telegram.js";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { walletAuth } from "../middleware/wallet-auth.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";

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
