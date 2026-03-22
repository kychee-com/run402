/**
 * Billing routes — allowance balance management.
 *
 * GET  /billing/v1/accounts/:wallet         — balance
 * GET  /billing/v1/accounts/:wallet/history  — ledger entries
 * POST /billing/v1/admin/accounts/:wallet/credit — admin credit
 * POST /billing/v1/admin/accounts/:wallet/debit  — admin debit
 * GET  /wallets/v1/:address/projects         — list projects for a wallet
 */

import { Router, Request, Response } from "express";
import { pool } from "../db/pool.js";
import { ADMIN_KEY } from "../config.js";
import {
  getBillingAccount,
  getOrCreateBillingAccount,
  adminCredit,
  adminDebit,
  getLedgerHistory,
} from "../services/billing.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";

const router = Router();

// GET /billing/v1/accounts/:wallet — balance + status
router.get("/billing/v1/accounts/:wallet", asyncHandler(async (req: Request, res: Response) => {
  const wallet = (req.params["wallet"] as string)?.toLowerCase();
  if (!wallet?.startsWith("0x")) {
    throw new HttpError(400, "Invalid wallet address");
  }

  const account = await getBillingAccount(wallet);

  res.json({
    available_usd_micros: account?.available_usd_micros ?? 0,
  });
}));

// GET /billing/v1/accounts/:wallet/history — ledger entries
router.get("/billing/v1/accounts/:wallet/history", asyncHandler(async (req: Request, res: Response) => {
  const wallet = (req.params["wallet"] as string)?.toLowerCase();
  if (!wallet?.startsWith("0x")) {
    throw new HttpError(400, "Invalid wallet address");
  }

  const limit = Math.min(parseInt(req.query["limit"] as string || "50", 10), 200);
  const entries = await getLedgerHistory(wallet, limit);

  res.json({
    wallet,
    entries: entries.map((e) => ({
      id: e.id,
      direction: e.direction,
      kind: e.kind,
      amount_usd_micros: e.amount_usd_micros,
      balance_after_available: e.balance_after_available,
      balance_after_held: e.balance_after_held,
      reference_type: e.reference_type,
      reference_id: e.reference_id,
      metadata: e.metadata,
      created_at: e.created_at.toISOString(),
    })),
  });
}));

// POST /billing/v1/admin/accounts/:wallet/credit — admin credit
router.post("/billing/v1/admin/accounts/:wallet/credit", asyncHandler(async (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string | undefined;
  if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
    throw new HttpError(403, "Requires admin key");
  }

  const wallet = (req.params["wallet"] as string)?.toLowerCase();
  if (!wallet?.startsWith("0x")) {
    throw new HttpError(400, "Invalid wallet address");
  }

  const { amount_usd_micros, reason, idempotency_key } = req.body || {};
  if (!amount_usd_micros || typeof amount_usd_micros !== "number" || amount_usd_micros <= 0) {
    throw new HttpError(400, "amount_usd_micros must be a positive number");
  }
  if (!reason || typeof reason !== "string") {
    throw new HttpError(400, "reason is required");
  }

  const result = await adminCredit(wallet, amount_usd_micros, reason, idempotency_key);

  res.json({
    wallet,
    billing_account_id: result.account.id,
    available_usd_micros: result.account.available_usd_micros,
    ledger_entry_id: result.ledger_entry.id,
  });
}));

// POST /billing/v1/admin/accounts/:wallet/debit — admin debit
router.post("/billing/v1/admin/accounts/:wallet/debit", asyncHandler(async (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string | undefined;
  if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
    throw new HttpError(403, "Requires admin key");
  }

  const wallet = (req.params["wallet"] as string)?.toLowerCase();
  if (!wallet?.startsWith("0x")) {
    throw new HttpError(400, "Invalid wallet address");
  }

  const { amount_usd_micros, reason, idempotency_key } = req.body || {};
  if (!amount_usd_micros || typeof amount_usd_micros !== "number" || amount_usd_micros <= 0) {
    throw new HttpError(400, "amount_usd_micros must be a positive number");
  }
  if (!reason || typeof reason !== "string") {
    throw new HttpError(400, "reason is required");
  }

  try {
    const result = await adminDebit(wallet, amount_usd_micros, reason, idempotency_key);
    res.json({
      wallet,
      billing_account_id: result.account.id,
      available_usd_micros: result.account.available_usd_micros,
      ledger_entry_id: result.ledger_entry.id,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith("Insufficient balance")) {
      throw new HttpError(402, err.message);
    }
    throw err;
  }
}));

// GET /wallets/v1/:address/projects — list active projects for a wallet (public)
router.get("/wallets/v1/:address/projects", asyncHandler(async (req: Request, res: Response) => {
  const wallet = (req.params["address"] as string)?.toLowerCase();
  if (!wallet?.startsWith("0x")) {
    throw new HttpError(400, "Invalid wallet address");
  }

  const result = await pool.query(
    `SELECT id, name, tier, status, api_calls, storage_bytes, created_at
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
      created_at: new Date(r.created_at).toISOString(),
    })),
  });
}));

export default router;
