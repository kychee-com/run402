/**
 * finance-rollup service
 *
 * Pure SQL rollups for the admin Finance tab. All queries are live
 * (no caching — per DD-1 in design.md) and scoped by time window.
 *
 * Public surface:
 *  - windowToInterval(window, now) — converts UI window selection to {start, end}
 *  - getPlatformRevenue(query, range) — sum of all billing_topups for the window
 *  - getRevenueBreakdownByProject(query, range) — per-project stream-column breakdown
 *  - getDirectCostByProject(query, range, costRates) — counter × rate per category per project
 *  - getPlatformCostFromCache(query, range, now) — sum from aws_cost_cache with cache age
 *  - computeDriftReconciliation(counter, costExplorer) — pure drift calc
 *
 * All queries accept a dependency-injected `FinanceRollupQueryFn` so tests
 * can use canned responses without touching a real DB. In production, the
 * default queryFn wraps `pool.query`.
 */

import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";

export type FinanceWindow = "24h" | "7d" | "30d" | "90d";

// Rows are typed at the call site where we know each query's shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;
export type FinanceRollupQueryFn = (sqlText: string, params?: unknown[]) => Promise<{ rows: AnyRow[] }>;

/** Default query fn used in production — wraps the real pool. */
export const defaultFinanceQuery: FinanceRollupQueryFn = async (sqlText, params) => {
  return pool.query(sql(sqlText), params) as unknown as { rows: AnyRow[] };
};

export interface WindowRange {
  start: Date;
  end: Date;
}

/**
 * Map a UI window selection to a {start, end} range ending at `now`.
 * Throws on invalid window.
 */
export function windowToInterval(window: FinanceWindow, now: Date): WindowRange {
  const endMs = now.getTime();
  let durationMs: number;
  switch (window) {
    case "24h":
      durationMs = 24 * 60 * 60 * 1000;
      break;
    case "7d":
      durationMs = 7 * 24 * 60 * 60 * 1000;
      break;
    case "30d":
      durationMs = 30 * 24 * 60 * 60 * 1000;
      break;
    case "90d":
      durationMs = 90 * 24 * 60 * 60 * 1000;
      break;
    default:
      throw new Error(`invalid window: ${window}`);
  }
  return { start: new Date(endMs - durationMs), end: new Date(endMs) };
}

// --- Drift reconciliation ---------------------------------------------------

export interface DriftResult {
  drift_percentage: number | null;
  drift_warning: boolean;
}

/**
 * Pure function: compute the percentage drift between counter-derived cost
 * and Cost Explorer cost for the same categories. Returns null drift if
 * either value is null or the denominator is zero (avoids divide-by-zero).
 * Warning fires strictly above 5%.
 */
export function computeDriftReconciliation(
  counterDerived: number | null,
  costExplorer: number | null,
): DriftResult {
  if (counterDerived === null || costExplorer === null || costExplorer === 0) {
    return { drift_percentage: null, drift_warning: false };
  }
  const driftPct = (Math.abs(counterDerived - costExplorer) / costExplorer) * 100;
  return {
    drift_percentage: Math.round(driftPct * 100) / 100,
    drift_warning: driftPct > 5,
  };
}

// --- Revenue queries --------------------------------------------------------

export interface PlatformRevenueResult {
  total_usd_micros: number;
}

export async function getPlatformRevenue(
  query: FinanceRollupQueryFn,
  range: WindowRange,
): Promise<PlatformRevenueResult> {
  const result = await query(
    `SELECT COALESCE(SUM(funded_usd_micros), 0)::BIGINT AS total_usd_micros
     FROM internal.billing_topups
     WHERE status = 'credited'
       AND created_at >= $1
       AND created_at < $2`,
    [range.start, range.end],
  );
  const raw = result.rows[0]?.total_usd_micros;
  return { total_usd_micros: raw == null ? 0 : Number(raw) };
}

export interface ProjectRevenueRow {
  project_id: string;
  project_name: string;
  tier_fees_usd_micros: number;
  email_packs_usd_micros: number;
  kms_rental_usd_micros: number;
  kms_sign_fees_usd_micros: number;
  per_call_sku_usd_micros: number;
  total_usd_micros: number;
}

export interface RevenueBreakdownResult {
  projects: ProjectRevenueRow[];
  unattributed_usd_micros: number;
  total_usd_micros: number;
}

