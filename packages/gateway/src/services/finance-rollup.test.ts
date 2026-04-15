import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  windowToInterval,
  computeDriftReconciliation,
  getPlatformRevenue,
  getRevenueBreakdownByProject,
  getDirectCostByProject,
  getPlatformCostFromCache,
  type FinanceRollupQueryFn,
  type FinanceWindow,
} from "./finance-rollup.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMockQuery(canned: Array<{ rows: any[] }>): {
  query: FinanceRollupQueryFn;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let i = 0;
  const query: FinanceRollupQueryFn = async (sql, params) => {
    calls.push({ sql, params });
    const r = canned[i++];
    if (!r) throw new Error(`mock query exhausted at call ${i}`);
    return r;
  };
  return { query, calls };
}

describe("finance-rollup — windowToInterval", () => {
  const now = new Date("2026-04-06T12:00:00Z");

  it("maps 24h to a 24-hour interval ending at now", () => {
    const w = windowToInterval("24h", now);
    assert.equal(w.end.getTime(), now.getTime());
    assert.equal(w.end.getTime() - w.start.getTime(), 24 * 60 * 60 * 1000);
  });

  it("maps 7d to 7 days", () => {
    const w = windowToInterval("7d", now);
    assert.equal(w.end.getTime() - w.start.getTime(), 7 * 24 * 60 * 60 * 1000);
  });

  it("maps 30d to 30 days", () => {
    const w = windowToInterval("30d", now);
    assert.equal(w.end.getTime() - w.start.getTime(), 30 * 24 * 60 * 60 * 1000);
  });

  it("maps 90d to 90 days", () => {
    const w = windowToInterval("90d", now);
    assert.equal(w.end.getTime() - w.start.getTime(), 90 * 24 * 60 * 60 * 1000);
  });

  it("throws on invalid window", () => {
    assert.throws(
      () => windowToInterval("1y" as unknown as FinanceWindow, now),
      /invalid window/i,
    );
  });
});

describe("finance-rollup — computeDriftReconciliation", () => {
  it("0% drift when values match", () => {
    const r = computeDriftReconciliation(100, 100);
    assert.equal(r.drift_percentage, 0);
    assert.equal(r.drift_warning, false);
  });

  it("10% drift warns", () => {
    const r = computeDriftReconciliation(110, 100);
    assert.equal(r.drift_percentage, 10);
    assert.equal(r.drift_warning, true);
  });

  it("4% drift does NOT warn (below 5% threshold)", () => {
    const r = computeDriftReconciliation(104, 100);
    assert.equal(r.drift_percentage, 4);
    assert.equal(r.drift_warning, false);
  });

  it("exactly 5% drift does NOT warn (strictly greater than 5%)", () => {
    const r = computeDriftReconciliation(105, 100);
    assert.equal(r.drift_percentage, 5);
    assert.equal(r.drift_warning, false);
  });

  it("null Cost Explorer → null drift, no warning", () => {
    const r = computeDriftReconciliation(100, null);
    assert.equal(r.drift_percentage, null);
    assert.equal(r.drift_warning, false);
  });

  it("null counter → null drift, no warning", () => {
    const r = computeDriftReconciliation(null, 100);
    assert.equal(r.drift_percentage, null);
    assert.equal(r.drift_warning, false);
  });

  it("zero denominator → null drift (no divide-by-zero)", () => {
    const r = computeDriftReconciliation(100, 0);
    assert.equal(r.drift_percentage, null);
    assert.equal(r.drift_warning, false);
  });
});

describe("finance-rollup — getPlatformRevenue", () => {
  it("returns total revenue from billing_topups for the window", async () => {
    const { query, calls } = makeMockQuery([
      { rows: [{ total_usd_micros: "15000000" }] }, // $15.00
    ]);
    const result = await getPlatformRevenue(query, {
      start: new Date("2026-03-07T00:00:00Z"),
      end: new Date("2026-04-06T00:00:00Z"),
    });
    assert.equal(result.total_usd_micros, 15_000_000);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /SUM.*funded_usd_micros/i);
    assert.match(calls[0].sql, /billing_topups/);
    assert.match(calls[0].sql, /status\s*=\s*'credited'/i);
  });

  it("returns zero when no topups in window", async () => {
    const { query } = makeMockQuery([
      { rows: [{ total_usd_micros: null }] },
    ]);
    const result = await getPlatformRevenue(query, {
      start: new Date("2026-03-07T00:00:00Z"),
      end: new Date("2026-04-06T00:00:00Z"),
    });
    assert.equal(result.total_usd_micros, 0);
  });
});

