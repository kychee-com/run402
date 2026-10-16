/**
 * `pay.fetch` on the `mpp` rail: buy an arbitrary URL whose 402 carries an
 * MPP Tempo charge challenge (spec `tenant-x402-payment-client-surface`,
 * decision D-tenant-mpp-priced-routes-9).
 *
 * Send the request; on 402 select the first offered Tempo chain the wallet
 * covers (`orderTempoCandidates`, through mppx's own selection), apply the USD
 * spend guard to the selected challenge before anything is signed, sign, and
 * retry the identical request with `Authorization: Payment`. The attempt is
 * journaled before the signed request leaves.
 *
 * An MPP payment's identity is its credential, not the caller key: the
 * gateway resolves a re-presented credential to the original payment and
 * treats `Idempotency-Key` as correlation only. So the signed credential stays
 * in this instance's memory for the identical request, and an ambiguous or
 * pending outcome is answered by re-presenting it, never by signing a second
 * one. A clean refusal (no funds moved) forgets it.
 */
import { createHash } from "node:crypto";

import { LocalError } from "../errors.js";
import {
  PaymentBuyerError,
  gatewayPaymentBuyerError,
  isTrustedRun402PendingResponse,
  merchantReceiptRequiredError,
  payResponseMetadata,
  paymentExceedsMaxError,
  readPaymentErrorEnvelope,
  responseSignalsReplay,
  type PayExecutor,
  type PayFetchResult,
  type PaymentFundsMoved,
  type PaymentReceipt,
} from "../namespaces/pay.js";
import {
  createFilePaymentAttemptStore,
  createPaymentAttemptId,
  requestSummary,
  withPaymentAttemptHeader,
  type PaymentAttemptJournalState,
  type PaymentAttemptRecord,
  type PaymentAttemptStore,
} from "./payment-attempts.js";
import { mppChallenges, paymentOffers, type PaymentOffer } from "./payment-offers.js";
import { PATH_USD, tempoChainById } from "./tempo.js";

type FetchFn = typeof globalThis.fetch;

/** The part of an mppx prepared payment this executor reads. */
export interface PreparedMppPayment {
  challenge: { id: string; method: string; intent: string; request: unknown; expires?: string };
  createCredential: () => Promise<string>;
  setCredential: (request: RequestInit, credential: string) => RequestInit;
}

export interface MppPayExecutorOptions {
  /** mppx `preparePayment` over the wallet's Tempo method; selection includes the balance ordering. */
  prepare: (response: Response, request: RequestInit) => Promise<PreparedMppPayment>;
  /** The paying wallet's address. */
  payer: string;
  baseFetch: FetchFn;
  /** Thrown when a 402 offers nothing this rail pays. */
  unsupported: (offers: PaymentOffer[]) => Error;
  /** Stable identity of an identical request (URL, method, body, caps). */
  fingerprint: (url: string, init: RequestInit | undefined, maxUsdMicros: number, requireReceipt: boolean) => Promise<string>;
  store?: PaymentAttemptStore;
  createAttemptId?: () => string;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Tests only: trust a Run402 pending answer from `http://localhost`. */
  allowTestLocalhost?: boolean;
}

/** Bounded waits for the gateway's "settlement still pending" answer to the paid request. */
export const MPP_PENDING_RETRY_LIMIT = 4;
const PENDING_RETRY_MIN_MS = 1_000;
const PENDING_RETRY_MAX_MS = 10_000;

interface HeldCredential {
  /** The header(s) mppx attaches for the selected challenge; usually `Authorization: Payment …`. */
  credentialHeaders: Array<[string, string]>;
  challenge: TempoChargeOffer;
  attemptId: string;
}

interface TempoChargeOffer {
  chainId: number;
  network: string;
  amountUsdMicros: number;
  recipient: string;
}

