import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config.js";
import { projectCache } from "../services/projects.js";
import type { ProjectInfo, TokenPayload } from "@run402/shared";

declare global {
  namespace Express {
    interface Request {
      project?: ProjectInfo;
      tokenPayload?: TokenPayload;
    }
  }
}

/**
 * Middleware: resolve project from `apikey` header (anon/authenticated JWT).
 * Attaches req.project on success.
 */
export function apikeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apikey = req.headers["apikey"] as string | undefined;
  if (!apikey) {
    res.status(401).json({ error: "Missing apikey header" });
    return;
  }

  let payload: TokenPayload;
  try {
    payload = jwt.verify(apikey, JWT_SECRET) as TokenPayload;
  } catch {
    res.status(401).json({ error: "Invalid apikey" });
    return;
  }

  const project = projectCache.get(payload.project_id);
  if (!project || project.status !== "active") {
    res.status(404).json({ error: "Project not found or inactive" });
    return;
  }

  // Check lease expiry
  if (project.leaseExpiresAt && new Date() > project.leaseExpiresAt) {
    res.status(402).json({
      error: "Lease expired",
      message: "Your project lease has expired. Renew to continue.",
      renew_url: `/projects/v1/${project.id}/renew`,
    });
    return;
  }

  req.project = project;
  req.tokenPayload = payload;
  next();
}

/**
 * Middleware: resolve project from Bearer token (service_role JWT).
 * Validates role === service_role and attaches req.project.
 */
export function serviceKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }

  let payload: TokenPayload;
  try {
    payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as TokenPayload;
  } catch {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  if (payload.role !== "service_role") {
    res.status(403).json({ error: "Requires service_role key" });
    return;
  }

  const project = projectCache.get(payload.project_id);
  if (!project || project.status !== "active") {
    res.status(404).json({ error: "Project not found or inactive" });
    return;
  }

  // Check lease expiry
  if (project.leaseExpiresAt && new Date() > project.leaseExpiresAt) {
    res.status(402).json({
      error: "Lease expired",
      message: "Your project lease has expired. Renew to continue.",
      renew_url: `/projects/v1/${project.id}/renew`,
    });
    return;
  }

  req.project = project;
  req.tokenPayload = payload;
  next();
}
