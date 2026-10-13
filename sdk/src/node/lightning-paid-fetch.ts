/**
 * The Lightning rail's buyer. Where the seller offers the x402 `exact` scheme
 * on Lightning (`lightning-x402-lnbtc.ts`) it pays that; otherwise it is a
 * `fetch` that selects Run402's MPP Lightning safety profile on every request, pays the one fixed BOLT11 challenge a 402
 * carries from the agent's own wallet (the budgeted sub-wallet on Run402's
 * Hub, over NWC), presents the preimage as the credential on a byte-identical
 * retry, and falls back to the x402 buyer when the seller offers no Lightning
 * challenge (the rail is unavailable, or the surface is not charged over it).
 *
 * The all-in debit cap (invoice plus routing fee, in msat and USD) is checked
 * against the wallet's remaining budget before paying. The pairing secret,
 * the preimage, and the invoice never reach a log or an error.
 *
 * Once the invoice is paid the money has moved, so the gateway's own "come
 * back for the fulfilment" answers on the paid retry (`PAYMENT_RECOVERY_PENDING`,
 * `PAYMENT_INTENT_PENDING`, `PAYMENT_STATE_UNAVAILABLE`, `PAYMENT_EVIDENCE_UNAVAILABLE`,
 * each with a `retry` next action and a `Retry-After`) are honoured here: the
 * byte-identical paid retry is repeated after the wait, a bounded number of
 * times. It lands on the same payment intent and is fulfilled without a second
 * payment; a settled intent never receives a fresh challenge.
 */
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  type PayExecutor,
  type PayFetchResult,
  type PaymentReceipt,
  payResponseMetadata,
  responseSignalsReplay,
} from "../namespaces/pay.js";
import { loadLightningStack, type LightningStack } from "./_paid-stack.js";
import {
  explicitRequestHeaders,
  isX402LightningCandidate,
  payX402Lightning,
  readX402LightningOffer,
  x402LightningNetworks,
  type X402LnbtcPaid,
} from "./lightning-x402-lnbtc.js";
import { NwcError, NwcWallet } from "./nwc.js";

/** The x402 network ids of Bitcoin mainnet and testnet3 (`lnbtc:` + the genesis hash prefix). */
export const LNBTC_MAINNET = "lnbtc:000000000019d6689c085ae165831e93";
export const LNBTC_TESTNET = "lnbtc:000000000933ea01ad0ee984209779ba";

/** The `lnbtc` network id for a node's reported network name, or null when the scheme defines none. */
export function lnbtcNetworkForNodeNetwork(name: string | null | undefined): string | null {
  const lower = (name ?? "").toLowerCase();
  if (lower === "mainnet" || lower === "bitcoin") return LNBTC_MAINNET;
  if (lower === "testnet" || lower === "testnet3") return LNBTC_TESTNET;
  return null;
}

type FetchFn = typeof globalThis.fetch;

export const RUN402_MPP_LIGHTNING_PROFILE = "run402-mpp-lightning-charge-draft00-safety-v1";
const ACCEPT_PAYMENT = `lightning/charge;profile=${RUN402_MPP_LIGHTNING_PROFILE}, tempo/charge;q=0.5`;
/** Routing-fee headroom on top of the invoice, in sats (internal Hub payments cost 0). */
const FEE_HEADROOM_SATS = 10;
/** A single Run402 charge above this is refused before paying (the spec's conservative USD ceiling in sats). */
export const LIGHTNING_MAX_DEBIT_SATS = 250_000;

/**
 * The gateway's post-settlement "not yet" answers. Each names the retained
 * intent, carries a `retry` next action and a `Retry-After`, and is answered
 * by repeating the identical paid request — the same Idempotency-Key and the
 * same credential — never by paying again. Terminal answers (`PAYMENT_CREDITED`,
 * `PAYMENT_MANUAL_REVIEW`) carry a different action and are returned as-is.
 */
