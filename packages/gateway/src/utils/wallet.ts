import { pool } from "../db/pool.js";

/**
 * Extract the sender wallet address from an x402 payment header.
 * The header is base64 JSON: { payload: { authorization: { from: "0x..." } } }
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
 * Record a wallet sighting (fire-and-forget upsert).
 */
export function recordWallet(address: string, source: string): void {
  const normalized = address.toLowerCase();
  pool.query(
    `INSERT INTO internal.wallet_sightings (wallet_address, source)
     VALUES ($1, $2)
     ON CONFLICT (wallet_address) DO UPDATE SET last_seen_at = NOW()`,
    [normalized, source],
  ).catch(() => {});
}
