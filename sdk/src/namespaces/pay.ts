import type { Client } from "../kernel.js";
import { Run402Error, type NextAction } from "../errors.js";

export const DEFAULT_PAYMENT_MAX_USD_MICROS = 100_000;
export const X402_COMMERCE_RESULT_SCHEMA_VERSION =
  "x402-commerce-result.v1" as const;
export const X402_PAYMENT_POLICY_ERROR_CODES = [
  "MERCHANT_RECEIPT_REQUIRED",
  "MERCHANT_RECEIPT_UNAVAILABLE",
] as const;
export const X402_GATEWAY_AVAILABILITY_ERROR_CODE =
  "MERCHANT_EVIDENCE_UNAVAILABLE" as const;
export const X402_MUTATION_STATES = [
  "not_started",
  "committed",
  "unknown",
] as const;
export const X402_RECOVERY_ACTIONS = [
  "retry",
  "reconcile_payment",
] as const;

export interface PayFetchOptions {
  /** Maximum atomic USD units this call may authorize. Defaults to 100,000 ($0.10). */
  maxUsdMicros?: number;
  /** Forwarded as `Idempotency-Key` for key-deduplicated paid HTTP surfaces. */
  idempotencyKey?: string;
  /**
   * Require a verified wallet-rooted merchant offer before authorizing
   * payment and a matching verified receipt after settlement.
   */
  requireReceipt?: boolean;
}

export const X402_EVIDENCE_STATUSES = [
  "verified",
  "absent",
  "invalid",
  "untrusted",
  "unavailable",
] as const;
export type PaymentEvidenceStatus =
  (typeof X402_EVIDENCE_STATUSES)[number];

export interface PaymentNextAction extends NextAction {
  type: "retry" | "reconcile_payment";
  why: string;
  request?: "repeat_identical";
  reusePayer?: true;
  reuseIdempotencyKey?: true;
}

export interface PaymentRawEvidence {
  offer: unknown | null;
  merchantReceipt: unknown | null;
  signerAuthorization: unknown | null;
}

export interface PaymentReceipt {
  /** @deprecated Use amountUsdMicros. */
  amount_usd_micros: number;
  /** @deprecated Use payTo. */
  pay_to: string;
  network: string;
  /** @deprecated Use transaction. */
  tx_ref: string;
  /** @deprecated Use resourceUrl. */
  url: string;
  paymentId: string | null;
  amountUsdMicros: number;
  asset: string;
  payer: string | null;
  payTo: string;
  transaction: string;
  resourceUrl: string;
  settlement: { status: PaymentEvidenceStatus };
  fundsMoved: PaymentFundsMoved;
  deduplicated: boolean;
  delivery: { status: "fulfilled" | "failed" | "unknown"; replay: boolean };
  offer: {
    status: PaymentEvidenceStatus;
    resourceUrl: string | null;
    validUntil: string | null;
  };
  merchantReceipt: {
    status: PaymentEvidenceStatus;
    claim: "service_delivered" | null;
    issuedAt: string | null;
  };
  signerRelationship: {
    kind: "direct" | "delegated" | "unverified" | null;
    merchantRoot: string | null;
    signer: string | null;
    authorizationExpiresAt: string | null;
  };
  policy: {
    requireReceipt: boolean;
    status: "satisfied" | "unsatisfied" | "not_required";
  };
  evidence: PaymentRawEvidence;
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
  /** Stable Run402 tenant-payment identity when the target supplied one. */
  paymentId?: string | null;
  /** Whether this HTTP request reused an existing Run402 payment identity. */
  deduplicated?: boolean | null;
  /** Funds movement initiated by this HTTP attempt, when declared by Run402. */
  fundsMoved?: PaymentFundsMoved | null;
  /** Tenant delivery state for this attempt. */
  delivery?: "first" | "replay" | "none" | null;
  /** Confirmed settlement time supplied by Run402. */
  settledAt?: string | null;
  /** Durable intent state when the request is a status-bearing replay. */
  intentState?: string | null;
  /** Canonical recovery actions. Never recommends a second payment. */
  nextActions?: PaymentNextAction[];
}