const POST_SETTLEMENT_RETRY_CODES = new Set([
  "PAYMENT_RECOVERY_PENDING",
  "PAYMENT_INTENT_PENDING",
  "PAYMENT_STATE_UNAVAILABLE",
  "PAYMENT_EVIDENCE_UNAVAILABLE",
]);
/** Bounded: the gateway credits a charge it cannot fulfil after three recovery cycles, well inside this. */
export const POST_SETTLEMENT_RETRY_LIMIT = 6;
const POST_SETTLEMENT_RETRY_MIN_MS = 1_000;
const POST_SETTLEMENT_RETRY_MAX_MS = 10_000;
const POST_SETTLEMENT_RETRY_DEFAULT_MS = 2_000;

export interface PostSettlementRetry {
  code: string;
  delayMs: number;
}

/**
 * The paid retry's answer, when it is one of the gateway's retryable
 * post-settlement states from the origin that was asked: the code and how
 * long to wait before repeating the identical request. Null for everything
 * else, including a terminal 409 and any answer from another origin.
 */
export async function readPostSettlementRetry(response: Response, url: string): Promise<PostSettlementRetry | null> {
  if ((response.status !== 409 && response.status !== 503) || response.redirected) return null;
  if (response.url) {
    try {
      if (new URL(response.url).origin !== new URL(url).origin) return null;
    } catch {
      return null;
    }
  }
  if (!response.headers.get("content-type")?.includes("application/json")) return null;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { code, next_actions: nextActions } = body as { code?: unknown; next_actions?: unknown };
  if (typeof code !== "string" || !POST_SETTLEMENT_RETRY_CODES.has(code)) return null;
  const action = Array.isArray(nextActions) ? nextActions[0] as { type?: unknown } | undefined : undefined;
  if (!action || typeof action !== "object" || action.type !== "retry") return null;
  const raw = response.headers.get("retry-after");
  const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : null;
  const delayMs = seconds === null
    ? POST_SETTLEMENT_RETRY_DEFAULT_MS
    : Math.min(POST_SETTLEMENT_RETRY_MAX_MS, Math.max(POST_SETTLEMENT_RETRY_MIN_MS, seconds * 1_000));
  return { code, delayMs };
}

export interface LightningWalletLike {
  getBudgetSats(): Promise<{ usedSats: number; totalSats: number | null } | null>;
  getBalanceSats(): Promise<number>;
  payInvoice(bolt11: string): Promise<{ preimage: string }>;
  lookupInvoice(paymentHash: string): Promise<{ state: string | null; preimage: string | null } | null>;
  /** The node's network name (`mainnet`, `testnet`, …); used when the wallet's network is probed. */
  getInfo?(): Promise<{ network: string | null; pubkey: string | null; methods: string[] }>;
}

/** Per-call limits a `pay.fetch` call hands the buyer; read through `perCall`. */
export interface LightningCallOptions {
  /** Refuse a Lightning payment whose invoice plus routing headroom exceeds this many sats. */
  maxSats?: number;
  /** A merchant receipt was demanded; no `lnbtc` entry carries one, so the buyer refuses before paying. */
  requireReceipt?: boolean;
}

export interface LightningFetchOptions {
  pairingUri: string;
  /** The x402 buyer to use when the seller offers no Lightning challenge. */
  fallback: () => Promise<FetchFn | null>;
  baseFetch?: FetchFn;
  wallet?: LightningWalletLike;
  stack?: () => Promise<LightningStack>;
  /**
   * The wallet's `lnbtc` network id: the platform Hub sub-wallet is mainnet
   * (the default); `"probe"` asks the node once (`get_info`) and remembers
   * the answer, for a bring-your-own pairing.
   */
  walletNetwork?: string | "probe";
  /** The per-call limits of the `pay.fetch` call in flight, when any. */
  perCall?: () => LightningCallOptions | undefined;
  /** Called with the payment hash of each paid challenge (never the preimage), and what was paid. */
  onPaid?: (paymentHash: string, paid?: X402LnbtcPaid) => void;
  /** The wait between post-settlement retries; tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
  /** Unix seconds for x402 Lightning invoice checks; tests pin it. */
  clock?: () => number;
}

