import type { Client } from "../kernel.js";
import { Run402Error, type NextAction } from "../errors.js";

export const DEFAULT_PAYMENT_MAX_USD_MICROS = 100_000;

export interface PayFetchOptions {
  /** Maximum atomic USD units this call may authorize. Defaults to 100,000 ($0.10). */
  maxUsdMicros?: number;
  /** Forwarded as `Idempotency-Key` for key-deduplicated paid HTTP surfaces. */
  idempotencyKey?: string;
}

export interface PaymentReceipt {
  amount_usd_micros: number;
  pay_to: string;
  network: string;
  tx_ref: string;
  url: string;
}

export type PayFetchOutcome = "not_required" | "settled" | "already_settled";

export interface PayFetchResult {
  /** The upstream response. The SDK never consumes its body. */
  response: Response;
  /** On-chain receipt, or null when no payment was needed / no transaction reference is available. */
  payment: PaymentReceipt | null;
  outcome: PayFetchOutcome;
  /** True for a re-presented proof or a key-deduplicated upstream result. */
  replay: boolean;
}

export type PaymentFundsMoved = boolean | "unknown";

export type PaymentBuyerErrorCode =
  | "PAYMENT_EXCEEDS_MAX"
  | "PAYMENT_WALLET_UNFUNDED"
  | "PAYMENT_NETWORK_UNSUPPORTED"
  | "PAYMENT_SETTLEMENT_FAILED";

/** Structured local failure from {@link Pay.fetch}. */
export class PaymentBuyerError extends Run402Error {
  readonly kind = "payment_buyer_error" as const;
  readonly code: PaymentBuyerErrorCode;
  readonly fundsMoved: PaymentFundsMoved;
  readonly cause?: unknown;

  constructor(init: {
    code: PaymentBuyerErrorCode;
    message: string;
    fundsMoved: PaymentFundsMoved;
    details?: Record<string, unknown>;
    nextActions: NextAction[];
    retryable?: boolean;
    safeToRetry?: boolean;
    cause?: unknown;
  }) {
    const mutationState = init.fundsMoved === false
      ? "not_started"
      : init.fundsMoved === true
        ? "completed"
        : "ambiguous";
    super(
      init.message,
      null,
      {
        error: init.code,
        code: init.code,
        message: init.message,
        category: "payment",
        source: "sdk",
        retryable: init.retryable ?? false,
        safe_to_retry: init.safeToRetry ?? init.fundsMoved === false,
        mutation_state: mutationState,
        details: {
          funds_moved: init.fundsMoved,
          ...(init.details ?? {}),
        },
        next_actions: init.nextActions,
      },
      "paying an x402-priced URL",
    );
    this.code = init.code;
    this.fundsMoved = init.fundsMoved;
    if (init.cause !== undefined) this.cause = init.cause;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      fundsMoved: this.fundsMoved,
    };
  }
}

export function isPaymentBuyerError(error: unknown): error is PaymentBuyerError {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { isRun402Error?: unknown }).isRun402Error === true &&
      (error as { kind?: unknown }).kind === "payment_buyer_error",
  );
}

export type PayExecutor = (
  url: string,
  init: RequestInit | undefined,
  options: Required<Pick<PayFetchOptions, "maxUsdMicros">> & Pick<PayFetchOptions, "idempotencyKey">,
) => Promise<PayFetchResult>;

/** Arbitrary-URL buyer namespace. Node supplies the x402 executor; isomorphic callers may inject one. */
export class Pay {
  constructor(
    private readonly client: Client,
    private readonly executor?: PayExecutor,
  ) {}