export async function getRevenueBreakdownByProject(
  query: FinanceRollupQueryFn,
  range: WindowRange,
): Promise<RevenueBreakdownResult> {
  // Per-project breakdown: topups joined via wallet_address → projects.wallet_address,
  // plus ledger entries for kms_wallet_rental and kms_sign_fee joined via
  // billing_account → billing_account_wallets → projects.wallet_address.
  // Per-call SKU entries are ledger 'image' or similar kinds.
  const perProjectResult = await query(
    `
    WITH topup_totals AS (
      SELECT
        p.id AS project_id,
        p.name AS project_name,
        SUM(CASE WHEN bt.topup_type = 'tier' THEN bt.funded_usd_micros ELSE 0 END)::BIGINT AS tier_fees,
        SUM(CASE WHEN bt.topup_type = 'email_pack' THEN bt.funded_usd_micros ELSE 0 END)::BIGINT AS email_packs
      FROM internal.billing_topups bt
      JOIN internal.projects p ON LOWER(p.wallet_address) = LOWER(bt.wallet_address)
      WHERE bt.status = 'credited'
        AND bt.created_at >= $1
        AND bt.created_at < $2
      GROUP BY p.id, p.name
    ),
    ledger_totals AS (
      SELECT
        p.id AS project_id,
        SUM(CASE WHEN al.kind = 'kms_wallet_rental' THEN ABS(al.amount_usd_micros) ELSE 0 END)::BIGINT AS kms_rental,
        SUM(CASE WHEN al.kind = 'kms_sign_fee' THEN ABS(al.amount_usd_micros) ELSE 0 END)::BIGINT AS kms_sign_fees,
        SUM(CASE WHEN al.kind IN ('image') THEN ABS(al.amount_usd_micros) ELSE 0 END)::BIGINT AS per_call_sku
      FROM internal.allowance_ledger al
      JOIN internal.billing_account_wallets baw ON baw.billing_account_id = al.billing_account_id
      JOIN internal.projects p ON LOWER(p.wallet_address) = LOWER(baw.wallet_address)
      WHERE al.created_at >= $1
        AND al.created_at < $2
      GROUP BY p.id
    )
    SELECT
      COALESCE(t.project_id, l.project_id) AS project_id,
      COALESCE(t.project_name, '(unnamed)') AS project_name,
      COALESCE(t.tier_fees, 0) AS tier_fees,
      COALESCE(t.email_packs, 0) AS email_packs,
      COALESCE(l.kms_rental, 0) AS kms_rental,
      COALESCE(l.kms_sign_fees, 0) AS kms_sign_fees,
      COALESCE(l.per_call_sku, 0) AS per_call_sku,
      COALESCE(t.tier_fees, 0) + COALESCE(t.email_packs, 0)
        + COALESCE(l.kms_rental, 0) + COALESCE(l.kms_sign_fees, 0) + COALESCE(l.per_call_sku, 0) AS total
    FROM topup_totals t
    FULL OUTER JOIN ledger_totals l USING (project_id)
    ORDER BY total DESC
    `,
    [range.start, range.end],
  );

  // Unattributed: topups whose wallet_address does NOT match any project.
  const unattributedResult = await query(
    `SELECT COALESCE(SUM(bt.funded_usd_micros), 0)::BIGINT AS unattributed_usd_micros
     FROM internal.billing_topups bt
     WHERE bt.status = 'credited'
       AND bt.created_at >= $1
       AND bt.created_at < $2
       AND (
         bt.wallet_address IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM internal.projects p
           WHERE LOWER(p.wallet_address) = LOWER(bt.wallet_address)
         )
       )`,
    [range.start, range.end],
  );

  const projects: ProjectRevenueRow[] = perProjectResult.rows
    .map((r) => ({
      project_id: r.project_id,
      project_name: r.project_name,
      tier_fees_usd_micros: Number(r.tier_fees),
      email_packs_usd_micros: Number(r.email_packs),
      kms_rental_usd_micros: Number(r.kms_rental),
      kms_sign_fees_usd_micros: Number(r.kms_sign_fees),
      per_call_sku_usd_micros: Number(r.per_call_sku),
      total_usd_micros: Number(r.total),
    }))
    // Drop noise: unnamed projects with zero revenue. Keep named-but-zero (operator
    // deliberately named them) and unnamed-but-with-revenue (the revenue matters).
    .filter((p) => {
      const isUnnamed = p.project_name == null || p.project_name === "" || p.project_name === "(unnamed)";
      return !(isUnnamed && p.total_usd_micros === 0);
    });
  const unattributedRaw = unattributedResult.rows[0]?.unattributed_usd_micros;
  const unattributed_usd_micros = unattributedRaw == null ? 0 : Number(unattributedRaw);
  const projectSum = projects.reduce((s, p) => s + p.total_usd_micros, 0);
  return {
    projects,
    unattributed_usd_micros,
    total_usd_micros: projectSum + unattributed_usd_micros,
  };
}

// --- Direct cost queries ----------------------------------------------------

