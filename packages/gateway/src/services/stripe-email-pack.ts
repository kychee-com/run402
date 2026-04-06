/**
 * Stripe email pack service.
 *
 * Creates Stripe Checkout Sessions for $5 / 10,000 email packs.
 * On webhook completion, credits the pack to email_credits_remaining.
 * Packs never expire. Require a verified custom sender domain to consume
 * (see billing-email-overage.ts).
 */

import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { STRIPE_SECRET_KEY, STRIPE_PRICE_EMAIL_PACK } from "../config.js";
import { getOrCreateBillingAccount, getOrCreateBillingAccountByEmail } from "./billing.js";
import type { BillingAccount } from "./billing.js";
import type { AccountIdentifier } from "./billing-identifier.js";
import { HttpError } from "../utils/async-handler.js";

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

/**
 * One pack = 10,000 emails.
 * Price = $5 = 5,000,000 micros.
 */
export const EMAIL_PACK_SIZE = 10_000;
export const EMAIL_PACK_PRICE_USD_MICROS = 5_000_000;

async function getOrCreateStripeCustomer(
  account: BillingAccount,
  walletAddress?: string,
  email?: string,
): Promise<string> {
  if (!stripe) throw new HttpError(503, "Stripe not configured");

  const customers = await stripe.customers.search({
    query: `metadata["billing_account_id"]:"${account.id}"`,
    limit: 1,
  });
  if (customers.data.length > 0 && customers.data[0]) {
    return customers.data[0].id;
  }

  const customer = await stripe.customers.create({
    email: email || account.primary_contact_email || undefined,
    metadata: {
      billing_account_id: account.id,
      wallet_address: walletAddress || "",
    },
  });
  return customer.id;
}

/**
 * Create a Stripe Checkout Session for a $5 email pack.
 * Supports wallet + email identifiers. On payment completion (webhook),
 * the pack is credited via creditEmailPackFromTopup.
 */
export async function createEmailPackCheckout(
  identifier: AccountIdentifier,
  options?: { successUrl?: string; cancelUrl?: string },
): Promise<{ checkout_url: string; topup_id: string }> {
  if (!stripe) throw new HttpError(503, "Stripe not configured");

  if (!STRIPE_PRICE_EMAIL_PACK) {
    throw new HttpError(503, "Stripe price ID not configured for email pack");
  }

  // Resolve billing account
  let account: BillingAccount;
  let walletAddress: string | undefined;
  let emailAddress: string | undefined;

  if (identifier.type === "wallet") {
    walletAddress = identifier.value;
    account = await getOrCreateBillingAccount(identifier.value);
  } else {
    emailAddress = identifier.value;
    account = await getOrCreateBillingAccountByEmail(identifier.value);
  }

  const customerId = await getOrCreateStripeCustomer(account, walletAddress, emailAddress);

  // Create topup row
  const topupId = randomUUID();
  await pool.query(
    sql(`INSERT INTO internal.billing_topups
       (id, billing_account_id, wallet_address, status, funded_usd_micros, charged_usd_cents, terms_version, topup_type, funded_email_credits)
     VALUES ($1, $2, $3, 'initiated', 0, 500, 'v1', $4, $5)`),
    [topupId, account.id, walletAddress || null, "email_pack", EMAIL_PACK_SIZE],
  );

  const successUrl = options?.successUrl || `https://run402.com/billing?success=true&topup=${topupId}`;
  const cancelUrl = options?.cancelUrl || `https://run402.com/billing?canceled=true`;

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "payment",
    line_items: [{
      price: STRIPE_PRICE_EMAIL_PACK,
      quantity: 1,
    }],
    metadata: {
      billing_account_id: account.id,
      topup_id: topupId,
      topup_type: "email_pack",
      pack_size: String(EMAIL_PACK_SIZE),
      ...(walletAddress ? { wallet_address: walletAddress } : {}),
      ...(emailAddress ? { email_address: emailAddress } : {}),
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  // Update topup with Stripe session ID
  await pool.query(
    sql(`UPDATE internal.billing_topups SET stripe_checkout_session_id = $1 WHERE id = $2`),
    [session.id, topupId],
  );

  return { checkout_url: session.url!, topup_id: topupId };
}

/**
 * Credit an email pack from a completed Stripe topup.
 * Idempotent via topup status check.
 */
export async function creditEmailPackFromTopup(
  topupId: string,
  stripeEventId: string,
): Promise<void> {
  // Read the topup
  const topupResult = await pool.query(
    sql(`SELECT id, billing_account_id, topup_type, funded_email_credits, status FROM internal.billing_topups WHERE id = $1`),
    [topupId],
  );
  if (topupResult.rows.length === 0) {
    throw new HttpError(404, `Topup ${topupId} not found`);
  }
  const topup = topupResult.rows[0] as {
    id: string;
    billing_account_id: string;
    topup_type: string;
    funded_email_credits: number;
    status: string | null;
  };

  if (topup.topup_type !== "email_pack") {
    throw new HttpError(400, `Topup ${topupId} has topup_type=${topup.topup_type}, expected 'email_pack'`);
  }

  // Idempotency: already credited
  if (topup.status === "credited") {
    return;
  }

  const creditsToAdd = Number(topup.funded_email_credits || EMAIL_PACK_SIZE);

  // Credit the pack in a transaction
  const client = await pool.connect();
  try {
    await client.query(sql("BEGIN"));

    // Lock and read current balance
    const locked = await client.query(
      sql(`SELECT email_credits_remaining, available_usd_micros, held_usd_micros FROM internal.billing_accounts WHERE id = $1 FOR UPDATE`),
      [topup.billing_account_id],
    );
    if (locked.rows.length === 0) {
      throw new HttpError(404, `Billing account ${topup.billing_account_id} not found`);
    }
    const currentCredits = Number(locked.rows[0].email_credits_remaining || 0);
    const newCredits = currentCredits + creditsToAdd;
    const availableMicros = Number(locked.rows[0].available_usd_micros);
    const heldMicros = Number(locked.rows[0].held_usd_micros);

    // Update pack credits
    await client.query(
      sql(`UPDATE internal.billing_accounts SET email_credits_remaining = $1, updated_at = NOW() WHERE id = $2`),
      [newCredits, topup.billing_account_id],
    );

    // Ledger entry — cash-denominated ($5 = 5_000_000 micros) with pack credits in metadata (DD-5)
    await client.query(
      sql(`INSERT INTO internal.allowance_ledger
       (id, billing_account_id, direction, kind, amount_usd_micros,
        balance_after_available, balance_after_held,
        reference_type, reference_id, idempotency_key, metadata)
       VALUES ($1, $2, 'credit', $3, $4, $5, $6, 'topup', $7, $8, $9)`),
      [
        randomUUID(), topup.billing_account_id, "email_pack_purchase",
        EMAIL_PACK_PRICE_USD_MICROS, availableMicros, heldMicros,
        topupId, stripeEventId,
        JSON.stringify({
          topup_id: topupId,
          email_credits_added: creditsToAdd,
          pack_size: EMAIL_PACK_SIZE,
          stripe_event_id: stripeEventId,
        }),
      ],
    );

    // Mark topup as credited
    await client.query(
      sql(`UPDATE internal.billing_topups SET status = $1, credited_at = NOW() WHERE id = $2`),
      ["credited", topupId],
    );

    await client.query(sql("COMMIT"));
  } catch (err) {
    try { await client.query(sql("ROLLBACK")); } catch { /* connection may be dead */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* may already be released */ }
  }
}
