/**
 * Reactivate KMS contract wallets after a billing-account top-up.
 *
 * This is a thin glue layer that exists in its own module so `billing.ts`
 * doesn't pull `wallet-rental.ts` (which transitively pulls KMS + viem)
 * during a top-up code path that has nothing else KMS-related.
 */

import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { reactivateProject } from "./wallet-rental.js";

export async function reactivateBillingAccountWallets(billingAccountId: string): Promise<number> {
  // Find every project whose owner wallet is linked to this billing account.
  const projectsResult = await pool.query(
    sql(`SELECT DISTINCT p.id FROM internal.projects p
     JOIN internal.billing_account_wallets baw ON baw.wallet_address = p.wallet_address
     WHERE baw.billing_account_id = $1 AND p.wallet_address IS NOT NULL`),
    [billingAccountId],
  );
  let total = 0;
  for (const row of projectsResult.rows) {
    const result = await reactivateProject(row.id);
    total += result.reactivated_count;
  }
  return total;
}
