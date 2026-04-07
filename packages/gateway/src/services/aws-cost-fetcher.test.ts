import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  mapAwsServiceToCategory,
  parseCostExplorerResponse,
  runDailyCostFetcher,
  manualCostRefresh,
  __resetRateLimitForTest,
  type CostExplorerClient,
  type CostExplorerResponse,
  type CostCacheUpsertRow,
} from "./aws-cost-fetcher.js";

describe("aws-cost-fetcher — service-to-category mapping", () => {
  it("maps known AWS service names to run402 categories", () => {
    assert.equal(mapAwsServiceToCategory("Amazon Relational Database Service"), "RDS");
    assert.equal(mapAwsServiceToCategory("Amazon Elastic Container Service"), "ECS Fargate");
    assert.equal(mapAwsServiceToCategory("Amazon Elastic Load Balancing"), "ALB");
    assert.equal(mapAwsServiceToCategory("Amazon CloudFront"), "CloudFront");
    assert.equal(mapAwsServiceToCategory("AWS Secrets Manager"), "Secrets Manager");
    assert.equal(mapAwsServiceToCategory("AmazonCloudWatch"), "CloudWatch");
    assert.equal(mapAwsServiceToCategory("AWS Key Management Service"), "KMS (Cost Explorer)");
    assert.equal(mapAwsServiceToCategory("Amazon Simple Email Service"), "SES (Cost Explorer)");
    assert.equal(mapAwsServiceToCategory("AWS Lambda"), "Lambda (Cost Explorer)");
    assert.equal(mapAwsServiceToCategory("Amazon Simple Storage Service"), "S3 (Cost Explorer)");
  });

  it("maps unknown services to 'Other shared'", () => {
    assert.equal(mapAwsServiceToCategory("AWS Quicksight"), "Other shared");
    assert.equal(mapAwsServiceToCategory("Amazon Comprehend"), "Other shared");
    assert.equal(mapAwsServiceToCategory(""), "Other shared");
  });
});

describe("aws-cost-fetcher — parseCostExplorerResponse", () => {
  it("converts Cost Explorer response into cache rows, applying the mapping", () => {
    const response: CostExplorerResponse = {
      ResultsByTime: [
        {
          TimePeriod: { Start: "2026-04-05", End: "2026-04-06" },
          Groups: [
            {
              Keys: ["Amazon Relational Database Service"],
              Metrics: { UnblendedCost: { Amount: "12.345", Unit: "USD" } },
            },
            {
              Keys: ["AWS Lambda"],
              Metrics: { UnblendedCost: { Amount: "0.05", Unit: "USD" } },
            },
          ],
        },
      ],
    };
    const rows = parseCostExplorerResponse(response);
    assert.equal(rows.length, 2);
    const rds = rows.find((r) => r.service_category === "RDS");
    assert.ok(rds);
    assert.equal(rds.day, "2026-04-05");
    // $12.345 → 12345000 USD-micros
    assert.equal(rds.cost_usd_micros, 12345000);
    const lambda = rows.find((r) => r.service_category === "Lambda (Cost Explorer)");
    assert.ok(lambda);
    assert.equal(lambda.cost_usd_micros, 50000); // $0.05 → 50000 micros
  });

  it("skips zero-cost groups", () => {
    const response: CostExplorerResponse = {
      ResultsByTime: [
        {
          TimePeriod: { Start: "2026-04-05", End: "2026-04-06" },
          Groups: [
            {
              Keys: ["Amazon Relational Database Service"],
              Metrics: { UnblendedCost: { Amount: "0.00", Unit: "USD" } },
            },
            {
              Keys: ["AWS Lambda"],
              Metrics: { UnblendedCost: { Amount: "0.05", Unit: "USD" } },
            },
          ],
        },
      ],
    };
    const rows = parseCostExplorerResponse(response);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].service_category, "Lambda (Cost Explorer)");
  });

  it("bucketizes unknown services into 'Other shared' and SUMS them per day", () => {
    const response: CostExplorerResponse = {
      ResultsByTime: [
        {
          TimePeriod: { Start: "2026-04-05", End: "2026-04-06" },
          Groups: [
            { Keys: ["AWS Quicksight"], Metrics: { UnblendedCost: { Amount: "1.00", Unit: "USD" } } },
            { Keys: ["Amazon Comprehend"], Metrics: { UnblendedCost: { Amount: "2.00", Unit: "USD" } } },
          ],
        },
      ],
    };
    const rows = parseCostExplorerResponse(response);
    const other = rows.filter((r) => r.service_category === "Other shared");
    assert.equal(other.length, 1);
    assert.equal(other[0].cost_usd_micros, 3000000); // $3.00
  });

  it("handles multiple days correctly", () => {
    const response: CostExplorerResponse = {
      ResultsByTime: [
        {
          TimePeriod: { Start: "2026-04-05", End: "2026-04-06" },
          Groups: [
            { Keys: ["AWS Lambda"], Metrics: { UnblendedCost: { Amount: "0.10", Unit: "USD" } } },
          ],
        },
        {
          TimePeriod: { Start: "2026-04-06", End: "2026-04-07" },
          Groups: [
            { Keys: ["AWS Lambda"], Metrics: { UnblendedCost: { Amount: "0.15", Unit: "USD" } } },
          ],
        },
      ],
    };
    const rows = parseCostExplorerResponse(response);
    assert.equal(rows.length, 2);
    const day5 = rows.find((r) => r.day === "2026-04-05");
    const day6 = rows.find((r) => r.day === "2026-04-06");
    assert.equal(day5?.cost_usd_micros, 100000);
    assert.equal(day6?.cost_usd_micros, 150000);
  });
});

