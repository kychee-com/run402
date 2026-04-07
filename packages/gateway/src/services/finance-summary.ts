/**
 * finance-summary service
 *
 * Thin composer that computes the top KPI card data (revenue / cost / margin)
 * for a given time window. Uses dependency-injected fetchers so it's
 * unit-testable without touching a real DB or AWS.
 *
 * Null-safe: when the AWS Cost Explorer cache is empty, cost and margin
 * are returned as null (not estimated from counter-derived cost alone,
 * which would overstate margin). The frontend renders "—" in those cards.
 */

import {
  windowToInterval,
  type FinanceWindow,
  type WindowRange,
  type PlatformRevenueResult,
  type PlatformCostResult,
} from "./finance-rollup.js";

export interface FinanceSummaryDeps {
  getPlatformRevenue: (range: WindowRange) => Promise<PlatformRevenueResult>;
  getPlatformCostFromCache: (range: WindowRange) => Promise<PlatformCostResult>;
  now: Date;
}

export interface FinanceSummaryResult {
  window: FinanceWindow;
  revenue_usd_micros: number;
  cost_usd_micros: number | null;
  margin_usd_micros: number | null;
  cost_source: {
    directly_attributable_usd_micros: number | null;
    shared_infra_usd_micros: number | null;
    cache_age_seconds: number | null;
    cache_status: "fresh" | "empty";
  };
  last_updated_at: Date;
}

export async function getFinanceSummary(
  window: FinanceWindow,
  deps: FinanceSummaryDeps,
): Promise<FinanceSummaryResult> {
  const range = windowToInterval(window, deps.now);

  const [revenue, cost] = await Promise.all([
    deps.getPlatformRevenue(range),
    deps.getPlatformCostFromCache(range),
  ]);

  const margin =
    cost.total_usd_micros === null
      ? null
      : revenue.total_usd_micros - cost.total_usd_micros;

  return {
    window,
    revenue_usd_micros: revenue.total_usd_micros,
    cost_usd_micros: cost.total_usd_micros,
    margin_usd_micros: margin,
    cost_source: {
      // MVP: we don't split directly-attributable vs shared here.
      // The cost breakdown endpoint (Phase 7) does that split.
      // For the summary card, "shared_infra" = the Cost Explorer total.
      directly_attributable_usd_micros: null,
      shared_infra_usd_micros: cost.total_usd_micros,
      cache_age_seconds: cost.cache_age_seconds,
      cache_status: cost.cache_status,
    },
    last_updated_at: deps.now,
  };
}
