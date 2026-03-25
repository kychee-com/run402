import { Router, Request, Response } from "express";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { validateEmail, validateURL } from "../utils/validate.js";
import { walletAuth } from "../middleware/wallet-auth.js";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";

const router = Router();

router.get("/agent/v1/contact", (_req: Request, res: Response) => {
  res.json({
    description: "Register agent contact info (name, email, webhook) tied to your wallet (free with wallet auth)",
    method: "POST",
    auth: "EIP-4361 wallet signature",
    body: {
      name: "string (required)",
      email: "string (optional, email address)",
      webhook: "string (optional, https:// URL)",
    },
  });
});

router.post("/agent/v1/contact", walletAuth(false), asyncHandler(async (req: Request, res: Response) => {
  const wallet = req.walletAddress!;

  // Validate body
  const { name, email, webhook } = req.body || {};

  if (!name || typeof name !== "string" || !name.trim()) {
    throw new HttpError(400, "Missing or empty 'name' field");
  }

  if (email !== undefined && email !== null) {
    validateEmail(email, "email");
  }

  if (webhook !== undefined && webhook !== null) {
    validateURL(webhook, "webhook");
  }

  // Upsert contact
  const result = await pool.query(
    sql(`INSERT INTO internal.agent_contacts (wallet_address, name, email, webhook)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (wallet_address) DO UPDATE
       SET name = EXCLUDED.name,
           email = EXCLUDED.email,
           webhook = EXCLUDED.webhook,
           updated_at = NOW()
     RETURNING wallet_address, name, email, webhook, updated_at`),
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