export function createMppPayExecutor(options: MppPayExecutorOptions): PayExecutor {
  const held = new Map<string, HeldCredential>();
  const store = options.store ?? createFilePaymentAttemptStore();
  const makeId = options.createAttemptId ?? createPaymentAttemptId;
  const now = options.now ?? (() => new Date().toISOString());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async (url, init, payOptions) => {
    const fingerprint = await options.fingerprint(url, init, payOptions.maxUsdMicros, payOptions.requireReceipt);
    const request = new Request(url, init);
    let hold = held.get(fingerprint);
    if (!hold) {
      const first = await options.baseFetch(request.clone());
      if (first.status !== 402) {
        return {
          response: first,
          payment: null,
          outcome: "not_required",
          replay: await responseSignalsReplay(first, payOptions.idempotencyKey !== undefined),
          ...payResponseMetadata(first),
        };
      }
      hold = await signForChallenge(first, request, payOptions, options, makeId);
      held.set(fingerprint, hold);
    }

    const record = journalIntent(store, hold.attemptId, url, init, now);
    write(store, record, now, "submitting", "in_progress", { provider_started_at: now() });
    let response: Response;
    try {
      // From here a thrown transport error leaves the outcome unknown.
      response = await sendPaid(request, hold, options, sleep);
    } catch (cause) {
      writeBestEffort(store, record, now, "ambiguous", "ambiguous", { last_error_code: "MPP_PAYMENT_OUTCOME_AMBIGUOUS" });
      throw outcomeUnknown("The MPP payment request failed after the credential was sent; its outcome is unknown.", hold, cause);
    }
    return settleOutcome(url, response, hold, payOptions.idempotencyKey !== undefined, options, {
      forget: () => held.delete(fingerprint),
      journal: (state, mutation, extra) => writeBestEffort(store, record, now, state, mutation, extra),
    });
  };
}

async function signForChallenge(
  response: Response,
  request: Request,
  payOptions: Parameters<PayExecutor>[2],
  options: MppPayExecutorOptions,
  makeId: () => string,
): Promise<HeldCredential> {
  const tempoOffered = mppChallenges(response).some((challenge) => challenge.method === "tempo" && challenge.intent === "charge");
  if (!tempoOffered) {
    await response.body?.cancel().catch(() => undefined);
    throw options.unsupported(paymentOffers(response));
  }
  if (payOptions.requireReceipt) {
    // MPP carries a protocol receipt, never a wallet-rooted merchant receipt.
    await response.body?.cancel().catch(() => undefined);
    throw merchantReceiptRequiredError({ protocol: "mpp" });
  }
  const prepared = await options.prepare(response, { method: request.method, headers: request.headers });
  await response.body?.cancel().catch(() => undefined);
  const offer = tempoChargeOffer(prepared.challenge);
  if (offer.amountUsdMicros > payOptions.maxUsdMicros) {
    throw paymentExceedsMaxError(offer.amountUsdMicros, payOptions.maxUsdMicros);
  }
  const credential = await prepared.createCredential();
  // Keep exactly the header(s) mppx sets for this challenge; the request itself is rebuilt from `request`.
  const credentialHeaders = [...new Headers(prepared.setCredential({ headers: new Headers() }, credential).headers).entries()];
  return { credentialHeaders, challenge: offer, attemptId: makeId() };
}

/** Read the selected Tempo charge: pathUSD only, so base units are USD micros. */
function tempoChargeOffer(challenge: PreparedMppPayment["challenge"]): TempoChargeOffer {
  const request = (challenge.request ?? {}) as { amount?: unknown; currency?: unknown; recipient?: unknown; methodDetails?: { chainId?: unknown } };
  const chain = tempoChainById(request.methodDetails?.chainId);
  const amount = typeof request.amount === "string" && /^\d+$/.test(request.amount) ? Number(request.amount) : NaN;
  const currency = typeof request.currency === "string" ? request.currency.toLowerCase() : "";
  if (!chain || !Number.isSafeInteger(amount) || currency !== PATH_USD || typeof request.recipient !== "string") {
    throw new PaymentBuyerError({
      code: "PAYMENT_NETWORK_UNSUPPORTED",
      message: "The MPP Tempo challenge is not a pathUSD charge on a Tempo chain this wallet pays.",
      fundsMoved: false,
      details: {
        protocol: "mpp",
        chain_id: request.methodDetails?.chainId ?? null,
        currency: request.currency ?? null,
      },
      nextActions: [{ type: "edit_request", why: "Use a priced endpoint that charges pathUSD on Tempo mainnet or Moderato." }],
    });
  }
  return { chainId: chain.id, network: chain.network, amountUsdMicros: amount, recipient: request.recipient };
}

