/**
 * Demo mode middleware — enforce limits on demo-flagged projects.
 *
 * Demo projects are live interactive instances of published apps.
 * Visitors can browse freely but writes are capped. When limits are hit,
 * the response guides visitors toward forking.
 */

import { Request, Response, NextFunction } from "express";
import type { ProjectInfo } from "@run402/shared";
import { DEFAULT_DEMO_CONFIG } from "@run402/shared";

// --- In-memory counters (per demo project, per gateway instance) ---

interface DemoCounters {
  inserts: number;
  deletes: number;
  signups: number;
  storageFiles: number;
  functionInvocations: number;
}

const counters = new Map<string, DemoCounters>();

// Projects currently being reset (returns 503)
const maintenanceProjects = new Set<string>();

export function getDemoCounters(projectId: string): DemoCounters {
  let c = counters.get(projectId);
  if (!c) {
    c = { inserts: 0, deletes: 0, signups: 0, storageFiles: 0, functionInvocations: 0 };
    counters.set(projectId, c);
  }
  return c;
}

export function resetDemoCounters(projectId: string): void {
  counters.delete(projectId);
}

export function setDemoMaintenance(projectId: string, active: boolean): void {
  if (active) maintenanceProjects.add(projectId);
  else maintenanceProjects.delete(projectId);
}

// --- Response helpers ---

function getRetryAfterSeconds(project: ProjectInfo): number {
  const config = project.demoConfig || DEFAULT_DEMO_CONFIG;
  if (!project.demoLastResetAt) return config.reset_interval_hours * 3600;
  const nextReset = project.demoLastResetAt.getTime() + config.reset_interval_hours * 3600000;
  return Math.max(1, Math.ceil((nextReset - Date.now()) / 1000));
}

function getResetsAt(project: ProjectInfo): string | undefined {
  const config = project.demoConfig || DEFAULT_DEMO_CONFIG;
  if (!project.demoLastResetAt) return undefined;
  return new Date(project.demoLastResetAt.getTime() + config.reset_interval_hours * 3600000).toISOString();
}

function demoLimitResponse(
  project: ProjectInfo,
  limitType: string,
  code: string,
  message: string,
  current: number,
  max: number,
) {
  return {
    error: "demo_limit_reached",
    code,
    message,
    limit_type: limitType,
    current,
    max,
    fork: project.demoSourceVersionId ? {
      version_id: project.demoSourceVersionId,
      fork_url: `https://run402.com/apps#${project.demoSourceVersionId}`,
    } : undefined,
    resets_at: getResetsAt(project),
  };
}

function sendDemoLimit(
  res: Response,
  project: ProjectInfo,
  limitType: string,
  code: string,
  message: string,
  current: number,
  max: number,
): void {
  res.set("Retry-After", String(getRetryAfterSeconds(project)));
  res.status(429).json(demoLimitResponse(project, limitType, code, message, current, max));
}

function sendDemoBlocked(res: Response, project: ProjectInfo, what: string): void {
  res.set("Retry-After", String(getRetryAfterSeconds(project)));
  res.status(429).json({
    error: "demo_limit_reached",
    code: "DEMO_BLOCKED",
    message: `This is a live demo. ${what} is not available in demo mode. Fork this app to get your own copy with no limits.`,
    limit_type: "blocked",
    fork: project.demoSourceVersionId ? {
      version_id: project.demoSourceVersionId,
      fork_url: `https://run402.com/apps#${project.demoSourceVersionId}`,
    } : undefined,
    resets_at: getResetsAt(project),
  });
}

function sendMaintenance(res: Response): void {
  res.set("Retry-After", "30");
  res.status(503).json({ error: "Demo is resetting. Try again in a few seconds.", retry_after: 30 });
}

// --- Middleware functions ---

/**
 * Demo check for PostgREST proxy routes (/rest/v1/*).
 * POST = insert (counted), PATCH/PUT = edit (configurable), DELETE = counted, GET = allowed.
 */
