/**
 * Custom domain routes — register, check status, list, and release custom domains.
 *
 * POST   /v1/domains       — Register a custom domain (service_key auth)
 * GET    /v1/domains       — List project's custom domains (service_key or admin)
 * GET    /v1/domains/:domain — Check domain status (no auth)
 * DELETE /v1/domains/:domain — Release a custom domain (service_key or admin)
 */

import { Router, Request, Response } from "express";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { serviceKeyOrAdmin } from "../middleware/admin-auth.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import {
  validateDomain,
  createDomain,
  getDomainWithStatus,
  listDomains,
  deleteDomain,
  DomainError,
} from "../services/domains.js";

const router = Router();

function formatDomain(record: {
  domain: string;
  subdomain_name: string;
  project_id: string | null;
  status: string;
  dns_instructions: unknown;
  created_at: string;
  updated_at: string;
}) {
  return {
    domain: record.domain,
    subdomain_name: record.subdomain_name,
    url: `https://${record.domain}`,
    subdomain_url: `https://${record.subdomain_name}.run402.com`,
    status: record.status,
    dns_instructions: record.dns_instructions,
    project_id: record.project_id,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

// POST /v1/domains — register a custom domain
router.post("/domains/v1", serviceKeyOrAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { domain, subdomain_name } = req.body || {};

  if (!domain || typeof domain !== "string") {
    throw new HttpError(400, "Missing or invalid 'domain' field");
  }

  if (!subdomain_name || typeof subdomain_name !== "string") {
    throw new HttpError(400, "Missing or invalid 'subdomain_name' field");
  }

  const validationError = validateDomain(domain.toLowerCase());
  if (validationError) {
    throw new HttpError(400, validationError);
  }

  const projectId = req.project?.id || null;

  try {
    const record = await createDomain(domain.toLowerCase(), subdomain_name, projectId);
    res.status(201).json(formatDomain(record));
  } catch (err: unknown) {
    if (err instanceof DomainError) {
      throw new HttpError(err.statusCode, err.message);
    }
    throw err;
  }
}));

// GET /v1/domains — list custom domains
router.get("/domains/v1", serviceKeyOrAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (req.isAdmin) {
    const records = await listDomains();
    res.json({ domains: records.map(formatDomain) });
  } else {
    const projectId = req.project!.id;
    const records = await listDomains(projectId);
    res.json({ domains: records.map(formatDomain) });
  }
}));

// GET /v1/domains/:domain — check domain status (no auth)
router.get("/domains/v1/:domain", asyncHandler(async (req: Request, res: Response) => {
  const record = await getDomainWithStatus(req.params.domain as string);
  if (!record) {
    throw new HttpError(404, "Domain not found");
  }
  res.json(formatDomain(record));
}));

// DELETE /v1/domains/:domain — release a custom domain
router.delete("/domains/v1/:domain", serviceKeyOrAdmin, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.isAdmin ? null : (req.project?.id || null);

  try {
    const deleted = await deleteDomain(req.params.domain as string, projectId);
    if (!deleted) {
      throw new HttpError(404, "Domain not found");
    }
    res.json({ status: "deleted", domain: req.params.domain });
  } catch (err: unknown) {
    if (err instanceof DomainError) {
      throw new HttpError(err.statusCode, err.message);
    }
    throw err;
  }
}));

export default router;
