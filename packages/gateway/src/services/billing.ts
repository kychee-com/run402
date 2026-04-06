/**
 * Core billing service — the only module that touches billing tables.
 * All balance mutations use SELECT ... FOR UPDATE + single transaction.
 * Currency: integer micro-USD (bigint in Postgres, number in JS).
 */

import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { randomUUID } from "node:crypto";
import { HttpError } from "../utils/async-handler.js";

export interface BillingAccount {
  id: string;
  status: string;
  currency: string;
  available_usd_micros: number;
  held_usd_micros: number;
  funding_policy: string;
  low_balance_threshold_usd_micros: number;
  primary_contact_email: string | null;
  tier: string | null;
  lease_started_at: Date | null;
  lease_expires_at: Date | null;
  email_credits_remaining: number;
  auto_recharge_enabled: boolean;
  auto_recharge_threshold: number;
  auto_recharge_failure_count: number;
  stripe_customer_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface LedgerEntry {
  id: string;
  billing_account_id: string;
  direction: string;
  kind: string;
  amount_usd_micros: number;
  balance_after_available: number;
  balance_after_held: number;
  reference_type: string | null;
  reference_id: string | null;
  idempotency_key: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface ChargeAuthorization {
  id: string;
  wallet_address: string;
  billing_account_id: string;
  rail: string;
  sku: string;
  amount_usd_micros: number;
  status: string;
  idempotency_key: string | null;
  payment_header_hash: string | null;
  metadata: Record<string, unknown> | null;
  expires_at: Date | null;
  created_at: Date;
  captured_at: Date | null;
}

/**
 * Get or create a billing account for a wallet address.
 * Atomic upsert: inserts billing_accounts + billing_account_wallets.
 */
export async function getOrCreateBillingAccount(wallet: string): Promise<BillingAccount> {
  const normalized = wallet.toLowerCase();

  // Check if wallet already linked
  const existing = await pool.query(
    sql(`SELECT ba.* FROM internal.billing_accounts ba
     JOIN internal.billing_account_wallets baw ON baw.billing_account_id = ba.id
     WHERE baw.wallet_address = $1`),
    [normalized],
  );

  if (existing.rows.length > 0) {
    return rowToAccount(existing.rows[0]);
  }

  // Create new account + wallet link in a transaction
  const client = await pool.connect();
  try {
    await client.query(sql("BEGIN"));

    // Double-check inside transaction
    const recheck = await client.query(
      sql(`SELECT ba.* FROM internal.billing_accounts ba
       JOIN internal.billing_account_wallets baw ON baw.billing_account_id = ba.id
       WHERE baw.wallet_address = $1`),
      [normalized],
    );
    if (recheck.rows.length > 0) {
      await client.query(sql("COMMIT"));
      return rowToAccount(recheck.rows[0]);
    }

    const accountId = randomUUID();
    await client.query(
      sql(`INSERT INTO internal.billing_accounts (id, status, currency, available_usd_micros, held_usd_micros, funding_policy, low_balance_threshold_usd_micros)
       VALUES ($1, 'active', 'USD', 0, 0, 'allowance_then_wallet', 1000000)`),
      [accountId],
    );

    await client.query(
      sql(`INSERT INTO internal.billing_account_wallets (wallet_address, billing_account_id, status, role)
       VALUES ($1, $2, 'active', 'owner')`),
      [normalized, accountId],
    );

    await client.query(sql("COMMIT"));

    const result = await pool.query(
      sql(`SELECT * FROM internal.billing_accounts WHERE id = $1`),
      [accountId],
    );
    return rowToAccount(result.rows[0]);
  } catch (err) {
    try { await client.query(sql("ROLLBACK")); } catch { /* connection may be dead */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* may already be released */ }
  }
}

/**
 * Lookup billing account by wallet address. Returns null if not found.
 */
export async function getBillingAccount(wallet: string): Promise<BillingAccount | null> {
  const normalized = wallet.toLowerCase();
  const result = await pool.query(
    sql(`SELECT ba.* FROM internal.billing_accounts ba
     JOIN internal.billing_account_wallets baw ON baw.billing_account_id = ba.id
     WHERE baw.wallet_address = $1`),
    [normalized],
  );
  return result.rows.length > 0 ? rowToAccount(result.rows[0]) : null;
}

/**
 * Lookup billing account by email address. Returns null if not found.
 */
export async function getBillingAccountByEmail(email: string): Promise<BillingAccount | null> {
  const normalized = email.toLowerCase().trim();
  const result = await pool.query(
    sql(`SELECT ba.* FROM internal.billing_accounts ba
     JOIN internal.billing_account_emails bae ON bae.billing_account_id = ba.id
     WHERE bae.email = $1`),
    [normalized],
  );
  return result.rows.length > 0 ? rowToAccount(result.rows[0]) : null;
}

/**
 * Get or create a billing account for an email address.
 * Atomic upsert: inserts billing_accounts + billing_account_emails.
 * Idempotent — returns existing account if email already linked.
 */
export async function getOrCreateBillingAccountByEmail(email: string): Promise<BillingAccount> {
  const normalized = email.toLowerCase().trim();

  // Check if email already linked
  const existing = await pool.query(
    sql(`SELECT ba.* FROM internal.billing_accounts ba
     JOIN internal.billing_account_emails bae ON bae.billing_account_id = ba.id
     WHERE bae.email = $1`),
    [normalized],
  );

  if (existing.rows.length > 0) {
    return rowToAccount(existing.rows[0]);
  }

  // Create new account + email link in a transaction
  const client = await pool.connect();
  try {
    await client.query(sql("BEGIN"));

    // Double-check inside transaction (race condition protection)
    const recheck = await client.query(
      sql(`SELECT ba.* FROM internal.billing_accounts ba
       JOIN internal.billing_account_emails bae ON bae.billing_account_id = ba.id
       WHERE bae.email = $1`),
      [normalized],
    );
    if (recheck.rows.length > 0) {
      await client.query(sql("COMMIT"));
      return rowToAccount(recheck.rows[0]);
    }

    const accountId = randomUUID();
    await client.query(
      sql(`INSERT INTO internal.billing_accounts (id, status, currency, available_usd_micros, held_usd_micros, funding_policy, low_balance_threshold_usd_micros, primary_contact_email)
       VALUES ($1, 'active', 'USD', 0, 0, 'allowance_then_wallet', 1000000, $2)`),
      [accountId, normalized],
    );

    await client.query(
      sql(`INSERT INTO internal.billing_account_emails (email, billing_account_id)
       VALUES ($1, $2)`),
      [normalized, accountId],
    );

    await client.query(sql("COMMIT"));

    const result = await pool.query(
      sql(`SELECT * FROM internal.billing_accounts WHERE id = $1`),
      [accountId],
    );
    return rowToAccount(result.rows[0]);
  } catch (err) {
    try { await client.query(sql("ROLLBACK")); } catch { /* connection may be dead */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* may already be released */ }
  }
}

/**
 * Link a wallet to an existing billing account (typically an email account).
 * Errors with 409 if the wallet is already linked to any account.
 * Errors with 404 if the target account does not exist.
 */
export async function linkWalletToEmailAccount(accountId: string, wallet: string): Promise<void> {
  const normalizedWallet = wallet.toLowerCase();

  // Check if wallet is already linked to any account
  const existing = await pool.query(
    sql(`SELECT billing_account_id FROM internal.billing_account_wallets WHERE wallet_address = $1`),
    [normalizedWallet],
  );
  if (existing.rows.length > 0) {
    throw new HttpError(409, "Wallet is already linked to a billing account");
  }

  // Check if target account exists
  const account = await pool.query(
    sql(`SELECT id FROM internal.billing_accounts WHERE id = $1`),
    [accountId],
  );
  if (account.rows.length === 0) {
    throw new HttpError(404, "Billing account not found");
  }

  // Link the wallet
  await pool.query(
    sql(`INSERT INTO internal.billing_account_wallets (wallet_address, billing_account_id, status, role)
     VALUES ($1, $2, 'active', 'owner')`),
    [normalizedWallet, accountId],
  );
}

/**
 * Admin credit — append ledger credit, increment available balance.
 */
export async function adminCredit(
  wallet: string,
  amountUsdMicros: number,
  reason: string,
  idempotencyKey?: string,
): Promise<{ account: BillingAccount; ledger_entry: LedgerEntry }> {
  const account = await getOrCreateBillingAccount(wallet);
  const key = idempotencyKey || randomUUID();

  const client = await pool.connect();
  try {
    await client.query(sql("BEGIN"));

    // Idempotency check
    const dup = await client.query(
      sql(`SELECT id FROM internal.allowance_ledger WHERE idempotency_key = $1`),
      [key],
    );
    if (dup.rows.length > 0) {
      const entry = await client.query(
        sql(`SELECT * FROM internal.allowance_ledger WHERE idempotency_key = $1`),
        [key],
      );
      await client.query(sql("COMMIT"));
      const updatedAccount = await getBillingAccount(wallet);
      return { account: updatedAccount!, ledger_entry: rowToLedger(entry.rows[0]) };
    }

    // Lock account row
    const locked = await client.query(
      sql(`SELECT * FROM internal.billing_accounts WHERE id = $1 FOR UPDATE`),
      [account.id],
    );
    const currentAvailable = Number(locked.rows[0].available_usd_micros);
    const currentHeld = Number(locked.rows[0].held_usd_micros);
    const newAvailable = currentAvailable + amountUsdMicros;

    // Update balance
    await client.query(
      sql(`UPDATE internal.billing_accounts SET available_usd_micros = $1, updated_at = NOW() WHERE id = $2`),
      [newAvailable, account.id],
    );

    // Append ledger
    const ledgerId = randomUUID();
    await client.query(
      sql(`INSERT INTO internal.allowance_ledger (id, billing_account_id, direction, kind, amount_usd_micros, balance_after_available, balance_after_held, reference_type, reference_id, idempotency_key, metadata)
       VALUES ($1, $2, 'credit', 'admin_credit', $3, $4, $5, 'admin', $6, $7, $8)`),
      [ledgerId, account.id, amountUsdMicros, newAvailable, currentHeld, reason, key, JSON.stringify({ reason })],
    );

    await client.query(sql("COMMIT"));

    const updatedAccount = await getBillingAccount(wallet);
    const ledgerEntry = await pool.query(
      sql(`SELECT * FROM internal.allowance_ledger WHERE id = $1`),
      [ledgerId],
    );
    return { account: updatedAccount!, ledger_entry: rowToLedger(ledgerEntry.rows[0]) };
  } catch (err) {
    try { await client.query(sql("ROLLBACK")); } catch { /* connection may be dead */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* may already be released */ }
  }
}

/**
 * Admin debit — append ledger debit, decrement available balance.
 */
export async function adminDebit(
  wallet: string,
  amountUsdMicros: number,
  reason: string,
  idempotencyKey?: string,
): Promise<{ account: BillingAccount; ledger_entry: LedgerEntry }> {
  const account = await getOrCreateBillingAccount(wallet);
  const key = idempotencyKey || randomUUID();

  const client = await pool.connect();
  try {
    await client.query(sql("BEGIN"));

    // Idempotency check
    const dup = await client.query(
      sql(`SELECT id FROM internal.allowance_ledger WHERE idempotency_key = $1`),
      [key],
    );
    if (dup.rows.length > 0) {
      const entry = await client.query(
        sql(`SELECT * FROM internal.allowance_ledger WHERE idempotency_key = $1`),
        [key],
      );
      await client.query(sql("COMMIT"));
      const updatedAccount = await getBillingAccount(wallet);
      return { account: updatedAccount!, ledger_entry: rowToLedger(entry.rows[0]) };
    }

    // Lock account row
    const locked = await client.query(
      sql(`SELECT * FROM internal.billing_accounts WHERE id = $1 FOR UPDATE`),
      [account.id],
    );
    const currentAvailable = Number(locked.rows[0].available_usd_micros);
    const currentHeld = Number(locked.rows[0].held_usd_micros);

    if (currentAvailable < amountUsdMicros) {
      throw new HttpError(402, `Insufficient balance: available=${currentAvailable}, requested=${amountUsdMicros}`);
    }

    const newAvailable = currentAvailable - amountUsdMicros;

    // Update balance
    await client.query(
      sql(`UPDATE internal.billing_accounts SET available_usd_micros = $1, updated_at = NOW() WHERE id = $2`),
      [newAvailable, account.id],
    );

    // Append ledger
    const ledgerId = randomUUID();
    await client.query(
      sql(`INSERT INTO internal.allowance_ledger (id, billing_account_id, direction, kind, amount_usd_micros, balance_after_available, balance_after_held, reference_type, reference_id, idempotency_key, metadata)
       VALUES ($1, $2, 'debit', 'admin_debit', $3, $4, $5, 'admin', $6, $7, $8)`),
      [ledgerId, account.id, amountUsdMicros, newAvailable, currentHeld, reason, key, JSON.stringify({ reason })],
    );

    await client.query(sql("COMMIT"));

    const updatedAccount = await getBillingAccount(wallet);
    const ledgerEntry = await pool.query(
      sql(`SELECT * FROM internal.allowance_ledger WHERE id = $1`),
      [ledgerId],
    );
    return { account: updatedAccount!, ledger_entry: rowToLedger(ledgerEntry.rows[0]) };
  } catch (err) {
    try { await client.query(sql("ROLLBACK")); } catch { /* connection may be dead */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* may already be released */ }
  }
}

/**
 * Debit allowance for a purchase (used by x402 middleware).
 * Returns the remaining balance, or null if insufficient funds.
 */
export async function debitAllowance(
  wallet: string,
  amountUsdMicros: number,
  sku: string,
  paymentHeaderHash: string | null,
): Promise<{ remaining: number; chargeId: string } | null> {
  const normalized = wallet.toLowerCase();

  const client = await pool.connect();
  try {
    await client.query(sql("BEGIN"));

    // Find account via wallet
    const accountResult = await client.query(
      sql(`SELECT ba.* FROM internal.billing_accounts ba
       JOIN internal.billing_account_wallets baw ON baw.billing_account_id = ba.id
       WHERE baw.wallet_address = $1
       FOR UPDATE OF ba`),
      [normalized],
    );

    if (accountResult.rows.length === 0) {
      await client.query(sql("ROLLBACK"));
      return null;
    }

    const row = accountResult.rows[0];
    const currentAvailable = Number(row.available_usd_micros);
    const currentHeld = Number(row.held_usd_micros);

    if (currentAvailable < amountUsdMicros) {
      await client.query(sql("ROLLBACK"));
      return null;
    }

    const newAvailable = currentAvailable - amountUsdMicros;

    // Update balance
    await client.query(
      sql(`UPDATE internal.billing_accounts SET available_usd_micros = $1, updated_at = NOW() WHERE id = $2`),
      [newAvailable, row.id],
    );

    // Append ledger
    const ledgerId = randomUUID();
    const idempotencyKey = paymentHeaderHash || randomUUID();
    await client.query(
      sql(`INSERT INTO internal.allowance_ledger (id, billing_account_id, direction, kind, amount_usd_micros, balance_after_available, balance_after_held, reference_type, reference_id, idempotency_key, metadata)
       VALUES ($1, $2, 'debit', 'purchase_debit', $3, $4, $5, 'charge', $6, $7, $8)`),
      [ledgerId, row.id, amountUsdMicros, newAvailable, currentHeld, sku, idempotencyKey, JSON.stringify({ sku })],
    );

    // Insert charge authorization
    const chargeId = randomUUID();
    await client.query(
      sql(`INSERT INTO internal.charge_authorizations (id, wallet_address, billing_account_id, rail, sku, amount_usd_micros, status, idempotency_key, payment_header_hash, created_at, captured_at)
       VALUES ($1, $2, $3, 'allowance', $4, $5, 'captured', $6, $7, NOW(), NOW())`),
      [chargeId, normalized, row.id, sku, amountUsdMicros, idempotencyKey, paymentHeaderHash],
    );

    await client.query(sql("COMMIT"));

    return { remaining: newAvailable, chargeId };
  } catch (err) {
    try { await client.query(sql("ROLLBACK")); } catch { /* connection may be dead */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* may already be released */ }
  }
}

/**
 * Credit from a Stripe top-up (used by webhook handler).
 */
export async function creditFromTopup(
  topupId: string,
  stripeEventId: string,
): Promise<BillingAccount> {
  const client = await pool.connect();
  try {
    await client.query(sql("BEGIN"));

    // Idempotency: check if already processed
    const dup = await client.query(
      sql(`SELECT id FROM internal.allowance_ledger WHERE idempotency_key = $1`),
      [stripeEventId],
    );
    if (dup.rows.length > 0) {
      // Already processed — return current state
      const topup = await client.query(
        sql(`SELECT billing_account_id FROM internal.billing_topups WHERE id = $1`),
        [topupId],
      );
      await client.query(sql("COMMIT"));
      const account = await pool.query(
        sql(`SELECT * FROM internal.billing_accounts WHERE id = $1`),
        [topup.rows[0].billing_account_id],
      );
      return rowToAccount(account.rows[0]);
    }

    // Load topup
    const topup = await client.query(
      sql(`SELECT * FROM internal.billing_topups WHERE id = $1`),
      [topupId],
    );
    if (topup.rows.length === 0) {
      await client.query(sql("ROLLBACK"));
      throw new Error(`Topup not found: ${topupId}`);
    }

    const topupRow = topup.rows[0];
    const amountUsdMicros = Number(topupRow.funded_usd_micros);

    // Lock account
    const locked = await client.query(
      sql(`SELECT * FROM internal.billing_accounts WHERE id = $1 FOR UPDATE`),
      [topupRow.billing_account_id],
    );
    const currentAvailable = Number(locked.rows[0].available_usd_micros);
    const currentHeld = Number(locked.rows[0].held_usd_micros);
    const newAvailable = currentAvailable + amountUsdMicros;

    // Update balance
    await client.query(
      sql(`UPDATE internal.billing_accounts SET available_usd_micros = $1, updated_at = NOW() WHERE id = $2`),
      [newAvailable, topupRow.billing_account_id],
    );

    // Append ledger
    const ledgerId = randomUUID();
    await client.query(
      sql(`INSERT INTO internal.allowance_ledger (id, billing_account_id, direction, kind, amount_usd_micros, balance_after_available, balance_after_held, reference_type, reference_id, idempotency_key, metadata)
       VALUES ($1, $2, 'credit', 'stripe_topup', $3, $4, $5, 'topup', $6, $7, $8)`),
      [ledgerId, topupRow.billing_account_id, amountUsdMicros, newAvailable, currentHeld, topupId, stripeEventId, JSON.stringify({ topup_id: topupId })],
    );

    // Mark topup as credited
    await client.query(
      sql(`UPDATE internal.billing_topups SET status = 'credited', credited_at = NOW() WHERE id = $1`),
      [topupId],
    );

    await client.query(sql("COMMIT"));

    const account = await pool.query(
      sql(`SELECT * FROM internal.billing_accounts WHERE id = $1`),
      [topupRow.billing_account_id],
    );
    return rowToAccount(account.rows[0]);
  } catch (err) {
    try { await client.query(sql("ROLLBACK")); } catch { /* connection may be dead */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* may already be released */ }
  }
}

/**
 * Get ledger history for a wallet.
 */
export async function getLedgerHistory(wallet: string, limit = 50): Promise<LedgerEntry[]> {
  const normalized = wallet.toLowerCase();
  const result = await pool.query(
    sql(`SELECT al.* FROM internal.allowance_ledger al
     JOIN internal.billing_account_wallets baw ON baw.billing_account_id = al.billing_account_id
     WHERE baw.wallet_address = $1
     ORDER BY al.created_at DESC
     LIMIT $2`),
    [normalized, limit],
  );
  return result.rows.map(rowToLedger);
}

// --- Row mappers ---

function rowToAccount(row: Record<string, unknown>): BillingAccount {
  return {
    id: row.id as string,
    status: row.status as string,
    currency: row.currency as string,
    available_usd_micros: Number(row.available_usd_micros),
    held_usd_micros: Number(row.held_usd_micros),
    funding_policy: row.funding_policy as string,
    low_balance_threshold_usd_micros: Number(row.low_balance_threshold_usd_micros),
    primary_contact_email: row.primary_contact_email as string | null,
    tier: (row.tier as string) || null,
    lease_started_at: row.lease_started_at ? new Date(row.lease_started_at as string) : null,
    lease_expires_at: row.lease_expires_at ? new Date(row.lease_expires_at as string) : null,
    email_credits_remaining: row.email_credits_remaining !== undefined && row.email_credits_remaining !== null
      ? Number(row.email_credits_remaining)
      : 0,
    auto_recharge_enabled: Boolean(row.auto_recharge_enabled),
    auto_recharge_threshold: row.auto_recharge_threshold !== undefined && row.auto_recharge_threshold !== null
      ? Number(row.auto_recharge_threshold)
      : 2000,
    auto_recharge_failure_count: row.auto_recharge_failure_count !== undefined && row.auto_recharge_failure_count !== null
      ? Number(row.auto_recharge_failure_count)
      : 0,
    stripe_customer_id: (row.stripe_customer_id as string) || null,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

function rowToLedger(row: Record<string, unknown>): LedgerEntry {
  return {
    id: row.id as string,
    billing_account_id: row.billing_account_id as string,
    direction: row.direction as string,
    kind: row.kind as string,
    amount_usd_micros: Number(row.amount_usd_micros),
    balance_after_available: Number(row.balance_after_available),
    balance_after_held: Number(row.balance_after_held),
    reference_type: row.reference_type as string | null,
    reference_id: row.reference_id as string | null,
    idempotency_key: row.idempotency_key as string | null,
    metadata: row.metadata as Record<string, unknown> | null,
    created_at: new Date(row.created_at as string),
  };
}