export function payFetchResultToJson(
  result: PayFetchResult,
  body: unknown,
): Record<string, unknown> {
  const payment = result.payment;
  return {
    schema_version: X402_COMMERCE_RESULT_SCHEMA_VERSION,
    http_status: result.response.status,
    body,
    payment: payment
      ? {
          payment_id: payment.paymentId,
          amount_usd_micros: payment.amountUsdMicros,
          asset: payment.asset,
          network: payment.network,
          payer: payment.payer,
          pay_to: payment.payTo,
          transaction: payment.transaction,
          resource_url: payment.resourceUrl,
          settlement: payment.settlement,
          funds_moved: payment.fundsMoved,
          deduplicated: payment.deduplicated,
          delivery: payment.delivery,
          offer: {
            status: payment.offer.status,
            resource_url: payment.offer.resourceUrl,
            valid_until: payment.offer.validUntil,
          },
          merchant_receipt: {
            status: payment.merchantReceipt.status,
            claim: payment.merchantReceipt.claim,
            issued_at: payment.merchantReceipt.issuedAt,
          },
          signer_relationship: {
            kind: payment.signerRelationship.kind,
            merchant_root: payment.signerRelationship.merchantRoot,
            signer: payment.signerRelationship.signer,
            authorization_expires_at:
              payment.signerRelationship.authorizationExpiresAt,
          },
          policy: {
            require_receipt: payment.policy.requireReceipt,
            status: payment.policy.status,
          },
          evidence: {
            offer: payment.evidence.offer,
            merchant_receipt: payment.evidence.merchantReceipt,
            signer_authorization: payment.evidence.signerAuthorization,
          },
        }
      : null,
    outcome: payment ? "paid" : "not_paid",
    replay: result.replay,
    next_actions: (result.nextActions ?? []).map((action) => ({
      type: action.type,
      why: action.why,
      ...(action.request ? { request: action.request } : {}),
      ...(action.reusePayer ? { reuse_payer: true } : {}),
      ...(action.reuseIdempotencyKey
        ? { reuse_idempotency_key: true }
        : {}),
    })),
  };
}

export type PaymentFundsMoved = boolean | "unknown";

export type PaymentBuyerErrorCode =
  | "PAYMENT_EXCEEDS_MAX"
  | "PAYMENT_WALLET_UNFUNDED"
  | "PAYMENT_NETWORK_UNSUPPORTED"
  | "PAYMENT_INTENT_PENDING"
  | "PAYMENT_DESTINATION_DRAINING"
  | "PAYMENT_INTENT_DESTINATION_CHANGED"
  | "PAYMENT_INTENT_FENCE_EXPIRED"
  | "PAYMENT_AUTHORIZATION_LIFETIME_EXCEEDED"
  | "PAYMENT_CALLER_IDENTITY_NOT_ACTIVE"
  | "IDEMPOTENCY_KEY_REUSED"
  | "INVALID_IDEMPOTENCY_KEY"
  | "IDEMPOTENCY_KEY_PAYER_REQUIRED"
  | "PAYMENT_SETTLEMENT_FAILED"
  | "MERCHANT_RECEIPT_REQUIRED"
  | "MERCHANT_RECEIPT_UNAVAILABLE";

export interface PayResponseMetadata {
  paymentId: string | null;
  deduplicated: boolean | null;
  fundsMoved: PaymentFundsMoved | null;
  delivery: "first" | "replay" | "none" | null;
  settledAt: string | null;
  intentState: string | null;
}

