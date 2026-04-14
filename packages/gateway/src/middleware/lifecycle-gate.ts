/**
 * Lifecycle write gate.
 *
 * Control-plane mutating routes (deploys, subdomain claims, secret rotation,
 * function upload, billing-plumbing writes) must be blocked when the target
 * project is not `active`. The live site and end-user data-plane traffic are
 * explicitly NOT gated — they continue to serve throughout grace.
 *
 * Apply this AFTER the auth middleware that attaches req.project (or sets
 * req.tokenPayload.project_id, or after any handler that attaches a project
 * by id). It consults the project cache to decide whether to 402 the request.
 *
 * Admin callers (`req.isAdmin === true`) bypass the gate so operators can
 * still manage grace-state projects for dispute resolution.
 */

import type { Request, Response, NextFunction } from "express";
import { projectCache, getProjectById } from "../services/projects.js";
import { PAST_DUE_DURATION_MS, FROZEN_DURATION_MS } from "../services/project-lifecycle.js";
import type { ProjectInfo } from "@run402/shared";

function resolveProjectId(req: Request): string | null {
  if (req.project?.id) return req.project.id;
  if (req.tokenPayload?.project_id) return req.tokenPayload.project_id;
  const idParam = req.params["id"];
  if (typeof idParam === "string") return idParam;
  const projectIdParam = req.params["projectId"];
  if (typeof projectIdParam === "string") return projectIdParam;
  const bodyId = (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>)["project_id"] : undefined);
  if (typeof bodyId === "string") return bodyId;
  return null;
}

function nextTransitionAt(project: ProjectInfo, row: Record<string, unknown>): Date | null {
  if (project.status === "past_due" && row["past_due_since"]) {
    return new Date(new Date(row["past_due_since"] as string).getTime() + PAST_DUE_DURATION_MS);
  }
  if (project.status === "frozen" && row["frozen_at"]) {
    return new Date(new Date(row["frozen_at"] as string).getTime() + FROZEN_DURATION_MS);
  }
  if (project.status === "dormant" && row["scheduled_purge_at"]) {
    return new Date(row["scheduled_purge_at"] as string);
  }
  return null;
}

/**
 * Express middleware that rejects mutating requests on non-active projects
 * with 402 Payment Required. Non-mutating methods (GET, HEAD, OPTIONS) skip
 * the check. Missing project context is passed through — the downstream
 * route will decide whether that's legal.
 */
export async function lifecycleGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Admins bypass
  if (req.isAdmin) { next(); return; }

  // Reads are never gated
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") { next(); return; }

  const projectId = resolveProjectId(req);
  if (!projectId) { next(); return; }

  // Cache-first (avoids a DB round-trip on the hot path)
  let project: ProjectInfo | null | undefined = projectCache.get(projectId);
  if (!project) {
    try {
      project = await getProjectById(projectId);
    } catch {
      // On DB failure, don't block the request — let the downstream handler surface the error
      next(); return;
    }
  }
  if (!project) { next(); return; }
  if (project.status === "active") { next(); return; }

  // Block with 402. Fetch the exact timer row for richer diagnostics.
  const { pool } = await import("../db/pool.js");
  const { sql } = await import("../db/sql.js");
  const result = await pool.query(
    sql(`SELECT past_due_since, frozen_at, dormant_at, scheduled_purge_at
     FROM internal.projects WHERE id = $1 LIMIT 1`),
    [projectId],
  );
  const row = result.rows[0] ?? {};
  const nextAt = nextTransitionAt(project, row);
  res.status(402).json({
    error: "payment_required",
    message: `Project is ${project.status}. Renew the wallet's tier to restore control-plane access.`,
    lifecycle_state: project.status,
    entered_state_at:
      project.status === "past_due" ? row["past_due_since"] :
      project.status === "frozen" ? row["frozen_at"] :
      project.status === "dormant" ? row["dormant_at"] : null,
    next_transition_at: nextAt?.toISOString() ?? null,
  });
}
