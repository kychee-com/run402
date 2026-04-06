/**
 * Contract wallet HTTP API — `/contracts/v1/...`
 *
 * All routes require `serviceKeyAuth` (per-project service key) and
 * resolve project_id via `req.project!.id`.
 *
 * Endpoints:
 *   POST   /contracts/v1/wallets                       — provision wallet (30-day prepay gate)
 *   GET    /contracts/v1/wallets                       — list project wallets
 *   GET    /contracts/v1/wallets/:id                   — wallet metadata + live native balance
 *   POST   /contracts/v1/wallets/:id/recovery-address  — set/clear recovery address
 *   POST   /contracts/v1/wallets/:id/alert             — set low-balance threshold
 *   POST   /contracts/v1/wallets/:id/drain             — drain to destination (X-Confirm-Drain)
 *   DELETE /contracts/v1/wallets/:id                   — explicit delete (X-Confirm-Delete)
 *   POST   /contracts/v1/call                          — submit write call
 *   POST   /contracts/v1/read                          — submit read call
 *   GET    /contracts/v1/calls/:id                     — call status / receipt
 */

import { Router, Request, Response } from "express";
import { sql } from "../db/sql.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { pool } from "../db/pool.js";
import { isSupportedChain } from "../services/chain-config.js";
import {
  provisionWallet,
  getWallet,
  listWallets,
  setRecoveryAddress,
  setLowBalanceThreshold,
  KMS_WALLET_RENT_USD_MICROS_PER_DAY,
  NON_CUSTODIAL_NOTICE,
} from "../services/contract-wallets.js";
import { submitContractCall, submitDrainCall } from "../services/contract-call.js";
import { readContract } from "../services/contract-read.js";
import { getNativeBalanceWei } from "../services/contract-call-tx.js";
import { getCachedEthUsdPrice } from "../services/eth-usd-price.js";
import { scheduleKeyDeletion } from "../services/kms-wallet.js";

const router = Router();

const PREPAY_REQUIRED_USD_MICROS = 30 * KMS_WALLET_RENT_USD_MICROS_PER_DAY; // = 1_200_000

// Helper: resolve a project's billing account id (best-effort).
async function getProjectBillingAccountId(projectId: string): Promise<{ id: string; available_usd_micros: number } | null> {
  const result = await pool.query(
    sql(`SELECT ba.id, ba.available_usd_micros
     FROM internal.billing_accounts ba
     JOIN internal.billing_account_wallets baw ON baw.billing_account_id = ba.id
     JOIN internal.projects p ON p.wallet_address = baw.wallet_address
     WHERE p.id = $1
     LIMIT 1`),
    [projectId],
  );
  if (result.rows.length === 0) return null;
  return {
    id: result.rows[0].id,
    available_usd_micros: Number(result.rows[0].available_usd_micros),
  };
}

interface WalletJson {
  id: string;
  project_id: string;
  chain: string;
  address: string;
  status: string;
  recovery_address: string | null;
  low_balance_threshold_wei: string;
  last_alert_sent_at: string | null;
  last_rent_debited_on: string | null;
  suspended_at: string | null;
  deleted_at: string | null;
  created_at: string;
  native_balance_wei?: string;
  native_balance_usd_micros?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walletToJson(w: any, balance?: bigint, ethUsd?: number): WalletJson {
  const json: WalletJson = {
    id: w.id,
    project_id: w.project_id,
    chain: w.chain,
    address: w.address,
    status: w.status,
    recovery_address: w.recovery_address,
    low_balance_threshold_wei: w.low_balance_threshold_wei.toString(),
    last_alert_sent_at: w.last_alert_sent_at ? new Date(w.last_alert_sent_at).toISOString() : null,
    last_rent_debited_on: w.last_rent_debited_on,
    suspended_at: w.suspended_at ? new Date(w.suspended_at).toISOString() : null,
    deleted_at: w.deleted_at ? new Date(w.deleted_at).toISOString() : null,
    created_at: w.created_at instanceof Date ? w.created_at.toISOString() : new Date(w.created_at).toISOString(),
  };
  if (balance != null) {
    json.native_balance_wei = balance.toString();
    if (ethUsd != null) {
      const balanceEth = Number(balance) / 1e18;
      json.native_balance_usd_micros = Math.round(balanceEth * ethUsd * 1_000_000);
    }
  }
  return json;
}

// ---------------------------------------------------------------------------
// POST /contracts/v1/wallets — provision
// ---------------------------------------------------------------------------

router.post("/contracts/v1/wallets", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project!.id;
  const { chain, recovery_address: recoveryAddress } = req.body || {};

  if (typeof chain !== "string" || !isSupportedChain(chain)) {
    throw new HttpError(400, "unsupported_chain", { error: "unsupported_chain", supported: ["base-mainnet", "base-sepolia"] });
  }
  if (recoveryAddress != null && (typeof recoveryAddress !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(recoveryAddress))) {
    throw new HttpError(400, "invalid_recovery_address", { error: "invalid_recovery_address" });
  }

  // 30-day prepay gate (DD-12)
  const ba = await getProjectBillingAccountId(projectId);
  if (!ba) {
    throw new HttpError(402, "no_billing_account", {
      error: "no_billing_account",
      detail: "Project has no billing account. Create one by topping up first.",
      non_custodial_notice: NON_CUSTODIAL_NOTICE,
    });
  }
  if (ba.available_usd_micros < PREPAY_REQUIRED_USD_MICROS) {
    throw new HttpError(402, "insufficient_balance_for_30_day_prepay", {
      error: "insufficient_balance_for_30_day_prepay",
      required_usd_micros: PREPAY_REQUIRED_USD_MICROS,
      available_usd_micros: ba.available_usd_micros,
      non_custodial_notice: NON_CUSTODIAL_NOTICE,
    });
  }

  const wallet = await provisionWallet({
    projectId,
    billingAccountId: ba.id,
    chain,
    recoveryAddress: recoveryAddress ?? null,
  });

  res.status(201).json({
    ...walletToJson(wallet, BigInt(0), 0),
    native_balance_wei: "0",
    native_balance_usd_micros: 0,
    non_custodial_notice: NON_CUSTODIAL_NOTICE,
  });
}));

