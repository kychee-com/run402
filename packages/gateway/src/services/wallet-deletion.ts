/**
 * 90-day suspension grace + funds-rescue lifecycle (DD-9, DD-10).
 *
 * For each suspended wallet the reconciler tick computes "days since
 * suspended_at" and dispatches:
 *   - day 60 / 75 / 88 → warning email (one per day, tracked via
 *     `last_warning_day`)
 *   - day 90+:
 *       - dust balance     → schedule KMS key deletion immediately
 *       - balance + recovery → submit auto-drain; defer deletion until the
 *         drain confirms (next tick).
 *       - balance + no recovery → schedule deletion + send fund-loss email.
 *
 * Dependencies that talk to RPC, KMS, the contract-call service, and email
 * are injected so the unit test can run with no infrastructure.
 */

import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";

export const DUST_WEI = BigInt(1000);
export const SUSPENSION_GRACE_DAYS = 90;
export const WARNING_DAYS = [60, 75, 88] as const;

export interface SuspensionGraceDeps {
  getBalanceWei: (address: string, chain?: string) => Promise<bigint>;
  scheduleKmsKeyDeletion: (kmsKeyId: string) => Promise<void>;
  submitDrainCall: (walletId: string, destinationAddress: string) => Promise<{ call_id: string; tx_hash: string }>;
  sendWarningEmail: (walletId: string, daysLeft: number) => Promise<void>;
  sendFundLossEmail: (walletId: string) => Promise<void>;
  sendDrainConfirmEmail: (walletId: string) => Promise<void>;
}

interface SuspendedWalletRow {
  id: string;
  project_id: string;
  address: string;
  chain: string;
  kms_key_id: string;
  recovery_address: string | null;
  suspended_at: string | Date;
  last_warning_day: number | null;
}

function daysSince(d: Date | string): number {
  const t = typeof d === "string" ? new Date(d).getTime() : d.getTime();
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

export async function processSuspensionGrace(deps: SuspensionGraceDeps): Promise<void> {
  const result = await pool.query(
    sql(`SELECT id, project_id, address, chain, kms_key_id, recovery_address, suspended_at, last_warning_day
     FROM internal.contract_wallets
     WHERE status = 'suspended' AND kms_key_id IS NOT NULL`),
  );

  for (const row of result.rows as SuspendedWalletRow[]) {
    const days = daysSince(row.suspended_at);

    if (days >= SUSPENSION_GRACE_DAYS) {
      await processDay90(row, deps);
      continue;
    }

    // Warnings
    for (const wd of WARNING_DAYS) {
      if (days >= wd && (row.last_warning_day ?? 0) < wd) {
        const daysLeft = SUSPENSION_GRACE_DAYS - wd;
        await deps.sendWarningEmail(row.id, daysLeft);
        await pool.query(
          sql(`UPDATE internal.contract_wallets SET last_warning_day = $1 WHERE id = $2`),
          [wd, row.id],
        );
        row.last_warning_day = wd;
      }
    }
  }
}

async function processDay90(row: SuspendedWalletRow, deps: SuspensionGraceDeps): Promise<void> {
  const balance = await deps.getBalanceWei(row.address, row.chain);

  // If a previous tick already submitted the auto-drain, follow up regardless
  // of current balance — the drain may have already cleared it.
  if (row.recovery_address) {
    const existingDrain = await pool.query(
      sql(`SELECT id, status FROM internal.contract_calls
       WHERE wallet_id = $1 AND function_name = '<auto_drain_pre_deletion>'
       ORDER BY created_at DESC LIMIT 1`),
      [row.id],
    );
    if (existingDrain.rows.length > 0) {
      const status = existingDrain.rows[0].status as string;
      if (status === "pending") return;
      if (status === "confirmed") {
        await scheduleDeletion(row, deps);
        await deps.sendDrainConfirmEmail(row.id);
        return;
      }
      if (status === "failed") {
        await scheduleDeletion(row, deps);
        await deps.sendFundLossEmail(row.id);
        return;
      }
    }
  }

  if (balance < DUST_WEI) {
    await scheduleDeletion(row, deps);
    return;
  }

  if (row.recovery_address) {
    // No prior drain on record → submit one now and wait for confirmation.
    await deps.submitDrainCall(row.id, row.recovery_address);
    return;
  }

  // No recovery address — delete and notify.
  await scheduleDeletion(row, deps);
  await deps.sendFundLossEmail(row.id);
}

async function scheduleDeletion(row: SuspendedWalletRow, deps: SuspensionGraceDeps): Promise<void> {
  await deps.scheduleKmsKeyDeletion(row.kms_key_id);
  await pool.query(
    sql(`UPDATE internal.contract_wallets
     SET status = 'deleted', deleted_at = NOW(), kms_key_id = NULL
     WHERE id = $1`),
    [row.id],
  );
}
