/**
 * aws-pricing-fetcher service
 *
 * Fetches current AWS prices from the AWS Pricing API for the 6 cost categories
 * tracked in `internal.cost_rates` (SES, Lambda requests, Lambda GB-sec, S3,
 * KMS monthly key fee, KMS sign ops). Used by the admin Finance tab's
 * "Refresh pricing" button.
 *
 * Design:
 *  - Each cost rate has a dedicated parser that takes a raw Pricing API response
 *    and returns the value in USD-micros matching our internal integer schema.
 *  - `refreshPricingRates(client, deps)` is the top-level orchestrator that fans
 *    out to all 6 rate lookups, compares against the stored `existingRates`, and
 *    calls `deps.update(changes)` for the diff. Per-service errors are captured
 *    in `result.errors` without aborting the rest.
 *
 * Per DD-9: only forward-going, no retroactive re-attribution of historical rows.
 * Per DD-2: pricing lives in the DB so this update happens without a redeploy.
 *
 * **Assumptions about the Pricing API:**
 *  - We call `GetProducts` with a ServiceCode and minimal filters, take the first
 *    PriceList entry, and extract `terms.OnDemand[*].priceDimensions[*].pricePerUnit.USD`.
 *  - The real API returns PriceList entries as JSON strings; we handle both
 *    strings and already-parsed objects to keep tests ergonomic.
 *  - Region is us-east-1 for all rate lookups (run402 is deployed there).
 */

import {
  PricingClient as AwsPricingClient,
  GetProductsCommand,
} from "@aws-sdk/client-pricing";

// --- Public types -----------------------------------------------------------

/** Minimal shape of an AWS Pricing API filter as used here. */
export interface PricingFilter {
  Type: "TERM_MATCH";
  Field: string;
  Value: string;
}

/** Input shape for `getProducts` — subset of the AWS SDK type we actually use. */
export interface GetProductsInput {
  ServiceCode: string;
  Filters?: PricingFilter[];
  FormatVersion?: string;
  MaxResults?: number;
}

/** A PriceList entry is either a JSON string (real API) or an already-parsed object (tests). */
export type PriceListEntry = string | Record<string, unknown>;

/** Response shape we care about. */
export interface PricingResponse {
  PriceList?: PriceListEntry[];
}

/** Interface the fetcher uses — real implementation wraps the AWS SDK. */
export interface PricingClient {
  getProducts(input: GetProductsInput): Promise<PricingResponse>;
}

/** Dependency bundle for `refreshPricingRates`. */
export interface RefreshPricingDeps {
  existingRates: Record<string, number>;
  update: (updates: Record<string, number>) => Promise<void>;
}

/** Result of a refresh run. */
export interface RefreshPricingResult {
  updated: Array<{ key: string; old_value: number; new_value: number }>;
  unchanged: string[];
  errors: Array<{ key: string; message: string }>;
}

// --- Parsing helpers --------------------------------------------------------

interface ParsedProduct {
  terms?: {
    OnDemand?: Record<string, {
      priceDimensions?: Record<string, {
        unit?: string;
        pricePerUnit?: { USD?: string };
        description?: string;
      }>;
    }>;
  };
}

/** Normalize a PriceList entry to a parsed object. */
function parseEntry(entry: PriceListEntry): ParsedProduct {
  if (typeof entry === "string") {
    return JSON.parse(entry) as ParsedProduct;
  }
  return entry as ParsedProduct;
}

/** Extract the first USD price per unit from a parsed product, or null if not found. */
function firstUsdPerUnit(product: ParsedProduct): number | null {
  const onDemand = product.terms?.OnDemand;
  if (!onDemand) return null;
  for (const offer of Object.values(onDemand)) {
    const dims = offer.priceDimensions;
    if (!dims) continue;
    for (const dim of Object.values(dims)) {
      const usd = dim.pricePerUnit?.USD;
      if (usd !== undefined) {
        const n = Number(usd);
        if (!Number.isNaN(n)) return n;
      }
    }
  }
  return null;
}

/** Extract the first pricePerUnit.USD from a PricingResponse, or throw. */
function firstUsdFromResponse(pricing: PricingResponse, serviceLabel: string): number {
  const list = pricing.PriceList ?? [];
  if (list.length === 0) {
    throw new Error(`no pricing data for ${serviceLabel}`);
  }
  const product = parseEntry(list[0]);
  const value = firstUsdPerUnit(product);
  if (value === null) {
    throw new Error(`no USD price dimension found for ${serviceLabel}`);
  }
  return value;
}

// --- Per-service parsers ----------------------------------------------------
// Each parser converts an AWS price (in USD, floating point) into our
// integer USD-micros schema matching the seeded default values.

/** SES outbound: AWS returns $ per email. $0.0001/email → 100 usd-micros. */
export function parseSesRate(pricing: PricingResponse): number {
  const usdPerEmail = firstUsdFromResponse(pricing, "SES");
  return Math.round(usdPerEmail * 1_000_000);
}

/**
 * Lambda request: AWS returns $ per request. $0.0000002/request → 0.2 micros/request,
 * but our seeded value is 200 (meaning "per 10^9 requests" for integer math).
 * Convention: lambda_request_usd_micros = Math.round(usdPerRequest * 1e9).
 */
export function parseLambdaRequestRate(pricing: PricingResponse): number {
  const usdPerRequest = firstUsdFromResponse(pricing, "Lambda request");
  return Math.round(usdPerRequest * 1_000_000_000);
}