export class LightningPaymentError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "LightningPaymentError";
  }
}

interface LightningChallenge {
  header: string;
  invoice: string;
  paymentHash: string;
  amountSats: number;
  expires: string | null;
}

/** The `WWW-Authenticate: Payment …` challenge for lightning/charge, or null. */
export function readLightningChallenge(response: Response, stack: LightningStack): LightningChallenge | null {
  if (response.status !== 402) return null;
  const header = response.headers.get("www-authenticate");
  if (!header || !/^payment\s/i.test(header)) return null;
  let challenge: ReturnType<LightningStack["Challenge"]["deserialize"]>;
  try {
    challenge = stack.Challenge.deserialize(header);
  } catch {
    return null;
  }
  if (challenge.method !== "lightning" || challenge.intent !== "charge") return null;
  const request = (challenge.request ?? {}) as Record<string, unknown>;
  const details = (request.methodDetails ?? {}) as Record<string, unknown>;
  const invoice = typeof details.invoice === "string" ? details.invoice : "";
  const paymentHash = typeof details.paymentHash === "string" ? details.paymentHash.toLowerCase() : "";
  const amountSats = Number(request.amount);
  if (!invoice || !/^[0-9a-f]{64}$/.test(paymentHash) || !Number.isFinite(amountSats) || amountSats <= 0) return null;
  return { header, invoice, paymentHash, amountSats, expires: typeof challenge.expires === "string" ? challenge.expires : null };
}

function withLightningHeaders(init: RequestInit | undefined, idempotencyKey: string): RequestInit {
  const headers = new Headers(init?.headers ?? {});
  headers.set("run402-payment-profile", RUN402_MPP_LIGHTNING_PROFILE);
  headers.set("accept-payment", ACCEPT_PAYMENT);
  if (!headers.has("idempotency-key")) headers.set("idempotency-key", idempotencyKey);
  return { ...init, headers };
}

function sha256Hex(hex: string): string {
  return createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
}

/** The Run402 surfaces charged over Lightning (`/.well-known/x402` → `paymentCapabilities[].resources`). */
const CHARGED_PATHS = [/^\/tiers\/v1\/[^/]+$/, /^\/generate-image\/v1$/];

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  return (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
}

/**
 * Only a POST to a charged surface gets the Lightning negotiation headers
 * and a default Idempotency-Key. Every other request is left byte-for-byte
 * alone: an Idempotency-Key on an ordinary write (a room message, a project
 * provision) would turn a deliberate repeat into a replay.
 */
export function isLightningChargedRequest(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  if (requestMethod(input, init) !== "POST") return false;
  let pathname: string;
  try {
    pathname = new URL(requestUrl(input)).pathname;
  } catch {
    return false;
  }
  return CHARGED_PATHS.some((pattern) => pattern.test(pathname));
}

function defaultIdempotencyKey(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const url = requestUrl(input);
  const method = requestMethod(input, init);
  const body = typeof init?.body === "string" ? init.body : init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : "";
  const digest = createHash("sha256").update(`${method}\n${url}\n${body}`).digest("hex");
  return `lnc_${digest.slice(0, 32)}`;
}

/**
 * The all-in debit cap, shared by both Lightning protocols: the charge plus
 * routing-fee headroom must fit the rail's ceiling and the wallet's remaining
 * budget. Throws before anything is paid.
 */
