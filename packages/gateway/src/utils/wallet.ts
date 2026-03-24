import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";

/**
 * Extract the sender wallet address from an x402 payment header.
 * The header is base64 JSON: { payload: { authorization: { from: "0x..." } } }
 *
 * x402 v2 uses `payment-signature` header (or `x-payment`).
 * Legacy clients may use `x-402-payment`.
 */
export function extractWalletFromPaymentHeader(header: string): string | null {
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString());
    const from = decoded.payload?.authorization?.from;
    return from?.startsWith("0x") ? from.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Get the payment header from a request, checking all known header names.
 * x402 v2: `payment-signature` or `x-payment`
 * Legacy: `x-402-payment`
 */
export function getPaymentHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
  return (headers["payment-signature"] || headers["x-payment"] || headers["x-402-payment"]) as string | undefined;
}

/**
 * Record a wallet sighting (fire-and-forget upsert).
 */
export function recordWallet(address: string, source: string): void {
  const normalized = address.toLowerCase();
  pool.query(
    sql(`INSERT INTO internal.wallet_sightings (wallet_address, source)
     VALUES ($1, $2)
     ON CONFLICT (wallet_address) DO UPDATE SET last_seen_at = NOW()`),
    [normalized, source],
  ).catch(() => {});
}
