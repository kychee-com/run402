/**
 * aws-cost-fetcher service
 *
 * Pulls AWS Cost Explorer data once per 24 hours (or on manual refresh) and
 * caches it in `internal.aws_cost_cache`. Used by the admin Finance tab to
 * display the "real" AWS bill alongside the counter-derived direct costs.
 *
 * Design (per DD-7, DD-11 in design.md):
 *  - Daily UTC cadence, idempotent via `latestFetchedAt` guard
 *  - Hardcoded service-to-category mapping const (AWS services rarely change)
 *  - Catch-all "Other shared" bucket for unknown services
 *  - Zero-cost groups are dropped
 *  - Manual refresh bypasses the 24h guard but is rate-limited to 1/60s
 *    per gateway instance
 *  - Dependency-injected client + upsert function so the real AWS SDK and
 *    DB never need to be touched in unit tests
 */

import {
  CostExplorerClient as AwsCostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";

// --- Public types -----------------------------------------------------------

export interface CostExplorerGroup {
  Keys?: string[];
  Metrics?: {
    UnblendedCost?: { Amount?: string; Unit?: string };
  };
}

export interface CostExplorerResultByTime {
  TimePeriod?: { Start?: string; End?: string };
  Groups?: CostExplorerGroup[];
}

export interface CostExplorerResponse {
  ResultsByTime?: CostExplorerResultByTime[];
}

export interface CostExplorerClient {
  getCostAndUsage(input: {
    TimePeriod: { Start: string; End: string };
    Granularity: "DAILY";
    Metrics: string[];
    GroupBy: Array<{ Type: "DIMENSION"; Key: "SERVICE" }>;
  }): Promise<CostExplorerResponse>;
}

export interface CostCacheUpsertRow {
  day: string; // ISO date (YYYY-MM-DD)
  service_category: string;
  cost_usd_micros: number;
}

// --- Hardcoded service-to-category mapping ----------------------------------
// Per DD-11. To add a new service: edit this const and deploy. No DB migration.

const SERVICE_TO_CATEGORY: Record<string, string> = Object.freeze({
  "Amazon Relational Database Service": "RDS",
  "Amazon Elastic Container Service": "ECS Fargate",
  "Amazon Elastic Load Balancing": "ALB",
  "Amazon CloudFront": "CloudFront",
  "AWS Secrets Manager": "Secrets Manager",
  "AmazonCloudWatch": "CloudWatch",
  "AWS Key Management Service": "KMS (Cost Explorer)",
  "Amazon Simple Email Service": "SES (Cost Explorer)",
  "AWS Lambda": "Lambda (Cost Explorer)",
  "Amazon Simple Storage Service": "S3 (Cost Explorer)",
});

export function mapAwsServiceToCategory(awsServiceName: string): string {
  return SERVICE_TO_CATEGORY[awsServiceName] ?? "Other shared";
}

// --- Response parser --------------------------------------------------------

/**
 * Convert a Cost Explorer response into cache rows. Zero-cost groups are
 * dropped. Multiple unknown services on the same day are SUMMED into a single
 * "Other shared" row (per the spec scenario "bucketizes unknown services").
 * Known services with the same category on the same day are also summed
 * (e.g., if Cost Explorer somehow returns two "Amazon Simple Email Service"
 * rows for one day — defensive).
 */
export function parseCostExplorerResponse(
  response: CostExplorerResponse,
): CostCacheUpsertRow[] {
  const byDayAndCategory = new Map<string, CostCacheUpsertRow>();
  for (const period of response.ResultsByTime ?? []) {
    const day = period.TimePeriod?.Start;
    if (!day) continue;
    for (const group of period.Groups ?? []) {
      const serviceName = group.Keys?.[0];
      const amountStr = group.Metrics?.UnblendedCost?.Amount;
      if (!serviceName || !amountStr) continue;
      const amountUsd = Number(amountStr);
      if (!Number.isFinite(amountUsd) || amountUsd === 0) continue;
      const category = mapAwsServiceToCategory(serviceName);
      const cost_usd_micros = Math.round(amountUsd * 1_000_000);
      const key = `${day}|${category}`;
      const existing = byDayAndCategory.get(key);
      if (existing) {
        existing.cost_usd_micros += cost_usd_micros;
      } else {
        byDayAndCategory.set(key, { day, service_category: category, cost_usd_micros });
      }
    }
  }
  return Array.from(byDayAndCategory.values());
}

// --- Daily fetcher ----------------------------------------------------------

export interface DailyFetcherDeps {
  client: CostExplorerClient;
  latestFetchedAt: Date | null;
  upsertRows: (rows: CostCacheUpsertRow[]) => Promise<void>;
  now: Date;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Format a Date as YYYY-MM-DD (UTC). */
function formatDateUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Runs the daily fetch. Skips if cache is fresh (<24h). Fetches the previous
 * complete UTC day PLUS the current running day. Idempotent at the 30-second
 * reconciler cadence.
 */
export async function runDailyCostFetcher(deps: DailyFetcherDeps): Promise<void> {
  // Skip if cache is fresh
  if (deps.latestFetchedAt) {
    const ageMs = deps.now.getTime() - deps.latestFetchedAt.getTime();
    if (ageMs < ONE_DAY_MS) {
      return;
    }
  }

  // Compute window: yesterday start → today end (inclusive of current running day)
  const todayStart = new Date(Date.UTC(
    deps.now.getUTCFullYear(),
    deps.now.getUTCMonth(),
    deps.now.getUTCDate(),
  ));
  const yesterdayStart = new Date(todayStart.getTime() - ONE_DAY_MS);
  const tomorrowStart = new Date(todayStart.getTime() + ONE_DAY_MS);

  const response = await deps.client.getCostAndUsage({
    TimePeriod: {
      Start: formatDateUtc(yesterdayStart),
      End: formatDateUtc(tomorrowStart),
    },
    Granularity: "DAILY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
  });

  const rows = parseCostExplorerResponse(response);
  if (rows.length > 0) {
    await deps.upsertRows(rows);
  }
}

// --- Manual refresh with rate limiting --------------------------------------

export interface ManualRefreshDeps {
  client: CostExplorerClient;
  upsertRows: (rows: CostCacheUpsertRow[]) => Promise<void>;
  now: Date;
}

export interface ManualRefreshResult {
  refreshed_at: Date;
  rows_upserted: number;
  cost_explorer_call_count: number;
}

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 60 seconds
let lastManualRefreshAt = 0; // milliseconds since epoch

/** Test hook: reset the module-level rate limit state between tests. */
export function __resetRateLimitForTest(): void {
  lastManualRefreshAt = 0;
}

/**
 * Manual on-demand refresh. Bypasses the 24h daily guard. Rate-limited to
 * once per 60 seconds per gateway instance to prevent accidental hammering.
 */
export async function manualCostRefresh(
  deps: ManualRefreshDeps,
): Promise<ManualRefreshResult> {
  const nowMs = deps.now.getTime();
  if (lastManualRefreshAt > 0 && nowMs - lastManualRefreshAt < RATE_LIMIT_WINDOW_MS) {
    const waitMs = RATE_LIMIT_WINDOW_MS - (nowMs - lastManualRefreshAt);
    throw new Error(
      `rate limit: manual cost refresh allowed once per 60s, please wait ${Math.ceil(waitMs / 1000)}s`,
    );
  }
  lastManualRefreshAt = nowMs;

  // Same window as the daily fetcher — yesterday complete + today running.
  const todayStart = new Date(Date.UTC(
    deps.now.getUTCFullYear(),
    deps.now.getUTCMonth(),
    deps.now.getUTCDate(),
  ));
  const yesterdayStart = new Date(todayStart.getTime() - ONE_DAY_MS);
  const tomorrowStart = new Date(todayStart.getTime() + ONE_DAY_MS);

  const response = await deps.client.getCostAndUsage({
    TimePeriod: {
      Start: formatDateUtc(yesterdayStart),
      End: formatDateUtc(tomorrowStart),
    },
    Granularity: "DAILY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
  });

  const rows = parseCostExplorerResponse(response);
  if (rows.length > 0) {
    await deps.upsertRows(rows);
  }

  return {
    refreshed_at: deps.now,
    rows_upserted: rows.length,
    cost_explorer_call_count: 1,
  };
}

// --- Real AWS SDK adapter ---------------------------------------------------

/** Build a CostExplorerClient backed by the real AWS SDK. us-east-1 only. */
export function createAwsCostExplorerClient(): CostExplorerClient {
  const awsClient = new AwsCostExplorerClient({ region: "us-east-1" });
  return {
    async getCostAndUsage(input) {
      const command = new GetCostAndUsageCommand({
        TimePeriod: input.TimePeriod,
        Granularity: input.Granularity,
        Metrics: input.Metrics,
        GroupBy: input.GroupBy,
      });
      const resp = await awsClient.send(command);
      return {
        ResultsByTime: resp.ResultsByTime?.map((r) => ({
          TimePeriod: r.TimePeriod,
          Groups: r.Groups?.map((g) => ({
            Keys: g.Keys,
            Metrics: g.Metrics as CostExplorerGroup["Metrics"],
          })),
        })),
      };
    },
  };
}
