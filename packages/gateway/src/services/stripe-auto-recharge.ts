/**
 * Stripe auto-recharge for email packs.
 *
 * When an email send consumes a credit and drops below the threshold,
 * this service can be triggered (fire-and-forget) to charge the saved
 * Stripe payment method off-session for another $5 pack.
 *
 * - 3 consecutive failures disables auto-recharge automatically.
 * - Requires a Stripe customer with a default payment method saved.
 */

import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { STRIPE_SECRET_KEY } from "../config.js";

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const PACK_SIZE = 10_000;
const PACK_PRICE_CENTS = 500;
const PACK_PRICE_USD_MICROS = 5_000_000;
const MAX_FAILURES = 3;

export interface AutoRechargeResult {
  success: boolean;
  reason?: string;
}

/**
 * Enable or disable auto-recharge for a billing account.
 */
export async function setAutoRecharge(
  billingAccountId: string,
  enabled: boolean,
  threshold?: number,
): Promise<void> {
  if (threshold !== undefined) {
    await pool.query(
      sql(`UPDATE internal.billing_accounts
       SET auto_recharge_enabled = $1, auto_recharge_threshold = $2, auto_recharge_failure_count = 0, updated_at = NOW()
       WHERE id = $3`),
      [enabled, threshold, billingAccountId],
    );
  } else {
    await pool.query(
      sql(`UPDATE internal.billing_accounts
       SET auto_recharge_enabled = $1, auto_recharge_failure_count = 0, updated_at = NOW()
       WHERE id = $2`),
      [enabled, billingAccountId],
    );
  }
}

/**
 * Trigger an off-session Stripe charge for a $5 email pack.
 * Updates failure count on decline. After MAX_FAILURES, disables auto-recharge.
 * Fire-and-forget style — caller should not await or rely on return value for latency-critical paths.
 */
export async function triggerAutoRecharge(billingAccountId: string): Promise<AutoRechargeResult> {
  if (!stripe) {
    return { success: false, reason: "stripe_not_configured" };
  }

  // Read account state
  const accountResult = await pool.query(
    sql(`SELECT id, stripe_customer_id, auto_recharge_failure_count FROM internal.billing_accounts WHERE id = $1`),
    [billingAccountId],
  );
  if (accountResult.rows.length === 0) {
    return { success: false, reason: "account_not_found" };
  }

  const account = accountResult.rows[0] as {
    id: string;
    stripe_customer_id: string | null;
    auto_recharge_failure_count: number;
  };

  if (!account.stripe_customer_id) {
    return { success: false, reason: "no_stripe_customer" };
  }

  const currentFailures = Number(account.auto_recharge_failure_count || 0);

  try {
    // Off-session charge using default payment method on the Stripe customer
    const pi = await stripe.paymentIntents.create({
      amount: PACK_PRICE_CENTS,
      currency: "usd",
      customer: account.stripe_customer_id,
      confirm: true,
      off_session: true,
      metadata: {
        billing_account_id: billingAccountId,
        topup_type: "email_pack",
        auto_recharge: "true",
      },
    });

    if (pi.status !== "succeeded") {
      throw new Error(`PaymentIntent status: ${pi.status}`);
    }

    // Success — create a topup record + credit pack in a transaction
    const topupId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query(sql("BEGIN"));

      await client.query(
        sql(`INSERT INTO internal.billing_topups
           (id, billing_account_id, wallet_address, status, funded_usd_micros, charged_usd_cents, terms_version, topup_type, funded_email_credits, stripe_payment_intent_id, paid_at, credited_at)
         VALUES ($1, $2, NULL, 'credited', 0, $3, 'v1', 'email_pack', $4, $5, NOW(), NOW())`),
        [topupId, billingAccountId, PACK_PRICE_CENTS, PACK_SIZE, pi.id],
      );

      // Lock account row and increment credits
      const locked = await client.query(
        sql(`SELECT email_credits_remaining, available_usd_micros, held_usd_micros FROM internal.billing_accounts WHERE id = $1 FOR UPDATE`),
        [billingAccountId],
      );
      const currentCredits = Number(locked.rows[0].email_credits_remaining || 0);
      const availableMicros = Number(locked.rows[0].available_usd_micros);
      const heldMicros = Number(locked.rows[0].held_usd_micros);
      const newCredits = currentCredits + PACK_SIZE;

      await client.query(
        sql(`UPDATE internal.billing_accounts
         SET email_credits_remaining = $1, auto_recharge_failure_count = 0, updated_at = NOW()
         WHERE id = $2`),
        [newCredits, billingAccountId],
      );

      // Ledger entry — kind='email_pack_auto_recharge' to distinguish from manual purchase
      await client.query(
        sql(`INSERT INTO internal.allowance_ledger
         (id, billing_account_id, direction, kind, amount_usd_micros,
          balance_after_available, balance_after_held,
          reference_type, reference_id, idempotency_key, metadata)
         VALUES ($1, $2, 'credit', 'email_pack_auto_recharge', $3, $4, $5, 'topup', $6, $7, $8)`),
        [
          randomUUID(), billingAccountId,
          PACK_PRICE_USD_MICROS, availableMicros, heldMicros,
          topupId, `autorecharge_${topupId}`,
          JSON.stringify({
            topup_id: topupId,
            email_credits_added: PACK_SIZE,
            stripe_payment_intent_id: pi.id,
            trigger: "auto_recharge",
          }),
        ],
      );

      await client.query(sql("COMMIT"));
    } catch (err) {
      try { await client.query(sql("ROLLBACK")); } catch { /* connection may be dead */ }
      throw err;
    } finally {
      try { client.release(); } catch { /* may already be released */ }
    }

    return { success: true };
  } catch (err: unknown) {
    // Failure path — increment counter, disable after 3 failures
    const newFailureCount = currentFailures + 1;
    if (newFailureCount >= MAX_FAILURES) {
      await pool.query(
        sql(`UPDATE internal.billing_accounts
         SET auto_recharge_enabled = $1, auto_recharge_failure_count = $2, updated_at = NOW()
         WHERE id = $3`),
        [false, newFailureCount, billingAccountId],
      );
      console.error(`  Auto-recharge disabled for account ${billingAccountId} after ${newFailureCount} failures`);
    } else {
      await pool.query(
        sql(`UPDATE internal.billing_accounts
         SET auto_recharge_failure_count = $1, updated_at = NOW()
         WHERE id = $2`),
        [newFailureCount, billingAccountId],
      );
    }

    const reason = err instanceof Error ? err.message : "unknown_error";
    console.error(`  Auto-recharge failed for account ${billingAccountId}: ${reason}`);
    return { success: false, reason };
  }
}
