/**
 * Billing email overage service.
 *
 * When a project exceeds its tier's daily email limit, this service decides
 * whether the send can proceed using an email pack credit.
 *
 * Rules:
 * - Project MUST have a verified custom sender domain (spam protection for
 *   mail.run402.com shared reputation).
 * - Project's billing account (via wallet) MUST have email_credits_remaining > 0.
 * - Decrement is atomic via SELECT ... FOR UPDATE (no negative balance under
 *   concurrency).
 *
 * Called by email-send.ts when tier limit is exhausted.
 */

import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { getVerifiedSenderDomain } from "./email-domains.js";

export type TryConsumeResult =
  | { allowed: true; remaining: number }
  | { allowed: false; reason: "no_custom_domain" | "no_billing_account" | "no_credits" };

/**
 * Try to consume one email pack credit for the given project.
 * Returns { allowed: true, remaining } on success, or { allowed: false, reason } otherwise.
 */
export async function tryConsumePackCredit(projectId: string): Promise<TryConsumeResult> {
  // 1. Must have verified custom sender domain (reputation protection)
  const customDomain = await getVerifiedSenderDomain(projectId);
  if (!customDomain) {
    return { allowed: false, reason: "no_custom_domain" };
  }

  // 2. Look up project's wallet to find billing account
  const projectResult = await pool.query(
    sql(`SELECT wallet_address FROM internal.projects WHERE id = $1`),
    [projectId],
  );
  if (projectResult.rows.length === 0 || !projectResult.rows[0].wallet_address) {
    return { allowed: false, reason: "no_billing_account" };
  }
  const wallet = (projectResult.rows[0].wallet_address as string).toLowerCase();

  // 3. Find billing account for that wallet
  const accountResult = await pool.query(
    sql(`SELECT billing_account_id, ba.email_credits_remaining
         FROM internal.billing_account_wallets baw
         JOIN internal.billing_accounts ba ON ba.id = baw.billing_account_id
         WHERE baw.wallet_address = $1`),
    [wallet],
  );
  if (accountResult.rows.length === 0) {
    return { allowed: false, reason: "no_billing_account" };
  }
  const billingAccountId = accountResult.rows[0].billing_account_id as string;
  const currentCredits = Number(accountResult.rows[0].email_credits_remaining || 0);
  if (currentCredits <= 0) {
    return { allowed: false, reason: "no_credits" };
  }

  // 4. Atomic decrement with SELECT FOR UPDATE (race protection)
  const client = await pool.connect();
  try {
    await client.query(sql("BEGIN"));

    const locked = await client.query(
      sql(`SELECT email_credits_remaining FROM internal.billing_accounts WHERE id = $1 FOR UPDATE`),
      [billingAccountId],
    );
    if (locked.rows.length === 0) {
      await client.query(sql("ROLLBACK"));
      return { allowed: false, reason: "no_billing_account" };
    }
    const lockedCredits = Number(locked.rows[0].email_credits_remaining || 0);
    if (lockedCredits <= 0) {
      // Race — another concurrent send took the last credit
      await client.query(sql("ROLLBACK"));
      return { allowed: false, reason: "no_credits" };
    }

    const newCredits = lockedCredits - 1;
    await client.query(
      sql(`UPDATE internal.billing_accounts SET email_credits_remaining = $1, updated_at = NOW() WHERE id = $2`),
      [newCredits, billingAccountId],
    );

    await client.query(sql("COMMIT"));

    return { allowed: true, remaining: newCredits };
  } catch (err) {
    try { await client.query(sql("ROLLBACK")); } catch { /* connection may be dead */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* may already be released */ }
  }
}