async function sendPaid(
  request: Request,
  hold: HeldCredential,
  options: MppPayExecutorOptions,
  sleep: (ms: number) => Promise<void>,
): Promise<Response> {
  const paidRequest = (): Request => {
    const headers = new Headers(request.headers);
    for (const [name, value] of hold.credentialHeaders) headers.set(name, value);
    const [, paidInit] = withPaymentAttemptHeader(request.url, { headers }, hold.attemptId, true);
    return new Request(request.clone(), paidInit);
  };
  let response = await options.baseFetch(paidRequest());
  for (let waits = 0; waits < MPP_PENDING_RETRY_LIMIT; waits += 1) {
    const delayMs = await pendingRetryDelay(request.url, response, options.allowTestLocalhost === true);
    if (delayMs === null) break;
    await response.body?.cancel().catch(() => undefined);
    await sleep(delayMs);
    // The same credential: the gateway resolves it to the same payment.
    response = await options.baseFetch(paidRequest());
  }
  return response;
}

async function pendingRetryDelay(url: string, response: Response, allowTestLocalhost: boolean): Promise<number | null> {
  const envelope = await readPaymentErrorEnvelope(response);
  const pending = isTrustedRun402PendingResponse({
    requestUrl: url,
    response,
    envelope,
    paymentBearing: true,
    redirectsDisabled: true,
    allowTestLocalhost,
  });
  if (!pending) return null;
  const seconds = Number(response.headers.get("retry-after"));
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : PENDING_RETRY_MIN_MS;
  return Math.min(PENDING_RETRY_MAX_MS, Math.max(PENDING_RETRY_MIN_MS, ms));
}

interface OutcomeHooks {
  forget: () => void;
  journal: (state: PaymentAttemptJournalState, mutation: PaymentAttemptRecord["mutation_state"], extra?: Partial<PaymentAttemptRecord>) => void;
}

async function settleOutcome(
  url: string,
  response: Response,
  hold: HeldCredential,
  keyed: boolean,
  options: MppPayExecutorOptions,
  hooks: OutcomeHooks,
): Promise<PayFetchResult> {
  const receipt = readPaymentReceipt(response);
  if (response.ok || receipt) {
    // A Payment-Receipt on a non-2xx proves the transfer: paid, delivery failed.
    hooks.journal("completed", "completed", { response_status: response.status });
    return paidResult(url, response, hold, receipt, options.payer, keyed);
  }
  const envelope = await readPaymentErrorEnvelope(response);
  const trusted = envelope ? gatewayPaymentBuyerError(response, envelope) : null;
  if (trusted) {
    const pending = trusted.code === "PAYMENT_INTENT_PENDING";
    hooks.journal(pending ? "intent_pending" : trusted.fundsMoved === false ? "failed" : "ambiguous",
      pending || trusted.fundsMoved !== false ? "ambiguous" : "not_started",
      { response_status: response.status, last_error_code: trusted.code });
    if (trusted.fundsMoved === false) hooks.forget();
    throw trusted;
  }
  const fundsMoved = refusalFundsMoved(response, envelope);
  hooks.journal(fundsMoved === false ? "failed" : "ambiguous", fundsMoved === false ? "not_started" : "ambiguous", {
    response_status: response.status,
    ...(typeof envelope?.code === "string" ? { last_error_code: envelope.code } : {}),
  });
  if (fundsMoved === false) {
    hooks.forget();
    throw new PaymentBuyerError({
      code: "PAYMENT_SETTLEMENT_FAILED",
      message: "The seller refused the MPP Tempo credential; no funds moved.",
      fundsMoved: false,
      details: { protocol: "mpp", network: hold.challenge.network, upstream_status: response.status, ...upstreamCode(envelope) },
      nextActions: [{ type: "retry", why: "No funds moved; retry to receive a fresh challenge." }],
      safeToRetry: true,
    });
  }
  throw outcomeUnknown("The seller answered the MPP payment without a receipt; whether the transfer landed is unknown.", hold, null, {
    upstream_status: response.status,
    ...upstreamCode(envelope),
  });
}

