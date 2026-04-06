/**
 * Background job: poll active wallets for low native-token balance and
 * fire a notification email (one per 24 hours per wallet) when balance
 * falls below the wallet's threshold.
 */

import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { getNativeBalanceWei } from "./contract-call-tx.js";
import { sendPlatformEmail } from "./platform-mail.js";

const ALERT_COOLDOWN_HOURS = 24;

export async function checkLowBalances(): Promise<void> {
  const result = await pool.query(
    sql(`SELECT id, project_id, address, chain, low_balance_threshold_wei, last_alert_sent_at
     FROM internal.contract_wallets
     WHERE status = 'active'`),
  );

  for (const row of result.rows) {
    try {
      const balance = await getNativeBalanceWei(row.address, row.chain);
      const threshold = BigInt(row.low_balance_threshold_wei ?? "0");
      if (balance >= threshold) continue;

      const last = row.last_alert_sent_at ? new Date(row.last_alert_sent_at).getTime() : 0;
      if (Date.now() - last < ALERT_COOLDOWN_HOURS * 60 * 60 * 1000) continue;

      // Look up billing email for the project
      const emailResult = await pool.query(
        sql(`SELECT primary_contact_email FROM internal.billing_accounts ba
         JOIN internal.billing_account_wallets baw ON baw.billing_account_id = ba.id
         JOIN internal.projects p ON p.wallet_address = baw.wallet_address
         WHERE p.id = $1
         LIMIT 1`),
        [row.project_id],
      );
      const to = emailResult.rows[0]?.primary_contact_email;
      if (!to) continue;

      await sendPlatformEmail({
        to,
        subject: `Low ETH balance on KMS wallet ${row.id}`,
        html: `<p>Your run402 KMS contract wallet <code>${row.id}</code> at <code>${row.address}</code> is low on ${row.chain === "base-mainnet" ? "Base mainnet" : row.chain} ETH.</p><p>Current balance: <code>${balance.toString()} wei</code>. Threshold: <code>${threshold.toString()} wei</code>.</p><p>Top up at <code>${row.address}</code> to keep submitting contract calls.</p>`,
        text: `Low ETH balance on KMS wallet ${row.id} (${row.address}). Current: ${balance.toString()} wei. Threshold: ${threshold.toString()} wei.`,
      });

      await pool.query(
        sql(`UPDATE internal.contract_wallets SET last_alert_sent_at = NOW() WHERE id = $1`),
        [row.id],
      );
    } catch (err) {
      console.error(`[wallet-balance-alerts] failed for ${row.id}:`, err);
    }
  }
}
