import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  handleSummaryRequest,
  handleRevenueRequest,
  handleCostsRequest,
  handleProjectRequest,
  handleExportRequest,
  handleRefreshCostsRequest,
  handleRefreshPricingRequest,
  parseWindowParam,
  type FinanceRouteDeps,
} from "./admin-finance.js";

// Mock express req/res helpers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockReq(overrides: any = {}): Request {
  return {
    headers: { cookie: "run402_admin=fake.fake" },
    query: {},
    params: {},
    ...overrides,
  } as Request;
}

interface TrackedRes extends Response {
  _status: number;
  _body: unknown;
  _text: string | undefined;
  _headers: Record<string, string>;
}

function mockRes(): TrackedRes {
  const res: Partial<TrackedRes> = {
    _status: 200,
    _body: undefined,
    _text: undefined,
    _headers: {},
  };
  res.status = function (code: number) { (this as TrackedRes)._status = code; return this as TrackedRes; };
  res.json = function (body: unknown) { (this as TrackedRes)._body = body; return this as TrackedRes; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).set = function (name: string, value: string) { (this as TrackedRes)._headers[name] = value; return this as TrackedRes; };
  res.type = function (t: string) { (this as TrackedRes)._headers["Content-Type"] = t; return this as TrackedRes; };
  res.send = function (text: string) { (this as TrackedRes)._text = text; return this as TrackedRes; };
  return res as TrackedRes;
}

function makeDeps(overrides: Partial<FinanceRouteDeps> = {}): FinanceRouteDeps {
  return {
    requireSession: () => ({ email: "admin@kychee.com", name: "Admin" }),
    getSummary: async () => ({
      window: "30d",
      revenue_usd_micros: 10_000_000,
      cost_usd_micros: 5_000_000,
      margin_usd_micros: 5_000_000,
      cost_source: {
        directly_attributable_usd_micros: null,
        shared_infra_usd_micros: 5_000_000,
        cache_age_seconds: 3600,
        cache_status: "fresh" as const,
      },
      last_updated_at: new Date(),
    }),
    getRevenueBreakdown: async () => ({
      projects: [{
        project_id: "proj_a",
        project_name: "Test",
        tier_fees_usd_micros: 5_000_000,
        email_packs_usd_micros: 0,
        kms_rental_usd_micros: 1_200_000,
        kms_sign_fees_usd_micros: 450_000,
        per_call_sku_usd_micros: 0,
        total_usd_micros: 6_650_000,
      }],
      unattributed_usd_micros: 0,
      total_usd_micros: 6_650_000,
      truncated: false,
    }),
    getCostBreakdown: async () => ({
      window: "30d",
      categories: [
        { category: "RDS", source: "cost_explorer", cost_usd_micros: 30_000_000, percentage_of_total: 60 },
        { category: "KMS wallet rental", source: "counter", cost_usd_micros: 1_200_000, percentage_of_total: 2.4 },
      ],
      directly_attributable_total: 1_200_000,
      shared_infra_total: 30_000_000,
      total_usd_micros: 31_200_000,
      reconciliation: {
        counter_derived_usd_micros: 1_200_000,
        cost_explorer_usd_micros: 1_100_000,
        drift_percentage: 9.09,
        drift_warning: true,
      },
    }),
    getProjectFinance: async (projectId) => {
      if (projectId === "not_found") return null;
      return {
        project_id: projectId,
        project_name: "Test Project",
        window: "30d",
        revenue_usd_micros: 6_650_000,
        direct_cost_usd_micros: 1_650_000,
        direct_margin_usd_micros: 5_000_000,
        revenue_breakdown: {
          tier_fees_usd_micros: 5_000_000,
          email_packs_usd_micros: 0,
          kms_rental_usd_micros: 1_200_000,
          kms_sign_fees_usd_micros: 450_000,
          per_call_sku_usd_micros: 0,
        },
        direct_cost_breakdown: [
          { category: "KMS wallet rental", cost_usd_micros: 1_200_000 },
          { category: "Chain gas passthrough", cost_usd_micros: 450_000 },
        ],
        notes: "Direct costs only. Shared infrastructure overhead is not allocated to individual projects.",
      };
    },
    refreshCostExplorer: async () => ({
      refreshed_at: new Date(),
      rows_upserted: 5,
      cost_explorer_call_count: 1,
    }),
    refreshPricingRates: async () => ({
      updated: [{ key: "ses_per_email_usd_micros", old_value: 100, new_value: 110 }],
      unchanged: ["lambda_request_usd_micros"],
      errors: [],
    }),
    ...overrides,
  };
}