describe("aws-cost-fetcher — runDailyCostFetcher", () => {
  it("fetches when cache is empty", async () => {
    const upsertedRows: CostCacheUpsertRow[] = [];
    let ceCallCount = 0;
    const mockClient: CostExplorerClient = {
      getCostAndUsage: async () => {
        ceCallCount++;
        return {
          ResultsByTime: [
            {
              TimePeriod: { Start: "2026-04-05", End: "2026-04-06" },
              Groups: [
                { Keys: ["AWS Lambda"], Metrics: { UnblendedCost: { Amount: "0.50", Unit: "USD" } } },
              ],
            },
          ],
        };
      },
    };
    await runDailyCostFetcher({
      client: mockClient,
      latestFetchedAt: null, // empty cache
      upsertRows: async (rows) => { upsertedRows.push(...rows); },
      now: new Date("2026-04-06T12:00:00Z"),
    });
    assert.equal(ceCallCount, 1);
    assert.equal(upsertedRows.length, 1);
    assert.equal(upsertedRows[0].service_category, "Lambda (Cost Explorer)");
  });

  it("skips fetch when cache is fresh (<24h)", async () => {
    let ceCallCount = 0;
    const mockClient: CostExplorerClient = {
      getCostAndUsage: async () => { ceCallCount++; return { ResultsByTime: [] }; },
    };
    await runDailyCostFetcher({
      client: mockClient,
      latestFetchedAt: new Date("2026-04-06T10:00:00Z"), // 2 hours ago
      upsertRows: async () => { /* no-op */ },
      now: new Date("2026-04-06T12:00:00Z"),
    });
    assert.equal(ceCallCount, 0);
  });

  it("fetches when cache is stale (>24h)", async () => {
    let ceCallCount = 0;
    const mockClient: CostExplorerClient = {
      getCostAndUsage: async () => {
        ceCallCount++;
        return { ResultsByTime: [] };
      },
    };
    await runDailyCostFetcher({
      client: mockClient,
      latestFetchedAt: new Date("2026-04-05T12:00:00Z"), // exactly 24h ago
      upsertRows: async () => { /* no-op */ },
      now: new Date("2026-04-06T13:00:00Z"),
    });
    assert.equal(ceCallCount, 1);
  });
});

describe("aws-cost-fetcher — manualCostRefresh", () => {
  it("bypasses 24h guard and always fetches", async () => {
    __resetRateLimitForTest();
    let ceCallCount = 0;
    const mockClient: CostExplorerClient = {
      getCostAndUsage: async () => {
        ceCallCount++;
        return { ResultsByTime: [] };
      },
    };
    const result = await manualCostRefresh({
      client: mockClient,
      upsertRows: async () => { /* no-op */ },
      now: new Date("2026-04-06T12:00:00Z"),
    });
    assert.equal(ceCallCount, 1);
    assert.ok(result.refreshed_at instanceof Date);
    assert.equal(result.rows_upserted, 0);
    assert.equal(result.cost_explorer_call_count, 1);
  });

  it("rate-limits to once per 60 seconds", async () => {
    __resetRateLimitForTest();
    const mockClient: CostExplorerClient = {
      getCostAndUsage: async () => ({ ResultsByTime: [] }),
    };
    const baseTime = new Date("2026-04-06T12:00:00Z");
    await manualCostRefresh({
      client: mockClient,
      upsertRows: async () => { /* no-op */ },
      now: baseTime,
    });
    // Second call 30s later — should throw
    await assert.rejects(
      () => manualCostRefresh({
        client: mockClient,
        upsertRows: async () => { /* no-op */ },
        now: new Date(baseTime.getTime() + 30_000),
      }),
      /rate.limit|too.many|wait/i,
    );
  });

  it("allows second call after 60 seconds", async () => {
    __resetRateLimitForTest();
    let calls = 0;
    const mockClient: CostExplorerClient = {
      getCostAndUsage: async () => {
        calls++;
        return { ResultsByTime: [] };
      },
    };
    const baseTime = new Date("2026-04-06T12:00:00Z");
    await manualCostRefresh({
      client: mockClient,
      upsertRows: async () => { /* no-op */ },
      now: baseTime,
    });
    await manualCostRefresh({
      client: mockClient,
      upsertRows: async () => { /* no-op */ },
      now: new Date(baseTime.getTime() + 61_000),
    });
    assert.equal(calls, 2);
  });
});
