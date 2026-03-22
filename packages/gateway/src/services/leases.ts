import { pool } from "../db/pool.js";
import { archiveProject } from "./projects.js";
import { errorMessage } from "../utils/errors.js";

let leaseInterval: ReturnType<typeof setInterval> | null = null;

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
  leaseInterval = setInterval(checkWalletLeases, 60 * 60 * 1000);
  console.log("  Lease checker started (hourly)");
}

export function stopLeaseChecker(): void {
  if (leaseInterval) {
    clearInterval(leaseInterval);
    leaseInterval = null;
  }
}
