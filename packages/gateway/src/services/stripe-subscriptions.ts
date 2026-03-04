import Stripe from "stripe";
import { STRIPE_SECRET_KEY } from "../config.js";
import type { TierName } from "@run402/shared";
import { errorMessage } from "../utils/errors.js";

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

export interface WalletSubscription {
  tier: TierName;
  status: string;
  currentPeriodEnd: Date;
  customerId: string;
}

// In-memory cache with 5-min TTL
const subCache = new Map<string, { data: WalletSubscription | null; cachedAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Query Stripe for the active subscription of a wallet address.
 * Looks up customer by metadata["wallet_address"].
 */
export async function getWalletSubscription(wallet: string): Promise<WalletSubscription | null> {
  if (!stripe) return null;
  const normalized = wallet.toLowerCase();

  // Check cache
  const cached = subCache.get(normalized);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    return cached.data;
  }

  try {
    const customers = await stripe.customers.search({
      query: `metadata["wallet_address"]:"${normalized}"`,
      limit: 1,
    });

    if (customers.data.length === 0) {
      subCache.set(normalized, { data: null, cachedAt: Date.now() });
      return null;
    }

    const customer = customers.data[0];
    if (!customer) {
      subCache.set(normalized, { data: null, cachedAt: Date.now() });
      return null;
    }
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: "active",
      limit: 1,
    });

    const sub = subscriptions.data[0];
    if (!sub) {
      subCache.set(normalized, { data: null, cachedAt: Date.now() });
      return null;
    }

    const item = sub.items.data[0];
    if (!item) {
      subCache.set(normalized, { data: null, cachedAt: Date.now() });
      return null;
    }
    const product = await stripe.products.retrieve(item.price.product as string);
    const tier = (product.metadata["run402_tier"] || "hobby") as TierName;

    // In Stripe SDK v20+, current_period_end is on the subscription item, not the subscription
    const periodEnd = (item as unknown as { current_period_end: number }).current_period_end;

    const result: WalletSubscription = {
      tier,
      status: sub.status,
      currentPeriodEnd: new Date(periodEnd * 1000),
      customerId: customer.id,
    };

    subCache.set(normalized, { data: result, cachedAt: Date.now() });
    return result;
  } catch (err: unknown) {
    console.error("Stripe subscription lookup failed:", errorMessage(err));
    return null;
  }
}

/**
 * Synchronous cache read for the metering hot path.
 * Returns undefined on cache miss (caller falls back to per-project enforcement).
 */
export function getWalletSubscriptionCached(wallet: string): WalletSubscription | null | undefined {
  const normalized = wallet.toLowerCase();
  const cached = subCache.get(normalized);
  if (!cached || Date.now() - cached.cachedAt >= CACHE_TTL) return undefined;
  return cached.data;
}

/**
 * Create a Stripe Checkout Session for a wallet.
 */
export async function createStripeCheckout(
  wallet: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  if (!stripe) throw new Error("Stripe not configured");
  const normalized = wallet.toLowerCase();

  // Check if already subscribed
  const existing = await getWalletSubscription(normalized);
  if (existing?.status === "active") {
    throw new Error("Wallet already has an active subscription");
  }

  // Find or create customer
  let customerId: string;
  const customers = await stripe.customers.search({
    query: `metadata["wallet_address"]:"${normalized}"`,
    limit: 1,
  });

  if (customers.data.length > 0 && customers.data[0]) {
    customerId = customers.data[0].id;
  } else {
    const customer = await stripe.customers.create({
      metadata: { wallet_address: normalized },
    });
    customerId = customer.id;
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: normalized,
  });

  return session.url!;
}

/**
 * Create a Stripe Customer Portal session for a wallet.
 */
export async function createStripePortal(wallet: string, returnUrl: string): Promise<string> {
  if (!stripe) throw new Error("Stripe not configured");
  const normalized = wallet.toLowerCase();

  const customers = await stripe.customers.search({
    query: `metadata["wallet_address"]:"${normalized}"`,
    limit: 1,
  });

  if (customers.data.length === 0) {
    throw new Error("No Stripe customer found for this wallet");
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customers.data[0]!.id, // guarded by length === 0 check above
    return_url: returnUrl,
  });

  return session.url;
}

/**
 * List active Stripe products with run402_tier metadata and their prices.
 */
export async function getProducts(): Promise<Array<{
  id: string;
  name: string;
  tier: string;
  description: string | null;
  prices: Array<{
    id: string;
    unit_amount: number;
    currency: string;
    interval: string;
  }>;
}>> {
  if (!stripe) return [];

  const products = await stripe.products.list({ active: true, limit: 100 });
  const run402Products = products.data.filter((p) => p.metadata["run402_tier"]);

  const result = [];
  for (const product of run402Products) {
    const prices = await stripe.prices.list({ product: product.id, active: true, limit: 10 });
    result.push({
      id: product.id,
      name: product.name,
      tier: product.metadata["run402_tier"]!,
      description: product.description,
      prices: prices.data.map((p) => ({
        id: p.id,
        unit_amount: p.unit_amount || 0,
        currency: p.currency,
        interval: p.recurring?.interval || "month",
      })),
    });
  }

  return result;
}

/**
 * Clear subscription cache for one or all wallets.
 */
export function clearSubscriptionCache(wallet?: string): void {
  if (wallet) {
    subCache.delete(wallet.toLowerCase());
  } else {
    subCache.clear();
  }
}
