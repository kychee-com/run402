import { pool } from "../db/pool.js";
import { projectCache, archiveProject } from "./projects.js";
import { LEASE_GRACE_PERIOD, LEASE_DELETE_PERIOD } from "../config.js";
import { errorMessage } from "../utils/errors.js";

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

    // Skip pinned projects (e.g. showcase apps that should never expire)
    if (project.pinned) continue;

    const expiryTime = project.leaseExpiresAt.getTime();

    if (now > expiryTime + LEASE_DELETE_PERIOD) {
      // Past delete period — archive and mark deleted
      console.log(`  Lease cleanup: deleting project ${project.id} (expired ${Math.floor((now - expiryTime) / 86400000)}d ago)`);
      try {
        await archiveProject(project.id);
        await pool.query(`UPDATE internal.projects SET status = 'deleted' WHERE id = $1`, [project.id]);
      } catch (err: unknown) {
        console.error(`  Failed to delete expired project ${project.id}:`, errorMessage(err));
      }
    } else if (now > expiryTime + LEASE_GRACE_PERIOD) {
      // Past grace period — archive
      console.log(`  Lease cleanup: archiving project ${project.id} (expired ${Math.floor((now - expiryTime) / 86400000)}d ago)`);
      try {
        await archiveProject(project.id);
      } catch (err: unknown) {
        console.error(`  Failed to archive expired project ${project.id}:`, errorMessage(err));
      }
    }
  }

  // Check wallet-level leases
  await checkWalletLeases();
}

/**
 * Check wallet-level tier leases. When a wallet's tier expires,
 * archive ALL its active projects.
 */
async function checkWalletLeases(): Promise<void> {
  try {
    // Find wallets with expired tier leases that still have active projects
    const result = await pool.query(`
      SELECT DISTINCT baw.wallet_address, ba.tier, ba.lease_expires_at
      FROM internal.billing_accounts ba
      JOIN internal.billing_account_wallets baw ON baw.billing_account_id = ba.id
      WHERE ba.tier IS NOT NULL
        AND ba.lease_expires_at IS NOT NULL
        AND ba.lease_expires_at < NOW() - INTERVAL '7 days'
      AND EXISTS (
        SELECT 1 FROM internal.projects p
        WHERE p.wallet_address = baw.wallet_address
        AND p.status = 'active'
        AND p.pinned = false
      )
    `);

    for (const row of result.rows) {
      const wallet = row.wallet_address;
      console.log(`  Wallet lease expired: ${wallet} (tier: ${row.tier}, expired: ${row.lease_expires_at})`);

      // Find and archive all non-pinned active projects for this wallet
      const projects = await pool.query(
        `SELECT id FROM internal.projects WHERE wallet_address = $1 AND status = 'active' AND pinned = false`,
        [wallet],
      );

      for (const proj of projects.rows) {
        try {
          await archiveProject(proj.id);
          console.log(`    Archived project ${proj.id} (wallet lease expired)`);
        } catch (err: unknown) {
          console.error(`    Failed to archive project ${proj.id}:`, errorMessage(err));
        }
      }
    }
  } catch (err: unknown) {
    console.error("  Failed to check wallet leases:", errorMessage(err));
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
