import { pool } from "../db/pool.js";
import { projectCache } from "./projects.js";
import { getTierLimits } from "@run402/shared";

/**
 * Update storage bytes for a project (on upload/delete).
 */
export async function updateStorageBytes(projectId: string, deltaBytes: number): Promise<void> {
  const project = projectCache.get(projectId);
  if (!project) return;

  project.storageBytes += deltaBytes;
  if (project.storageBytes < 0) project.storageBytes = 0;

  await pool.query(
    `UPDATE internal.projects SET storage_bytes = $1 WHERE id = $2`,
    [project.storageBytes, projectId],
  );
}

/**
 * Check if a project has exceeded its storage budget.
 */
export function isStorageExceeded(projectId: string): boolean {
  const project = projectCache.get(projectId);
  if (!project) return true;
  const limits = getTierLimits(project.tier);
  return project.storageBytes >= limits.storageBytes;
}
