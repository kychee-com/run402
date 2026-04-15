/**
 * Admin Finance dashboard — revenue / cost / margin breakdown for operators.
 *
 * All routes live under /admin/api/finance/* and are gated behind the
 * existing /admin Google OAuth session (@kychee.com only).
 *
 * Handlers are split into pure functions (handleXxxRequest) that take a
 * dependency bundle for testability. The Express router at the bottom
 * wires them to real services.
 *
 * Routes:
 *   GET  /admin/finance                           — HTML page (Finance tab)
 *   GET  /admin/api/finance/summary?window=...    — KPI cards JSON
 *   GET  /admin/api/finance/revenue?window=...    — revenue breakdown
 *   GET  /admin/api/finance/costs?window=...      — cost breakdown + drift
 *   GET  /admin/api/finance/project/:id?window=.. — per-project finance
 *   GET  /admin/api/finance/export?scope=...      — CSV export (platform/project)
 *   POST /admin/api/finance/refresh-costs         — manual Cost Explorer pull
 *   POST /admin/api/finance/refresh-pricing       — manual Pricing API pull
 */

import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import { ADMIN_SESSION_SECRET } from "../config.js";
import { asyncHandler } from "../utils/async-handler.js";
import {
  windowToInterval,
  getPlatformRevenue as realGetPlatformRevenue,
  getRevenueBreakdownByProject as realGetRevenueBreakdownByProject,
  getDirectCostByProject as realGetDirectCostByProject,
  getPlatformCostFromCache as realGetPlatformCostFromCache,
  computeDriftReconciliation,
  defaultFinanceQuery,
  type FinanceWindow,
  type RevenueBreakdownResult,
  type ProjectDirectCostRow,
  type PlatformCostResult,
} from "../services/finance-rollup.js";
import { getFinanceSummary, type FinanceSummaryResult } from "../services/finance-summary.js";
import { createFinanceCache } from "../services/finance-cache.js";
import { getAllCostRates, type CostRateRow } from "../services/cost-rates.js";
import { manualCostRefresh, createAwsCostExplorerClient, type ManualRefreshResult } from "../services/aws-cost-fetcher.js";
import { refreshPricingRates, createAwsPricingClient, type RefreshPricingResult } from "../services/aws-pricing-fetcher.js";
import { updateCostRates } from "../services/cost-rates.js";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";

const SESSION_COOKIE = "run402_admin";

// ------------------------------------------------------------------
// Session (local copy matching admin-dashboard.ts / admin-wallet.ts)
// ------------------------------------------------------------------

function hmacSign(payload: string): string {
  return crypto.createHmac("sha256", ADMIN_SESSION_SECRET).update(payload).digest("hex");
}

function getSession(req: Request): { email: string; name: string } | null {
  const raw = req.headers.cookie?.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  const cookie = raw.split("=").slice(1).join("=");
  const [b64, sig] = cookie.split(".");
  if (!b64 || !sig) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(hmacSign(b64), "hex"), Buffer.from(sig, "hex"))) return null;
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(b64, "base64url").toString());
    if (data.exp < Date.now()) return null;
    return { email: data.email, name: data.name };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Window param parsing
// ------------------------------------------------------------------

export function parseWindowParam(raw: string | undefined | string[]): FinanceWindow {
  if (Array.isArray(raw)) {
    throw new Error("invalid_window: array parameter not allowed");
  }
  if (raw === undefined || raw === "") return "30d";
  if (raw === "24h" || raw === "7d" || raw === "30d" || raw === "90d") return raw;
  throw new Error(`invalid_window: ${raw}`);
}

// ------------------------------------------------------------------
// Dependency injection shape for testable handlers
// ------------------------------------------------------------------

export interface ProjectFinanceResult {
  project_id: string;
  project_name: string;
  window: FinanceWindow;
  revenue_usd_micros: number;
  direct_cost_usd_micros: number;
  direct_margin_usd_micros: number;
  revenue_breakdown: {
    tier_fees_usd_micros: number;
    email_packs_usd_micros: number;
    kms_rental_usd_micros: number;
    kms_sign_fees_usd_micros: number;
    per_call_sku_usd_micros: number;
  };
  direct_cost_breakdown: Array<{ category: string; cost_usd_micros: number }>;
  notes: string;
}

