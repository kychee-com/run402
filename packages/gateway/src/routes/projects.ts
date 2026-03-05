import { Router, Request, Response } from "express";
import { TIERS } from "@run402/shared";
import type { TierName } from "@run402/shared";
import { createProject, archiveProject, renewLease } from "../services/projects.js";
import { notifyNewProject } from "../services/telegram.js";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { extractWalletFromPaymentHeader } from "../utils/wallet.js";
import { getWalletSubscription } from "../services/stripe-subscriptions.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";

const router = Router();

// GET/POST /v1/projects/quote — return tier pricing (free, no auth)
// GET /v1/projects — same (enables `purl inspect` on the x402-gated POST route)
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
router.get("/v1/projects", handleQuote);
router.post("/v1/projects/quote", handleQuote);

// POST /v1/projects — create project (x402-gated)
router.post("/v1/projects", asyncHandler(async (req: Request, res: Response) => {
  const name = req.body?.name || `project-${Date.now()}`;
  let tier = (req.body?.tier as TierName) || "prototype";

  if (!TIERS[tier]) {
    throw new HttpError(400, `Unknown tier: ${tier}. Valid tiers: ${Object.keys(TIERS).join(", ")}`);
  }

  // Extract x402 transaction hash and wallet address
  const txHash = res.getHeader("x-402-transaction") as string | undefined;
  const paymentHeader = req.headers["x-402-payment"] as string | undefined;
  const walletAddress = paymentHeader ? extractWalletFromPaymentHeader(paymentHeader) : undefined;

  // For subscribed wallets: use subscription tier
  if (walletAddress) {
    const sub = await getWalletSubscription(walletAddress);
    if (sub?.status === "active") {
      tier = sub.tier;
    }
  }

  const project = await createProject(name, tier, txHash, walletAddress || undefined);
  if (!project) {
    throw new HttpError(503, "No schema slots available");
  }

  console.log(`  Created project: ${project.id} (schema: ${project.schemaSlot}, tier: ${tier})`);
  notifyNewProject(name, tier, project.id);

  res.json({
    project_id: project.id,
    anon_key: project.anonKey,
    service_key: project.serviceKey,
    schema_slot: project.schemaSlot,
    tier: project.tier,
    lease_expires_at: project.leaseExpiresAt.toISOString(),
  });
}));

// POST /v1/projects/create/:tier — tier-specific creation (x402-gated per tier)
router.post("/v1/projects/create/:tier", asyncHandler(async (req: Request, res: Response) => {
  let tier = req.params["tier"] as TierName;
  if (!TIERS[tier]) {
    throw new HttpError(400, `Unknown tier: ${tier}`);
  }

  const name = req.body?.name || `project-${Date.now()}`;
  const txHash = res.getHeader("x-402-transaction") as string | undefined;
  const paymentHeader = req.headers["x-402-payment"] as string | undefined;
  const walletAddress = paymentHeader ? extractWalletFromPaymentHeader(paymentHeader) : undefined;

  // For subscribed wallets: use subscription tier
  if (walletAddress) {
    const sub = await getWalletSubscription(walletAddress);
    if (sub?.status === "active") {
      tier = sub.tier;
    }
  }

  const project = await createProject(name, tier, txHash, walletAddress || undefined);
  if (!project) {
    throw new HttpError(503, "No schema slots available");
  }

  console.log(`  Created project: ${project.id} (schema: ${project.schemaSlot}, tier: ${tier})`);
  notifyNewProject(name, tier, project.id);

  res.json({
    project_id: project.id,
    anon_key: project.anonKey,
    service_key: project.serviceKey,
    schema_slot: project.schemaSlot,
    tier: project.tier,
    lease_expires_at: project.leaseExpiresAt.toISOString(),
  });
}));

// DELETE /v1/projects/:id — archive project (requires service_key)
router.delete("/v1/projects/:id", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
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

// POST /v1/projects/:id/renew — renew lease (x402-gated in future)
router.post("/v1/projects/:id/renew", asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.params["id"] as string;
  const tier = (req.body?.tier as TierName) || "prototype";

  const newExpiry = await renewLease(projectId, tier);
  if (!newExpiry) {
    throw new HttpError(404, "Project not found");
  }

  console.log(`  Renewed project: ${projectId} (new expiry: ${newExpiry.toISOString()})`);
  res.json({
    project_id: projectId,
    tier,
    lease_expires_at: newExpiry.toISOString(),
  });
}));

export default router;