describe("admin-finance routes — parseWindowParam", () => {
  it("defaults to 30d when missing", () => {
    assert.equal(parseWindowParam(undefined), "30d");
    assert.equal(parseWindowParam(""), "30d");
  });
  it("accepts valid windows", () => {
    assert.equal(parseWindowParam("24h"), "24h");
    assert.equal(parseWindowParam("7d"), "7d");
    assert.equal(parseWindowParam("30d"), "30d");
    assert.equal(parseWindowParam("90d"), "90d");
  });
  it("throws on invalid windows", () => {
    assert.throws(() => parseWindowParam("1y"), /invalid_window/);
    assert.throws(() => parseWindowParam("abc"), /invalid_window/);
  });
  it("rejects array params (avoid query string tricks)", () => {
    assert.throws(() => parseWindowParam(["7d", "30d"] as unknown as string), /invalid_window/);
  });
});

describe("admin-finance routes — GET /admin/api/finance/summary", () => {
  it("returns 200 with valid session and default window", async () => {
    const res = mockRes();
    await handleSummaryRequest(mockReq(), res, makeDeps());
    assert.equal(res._status, 200);
    const body = res._body as Record<string, unknown>;
    assert.ok(body.revenue_usd_micros);
    assert.ok(body.cost_usd_micros);
    assert.ok(body.margin_usd_micros);
  });

  it("returns 401 without session", async () => {
    const res = mockRes();
    await handleSummaryRequest(mockReq(), res, makeDeps({ requireSession: () => null }));
    assert.equal(res._status, 401);
  });

  it("returns 400 on invalid window", async () => {
    const res = mockRes();
    await handleSummaryRequest(mockReq({ query: { window: "1y" } }), res, makeDeps());
    assert.equal(res._status, 400);
    const body = res._body as Record<string, unknown>;
    assert.equal((body as { error?: string }).error, "invalid_window");
  });
});

describe("admin-finance routes — GET /admin/api/finance/revenue", () => {
  it("returns revenue breakdown", async () => {
    const res = mockRes();
    await handleRevenueRequest(mockReq(), res, makeDeps());
    assert.equal(res._status, 200);
    const body = res._body as { projects: unknown[]; total_usd_micros: number };
    assert.equal(body.projects.length, 1);
    assert.equal(body.total_usd_micros, 6_650_000);
  });
});

describe("admin-finance routes — GET /admin/api/finance/costs", () => {
  it("returns cost breakdown with reconciliation", async () => {
    const res = mockRes();
    await handleCostsRequest(mockReq(), res, makeDeps());
    assert.equal(res._status, 200);
    const body = res._body as { categories: unknown[]; reconciliation: { drift_warning: boolean } };
    assert.equal(body.categories.length, 2);
    assert.equal(body.reconciliation.drift_warning, true);
  });
});