describe("finance-rollup — getRevenueBreakdownByProject", () => {
  it("returns per-project breakdown with stream columns and unattributed bucket", async () => {
    const { query, calls } = makeMockQuery([
      // per-project rows
      {
        rows: [
          {
            project_id: "proj_kysigned",
            project_name: "kysigned",
            tier_fees: "5000000",      // $5.00
            email_packs: "5000000",    // $5.00
            kms_rental: "1200000",     // $1.20 (30d × $0.04)
            kms_sign_fees: "450000",   // $0.45
            per_call_sku: "0",
            total: "11650000",
          },
          {
            project_id: "proj_other",
            project_name: "other",
            tier_fees: "500000",
            email_packs: "0",
            kms_rental: "0",
            kms_sign_fees: "0",
            per_call_sku: "30000",
            total: "530000",
          },
        ],
      },
      // unattributed bucket
      { rows: [{ unattributed_usd_micros: "100000" }] },
    ]);
    const result = await getRevenueBreakdownByProject(query, {
      start: new Date("2026-03-07T00:00:00Z"),
      end: new Date("2026-04-06T00:00:00Z"),
    });
    assert.equal(result.projects.length, 2);
    assert.equal(result.projects[0].project_id, "proj_kysigned");
    assert.equal(result.projects[0].tier_fees_usd_micros, 5_000_000);
    assert.equal(result.projects[0].email_packs_usd_micros, 5_000_000);
    assert.equal(result.projects[0].kms_rental_usd_micros, 1_200_000);
    assert.equal(result.projects[0].kms_sign_fees_usd_micros, 450_000);
    assert.equal(result.projects[0].total_usd_micros, 11_650_000);
    assert.equal(result.unattributed_usd_micros, 100_000);
    // Reconciliation: top-level total equals sum of projects + unattributed
    const summed = result.projects.reduce((s, p) => s + p.total_usd_micros, 0) + result.unattributed_usd_micros;
    assert.equal(result.total_usd_micros, summed);
    assert.equal(calls.length, 2);
  });

  it("empty window returns empty projects array and zero total", async () => {
    const { query } = makeMockQuery([
      { rows: [] },
      { rows: [{ unattributed_usd_micros: null }] },
    ]);
    const result = await getRevenueBreakdownByProject(query, {
      start: new Date("2026-03-07T00:00:00Z"),
      end: new Date("2026-04-06T00:00:00Z"),
    });
    assert.deepEqual(result.projects, []);
    assert.equal(result.unattributed_usd_micros, 0);
    assert.equal(result.total_usd_micros, 0);
  });

  it("filters out unnamed projects with zero revenue (dashboard noise reduction)", async () => {
    const { query } = makeMockQuery([
      {
        rows: [
          // Keep: named project with revenue
          { project_id: "proj_a", project_name: "kysigned", tier_fees: "5000000", email_packs: "0", kms_rental: "0", kms_sign_fees: "0", per_call_sku: "0", total: "5000000" },
          // Drop: unnamed + zero total (noise)
          { project_id: "proj_b", project_name: "(unnamed)", tier_fees: "0", email_packs: "0", kms_rental: "0", kms_sign_fees: "0", per_call_sku: "0", total: "0" },
          { project_id: "proj_c", project_name: null, tier_fees: "0", email_packs: "0", kms_rental: "0", kms_sign_fees: "0", per_call_sku: "0", total: "0" },
          { project_id: "proj_d", project_name: "", tier_fees: "0", email_packs: "0", kms_rental: "0", kms_sign_fees: "0", per_call_sku: "0", total: "0" },
          // Keep: named project even with zero revenue (operator explicitly named it — might be running cost-only)
          { project_id: "proj_e", project_name: "test-project", tier_fees: "0", email_packs: "0", kms_rental: "0", kms_sign_fees: "0", per_call_sku: "0", total: "0" },
          // Keep: unnamed project with revenue (rare, but the revenue matters)
          { project_id: "proj_f", project_name: "(unnamed)", tier_fees: "100000", email_packs: "0", kms_rental: "0", kms_sign_fees: "0", per_call_sku: "0", total: "100000" },
        ],
      },
      { rows: [{ unattributed_usd_micros: "0" }] },
    ]);
    const result = await getRevenueBreakdownByProject(query, {
      start: new Date("2026-03-07T00:00:00Z"),
      end: new Date("2026-04-06T00:00:00Z"),
    });
    const keptIds = result.projects.map((p) => p.project_id);
    assert.deepEqual(keptIds, ["proj_a", "proj_e", "proj_f"], "should drop 3 unnamed-zero rows, keep 3");
    // Reconciliation invariant still holds (zero totals don't affect the sum)
    assert.equal(result.total_usd_micros, 5_100_000);
  });

  it("filters unnamed variants case-insensitively with trim (broadened unnamed match)", async () => {
    const { query } = makeMockQuery([
      {
        rows: [
          // All should be dropped: zero revenue + various 'unnamed' spellings
          { project_id: "proj_1", project_name: "Unnamed", tier_fees: "0", email_packs: "0", kms_rental: "0", kms_sign_fees: "0", per_call_sku: "0", total: "0" },
          { project_id: "proj_2", project_name: "UNNAMED", tier_fees: "0", email_packs: "0", kms_rental: "0", kms_sign_fees: "0", per_call_sku: "0", total: "0" },
          { project_id: "proj_3", project_name: "unnamed", tier_fees: "0", email_packs: "0", kms_rental: "0", kms_sign_fees: "0", per_call_sku: "0", total: "0" },
          { project_id: "proj_4", project_name: "  (unnamed)  ", tier_fees: "0", email_packs: "0", kms_rental: "0", kms_sign_fees: "0", per_call_sku: "0", total: "0" },
          { project_id: "proj_5", project_name: "   ", tier_fees: "0", email_packs: "0", kms_rental: "0", kms_sign_fees: "0", per_call_sku: "0", total: "0" },
          // Keep: named "Unnamed" but WITH revenue (revenue matters regardless of name)
          { project_id: "proj_6", project_name: "Unnamed", tier_fees: "42", email_packs: "0", kms_rental: "0", kms_sign_fees: "0", per_call_sku: "0", total: "42" },
          // Keep: real name that happens to contain "unnamed" substring — not a strict match
          { project_id: "proj_7", project_name: "Unnamed Corp", tier_fees: "0", email_packs: "0", kms_rental: "0", kms_sign_fees: "0", per_call_sku: "0", total: "0" },
        ],
      },
      { rows: [{ unattributed_usd_micros: "0" }] },
    ]);
    const result = await getRevenueBreakdownByProject(query, {
      start: new Date("2026-03-07T00:00:00Z"),
      end: new Date("2026-04-06T00:00:00Z"),
    });
    const keptIds = result.projects.map((p) => p.project_id);
    assert.deepEqual(keptIds, ["proj_6", "proj_7"], "drop 5 unnamed-zero variants; keep unnamed-with-revenue and real-named");
  });
});

