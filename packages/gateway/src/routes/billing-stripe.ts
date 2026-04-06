/**
 * Stripe billing routes — checkout + webhook.
 *
 * POST /billing/v1/checkouts      — create Stripe Checkout session for allowance top-up
 * POST /webhooks/v1/stripe        — Stripe webhook handler (signature-verified)
 */

import { Router, Request, Response } from "express";
import { createAllowanceCheckout, handleStripeWebhookEvent } from "../services/stripe-billing.js";
import { createTierCheckout } from "../services/stripe-tier-checkout.js";
import { createEmailPackCheckout } from "../services/stripe-email-pack.js";
import { setAutoRecharge } from "../services/stripe-auto-recharge.js";
import { resolveAccountIdentifier } from "../services/billing-identifier.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { errorMessage } from "../utils/errors.js";
import { STRIPE_SECRET_KEY } from "../config.js";

const router = Router();

// POST /billing/v1/checkouts — create Stripe Checkout for allowance top-up (wallet OR email)
router.post("/billing/v1/checkouts", asyncHandler(async (req: Request, res: Response) => {
  if (!STRIPE_SECRET_KEY) {
    throw new HttpError(503, "Stripe not configured");
  }

  const { wallet, email, amount_usd_micros, success_url, cancel_url } = req.body || {};

  if (!wallet && !email) {
    throw new HttpError(400, "wallet or email is required");
  }
  if (!amount_usd_micros || typeof amount_usd_micros !== "number" || amount_usd_micros <= 0) {
    throw new HttpError(400, "amount_usd_micros must be a positive number");
  }

  // Backward-compat: if wallet provided, use existing wallet-based checkout
  // (createAllowanceCheckout). If only email, this is a new email-based allowance
  // top-up — not wired yet in stripe-billing.ts, so use tier/pack endpoints for now.
  if (wallet && typeof wallet === "string" && wallet.startsWith("0x")) {
    const result = await createAllowanceCheckout(wallet, amount_usd_micros, success_url, cancel_url, email);
    res.json(result);
    return;
  }

  // Email-only cash top-up not yet supported — direct users to tier or pack checkout
  throw new HttpError(400, "Email-based allowance top-up not yet supported. Use /billing/v1/tiers/:tier/checkout or /billing/v1/email-packs/checkout for email accounts.");
}));

// POST /billing/v1/tiers/:tier/checkout — Stripe tier subscription checkout
router.post("/billing/v1/tiers/:tier/checkout", asyncHandler(async (req: Request, res: Response) => {
  if (!STRIPE_SECRET_KEY) {
    throw new HttpError(503, "Stripe not configured");
  }
  const tierRaw = req.params["tier"];
  if (!tierRaw || typeof tierRaw !== "string") {
    throw new HttpError(400, "tier required in URL");
  }
  const tier: string = tierRaw;
  const { wallet, email, success_url, cancel_url } = req.body || {};
  if (!wallet && !email) {
    throw new HttpError(400, "wallet or email is required");
  }
  const rawId = typeof wallet === "string" ? wallet : typeof email === "string" ? email : "";
  const identifier = resolveAccountIdentifier(rawId);
  const result = await createTierCheckout(identifier, tier, { successUrl: success_url, cancelUrl: cancel_url });
  res.json(result);
}));

// POST /billing/v1/email-packs/checkout — Stripe email pack checkout ($5 = 10k emails)
router.post("/billing/v1/email-packs/checkout", asyncHandler(async (req: Request, res: Response) => {
  if (!STRIPE_SECRET_KEY) {
    throw new HttpError(503, "Stripe not configured");
  }
  const { wallet, email, success_url, cancel_url } = req.body || {};
  if (!wallet && !email) {
    throw new HttpError(400, "wallet or email is required");
  }
  const rawId = typeof wallet === "string" ? wallet : typeof email === "string" ? email : "";
  const identifier = resolveAccountIdentifier(rawId);
  const result = await createEmailPackCheckout(identifier, { successUrl: success_url, cancelUrl: cancel_url });
  res.json(result);
}));

// POST /billing/v1/email-packs/auto-recharge — enable/disable auto-recharge
router.post("/billing/v1/email-packs/auto-recharge", asyncHandler(async (req: Request, res: Response) => {
  const { billing_account_id, enabled, threshold } = req.body || {};
  if (!billing_account_id || typeof billing_account_id !== "string") {
    throw new HttpError(400, "billing_account_id required");
  }
  if (typeof enabled !== "boolean") {
    throw new HttpError(400, "enabled (boolean) required");
  }
  if (threshold !== undefined && (typeof threshold !== "number" || threshold < 0)) {
    throw new HttpError(400, "threshold must be a non-negative number");
  }
  await setAutoRecharge(billing_account_id, enabled, threshold);
  res.json({ status: "ok", billing_account_id, enabled, threshold: threshold ?? null });
}));

// POST /webhooks/v1/stripe — Stripe webhook (raw body, signature-verified)
router.post("/webhooks/v1/stripe", asyncHandler(async (req: Request, res: Response) => {
  const signature = req.headers["stripe-signature"] as string;
  if (!signature) {
    throw new HttpError(400, "Missing stripe-signature header");
  }

  try {
    // req.body is raw Buffer here (set up by express.raw() in server.ts)
    const rawBody = req.body as Buffer;
    await handleStripeWebhookEvent(rawBody, signature);
    res.json({ received: true });
  } catch (err: unknown) {
    const msg = errorMessage(err);
    if (msg.includes("signature") || msg.includes("No signatures found")) {
      throw new HttpError(400, "Webhook signature verification failed");
    }
    throw err;
  }
}));

export default router;
