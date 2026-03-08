/**
 * Stripe billing routes — checkout + webhook.
 *
 * POST /v1/billing/checkouts      — create Stripe Checkout session for allowance top-up
 * POST /v1/webhooks/stripe        — Stripe webhook handler (signature-verified)
 */

import { Router, Request, Response } from "express";
import { createAllowanceCheckout, handleStripeWebhookEvent } from "../services/stripe-billing.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { errorMessage } from "../utils/errors.js";
import { STRIPE_SECRET_KEY } from "../config.js";

const router = Router();

// POST /v1/billing/checkouts — create Stripe Checkout for allowance top-up
router.post("/v1/billing/checkouts", asyncHandler(async (req: Request, res: Response) => {
  if (!STRIPE_SECRET_KEY) {
    throw new HttpError(503, "Stripe not configured");
  }

  const { wallet, amount_usd_micros, success_url, cancel_url, email } = req.body || {};

  if (!wallet || typeof wallet !== "string" || !wallet.startsWith("0x")) {
    throw new HttpError(400, "wallet is required (0x-prefixed address)");
  }
  if (!amount_usd_micros || typeof amount_usd_micros !== "number" || amount_usd_micros <= 0) {
    throw new HttpError(400, "amount_usd_micros must be a positive number");
  }

  const result = await createAllowanceCheckout(wallet, amount_usd_micros, success_url, cancel_url, email);
  res.json(result);
}));

// POST /v1/webhooks/stripe — Stripe webhook (raw body, signature-verified)
router.post("/v1/webhooks/stripe", asyncHandler(async (req: Request, res: Response) => {
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