export interface CostRatesBundle {
  ses_per_email_usd_micros: number;
  lambda_request_usd_micros: number;
  lambda_gb_second_usd_micros: number;
  s3_gb_month_usd_micros: number;
  kms_key_monthly_usd_micros: number;
  kms_sign_per_op_usd_micros: number;
}

export interface ProjectDirectCostRow {
  project_id: string;
  categories: Record<string, number>;
  total_usd_micros: number;
}

/**
 * Computes directly-attributable cost per project from usage counters × rates.
 * Six queries, one per category. Results are keyed by project_id and merged.
 *
 * Unit conventions (match the seeded cost_rates values):
 *  - ses × emails (micro-scale)
 *  - lambda requests: stored as "per-M requests × 1000" → divide by 1000, multiply by count
 *  - lambda GB-sec: micro-scale, multiply directly
 *  - s3: GB-month × 23000 (micro-scale); we compute pro-rata by window days
 *  - kms key monthly: $1/month; we bill N days / 30 days of a month
 *  - kms sign per op: multiply directly
 */
export async function getDirectCostByProject(
  query: FinanceRollupQueryFn,
  range: WindowRange,
  costRates: CostRatesBundle,
): Promise<ProjectDirectCostRow[]> {
  // Helper: accumulate per-project numeric values keyed by category.
  const byProject = new Map<string, Record<string, number>>();
  const add = (projectId: string, category: string, value: number) => {
    let row = byProject.get(projectId);
    if (!row) {
      row = {};
      byProject.set(projectId, row);
    }
    row[category] = (row[category] ?? 0) + value;
  };

  // Query 1: KMS wallet rent-days per project (count of days each active wallet was billed).
  // We compute rent-days = count(distinct date in range where last_rent_debited_on fell).
  // Simpler: for each wallet in range, rent-days = window overlap with wallet's active period.
  // For MVP: treat total_rent_days = COUNT of contract_wallets active at any point in window.
  const kmsRentResult = await query(
    `SELECT project_id, COUNT(*)::BIGINT AS total_rent_days
     FROM internal.contract_wallets
     WHERE created_at < $2
       AND (deleted_at IS NULL OR deleted_at >= $1)
     GROUP BY project_id`,
    [range.start, range.end],
  );
  for (const row of kmsRentResult.rows) {
    // kms_key_monthly_usd_micros is "$1/key/month". 30 days/month → per-day rate = rate/30.
    // But our seed is 1_000_000 for $1.00. For N wallet-days: N × 1_000_000 / 30.
    const days = Number(row.total_rent_days);
    const cost = Math.round((days * costRates.kms_key_monthly_usd_micros) / 30);
    add(row.project_id, "KMS wallet rental", cost);
  }

  // Query 2: contract call sign ops per project.
  const kmsSignResult = await query(
    `SELECT project_id, COUNT(*)::BIGINT AS total_signs
     FROM internal.contract_calls
     WHERE status IN ('confirmed', 'failed')
       AND created_at >= $1
       AND created_at < $2
     GROUP BY project_id`,
    [range.start, range.end],
  );
  for (const row of kmsSignResult.rows) {
    const signs = Number(row.total_signs);
    const cost = signs * costRates.kms_sign_per_op_usd_micros;
    add(row.project_id, "KMS sign ops", cost);
  }

  // Query 3: chain gas from ledger entries (exact, at-cost, already in USD-micros).
  // Joined to project via billing_account → billing_account_wallets → projects.wallet_address.
  const gasResult = await query(
    `SELECT p.id AS project_id, COALESCE(SUM(ABS(al.amount_usd_micros)), 0)::BIGINT AS total_gas_usd_micros
     FROM internal.allowance_ledger al
     JOIN internal.billing_account_wallets baw ON baw.billing_account_id = al.billing_account_id
     JOIN internal.projects p ON LOWER(p.wallet_address) = LOWER(baw.wallet_address)
     WHERE al.kind = 'contract_call_gas'
       AND al.created_at >= $1
       AND al.created_at < $2
     GROUP BY p.id`,
    [range.start, range.end],
  );
  for (const row of gasResult.rows) {
    add(row.project_id, "Chain gas passthrough", Number(row.total_gas_usd_micros));
  }

  // Query 4: email send count per project (via mailbox.project_id).
  const emailResult = await query(
    `SELECT m.project_id, COUNT(*)::BIGINT AS total_emails
     FROM internal.email_messages em
     JOIN internal.mailboxes m ON m.id = em.mailbox_id
     WHERE em.direction = 'outbound'
       AND em.created_at >= $1
       AND em.created_at < $2
     GROUP BY m.project_id`,
    [range.start, range.end],
  );
  for (const row of emailResult.rows) {
    const emails = Number(row.total_emails);
    const cost = emails * costRates.ses_per_email_usd_micros;
    add(row.project_id, "SES email send", cost);
  }

  // Query 5: Lambda invocations per project.
  // Note: we use the `projects.api_calls` counter as a proxy for Lambda invocations
  // for now — this is an approximation. Real Lambda counters per project would
  // require either CloudWatch logs or a dedicated function invocation counter.
  // GB-seconds we approximate by (invocations × avg_memory_gb × avg_duration_sec).
  // For MVP: assume 256 MB memory, 2 sec avg duration → 0.5 GB-sec per invocation.
  const lambdaResult = await query(
    `SELECT id AS project_id,
            api_calls::BIGINT AS total_invocations,
            (api_calls * 0.5)::BIGINT AS total_gb_seconds
     FROM internal.projects
     WHERE api_calls > 0`,
    [],
  );
  for (const row of lambdaResult.rows) {
    const invocations = Number(row.total_invocations);
    const gbSeconds = Number(row.total_gb_seconds);
    // Request cost: the stored value is "usd-micros per million requests × 1000"
    // so per-request cost in usd-micros = stored / 1000 / 1e6 × 1e6 = stored / 1000
    // For N requests: cost_usd_micros = N × stored / 1000
    const reqCost = Math.round((invocations * costRates.lambda_request_usd_micros) / 1000);
    // GB-second cost: stored rate is micro-scale, multiply directly
    const gbsCost = Math.round(gbSeconds * costRates.lambda_gb_second_usd_micros);
    add(row.project_id, "Lambda invocations", reqCost + gbsCost);
  }

  // Query 6: S3 storage — time-weighted average bytes × days × rate.
  // For MVP: take current storage_bytes as the average and pro-rate by window days.
  const storageResult = await query(
    `SELECT id AS project_id, storage_bytes::BIGINT AS avg_storage_bytes
     FROM internal.projects
     WHERE storage_bytes > 0`,
    [],
  );
  const windowDays = (range.end.getTime() - range.start.getTime()) / (24 * 60 * 60 * 1000);
  for (const row of storageResult.rows) {
    const bytes = Number(row.avg_storage_bytes);
    const gb = bytes / (1024 * 1024 * 1024);
    // Rate is per-GB-month. Pro-rate by windowDays / 30.
    const cost = Math.round(gb * windowDays * costRates.s3_gb_month_usd_micros / 30);
    add(row.project_id, "S3 storage", cost);
  }

  // Materialize
  const result: ProjectDirectCostRow[] = [];
  for (const [project_id, categories] of byProject.entries()) {
    const total = Object.values(categories).reduce((s, v) => s + v, 0);
    result.push({ project_id, categories, total_usd_micros: total });
  }
  // Sort by total descending
  result.sort((a, b) => b.total_usd_micros - a.total_usd_micros);
  return result;
}

