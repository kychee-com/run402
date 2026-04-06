/**
 * Contract wallet provisioning + inspection service.
 *
 * Responsibilities:
 *   - provisionWallet: create a KMS-backed wallet, insert the row, debit the
 *     first day's rent — all atomically. The 30-day prepay check happens at
 *     the route layer (DD-12), not here.
 *   - getWallet / listWallets: project-scoped lookup, no cross-project leak.
 *   - setRecoveryAddress / setLowBalanceThreshold: simple updates.
 *
 * Note: balance reads from RPC are NOT done here — they happen at the route
 * layer to keep this service unit-testable without RPC dependencies.
 */

import { randomUUID } from "node:crypto";
import { sql } from "../db/sql.js";
import { pool } from "../db/pool.js";
import { HttpError } from "../utils/async-handler.js";
import { isSupportedChain } from "./chain-config.js";
import { createKmsKey } from "./kms-wallet.js";

export const KMS_WALLET_RENT_USD_MICROS_PER_DAY = 40_000;

export interface ContractWallet {
  id: string;
  project_id: string;
  kms_key_id: string | null;
  chain: string;
  address: string;
  status: "active" | "suspended" | "deleted";
  recovery_address: string | null;
  low_balance_threshold_wei: bigint;
  last_alert_sent_at: Date | null;
  last_rent_debited_on: string | null;
  suspended_at: Date | null;
  deleted_at: Date | null;
  last_warning_day: number | null;
  created_at: Date;
}

interface ProvisionWalletInput {
  projectId: string;
  billingAccountId: string;
  chain: string;
  recoveryAddress?: string | null;
}

