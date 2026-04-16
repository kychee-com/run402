/**
 * Subdomain routes — claim, list, lookup, and release custom subdomains.
 *
 * POST   /v1/subdomains       — Claim or reassign (service_key auth)
 * GET    /v1/subdomains       — List project's subdomains (service_key auth)
 * GET    /v1/subdomains/:name — Lookup (free, no auth)
 * DELETE /v1/subdomains/:name — Release (service_key auth)
 */

import { Router, Request, Response } from "express";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { serviceKeyOrAdmin, walletAuthOrAdmin } from "../middleware/admin-auth.js";
import { lifecycleGate } from "../middleware/lifecycle-gate.js";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import {
  validateSubdomainName,
  createOrUpdateSubdomain,
  getSubdomain,
  listSubdomains,
  deleteSubdomain,
  SubdomainError,
} from "../services/subdomains.js";
import { getDeploymentUrl, getSubdomainUrl } from "../utils/public-urls.js";

const router = Router();

/** Build the public response shape for a subdomain record. */
function formatSubdomain(record: {
  name: string;
  deployment_id: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}) {
  return {
    name: record.name,
    deployment_id: record.deployment_id,
    url: getSubdomainUrl(record.name),
    deployment_url: getDeploymentUrl(record.deployment_id),
    project_id: record.project_id,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

// POST /v1/subdomains — claim or reassign a subdomain
router.post("/subdomains/v1", serviceKeyAuth, lifecycleGate, asyncHandler(async (req: Request, res: Response) => {
  const { name, deployment_id } = req.body || {};

  if (!name || typeof name !== "string") {
    throw new HttpError(400, "Missing or invalid 'name' field");
  }

  if (!deployment_id || typeof deployment_id !== "string") {
    throw new HttpError(400, "Missing or invalid 'deployment_id' field");
  }

  const validationError = validateSubdomainName(name);
  if (validationError) {
    throw new HttpError(400, validationError);
  }

  const projectId = req.project?.id || null;

  try {
    const record = await createOrUpdateSubdomain(name, deployment_id, projectId);
    res.status(201).json(formatSubdomain(record));
  } catch (err: unknown) {
    if (err instanceof SubdomainError) {
      throw new HttpError(err.statusCode, err.message);
    }
    throw err;
  }
}));

// GET /v1/subdomains — list subdomains (admin: all, service_key: project, wallet: own projects)
router.get("/subdomains/v1", serviceKeyOrAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (req.isAdmin) {
    // Admin: list all subdomains
    const result = await pool.query(
      sql(`SELECT name, deployment_id, project_id, created_at, updated_at FROM internal.subdomains ORDER BY created_at DESC`),
    );
    res.json({ subdomains: result.rows.map(formatSubdomain) });
  } else {
    // Service key: list subdomains for the authenticated project
    const projectId = req.project!.id;
    const records = await listSubdomains(projectId);
    res.json({ subdomains: records.map(formatSubdomain) });
  }
}));

// GET /v1/subdomains/:name — lookup a subdomain (free, no auth)
router.get("/subdomains/v1/:name", asyncHandler(async (req: Request, res: Response) => {
  const record = await getSubdomain(req.params.name as string);
  if (!record) {
    throw new HttpError(404, "Subdomain not found");
  }
  res.json(formatSubdomain(record));
}));

// DELETE /v1/subdomains/:name — release a subdomain (service_key or admin)
router.delete("/subdomains/v1/:name", serviceKeyOrAdmin, asyncHandler(async (req: Request, res: Response) => {
  // Admin bypasses project ownership check
  const projectId = req.isAdmin ? null : (req.project?.id || null);

  try {
    const deleted = await deleteSubdomain(req.params.name as string, projectId);
    if (!deleted) {
      throw new HttpError(404, "Subdomain not found");
    }
    res.json({ status: "deleted", name: req.params.name });
  } catch (err: unknown) {
    if (err instanceof SubdomainError) {
      throw new HttpError(err.statusCode, err.message);
    }
    throw err;
  }
}));

export default router;