describe("finance-rollup — getDirectCostByProject", () => {
  it("computes counter × rate for each category and returns one row per project", async () => {
    const { query, calls } = makeMockQuery([
      // contract_wallets rent-days per project
      { rows: [{ project_id: "proj_a", total_rent_days: "30" }] },
      // contract_calls signs per project
      { rows: [{ project_id: "proj_a", total_signs: "100" }] },
      // contract_call_gas sum per project
      { rows: [{ project_id: "proj_a", total_gas_usd_micros: "50000" }] },
      // email messages count per project
      { rows: [{ project_id: "proj_a", total_emails: "500" }] },
      // lambda invocations per project (stub: we approximate via project.api_calls counter)
      { rows: [{ project_id: "proj_a", total_invocations: "100000", total_gb_seconds: "200" }] },
      // S3 storage (time-weighted average) per project
      { rows: [{ project_id: "proj_a", avg_storage_bytes: "536870912" }] }, // 512 MB
    ]);
    const costRates = {
      ses_per_email_usd_micros: 100,
      lambda_request_usd_micros: 200,
      lambda_gb_second_usd_micros: 17,
      s3_gb_month_usd_micros: 23000,
      kms_key_monthly_usd_micros: 1000000,
      kms_sign_per_op_usd_micros: 3,
    };
    const result = await getDirectCostByProject(query, {
      start: new Date("2026-03-07T00:00:00Z"),
      end: new Date("2026-04-06T00:00:00Z"),
    }, costRates);
    assert.equal(result.length, 1);
    const proj = result[0];
    assert.equal(proj.project_id, "proj_a");
    // KMS rental: 30 days × $1/30days = $1.00. 30 days × 1000000 / 30 = 1_000_000
    assert.equal(proj.categories["KMS wallet rental"], 1_000_000);
    // KMS sign ops: 100 × 3 = 300
    assert.equal(proj.categories["KMS sign ops"], 300);
    // Chain gas: 50000 (direct from ledger)
    assert.equal(proj.categories["Chain gas passthrough"], 50_000);
    // SES: 500 × 100 = 50000
    assert.equal(proj.categories["SES email send"], 50_000);
    // Lambda: 100000 × 200 / 1_000_000_000 (to unit-convert back from ×1e9 per parser convention)
    //   plus 200 GB-sec × 17 (micro-scale) = 3400
    // = (100000 × 200 / 1_000_000) + 3400 ... wait, this needs careful thought
    // For request: seeded value 200 means "$0.20/M requests" = 200 USD-micros per million requests
    //   so N requests cost: N/1_000_000 × 200 = N * 200 / 1_000_000 = N * 0.0002 dollars
    //   = N × 200 / 1 usd-micros? No, units matter.
    // Actually, 200 stored as usd-micros per M requests. For 100_000 requests:
    //   cost_usd_micros = 100_000 / 1_000_000 × 200 = 20 usd-micros = $0.00002
    //   That matches $0.20 per million × 0.1 million = $0.02... wait no.
    //   $0.20/M × 100_000 requests = $0.20 × 0.1 = $0.02 = 20_000 usd-micros
    // Hmm there's a scale mismatch. Let me define the interpretation clearly:
    //   - lambda_request_usd_micros = 200 is the "rate in usd-micros per million requests"
    //   - So per-request cost = 200 / 1_000_000 = 0.0002 usd-micros = 0.0000000002 USD
    //   - That can't be right either.
    // The REAL math: $0.20 per million = $0.20 / 1_000_000 = $0.0000002/request
    //   = 0.0000002 × 1_000_000 usd-micros/USD = 0.2 usd-micros per request
    //   × 1_000_000_000 for integer storage = 200
    //   So at use-time we divide by 1_000_000_000:
    //   cost_usd_micros = (count × 200) / 1_000_000_000
    //   For 100_000 requests: 100_000 × 200 / 1_000_000_000 = 20_000_000 / 1_000_000_000 = 0.02 usd-micros
    //   That's $0.00000002 — wrong again.
    // Let me just do the raw math: $0.20/M × 100k = $0.02 = 20_000 usd-micros
    //   Working backwards: 100_000 × 200 / X = 20_000 → X = 100_000 × 200 / 20_000 = 1000
    //   So divide by 1000.
    // Hmm OK so lambda_request_usd_micros = 200 means "divide request count by 1000, multiply by 200"?
    // That's weird. Let me look at what the seed actually means.
    // Actually the simplest interpretation: lambda_request_usd_micros = 200 represents $0.20/M as an integer.
    //   Real formula: cost_usd = count × ($0.20 / 1_000_000) = count × 0.0000002
    //   Convert to usd-micros: count × 0.0000002 × 1_000_000 = count × 0.2
    //   So cost_usd_micros = count × 0.2 = count × (200 / 1000)
    //   So the stored 200 is actually the $ per million × 1000 (thousandths of a dollar per million).
    //
    // In code, for 100_000 requests:
    //   cost_usd_micros = Math.round(100_000 * 200 / 1000) = 20_000
    //   = 100_000 * 0.2 = 20_000
    // So divide the stored value by 1000, then multiply by count.
    //
    // OK the naming is a mess. Let me just assert the result and code to match.
    // For 100_000 requests × rate 200: cost = 20_000 usd-micros
    // For 200 GB-seconds × rate 17: cost = ... should match the seed interpretation
    //   $0.0000166667/GB-sec × 200 = $0.00333334 = 3333 usd-micros
    //   Using stored rate 17 (which was 0.0000166667 × 1_000_000 = 16.67 → 17):
    //   cost_usd_micros = 200 × 17 = 3400
    // So lambda_gb_second IS micro-scale, multiply directly.
    // Total Lambda: 20_000 + 3400 = 23_400
    assert.equal(proj.categories["Lambda invocations"], 23_400);
    // S3: avg 512 MB × 30 days × 23000 usd-micros/GB-month / 30 = bytes_to_gb × 23000
    //   512 MB = 0.5 GB
    //   Full month at rate 23000 = 0.5 × 23000 = 11500 usd-micros
    //   For 30 days it's exactly a full month pro-rata = 11500
    assert.equal(proj.categories["S3 storage"], 11_500);
    // Total
    const expectedTotal = 1_000_000 + 300 + 50_000 + 50_000 + 23_400 + 11_500;
    assert.equal(proj.total_usd_micros, expectedTotal);
    assert.equal(calls.length, 6);
  });

  it("returns empty array when no projects have activity", async () => {
    const { query } = makeMockQuery([
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ]);
    const costRates = {
      ses_per_email_usd_micros: 100,
      lambda_request_usd_micros: 200,
      lambda_gb_second_usd_micros: 17,
      s3_gb_month_usd_micros: 23000,
      kms_key_monthly_usd_micros: 1000000,
      kms_sign_per_op_usd_micros: 3,
    };
    const result = await getDirectCostByProject(query, {
      start: new Date("2026-03-07T00:00:00Z"),
      end: new Date("2026-04-06T00:00:00Z"),
    }, costRates);
    assert.deepEqual(result, []);
  });
});

