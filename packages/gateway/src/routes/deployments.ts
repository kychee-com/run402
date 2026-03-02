/**
 * Deployment routes — Vercel-compatible static site hosting.
 *
 * POST /v13/deployments — deploy a static site (x402-gated, $0.05)
 * GET  /v13/deployments/:id — get deployment status (free)
 */

import { Router, Request, Response } from "express";
import { createDeployment, getDeployment, DeploymentError } from "../services/deployments.js";
import type { DeploymentFile } from "../services/deployments.js";

const router = Router();

// POST /v13/deployments — create a deployment
router.post("/v13/deployments", async (req: Request, res: Response) => {
  try {
    const { name, project, target, files } = req.body;

    // Validate required fields
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "Missing or invalid 'name' field" });
      return;
    }

    if (!files || !Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: "Missing or empty 'files' array" });
      return;
    }

    // Validate each file
    for (const f of files as DeploymentFile[]) {
      if (!f.file || typeof f.file !== "string") {
        res.status(400).json({ error: "Each file must have a 'file' (path) field" });
        return;
      }
      if (f.data === undefined || f.data === null) {
        res.status(400).json({ error: `File '${f.file}' is missing 'data' field` });
        return;
      }
      if (f.encoding && f.encoding !== "utf-8" && f.encoding !== "base64") {
        res.status(400).json({ error: `File '${f.file}' has invalid encoding (must be 'utf-8' or 'base64')` });
        return;
      }
    }

    // Extract x402 transaction hash if present
    const txHash = res.getHeader("x-402-transaction") as string | undefined;

    const deployment = await createDeployment(
      { name, project, target, files },
      txHash,
    );

    res.status(201).json(deployment);
  } catch (err: any) {
    if (err instanceof DeploymentError) {
      res.status(err.statusCode).json({ error: err.message });
    } else {
      console.error("Deployment error:", err.message);
      res.status(500).json({ error: "Deployment failed" });
    }
  }
});

// GET /v13/deployments/:id — get deployment status (free, no auth)
router.get("/v13/deployments/:id", async (req: Request, res: Response) => {
  try {
    const deployment = await getDeployment(req.params.id as string);
    if (!deployment) {
      res.status(404).json({ error: "Deployment not found" });
      return;
    }
    res.json(deployment);
  } catch (err: any) {
    console.error("Deployment lookup error:", err.message);
    res.status(500).json({ error: "Lookup failed" });
  }
});

export default router;