/**
 * A 402 is the seller re-challenging: it did not accept the credential. This
 * client pays Tempo in pull mode (it signs, the seller broadcasts), so a
 * refusal moved nothing unless the seller says otherwise. Any other non-2xx
 * without a receipt is unknown.
 */
function refusalFundsMoved(response: Response, envelope: Record<string, unknown> | null): PaymentFundsMoved {
  const details = envelope?.details as Record<string, unknown> | undefined;
  const declared = envelope?.funds_moved ?? details?.funds_moved;
  if (declared === true || declared === false || declared === "unknown") return declared;
  return response.status === 402 ? false : "unknown";
}

function upstreamCode(envelope: Record<string, unknown> | null): Record<string, unknown> {
  return typeof envelope?.code === "string" ? { upstream_code: envelope.code } : {};
}

function outcomeUnknown(message: string, hold: HeldCredential, cause: unknown, details: Record<string, unknown> = {}): PaymentBuyerError {
  return new PaymentBuyerError({
    code: "PAYMENT_SETTLEMENT_FAILED",
    message,
    fundsMoved: "unknown",
    details: { protocol: "mpp", network: hold.challenge.network, payment_attempt_id: hold.attemptId, ...details },
    nextActions: [{
      type: "retry",
      request: "repeat_identical",
      why: "Repeat the identical request from this client: it re-presents the same credential, which the seller resolves to the same payment and never charges twice.",
    }],
    retryable: true,
    safeToRetry: false,
    ...(cause !== null ? { cause } : {}),
  });
}

async function paidResult(
  url: string,
  response: Response,
  hold: HeldCredential,
  receipt: ProtocolReceipt | null,
  payer: string,
  keyed: boolean,
): Promise<PayFetchResult> {
  const metadata = payResponseMetadata(response);
  const deduplicated = metadata.deduplicated ?? false;
  // MPP carries no merchant receipt and no signer authorization, so these instants are absent.
  const noInstant: string | null = null;
  const payment: PaymentReceipt = {
    protocol: "mpp",
    method: "tempo",
    network: hold.challenge.network,
    paymentId: metadata.paymentId,
    amountUsdMicros: hold.challenge.amountUsdMicros,
    asset: PATH_USD,
    payer,
    payTo: hold.challenge.recipient,
    transaction: receipt?.reference ?? "",
    resourceUrl: url,
    settlement: { status: receipt ? "verified" : "unavailable" },
    fundsMoved: metadata.fundsMoved ?? (deduplicated ? false : true),
    deduplicated,
    delivery: { status: response.ok ? "fulfilled" : "failed", replay: deduplicated },
    offer: { status: "unavailable", resourceUrl: null, validUntil: null },
    merchantReceipt: { status: "unavailable", claim: null, issuedAt: noInstant },
    signerRelationship: { kind: null, merchantRoot: null, signer: null, authorizationExpiresAt: noInstant },
    policy: { requireReceipt: false, status: "not_required" },
    evidence: { offer: null, merchantReceipt: null, signerAuthorization: null, protocolReceipt: receipt },
  };
  return {
    response,
    payment,
    outcome: deduplicated ? "already_settled" : "settled",
    replay: deduplicated || await responseSignalsReplay(response, keyed),
    ...metadata,
  };
}

interface ProtocolReceipt {
  method: string;
  reference: string;
  status: string;
  timestamp: string | null;
}

