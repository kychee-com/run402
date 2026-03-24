/**
 * Admin wallets service — manage wallet addresses authorized for admin API access.
 *
 * Stores admin wallets in internal.admin_wallets and maintains an in-memory
 * Set for fast lookups on every admin API request.
 */

import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";

const adminWallets = new Set<string>();

export async function initAdminWalletsTable(): Promise<void> {
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.admin_wallets (
      address    TEXT PRIMARY KEY,
      label      TEXT,
      added_by   TEXT NOT NULL,
      added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));

  // Load into memory
  const { rows } = await pool.query(sql(`SELECT address FROM internal.admin_wallets`));
  for (const row of rows) {
    adminWallets.add((row.address as string).toLowerCase());
  }
  console.log(`  Admin wallets loaded: ${adminWallets.size}`);
}

export function isAdminWallet(address: string): boolean {
  return adminWallets.has(address.toLowerCase());
}

export async function addAdminWallet(address: string, label: string | null, addedBy: string): Promise<void> {
  const normalized = address.toLowerCase();
  await pool.query(
    sql(`INSERT INTO internal.admin_wallets (address, label, added_by) VALUES ($1, $2, $3)
     ON CONFLICT (address) DO UPDATE SET label = $2, added_by = $3, added_at = NOW()`),
    [normalized, label, addedBy],
  );
  adminWallets.add(normalized);
}

export async function removeAdminWallet(address: string): Promise<boolean> {
  const normalized = address.toLowerCase();
  const result = await pool.query(sql(`DELETE FROM internal.admin_wallets WHERE address = $1`), [normalized]);
  adminWallets.delete(normalized);
  return (result.rowCount ?? 0) > 0;
}

export async function listAdminWallets(): Promise<Array<{ address: string; label: string | null; added_by: string; added_at: string }>> {
  const { rows } = await pool.query(sql(`SELECT address, label, added_by, added_at FROM internal.admin_wallets ORDER BY added_at DESC`));
  return rows as Array<{ address: string; label: string | null; added_by: string; added_at: string }>;
}