/**
 * Lambda GB-second: AWS returns $ per GB-second. $0.0000166667/GB-sec → 17 usd-micros.
 * NOTE: the naming convention `usd_micros` is inconsistent with lambda_request above.
 * The seeded value is 17, which is `Math.round(0.0000166667 * 1e6)` → micro-scale.
 * Downstream math in finance-rollup takes care of the unit mismatch.
 */
export function parseLambdaGbSecondRate(pricing: PricingResponse): number {
  const usdPerGbSec = firstUsdFromResponse(pricing, "Lambda GB-second");
  return Math.round(usdPerGbSec * 1_000_000);
}

/** S3 standard storage: AWS returns $ per GB-month. $0.023/GB-month → 23000 usd-micros. */
export function parseS3StorageRate(pricing: PricingResponse): number {
  const usdPerGbMonth = firstUsdFromResponse(pricing, "S3 storage");
  return Math.round(usdPerGbMonth * 1_000_000);
}

/** KMS monthly key: AWS returns $ per key-month. $1.00/key-month → 1_000_000 usd-micros. */
export function parseKmsKeyRate(pricing: PricingResponse): number {
  const usdPerKeyMonth = firstUsdFromResponse(pricing, "KMS key");
  return Math.round(usdPerKeyMonth * 1_000_000);
}

/**
 * KMS sign ops: AWS returns $ per sign op. $0.000003/sign → 3 usd-micros
 * (stored with the same "per op * 1e6" convention as sub-cent rates).
 */
export function parseKmsSignRate(pricing: PricingResponse): number {
  const usdPerSign = firstUsdFromResponse(pricing, "KMS sign");
  return Math.round(usdPerSign * 1_000_000);
}

// --- Orchestrator -----------------------------------------------------------

interface RateFetchSpec {
  key: string;
  fetch: () => Promise<number>;
}

/**
 * Top-level refresh: fans out to all 6 rate lookups, compares against
 * `existingRates`, calls `update(changes)` for the diff, captures per-service
 * errors without aborting the rest.
 */
export async function refreshPricingRates(
  client: PricingClient,
  deps: RefreshPricingDeps,
): Promise<RefreshPricingResult> {
  const specs: RateFetchSpec[] = [
    {
      key: "ses_per_email_usd_micros",
      fetch: async () => {
        const resp = await client.getProducts({ ServiceCode: "AmazonSES" });
        return parseSesRate(resp);
      },
    },
    {
      key: "lambda_request_usd_micros",
      fetch: async () => {
        const resp = await client.getProducts({
          ServiceCode: "AWSLambda",
          Filters: [{ Type: "TERM_MATCH", Field: "group", Value: "AWS-Lambda-Requests" }],
        });
        return parseLambdaRequestRate(resp);
      },
    },
    {
      key: "lambda_gb_second_usd_micros",
      fetch: async () => {
        const resp = await client.getProducts({
          ServiceCode: "AWSLambda",
          Filters: [{ Type: "TERM_MATCH", Field: "group", Value: "AWS-Lambda-Duration" }],
        });
        return parseLambdaGbSecondRate(resp);
      },
    },
    {
      key: "s3_gb_month_usd_micros",
      fetch: async () => {
        const resp = await client.getProducts({
          ServiceCode: "AmazonS3",
          Filters: [{ Type: "TERM_MATCH", Field: "storageClass", Value: "General Purpose" }],
        });
        return parseS3StorageRate(resp);
      },
    },
    {
      key: "kms_key_monthly_usd_micros",
      fetch: async () => {
        const resp = await client.getProducts({
          ServiceCode: "awskms",
          Filters: [{ Type: "TERM_MATCH", Field: "usagetype", Value: "KMS-Keys" }],
        });
        return parseKmsKeyRate(resp);
      },
    },
    {
      key: "kms_sign_per_op_usd_micros",
      fetch: async () => {
        const resp = await client.getProducts({
          ServiceCode: "awskms",
          Filters: [{ Type: "TERM_MATCH", Field: "usagetype", Value: "KMS-Requests-Sign" }],
        });
        return parseKmsSignRate(resp);
      },
    },
  ];

  const updated: RefreshPricingResult["updated"] = [];
  const unchanged: string[] = [];
  const errors: RefreshPricingResult["errors"] = [];
  const toUpdate: Record<string, number> = {};

  for (const spec of specs) {
    try {
      const newValue = await spec.fetch();
      const oldValue = deps.existingRates[spec.key];
      if (oldValue !== undefined && oldValue === newValue) {
        unchanged.push(spec.key);
      } else {
        updated.push({ key: spec.key, old_value: oldValue ?? 0, new_value: newValue });
        toUpdate[spec.key] = newValue;
      }
    } catch (err) {
      errors.push({
        key: spec.key,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (Object.keys(toUpdate).length > 0) {
    await deps.update(toUpdate);
  }

  return { updated, unchanged, errors };
}

// --- Real AWS SDK adapter ---------------------------------------------------

/**
 * Build a PricingClient backed by the real AWS SDK. The Pricing API endpoint
 * is only available in us-east-1 and ap-south-1 — we force us-east-1.
 */
export function createAwsPricingClient(): PricingClient {
  const awsClient = new AwsPricingClient({ region: "us-east-1" });
  return {
    async getProducts(input) {
      const command = new GetProductsCommand({
        ServiceCode: input.ServiceCode,
        Filters: input.Filters,
        FormatVersion: input.FormatVersion ?? "aws_v1",
        MaxResults: input.MaxResults ?? 1,
      });
      const resp = await awsClient.send(command);
      return { PriceList: resp.PriceList };
    },
  };
}
