import { pool } from "../db/pool.js";
import { projectCache, archiveProject } from "./projects.js";
import { LEASE_GRACE_PERIOD, LEASE_DELETE_PERIOD } from "../config.js";
import { getWalletSubscription, clearSubscriptionCache } from "./stripe-subscriptions.js";
import type { TierName } from "@run402/shared";
import { errorMessage } from "../utils/errors.js";

let leaseInterval: ReturnType<typeof setInterval> | null = null;
let lastStripeCheck = 0;
const STRIPE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24h

/**
 * Check for expired leases. Called hourly.
 * - Past grace period (7 days after expiry): archive
 * - Past delete period (30 days after expiry): mark deleted
 * - Daily: sync Stripe subscription status for subscribed wallets
 */
async function checkLeases(): Promise<void> {
  const now = Date.now();

  // Daily Stripe lifecycle sync
  if (now - lastStripeCheck >= STRIPE_CHECK_INTERVAL) {
    await syncStripeSubscriptions();
    lastStripeCheck = now;
  }

  for (const project of projectCache.values()) {
    if (project.status !== "active") continue;
    if (!project.leaseExpiresAt) continue;

    // Skip pinned projects (e.g. showcase apps that should never expire)
    if (project.pinned) continue;

    // Skip subscription-managed projects (their leases are extended by syncStripeSubscriptions)
    if (project.walletAddress) {
      const sub = await getWalletSubscription(project.walletAddress);
      if (sub?.status === "active") continue;
    }

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
}

/**
 * Daily sync: extend leases and upgrade tiers for subscribed wallets.
 */
async function syncStripeSubscriptions(): Promise<void> {
  // Group projects by wallet
  const walletProjects = new Map<string, string[]>();
  for (const project of projectCache.values()) {
    if (project.status !== "active" || !project.walletAddress) continue;
    const existing = walletProjects.get(project.walletAddress);
    if (existing) {
      existing.push(project.id);
    } else {
      walletProjects.set(project.walletAddress, [project.id]);
    }
  }

  if (walletProjects.size === 0) return;

  let synced = 0;
  for (const [wallet, projectIds] of walletProjects) {
    try {
      const sub = await getWalletSubscription(wallet);
      if (!sub || sub.status !== "active") continue;

      // Extend lease to currentPeriodEnd + 7d grace
      const graceMs = 7 * 24 * 60 * 60 * 1000;
      const newExpiry = new Date(sub.currentPeriodEnd.getTime() + graceMs);

      for (const pid of projectIds) {
        const project = projectCache.get(pid);
        if (!project) continue;

        // Upgrade tier if subscription tier differs
        const needsUpdate = project.tier !== sub.tier || project.leaseExpiresAt < newExpiry;
        if (needsUpdate) {
          await pool.query(
            `UPDATE internal.projects SET tier = $1, lease_expires_at = $2 WHERE id = $3`,
            [sub.tier, newExpiry.toISOString(), pid],
          );
          project.tier = sub.tier as TierName;
          project.leaseExpiresAt = newExpiry;
          synced++;
        }
      }
    } catch (err: unknown) {
      console.error(`  Stripe sync failed for wallet ${wallet}:`, errorMessage(err));
    }
  }

  // Clear cache after sync to pick up fresh data
  clearSubscriptionCache();

  if (synced > 0) {
    console.log(`  Stripe sync: updated ${synced} project(s) across ${walletProjects.size} wallet(s)`);
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