  async fetch(
    url: string | URL,
    init?: RequestInit,
    options: PayFetchOptions = {},
  ): Promise<PayFetchResult> {
    const normalizedUrl = normalizePayUrl(url);
    const maxUsdMicros = normalizeMax(options.maxUsdMicros);
    const nextInit = withIdempotencyKey(init, options.idempotencyKey);
    if (this.executor) {
      return this.executor(normalizedUrl, nextInit, {
        maxUsdMicros,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
    }

    const response = await this.client.fetch(normalizedUrl, nextInit);
    if (response.status === 402) {
      throw walletUnavailableError();
    }
    return {
      response,
      payment: null,
      outcome: "not_required",
      replay: await responseSignalsReplay(response, options.idempotencyKey !== undefined),
    };
  }
}

export function paymentExceedsMaxError(
  challengedAmountUsdMicros: number,
  maxUsdMicros: number,
): PaymentBuyerError {
  return new PaymentBuyerError({
    code: "PAYMENT_EXCEEDS_MAX",
    message:
      `The endpoint requested ${challengedAmountUsdMicros} usd_micros, above this call's ` +
      `${maxUsdMicros} ceiling. Raise it explicitly with { maxUsdMicros: ${challengedAmountUsdMicros} } ` +
      `or CLI --max-usd ${(challengedAmountUsdMicros / 1_000_000).toFixed(6)}.`,
    fundsMoved: false,
    details: {
      challenged_amount_usd_micros: challengedAmountUsdMicros,
      max_usd_micros: maxUsdMicros,
    },
    nextActions: [
      {
        type: "edit_request",
        field: "maxUsdMicros",
        value: challengedAmountUsdMicros,
        why: "Raise the ceiling only after confirming this exact price is intended.",
      },
    ],
  });
}

export function walletUnavailableError(details: Record<string, unknown> = {}): PaymentBuyerError {
  return new PaymentBuyerError({
    code: "PAYMENT_WALLET_UNFUNDED",
    message: "No funded x402 wallet is available for this payment.",
    fundsMoved: false,
    details,
    nextActions: [
      {
        type: "fund_wallet",
        why: "Fund the configured Run402 allowance wallet with USDC on a challenge network, then retry.",
      },
      {
        type: "run_command",
        command: "run402 allowance fund",
        why: "Open the canonical wallet funding flow.",
      },
      {
        type: "run_command",
        command: "run402 init",
        why: "Create an allowance and use the testnet faucet when no wallet is configured.",
      },
    ],
  });
}

export async function responseSignalsReplay(response: Response, inspect: boolean): Promise<boolean> {
  if (!inspect || !response.headers.get("content-type")?.includes("application/json")) return false;
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > 1_000_000) return false;
  try {
    const body = await response.clone().json() as Record<string, unknown>;
    return body?.deduplicated === true;
  } catch {
    return false;
  }
}

function normalizePayUrl(input: string | URL): string {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch (cause) {
    throw new PaymentBuyerError({
      code: "PAYMENT_SETTLEMENT_FAILED",
      message: "pay.fetch requires an absolute HTTP(S) URL.",
      fundsMoved: false,
      details: { field: "url" },
      nextActions: [{ type: "edit_request", field: "url", why: "Pass the complete priced endpoint URL." }],
      cause,
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PaymentBuyerError({
      code: "PAYMENT_SETTLEMENT_FAILED",
      message: "pay.fetch supports only HTTP(S) URLs.",
      fundsMoved: false,
      details: { field: "url", protocol: url.protocol },
      nextActions: [{ type: "edit_request", field: "url", why: "Use an https:// or http:// endpoint." }],
    });
  }
  return url.toString();
}

function normalizeMax(value: number | undefined): number {
  const normalized = value ?? DEFAULT_PAYMENT_MAX_USD_MICROS;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new PaymentBuyerError({
      code: "PAYMENT_SETTLEMENT_FAILED",
      message: "maxUsdMicros must be a non-negative safe integer.",
      fundsMoved: false,
      details: { field: "maxUsdMicros", value: normalized },
      nextActions: [{ type: "edit_request", field: "maxUsdMicros", why: "Pass an integer number of usd_micros." }],
    });
  }
  return normalized;
}

function withIdempotencyKey(init: RequestInit | undefined, key: string | undefined): RequestInit | undefined {
  if (key === undefined) return init;
  if (key.trim() === "") {
    throw new PaymentBuyerError({
      code: "PAYMENT_SETTLEMENT_FAILED",
      message: "idempotencyKey must not be empty.",
      fundsMoved: false,
      details: { field: "idempotencyKey" },
      nextActions: [{ type: "edit_request", field: "idempotencyKey", why: "Use a stable non-empty key for this paid intent." }],
    });
  }
  const headers = new Headers(init?.headers);
  headers.set("Idempotency-Key", key);
  return { ...init, headers };
}
