/**
 * Wallet tier service — manages wallet-level tier subscriptions.
 *
 * A wallet subscribes to a tier (prototype/hobby/team) which grants pool
 * limits across all its projects. Projects no longer have individual pricing;
 * they inherit limits from the wallet's active tier.
 */

import { pool } from "../db/pool.js";
import { TIERS, getTierLimits } from "@run402/shared";
import type { TierName, WalletTierInfo } from "@run402/shared";
import { getOrCreateBillingAccount, type BillingAccount } from "./billing.js";
import { randomUUID } from "node:crypto";

/**
 * Subscribe a wallet to a tier. Sets tier + lease on the billing account.
 */
export async function subscribeTier(
  wallet: string,
  tier: TierName,
): Promise<BillingAccount> {
  const normalized = wallet.toLowerCase();
  const account = await getOrCreateBillingAccount(normalized);
  const tierConfig = TIERS[tier];

  const now = new Date();
  const expiresAt = new Date(now.getTime() + tierConfig.leaseDays * 24 * 60 * 60 * 1000);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE internal.billing_accounts
       SET tier = $1, lease_started_at = $2, lease_expires_at = $3, updated_at = NOW()
       WHERE id = $4`,
      [tier, now, expiresAt, account.id],
    );

    // Ledger entry for the subscription
    const ledgerId = randomUUID();
    await client.query(
      `INSERT INTO internal.allowance_ledger
       (id, billing_account_id, direction, kind, amount_usd_micros,
        balance_after_available, balance_after_held,
        reference_type, reference_id, idempotency_key, metadata)
       VALUES ($1, $2, 'debit', 'tier_subscribe', 0, $3, $4, 'tier', $5, $6, $7)`,
      [
        ledgerId, account.id,
        account.available_usd_micros, account.held_usd_micros,
        tier, randomUUID(),
        JSON.stringify({ tier, lease_days: tierConfig.leaseDays }),
      ],
    );

    await client.query("COMMIT");

    const result = await pool.query(
      `SELECT * FROM internal.billing_accounts WHERE id = $1`,
      [account.id],
    );
    return rowToAccount(result.rows[0]);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* may already be released */ }
  }
}

/**
 * Renew a wallet's current tier subscription.
 */
export async function renewTier(
  wallet: string,
  tier: TierName,
): Promise<BillingAccount> {
  const normalized = wallet.toLowerCase();
  const account = await getOrCreateBillingAccount(normalized);
  const tierConfig = TIERS[tier];

  // Extend from current expiry if still active, otherwise from now
  const now = new Date();
  const base = account.lease_expires_at && account.lease_expires_at.getTime() > now.getTime()
    ? account.lease_expires_at
    : now;
  const expiresAt = new Date(base.getTime() + tierConfig.leaseDays * 24 * 60 * 60 * 1000);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE internal.billing_accounts
       SET tier = $1, lease_started_at = COALESCE(lease_started_at, $2), lease_expires_at = $3, updated_at = NOW()
       WHERE id = $4`,
      [tier, now, expiresAt, account.id],
    );

    const ledgerId = randomUUID();
    await client.query(
      `INSERT INTO internal.allowance_ledger
       (id, billing_account_id, direction, kind, amount_usd_micros,
        balance_after_available, balance_after_held,
        reference_type, reference_id, idempotency_key, metadata)
       VALUES ($1, $2, 'debit', 'tier_renew', 0, $3, $4, 'tier', $5, $6, $7)`,
      [
        ledgerId, account.id,
        account.available_usd_micros, account.held_usd_micros,
        tier, randomUUID(),
        JSON.stringify({ tier, lease_days: tierConfig.leaseDays }),
      ],
    );

    await client.query("COMMIT");

    const result = await pool.query(
      `SELECT * FROM internal.billing_accounts WHERE id = $1`,
      [account.id],
    );
    return rowToAccount(result.rows[0]);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* may already be released */ }
  }
}

/**
 * Upgrade a wallet's tier. Charges full new-tier price via x402.
 * Prorated refund of remaining time on old tier is credited to allowance.
 */
