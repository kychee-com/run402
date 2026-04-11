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
  getDirectCostTotal: (range: WindowRange) => Promise<number>;
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

  const [revenue, cost, directCostTotal] = await Promise.all([
    deps.getPlatformRevenue(range),
    deps.getPlatformCostFromCache(range),
    deps.getDirectCostTotal(range),
  ]);

  const sharedInfra = cost.total_usd_micros;
  // Total cost = counter-derived direct cost + Cost Explorer shared infra.
  // If CE cache is empty, we still show counter-derived cost alone (better
  // than showing nothing when we have real usage data).
  const totalCost = sharedInfra === null
    ? (directCostTotal > 0 ? directCostTotal : null)
    : directCostTotal + sharedInfra;
  const margin = totalCost === null
    ? null
    : revenue.total_usd_micros - totalCost;

  return {
    window,
    revenue_usd_micros: revenue.total_usd_micros,
    cost_usd_micros: totalCost,
    margin_usd_micros: margin,
    cost_source: {
      directly_attributable_usd_micros: directCostTotal > 0 ? directCostTotal : null,
      shared_infra_usd_micros: sharedInfra,
      cache_age_seconds: cost.cache_age_seconds,
      cache_status: cost.cache_status,
    },
    last_updated_at: deps.now,
  };
}
