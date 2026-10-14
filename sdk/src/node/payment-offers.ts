/**
 * Every payment a 402 offers, whichever protocol states it: x402 entries from
 * `PAYMENT-REQUIRED`, MPP challenges from `WWW-Authenticate: Payment`. The
 * wrong-rail error lists these and names the rail switch that would pay the
 * first one (spec `tenant-x402-payment-client-surface`).
 *
 * Parsed without the paid stack: an x402-only install has no `mppx`, and the
 * error still has to say what the seller wanted.
 */

export type PaymentRail = "x402" | "mpp" | "lightning";

export interface PaymentOffer {
  protocol: "x402" | "mpp";
  /** x402 scheme (`exact`), or the MPP method (`tempo`, `lightning`). */
  method: string;
  /** MPP intent (`charge`); absent for x402. */
  intent?: string;
  /** CAIP-2 network id, when the offer names one. */
  network: string | null;
}

const LNBTC_PREFIX = "lnbtc:";

export function paymentOffers(response: Response): PaymentOffer[] {
  return [...x402Offers(response), ...mppOffers(response)];
}

export function x402Offers(response: Response): PaymentOffer[] {
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) return [];
  try {
    // base64url decoding accepts both alphabets, so it reads either seller encoding.
    const decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { accepts?: unknown };
    if (!Array.isArray(decoded.accepts)) return [];
    return decoded.accepts.flatMap((accept: unknown) => {
      const entry = accept as { scheme?: unknown; network?: unknown };
      return typeof entry?.scheme === "string"
        ? [{ protocol: "x402" as const, method: entry.scheme, network: typeof entry.network === "string" ? entry.network : null }]
        : [];
    });
  } catch {
    return [];
  }
}

export interface MppChallengeParams {
  id?: string;
  method: string;
  intent: string;
  request: Record<string, unknown> | null;
}

/** The `Payment` challenges in `WWW-Authenticate`, with their decoded `request`. */
export function mppChallenges(response: Response): MppChallengeParams[] {
  const header = response.headers.get("WWW-Authenticate");
  if (!header) return [];
  return splitPaymentChallenges(header).flatMap((params) => {
    if (!params.method || !params.intent) return [];
    return [{
      ...(params.id ? { id: params.id } : {}),
      method: params.method,
      intent: params.intent,
      request: decodeRequest(params.request),
    }];
  });
}

export function mppOffers(response: Response): PaymentOffer[] {
  return mppChallenges(response).map((challenge) => ({
    protocol: "mpp" as const,
    method: challenge.method,
    intent: challenge.intent,
    network: mppNetwork(challenge),
  }));
}

/** `eip155:<chainId>` for a Tempo charge; the request's own network otherwise. */
function mppNetwork(challenge: MppChallengeParams): string | null {
  const details = challenge.request?.methodDetails as { chainId?: unknown; network?: unknown } | undefined;
  if (challenge.method === "tempo" && (typeof details?.chainId === "number" || typeof details?.chainId === "string")) {
    return `eip155:${String(details.chainId)}`;
  }
  return typeof details?.network === "string" ? details.network : null;
}

/** The rail that pays an offer: x402 EVM entries, MPP Tempo, and Lightning (either protocol). */
export function railForOffer(offer: PaymentOffer): PaymentRail | null {
  if (offer.method === "lightning" || offer.network?.startsWith(LNBTC_PREFIX)) return "lightning";
  if (offer.protocol === "mpp") return offer.method === "tempo" ? "mpp" : null;
  return offer.method === "exact" ? "x402" : null;
}

/** The first offer's rail, when it is not the configured one. */
export function switchRailFor(offers: readonly PaymentOffer[], configured: PaymentRail | undefined): PaymentRail | null {
  for (const offer of offers) {
    const rail = railForOffer(offer);
    if (rail && rail !== configured) return rail;
  }
  return null;
}

/**
 * RFC 9110 auth-params for every `Payment` scheme in the header. A header may
 * carry several challenges, comma-joined; a new challenge starts where a
 * scheme token is followed by a space instead of `=`.
 */
function splitPaymentChallenges(header: string): Array<Record<string, string>> {
  const challenges: Array<{ scheme: string; params: Record<string, string> }> = [];
  let index = 0;
  while (index < header.length) {
    index = skip(header, index, " \t,");
    const token = readToken(header, index);
    if (!token) break;
    index += token.length;
    if (header[index] !== "=") {
      challenges.push({ scheme: token.toLowerCase(), params: {} });
      continue;
    }
    const current = challenges[challenges.length - 1];
    const parsed = readParamValue(header, index + 1);
    index = parsed.next;
    if (current) current.params[token.toLowerCase()] = parsed.value;
  }
  return challenges.filter((challenge) => challenge.scheme === "payment").map((challenge) => challenge.params);
}

function skip(value: string, index: number, chars: string): number {
  while (index < value.length && chars.includes(value[index]!)) index += 1;
  return index;
}

function readToken(value: string, index: number): string {
  const match = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+/.exec(value.slice(index));
  return match ? match[0] : "";
}

function readParamValue(value: string, index: number): { value: string; next: number } {
  index = skip(value, index, " \t");
  if (value[index] !== "\"") {
    const token = /^[^,\s]*/.exec(value.slice(index))![0];
    return { value: token, next: index + token.length };
  }
  let out = "";
  let cursor = index + 1;
  while (cursor < value.length && value[cursor] !== "\"") {
    if (value[cursor] === "\\" && cursor + 1 < value.length) cursor += 1;
    out += value[cursor];
    cursor += 1;
  }
  return { value: out, next: cursor + 1 };
}

function decodeRequest(encoded: string | undefined): Record<string, unknown> | null {
  if (!encoded) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
