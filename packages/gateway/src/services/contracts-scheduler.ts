/**
 * Background scheduler for the KMS contract-wallet feature.
 *
 * Wires four jobs into setInterval loops:
 *   - reconcilePendingCalls       — every 30s
 *   - debitDailyRent              — every 30s (idempotent on UTC date)
 *   - processSuspensionGrace      — every 30s
 *   - checkLowBalances            — every 10 min
 *
 * Each job is wrapped in a try/catch so a failure on one tick never kills
 * the loop. On boot we run every job once immediately so a long restart
 * window doesn't skip work.
 */

import { errorMessage } from "../utils/errors.js";
import { reconcilePendingCalls } from "./contract-call-reconciler.js";
import { debitDailyRent, reactivateProject as _ } from "./wallet-rental.js";
import { processSuspensionGrace, type SuspensionGraceDeps } from "./wallet-deletion.js";
import { checkLowBalances } from "./wallet-balance-alerts.js";
import { getNativeBalanceWei } from "./contract-call-tx.js";
import { scheduleKeyDeletion } from "./kms-wallet.js";
import { submitDrainCall } from "./contract-call.js";
import { sendPlatformEmail } from "./platform-mail.js";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";

void _; // re-export safety

const FAST_INTERVAL_MS = 30 * 1000;
const SLOW_INTERVAL_MS = 10 * 60 * 1000;

let fastInterval: ReturnType<typeof setInterval> | null = null;
let slowInterval: ReturnType<typeof setInterval> | null = null;

const deletionDeps: SuspensionGraceDeps = {
  getBalanceWei: (addr, chain) => getNativeBalanceWei(addr, chain || "base-mainnet"),
  scheduleKmsKeyDeletion: async (keyId) => { await scheduleKeyDeletion(keyId); },
  submitDrainCall: async (walletId, dest) => {
    // Look up the project_id from the wallet row.
    const r = await pool.query(
      sql(`SELECT project_id FROM internal.contract_wallets WHERE id = $1`),
      [walletId],
    );
    if (r.rows.length === 0) throw new Error(`wallet ${walletId} not found`);
    const projectId = r.rows[0].project_id as string;
    const result = await submitDrainCall({
      projectId,
      walletId,
      destinationAddress: dest,
    });
    return { call_id: result.call_id, tx_hash: result.tx_hash };
  },
  sendWarningEmail: async (walletId, daysLeft) => {
    const email = await lookupBillingEmailForWallet(walletId);
    if (!email) return;
    await sendPlatformEmail({
      to: email,
      subject: `URGENT: Your run402 contract wallet will be deleted in ${daysLeft} days`,
      html: `<p>Your run402 KMS contract wallet <code>${walletId}</code> has been suspended for ${90 - daysLeft} days. It will be permanently deleted in <strong>${daysLeft} days</strong>.</p><p>run402 does not hold funds on your behalf. If you do not take action (top up cash, drain the wallet, or set a recovery address) before deletion, the on-chain funds at this address will become permanently inaccessible to anyone, including run402.</p><p>Reactivate by topping up your cash balance, drain via the API, or set a recovery address now.</p>`,
      text: `Your run402 contract wallet ${walletId} will be deleted in ${daysLeft} days. run402 does not hold funds on your behalf — top up, drain, or set a recovery address now.`,
    });
  },
  sendFundLossEmail: async (walletId) => {
    const email = await lookupBillingEmailForWallet(walletId);
    if (!email) return;
    await sendPlatformEmail({
      to: email,
      subject: `Your run402 contract wallet ${walletId} has been deleted (funds lost)`,
      html: `<p>The KMS key for wallet <code>${walletId}</code> has been destroyed after 90 days of suspension and no recovery address was set. These funds cannot be recovered by run402, AWS, or any third party. The cryptographic key that controlled this address has been destroyed. run402 is not a custodian and has no obligation to compensate for this loss. You were notified on day 60, day 75, and day 88 of suspension.</p>`,
      text: `Your run402 contract wallet ${walletId} has been deleted. The on-chain funds at this address are permanently inaccessible. run402 is not a custodian.`,
    });
  },
  sendDrainConfirmEmail: async (walletId) => {
    const email = await lookupBillingEmailForWallet(walletId);
    if (!email) return;
    await sendPlatformEmail({
      to: email,
      subject: `run402 contract wallet ${walletId} auto-drained + deleted`,
      html: `<p>Your run402 KMS contract wallet <code>${walletId}</code> reached 90 days of suspension. We auto-drained the on-chain balance to the recovery address you set, then scheduled the KMS key for deletion (7-day window).</p>`,
      text: `Your run402 contract wallet ${walletId} was auto-drained to your recovery address and deleted.`,
    });
  },
};

async function lookupBillingEmailForWallet(walletId: string): Promise<string | null> {
  const r = await pool.query(
    sql(`SELECT ba.primary_contact_email
     FROM internal.contract_wallets cw
     JOIN internal.projects p ON p.id = cw.project_id
     JOIN internal.billing_account_wallets baw ON baw.wallet_address = p.wallet_address
     JOIN internal.billing_accounts ba ON ba.id = baw.billing_account_id
     WHERE cw.id = $1 LIMIT 1`),
    [walletId],
  );
  return r.rows[0]?.primary_contact_email ?? null;
}

async function fastTick(): Promise<void> {
  try { await reconcilePendingCalls(); } catch (err) { console.error("[contracts-scheduler] reconciler:", errorMessage(err)); }
  try { await debitDailyRent(); } catch (err) { console.error("[contracts-scheduler] daily rent:", errorMessage(err)); }
  try { await processSuspensionGrace(deletionDeps); } catch (err) { console.error("[contracts-scheduler] suspension grace:", errorMessage(err)); }
}

async function slowTick(): Promise<void> {
  try { await checkLowBalances(); } catch (err) { console.error("[contracts-scheduler] low balances:", errorMessage(err)); }
}

export async function startContractsScheduler(): Promise<void> {
  // Run once at boot
  await fastTick();
  await slowTick();
  fastInterval = setInterval(() => { void fastTick(); }, FAST_INTERVAL_MS);
  slowInterval = setInterval(() => { void slowTick(); }, SLOW_INTERVAL_MS);
  console.log("  Contracts scheduler started (30s fast / 10m slow)");
}

export function stopContractsScheduler(): void {
  if (fastInterval) clearInterval(fastInterval);
  if (slowInterval) clearInterval(slowInterval);
  fastInterval = null;
  slowInterval = null;
}
