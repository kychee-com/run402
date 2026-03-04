import { Router, Request, Response } from "express";
import { pool } from "../db/pool.js";
import {
  getWalletSubscription,
  createStripeCheckout,
  createStripePortal,
  getProducts,
  clearSubscriptionCache,
} from "../services/stripe-subscriptions.js";

const router = Router();

// GET /v1/wallets/:address/projects — list projects for a wallet (public)
router.get("/v1/wallets/:address/projects", async (req: Request, res: Response) => {
  const wallet = (req.params["address"] as string)?.toLowerCase();
  if (!wallet?.startsWith("0x")) {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }

  try {
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
  } catch (err: any) {
    console.error("Failed to list wallet projects:", err.message);
    res.status(500).json({ error: "Failed to list projects" });
  }
});

// GET /v1/stripe/products — list Stripe products + prices
router.get("/v1/stripe/products", async (_req: Request, res: Response) => {
  try {
    const products = await getProducts();
    res.json({ products });
  } catch (err: any) {
    console.error("Failed to list products:", err.message);
    res.status(500).json({ error: "Failed to list products" });
  }
});

// POST /v1/stripe/checkout — create Checkout Session
router.post("/v1/stripe/checkout", async (req: Request, res: Response) => {
  const { wallet, price_id, success_url, cancel_url } = req.body || {};

  if (!wallet || !price_id) {
    res.status(400).json({ error: "Missing required fields: wallet, price_id" });
    return;
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
  } catch (err: any) {
    if (err.message === "Wallet already has an active subscription") {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("Failed to create checkout:", err.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// POST /v1/stripe/portal — create Customer Portal session
router.post("/v1/stripe/portal", async (req: Request, res: Response) => {
  const { wallet, return_url } = req.body || {};

  if (!wallet) {
    res.status(400).json({ error: "Missing required field: wallet" });
    return;
  }

  const defaultReturn = `https://run402.com/subscribe?wallet=${encodeURIComponent(wallet)}`;

  try {
    const url = await createStripePortal(wallet, return_url || defaultReturn);
    res.json({ url });
  } catch (err: any) {
    if (err.message === "No Stripe customer found for this wallet") {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error("Failed to create portal:", err.message);
    res.status(500).json({ error: "Failed to create portal session" });
  }
});

// GET /v1/stripe/subscription/:wallet — subscription status for a wallet
router.get("/v1/stripe/subscription/:wallet", async (req: Request, res: Response) => {
  const wallet = (req.params["wallet"] as string)?.toLowerCase();
  if (!wallet?.startsWith("0x")) {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }

  try {
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
  } catch (err: any) {
    console.error("Failed to get subscription:", err.message);
    res.status(500).json({ error: "Failed to get subscription status" });
  }
});

// POST /v1/stripe/cache/clear — clear subscription cache (for post-checkout warming)
router.post("/v1/stripe/cache/clear", async (req: Request, res: Response) => {
  const { wallet } = req.body || {};
  clearSubscriptionCache(wallet);
  res.json({ status: "ok" });
});

export default router;