/** Structured local failure from {@link Pay.fetch}. */
export class PaymentBuyerError extends Run402Error {
  readonly kind = "payment_buyer_error" as const;
  readonly code: PaymentBuyerErrorCode;
  readonly fundsMoved: PaymentFundsMoved;
  readonly paymentId: string | null;
  readonly intentState: string | null;
  readonly delivery: "first" | "replay" | "none" | null;
  readonly deduplicated: boolean | null;
  readonly settledAt: string | null;
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
    status?: number | null;
    body?: Record<string, unknown>;
  }) {
    const mutationState = init.fundsMoved === false
      ? "not_started"
      : init.fundsMoved === true
        ? "completed"
        : "ambiguous";
    const body = init.body ?? {
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
    };
    super(
      init.message,
      init.status ?? null,
      body,
      "paying an x402-priced URL",
    );
    this.code = init.code;
    this.fundsMoved = init.fundsMoved;
    this.paymentId = stringOrNull(body.payment_id);
    this.intentState = stringOrNull(body.intent_state);
    this.delivery = paymentDelivery(body.delivery);
    this.deduplicated = booleanOrNull(body.deduplicated);
    this.settledAt = stringOrNull(body.settled_at);
    if (init.cause !== undefined) this.cause = init.cause;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      fundsMoved: this.fundsMoved,
      paymentId: this.paymentId,
      intentState: this.intentState,
      delivery: this.delivery,
      deduplicated: this.deduplicated,
      settledAt: this.settledAt,
    };
  }
}

/**
 * A receipt policy failed after a paid response was received. The original
 * response and commerce result remain available for reconciliation.
 */
export class PaymentPolicyError extends PaymentBuyerError {
  readonly response: Response;
  readonly result: PayFetchResult;
  readonly mutationState: "not_started" | "committed" | "unknown";
  readonly safeToRetry: boolean;
  readonly nextActions: PaymentNextAction[];

  constructor(init: {
    response: Response;
    result: PayFetchResult;
    message: string;
    fundsMoved: PaymentFundsMoved;
    mutationState: "not_started" | "committed" | "unknown";
    safeToRetry: boolean;
    nextActions: PaymentNextAction[];
  }) {
    super({
      code: "MERCHANT_RECEIPT_UNAVAILABLE",
      message: init.message,
      fundsMoved: init.fundsMoved,
      safeToRetry: init.safeToRetry,
      details: {
        merchant_receipt_status:
          init.result.payment?.merchantReceipt.status ?? "unavailable",
      },
      nextActions: init.nextActions.map((action) => ({
        type: action.type,
        why: action.why,
        ...(action.request ? { request: action.request } : {}),
        ...(action.reusePayer ? { reuse_payer: action.reusePayer } : {}),
        ...(action.reuseIdempotencyKey
          ? { reuse_idempotency_key: action.reuseIdempotencyKey }
          : {}),
      })),
      body: {
        error: "MERCHANT_RECEIPT_UNAVAILABLE",
        code: "MERCHANT_RECEIPT_UNAVAILABLE",
        message: init.message,
        category: "payment_policy",
        source: "sdk",
        retryable: init.safeToRetry,
        safe_to_retry: init.safeToRetry,
        mutation_state: init.mutationState,
        funds_moved: init.fundsMoved,
        details: {
          merchant_receipt_status:
            init.result.payment?.merchantReceipt.status ?? "unavailable",
        },
        next_actions: init.nextActions,
      },
    });
    this.response = init.response;
    this.result = init.result;
    this.mutationState = init.mutationState;
    this.safeToRetry = init.safeToRetry;
    this.nextActions = init.nextActions;
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

export function isPaymentPolicyError(
  error: unknown,
): error is PaymentPolicyError {
  return Boolean(
    isPaymentBuyerError(error) &&
      (error as { code?: unknown }).code ===
        "MERCHANT_RECEIPT_UNAVAILABLE" &&
      (error as { response?: unknown }).response instanceof Response &&
      typeof (error as { result?: unknown }).result === "object",
  );
}

export type PayExecutor = (
  url: string,
  init: RequestInit | undefined,
  options: Required<
    Pick<PayFetchOptions, "maxUsdMicros" | "requireReceipt">
  > &
    Pick<PayFetchOptions, "idempotencyKey">,
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
        requireReceipt: options.requireReceipt === true,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
    }

    const response = await this.client.fetch(normalizedUrl, nextInit);
    if (response.status === 402) {
      if (options.requireReceipt) {
        throw merchantReceiptRequiredError();
      }
      throw walletUnavailableError();
    }
    return {
      response,
      payment: null,
      outcome: "not_required",
      replay: await responseSignalsReplay(response, options.idempotencyKey !== undefined),
      ...payResponseMetadata(response),
    };
  }
}

