import { pool } from "../db/pool.js";
import { projectCache, archiveProject } from "./projects.js";
import { LEASE_GRACE_PERIOD, LEASE_DELETE_PERIOD } from "../config.js";

let leaseInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Check for expired leases. Called hourly.
 * - Past grace period (7 days after expiry): archive
 * - Past delete period (30 days after expiry): mark deleted
 */
async function checkLeases(): Promise<void> {
  const now = Date.now();

  for (const project of projectCache.values()) {
    if (project.status !== "active") continue;
    if (!project.leaseExpiresAt) continue;

    const expiryTime = project.leaseExpiresAt.getTime();

    if (now > expiryTime + LEASE_DELETE_PERIOD) {
      // Past delete period — archive and mark deleted
      console.log(`  Lease cleanup: deleting project ${project.id} (expired ${Math.floor((now - expiryTime) / 86400000)}d ago)`);
      try {
        await archiveProject(project.id);
        await pool.query(`UPDATE internal.projects SET status = 'deleted' WHERE id = $1`, [project.id]);
      } catch (err: any) {
        console.error(`  Failed to delete expired project ${project.id}:`, err.message);
      }
    } else if (now > expiryTime + LEASE_GRACE_PERIOD) {
      // Past grace period — archive
      console.log(`  Lease cleanup: archiving project ${project.id} (expired ${Math.floor((now - expiryTime) / 86400000)}d ago)`);
      try {
        await archiveProject(project.id);
      } catch (err: any) {
        console.error(`  Failed to archive expired project ${project.id}:`, err.message);
      }
    }
  }
}

export function startLeaseChecker(): void {
  // Run hourly
  leaseInterval = setInterval(checkLeases, 60 * 60 * 1000);
  console.log("  Lease checker started (hourly)");
}

export function stopLeaseChecker(): void {
  if (leaseInterval) {
    clearInterval(leaseInterval);
    leaseInterval = null;
  }
}
