/**
 * Project lifecycle state machine.
 *
 *   active ──lease_exp──▶ past_due ──+14d──▶ frozen ──+30d──▶ dormant ──+60d──▶ purged
 *     ▲                       │                  │                │
 *     └────────renewal / topup / tier upgrade────┴────────────────┘
 *
 * - `advanceLifecycle()` runs all pending transitions across all projects in one tick.
 *   Called hourly from the scheduler (see services/leases.ts).
 * - `advanceLifecycleForWallet(wallet)` is called synchronously after tier
 *   subscribe/renew/upgrade so owners who just paid don't have to wait for the
 *   next hourly tick to regain control-plane access.
 *
 * Every forward transition uses an UPDATE ... RETURNING guard, so two concurrent
 * ticks cannot both act on the same row. Transitions are idempotent: a tick
 * that sees a row already in the correct state for current time makes no changes.
 *
 * Pinned projects (`pinned = true`) are skipped entirely — they remain `active`
 * regardless of lease state.
 */

import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { purgeProject, projectCache } from "./projects.js";
import { sendPlatformEmail } from "./platform-mail.js";
import {
  renderPastDueEmail,
  renderFrozenEmail,
  renderFinalWarningEmail,
} from "./project-email-templates.js";
import { errorMessage } from "../utils/errors.js";
import { LIFECYCLE_ENABLED } from "../config.js";

// Grace durations. Exported for tests and for email templates that need to
// name the exact next-transition date.
export const PAST_DUE_DURATION_MS = 14 * 24 * 60 * 60 * 1000;
export const FROZEN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const DORMANT_DURATION_MS = 60 * 24 * 60 * 60 * 1000;
export const PURGE_TAIL_MS = 14 * 24 * 60 * 60 * 1000; // subdomain reservation persists this long past purge
export const FINAL_WARNING_LEAD_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Email: lookup billing contact and render the three lifecycle templates.
// ---------------------------------------------------------------------------

/**
 * Resolve the billing-contact email for a project.
 *
 * Follows project → wallet → billing_account_wallets → billing_accounts.
 * Returns null if the project has no wallet, no billing account, or no
 * primary_contact_email on file.
 */
export async function lookupBillingEmailForProject(projectId: string): Promise<string | null> {
  const result = await pool.query(
    sql(`SELECT ba.primary_contact_email
     FROM internal.projects p
     JOIN internal.billing_account_wallets baw ON LOWER(baw.wallet_address) = LOWER(p.wallet_address)
     JOIN internal.billing_accounts ba ON ba.id = baw.billing_account_id
     WHERE p.id = $1 LIMIT 1`),
    [projectId],
  );
  return result.rows[0]?.primary_contact_email ?? null;
}

interface LifecycleEmailContext {
  projectId: string;
  projectName: string;
  nextTransitionAt: Date;
}

async function emailPastDue(ctx: LifecycleEmailContext): Promise<void> {
  const to = await lookupBillingEmailForProject(ctx.projectId);
  if (!to) { console.warn(`[lifecycle] no billing email for ${ctx.projectId}, skipping past_due email`); return; }
  await sendPlatformEmail({
    to,
    ...renderPastDueEmail({
      projectName: ctx.projectName,
      frozenOn: ctx.nextTransitionAt.toISOString().slice(0, 10),
    }),
  });
}

async function emailFrozen(ctx: LifecycleEmailContext): Promise<void> {
  const to = await lookupBillingEmailForProject(ctx.projectId);
  if (!to) { console.warn(`[lifecycle] no billing email for ${ctx.projectId}, skipping frozen email`); return; }
  await sendPlatformEmail({
    to,
    ...renderFrozenEmail({
      projectName: ctx.projectName,
      dormantOn: ctx.nextTransitionAt.toISOString().slice(0, 10),
    }),
  });
}

async function emailPurgeFinalWarning(ctx: LifecycleEmailContext & { scheduledPurgeAt: Date }): Promise<void> {
  const to = await lookupBillingEmailForProject(ctx.projectId);
  if (!to) { console.warn(`[lifecycle] no billing email for ${ctx.projectId}, skipping purge_final_warning email`); return; }
  await sendPlatformEmail({
    to,
    ...renderFinalWarningEmail({
      projectName: ctx.projectName,
      scheduledPurgeAt: ctx.scheduledPurgeAt.toISOString(),
    }),
  });
}

// ---------------------------------------------------------------------------
// Transitions. Each returns the rows that it acted on, so the caller can
// enqueue emails, write subdomain reservations, etc.
// ---------------------------------------------------------------------------

interface LifecycleRow {
  id: string;
  name: string;
  past_due_since: Date | null;
  frozen_at: Date | null;
  dormant_at: Date | null;
  scheduled_purge_at: Date | null;
}

/**
 * Advance projects whose wallet lease has expired but who are still `active`
 * (excluding pinned projects) to `past_due`.
 */
