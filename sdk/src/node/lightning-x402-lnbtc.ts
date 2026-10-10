/**
 * The Lightning rail's x402 buyer: pays the x402 Foundation's `exact` scheme on
 * Bitcoin Lightning (`lnbtc`) from the agent's own Lightning wallet.
 *
 * The seller's 402 carries an `accepts[]` entry on an `lnbtc:` network whose
 * `extra.invoice` is a BOLT11 invoice committing (by description hash) to the
 * exact request. The vendored client scheme recomputes that request hash from
 * the request this buyer is about to send, refuses to pay anything bound to
 * another request or signed by another key, pays, and checks the preimage.
 * The paid retry is the same request plus `PAYMENT-SIGNATURE`.
 *
 * Run402 offers it on `POST /generate-image/v1` (spec `x402-lightning-exact`);
 * the Lightning fetch prefers it there over MPP Lightning. The preimage and the
 * pairing secret never reach a log or an error.
 */
import { decodeInvoice } from "./vendor/x402-lnbtc/bolt11.js";
import { httpRequestBinding } from "./vendor/x402-lnbtc/binding.js";
import { LnbtcError } from "./vendor/x402-lnbtc/constants.js";
import { ExactLnbtcScheme } from "./vendor/x402-lnbtc/exact/client/scheme.js";
import type { LightningPayer } from "./vendor/x402-lnbtc/types.js";
import { NwcError } from "./nwc.js";

type FetchFn = typeof globalThis.fetch;

/** Run402 surfaces that offer x402 `exact` on `lnbtc`. */
const X402_LNBTC_PATHS = [/^\/generate-image\/v1$/];

/** The fetch default for a string body without an explicit content type. */
const STRING_BODY_CONTENT_TYPE = "text/plain;charset=UTF-8";

export interface X402LnbtcRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface X402LnbtcOffer {
  paymentRequired: {
    x402Version: number;
    resource?: { url?: string; description?: string; mimeType?: string };
    accepts: X402LnbtcRequirements[];
  };
  requirements: X402LnbtcRequirements;
}

/** The thrown error type, shared with the MPP Lightning buyer. */
export interface X402LnbtcErrorFactory {
  (code: string, message: string, details?: Record<string, unknown>): Error;
}

