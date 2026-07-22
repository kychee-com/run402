import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

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
};

interface PayUrlArgs {
  url: string;
  method?: string;
  body?: string | Record<string, unknown>;
  idempotency_key?: string;
  max_usd_micros?: number;
}

interface PayUrlSdk {
  pay: {
    fetch: (
      url: string,
      init?: RequestInit,
      options?: { idempotencyKey?: string; maxUsdMicros?: number },
    ) => Promise<{
      response: Response;
      payment: unknown;
      outcome: string;
      replay: boolean;
      paymentId?: string | null;
      deduplicated?: boolean | null;
      fundsMoved?: boolean | "unknown" | null;
      delivery?: "first" | "replay" | "none" | null;
      settledAt?: string | null;
      intentState?: string | null;
    }>;
  };
}

export async function handlePayUrl(
  args: PayUrlArgs,
  deps: { getSdk?: () => PayUrlSdk } = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const method = (args.method ?? "GET").toUpperCase();
    const init = requestInit(method, args.body);
    const result = await (deps.getSdk?.() ?? getSdk()).pay.fetch(args.url, init, {
      ...(args.idempotency_key !== undefined ? { idempotencyKey: args.idempotency_key } : {}),
      ...(args.max_usd_micros !== undefined ? { maxUsdMicros: args.max_usd_micros } : {}),
    });
    const body = await readResponseBody(result.response);
    const output = {
      http_status: result.response.status,
      body,
      payment: result.payment,
      outcome: result.outcome,
      replay: result.replay,
      payment_id: result.paymentId ?? null,
      deduplicated: result.deduplicated ?? null,
      funds_moved: result.fundsMoved ?? null,
      delivery: result.delivery ?? null,
      settled_at: result.settledAt ?? null,
      intent_state: result.intentState ?? null,
    };
    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
  } catch (error) {
    return mapSdkError(error, "paying URL");
  }
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