async function checkLightningCaps(wallet: LightningWalletLike, amountSats: number, maxSats?: number): Promise<void> {
  const allIn = amountSats + FEE_HEADROOM_SATS;
  if (maxSats !== undefined && allIn > maxSats) {
    throw new LightningPaymentError("LIGHTNING_DEBIT_ABOVE_CAP", `A Lightning charge of ${amountSats} sats (plus ${FEE_HEADROOM_SATS} sats routing headroom) exceeds the ${maxSats}-sat cap given for this call.`, { amount_sats: amountSats, cap_sats: maxSats, cap_source: "max_sats", next_action: "raise maxSats / --max-sats, or pay over x402" });
  }
  if (allIn > LIGHTNING_MAX_DEBIT_SATS) {
    throw new LightningPaymentError("LIGHTNING_DEBIT_ABOVE_CAP", `A Lightning charge of ${amountSats} sats exceeds the ${LIGHTNING_MAX_DEBIT_SATS}-sat ceiling.`, { amount_sats: amountSats, cap_sats: LIGHTNING_MAX_DEBIT_SATS, cap_source: "ceiling", next_action: "pay over x402 (run402 init --switch-rail)" });
  }
  const budget = await wallet.getBudgetSats().catch(() => null);
  if (budget && budget.totalSats !== null && budget.totalSats - budget.usedSats < allIn) {
    throw new LightningPaymentError("LIGHTNING_BUDGET_EXHAUSTED", `The Lightning wallet's remaining budget (${budget.totalSats - budget.usedSats} sats) cannot cover ${allIn} sats.`, { remaining_sats: budget.totalSats - budget.usedSats, required_sats: allIn, next_action: "pay over x402 (run402 init --switch-rail), or ask the platform for a new wallet" });
  }
}