export function demoRestMiddleware(req: Request, res: Response, next: NextFunction): void {
  const project = req.project;
  if (!project?.demoMode) return next();
  if (maintenanceProjects.has(project.id)) return sendMaintenance(res);

  const config = project.demoConfig || DEFAULT_DEMO_CONFIG;
  const c = getDemoCounters(project.id);

  if (req.method === "POST") {
    if (c.inserts >= config.max_row_inserts) {
      return sendDemoLimit(res, project, "row_inserts", "DEMO_ROW_INSERT_LIMIT",
        "This is a live demo. You've reached the insert limit. Fork this app to get your own copy with no limits.",
        c.inserts, config.max_row_inserts);
    }
    c.inserts++;
  } else if (req.method === "DELETE") {
    if (!config.allow_deletes) {
      return sendDemoBlocked(res, project, "Deleting data");
    }
    if (c.deletes >= config.max_row_deletes) {
      return sendDemoLimit(res, project, "row_deletes", "DEMO_ROW_DELETE_LIMIT",
        "This is a live demo. You've reached the delete limit. Fork this app to get your own copy with no limits.",
        c.deletes, config.max_row_deletes);
    }
    c.deletes++;
  } else if (req.method === "PATCH" || req.method === "PUT") {
    if (!config.allow_edits) {
      return sendDemoBlocked(res, project, "Editing data");
    }
  }
  // GET/HEAD/OPTIONS always allowed

  next();
}

/**
 * Demo check for auth signup (/auth/v1/signup).
 */
export function demoSignupMiddleware(req: Request, res: Response, next: NextFunction): void {
  const project = req.project;
  if (!project?.demoMode) return next();
  if (maintenanceProjects.has(project.id)) return sendMaintenance(res);

  const config = project.demoConfig || DEFAULT_DEMO_CONFIG;
  const c = getDemoCounters(project.id);

  if (c.signups >= config.max_auth_users) {
    return sendDemoLimit(res, project, "auth_users", "DEMO_AUTH_USER_LIMIT",
      "This is a live demo. You've reached the signup limit. Fork this app to get your own copy with no limits.",
      c.signups, config.max_auth_users);
  }
  c.signups++;
  next();
}

/**
 * Demo check for storage uploads (POST /storage/v1/*).
 */
export function demoStorageMiddleware(req: Request, res: Response, next: NextFunction): void {
  const project = req.project;
  if (!project?.demoMode) return next();
  if (maintenanceProjects.has(project.id)) return sendMaintenance(res);

  if (req.method !== "POST") return next();

  const config = project.demoConfig || DEFAULT_DEMO_CONFIG;
  const c = getDemoCounters(project.id);

  if (c.storageFiles >= config.max_storage_files) {
    return sendDemoLimit(res, project, "storage_files", "DEMO_STORAGE_FILE_LIMIT",
      "This is a live demo. You've reached the file upload limit. Fork this app to get your own copy with no limits.",
      c.storageFiles, config.max_storage_files);
  }
  c.storageFiles++;
  next();
}

/**
 * Demo check for function invocations (/functions/v1/*).
 */
export function demoFunctionInvokeMiddleware(req: Request, res: Response, next: NextFunction): void {
  const project = req.project;
  if (!project?.demoMode) return next();
  if (maintenanceProjects.has(project.id)) return sendMaintenance(res);

  const config = project.demoConfig || DEFAULT_DEMO_CONFIG;
  const c = getDemoCounters(project.id);

  if (c.functionInvocations >= config.max_function_invocations) {
    return sendDemoLimit(res, project, "function_invocations", "DEMO_FUNCTION_INVOCATION_LIMIT",
      "This is a live demo. You've reached the function invocation limit. Fork this app to get your own copy with no limits.",
      c.functionInvocations, config.max_function_invocations);
  }
  c.functionInvocations++;
  next();
}

/**
 * Demo check: block endpoint entirely (SQL exec, secrets, function deploy).
 */
export function demoBlockedMiddleware(what: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const project = req.project;
    if (!project?.demoMode) return next();
    if (maintenanceProjects.has(project.id)) return sendMaintenance(res);
    sendDemoBlocked(res, project, what);
  };
}
