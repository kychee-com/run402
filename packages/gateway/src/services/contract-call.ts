/**
 * Contract write-call orchestrator.
 *
 * Validates the wallet, parses the ABI, builds + signs + broadcasts the
 * transaction, and persists a `contract_calls` row. Status reconciliation
 * (gas + sign-fee ledger entries) lives in `contract-call-reconciler.ts`.
 *
 * Drains share the same orchestration via `submitDrainCall` — see DD-6.
 */

import { randomUUID } from "node:crypto";
import { sql } from "../db/sql.js";
import { encodeFunctionData, type Abi } from "viem";
import { pool } from "../db/pool.js";
import { HttpError } from "../utils/async-handler.js";
import { signDigest } from "./kms-wallet.js";
import { getWallet } from "./contract-wallets.js";
import {
  buildSignedTransaction,
  broadcastSignedTransaction,
  getNativeBalanceWei,
} from "./contract-call-tx.js";
import { isSupportedChain } from "./chain-config.js";

const DUST_WEI = BigInt(1000);

function newCallId(): string {
  return `ccall_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export interface SubmitContractCallInput {
  projectId: string;
  walletId: string;
  chain: string;
  contractAddress: string;
  abiFragment: Abi;
  functionName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[];
  valueWei?: bigint;
  idempotencyKey?: string;
}

export interface SubmitResult {
  call_id: string;
  tx_hash: string;
  status: "pending" | "failed";
}

export async function submitContractCall(input: SubmitContractCallInput): Promise<SubmitResult> {
  // Chain check
  if (!isSupportedChain(input.chain)) {
    throw new HttpError(400, "unsupported_chain");
  }

  // Idempotency lookup
  if (input.idempotencyKey) {
    const dup = await pool.query(
      sql(`SELECT id, tx_hash, status FROM internal.contract_calls
       WHERE project_id = $1 AND idempotency_key = $2 LIMIT 1`),
      [input.projectId, input.idempotencyKey],
    );
    if (dup.rows.length > 0) {
      const r = dup.rows[0];
      return { call_id: r.id, tx_hash: r.tx_hash, status: r.status };
    }
  }

  // Wallet check
  const wallet = await getWallet(input.walletId, input.projectId);
  if (!wallet) {
    throw new HttpError(404, "wallet_not_found");
  }
  if (wallet.status === "deleted") {
    throw new HttpError(410, "wallet_deleted", { error: "wallet_deleted" });
  }
  if (wallet.status === "suspended") {
    throw new HttpError(402, "wallet_suspended_unpaid_rent", {
      error: "wallet_suspended_unpaid_rent",
      wallet_id: wallet.id,
      suspended_at: wallet.suspended_at,
      required_top_up_usd_micros: 40000,
    });
  }
  if (wallet.chain !== input.chain) {
    throw new HttpError(400, "chain_mismatch");
  }

  // ABI parsing + function existence
  let data: `0x${string}`;
  try {
    if (!Array.isArray(input.abiFragment)) {
      throw new Error("abi must be an array");
    }
    const fnExists = input.abiFragment.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) => e?.type === "function" && e?.name === input.functionName,
    );
    if (!fnExists) throw new Error(`function ${input.functionName} not in ABI`);
    data = encodeFunctionData({
      abi: input.abiFragment,
      functionName: input.functionName,
      args: input.args,
    });
  } catch (err) {
    throw new HttpError(400, "invalid_abi", { error: "invalid_abi", detail: (err as Error).message });
  }

  // Native balance check
  const balance = await getNativeBalanceWei(wallet.address, wallet.chain);
  const valueWei = input.valueWei ?? BigInt(0);
  if (balance < valueWei) {
    throw new HttpError(402, "insufficient_native_balance", {
      error: "insufficient_native_balance",
      required_wei: valueWei.toString(),
      available_wei: balance.toString(),
    });
  }

  // Build + sign + broadcast
  const callId = newCallId();
  let txHash: string;
  let status: "pending" | "failed" = "pending";
  let errMsg: string | null = null;
  try {
    const built = await buildSignedTransaction(
      {
        chainName: wallet.chain,
        fromAddress: wallet.address,
        toAddress: input.contractAddress,
        data,
        valueWei,
      },
      async (digest32, walletAddress) => {
        const sig = await signDigest(wallet.kms_key_id!, digest32, walletAddress);
        return { r: sig.r, s: sig.s, v: sig.v };
      },
    );
    if (balance < built.estimatedGasCostWei + valueWei) {
      throw new HttpError(402, "insufficient_native_balance", {
        error: "insufficient_native_balance",
        required_wei: (built.estimatedGasCostWei + valueWei).toString(),
        available_wei: balance.toString(),
      });
    }
    const result = await broadcastSignedTransaction(built.serializedSigned, wallet.chain);
    txHash = result.tx_hash;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    status = "failed";
    txHash = "";
    errMsg = (err as Error).message ?? "broadcast_failed";
  }

  // Persist row regardless of success/failure
  await pool.query(
    sql(`INSERT INTO internal.contract_calls
     (id, wallet_id, project_id, chain, contract_address, function_name,
      args_json, idempotency_key, tx_hash, status, error, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, NOW(), NOW())`),
    [
      callId,
      wallet.id,
      input.projectId,
      input.chain,
      input.contractAddress,
      input.functionName,
      JSON.stringify(input.args),
      input.idempotencyKey ?? null,
      txHash || null,
      status,
      errMsg,
    ],
  );

  if (status === "failed" && errMsg) {
    throw new HttpError(502, "broadcast_failed", {
      call_id: callId,
      status: "failed",
      error: errMsg,
    });
  }

  return { call_id: callId, tx_hash: txHash, status };
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

export interface SubmitDrainInput {
  projectId: string;
  walletId: string;
  destinationAddress: string;
}

export async function submitDrainCall(input: SubmitDrainInput): Promise<SubmitResult> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.destinationAddress)) {
    throw new HttpError(400, "invalid_destination_address");
  }

  const wallet = await getWallet(input.walletId, input.projectId);
  if (!wallet) throw new HttpError(404, "wallet_not_found");
  if (wallet.status === "deleted") {
    throw new HttpError(410, "wallet_deleted", { error: "wallet_deleted" });
  }
  // Drains intentionally allowed on suspended wallets (DD-6 / safety valve).

  const balance = await getNativeBalanceWei(wallet.address, wallet.chain);
  if (balance < DUST_WEI) {
    throw new HttpError(409, "nothing_to_drain", {
      error: "nothing_to_drain",
      balance_wei: balance.toString(),
    });
  }

  const callId = newCallId();
  let txHash = "";
  let status: "pending" | "failed" = "pending";
  let errMsg: string | null = null;
  try {
    const built = await buildSignedTransaction(
      {
        chainName: wallet.chain,
        fromAddress: wallet.address,
        toAddress: input.destinationAddress,
        data: "0x",
        valueWei: balance > BigInt(0) ? balance / BigInt(2) : BigInt(0), // placeholder; refined post-gas estimate
      },
      async (digest32, walletAddress) => {
        const sig = await signDigest(wallet.kms_key_id!, digest32, walletAddress);
        return { r: sig.r, s: sig.s, v: sig.v };
      },
    );
    // Recompute the actual drain value: balance - estimated gas cost
    const drainValue = balance - built.estimatedGasCostWei;
    if (drainValue <= BigInt(0)) {
      throw new HttpError(409, "nothing_to_drain", {
        error: "nothing_to_drain",
        balance_wei: balance.toString(),
        estimated_gas_cost_wei: built.estimatedGasCostWei.toString(),
      });
    }
    // Re-build with exact value
    const finalBuilt = await buildSignedTransaction(
      {
        chainName: wallet.chain,
        fromAddress: wallet.address,
        toAddress: input.destinationAddress,
        data: "0x",
        valueWei: drainValue,
      },
      async (digest32, walletAddress) => {
        const sig = await signDigest(wallet.kms_key_id!, digest32, walletAddress);
        return { r: sig.r, s: sig.s, v: sig.v };
      },
    );
    const result = await broadcastSignedTransaction(finalBuilt.serializedSigned, wallet.chain);
    txHash = result.tx_hash;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    status = "failed";
    errMsg = (err as Error).message ?? "drain_broadcast_failed";
  }

  await pool.query(
    sql(`INSERT INTO internal.contract_calls
     (id, wallet_id, project_id, chain, contract_address, function_name,
      args_json, idempotency_key, tx_hash, status, error, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, '<drain>', $6::jsonb, NULL, $7, $8, $9, NOW(), NOW())`),
    [
      callId,
      wallet.id,
      input.projectId,
      wallet.chain,
      input.destinationAddress,
      JSON.stringify({ destination: input.destinationAddress }),
      txHash || null,
      status,
      errMsg,
    ],
  );

  if (status === "failed" && errMsg) {
    throw new HttpError(502, "drain_broadcast_failed", {
      call_id: callId,
      status: "failed",
      error: errMsg,
    });
  }

  return { call_id: callId, tx_hash: txHash, status };
}
