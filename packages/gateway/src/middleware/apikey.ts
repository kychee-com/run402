import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config.js";
import { projectCache, isServingStatus } from "../services/projects.js";
import type { ProjectInfo, TokenPayload } from "@run402/shared";

declare global {
  namespace Express {
    interface Request {
      project?: ProjectInfo;
      tokenPayload?: TokenPayload;
      isAdmin?: boolean;
      isProjectAdmin?: boolean;
      projectAdminUserId?: string;
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
  if (!project || !isServingStatus(project.status)) {
    res.status(404).json({ error: "Project not found or inactive" });
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
  if (!project || !isServingStatus(project.status)) {
    res.status(404).json({ error: "Project not found or inactive" });
    return;
  }

  req.project = project;
  req.tokenPayload = payload;
  next();
}

/**
 * Middleware: resolve project from Bearer token (project_admin JWT).
 * Validates role === project_admin, checks project_id matches URL :id,
 * and attaches req.project, req.isProjectAdmin, req.projectAdminUserId.
 */
export function projectAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }

  let payload: TokenPayload;
  try {
    payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as TokenPayload;
  } catch {
    res.status(401).json({ error: "Token expired or invalid" });
    return;
  }

  if (payload.role !== "project_admin") {
    res.status(401).json({ error: "Requires project_admin token" });
    return;
  }

  // Validate project_id matches URL :id parameter
  const urlProjectId = req.params.id;
  if (urlProjectId && payload.project_id !== urlProjectId) {
    res.status(401).json({ error: "Token project_id does not match URL" });
    return;
  }

  const project = projectCache.get(payload.project_id);
  if (!project || !isServingStatus(project.status)) {
    res.status(404).json({ error: "Project not found or inactive" });
    return;
  }

  req.project = project;
  req.tokenPayload = payload;
  req.isProjectAdmin = true;
  req.projectAdminUserId = payload.sub;
  next();
}

/**
 * Composed middleware: tries serviceKeyAuth, then projectAdminAuth.
 * If both fail, returns 401.
 */
export function serviceKeyOrProjectAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }

  let payload: TokenPayload;
  try {
    payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as TokenPayload;
  } catch {
    res.status(401).json({ error: "Token expired or invalid" });
    return;
  }

  // Route to the right auth based on role claim
  if (payload.role === "service_role") {
    serviceKeyAuth(req, res, next);
  } else if (payload.role === "project_admin") {
    projectAdminAuth(req, res, next);
  } else {
    res.status(401).json({ error: "Requires service_role or project_admin token" });
  }
}