export interface CostBreakdownResult {
  window: FinanceWindow;
  categories: Array<{ category: string; source: "counter" | "cost_explorer"; cost_usd_micros: number; percentage_of_total: number }>;
  directly_attributable_total: number;
  shared_infra_total: number | null;
  total_usd_micros: number | null;
  reconciliation: {
    counter_derived_usd_micros: number | null;
    cost_explorer_usd_micros: number | null;
    drift_percentage: number | null;
    drift_warning: boolean;
  };
}

export interface FinanceFetchOptions {
  refresh?: boolean;
}

export interface FinanceRouteDeps {
  requireSession: (req: Request) => { email: string; name: string } | null;
  getSummary: (window: FinanceWindow, opts?: FinanceFetchOptions) => Promise<FinanceSummaryResult>;
  getRevenueBreakdown: (window: FinanceWindow, opts?: FinanceFetchOptions) => Promise<RevenueBreakdownResult>;
  getCostBreakdown: (window: FinanceWindow, opts?: FinanceFetchOptions) => Promise<CostBreakdownResult>;
  getProjectFinance: (projectId: string, window: FinanceWindow) => Promise<ProjectFinanceResult | null>;
  refreshCostExplorer: () => Promise<ManualRefreshResult>;
  refreshPricingRates: () => Promise<RefreshPricingResult>;
}

function parseRefresh(req: Request): boolean {
  const v = req.query.refresh;
  return v === "1" || v === "true";
}

// ------------------------------------------------------------------
// Pure handlers (testable without Express)
// ------------------------------------------------------------------

function ensureSessionOrReject(req: Request, res: Response, deps: FinanceRouteDeps): { email: string; name: string } | null {
  const session = deps.requireSession(req);
  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return session;
}

