/**
 * Stripe billing service — Checkout Sessions + webhook handling for allowance top-ups.
 */

import Stripe from "stripe";
import { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_WEBHOOK_SECRET_LIVE } from "../config.js";
import { getOrCreateBillingAccount, creditFromTopup } from "./billing.js";
import { applyTierFromTopup } from "./stripe-tier-checkout.js";
import { creditEmailPackFromTopup } from "./stripe-email-pack.js";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { randomUUID } from "node:crypto";
import { errorMessage } from "../utils/errors.js";

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

/**
 * Create a Stripe Checkout Session for topping up allowance.
 */
export async function createAllowanceCheckout(
  wallet: string,
  amountUsdMicros: number,
  successUrl?: string,
  cancelUrl?: string,
  email?: string,
): Promise<{ checkout_url: string; topup_id: string }> {
  if (!stripe) throw new Error("Stripe not configured");
  const normalized = wallet.toLowerCase();

  // Ensure billing account exists
  const account = await getOrCreateBillingAccount(normalized);

  // Find or create Stripe customer
  const customerId = await getOrCreateStripeCustomer(account.id, normalized, email);

  // Create topup record
  const topupId = randomUUID();
  const amountInCents = Math.round(amountUsdMicros / 10_000); // micros to cents: 1_000_000 micros = 100 cents

  await pool.query(
    sql(`INSERT INTO internal.billing_topups (id, billing_account_id, wallet_address, status, funded_usd_micros, charged_usd_cents, terms_version)
     VALUES ($1, $2, $3, 'initiated', $4, $5, 'v1')`),
    [topupId, account.id, normalized, amountUsdMicros, amountInCents],
  );

  const defaultSuccess = `https://run402.com/billing?wallet=${encodeURIComponent(normalized)}&success=true`;
  const defaultCancel = `https://run402.com/billing?wallet=${encodeURIComponent(normalized)}`;

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "payment",
    line_items: [{
      price_data: {
        currency: "usd",
        unit_amount: amountInCents,
        product_data: {
          name: "Run402 Allowance Top-Up",
          description: `$${(amountInCents / 100).toFixed(2)} allowance credit`,
        },
      },
      quantity: 1,
    }],
    metadata: {
      billing_account_id: account.id,
      wallet_address: normalized,
      topup_id: topupId,
      terms_version: "v1",
    },
    success_url: successUrl || defaultSuccess,
    cancel_url: cancelUrl || defaultCancel,
    client_reference_id: normalized,
  });

  // Update topup with Stripe session ID
  await pool.query(
    sql(`UPDATE internal.billing_topups SET stripe_checkout_session_id = $1 WHERE id = $2`),
    [session.id, topupId],
  );

  return { checkout_url: session.url!, topup_id: topupId };
}

/**
 * Handle a Stripe webhook event.
 * Returns true if the event was processed, false if ignored.
 */
export async function handleStripeWebhookEvent(rawBody: Buffer, signature: string): Promise<boolean> {
  if (!stripe) throw new Error("Stripe not configured");

  const secrets = [STRIPE_WEBHOOK_SECRET, STRIPE_WEBHOOK_SECRET_LIVE].filter(Boolean);
  if (secrets.length === 0) throw new Error("No STRIPE_WEBHOOK_SECRET configured");

  // Try each webhook secret (test + live) until one verifies
  let event: Stripe.Event | undefined;
  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, secret);
      break;
    } catch {
      continue;
    }
  }
  if (!event) {
    throw new Error("Webhook signature verification failed: no matching secret");
  }

  // Idempotent: check if already processed
  const existing = await pool.query(
    sql(`SELECT stripe_event_id FROM internal.stripe_webhook_events WHERE stripe_event_id = $1`),
    [event.id],
  );
  if (existing.rows.length > 0) {
    return false; // Already processed
  }

  // Record the event
  await pool.query(
    sql(`INSERT INTO internal.stripe_webhook_events (stripe_event_id, type, livemode, payload, received_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (stripe_event_id) DO NOTHING`),
    [event.id, event.type, event.livemode, JSON.stringify(event.data)],
  );

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      if (session.payment_status !== "paid") {
        return false;
      }

      const topupId = session.metadata?.topup_id;
      if (!topupId) {
        console.warn(`Stripe webhook: checkout.session.completed without topup_id metadata: ${session.id}`);
        return false;
      }

      // Update topup with payment info
      await pool.query(
        sql(`UPDATE internal.billing_topups SET
           status = 'paid',
           stripe_payment_intent_id = $1,
           payer_email = $2,
           livemode = $3,
           paid_at = NOW()
         WHERE id = $4 AND status = 'initiated'`),
        [
          session.payment_intent as string,
          session.customer_details?.email || null,
          event.livemode,
          topupId,
        ],
      );

      // Branch on topup_type to decide how to apply the payment
      const topupType = session.metadata?.topup_type || "cash";
      if (topupType === "tier") {
        const result = await applyTierFromTopup(topupId);
        console.log(`Stripe webhook: applied tier ${result.tier} (${result.action}) from topup ${topupId}`);
      } else if (topupType === "email_pack") {
        await creditEmailPackFromTopup(topupId, event.id);
        console.log(`Stripe webhook: credited email pack from topup ${topupId}`);
      } else {
        await creditFromTopup(topupId, event.id);
        console.log(`Stripe webhook: credited topup ${topupId} from session ${session.id}`);
      }
    }

    // Mark event as processed
    await pool.query(
      sql(`UPDATE internal.stripe_webhook_events SET processed_at = NOW() WHERE stripe_event_id = $1`),
      [event.id],
    );

    return true;
  } catch (err) {
    // Record processing error
    await pool.query(
      sql(`UPDATE internal.stripe_webhook_events SET processing_error = $1 WHERE stripe_event_id = $2`),
      [errorMessage(err), event.id],
    );
    throw err;
  }
}

/**
 * Get or create a Stripe customer for a billing account.
 */
async function getOrCreateStripeCustomer(billingAccountId: string, wallet: string, email?: string): Promise<string> {
  if (!stripe) throw new Error("Stripe not configured");

  // Search by metadata
  const customers = await stripe.customers.search({
    query: `metadata["billing_account_id"]:"${billingAccountId}"`,
    limit: 1,
  });

  if (customers.data.length > 0 && customers.data[0]) {
    return customers.data[0].id;
  }

  // Create new customer
  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: {
      billing_account_id: billingAccountId,
      wallet_address: wallet,
    },
  });

  return customer.id;
}
