/**
 * Stripe tier checkout service.
 *
 * Creates Stripe Checkout Sessions for tier subscription/renew/upgrade.
 * Supports both wallet and email identifiers. The actual tier application
 * happens in the webhook handler (see stripe-billing.ts handleStripeWebhookEvent)
 * when the session completes.
 */

import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import {
  STRIPE_SECRET_KEY,
  STRIPE_PRICE_PROTOTYPE,
  STRIPE_PRICE_HOBBY,
  STRIPE_PRICE_TEAM,
} from "../config.js";
import { getOrCreateBillingAccount, getOrCreateBillingAccountByEmail } from "./billing.js";
import type { BillingAccount } from "./billing.js";
import type { AccountIdentifier } from "./billing-identifier.js";
import { HttpError } from "../utils/async-handler.js";

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

type TierName = "prototype" | "hobby" | "team";

const TIER_PRICE_IDS: Record<TierName, string> = {
  prototype: STRIPE_PRICE_PROTOTYPE,
  hobby: STRIPE_PRICE_HOBBY,
  team: STRIPE_PRICE_TEAM,
};

const VALID_TIERS: TierName[] = ["prototype", "hobby", "team"];

function isValidTier(tier: string): tier is TierName {
  return (VALID_TIERS as string[]).includes(tier);
}

/**
 * Get or create a Stripe customer for a billing account.
 * Searches by billing_account_id in metadata; creates if not found.
 */
async function getOrCreateStripeCustomer(
  account: BillingAccount,
  walletAddress?: string,
  email?: string,
): Promise<string> {
  if (!stripe) throw new HttpError(503, "Stripe not configured");

  // Search by metadata
  const customers = await stripe.customers.search({
    query: `metadata["billing_account_id"]:"${account.id}"`,
    limit: 1,
  });
  if (customers.data.length > 0 && customers.data[0]) {
    return customers.data[0].id;
  }

  // Create new customer
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
 * Create a Stripe Checkout Session for a tier subscription.
 * Supports wallet or email identifiers. On payment completion (webhook),
 * the tier is applied via setTierForAccount.
 */
export async function createTierCheckout(
  identifier: AccountIdentifier,
  tier: string,
  options?: { successUrl?: string; cancelUrl?: string },
): Promise<{ checkout_url: string; topup_id: string }> {
  if (!stripe) throw new HttpError(503, "Stripe not configured");

  if (!isValidTier(tier)) {
    throw new HttpError(400, `Invalid tier: ${tier}. Must be one of: ${VALID_TIERS.join(", ")}`);
  }

  const priceId = TIER_PRICE_IDS[tier];
  if (!priceId) {
    throw new HttpError(503, `Stripe price ID not configured for tier: ${tier}`);
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

  // Get or create Stripe customer
  const customerId = await getOrCreateStripeCustomer(account, walletAddress, emailAddress);

  // Create topup row with topup_type='tier'
  const topupId = randomUUID();
  await pool.query(
    sql(`INSERT INTO internal.billing_topups
       (id, billing_account_id, wallet_address, status, funded_usd_micros, charged_usd_cents, terms_version, topup_type, tier_name)
     VALUES ($1, $2, $3, 'initiated', 0, 0, 'v1', 'tier', $4)`),
    [topupId, account.id, walletAddress || null, tier],
  );

  // Create Stripe Checkout Session
  const successUrl = options?.successUrl || `https://run402.com/billing?success=true&topup=${topupId}`;
  const cancelUrl = options?.cancelUrl || `https://run402.com/billing?canceled=true`;

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "payment",
    line_items: [{
      price: priceId,
      quantity: 1,
    }],
    metadata: {
      billing_account_id: account.id,
      topup_id: topupId,
      topup_type: "tier",
      tier_name: tier,
      terms_version: "v1",
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
