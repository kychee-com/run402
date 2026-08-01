import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import {
  RUN402_MPP_LIGHTNING_PROFILE,
  payFetchResultToJson,
  type PayFetchResult,
  type PaymentPreference,
} from "../../sdk/dist/index.js";

export const paymentPreferenceSchema = z.union([
  z.object({
    protocol: z.literal("mpp"),
    method: z.literal("lightning"),
    intent: z.literal("charge"),
    wallet: z.custom<`nwc:${string}`>(
      (value) => typeof value === "string" && /^nwc:[a-z0-9][a-z0-9_-]{0,63}$/.test(value),
      "Expected an nwc:<label> local instrument alias",
    ),
  }),
  z.object({
    protocol: z.literal("mpp"),
    method: z.literal("tempo"),
    intent: z.literal("charge").optional(),
    wallet: z.string().optional(),
  }),
  z.object({
    protocol: z.literal("x402"),
    network: z.string().min(1),
    wallet: z.string().optional(),
  }),
]);

export const payUrlSchema = {
  url: z.string().url().describe("The HTTP(S) URL to call"),
  method: z.string().optional().describe("HTTP method (default: GET)"),
  body: z
    .union([z.string(), z.record(z.unknown())])
    .optional()
    .describe("Request body as text or a JSON object"),
  idempotency_key: z
    .string()
    .optional()
    .describe("Stable Idempotency-Key forwarded to the seller; on Run402 pending, retry the identical call with the same payer and key"),
  max_usd_micros: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Maximum payment in USD micros (default: 100000, or $0.10)"),
  require_receipt: z
    .boolean()
    .optional()
    .describe(
      "Require a verified wallet-rooted merchant offer before payment and a matching receipt after settlement",
    ),
  payment_preferences: z.array(paymentPreferenceSchema).min(1).max(16).optional()
    .describe("Ordered payment capabilities; Lightning is explicit and uses the exact Run402 profile on Bitcoin mainnet"),
  profile: z.literal(RUN402_MPP_LIGHTNING_PROFILE).optional()
    .describe("Exact Run402 Lightning charge profile opt-in"),
  max_native_amount_msat: z.number().int().nonnegative().optional()
    .describe("Maximum Lightning invoice plus authorized routing fee, in millisatoshis"),
  max_routing_fee_msat: z.number().int().nonnegative().optional()
    .describe("Maximum routing fee the configured Lightning instrument may apply"),
  evidence_policy: z.enum(["none", "protocol_settlement", "run402_settlement", "merchant_fulfillment"]).optional(),
  organization_id: z.string().min(1).optional()
    .describe("Organization binding retained across discovery, retry, and recovery"),
};

interface PayUrlArgs {
  url: string;
  method?: string;
  body?: string | Record<string, unknown>;
  idempotency_key?: string;
  max_usd_micros?: number;
  require_receipt?: boolean;
  payment_preferences?: PaymentPreference[];
  profile?: typeof RUN402_MPP_LIGHTNING_PROFILE;
  max_native_amount_msat?: number;
  max_routing_fee_msat?: number;
  evidence_policy?: "none" | "protocol_settlement" | "run402_settlement" | "merchant_fulfillment";
  organization_id?: string;
}

interface PayUrlSdk {
  pay: {
    fetch: (
      url: string,
      init?: RequestInit,
      options?: {
        idempotencyKey?: string;
        maxUsdMicros?: number;
        requireReceipt?: boolean;
        paymentPreferences?: PaymentPreference[];
        profile?: typeof RUN402_MPP_LIGHTNING_PROFILE;
        maxNativeAmountMsat?: number;
        maxRoutingFeeMsat?: number;
        evidencePolicy?: "none" | "protocol_settlement" | "run402_settlement" | "merchant_fulfillment";
        principalTransport?: "siwx";
        organizationId?: string;
      },
    ) => Promise<PayFetchResult>;
  };
}

export async function handlePayUrl(
  args: PayUrlArgs,
  deps: { getSdk?: () => PayUrlSdk } = {},
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  try {
    const method = (args.method ?? "GET").toUpperCase();
    const init = requestInit(method, args.body);
    const result = await (deps.getSdk?.() ?? getSdk()).pay.fetch(args.url, init, {
      ...(args.idempotency_key !== undefined ? { idempotencyKey: args.idempotency_key } : {}),
      ...(args.max_usd_micros !== undefined ? { maxUsdMicros: args.max_usd_micros } : {}),
      ...(args.require_receipt !== undefined
        ? { requireReceipt: args.require_receipt }
        : {}),
      ...(args.payment_preferences ? { paymentPreferences: args.payment_preferences } : {}),
      ...(args.profile ? { profile: args.profile } : {}),
      ...(args.max_native_amount_msat !== undefined
        ? { maxNativeAmountMsat: args.max_native_amount_msat } : {}),
      ...(args.max_routing_fee_msat !== undefined
        ? { maxRoutingFeeMsat: args.max_routing_fee_msat } : {}),
      ...(args.evidence_policy ? { evidencePolicy: args.evidence_policy } : {}),
      ...(args.organization_id ? { organizationId: args.organization_id } : {}),
      ...(args.payment_preferences?.some((item) =>
        item.protocol === "mpp" && item.method === "lightning")
        ? { principalTransport: "siwx" as const } : {}),
    });
    const body = await readResponseBody(result.response);
    const output = payFetchResultToJson(result, body);
    return {
      content: [{ type: "text", text: renderCommerceSummary(output) }],
      structuredContent: output,
    };
  } catch (error) {
    return mapSdkError(error, "paying URL");
  }
}

function renderCommerceSummary(output: Record<string, unknown>): string {
  const payment = output.payment as Record<string, unknown> | null;
  const paymentResult = output.payment_result as Record<string, unknown> | null;
  if (!payment) {
    if (paymentResult) {
      return [
        `HTTP ${output.http_status}`,
        `Payment: ${paymentResult.protocol}/${paymentResult.method} ${paymentResult.intent}`,
        `Funds moved: ${paymentResult.funds_moved}; replay: ${paymentResult.replay}`,
        `Operation: ${paymentResult.operation_state ?? "unknown"}`,
      ].join("\n");
    }
    return [
      `HTTP ${output.http_status}`,
      "Payment: not required",
      `Outcome: ${output.outcome}`,
    ].join("\n");
  }
  const settlement = payment.settlement as Record<string, unknown>;
  const delivery = payment.delivery as Record<string, unknown>;
  const receipt = payment.merchant_receipt as Record<string, unknown>;
  const relationship = payment.signer_relationship as Record<string, unknown>;
  const policy = payment.policy as Record<string, unknown>;
  return [
    `HTTP ${output.http_status}`,
    `Payment: ${payment.amount_usd_micros} usd_micros → ${payment.pay_to}`,
    `Settlement: ${settlement.status}`,
    `Funds moved: ${payment.funds_moved}; replay: ${delivery.replay}`,
    `Merchant receipt: ${receipt.status}`,
    `Signer relationship: ${relationship.kind ?? "none"}`,
    `Receipt policy: ${policy.status}`,
  ].join("\n");
}

function requestInit(method: string, body: PayUrlArgs["body"]): RequestInit {
  if (body === undefined) return { method };
  if (method === "GET" || method === "HEAD") {
    throw new TypeError(`body cannot be used with ${method}`);
  }
  if (typeof body === "string") {
    return {
      method,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body,
    };
  }
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  if (response.headers.get("content-type")?.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