export async function upgradeTier(
  wallet: string,
  newTier: TierName,
): Promise<BillingAccount> {
  const normalized = wallet.toLowerCase();
  const account = await getOrCreateBillingAccount(normalized);
  const newTierConfig = TIERS[newTier];

  const now = new Date();
  const expiresAt = new Date(now.getTime() + newTierConfig.leaseDays * 24 * 60 * 60 * 1000);

  // Calculate prorated refund for remaining old tier time
  let refundMicros = 0;
  if (account.tier && account.lease_expires_at && account.lease_started_at) {
    const oldTierConfig = TIERS[account.tier as TierName];
    if (oldTierConfig) {
      const totalMs = account.lease_expires_at.getTime() - account.lease_started_at.getTime();
      const remainingMs = Math.max(0, account.lease_expires_at.getTime() - now.getTime());
      if (totalMs > 0) {
        refundMicros = Math.floor((remainingMs / totalMs) * oldTierConfig.priceUsdMicros);
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock account
    const locked = await client.query(
      `SELECT * FROM internal.billing_accounts WHERE id = $1 FOR UPDATE`,
      [account.id],
    );
    const currentAvailable = Number(locked.rows[0].available_usd_micros);
    const currentHeld = Number(locked.rows[0].held_usd_micros);

    let newAvailable = currentAvailable;

    // Credit prorated refund to allowance
    if (refundMicros > 0) {
      newAvailable += refundMicros;

      const refundLedgerId = randomUUID();
      await client.query(
        `INSERT INTO internal.allowance_ledger
         (id, billing_account_id, direction, kind, amount_usd_micros,
          balance_after_available, balance_after_held,
          reference_type, reference_id, idempotency_key, metadata)
         VALUES ($1, $2, 'credit', 'tier_upgrade_refund', $3, $4, $5, 'tier', $6, $7, $8)`,
        [
          refundLedgerId, account.id,
          refundMicros, newAvailable, currentHeld,
          `${account.tier}_to_${newTier}`, randomUUID(),
          JSON.stringify({ old_tier: account.tier, new_tier: newTier, refund_micros: refundMicros }),
        ],
      );
    }

    // Update tier + lease + allowance
    await client.query(
      `UPDATE internal.billing_accounts
       SET tier = $1, lease_started_at = $2, lease_expires_at = $3,
           available_usd_micros = $4, updated_at = NOW()
       WHERE id = $5`,
      [newTier, now, expiresAt, newAvailable, account.id],
    );

    const upgradeLedgerId = randomUUID();
    await client.query(
      `INSERT INTO internal.allowance_ledger
       (id, billing_account_id, direction, kind, amount_usd_micros,
        balance_after_available, balance_after_held,
        reference_type, reference_id, idempotency_key, metadata)
       VALUES ($1, $2, 'debit', 'tier_upgrade', 0, $3, $4, 'tier', $5, $6, $7)`,
      [
        upgradeLedgerId, account.id,
        newAvailable, currentHeld,
        newTier, randomUUID(),
        JSON.stringify({ old_tier: account.tier, new_tier: newTier, refund_micros: refundMicros }),
      ],
    );

    await client.query("COMMIT");

    const result = await pool.query(
      `SELECT * FROM internal.billing_accounts WHERE id = $1`,
      [account.id],
    );
    return rowToAccount(result.rows[0]);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* may already be released */ }
  }
}

/**
 * Get wallet tier info including pool usage across all projects.
 */
export async function getWalletTier(wallet: string): Promise<WalletTierInfo> {
  const normalized = wallet.toLowerCase();

  // Get billing account
  const accountResult = await pool.query(
    `SELECT ba.* FROM internal.billing_accounts ba
     JOIN internal.billing_account_wallets baw ON baw.billing_account_id = ba.id
     WHERE baw.wallet_address = $1`,
    [normalized],
  );

  const usage = await getWalletPoolUsage(normalized);

  if (accountResult.rows.length === 0) {
    return {
      wallet: normalized,
      tier: null,
      lease_started_at: null,
      lease_expires_at: null,
      active: false,
      pool_usage: usage,
    };
  }

  const row = accountResult.rows[0];
  const tier = row.tier as TierName | null;
  const leaseExpiresAt = row.lease_expires_at ? new Date(row.lease_expires_at as string) : null;
  const active = tier !== null && leaseExpiresAt !== null && leaseExpiresAt.getTime() > Date.now();

  return {
    wallet: normalized,
    tier,
    lease_started_at: row.lease_started_at ? new Date(row.lease_started_at as string).toISOString() : null,
    lease_expires_at: leaseExpiresAt ? leaseExpiresAt.toISOString() : null,
    active,
    pool_usage: usage,
  };
}

/**
 * Get aggregate pool usage across all projects for a wallet.
 */
export async function getWalletPoolUsage(wallet: string): Promise<WalletTierInfo["pool_usage"]> {
  const normalized = wallet.toLowerCase();

  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS projects,
       COALESCE(SUM(api_calls), 0)::bigint AS total_api_calls,
       COALESCE(SUM(storage_bytes), 0)::bigint AS total_storage_bytes
     FROM internal.projects
     WHERE wallet_address = $1 AND status = 'active'`,
    [normalized],
  );

  const row = result.rows[0] || { projects: 0, total_api_calls: 0, total_storage_bytes: 0 };

  // Get tier limits from billing account
  const accountResult = await pool.query(
    `SELECT ba.tier FROM internal.billing_accounts ba
     JOIN internal.billing_account_wallets baw ON baw.billing_account_id = ba.id
     WHERE baw.wallet_address = $1`,
    [normalized],
  );

  const tier = accountResult.rows[0]?.tier as TierName | null;
  const limits = tier ? getTierLimits(tier) : { apiCalls: 0, storageBytes: 0 };

  return {
    projects: Number(row.projects),
    total_api_calls: Number(row.total_api_calls),
    total_storage_bytes: Number(row.total_storage_bytes),
    api_calls_limit: limits.apiCalls,
    storage_bytes_limit: limits.storageBytes,
  };
}

/**
 * Unified tier operation: auto-detects subscribe, renew, upgrade, or downgrade.
 */
export type TierAction = "subscribe" | "renew" | "upgrade" | "downgrade";

export async function setTier(
  wallet: string,
  tier: TierName,
): Promise<BillingAccount & { action: TierAction; previous_tier?: string | null }> {
  const normalized = wallet.toLowerCase();
  const account = await getOrCreateBillingAccount(normalized);

  const TIER_ORDER: TierName[] = ["prototype", "hobby", "team"];
  const currentIdx = account.tier ? TIER_ORDER.indexOf(account.tier as TierName) : -1;
  const newIdx = TIER_ORDER.indexOf(tier);
  const isActive = account.tier !== null
    && account.lease_expires_at !== null
    && account.lease_expires_at.getTime() > Date.now();

  if (!account.tier || !isActive) {
    // No tier or expired → fresh subscribe
    const result = await subscribeTier(wallet, tier);
    return { ...result, action: "subscribe", previous_tier: account.tier };
  } else if (tier === account.tier) {
    // Same tier, active → renew (extend from expiry)
    const result = await renewTier(wallet, tier);
    return { ...result, action: "renew", previous_tier: account.tier };
  } else if (newIdx > currentIdx) {
    // Higher tier → upgrade (prorated refund to allowance)
    const previousTier = account.tier;
    const result = await upgradeTier(wallet, tier);
    return { ...result, action: "upgrade", previous_tier: previousTier };
  } else {
    // Lower tier, active → downgrade if usage fits
    const usage = await getWalletPoolUsage(normalized);
    const limits = getTierLimits(tier);
    if (usage.total_storage_bytes > limits.storageBytes) {
      throw new Error(
        `Cannot downgrade: storage usage (${usage.total_storage_bytes} bytes) exceeds ${tier} limit (${limits.storageBytes} bytes). Delete data or wait for lease to expire.`,
      );
    }
    // Prorated refund of remaining old tier time, same as upgrade
    const previousTier = account.tier;
    const result = await upgradeTier(wallet, tier);
    return { ...result, action: "downgrade", previous_tier: previousTier };
  }
}

/**
 * Check if a wallet has an active tier subscription.
 */
export function isWalletTierActive(account: BillingAccount): boolean {
  return (
    account.tier !== null &&
    account.lease_expires_at !== null &&
    account.lease_expires_at.getTime() > Date.now()
  );
}

/**
 * Calculate the x402 price for upgrading from current tier to a new tier.
 * Returns full new-tier price (prorated refund credited to allowance separately).
 */
export function calculateUpgradePrice(newTier: TierName): number {
  return TIERS[newTier].priceUsdMicros;
}

// Row mapper (duplicated from billing.ts to avoid circular dependency)
function rowToAccount(row: Record<string, unknown>): BillingAccount {
  return {
    id: row.id as string,
    status: row.status as string,
    currency: row.currency as string,
    available_usd_micros: Number(row.available_usd_micros),
    held_usd_micros: Number(row.held_usd_micros),
    funding_policy: row.funding_policy as string,
    low_balance_threshold_usd_micros: Number(row.low_balance_threshold_usd_micros),
    primary_contact_email: row.primary_contact_email as string | null,
    tier: (row.tier as string) || null,
    lease_started_at: row.lease_started_at ? new Date(row.lease_started_at as string) : null,
    lease_expires_at: row.lease_expires_at ? new Date(row.lease_expires_at as string) : null,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}