export async function provisionWallet(input: ProvisionWalletInput): Promise<ContractWallet> {
  if (!isSupportedChain(input.chain)) {
    throw new HttpError(400, `unsupported_chain: ${input.chain}`, {
      error: "unsupported_chain",
    });
  }

  // Pre-check the recovery address is well-formed
  if (input.recoveryAddress != null) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(input.recoveryAddress)) {
      throw new HttpError(400, "invalid_recovery_address", { error: "invalid_recovery_address" });
    }
  }

  const walletId = `cwlt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  // 1. Create KMS key OUTSIDE the DB transaction. The KMS call has its own
  // failure mode and we don't want a multi-second DB tx held open while
  // KMS provisions a key. If KMS succeeds but the DB tx fails, we orphan
  // a KMS key — the deletion job + tag-orphan check will catch it.
  const kms = await createKmsKey(input.projectId, walletId);

  // Self-reference check (post KMS so we know the wallet's address)
  if (
    input.recoveryAddress &&
    input.recoveryAddress.toLowerCase() === kms.address.toLowerCase()
  ) {
    throw new HttpError(400, "recovery_address_self_reference", {
      error: "recovery_address_self_reference",
    });
  }

  const client = await pool.connect();
  try {
    await client.query(sql(`BEGIN`));

    // Lock the billing account, debit one day's rent
    const accountResult = await client.query(
      sql(`SELECT * FROM internal.billing_accounts WHERE id = $1 FOR UPDATE`),
      [input.billingAccountId],
    );
    if (accountResult.rows.length === 0) {
      throw new HttpError(404, "billing_account_not_found");
    }
    const currentAvailable = BigInt(accountResult.rows[0].available_usd_micros);
    if (currentAvailable < BigInt(KMS_WALLET_RENT_USD_MICROS_PER_DAY)) {
      throw new HttpError(402, "insufficient_balance_for_first_day_rent", {
        error: "insufficient_balance_for_first_day_rent",
        required_usd_micros: KMS_WALLET_RENT_USD_MICROS_PER_DAY,
        available_usd_micros: Number(currentAvailable),
      });
    }
    const newAvailable = currentAvailable - BigInt(KMS_WALLET_RENT_USD_MICROS_PER_DAY);

    // Insert wallet row with last_rent_debited_on = today
    await client.query(
      sql(`INSERT INTO internal.contract_wallets
       (id, project_id, kms_key_id, chain, address, status, recovery_address,
        low_balance_threshold_wei, last_rent_debited_on, created_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, 1000000000000000, CURRENT_DATE, NOW())`),
      [
        walletId,
        input.projectId,
        kms.kms_key_id,
        input.chain,
        kms.address,
        input.recoveryAddress ?? null,
      ],
    );

    // Debit cash + ledger entry
    await client.query(
      sql(`UPDATE internal.billing_accounts SET available_usd_micros = $1, updated_at = NOW() WHERE id = $2`),
      [newAvailable.toString(), input.billingAccountId],
    );

    const ledgerId = randomUUID();
    await client.query(
      sql(`INSERT INTO internal.allowance_ledger
       (id, billing_account_id, direction, kind, amount_usd_micros,
        balance_after_available, balance_after_held, reference_type, reference_id,
        idempotency_key, metadata)
       VALUES ($1, $2, 'debit', 'kms_wallet_rental', $3, $4, $5, 'contract_wallet', $6, $7, $8)`),
      [
        ledgerId,
        input.billingAccountId,
        KMS_WALLET_RENT_USD_MICROS_PER_DAY,
        newAvailable.toString(),
        "0",
        walletId,
        `kms_wallet_rental:${walletId}:${new Date().toISOString().slice(0, 10)}`,
        JSON.stringify({ wallet_id: walletId, day: new Date().toISOString().slice(0, 10), reason: "first_day_at_creation" }),
      ],
    );

    await client.query(sql(`COMMIT`));
  } catch (err) {
    try { await client.query(sql(`ROLLBACK`)); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }

  // Return the freshly inserted row shape (avoid a SELECT round-trip — the
  // caller has everything from the inputs + KMS result).
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: walletId,
    project_id: input.projectId,
    kms_key_id: kms.kms_key_id,
    chain: input.chain,
    address: kms.address,
    status: "active",
    recovery_address: input.recoveryAddress ?? null,
    low_balance_threshold_wei: BigInt("1000000000000000"),
    last_alert_sent_at: null,
    last_rent_debited_on: today,
    suspended_at: null,
    deleted_at: null,
    last_warning_day: null,
    created_at: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToWallet(row: any): ContractWallet {
  return {
    id: row.id,
    project_id: row.project_id,
    kms_key_id: row.kms_key_id ?? null,
    chain: row.chain,
    address: row.address,
    status: row.status as ContractWallet["status"],
    recovery_address: row.recovery_address ?? null,
    low_balance_threshold_wei: BigInt(row.low_balance_threshold_wei ?? "0"),
    last_alert_sent_at: row.last_alert_sent_at ? new Date(row.last_alert_sent_at) : null,
    last_rent_debited_on: row.last_rent_debited_on ? String(row.last_rent_debited_on).slice(0, 10) : null,
    suspended_at: row.suspended_at ? new Date(row.suspended_at) : null,
    deleted_at: row.deleted_at ? new Date(row.deleted_at) : null,
    last_warning_day: row.last_warning_day ?? null,
    created_at: new Date(row.created_at),
  };
}

export async function getWallet(walletId: string, projectId: string): Promise<ContractWallet | null> {
  const result = await pool.query(
    sql(`SELECT * FROM internal.contract_wallets WHERE id = $1`),
    [walletId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows[0].project_id !== projectId) return null;
  return rowToWallet(result.rows[0]);
}

export async function listWallets(projectId: string): Promise<ContractWallet[]> {
  const result = await pool.query(
    sql(`SELECT * FROM internal.contract_wallets WHERE project_id = $1 ORDER BY created_at DESC`),
    [projectId],
  );
  return result.rows.map(rowToWallet);
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export async function setRecoveryAddress(
  walletId: string,
  projectId: string,
  recoveryAddress: string | null,
): Promise<ContractWallet> {
  const wallet = await getWallet(walletId, projectId);
  if (!wallet) throw new HttpError(404, "not_found");
  if (wallet.status === "deleted") {
    throw new HttpError(410, "wallet_deleted", { error: "wallet_deleted" });
  }
  if (recoveryAddress != null) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(recoveryAddress)) {
      throw new HttpError(400, "invalid_recovery_address", { error: "invalid_recovery_address" });
    }
    if (recoveryAddress.toLowerCase() === wallet.address.toLowerCase()) {
      throw new HttpError(400, "recovery_address_self_reference", {
        error: "recovery_address_self_reference",
      });
    }
  }
  await pool.query(
    sql(`UPDATE internal.contract_wallets SET recovery_address = $1 WHERE id = $2`),
    [recoveryAddress, walletId],
  );
  return { ...wallet, recovery_address: recoveryAddress };
}

export async function setLowBalanceThreshold(
  walletId: string,
  projectId: string,
  thresholdWei: bigint,
): Promise<ContractWallet> {
  const wallet = await getWallet(walletId, projectId);
  if (!wallet) throw new HttpError(404, "not_found");
  await pool.query(
    sql(`UPDATE internal.contract_wallets SET low_balance_threshold_wei = $1 WHERE id = $2`),
    [thresholdWei.toString(), walletId],
  );
  return { ...wallet, low_balance_threshold_wei: thresholdWei };
}

export const NON_CUSTODIAL_NOTICE =
  "This wallet is non-custodial. You are responsible for funding ETH for gas, paying daily rent in cash credit, and either draining or setting a recovery address before suspension reaches 90 days. run402 will not recover funds from a deleted wallet.";