describe("admin-finance routes — GET /admin/api/finance/project/:id", () => {
  it("returns per-project finance data", async () => {
    const res = mockRes();
    await handleProjectRequest(
      mockReq({ params: { id: "proj_a" } }),
      res,
      makeDeps(),
    );
    assert.equal(res._status, 200);
    const body = res._body as { project_id: string; revenue_usd_micros: number };
    assert.equal(body.project_id, "proj_a");
  });

  it("returns 404 for unknown project", async () => {
    const res = mockRes();
    await handleProjectRequest(
      mockReq({ params: { id: "not_found" } }),
      res,
      makeDeps(),
    );
    assert.equal(res._status, 404);
  });

  it("returns 401 without session", async () => {
    const res = mockRes();
    await handleProjectRequest(
      mockReq({ params: { id: "proj_a" } }),
      res,
      makeDeps({ requireSession: () => null }),
    );
    assert.equal(res._status, 401);
  });
});

describe("admin-finance routes — GET /admin/api/finance/export", () => {
  it("returns platform CSV with multi-section body", async () => {
    const res = mockRes();
    await handleExportRequest(
      mockReq({ query: { scope: "platform", window: "30d", format: "csv" } }),
      res,
      makeDeps(),
    );
    assert.equal(res._status, 200);
    assert.equal(res._headers["Content-Type"], "text/csv; charset=utf-8");
    assert.match(res._headers["Content-Disposition"], /attachment; filename="run402-finance-platform-30d-/);
    assert.ok(res._text);
    // Three sections separated by blank lines
    const text = res._text as string;
    assert.match(text, /Platform Summary/);
    assert.match(text, /Revenue Breakdown by Project/);
    assert.match(text, /Cost Breakdown by Category/);
    assert.match(text, /TOTAL/);
  });

  it("returns project CSV with project-scoped body", async () => {
    const res = mockRes();
    await handleExportRequest(
      mockReq({ query: { scope: "project", id: "proj_a", window: "30d", format: "csv" } }),
      res,
      makeDeps(),
    );
    assert.equal(res._status, 200);
    const text = res._text as string;
    assert.match(text, /Project Summary/);
    assert.match(text, /Revenue Breakdown/);
    assert.match(text, /Direct Cost Breakdown/);
  });

  it("returns 400 for missing id on project scope", async () => {
    const res = mockRes();
    await handleExportRequest(
      mockReq({ query: { scope: "project", window: "30d", format: "csv" } }),
      res,
      makeDeps(),
    );
    assert.equal(res._status, 400);
  });

  it("returns 400 for unsupported format", async () => {
    const res = mockRes();
    await handleExportRequest(
      mockReq({ query: { scope: "platform", window: "30d", format: "json" } }),
      res,
      makeDeps(),
    );
    assert.equal(res._status, 400);
    const body = res._body as { error: string };
    assert.equal(body.error, "unsupported_format");
  });
});

describe("admin-finance routes — POST /admin/api/finance/refresh-costs", () => {
  it("triggers Cost Explorer pull and returns result", async () => {
    const res = mockRes();
    await handleRefreshCostsRequest(mockReq(), res, makeDeps());
    assert.equal(res._status, 200);
    const body = res._body as { rows_upserted: number };
    assert.equal(body.rows_upserted, 5);
  });

  it("returns 429 when rate limited", async () => {
    const res = mockRes();
    await handleRefreshCostsRequest(
      mockReq(),
      res,
      makeDeps({
        refreshCostExplorer: async () => {
          throw new Error("rate limit: wait 30s");
        },
      }),
    );
    assert.equal(res._status, 429);
  });

  it("returns 502 on Cost Explorer API failure", async () => {
    const res = mockRes();
    await handleRefreshCostsRequest(
      mockReq(),
      res,
      makeDeps({
        refreshCostExplorer: async () => {
          throw new Error("AWS: AccessDenied");
        },
      }),
    );
    assert.equal(res._status, 502);
  });
});

describe("admin-finance routes — POST /admin/api/finance/refresh-pricing", () => {
  it("returns diff of updated rates", async () => {
    const res = mockRes();
    await handleRefreshPricingRequest(mockReq(), res, makeDeps());
    assert.equal(res._status, 200);
    const body = res._body as { updated: unknown[]; unchanged: unknown[] };
    assert.equal(body.updated.length, 1);
    assert.equal(body.unchanged.length, 1);
  });
});
