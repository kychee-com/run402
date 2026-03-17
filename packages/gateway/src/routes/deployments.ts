/**
 * Deployment routes — Vercel-compatible static site hosting.
 *
 * POST /deployments/v1 — deploy a static site (wallet auth, free with tier)
 * GET  /deployments/v1/:id — get deployment status (free)
 */

import { Router, Request, Response } from "express";
import { createDeployment, getDeployment, DeploymentError } from "../services/deployments.js";
import type { DeploymentFile } from "../services/deployments.js";
import { walletAuth } from "../middleware/wallet-auth.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";

const router = Router();

// GET /v1/deployments — info
router.get("/deployments/v1", (_req: Request, res: Response) => {
  res.json({
    description: "Deploy a static site — Vercel-compatible inlined file upload (free with active tier)",
    method: "POST",
    auth: "EIP-4361 wallet signature",
    body: { project: "string (required project ID)", files: "[{ file, data, encoding? }]" },
  });
});

// POST /v1/deployments — create a deployment (wallet auth, free)
router.post("/deployments/v1", walletAuth(false), asyncHandler(async (req: Request, res: Response) => {
  const { project, target, files } = req.body || {};

  if (!project || typeof project !== "string") {
    throw new HttpError(400, "Missing or invalid 'project' field (project ID required)");
  }

  if (!files || !Array.isArray(files) || files.length === 0) {
    throw new HttpError(400, "Missing or empty 'files' array");
  }

  // Validate each file
  for (const f of files as DeploymentFile[]) {
    if (!f.file || typeof f.file !== "string") {
      throw new HttpError(400, "Each file must have a 'file' (path) field");
    }
    if (f.data === undefined || f.data === null) {
      throw new HttpError(400, `File '${f.file}' is missing 'data' field`);
    }
    if (f.encoding && f.encoding !== "utf-8" && f.encoding !== "base64") {
      throw new HttpError(400, `File '${f.file}' has invalid encoding (must be 'utf-8' or 'base64')`);
    }
  }

  try {
    const deployment = await createDeployment(
      { project, target, files },
      undefined,
    );
    res.status(201).json(deployment);
  } catch (err: unknown) {
    if (err instanceof DeploymentError) {
      throw new HttpError(err.statusCode, err.message);
    }
    throw err;
  }
}));

// GET /v1/deployments/:id — get deployment status (free, no auth)
router.get("/deployments/v1/:id", asyncHandler(async (req: Request, res: Response) => {
  const deployment = await getDeployment(req.params.id as string);
  if (!deployment) {
    throw new HttpError(404, "Deployment not found");
  }
  res.json(deployment);
}));

export default router;