async function transitionActiveToPastDue(): Promise<LifecycleRow[]> {
  const result = await pool.query(
    sql(`UPDATE internal.projects p
     SET status = 'past_due',
         past_due_since = NOW()
     WHERE p.status = 'active'
       AND p.pinned = false
       AND EXISTS (
         SELECT 1
         FROM internal.billing_account_wallets baw
         JOIN internal.billing_accounts ba ON ba.id = baw.billing_account_id
         WHERE LOWER(baw.wallet_address) = LOWER(p.wallet_address)
           AND ba.lease_expires_at IS NOT NULL
           AND ba.lease_expires_at < NOW()
       )
     RETURNING id, name, past_due_since, frozen_at, dormant_at, scheduled_purge_at`),
  );
  return result.rows as LifecycleRow[];
}

/**
 * Advance `past_due` projects whose 14-day window has elapsed to `frozen`.
 * Also writes subdomain reservation columns for each frozen project.
 */
async function transitionPastDueToFrozen(): Promise<LifecycleRow[]> {
  const client = await pool.connect();
  try {
    await client.query(sql("BEGIN"));
    const result = await client.query(
      sql(`UPDATE internal.projects
       SET status = 'frozen',
           frozen_at = NOW()
       WHERE status = 'past_due'
         AND past_due_since IS NOT NULL
         AND past_due_since < NOW() - INTERVAL '14 days'
       RETURNING id, name, past_due_since, frozen_at, dormant_at, scheduled_purge_at`),
    );
    const rows = result.rows as LifecycleRow[];

    // Reserve subdomains for the whole ~104-day tail (frozen 30 + dormant 60 + purge tail 14).
    for (const row of rows) {
      await client.query(
        sql(`UPDATE internal.subdomains
         SET reserved_for_project_id = $1,
             reserved_until = NOW() + INTERVAL '104 days'
         WHERE project_id = $1`),
        [row.id],
      );
    }

    await client.query(sql("COMMIT"));
    return rows;
  } catch (err) {
    await client.query(sql("ROLLBACK"));
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Advance `frozen` projects whose 30-day window has elapsed to `dormant`,
 * stamping `scheduled_purge_at = NOW() + 60d`.
 */
async function transitionFrozenToDormant(): Promise<LifecycleRow[]> {
  const result = await pool.query(
    sql(`UPDATE internal.projects
     SET status = 'dormant',
         dormant_at = NOW(),
         scheduled_purge_at = NOW() + INTERVAL '60 days'
     WHERE status = 'frozen'
       AND frozen_at IS NOT NULL
       AND frozen_at < NOW() - INTERVAL '30 days'
     RETURNING id, name, past_due_since, frozen_at, dormant_at, scheduled_purge_at`),
  );
  return result.rows as LifecycleRow[];
}

/**
 * Stamp `purge_warning_sent_at` on dormant projects within 24h of purge
 * that haven't yet been warned. Returns the rows so emails can be sent.
 */
async function transitionDormantToFinalWarning(): Promise<LifecycleRow[]> {
  const result = await pool.query(
    sql(`UPDATE internal.projects
     SET purge_warning_sent_at = NOW()
     WHERE status = 'dormant'
       AND scheduled_purge_at IS NOT NULL
       AND scheduled_purge_at < NOW() + INTERVAL '24 hours'
       AND purge_warning_sent_at IS NULL
     RETURNING id, name, past_due_since, frozen_at, dormant_at, scheduled_purge_at`),
  );
  return result.rows as LifecycleRow[];
}

/**
 * Return dormant projects whose scheduled_purge_at has elapsed, claimed via
 * the same row-level update guard used by other transitions (intermediate
 * status `'purging'` prevents concurrent ticks from double-purging).
 */
async function claimDormantForPurge(): Promise<LifecycleRow[]> {
  const result = await pool.query(
    sql(`UPDATE internal.projects
     SET status = 'purging'
     WHERE status = 'dormant'
       AND scheduled_purge_at IS NOT NULL
       AND scheduled_purge_at <= NOW()
     RETURNING id, name, past_due_since, frozen_at, dormant_at, scheduled_purge_at`),
  );
  return result.rows as LifecycleRow[];
}

/**
 * Transition a project back to `active` from any non-terminal grace state.
 * Clears all timer columns and clears subdomain reservations owned by the
 * project. Idempotent on `active` projects.
 */
async function transitionToActive(projectId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query(sql("BEGIN"));
    const result = await client.query(
      sql(`UPDATE internal.projects
       SET status = 'active',
           past_due_since = NULL,
           frozen_at = NULL,
           dormant_at = NULL,
           scheduled_purge_at = NULL,
           purge_warning_sent_at = NULL
       WHERE id = $1
         AND status IN ('past_due', 'frozen', 'dormant')
       RETURNING id`),
      [projectId],
    );
    const changed = (result.rowCount ?? 0) > 0;
    if (changed) {
      await client.query(
        sql(`UPDATE internal.subdomains
         SET reserved_for_project_id = NULL,
             reserved_until = NULL
         WHERE reserved_for_project_id = $1`),
        [projectId],
      );
    }
    await client.query(sql("COMMIT"));
    if (changed) {
      // Invalidate the project cache so the next request sees the new status.
      projectCache.delete(projectId);
    }
    return changed;
  } catch (err) {
    await client.query(sql("ROLLBACK"));
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Public API: orchestrate transitions + emails.
// ---------------------------------------------------------------------------

/**
 * Run every forward transition in order on every matching project. This is the
 * single entry point called from the hourly scheduler tick. A failure in one
 * transition does not prevent the others from running.
 */
export async function advanceLifecycle(): Promise<void> {
  if (!LIFECYCLE_ENABLED) return;

  // 1. active → past_due
  try {
    const rows = await transitionActiveToPastDue();
    for (const row of rows) {
      console.log(`  [lifecycle] ${row.id} (${row.name}): active → past_due`);
      projectCache.delete(row.id);
      try {
        await emailPastDue({
          projectId: row.id,
          projectName: row.name,
          nextTransitionAt: new Date(Date.now() + PAST_DUE_DURATION_MS),
        });
      } catch (err) { console.error(`  [lifecycle] past_due email failed for ${row.id}:`, errorMessage(err)); }
    }
  } catch (err) { console.error("  [lifecycle] active → past_due failed:", errorMessage(err)); }

  // 2. past_due → frozen
  try {
    const rows = await transitionPastDueToFrozen();
    for (const row of rows) {
      console.log(`  [lifecycle] ${row.id} (${row.name}): past_due → frozen`);
      try {
        await emailFrozen({
          projectId: row.id,
          projectName: row.name,
          nextTransitionAt: new Date(Date.now() + FROZEN_DURATION_MS),
        });
      } catch (err) { console.error(`  [lifecycle] frozen email failed for ${row.id}:`, errorMessage(err)); }
    }
  } catch (err) { console.error("  [lifecycle] past_due → frozen failed:", errorMessage(err)); }

  // 3. frozen → dormant
  try {
    const rows = await transitionFrozenToDormant();
    for (const row of rows) {
      console.log(`  [lifecycle] ${row.id} (${row.name}): frozen → dormant (purge scheduled ${row.scheduled_purge_at})`);
    }
  } catch (err) { console.error("  [lifecycle] frozen → dormant failed:", errorMessage(err)); }

  // 4. dormant 24h final warning
  try {
    const rows = await transitionDormantToFinalWarning();
    for (const row of rows) {
      console.log(`  [lifecycle] ${row.id} (${row.name}): final warning (purge at ${row.scheduled_purge_at})`);
      if (!row.scheduled_purge_at) continue;
      try {
        await emailPurgeFinalWarning({
          projectId: row.id,
          projectName: row.name,
          nextTransitionAt: row.scheduled_purge_at,
          scheduledPurgeAt: row.scheduled_purge_at,
        });
      } catch (err) { console.error(`  [lifecycle] final warning email failed for ${row.id}:`, errorMessage(err)); }
    }
  } catch (err) { console.error("  [lifecycle] final warning failed:", errorMessage(err)); }

  // 5. dormant → purged (terminal)
  try {
    const claimed = await claimDormantForPurge();
    for (const row of claimed) {
      console.log(`  [lifecycle] ${row.id} (${row.name}): dormant → purging`);
      try {
        await purgeProject(row.id);
        console.log(`  [lifecycle] ${row.id}: purged`);
      } catch (err) {
        console.error(`  [lifecycle] purge failed for ${row.id}:`, errorMessage(err));
        // Revert to dormant so a later tick can retry.
        try {
          await pool.query(
            sql(`UPDATE internal.projects SET status = 'dormant' WHERE id = $1 AND status = 'purging'`),
            [row.id],
          );
        } catch (revertErr) { console.error(`  [lifecycle] revert to dormant failed for ${row.id}:`, errorMessage(revertErr)); }
      }
    }
  } catch (err) { console.error("  [lifecycle] dormant → purged failed:", errorMessage(err)); }
}

/**
 * Reactivate a single project. Called by the topup/renewal/upgrade hooks in
 * wallet-tiers.ts so owners who just paid don't have to wait for the next
 * hourly tick. No-op if the project is already `active` or terminal.
 */
export async function advanceLifecycleForProject(projectId: string): Promise<boolean> {
  if (!LIFECYCLE_ENABLED) return false;
  try {
    return await transitionToActive(projectId);
  } catch (err) {
    console.error(`  [lifecycle] reactivate failed for ${projectId}:`, errorMessage(err));
    return false;
  }
}

/**
 * Reactivate every non-terminal project owned by the given wallet. Best-effort:
 * individual failures are logged, never thrown. Called after tier subscribe /
 * renew / upgrade.
 */
export async function advanceLifecycleForWallet(walletAddress: string): Promise<void> {
  if (!LIFECYCLE_ENABLED) return;
  try {
    const result = await pool.query(
      sql(`SELECT id FROM internal.projects
       WHERE LOWER(wallet_address) = LOWER($1)
         AND status IN ('past_due', 'frozen', 'dormant')`),
      [walletAddress],
    );
    for (const row of result.rows) {
      await advanceLifecycleForProject(row.id);
    }
  } catch (err) {
    console.error(`  [lifecycle] reactivate wallet ${walletAddress} failed:`, errorMessage(err));
  }
}
