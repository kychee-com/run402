/**
 * The Lightning rail's buyer: a `fetch` that selects Run402's MPP Lightning
 * safety profile on every request, pays the one fixed BOLT11 challenge a 402
 * carries from the agent's own wallet (the budgeted sub-wallet on Run402's
 * Hub, over NWC), presents the preimage as the credential on a byte-identical
 * retry, and falls back to the x402 buyer when the seller offers no Lightning
 * challenge (the rail is unavailable, or the surface is not charged over it).
 *
 * The all-in debit cap (invoice plus routing fee, in msat and USD) is checked
 * against the wallet's remaining budget before paying. The pairing secret,
 * the preimage, and the invoice never reach a log or an error.
 */
import { createHash } from "node:crypto";

import { loadLightningStack, type LightningStack } from "./_paid-stack.js";
import { NwcError, NwcWallet } from "./nwc.js";

type FetchFn = typeof globalThis.fetch;

export const RUN402_MPP_LIGHTNING_PROFILE = "run402-mpp-lightning-charge-draft00-safety-v1";
const ACCEPT_PAYMENT = `lightning/charge;profile=${RUN402_MPP_LIGHTNING_PROFILE}, tempo/charge;q=0.5`;
/** Routing-fee headroom on top of the invoice, in sats (internal Hub payments cost 0). */
const FEE_HEADROOM_SATS = 10;
/** A single Run402 charge above this is refused before paying (the spec's conservative USD ceiling in sats). */
export const LIGHTNING_MAX_DEBIT_SATS = 250_000;

export interface LightningWalletLike {
  getBudgetSats(): Promise<{ usedSats: number; totalSats: number | null } | null>;
  getBalanceSats(): Promise<number>;
  payInvoice(bolt11: string): Promise<{ preimage: string }>;
  lookupInvoice(paymentHash: string): Promise<{ state: string | null; preimage: string | null } | null>;
}

export interface LightningFetchOptions {
  pairingUri: string;
  /** The x402 buyer to use when the seller offers no Lightning challenge. */
  fallback: () => Promise<FetchFn | null>;
  baseFetch?: FetchFn;
  wallet?: LightningWalletLike;
  stack?: () => Promise<LightningStack>;
  /** Called with the payment hash of each paid challenge (never the preimage). */
  onPaid?: (paymentHash: string) => void;
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

export function createLightningFetch(options: LightningFetchOptions): FetchFn {
  const baseFetch: FetchFn = options.baseFetch ?? ((input, init) => globalThis.fetch(input, init));
  const wallet: LightningWalletLike = options.wallet ?? new NwcWallet(options.pairingUri);
  const loadStack = options.stack ?? loadLightningStack;
  let fallbackFetch: FetchFn | null | undefined;

  const fallback = async (): Promise<FetchFn | null> => {
    if (fallbackFetch === undefined) fallbackFetch = await options.fallback();
    return fallbackFetch;
  };

  return async (input, init) => {
    if (!isLightningChargedRequest(input, init)) {
      // Not a Lightning surface: the x402 buyer (or the plain fetch) owns it.
      const other = (await fallback()) ?? baseFetch;
      return other(input, init);
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

    const allIn = challenge.amountSats + FEE_HEADROOM_SATS;
    if (allIn > LIGHTNING_MAX_DEBIT_SATS) {
      throw new LightningPaymentError("LIGHTNING_DEBIT_ABOVE_CAP", `A Lightning charge of ${challenge.amountSats} sats exceeds the ${LIGHTNING_MAX_DEBIT_SATS}-sat ceiling.`, { amount_sats: challenge.amountSats, cap_sats: LIGHTNING_MAX_DEBIT_SATS, next_action: "pay over x402 (run402 init --switch-rail)" });
    }
    const budget = await wallet.getBudgetSats().catch(() => null);
    if (budget && budget.totalSats !== null && budget.totalSats - budget.usedSats < allIn) {
      throw new LightningPaymentError("LIGHTNING_BUDGET_EXHAUSTED", `The Lightning wallet's remaining budget (${budget.totalSats - budget.usedSats} sats) cannot cover ${allIn} sats.`, { remaining_sats: budget.totalSats - budget.usedSats, required_sats: allIn, next_action: "pay over x402 (run402 init --switch-rail), or ask the platform for a new wallet" });
    }

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
    return baseFetch(input, { ...firstInit, headers: retryHeaders });
  };
}