function safeParseWindow(req: Request, res: Response): FinanceWindow | null {
  try {
    return parseWindowParam((req.query.window as string | undefined) ?? undefined);
  } catch (err) {
    res.status(400).json({
      error: "invalid_window",
      allowed: ["24h", "7d", "30d", "90d"],
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function handleSummaryRequest(req: Request, res: Response, deps: FinanceRouteDeps): Promise<void> {
  if (!ensureSessionOrReject(req, res, deps)) return;
  const window = safeParseWindow(req, res);
  if (!window) return;
  const summary = await deps.getSummary(window, { refresh: parseRefresh(req) });
  res.status(200).json(summary);
}

export async function handleRevenueRequest(req: Request, res: Response, deps: FinanceRouteDeps): Promise<void> {
  if (!ensureSessionOrReject(req, res, deps)) return;
  const window = safeParseWindow(req, res);
  if (!window) return;
  const breakdown = await deps.getRevenueBreakdown(window, { refresh: parseRefresh(req) });
  res.status(200).json(breakdown);
}

export async function handleCostsRequest(req: Request, res: Response, deps: FinanceRouteDeps): Promise<void> {
  if (!ensureSessionOrReject(req, res, deps)) return;
  const window = safeParseWindow(req, res);
  if (!window) return;
  const costs = await deps.getCostBreakdown(window, { refresh: parseRefresh(req) });
  res.status(200).json(costs);
}

export async function handleProjectRequest(req: Request, res: Response, deps: FinanceRouteDeps): Promise<void> {
  if (!ensureSessionOrReject(req, res, deps)) return;
  const window = safeParseWindow(req, res);
  if (!window) return;
  const projectId = req.params.id as string;
  const result = await deps.getProjectFinance(projectId, window);
  if (!result) {
    res.status(404).json({ error: "project_not_found" });
    return;
  }
  res.status(200).json(result);
}

export async function handleExportRequest(req: Request, res: Response, deps: FinanceRouteDeps): Promise<void> {
  if (!ensureSessionOrReject(req, res, deps)) return;

  const format = (req.query.format as string | undefined) ?? "csv";
  if (format !== "csv") {
    res.status(400).json({ error: "unsupported_format", supported: ["csv"] });
    return;
  }

  const window = safeParseWindow(req, res);
  if (!window) return;

  const scope = (req.query.scope as string | undefined) ?? "platform";
  if (scope !== "platform" && scope !== "project") {
    res.status(400).json({ error: "invalid_scope", allowed: ["platform", "project"] });
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  if (scope === "platform") {
    const [summary, revenue, costs] = await Promise.all([
      deps.getSummary(window),
      deps.getRevenueBreakdown(window),
      deps.getCostBreakdown(window),
    ]);
    const csv = buildPlatformCsv(summary, revenue, costs);
    res.type("text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="run402-finance-platform-${window}-${timestamp}.csv"`);
    res.send(csv);
    return;
  }

  // scope === "project"
  const projectId = (req.query.id as string | undefined) ?? "";
  if (!projectId) {
    res.status(400).json({ error: "missing_project_id" });
    return;
  }
  const project = await deps.getProjectFinance(projectId, window);
  if (!project) {
    res.status(404).json({ error: "project_not_found" });
    return;
  }
  const csv = buildProjectCsv(project);
  res.type("text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="run402-finance-project-${projectId}-${window}-${timestamp}.csv"`);
  res.send(csv);
}

export async function handleRefreshCostsRequest(req: Request, res: Response, deps: FinanceRouteDeps): Promise<void> {
  if (!ensureSessionOrReject(req, res, deps)) return;
  try {
    const result = await deps.refreshCostExplorer();
    res.status(200).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/rate limit/i.test(msg)) {
      res.status(429).json({ error: "rate_limited", message: msg });
      return;
    }
    res.status(502).json({ error: "cost_explorer_unavailable", aws_error: msg });
  }
}

export async function handleRefreshPricingRequest(req: Request, res: Response, deps: FinanceRouteDeps): Promise<void> {
  if (!ensureSessionOrReject(req, res, deps)) return;
  try {
    const result = await deps.refreshPricingRates();
    res.status(200).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "pricing_api_unavailable", aws_error: msg });
  }
}

// ------------------------------------------------------------------
// CSV builders
// ------------------------------------------------------------------

function fmtUsd(usdMicros: number | null): string {
  if (usdMicros === null) return "";
  return (usdMicros / 1_000_000).toFixed(6);
}

function buildPlatformCsv(
  summary: FinanceSummaryResult,
  revenue: RevenueBreakdownResult,
  costs: CostBreakdownResult,
): string {
  const lines: string[] = [];

  // Section 1: Platform Summary
  lines.push("# Platform Summary");
  lines.push("window,revenue_usd,cost_usd,margin_usd,cost_source,cache_age_hours");
  const cacheAgeH = summary.cost_source.cache_age_seconds == null
    ? ""
    : (summary.cost_source.cache_age_seconds / 3600).toFixed(2);
  lines.push(
    [
      summary.window,
      fmtUsd(summary.revenue_usd_micros),
      fmtUsd(summary.cost_usd_micros),
      fmtUsd(summary.margin_usd_micros),
      summary.cost_source.cache_status,
      cacheAgeH,
    ].join(","),
  );
  lines.push("");

  // Section 2: Revenue Breakdown by Project
  lines.push("# Revenue Breakdown by Project");
  lines.push("project_id,project_name,tier_fees_usd,email_packs_usd,kms_rental_usd,kms_sign_fees_usd,per_call_sku_usd,total_usd");
  for (const p of revenue.projects) {
    lines.push(
      [
        p.project_id,
        JSON.stringify(p.project_name),
        fmtUsd(p.tier_fees_usd_micros),
        fmtUsd(p.email_packs_usd_micros),
        fmtUsd(p.kms_rental_usd_micros),
        fmtUsd(p.kms_sign_fees_usd_micros),
        fmtUsd(p.per_call_sku_usd_micros),
        fmtUsd(p.total_usd_micros),
      ].join(","),
    );
  }
  if (revenue.unattributed_usd_micros > 0) {
    lines.push(`_unattributed,"(unattributed)",,,,,,${fmtUsd(revenue.unattributed_usd_micros)}`);
  }
  lines.push(`TOTAL,,,,,,,${fmtUsd(revenue.total_usd_micros)}`);
  lines.push("");

  // Section 3: Cost Breakdown by Category
  lines.push("# Cost Breakdown by Category");
  lines.push("category,source,cost_usd,percentage_of_total");
  for (const c of costs.categories) {
    lines.push(
      [
        JSON.stringify(c.category),
        c.source,
        fmtUsd(c.cost_usd_micros),
        c.percentage_of_total.toFixed(2),
      ].join(","),
    );
  }

  return lines.join("\n") + "\n";
}

function buildProjectCsv(project: ProjectFinanceResult): string {
  const lines: string[] = [];

  // Section 1: Project Summary
  lines.push("# Project Summary");
  lines.push("project_id,project_name,window,revenue_usd,direct_cost_usd,direct_margin_usd");
  lines.push(
    [
      project.project_id,
      JSON.stringify(project.project_name),
      project.window,
      fmtUsd(project.revenue_usd_micros),
      fmtUsd(project.direct_cost_usd_micros),
      fmtUsd(project.direct_margin_usd_micros),
    ].join(","),
  );
  lines.push("");

  // Section 2: Revenue Breakdown
  lines.push("# Revenue Breakdown");
  lines.push("tier_fees_usd,email_packs_usd,kms_rental_usd,kms_sign_fees_usd,per_call_sku_usd");
  lines.push(
    [
      fmtUsd(project.revenue_breakdown.tier_fees_usd_micros),
      fmtUsd(project.revenue_breakdown.email_packs_usd_micros),
      fmtUsd(project.revenue_breakdown.kms_rental_usd_micros),
      fmtUsd(project.revenue_breakdown.kms_sign_fees_usd_micros),
      fmtUsd(project.revenue_breakdown.per_call_sku_usd_micros),
    ].join(","),
  );
  lines.push("");

  // Section 3: Direct Cost Breakdown
  lines.push("# Direct Cost Breakdown");
  lines.push("category,cost_usd");
  for (const c of project.direct_cost_breakdown) {
    lines.push([JSON.stringify(c.category), fmtUsd(c.cost_usd_micros)].join(","));
  }

  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------
// Production dependency bundle
// ------------------------------------------------------------------

async function buildProductionDeps(): Promise<FinanceRouteDeps> {
  // Short-TTL in-memory cache + request coalescer to prevent OOM from concurrent
  // /admin/finance loads. See finance-cache.ts. Set FINANCE_CACHE_TTL_MS=0 to disable.
  const ttlMs = Number.parseInt(process.env.FINANCE_CACHE_TTL_MS ?? "30000", 10);
  const cache = createFinanceCache({ ttlMs: Number.isFinite(ttlMs) ? ttlMs : 30000 });

  // These wrap the real DB/AWS so they share the same injection point as tests.
  return {
    requireSession: getSession,
    getSummary: async (window, opts) => {
      return cache.get(
        `summary:${window}`,
        () =>
          getFinanceSummary(window, {
            getPlatformRevenue: (range) => realGetPlatformRevenue(defaultFinanceQuery, range),
            getPlatformCostFromCache: (range) =>
              realGetPlatformCostFromCache(defaultFinanceQuery, range, new Date()),
            getDirectCostTotal: async (range) => {
              const rates = await getAllCostRates();
              const bundle = toCostRatesBundle(rates);
              const perProject = await realGetDirectCostByProject(defaultFinanceQuery, range, bundle);
              return perProject.reduce((s, p) => s + p.total_usd_micros, 0);
            },
            now: new Date(),
          }),
        { refresh: opts?.refresh },
      );
    },
    getRevenueBreakdown: async (window, opts) => {
      return cache.get(
        `revenue:${window}`,
        () => {
          const range = windowToInterval(window, new Date());
          return realGetRevenueBreakdownByProject(defaultFinanceQuery, range);
        },
        { refresh: opts?.refresh },
      );
    },
    getCostBreakdown: async (window, opts) => {
      return cache.get(
        `costs:${window}`,
        async () => {
          const range = windowToInterval(window, new Date());
          const rates = await getAllCostRates();
          const costRatesBundle = toCostRatesBundle(rates);
          const [perProject, platformCost] = await Promise.all([
            realGetDirectCostByProject(defaultFinanceQuery, range, costRatesBundle),
            realGetPlatformCostFromCache(defaultFinanceQuery, range, new Date()),
          ]);
          return mergeIntoCostBreakdown(window, perProject, platformCost);
        },
        { refresh: opts?.refresh },
      );
    },
    getProjectFinance: async (projectId, window) => {
      const range = windowToInterval(window, new Date());
      const rates = await getAllCostRates();
      const costRatesBundle = toCostRatesBundle(rates);
      // Fetch project name
      const projectResult = await pool.query(
        sql(`SELECT id, name FROM internal.projects WHERE id = $1`),
        [projectId],
      );
      if (projectResult.rows.length === 0) return null;
      const project = projectResult.rows[0] as { id: string; name: string };

      const [revenueBreakdown, directCosts] = await Promise.all([
        realGetRevenueBreakdownByProject(defaultFinanceQuery, range),
        realGetDirectCostByProject(defaultFinanceQuery, range, costRatesBundle),
      ]);

      const projectRevenue = revenueBreakdown.projects.find((p) => p.project_id === projectId);
      const projectCost = directCosts.find((p) => p.project_id === projectId);

      const revenue_usd_micros = projectRevenue?.total_usd_micros ?? 0;
      const direct_cost_usd_micros = projectCost?.total_usd_micros ?? 0;
      const direct_margin_usd_micros = revenue_usd_micros - direct_cost_usd_micros;

      return {
        project_id: project.id,
        project_name: project.name,
        window,
        revenue_usd_micros,
        direct_cost_usd_micros,
        direct_margin_usd_micros,
        revenue_breakdown: {
          tier_fees_usd_micros: projectRevenue?.tier_fees_usd_micros ?? 0,
          email_packs_usd_micros: projectRevenue?.email_packs_usd_micros ?? 0,
          kms_rental_usd_micros: projectRevenue?.kms_rental_usd_micros ?? 0,
          kms_sign_fees_usd_micros: projectRevenue?.kms_sign_fees_usd_micros ?? 0,
          per_call_sku_usd_micros: projectRevenue?.per_call_sku_usd_micros ?? 0,
        },
        direct_cost_breakdown: Object.entries(projectCost?.categories ?? {}).map(([category, cost_usd_micros]) => ({
          category,
          cost_usd_micros,
        })),
        notes: "Direct costs only. Shared infrastructure overhead is not allocated to individual projects. See the Finance tab for platform totals.",
      };
    },
    refreshCostExplorer: async () => {
      const client = createAwsCostExplorerClient();
      return manualCostRefresh({
        client,
        upsertRows: async (rows) => {
          for (const row of rows) {
            await pool.query(
              sql(
                `INSERT INTO internal.aws_cost_cache (day, service_category, cost_usd_micros, fetched_at)
                 VALUES ($1::date, $2, $3, NOW())
                 ON CONFLICT (day, service_category) DO UPDATE SET
                   cost_usd_micros = EXCLUDED.cost_usd_micros,
                   fetched_at = EXCLUDED.fetched_at`,
              ),
              [row.day, row.service_category, row.cost_usd_micros],
            );
          }
        },
        now: new Date(),
      });
    },
    refreshPricingRates: async () => {
      const client = createAwsPricingClient();
      const rates = await getAllCostRates();
      const existingRates = Object.fromEntries(
        Object.entries(rates).map(([k, v]) => [k, v.value]),
      );
      return refreshPricingRates(client, {
        existingRates,
        update: async (updates) => {
          await updateCostRates(updates, "aws-pricing-api");
        },
      });
    },
  };
}

function toCostRatesBundle(rates: Record<string, CostRateRow>): {
  ses_per_email_usd_micros: number;
  lambda_request_usd_micros: number;
  lambda_gb_second_usd_micros: number;
  s3_gb_month_usd_micros: number;
  kms_key_monthly_usd_micros: number;
  kms_sign_per_op_usd_micros: number;
} {
  return {
    ses_per_email_usd_micros: rates.ses_per_email_usd_micros?.value ?? 100,
    lambda_request_usd_micros: rates.lambda_request_usd_micros?.value ?? 200,
    lambda_gb_second_usd_micros: rates.lambda_gb_second_usd_micros?.value ?? 17,
    s3_gb_month_usd_micros: rates.s3_gb_month_usd_micros?.value ?? 23000,
    kms_key_monthly_usd_micros: rates.kms_key_monthly_usd_micros?.value ?? 1000000,
    kms_sign_per_op_usd_micros: rates.kms_sign_per_op_usd_micros?.value ?? 3,
  };
}

function mergeIntoCostBreakdown(
  window: FinanceWindow,
  perProject: ProjectDirectCostRow[],
  platformCost: PlatformCostResult,
): CostBreakdownResult {
  // Counter-derived: aggregate per-category across all projects
  const counterCategories = new Map<string, number>();
  for (const p of perProject) {
    for (const [cat, val] of Object.entries(p.categories)) {
      counterCategories.set(cat, (counterCategories.get(cat) ?? 0) + val);
    }
  }
  const counterRows = Array.from(counterCategories.entries()).map(([category, cost_usd_micros]) => ({
    category,
    source: "counter" as const,
    cost_usd_micros,
    percentage_of_total: 0, // filled below
  }));
  const ceRows = platformCost.categories.map((c) => ({
    category: c.category,
    source: "cost_explorer" as const,
    cost_usd_micros: c.cost_usd_micros,
    percentage_of_total: 0,
  }));
  const allRows = [...counterRows, ...ceRows];
  const directly_attributable_total = counterRows.reduce((s, r) => s + r.cost_usd_micros, 0);
  const shared_infra_total = platformCost.total_usd_micros;
  const total_usd_micros = shared_infra_total === null
    ? null
    : directly_attributable_total + shared_infra_total;
  if (total_usd_micros && total_usd_micros > 0) {
    for (const r of allRows) {
      r.percentage_of_total = Math.round((r.cost_usd_micros / total_usd_micros) * 10000) / 100;
    }
  }
  allRows.sort((a, b) => b.cost_usd_micros - a.cost_usd_micros);

  // Drift reconciliation: compare counter-derived KMS+SES+Lambda+S3 against
  // Cost Explorer's (Cost Explorer)-suffixed categories.
  const comparable = new Set([
    "KMS wallet rental",
    "KMS sign ops",
    "SES email send",
    "Lambda invocations",
    "S3 storage",
  ]);
  const counterComparable = counterRows
    .filter((r) => comparable.has(r.category))
    .reduce((s, r) => s + r.cost_usd_micros, 0);
  const ceComparable = platformCost.categories
    .filter((c) => /\(Cost Explorer\)/.test(c.category))
    .reduce((s, c) => s + c.cost_usd_micros, 0);
  const drift = computeDriftReconciliation(
    counterComparable > 0 ? counterComparable : null,
    ceComparable > 0 ? ceComparable : null,
  );

  return {
    window,
    categories: allRows,
    directly_attributable_total,
    shared_infra_total,
    total_usd_micros,
    reconciliation: {
      counter_derived_usd_micros: counterComparable > 0 ? counterComparable : null,
      cost_explorer_usd_micros: ceComparable > 0 ? ceComparable : null,
      drift_percentage: drift.drift_percentage,
      drift_warning: drift.drift_warning,
    },
  };
}

// ------------------------------------------------------------------
// Express router
// ------------------------------------------------------------------

const router = Router();

let cachedDeps: FinanceRouteDeps | null = null;
async function deps(): Promise<FinanceRouteDeps> {
  if (!cachedDeps) {
    cachedDeps = await buildProductionDeps();
  }
  return cachedDeps;
}

router.get("/admin/api/finance/summary", asyncHandler(async (req, res) => {
  await handleSummaryRequest(req, res, await deps());
}));

router.get("/admin/api/finance/revenue", asyncHandler(async (req, res) => {
  await handleRevenueRequest(req, res, await deps());
}));

router.get("/admin/api/finance/costs", asyncHandler(async (req, res) => {
  await handleCostsRequest(req, res, await deps());
}));

router.get("/admin/api/finance/project/:id", asyncHandler(async (req, res) => {
  await handleProjectRequest(req, res, await deps());
}));

router.get("/admin/api/finance/export", asyncHandler(async (req, res) => {
  await handleExportRequest(req, res, await deps());
}));

router.post("/admin/api/finance/refresh-costs", asyncHandler(async (req, res) => {
  await handleRefreshCostsRequest(req, res, await deps());
}));

router.post("/admin/api/finance/refresh-pricing", asyncHandler(async (req, res) => {
  await handleRefreshPricingRequest(req, res, await deps());
}));

// HTML page — served in Phase 8
router.get("/admin/finance", asyncHandler(async (req, res) => {
  const session = getSession(req);
  if (!session) { res.redirect("/admin/login"); return; }
  const { financePage } = await import("./admin-finance-html.js");
  res.type("html").send(financePage(session.name, session.email));
}));

export default router;