describe("finance-rollup — getPlatformCostFromCache", () => {
  it("sums rows in aws_cost_cache for the window", async () => {
    const { query } = makeMockQuery([
      {
        rows: [
          { service_category: "RDS", total_usd_micros: "30000000" }, // $30
          { service_category: "ECS Fargate", total_usd_micros: "15000000" }, // $15
        ],
      },
      { rows: [{ fetched_at: new Date("2026-04-06T10:00:00Z") }] },
    ]);
    const result = await getPlatformCostFromCache(query, {
      start: new Date("2026-03-07T00:00:00Z"),
      end: new Date("2026-04-06T12:00:00Z"),
    }, new Date("2026-04-06T12:00:00Z"));
    assert.equal(result.total_usd_micros, 45_000_000);
    assert.equal(result.categories.length, 2);
    assert.equal(result.categories[0].category, "RDS");
    assert.equal(result.categories[0].cost_usd_micros, 30_000_000);
    // Cache age = 2 hours = 7200 seconds
    assert.equal(result.cache_age_seconds, 7200);
    assert.equal(result.cache_status, "fresh");
  });

  it("reports empty status when cache has no rows for the window", async () => {
    const { query } = makeMockQuery([
      { rows: [] },
      { rows: [] },
    ]);
    const result = await getPlatformCostFromCache(query, {
      start: new Date("2026-03-07T00:00:00Z"),
      end: new Date("2026-04-06T12:00:00Z"),
    }, new Date("2026-04-06T12:00:00Z"));
    assert.equal(result.total_usd_micros, null);
    assert.equal(result.cache_status, "empty");
    assert.equal(result.cache_age_seconds, null);
    assert.deepEqual(result.categories, []);
  });
});
