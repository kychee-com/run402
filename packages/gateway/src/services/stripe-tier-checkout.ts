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

// TIER pricing (usd micros) — duplicated here to avoid circular dep with shared
const TIER_PRICE_MICROS: Record<TierName, number> = {
  prototype: 100_000,
  hobby: 5_000_000,
  team: 20_000_000,
};
const TIER_LEASE_DAYS: Record<TierName, number> = {
  prototype: 7,
  hobby: 30,
  team: 30,
};
const TIER_ORDER: TierName[] = ["prototype", "hobby", "team"];

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

// ---------------------------------------------------------------------------
// applyTierFromTopup — webhook handler calls this on checkout.session.completed
// ---------------------------------------------------------------------------

export type TierAction = "subscribe" | "renew" | "upgrade" | "downgrade" | "noop";

export interface ApplyTierResult {
  action: TierAction;
  tier: TierName | null;
  billing_account_id: string;
}

/**
 * Apply a tier from a completed Stripe topup.
 * Idempotent — if the topup is already 'credited', returns { action: 'noop' }.
 * Called by handleStripeWebhookEvent when topup_type='tier'.
 */
export async function applyTierFromTopup(topupId: string): Promise<ApplyTierResult> {
  // Read the topup
  const topupResult = await pool.query(
    sql(`SELECT id, billing_account_id, tier_name, topup_type, status FROM internal.billing_topups WHERE id = $1`),
    [topupId],
  );
  if (topupResult.rows.length === 0) {
    throw new HttpError(404, `Topup ${topupId} not found`);
  }
  const topup = topupResult.rows[0] as {
    id: string;
    billing_account_id: string;
    tier_name: string | null;
    topup_type: string;
    status: string | null;
  };

  if (topup.topup_type !== "tier") {
    throw new HttpError(400, `Topup ${topupId} has topup_type=${topup.topup_type}, expected 'tier'`);
  }
  if (!topup.tier_name || !isValidTier(topup.tier_name)) {
    throw new HttpError(400, `Topup ${topupId} has invalid tier_name: ${topup.tier_name}`);
  }

  // Idempotency: if already credited, noop
  if (topup.status === "credited") {
    return { action: "noop", tier: topup.tier_name, billing_account_id: topup.billing_account_id };
  }

  const newTier = topup.tier_name;
  const newTierLeaseDays = TIER_LEASE_DAYS[newTier];

  // Read current account state
  const accountResult = await pool.query(
    sql(`SELECT id, tier, lease_started_at, lease_expires_at, available_usd_micros, held_usd_micros FROM internal.billing_accounts WHERE id = $1`),
    [topup.billing_account_id],
  );
  if (accountResult.rows.length === 0) {
    throw new HttpError(404, `Billing account ${topup.billing_account_id} not found`);
  }
  const account = accountResult.rows[0] as {
    id: string;
    tier: string | null;
    lease_started_at: string | null;
    lease_expires_at: string | null;
    available_usd_micros: string;
    held_usd_micros: string;
  };

  const now = new Date();
  const currentTier = account.tier as TierName | null;
  const leaseExpiresAt = account.lease_expires_at ? new Date(account.lease_expires_at) : null;
  const isActive = currentTier !== null && leaseExpiresAt !== null && leaseExpiresAt.getTime() > now.getTime();

  // Determine action
  let action: TierAction;
  let newLeaseStart: Date;
  let newLeaseExpires: Date;
  let refundMicros = 0;

  if (!isActive || !currentTier) {
    // Fresh subscribe
    action = "subscribe";
    newLeaseStart = now;
    newLeaseExpires = new Date(now.getTime() + newTierLeaseDays * 24 * 60 * 60 * 1000);
  } else if (currentTier === newTier) {
    // Renew — extend lease from current expiry
    action = "renew";
    newLeaseStart = account.lease_started_at ? new Date(account.lease_started_at) : now;
    newLeaseExpires = new Date(leaseExpiresAt!.getTime() + newTierLeaseDays * 24 * 60 * 60 * 1000);
  } else {
    // Upgrade or downgrade — prorated refund + new lease
    const currentIdx = TIER_ORDER.indexOf(currentTier);
    const newIdx = TIER_ORDER.indexOf(newTier);
    action = newIdx > currentIdx ? "upgrade" : "downgrade";
    newLeaseStart = now;
    newLeaseExpires = new Date(now.getTime() + newTierLeaseDays * 24 * 60 * 60 * 1000);

    // Prorated refund of remaining old tier time
    if (account.lease_started_at && leaseExpiresAt) {
      const leaseStart = new Date(account.lease_started_at);
      const totalMs = leaseExpiresAt.getTime() - leaseStart.getTime();
      const remainingMs = Math.max(0, leaseExpiresAt.getTime() - now.getTime());
      const oldPrice = TIER_PRICE_MICROS[currentTier];
      if (totalMs > 0 && oldPrice > 0) {
        refundMicros = Math.floor((remainingMs / totalMs) * oldPrice);
      }
    }
  }

  // Apply the change in a transaction
  const client = await pool.connect();
  try {
    await client.query(sql("BEGIN"));

    // Lock the account
    const locked = await client.query(
      sql(`SELECT available_usd_micros, held_usd_micros FROM internal.billing_accounts WHERE id = $1 FOR UPDATE`),
      [account.id],
    );
    const currentAvailable = Number(locked.rows[0].available_usd_micros);
    const currentHeld = Number(locked.rows[0].held_usd_micros);
    const newAvailable = currentAvailable + refundMicros;

    // Refund ledger entry (if any)
    if (refundMicros > 0) {
      await client.query(
        sql(`INSERT INTO internal.allowance_ledger
         (id, billing_account_id, direction, kind, amount_usd_micros,
          balance_after_available, balance_after_held,
          reference_type, reference_id, idempotency_key, metadata)
         VALUES ($1, $2, 'credit', 'tier_upgrade_refund', $3, $4, $5, 'tier', $6, $7, $8)`),
        [
          randomUUID(), account.id,
          refundMicros, newAvailable, currentHeld,
          `${currentTier}_to_${newTier}`, `${topupId}_refund`,
          JSON.stringify({ old_tier: currentTier, new_tier: newTier, refund_micros: refundMicros, topup_id: topupId }),
        ],
      );
    }

    // Update tier, lease, available balance
    await client.query(
      sql(`UPDATE internal.billing_accounts
       SET tier = $1, lease_started_at = $2, lease_expires_at = $3,
           available_usd_micros = $4, updated_at = NOW()
       WHERE id = $5`),
      [newTier, newLeaseStart, newLeaseExpires, newAvailable, account.id],
    );

    // Ledger entry for the tier action
    const ledgerKind = action === "subscribe" ? "tier_subscribe"
      : action === "renew" ? "tier_renew"
      : action === "upgrade" ? "tier_upgrade"
      : "tier_upgrade"; // downgrade also uses tier_upgrade to match existing ledger kinds
    await client.query(
      sql(`INSERT INTO internal.allowance_ledger
       (id, billing_account_id, direction, kind, amount_usd_micros,
        balance_after_available, balance_after_held,
        reference_type, reference_id, idempotency_key, metadata)
       VALUES ($1, $2, 'debit', $3, 0, $4, $5, 'tier', $6, $7, $8)`),
      [
        randomUUID(), account.id, ledgerKind,
        newAvailable, currentHeld,
        newTier, topupId,
        JSON.stringify({ action, old_tier: currentTier, new_tier: newTier, topup_id: topupId }),
      ],
    );

    // Mark topup as credited (idempotency guard for future calls)
    await client.query(
      sql(`UPDATE internal.billing_topups SET status = 'credited', credited_at = NOW() WHERE id = $1`),
      [topupId],
    );

    await client.query(sql("COMMIT"));
  } catch (err) {
    try { await client.query(sql("ROLLBACK")); } catch { /* connection may be dead */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* may already be released */ }
  }

  return { action, tier: newTier, billing_account_id: account.id };
}
