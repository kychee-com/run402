/**
 * Status reconciliation for `internal.contract_calls`.
 *
 * Runs every 30s. For each `pending` call older than ~5s, polls the chain
 * RPC for the receipt. On receipt:
 *   1. Compute gas cost in wei + USD-micros (Chainlink-cached price)
 *   2. Insert two ledger entries: `contract_call_gas` (at-cost) and
 *      `kms_sign_fee` (5 USD-micros markup).
 *   3. Update the call row to confirmed | failed in the same transaction.
 *
 * Idempotent: a re-run on an already-confirmed call is a no-op (the
 * pending filter excludes it).
 */

import { randomUUID } from "node:crypto";
import { sql } from "../db/sql.js";
import { pool } from "../db/pool.js";
import { getTransactionReceipt } from "./contract-call-rpc.js";
import { getCachedEthUsdPrice } from "./eth-usd-price.js";

export const KMS_SIGN_FEE_USD_MICROS = 5;

export async function reconcilePendingCalls(): Promise<void> {
  const result = await pool.query(
    sql(`SELECT id, wallet_id, project_id, chain, tx_hash
     FROM internal.contract_calls
     WHERE status = 'pending' AND tx_hash IS NOT NULL AND created_at < NOW() - INTERVAL '5 seconds'
     ORDER BY created_at ASC LIMIT 100`),
  );

  for (const row of result.rows) {
    let receipt;
    try {
      receipt = await getTransactionReceipt(row.tx_hash, row.chain);
    } catch (err) {
      console.error(`[reconciler] receipt fetch failed for ${row.id}:`, err);
      continue;
    }
    if (!receipt) continue;

    const gasUsedWei = receipt.gasUsed;
    const gasPriceWei = receipt.effectiveGasPrice;
    const gasCostWei = gasUsedWei * gasPriceWei;

    let ethUsd = 2000;
    try {
      ethUsd = await getCachedEthUsdPrice(row.chain);
    } catch {
      // fallback already inside the helper
    }
    const gasCostUsd = (Number(gasCostWei) / 1e18) * ethUsd;
    const gasCostUsdMicros = Math.max(1, Math.round(gasCostUsd * 1_000_000));

    // Find billing account for project
    const baResult = await pool.query(
      sql(`SELECT ba.id FROM internal.billing_accounts ba
       JOIN internal.billing_account_wallets baw ON baw.billing_account_id = ba.id
       JOIN internal.projects p ON p.wallet_address = baw.wallet_address
       WHERE p.id = $1`),
      [row.project_id],
    );
    if (baResult.rows.length === 0) {
      // No billing account → mark the call but skip ledger entries.
      await pool.query(
        sql(`UPDATE internal.contract_calls
         SET status = $1, gas_used_wei = $2, gas_cost_usd_micros = $3, updated_at = NOW()
         WHERE id = $4`),
        [receipt.status === "success" ? "confirmed" : "failed", gasUsedWei.toString(), gasCostUsdMicros, row.id],
      );
      continue;
    }
    const billingAccountId = baResult.rows[0].id;

    const client = await pool.connect();
    try {
      await client.query(sql(`BEGIN`));
      // Lock account
      const locked = await client.query(
        sql(`SELECT * FROM internal.billing_accounts WHERE id = $1 FOR UPDATE`),
        [billingAccountId],
      );
      const available = BigInt(locked.rows[0].available_usd_micros);
      const newAvailable = available - BigInt(gasCostUsdMicros) - BigInt(KMS_SIGN_FEE_USD_MICROS);

      await client.query(
        sql(`UPDATE internal.billing_accounts SET available_usd_micros = $1, updated_at = NOW() WHERE id = $2`),
        [newAvailable.toString(), billingAccountId],
      );

      // contract_call_gas ledger
      await client.query(
        sql(`INSERT INTO internal.allowance_ledger
         (id, billing_account_id, direction, kind, amount_usd_micros,
          balance_after_available, balance_after_held, reference_type, reference_id,
          idempotency_key, metadata)
         VALUES ($1, $2, 'debit', 'contract_call_gas', $3, $4, $5, 'contract_call', $6, $7, $8)
         ON CONFLICT (idempotency_key) DO NOTHING`),
        [
          randomUUID(),
          billingAccountId,
          gasCostUsdMicros,
          newAvailable.toString(),
          locked.rows[0].held_usd_micros,
          row.id,
          `contract_call_gas:${row.id}`,
          JSON.stringify({ call_id: row.id, tx_hash: row.tx_hash, chain: row.chain, gas_used_wei: gasUsedWei.toString(), gas_price_wei: gasPriceWei.toString(), eth_usd_price_used: ethUsd }),
        ],
      );

      // kms_sign_fee ledger
      await client.query(
        sql(`INSERT INTO internal.allowance_ledger
         (id, billing_account_id, direction, kind, amount_usd_micros,
          balance_after_available, balance_after_held, reference_type, reference_id,
          idempotency_key, metadata)
         VALUES ($1, $2, 'debit', 'kms_sign_fee', $3, $4, $5, 'contract_call', $6, $7, $8)
         ON CONFLICT (idempotency_key) DO NOTHING`),
        [
          randomUUID(),
          billingAccountId,
          KMS_SIGN_FEE_USD_MICROS,
          newAvailable.toString(),
          locked.rows[0].held_usd_micros,
          row.id,
          `kms_sign_fee:${row.id}`,
          JSON.stringify({ call_id: row.id }),
        ],
      );

      // Mark the call as terminal
      await client.query(
        sql(`UPDATE internal.contract_calls
         SET status = $1, gas_used_wei = $2, gas_cost_usd_micros = $3, receipt_json = $4, updated_at = NOW()
         WHERE id = $5`),
        [
          receipt.status === "success" ? "confirmed" : "failed",
          gasUsedWei.toString(),
          gasCostUsdMicros,
          JSON.stringify({ block_number: receipt.blockNumber.toString(), gas_used_wei: gasUsedWei.toString(), effective_gas_price_wei: gasPriceWei.toString(), status: receipt.status }),
          row.id,
        ],
      );

      await client.query(sql(`COMMIT`));
    } catch (err) {
      try { await client.query(sql(`ROLLBACK`)); } catch { /* ignore */ }
      console.error(`[reconciler] commit failed for ${row.id}:`, err);
    } finally {
      client.release();
    }
  }
}
