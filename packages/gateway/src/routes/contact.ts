import { Router, Request, Response } from "express";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { extractWalletFromPaymentHeader, recordWallet } from "../utils/wallet.js";
import { pool } from "../db/pool.js";

const router = Router();

router.get("/v1/agent/contact", (_req: Request, res: Response) => {
  res.json({
    description: "Register agent contact info (name, email, webhook) tied to your wallet",
    price: "$0.001 USDC",
    method: "PUT",
    body: {
      name: "string (required)",
      email: "string (optional, email address)",
      webhook: "string (optional, https:// URL)",
    },
  });
});

router.put("/v1/agent/contact", asyncHandler(async (req: Request, res: Response) => {
  // Extract wallet from payment header
  const paymentHeader = req.header("payment-signature") || req.header("x-payment");
  if (!paymentHeader) {
    throw new HttpError(401, "Missing payment header");
  }

  const wallet = extractWalletFromPaymentHeader(paymentHeader);
  if (!wallet) {
    throw new HttpError(401, "Could not extract wallet from payment header");
  }

  recordWallet(wallet, "contact");

  // Validate body
  const { name, email, webhook } = req.body || {};

  if (!name || typeof name !== "string" || !name.trim()) {
    throw new HttpError(400, "Missing or empty 'name' field");
  }

  if (email !== undefined && email !== null) {
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpError(400, "Invalid 'email' — must be a valid email address");
    }
  }

  if (webhook !== undefined && webhook !== null) {
    if (typeof webhook !== "string" || !webhook.startsWith("https://")) {
      throw new HttpError(400, "Invalid 'webhook' — must start with https://");
    }
  }

  // Upsert contact
  const result = await pool.query(
    `INSERT INTO internal.agent_contacts (wallet_address, name, email, webhook)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (wallet_address) DO UPDATE
       SET name = EXCLUDED.name,
           email = EXCLUDED.email,
           webhook = EXCLUDED.webhook,
           updated_at = NOW()
     RETURNING wallet_address, name, email, webhook, updated_at`,
    [wallet, name.trim(), email?.trim() || null, webhook?.trim() || null],
  );

  const row = result.rows[0];
  res.json({
    wallet: row.wallet_address,
    name: row.name,
    email: row.email,
    webhook: row.webhook,
    updated_at: row.updated_at,
  });
}));

export default router;