// ---------------------------------------------------------------------------
// GET /contracts/v1/wallets — list
// ---------------------------------------------------------------------------

router.get("/contracts/v1/wallets", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project!.id;
  const wallets = await listWallets(projectId);
  res.json({ wallets: wallets.map((w) => walletToJson(w)) });
}));

// ---------------------------------------------------------------------------
// GET /contracts/v1/wallets/:id — single
// ---------------------------------------------------------------------------

router.get("/contracts/v1/wallets/:id", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project!.id;
  const wallet = await getWallet(req.params.id as string, projectId);
  if (!wallet) throw new HttpError(404, "wallet_not_found");
  let balance: bigint | undefined;
  let ethUsd: number | undefined;
  if (wallet.status !== "deleted") {
    try {
      balance = await getNativeBalanceWei(wallet.address, wallet.chain);
      ethUsd = await getCachedEthUsdPrice(wallet.chain);
    } catch (err) {
      console.error("[contracts] balance fetch failed:", err);
    }
  }
  res.json(walletToJson(wallet, balance, ethUsd));
}));

// ---------------------------------------------------------------------------
// POST /contracts/v1/wallets/:id/recovery-address
// ---------------------------------------------------------------------------

router.post("/contracts/v1/wallets/:id/recovery-address", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project!.id;
  const { recovery_address: recoveryAddress } = req.body || {};
  if (recoveryAddress != null && (typeof recoveryAddress !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(recoveryAddress))) {
    throw new HttpError(400, "invalid_recovery_address");
  }
  const wallet = await setRecoveryAddress(req.params.id as string, projectId, recoveryAddress ?? null);
  res.json(walletToJson(wallet));
}));

// ---------------------------------------------------------------------------
// POST /contracts/v1/wallets/:id/alert
// ---------------------------------------------------------------------------

router.post("/contracts/v1/wallets/:id/alert", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project!.id;
  const { threshold_wei: thresholdWei } = req.body || {};
  if (typeof thresholdWei !== "string" && typeof thresholdWei !== "number") {
    throw new HttpError(400, "invalid_threshold_wei");
  }
  let thresholdBig: bigint;
  try {
    thresholdBig = BigInt(thresholdWei);
  } catch {
    throw new HttpError(400, "invalid_threshold_wei");
  }
  const wallet = await setLowBalanceThreshold(req.params.id as string, projectId, thresholdBig);
  res.json(walletToJson(wallet));
}));

// ---------------------------------------------------------------------------
// POST /contracts/v1/wallets/:id/drain
// ---------------------------------------------------------------------------

router.post("/contracts/v1/wallets/:id/drain", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project!.id;
  const walletId = req.params.id as string;
  const confirm = req.headers["x-confirm-drain"] as string | undefined;
  if (confirm !== walletId) {
    throw new HttpError(400, "drain_confirmation_required", {
      error: "drain_confirmation_required",
      expected_header: `X-Confirm-Drain: ${walletId}`,
    });
  }
  const { destination_address: destinationAddress } = req.body || {};
  if (typeof destinationAddress !== "string") {
    throw new HttpError(400, "invalid_destination_address");
  }
  const result = await submitDrainCall({ projectId, walletId, destinationAddress });
  res.status(202).json(result);
}));

