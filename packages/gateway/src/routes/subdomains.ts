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
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import {
  validateSubdomainName,
  createOrUpdateSubdomain,
  getSubdomain,
  listSubdomains,
  deleteSubdomain,
  SubdomainError,
} from "../services/subdomains.js";

const router = Router();

/** Build the public response shape for a subdomain record. */
function formatSubdomain(record: {
  name: string;
  deployment_id: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}) {
  const dnsLabel = record.deployment_id.replace(/_/g, "-");
  return {
    name: record.name,
    deployment_id: record.deployment_id,
    url: `https://${record.name}.run402.com`,
    deployment_url: `https://${dnsLabel}.sites.run402.com`,
    project_id: record.project_id,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

// POST /v1/subdomains — claim or reassign a subdomain
router.post("/v1/subdomains", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
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

// GET /v1/subdomains — list subdomains for the authenticated project
router.get("/v1/subdomains", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project!.id;
  const records = await listSubdomains(projectId);
  res.json(records.map(formatSubdomain));
}));

// GET /v1/subdomains/:name — lookup a subdomain (free, no auth)
router.get("/v1/subdomains/:name", asyncHandler(async (req: Request, res: Response) => {
  const record = await getSubdomain(req.params.name as string);
  if (!record) {
    throw new HttpError(404, "Subdomain not found");
  }
  res.json(formatSubdomain(record));
}));

// DELETE /v1/subdomains/:name — release a subdomain
router.delete("/v1/subdomains/:name", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project?.id || null;

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