export function createLightningFetch(options: LightningFetchOptions): FetchFn {
  const baseFetch: FetchFn = options.baseFetch ?? ((input, init) => globalThis.fetch(input, init));
  const wallet: LightningWalletLike = options.wallet ?? new NwcWallet(options.pairingUri);
  const loadStack = options.stack ?? loadLightningStack;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const perCall = options.perCall ?? (() => undefined);
  let fallbackFetch: FetchFn | null | undefined;
  let walletNetwork: Promise<string | null> | undefined;

  const fallback = async (): Promise<FetchFn | null> => {
    if (fallbackFetch === undefined) fallbackFetch = await options.fallback();
    return fallbackFetch;
  };

  /** The wallet's `lnbtc` network: configured, or probed from the node once. */
  const resolveWalletNetwork = (): Promise<string | null> => {
    if (walletNetwork === undefined) {
      walletNetwork = options.walletNetwork === "probe"
        ? (wallet.getInfo ? wallet.getInfo().then((info) => lnbtcNetworkForNodeNetwork(info.network)) : Promise.resolve(null))
        : Promise.resolve(options.walletNetwork ?? LNBTC_MAINNET);
    }
    return walletNetwork;
  };

  /** Pay the 402's `lnbtc` entry on the wallet's network, or say exactly why not. */
  const payOffer = async (input: RequestInfo | URL, init: RequestInit | undefined, probe: Response): Promise<Response | null> => {
    const offered = x402LightningNetworks(probe);
    if (offered.length === 0) return null;
    const network = await resolveWalletNetwork();
    const offer = network === null ? null : readX402LightningOffer(probe, network);
    await probe.body?.cancel().catch(() => undefined);
    if (!offer) {
      throw new LightningPaymentError(
        "LIGHTNING_NETWORK_MISMATCH",
        `The seller's Lightning offer is on ${offered.join(", ")} and this wallet is on ${network ?? "an unsupported network"}; nothing was paid.`,
        { offered_networks: offered, wallet_network: network, next_action: "pay with a pairing on that network: run402 pay --lightning-pairing <file|->" },
      );
    }
    const call = perCall();
    if (call?.requireReceipt) {
      throw new LightningPaymentError(
        "LIGHTNING_RECEIPT_UNAVAILABLE",
        "An x402 Lightning entry carries no merchant receipt; drop requireReceipt (--require-receipt) or pay over x402 USDC. Nothing was paid.",
        { network: offer.requirements.network },
      );
    }
    return payX402Lightning({
      input,
      init,
      offer,
      wallet,
      baseFetch,
      fail: (code, message, details) => new LightningPaymentError(code, message, details),
      checkCaps: (amountSats) => checkLightningCaps(wallet, amountSats, call?.maxSats),
      onPaid: options.onPaid,
      ...(options.clock ? { clock: options.clock } : {}),
    });
  };

  return async (input, init) => {
    if (!isLightningChargedRequest(input, init)) {
      // Any other URL: the 402 decides. An `lnbtc` entry on the wallet's
      // network is paid here; one on another network is refused by name; no
      // entry at all hands the request to the x402 buyer (or the plain fetch).
      const probe = await baseFetch(input, init);
      if (probe.status !== 402) return probe;
      const paid = await payOffer(input, init, probe);
      if (paid) return paid;
      const other = (await fallback()) ?? baseFetch;
      return other(input, init);
    }
    // x402 `exact` on Lightning first where the seller offers it: a request
    // without the MPP profile reaches the seller's x402 paywall, whose 402
    // names an `lnbtc` entry while its Hub can issue. No entry (the Hub is
    // paused, or this surface has none) falls through to MPP Lightning.
    if (isX402LightningCandidate(input, init)) {
      const probe = await baseFetch(input, { ...init, headers: explicitRequestHeaders(init) });
      if (probe.status !== 402) return probe;
      const paid = await payOffer(input, init, probe);
      if (paid) return paid;
    }
    // Deterministic over the request bytes: a retry of the identical call
    // (after a crash, a timeout, or a gateway hiccup between payment and
    // fulfilment) lands on the same payment intent and is fulfilled without
    // a second payment. A deliberate second identical purchase passes its
    // own Idempotency-Key.
    const idempotencyKey = defaultIdempotencyKey(input, init);
    const firstInit = withLightningHeaders(init, idempotencyKey);
    const first = await baseFetch(input, firstInit);
    if (first.status !== 402) return first;
    const stack = await loadStack();
    const challenge = readLightningChallenge(first, stack);
    if (!challenge) {
      // No Lightning offer: the seller wants x402 (or the rail is paused).
      const x402 = await fallback();
      if (!x402) return first;
      await first.body?.cancel().catch(() => undefined);
      return x402(input, init);
    }
    await first.body?.cancel().catch(() => undefined);

    await checkLightningCaps(wallet, challenge.amountSats, perCall()?.maxSats);

    let preimage: string;
    try {
      preimage = (await wallet.payInvoice(challenge.invoice)).preimage;
    } catch (error) {
      // Unknown outcome: resolve by hash before ever paying again.
      if (error instanceof NwcError && (error.code === "TIMEOUT" || error.code === "RELAY_CLOSED" || error.code === "RELAY_UNREACHABLE")) {
        const looked = await wallet.lookupInvoice(challenge.paymentHash).catch(() => null);
        if (looked?.preimage) preimage = looked.preimage;
        else throw new LightningPaymentError("LIGHTNING_PAYMENT_OUTCOME_UNKNOWN", "The Lightning payment's outcome is unknown; the same request may be retried with the same Idempotency-Key once the wallet is reachable.", { payment_hash: challenge.paymentHash, idempotency_key: idempotencyKey });
      } else if (error instanceof NwcError) {
        throw new LightningPaymentError(`LIGHTNING_${error.code}`, `The Lightning wallet refused the payment (${error.code}).`, { payment_hash: challenge.paymentHash, next_action: "pay over x402 (run402 init --switch-rail)" });
      } else {
        throw error;
      }
    }
    if (sha256Hex(preimage) !== challenge.paymentHash) {
      throw new LightningPaymentError("LIGHTNING_PREIMAGE_MISMATCH", "The wallet returned a preimage that does not hash to the challenge's payment hash.", { payment_hash: challenge.paymentHash });
    }
    options.onPaid?.(challenge.paymentHash);
    const credential = stack.Credential.serialize(stack.Credential.from({
      challenge: stack.Challenge.deserialize(challenge.header),
      payload: { preimage },
    }));
    const retryHeaders = new Headers(firstInit.headers);
    retryHeaders.set("authorization", credential);
    // Byte-identical retry: same body, same Idempotency-Key, plus the credential.
    const paidInit: RequestInit = { ...firstInit, headers: retryHeaders };
    let response = await baseFetch(input, paidInit);
    // The money has moved. While the gateway says the settled charge's
    // fulfilment is still pending, repeat the identical paid request after
    // its Retry-After: the same intent, no second payment, a bounded wait.
    for (let waits = 0; waits < POST_SETTLEMENT_RETRY_LIMIT; waits += 1) {
      const pending = await readPostSettlementRetry(response, requestUrl(input));
      if (!pending) break;
      await response.body?.cancel().catch(() => undefined);
      await sleep(pending.delayMs);
      response = await baseFetch(input, paidInit);
    }
    return response;
  };
}

