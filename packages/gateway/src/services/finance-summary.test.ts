import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getFinanceSummary, type FinanceSummaryDeps } from "./finance-summary.js";

function makeDeps(overrides: Partial<FinanceSummaryDeps> = {}): FinanceSummaryDeps {
  return {
    getPlatformRevenue: async () => ({ total_usd_micros: 10_000_000 }),
    getPlatformCostFromCache: async () => ({
      categories: [{ category: "RDS", cost_usd_micros: 5_000_000 }],
      total_usd_micros: 5_000_000,
      cache_age_seconds: 3600,
      cache_status: "fresh" as const,
    }),
    now: new Date("2026-04-06T12:00:00Z"),
    ...overrides,
  };
}

describe("getFinanceSummary", () => {
  it("returns full summary with positive margin when cache is populated", async () => {
    const result = await getFinanceSummary("30d", makeDeps());
    assert.equal(result.window, "30d");
    assert.equal(result.revenue_usd_micros, 10_000_000);
    assert.equal(result.cost_usd_micros, 5_000_000);
    assert.equal(result.margin_usd_micros, 5_000_000);
    assert.equal(result.cost_source.cache_status, "fresh");
    assert.equal(result.cost_source.shared_infra_usd_micros, 5_000_000);
    assert.equal(result.cost_source.cache_age_seconds, 3600);
    assert.ok(result.last_updated_at instanceof Date);
  });

  it("returns negative margin when cost exceeds revenue", async () => {
    const deps = makeDeps({
      getPlatformRevenue: async () => ({ total_usd_micros: 3_000_000 }),
    });
    const result = await getFinanceSummary("30d", deps);
    assert.equal(result.margin_usd_micros, -2_000_000);
  });

  it("returns null cost and null margin when cache is empty", async () => {
    const deps = makeDeps({
      getPlatformCostFromCache: async () => ({
        categories: [],
        total_usd_micros: null,
        cache_age_seconds: null,
        cache_status: "empty" as const,
      }),
    });
    const result = await getFinanceSummary("30d", deps);
    assert.equal(result.revenue_usd_micros, 10_000_000);
    assert.equal(result.cost_usd_micros, null);
    assert.equal(result.margin_usd_micros, null);
    assert.equal(result.cost_source.cache_status, "empty");
  });

  it("passes the window through to both dependency calls", async () => {
    let revenueWindow: string | null = null;
    let costWindow: string | null = null;
    const deps = makeDeps({
      getPlatformRevenue: async (range) => {
        revenueWindow = range.end.getTime() - range.start.getTime() === 7 * 24 * 3600 * 1000 ? "7d" : "other";
        return { total_usd_micros: 0 };
      },
      getPlatformCostFromCache: async (range) => {
        costWindow = range.end.getTime() - range.start.getTime() === 7 * 24 * 3600 * 1000 ? "7d" : "other";
        return {
          categories: [],
          total_usd_micros: null,
          cache_age_seconds: null,
          cache_status: "empty" as const,
        };
      },
    });
    await getFinanceSummary("7d", deps);
    assert.equal(revenueWindow, "7d");
    assert.equal(costWindow, "7d");
  });
});
