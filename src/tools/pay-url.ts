import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import {
  payFetchResultToJson,
  type PayFetchResult,
} from "../../sdk/dist/index.js";

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
};

interface PayUrlArgs {
  url: string;
  method?: string;
  body?: string | Record<string, unknown>;
  idempotency_key?: string;
  max_usd_micros?: number;
  require_receipt?: boolean;
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
  if (!payment) {
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
