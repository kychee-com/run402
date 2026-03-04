import { Router, Request, Response } from "express";
import { TIERS } from "@run402/shared";
import type { TierName } from "@run402/shared";
import { createProject, archiveProject, renewLease } from "../services/projects.js";
import { notifyNewProject } from "../services/telegram.js";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { extractWalletFromPaymentHeader } from "../utils/wallet.js";
import { getWalletSubscription } from "../services/stripe-subscriptions.js";

const router = Router();

// POST /v1/projects/quote — return tier pricing (free, no auth)
router.post("/v1/projects/quote", (_req: Request, res: Response) => {
  const tiers: Record<string, any> = {};
  for (const [name, config] of Object.entries(TIERS)) {
    tiers[name] = {
      price: config.price,
      lease_days: config.leaseDays,
      storage_mb: config.storageMb,
      api_calls: config.apiCalls,
    };
  }
  res.json({ tiers });
});

// POST /v1/projects — create project (x402-gated)
router.post("/v1/projects", async (req: Request, res: Response) => {
  const name = req.body?.name || `project-${Date.now()}`;
  let tier = (req.body?.tier as TierName) || "prototype";

  if (!TIERS[tier]) {
    res.status(400).json({ error: `Unknown tier: ${tier}. Valid tiers: ${Object.keys(TIERS).join(", ")}` });
    return;
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

  try {
    const project = await createProject(name, tier, txHash, walletAddress || undefined);
    if (!project) {
      res.status(503).json({ error: "No schema slots available" });
      return;
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
  } catch (err: any) {
    console.error("Failed to create project:", err.message);
    res.status(500).json({ error: "Failed to create project" });
  }
});

// POST /v1/projects/create/:tier — tier-specific creation (x402-gated per tier)
router.post("/v1/projects/create/:tier", async (req: Request, res: Response) => {
  let tier = req.params["tier"] as TierName;
  if (!TIERS[tier]) {
    res.status(400).json({ error: `Unknown tier: ${tier}` });
    return;
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

  try {
    const project = await createProject(name, tier, txHash, walletAddress || undefined);
    if (!project) {
      res.status(503).json({ error: "No schema slots available" });
      return;
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
  } catch (err: any) {
    console.error("Failed to create project:", err.message);
    res.status(500).json({ error: "Failed to create project" });
  }
});

// DELETE /v1/projects/:id — archive project (requires service_key)
router.delete("/v1/projects/:id", serviceKeyAuth, async (req: Request, res: Response) => {
  const projectId = req.params["id"] as string;

  // Verify the service_key belongs to this project
  if (req.tokenPayload?.project_id !== projectId) {
    res.status(403).json({ error: "Service key does not match project" });
    return;
  }

  try {
    const archived = await archiveProject(projectId);
    if (!archived) {
      res.status(404).json({ error: "Project not found or already archived" });
      return;
    }

    console.log(`  Archived project: ${projectId}`);
    res.json({ status: "archived", project_id: projectId });
  } catch (err: any) {
    console.error("Failed to archive project:", err.message);
    res.status(500).json({ error: "Failed to archive project" });
  }
});

// POST /v1/projects/:id/renew — renew lease (x402-gated in future)
router.post("/v1/projects/:id/renew", async (req: Request, res: Response) => {
  const projectId = req.params["id"] as string;
  const tier = (req.body?.tier as TierName) || "prototype";

  try {
    const newExpiry = await renewLease(projectId, tier);
    if (!newExpiry) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    console.log(`  Renewed project: ${projectId} (new expiry: ${newExpiry.toISOString()})`);
    res.json({
      project_id: projectId,
      tier,
      lease_expires_at: newExpiry.toISOString(),
    });
  } catch (err: any) {
    console.error("Failed to renew project:", err.message);
    res.status(500).json({ error: "Failed to renew project" });
  }
});

export default router;