export function merchantReceiptRequiredError(
  details: Record<string, unknown> = {},
): PaymentBuyerError {
  return new PaymentBuyerError({
    code: "MERCHANT_RECEIPT_REQUIRED",
    message:
      "No eligible payment requirement carried a valid wallet-rooted merchant offer.",
    fundsMoved: false,
    safeToRetry: true,
    details,
    nextActions: [],
    body: {
      error: "MERCHANT_RECEIPT_REQUIRED",
      code: "MERCHANT_RECEIPT_REQUIRED",
      message:
        "No eligible payment requirement carried a valid wallet-rooted merchant offer.",
      category: "payment_policy",
      source: "sdk",
      retryable: false,
      safe_to_retry: true,
      mutation_state: "not_started",
      funds_moved: false,
      details,
      next_actions: [],
    },
  });
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
  const declared = booleanHeader(response.headers.get("x-run402-payment-deduplicated"));
  if (declared !== null) return declared;
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

/** Parse platform-owned payment response headers without consuming the response body. */
export function payResponseMetadata(response: Response): PayResponseMetadata {
  const funds = response.headers.get("x-run402-payment-funds-moved");
  const delivery = response.headers.get("x-run402-payment-delivery");
  return {
    paymentId: nonEmpty(response.headers.get("x-run402-payment-id")),
    deduplicated: booleanHeader(response.headers.get("x-run402-payment-deduplicated")),
    fundsMoved: funds === "true" ? true : funds === "false" ? false : funds === "unknown" ? "unknown" : null,
    delivery: delivery === "first" || delivery === "replay" || delivery === "none" ? delivery : null,
    settledAt: nonEmpty(response.headers.get("x-run402-payment-settled-at")),
    intentState: nonEmpty(response.headers.get("x-run402-payment-intent-state")),
  };
}

export const RUN402_PENDING_CLASSIFIER_VERSION = 1;

const RESERVED_RUN402_LABELS = new Set([
  "api", "admin", "assets", "cdn", "dashboard", "docs", "help", "mail",
  "sites", "static", "status", "support", "www",
]);

/** Exact DNS-label classifier for Run402-owned tenant and deployment hosts. */
export function isTrustedRun402PaymentUrl(
  input: string | URL,
  options: { allowTestLocalhost?: boolean } = {},
): boolean {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return false;
  }
  if (options.allowTestLocalhost && url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return true;
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const labels = url.hostname.toLowerCase().split(".");
  if (labels.length === 3 && labels[1] === "run402" &&
      (labels[2] === "com" || labels[2] === "app")) {
    return labels[0]!.length > 0 && !RESERVED_RUN402_LABELS.has(labels[0]!);
  }
  return labels.length === 4 && labels[1] === "sites" && labels[2] === "run402" &&
    (labels[3] === "com" || labels[3] === "app") && labels[0]!.length > 0;
}

/**
 * Trust a pending result only at the complete signed-response boundary. The
 * caller supplies `paymentBearing` and `redirectsDisabled` from its executor;
 * shape alone is intentionally insufficient for arbitrary/custom domains.
 */
export function isTrustedRun402PendingResponse(input: {
  requestUrl: string;
  response: Response;
  envelope: Record<string, unknown> | null;
  paymentBearing: boolean;
  redirectsDisabled: boolean;
  allowTestLocalhost?: boolean;
}): boolean {
  if (!input.paymentBearing || !input.redirectsDisabled || input.response.redirected) return false;
  if (input.response.status !== 409 || input.envelope?.code !== "PAYMENT_INTENT_PENDING") return false;
  if (input.response.headers.get("x-run402-payment-intent-state") !== "pending") return false;
  if (!input.response.url) return false;
  try {
    const requestUrl = new URL(input.requestUrl);
    const responseUrl = new URL(input.response.url);
    return requestUrl.origin === responseUrl.origin &&
      isTrustedRun402PaymentUrl(requestUrl, { allowTestLocalhost: input.allowTestLocalhost });
  } catch {
    return false;
  }
}

export async function readPaymentErrorEnvelope(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.headers.get("content-type")?.includes("application/json")) return null;
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > 1_000_000) return null;
  try {
    const value = await response.clone().json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function gatewayPaymentBuyerError(
  response: Response,
  envelope: Record<string, unknown>,
): PaymentBuyerError | null {
  const code = envelope.code;
  if (!isPaymentBuyerErrorCode(code)) return null;
  const metadata = payResponseMetadata(response);
  const declaredFunds = envelope.funds_moved;
  const fundsMoved: PaymentFundsMoved =
    declaredFunds === true || declaredFunds === false || declaredFunds === "unknown"
      ? declaredFunds
      : metadata.fundsMoved ?? "unknown";
  const body: Record<string, unknown> = {
    ...envelope,
    ...(envelope.payment_id === undefined && metadata.paymentId !== null
      ? { payment_id: metadata.paymentId }
      : {}),
    ...(envelope.deduplicated === undefined && metadata.deduplicated !== null
      ? { deduplicated: metadata.deduplicated }
      : {}),
    ...(envelope.delivery === undefined && metadata.delivery !== null
      ? { delivery: metadata.delivery }
      : {}),
    ...(envelope.settled_at === undefined && metadata.settledAt !== null
      ? { settled_at: metadata.settledAt }
      : {}),
    ...(envelope.intent_state === undefined && metadata.intentState !== null
      ? { intent_state: metadata.intentState }
      : {}),
    ...(envelope.funds_moved === undefined && metadata.fundsMoved !== null
      ? { funds_moved: metadata.fundsMoved }
      : {}),
  };
  return new PaymentBuyerError({
    code,
    message: typeof envelope.message === "string" ? envelope.message : code,
    fundsMoved,
    details: isRecord(envelope.details) ? envelope.details : {},
    nextActions: Array.isArray(envelope.next_actions) ? envelope.next_actions as NextAction[] : [],
    retryable: typeof envelope.retryable === "boolean" ? envelope.retryable : false,
    safeToRetry: typeof envelope.safe_to_retry === "boolean" ? envelope.safe_to_retry : false,
    status: response.status,
    body,
  });
}

function isPaymentBuyerErrorCode(value: unknown): value is PaymentBuyerErrorCode {
  return typeof value === "string" && new Set<string>([
    "PAYMENT_EXCEEDS_MAX", "PAYMENT_WALLET_UNFUNDED", "PAYMENT_NETWORK_UNSUPPORTED",
    "PAYMENT_INTENT_PENDING", "PAYMENT_DESTINATION_DRAINING",
    "PAYMENT_INTENT_DESTINATION_CHANGED", "PAYMENT_INTENT_FENCE_EXPIRED",
    "PAYMENT_AUTHORIZATION_LIFETIME_EXCEEDED", "PAYMENT_CALLER_IDENTITY_NOT_ACTIVE",
    "IDEMPOTENCY_KEY_REUSED",
    "INVALID_IDEMPOTENCY_KEY", "IDEMPOTENCY_KEY_PAYER_REQUIRED",
    "PAYMENT_SETTLEMENT_FAILED",
    "MERCHANT_RECEIPT_REQUIRED", "MERCHANT_RECEIPT_UNAVAILABLE",
  ]).has(value);
}

function nonEmpty(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function booleanHeader(value: string | null): boolean | null {
  return value === "true" ? true : value === "false" ? false : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function paymentDelivery(value: unknown): "first" | "replay" | "none" | null {
  return value === "first" || value === "replay" || value === "none" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
