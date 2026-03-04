import { Router, Request, Response } from "express";
import { pool } from "../db/pool.js";
import { errorMessage } from "../utils/errors.js";
import {
  getWalletSubscription,
  createStripeCheckout,
  createStripePortal,
  getProducts,
  clearSubscriptionCache,
} from "../services/stripe-subscriptions.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";

const router = Router();

// GET /v1/wallets/:address/projects — list projects for a wallet (public)
router.get("/v1/wallets/:address/projects", asyncHandler(async (req: Request, res: Response) => {
  const wallet = (req.params["address"] as string)?.toLowerCase();
  if (!wallet?.startsWith("0x")) {
    throw new HttpError(400, "Invalid wallet address");
  }

  const result = await pool.query(
    `SELECT id, name, tier, status, api_calls, storage_bytes, lease_expires_at, created_at
     FROM internal.projects WHERE wallet_address = $1 AND status = 'active'
     ORDER BY created_at DESC`,
    [wallet],
  );

  res.json({
    wallet,
    projects: result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      tier: r.tier,
      status: r.status,
      api_calls: r.api_calls,
      storage_bytes: Number(r.storage_bytes),
      lease_expires_at: new Date(r.lease_expires_at).toISOString(),
      created_at: new Date(r.created_at).toISOString(),
    })),
  });
}));

// GET /v1/stripe/products — list Stripe products + prices
router.get("/v1/stripe/products", asyncHandler(async (_req: Request, res: Response) => {
  const products = await getProducts();
  res.json({ products });
}));

// POST /v1/stripe/checkout — create Checkout Session
router.post("/v1/stripe/checkout", asyncHandler(async (req: Request, res: Response) => {
  const { wallet, price_id, success_url, cancel_url } = req.body || {};

  if (!wallet || !price_id) {
    throw new HttpError(400, "Missing required fields: wallet, price_id");
  }

  const defaultSuccess = `https://run402.com/subscribe?wallet=${encodeURIComponent(wallet)}&success=true`;
  const defaultCancel = `https://run402.com/subscribe?wallet=${encodeURIComponent(wallet)}`;

  try {
    const url = await createStripeCheckout(
      wallet,
      price_id,
      success_url || defaultSuccess,
      cancel_url || defaultCancel,
    );
    res.json({ url });
  } catch (err: unknown) {
    if (errorMessage(err) === "Wallet already has an active subscription") {
      throw new HttpError(409, "Wallet already has an active subscription");
    }
    throw err;
  }
}));

// POST /v1/stripe/portal — create Customer Portal session
router.post("/v1/stripe/portal", asyncHandler(async (req: Request, res: Response) => {
  const { wallet, return_url } = req.body || {};

  if (!wallet) {
    throw new HttpError(400, "Missing required field: wallet");
  }

  const defaultReturn = `https://run402.com/subscribe?wallet=${encodeURIComponent(wallet)}`;

  try {
    const url = await createStripePortal(wallet, return_url || defaultReturn);
    res.json({ url });
  } catch (err: unknown) {
    if (errorMessage(err) === "No Stripe customer found for this wallet") {
      throw new HttpError(404, "No Stripe customer found for this wallet");
    }
    throw err;
  }
}));

// GET /v1/stripe/subscription/:wallet — subscription status for a wallet
router.get("/v1/stripe/subscription/:wallet", asyncHandler(async (req: Request, res: Response) => {
  const wallet = (req.params["wallet"] as string)?.toLowerCase();
  if (!wallet?.startsWith("0x")) {
    throw new HttpError(400, "Invalid wallet address");
  }

  const sub = await getWalletSubscription(wallet);
  if (!sub) {
    res.json({ wallet, subscribed: false });
    return;
  }
  res.json({
    wallet,
    subscribed: true,
    tier: sub.tier,
    status: sub.status,
    current_period_end: sub.currentPeriodEnd.toISOString(),
  });
}));

// POST /v1/stripe/cache/clear — clear subscription cache (for post-checkout warming)
router.post("/v1/stripe/cache/clear", async (req: Request, res: Response) => {
  const { wallet } = req.body || {};
  clearSubscriptionCache(wallet);
  res.json({ status: "ok" });
});

export default router;