// ---------------------------------------------------------------------------
// DELETE /contracts/v1/wallets/:id
// ---------------------------------------------------------------------------

const DUST_WEI = BigInt(1000);

router.delete("/contracts/v1/wallets/:id", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project!.id;
  const walletId = req.params.id as string;
  const confirm = req.headers["x-confirm-delete"] as string | undefined;
  if (confirm !== walletId) {
    throw new HttpError(400, "delete_confirmation_required", {
      error: "delete_confirmation_required",
      expected_header: `X-Confirm-Delete: ${walletId}`,
    });
  }
  const wallet = await getWallet(walletId, projectId);
  if (!wallet) throw new HttpError(404, "wallet_not_found");
  if (wallet.status === "deleted") {
    res.status(200).json({ id: wallet.id, status: "deleted", deleted_at: wallet.deleted_at });
    return;
  }
  // Refuse if balance > dust
  const balance = await getNativeBalanceWei(wallet.address, wallet.chain);
  if (balance >= DUST_WEI) {
    throw new HttpError(409, "wallet_has_funds", {
      error: "wallet_has_funds",
      address: wallet.address,
      native_balance_wei: balance.toString(),
      instructions: "Drain the wallet on-chain before deleting. The on-chain balance is yours; we cannot recover it after deletion.",
    });
  }
  // Schedule KMS deletion
  await scheduleKeyDeletion(wallet.kms_key_id!);
  await pool.query(
    sql(`UPDATE internal.contract_wallets
     SET status = 'deleted', deleted_at = NOW(), kms_key_id = NULL
     WHERE id = $1`),
    [walletId],
  );
  const kmsCompletes = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  res.json({ id: walletId, status: "deleted", deleted_at: new Date().toISOString(), kms_deletion_completes_at: kmsCompletes.toISOString() });
}));

// ---------------------------------------------------------------------------
// POST /contracts/v1/call
// ---------------------------------------------------------------------------

router.post("/contracts/v1/call", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project!.id;
  const { wallet_id, contract_address, abi_fragment, function_name, args, value, chain } = req.body || {};
  if (typeof wallet_id !== "string" || typeof contract_address !== "string" || typeof function_name !== "string" || !Array.isArray(args)) {
    throw new HttpError(400, "invalid_request");
  }
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
  const result = await submitContractCall({
    projectId,
    walletId: wallet_id,
    chain: chain || "base-mainnet",
    contractAddress: contract_address,
    abiFragment: abi_fragment,
    functionName: function_name,
    args,
    valueWei: value != null ? BigInt(value) : undefined,
    idempotencyKey,
  });
  res.status(202).json(result);
}));

// ---------------------------------------------------------------------------
// POST /contracts/v1/read
// ---------------------------------------------------------------------------

router.post("/contracts/v1/read", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const { chain, contract_address, abi_fragment, function_name, args } = req.body || {};
  if (typeof chain !== "string" || typeof contract_address !== "string" || typeof function_name !== "string" || !Array.isArray(args)) {
    throw new HttpError(400, "invalid_request");
  }
  const result = await readContract({
    chain,
    contractAddress: contract_address,
    abiFragment: abi_fragment,
    functionName: function_name,
    args,
  });
  // Serialize bigints
  res.json({ result: JSON.parse(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) });
}));

// ---------------------------------------------------------------------------
// GET /contracts/v1/calls/:id
// ---------------------------------------------------------------------------

router.get("/contracts/v1/calls/:id", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project!.id;
  const callId = req.params.id as string;
  const result = await pool.query(
    sql(`SELECT * FROM internal.contract_calls WHERE id = $1 LIMIT 1`),
    [callId],
  );
  if (result.rows.length === 0) throw new HttpError(404, "call_not_found");
  if (result.rows[0].project_id !== projectId) throw new HttpError(404, "call_not_found");
  const r = result.rows[0];
  res.json({
    id: r.id,
    wallet_id: r.wallet_id,
    chain: r.chain,
    contract_address: r.contract_address,
    function_name: r.function_name,
    tx_hash: r.tx_hash,
    status: r.status,
    gas_used_wei: r.gas_used_wei?.toString() ?? null,
    gas_cost_usd_micros: r.gas_cost_usd_micros ?? null,
    receipt: r.receipt_json,
    error: r.error,
    created_at: r.created_at,
    updated_at: r.updated_at,
  });
}));

export default router;