interface LightningPayCall extends LightningCallOptions {
  paymentHash?: string;
  paid?: X402LnbtcPaid;
}

/**
 * `pay.fetch` on the Lightning rail: the buyer above, run under a per-call
 * context that carries the call's caps in and the payment it made out, so the
 * result reports the `lnbtc` network and the payment hash as its
 * transaction. A request that needed no payment, or that the x402 fallback
 * paid, is reported as the fallback reports it.
 */
export function createLightningPayExecutor(options: Omit<LightningFetchOptions, "perCall" | "onPaid"> & {
  /** The x402 executor that reports a USDC payment made by the fallback, when there is one. */
  fallbackPay?: PayExecutor | null;
}): PayExecutor {
  const calls = new AsyncLocalStorage<LightningPayCall>();
  const fetchFn = createLightningFetch({
    ...options,
    perCall: () => calls.getStore(),
    onPaid: (paymentHash, paid) => {
      const call = calls.getStore();
      if (call) {
        call.paymentHash = paymentHash;
        if (paid) call.paid = paid;
      }
    },
  });
  return async (url, init, payOptions) => {
    const call: LightningPayCall = {
      ...(payOptions.maxSats !== undefined ? { maxSats: payOptions.maxSats } : {}),
      requireReceipt: payOptions.requireReceipt === true,
    };
    const response = await calls.run(call, () => fetchFn(url, init));
    if (!call.paymentHash || !call.paid) {
      return {
        response,
        payment: null,
        outcome: "not_required",
        replay: await responseSignalsReplay(response, payOptions.idempotencyKey !== undefined),
        ...payResponseMetadata(response),
      };
    }
    const settled = readSettledPaymentResponse(response);
    // A Lightning entry carries no merchant receipt and no signer authorization, so these instants are absent.
    const noInstant: string | null = null;
    const payment: PaymentReceipt = {
      network: call.paid.network,
      paymentId: null,
      amountUsdMicros: 0,
      amountMsat: call.paid.amountMsat,
      asset: "BTC",
      payer: null,
      payTo: call.paid.payTo,
      transaction: settled?.transaction ?? call.paymentHash,
      resourceUrl: call.paid.resourceUrl,
      settlement: { status: settled?.success ? "verified" : "unavailable" },
      fundsMoved: true,
      deduplicated: false,
      delivery: { status: response.ok ? "fulfilled" : "failed", replay: false },
      offer: { status: "absent", resourceUrl: null, validUntil: null },
      merchantReceipt: { status: "absent", claim: null, issuedAt: noInstant },
      signerRelationship: { kind: null, merchantRoot: null, signer: null, authorizationExpiresAt: noInstant },
      policy: { requireReceipt: false, status: "not_required" },
      evidence: { offer: null, merchantReceipt: null, signerAuthorization: null },
    };
    const result: PayFetchResult = {
      response,
      payment,
      outcome: "settled",
      replay: false,
      ...payResponseMetadata(response),
    };
    return result;
  };
}

/** The seller's `PAYMENT-RESPONSE` (x402 v2): `{ success, transaction, network }`, or null. */
function readSettledPaymentResponse(response: Response): { success: boolean; transaction: string; network: string } | null {
  const header = response.headers.get("payment-response");
  if (!header) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { success?: unknown; transaction?: unknown; network?: unknown };
    return {
      success: parsed.success === true,
      transaction: typeof parsed.transaction === "string" ? parsed.transaction : "",
      network: typeof parsed.network === "string" ? parsed.network : "",
    };
  } catch {
    return null;
  }
}
