/**
 * Daily rent debit + suspension job for KMS contract wallets.
 *
 * Idempotent on `(wallet_id, today_utc_date)`. Safe to invoke at any cadence —
 * the existing run402 background-task scheduler runs it on every 30s tick
 * and a guard prevents double-debit within the same UTC day.
 *
 * Suspension is project-wide (DD-5): when a project's cash balance can't
 * cover rent for any one of its active wallets, ALL of the project's active
 * wallets transition to `suspended` simultaneously.
 */

import { randomUUID } from "node:crypto";
import { sql } from "../db/sql.js";
import { pool } from "../db/pool.js";
import { KMS_WALLET_RENT_USD_MICROS_PER_DAY } from "./contract-wallets.js";

interface RentResult {
  debited: string[];
  suspended: string[];
}

/**
 * Process pending rent debits.
 *
 * Algorithm:
 *   1. SELECT all active wallets where last_rent_debited_on < today_utc.
 *   2. Group by project_id.
 *   3. For each project:
 *        - Open a tx, lock the billing account row.
 *        - If balance >= (count * 40000): debit count * 40000, write
 *          one ledger entry per wallet, UPDATE last_rent_debited_on.
 *        - Else: SUSPEND every active wallet on the project.
 *      Commit.
 */
export async function debitDailyRent(): Promise<RentResult> {
  const debited: string[] = [];
  const suspended: string[] = [];

  // Fetch the to-process set in a single query so the per-project loop is
  // unambiguous about scope.
  const candidates = await pool.query(
    sql(`SELECT id, project_id FROM internal.contract_wallets
     WHERE status = 'active' AND (last_rent_debited_on < CURRENT_DATE OR last_rent_debited_on IS NULL)
     ORDER BY project_id, id`),
  );

  // Group by project
  const byProject = new Map<string, string[]>();
  for (const row of candidates.rows) {
    const list = byProject.get(row.project_id) ?? [];
    list.push(row.id);
    byProject.set(row.project_id, list);
  }

  for (const [projectId, walletIds] of byProject.entries()) {
    const client = await pool.connect();
    try {
      await client.query(sql(`BEGIN`));
      // Look up billing account via project owner wallet.
      const baResult = await client.query(
        sql(`SELECT ba.* FROM internal.billing_accounts ba
         JOIN internal.billing_account_wallets baw ON baw.billing_account_id = ba.id
         JOIN internal.projects p ON p.wallet_address = baw.wallet_address
         WHERE p.id = $1
         FOR UPDATE OF ba`),
        [projectId],
      );

      if (baResult.rows.length === 0) {
        // No billing account → suspend the project's wallets defensively.
        await client.query(
          sql(`UPDATE internal.contract_wallets
           SET status = 'suspended', suspended_at = NOW()
           WHERE project_id = $1 AND status = 'active'`),
          [projectId],
        );
        suspended.push(projectId);
        await client.query(sql(`COMMIT`));
        continue;
      }

      const billingAccountId = baResult.rows[0].id;
      const available = BigInt(baResult.rows[0].available_usd_micros);
      const requiredTotal = BigInt(KMS_WALLET_RENT_USD_MICROS_PER_DAY) * BigInt(walletIds.length);

      if (available < requiredTotal) {
        // Insufficient — suspend ALL active wallets on the project.
        await client.query(
          sql(`UPDATE internal.contract_wallets
           SET status = 'suspended', suspended_at = NOW()
           WHERE project_id = $1 AND status = 'active'`),
          [projectId],
        );
        suspended.push(projectId);
        await client.query(sql(`COMMIT`));
        continue;
      }

      // Debit total + one ledger entry per wallet
      let runningAvailable = available;
      for (const walletId of walletIds) {
        runningAvailable -= BigInt(KMS_WALLET_RENT_USD_MICROS_PER_DAY);
        const ledgerId = randomUUID();
        const todayIso = new Date().toISOString().slice(0, 10);
        await client.query(
          sql(`INSERT INTO internal.allowance_ledger
           (id, billing_account_id, direction, kind, amount_usd_micros,
            balance_after_available, balance_after_held, reference_type, reference_id,
            idempotency_key, metadata)
           VALUES ($1, $2, 'debit', 'kms_wallet_rental', $3, $4, $5, 'contract_wallet', $6, $7, $8)
           ON CONFLICT (idempotency_key) DO NOTHING`),
          [
            ledgerId,
            billingAccountId,
            KMS_WALLET_RENT_USD_MICROS_PER_DAY,
            runningAvailable.toString(),
            "0",
            walletId,
            `kms_wallet_rental:${walletId}:${todayIso}`,
            JSON.stringify({ wallet_id: walletId, day: todayIso }),
          ],
        );
        await client.query(
          sql(`UPDATE internal.contract_wallets
           SET last_rent_debited_on = CURRENT_DATE
           WHERE id = $1 AND last_rent_debited_on < CURRENT_DATE OR (id = $1 AND last_rent_debited_on IS NULL)`),
          [walletId],
        );
        debited.push(walletId);
      }
      await client.query(
        sql(`UPDATE internal.billing_accounts SET available_usd_micros = $1, updated_at = NOW() WHERE id = $2`),
        [runningAvailable.toString(), billingAccountId],
      );

      await client.query(sql(`COMMIT`));
    } catch (err) {
      try { await client.query(sql(`ROLLBACK`)); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  }

  return { debited, suspended };
}

/**
 * Reactivate every suspended wallet on the project. Called from billing
 * top-up code paths after a successful credit. No-op when nothing is
 * suspended.
 */
export async function reactivateProject(projectId: string): Promise<{ reactivated_count: number }> {
  const result = await pool.query(
    sql(`SELECT id FROM internal.contract_wallets WHERE project_id = $1 AND status = 'suspended'`),
    [projectId],
  );
  if (result.rows.length === 0) {
    return { reactivated_count: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query(sql(`BEGIN`));
    await client.query(
      sql(`UPDATE internal.contract_wallets
       SET status = 'active', suspended_at = NULL, last_warning_day = NULL,
           last_rent_debited_on = NULL
       WHERE project_id = $1 AND status = 'suspended'`),
      [projectId],
    );
    await client.query(sql(`COMMIT`));
  } catch (err) {
    try { await client.query(sql(`ROLLBACK`)); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }

  // Trigger an immediate debit-or-suspend pass for the project.
  await debitDailyRent();

  return { reactivated_count: result.rows.length };
}