export interface X402LnbtcWallet {
  payInvoice(bolt11: string): Promise<{ preimage: string }>;
  lookupInvoice(paymentHash: string): Promise<{ state: string | null; preimage: string | null } | null>;
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

/** A POST to a Run402 surface that offers x402 on Lightning. */
export function isX402LightningCandidate(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  if (method !== "POST") return false;
  try {
    return X402_LNBTC_PATHS.some((pattern) => pattern.test(new URL(requestUrl(input)).pathname));
  } catch {
    return false;
  }
}

/** The x402 v2 challenge's `exact` entry on an `lnbtc:` network with an invoice, or null. */
export function readX402LightningOffer(response: Response): X402LnbtcOffer | null {
  if (response.status !== 402) return null;
  const header = response.headers.get("payment-required");
  if (!header) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
  const paymentRequired = decoded as X402LnbtcOffer["paymentRequired"] | null;
  if (!paymentRequired || paymentRequired.x402Version !== 2 || !Array.isArray(paymentRequired.accepts)) return null;
  const requirements = paymentRequired.accepts.find((entry) =>
    entry?.scheme === "exact" &&
    typeof entry.network === "string" && entry.network.startsWith("lnbtc:") &&
    typeof entry.extra?.invoice === "string" && entry.extra.invoice.length > 0,
  );
  return requirements ? { paymentRequired, requirements } : null;
}

/** The body bytes exactly as fetch will send them, or null when they cannot be known up front. */
function bodyBytes(body: RequestInit["body"]): Uint8Array | null {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return null;
}

/**
 * The request headers made explicit: a string body without a content type is
 * sent by fetch as `text/plain;charset=UTF-8`, and the request hash must bind
 * the value actually sent, so it is set here rather than left to fetch.
 */
export function explicitRequestHeaders(init: RequestInit | undefined): Headers {
  const headers = new Headers(init?.headers ?? {});
  if (typeof init?.body === "string" && !headers.has("content-type")) {
    headers.set("content-type", STRING_BODY_CONTENT_TYPE);
  }
  return headers;
}

export interface PayX402LightningOptions {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
  offer: X402LnbtcOffer;
  wallet: X402LnbtcWallet;
  baseFetch: FetchFn;
  fail: X402LnbtcErrorFactory;
  /** Checks the all-in cost (sats) against the rail's ceiling and the wallet's budget; throws to refuse. */
  checkCaps: (amountSats: number) => Promise<void>;
  onPaid?: (paymentHash: string) => void;
  /** Unix seconds; the invoice checks' clock. Tests pin it; production uses the system clock. */
  clock?: () => number;
}

/** Pay the offer and send the paid retry. */
export async function payX402Lightning(options: PayX402LightningOptions): Promise<Response> {
  const { input, init, offer, wallet, fail } = options;
  const url = requestUrl(input);
  const method = (init?.method ?? "POST").toUpperCase();
  const bytes = bodyBytes(init?.body);
  if (!bytes) {
    throw fail("LIGHTNING_BODY_NOT_REPLAYABLE", "An x402 Lightning payment binds the exact body bytes; a streamed body cannot be paid for.");
  }
  const headers = explicitRequestHeaders(init);
  const params = offer.requirements.extra.requestBindingParams as { headers?: unknown } | undefined;
  const boundHeaders = Array.isArray(params?.headers) ? params.headers.filter((name): name is string => typeof name === "string") : [];

  const amountMsat = BigInt(offer.requirements.amount);
  await options.checkCaps(Number((amountMsat + 999n) / 1000n));

  const payer: LightningPayer = {
    payInvoice: async (invoice) => {
      const decoded = decodeInvoice(invoice);
      let preimage: string;
      try {
        preimage = (await wallet.payInvoice(invoice)).preimage;
      } catch (error) {
        // Unknown outcome: resolve by hash before ever paying again.
        if (error instanceof NwcError && (error.code === "TIMEOUT" || error.code === "RELAY_CLOSED" || error.code === "RELAY_UNREACHABLE")) {
          const looked = await wallet.lookupInvoice(decoded.paymentHash).catch(() => null);
          if (!looked?.preimage) {
            throw fail("LIGHTNING_PAYMENT_OUTCOME_UNKNOWN", "The Lightning payment's outcome is unknown; check the wallet before paying again.", { payment_hash: decoded.paymentHash });
          }
          preimage = looked.preimage;
        } else if (error instanceof NwcError) {
          throw fail(`LIGHTNING_${error.code}`, `The Lightning wallet refused the payment (${error.code}).`, { payment_hash: decoded.paymentHash, next_action: "pay over x402 (run402 init --switch-rail)" });
        } else {
          throw error;
        }
      }
      return { invoice, paymentHash: decoded.paymentHash, amountMsat: decoded.amountMsat, status: "paid", preimage };
    },
  };

  const scheme = new ExactLnbtcScheme({
    payer,
    ...(options.clock ? { clock: options.clock } : {}),
    requestBinding: () => httpRequestBinding({
      method,
      url,
      body: bytes,
      boundHeaders,
      getHeader: (name) => (headers.has(name) ? [headers.get(name)!] : undefined),
    }),
  });

  let payload: { preimage: string };
  try {
    const abort = await scheme.schemeHooks.onBeforePaymentCreation?.({
      paymentRequired: offer.paymentRequired as never,
      selectedRequirements: offer.requirements as never,
    });
    if (abort && "abort" in abort && abort.abort) {
      throw new LnbtcError(abort.reason as never);
    }
    const result = await scheme.createPaymentPayload(2, offer.requirements as never);
    payload = result.payload as { preimage: string };
  } catch (error) {
    if (error instanceof LnbtcError) {
      const mismatch = error.reason === "invalid_exact_lnbtc_request_mismatch" ||
        error.reason === "invalid_exact_lnbtc_invoice_request_mismatch";
      throw fail(
        mismatch ? "LIGHTNING_REQUEST_BINDING_MISMATCH" : "LIGHTNING_X402_INVOICE_REFUSED",
        mismatch
          ? "The seller's Lightning invoice is bound to a different request than the one being sent; nothing was paid."
          : `The seller's x402 Lightning offer failed validation (${error.reason}); nothing was paid.`,
        { reason: error.reason },
      );
    }
    throw error;
  }

  const paymentHash = decodeInvoice(String(offer.requirements.extra.invoice)).paymentHash;
  options.onPaid?.(paymentHash);
  const signature = Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: offer.paymentRequired.resource,
    accepted: offer.requirements,
    payload,
  })).toString("base64");
  headers.set("payment-signature", signature);
  return options.baseFetch(input, { ...init, headers });
}