/** The standard MPP `Payment-Receipt`: base64url JSON `{ method, reference, status, timestamp }`. */
function readPaymentReceipt(response: Response): ProtocolReceipt | null {
  const header = response.headers.get("payment-receipt");
  if (!header) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.status !== "success" || typeof parsed.reference !== "string" || typeof parsed.method !== "string") return null;
    return {
      method: parsed.method,
      reference: parsed.reference,
      status: parsed.status,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
    };
  } catch {
    return null;
  }
}

function journalIntent(
  store: PaymentAttemptStore,
  attemptId: string,
  url: string,
  init: RequestInit | undefined,
  now: () => string,
): PaymentAttemptRecord {
  const existing = safeRead(store, attemptId);
  if (existing) return existing;
  const summary = requestSummary(url, init);
  const at = now();
  const record: PaymentAttemptRecord = {
    version: 1,
    payment_attempt_id: attemptId,
    rail: "mpp",
    state: "intent",
    mutation_state: "not_started",
    method: summary.method,
    origin: summary.origin,
    path_sha256: summary.path_sha256,
    ...(summary.caller_key_sha256 ? { caller_key_sha256: summary.caller_key_sha256 } : {}),
    created_at: at,
    updated_at: at,
  };
  try {
    if (!store.claim(record)) {
      throw new LocalError("The generated MPP payment attempt id already exists.", "reserving MPP payment attempt", { code: "MPP_ATTEMPT_ID_COLLISION" });
    }
  } catch (cause) {
    throw new PaymentBuyerError({
      code: "PAYMENT_SETTLEMENT_FAILED",
      message: "The MPP payment was not sent because its attempt could not be recorded.",
      fundsMoved: false,
      details: { protocol: "mpp", payment_attempt_id: attemptId },
      nextActions: [{ type: "retry", why: "Nothing was sent; retry once the local config directory is writable." }],
      safeToRetry: true,
      cause,
    });
  }
  return record;
}

function safeRead(store: PaymentAttemptStore, attemptId: string): PaymentAttemptRecord | null {
  try {
    return store.read(attemptId);
  } catch {
    return null;
  }
}

/** Before dispatch the write must land: an unrecorded signed request is never sent. */
function write(
  store: PaymentAttemptStore,
  record: PaymentAttemptRecord,
  now: () => string,
  state: PaymentAttemptJournalState,
  mutation: PaymentAttemptRecord["mutation_state"],
  extra: Partial<PaymentAttemptRecord> = {},
): void {
  Object.assign(record, extra, { state, mutation_state: mutation, updated_at: now() });
  try {
    store.write({ ...record });
  } catch (cause) {
    throw new PaymentBuyerError({
      code: "PAYMENT_SETTLEMENT_FAILED",
      message: "The MPP payment was not sent because its attempt could not be recorded.",
      fundsMoved: false,
      details: { protocol: "mpp", payment_attempt_id: record.payment_attempt_id },
      nextActions: [{ type: "retry", why: "Nothing was sent; retry once the local config directory is writable." }],
      safeToRetry: true,
      cause,
    });
  }
}

function writeBestEffort(
  store: PaymentAttemptStore,
  record: PaymentAttemptRecord,
  now: () => string,
  state: PaymentAttemptJournalState,
  mutation: PaymentAttemptRecord["mutation_state"],
  extra: Partial<PaymentAttemptRecord> = {},
): void {
  try {
    write(store, record, now, state, mutation, extra);
  } catch {
    // The outcome is already decided; the journal is a best-effort record of it.
  }
}

/** Test seam: a stable fingerprint for callers without the paid-fetch one. */
export async function simpleMppFingerprint(url: string, init: RequestInit | undefined, maxUsdMicros: number, requireReceipt: boolean): Promise<string> {
  const request = new Request(url, init);
  const body = await request.clone().arrayBuffer();
  return createHash("sha256")
    .update(JSON.stringify([request.method, request.url, request.headers.get("idempotency-key"), maxUsdMicros, requireReceipt]))
    .update(Buffer.from(body))
    .digest("hex");
}