// --- Platform cost from Cost Explorer cache ---------------------------------

export interface PlatformCostCategory {
  category: string;
  cost_usd_micros: number;
}

export interface PlatformCostResult {
  categories: PlatformCostCategory[];
  total_usd_micros: number | null;
  cache_age_seconds: number | null;
  cache_status: "fresh" | "empty";
}

export async function getPlatformCostFromCache(
  query: FinanceRollupQueryFn,
  range: WindowRange,
  now: Date,
): Promise<PlatformCostResult> {
  // Sum rows by category for days in the window.
  const categoriesResult = await query(
    `SELECT service_category, SUM(cost_usd_micros)::BIGINT AS total_usd_micros
     FROM internal.aws_cost_cache
     WHERE day >= $1::date
       AND day <= $2::date
     GROUP BY service_category
     ORDER BY total_usd_micros DESC`,
    [range.start, range.end],
  );

  // Latest fetched_at for cache age
  const ageResult = await query(
    `SELECT MAX(fetched_at) AS fetched_at FROM internal.aws_cost_cache`,
    [],
  );

  if (categoriesResult.rows.length === 0) {
    return {
      categories: [],
      total_usd_micros: null,
      cache_age_seconds: null,
      cache_status: "empty",
    };
  }

  const categories: PlatformCostCategory[] = categoriesResult.rows.map((r) => ({
    category: r.service_category,
    cost_usd_micros: Number(r.total_usd_micros),
  }));
  const total = categories.reduce((s, c) => s + c.cost_usd_micros, 0);
  const fetchedAt = ageResult.rows[0]?.fetched_at;
  const cacheAgeSeconds = fetchedAt instanceof Date
    ? Math.round((now.getTime() - fetchedAt.getTime()) / 1000)
    : null;

  return {
    categories,
    total_usd_micros: total,
    cache_age_seconds: cacheAgeSeconds,
    cache_status: "fresh",
  };
}
