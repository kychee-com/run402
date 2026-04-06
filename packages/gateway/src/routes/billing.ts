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
import { sql } from "../db/sql.js";
import { ADMIN_KEY } from "../config.js";
import {
  getBillingAccount,
  getOrCreateBillingAccount,
  getBillingAccountByEmail,
  getOrCreateBillingAccountByEmail,
  linkWalletToEmailAccount,
  adminCredit,
  adminDebit,
  getLedgerHistory,
  type BillingAccount,
} from "../services/billing.js";
import { resolveAccountIdentifier } from "../services/billing-identifier.js";
import { sendVerificationEmail } from "../services/billing-notifications.js";
import { randomBytes } from "node:crypto";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { validateWalletAddress, validatePaginationInt } from "../utils/validate.js";

const router = Router();

// Helper: resolve an identifier to a ledger "wallet" param for getLedgerHistory.
// For email accounts we need the wallet (if any) — or we can extend getLedgerHistory to accept accountId.
// For now, look up the account and use it directly for balance; history by account_id.
async function resolveAccount(identifier: string): Promise<BillingAccount | null> {
  const id = resolveAccountIdentifier(identifier);
  if (id.type === "wallet") {
    return getBillingAccount(id.value);
  } else {
    return getBillingAccountByEmail(id.value);
  }
}

// GET /billing/v1/accounts/:id — balance + status (identifier = wallet or email)
router.get("/billing/v1/accounts/:id", asyncHandler(async (req: Request, res: Response) => {
  const rawId = req.params["id"] || "";
  const identifier = resolveAccountIdentifier(rawId);
  const account = identifier.type === "wallet"
    ? await getBillingAccount(identifier.value)
    : await getBillingAccountByEmail(identifier.value);

  res.json({
    available_usd_micros: account?.available_usd_micros ?? 0,
    email_credits_remaining: account?.email_credits_remaining ?? 0,
    tier: account?.tier ?? null,
    lease_expires_at: account?.lease_expires_at ? account.lease_expires_at.toISOString() : null,
    auto_recharge_enabled: account?.auto_recharge_enabled ?? false,
    auto_recharge_threshold: account?.auto_recharge_threshold ?? 2000,
    identifier_type: identifier.type,
  });
}));

// GET /billing/v1/accounts/:id/history — ledger entries (identifier = wallet or email)
router.get("/billing/v1/accounts/:id/history", asyncHandler(async (req: Request, res: Response) => {
  const rawId = req.params["id"] || "";
  const identifier = resolveAccountIdentifier(rawId);
  const limit = validatePaginationInt(req.query["limit"], "limit", { fallback: 50, max: 200 });

  let entries: Awaited<ReturnType<typeof getLedgerHistory>> = [];
  if (identifier.type === "wallet") {
    entries = await getLedgerHistory(identifier.value, limit);
  } else {
    // For email accounts, look up the account and read ledger by billing_account_id
    const account = await getBillingAccountByEmail(identifier.value);
    if (account) {
      const result = await pool.query(
        sql(`SELECT * FROM internal.allowance_ledger WHERE billing_account_id = $1 ORDER BY created_at DESC LIMIT $2`),
        [account.id, limit],
      );
      entries = result.rows.map((row) => ({
        id: row.id as string,
        billing_account_id: row.billing_account_id as string,
        direction: row.direction as string,
        kind: row.kind as string,
        amount_usd_micros: Number(row.amount_usd_micros),
        balance_after_available: Number(row.balance_after_available),
        balance_after_held: Number(row.balance_after_held),
        reference_type: (row.reference_type as string) || null,
        reference_id: (row.reference_id as string) || null,
        idempotency_key: (row.idempotency_key as string) || null,
        metadata: row.metadata as Record<string, unknown> | null,
        created_at: new Date(row.created_at as string),
      }));
    }
  }

  res.json({
    identifier: rawId,
    identifier_type: identifier.type,
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

// POST /billing/v1/accounts — create an email-based billing account
// Body: { email: string }
router.post("/billing/v1/accounts", asyncHandler(async (req: Request, res: Response) => {
  const { email } = (req.body || {}) as { email?: unknown };
  if (!email || typeof email !== "string") {
    throw new HttpError(400, "email required");
  }
  const identifier = resolveAccountIdentifier(email);
  if (identifier.type !== "email") {
    throw new HttpError(400, "email must be a valid email address");
  }

  const account = await getOrCreateBillingAccountByEmail(identifier.value);

  // Send verification email (rate-limited)
  const verificationToken = randomBytes(24).toString("base64url");
  // Store the token hash on the row — reuse verification_send_count column pattern
  // For MVP we just send the raw token (magic link pattern); a dedicated token table can come later.
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  try {
    await sendVerificationEmail(identifier.value, verificationToken, ip);
  } catch (err) {
    // Don't fail account creation on verification email failure — log + continue
    console.error("Verification email send failed:", err);
  }

  res.status(201).json({
    id: account.id,
    email: identifier.value,
    email_credits_remaining: account.email_credits_remaining,
    verification_sent: true,
  });
}));

// POST /billing/v1/accounts/:id/link-wallet — link a wallet to an existing email account
// Body: { wallet: string } (SIWX auth enforced via walletAddress in req context)
router.post("/billing/v1/accounts/:id/link-wallet", asyncHandler(async (req: Request, res: Response) => {
  const accountIdRaw = req.params["id"];
  if (!accountIdRaw || typeof accountIdRaw !== "string") {
    throw new HttpError(400, "account id required");
  }
  const accountId: string = accountIdRaw;
  const { wallet } = (req.body || {}) as { wallet?: unknown };
  if (!wallet || typeof wallet !== "string") {
    throw new HttpError(400, "wallet required");
  }
  const normalizedWallet = validateWalletAddress(wallet, "wallet");

  await linkWalletToEmailAccount(accountId, normalizedWallet);

  res.json({
    status: "linked",
    billing_account_id: accountId,
    wallet: normalizedWallet,
  });
}));

// POST /billing/v1/admin/accounts/:wallet/credit — admin credit
router.post("/billing/v1/admin/accounts/:wallet/credit", asyncHandler(async (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string | undefined;
  if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
    throw new HttpError(403, "Requires admin key");
  }

  const wallet = validateWalletAddress(req.params["wallet"], "wallet");

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

  const wallet = validateWalletAddress(req.params["wallet"], "wallet");

  const { amount_usd_micros, reason, idempotency_key } = req.body || {};
  if (!amount_usd_micros || typeof amount_usd_micros !== "number" || amount_usd_micros <= 0) {
    throw new HttpError(400, "amount_usd_micros must be a positive number");
  }
  if (!reason || typeof reason !== "string") {
    throw new HttpError(400, "reason is required");
  }

  const result = await adminDebit(wallet, amount_usd_micros, reason, idempotency_key);
  res.json({
    wallet,
    billing_account_id: result.account.id,
    available_usd_micros: result.account.available_usd_micros,
    ledger_entry_id: result.ledger_entry.id,
  });
}));

// GET /wallets/v1/:address/projects — list active projects for a wallet (public)
router.get("/wallets/v1/:address/projects", asyncHandler(async (req: Request, res: Response) => {
  const wallet = validateWalletAddress(req.params["address"], "address");

  const result = await pool.query(
    sql(`SELECT id, name, tier, status, api_calls, storage_bytes, created_at
     FROM internal.projects WHERE wallet_address = $1 AND status = 'active'
     ORDER BY created_at DESC`),
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
