export const RUN402_LIGHTNING_SELLER_SOURCE =
  "coinbase_exchange_btc_usd_bid_v1" as const;
export const RUN402_LIGHTNING_BUYER_SOURCE =
  "gemini_btcusd_ask_v2" as const;

const REQUEST_DEADLINE_MS = 2_000;
const COINBASE_MAX_AGE_MS = 15_000;
const MAX_RECEIPT_SKEW_MS = 1_000;
const MAX_DIVERGENCE_BPS = 100;
const SELLER_SPREAD_BPS = 50;
const QUOTE_LIFETIME_MS = 45_000;
const BUYER_RATE_USE_WINDOW_MS = 5_000;

export interface LightningSellerQuote {
  source: typeof RUN402_LIGHTNING_SELLER_SOURCE;
  sourceReference: string;
  sourceObservationInstant: Date;
  rateNumerator: bigint;
  rateDenominator: bigint;
  spreadBps: number;
  quoteInstant: Date;
  quoteExpiryInstant: Date;
}

export interface LightningBuyerValuation {
  sellerRateUsdMicrosPerBtc: bigint;
  buyerRateUsdMicrosPerBtc: bigint;
  conservativeRateUsdMicrosPerBtc: bigint;
  sellerResponseInstant: Date;
  buyerResponseInstant: Date;
  sellerTradeInstant: Date;
  buyerSource: typeof RUN402_LIGHTNING_BUYER_SOURCE;
}

export class LightningValuationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "LightningValuationError";
  }
}

export async function fetchLightningBuyerValuation(input: {
  retainedSellerQuote: LightningSellerQuote;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<LightningBuyerValuation> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  validateRetainedSellerQuote(input.retainedSellerQuote, startedAt);
  const [coinbase, gemini] = await Promise.all([
    fetchJson(
      "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
      fetchImpl,
      now,
    ),
    fetchJson("https://api.gemini.com/v2/ticker/BTCUSD", fetchImpl, now),
  ]);
  const coinbaseBid = decimalUsdToMicros(stringValue(coinbase.body, "bid"));
  const coinbaseAsk = decimalUsdToMicros(stringValue(coinbase.body, "ask"));
  const geminiBid = decimalUsdToMicros(stringValue(gemini.body, "bid"));
  const geminiAsk = decimalUsdToMicros(stringValue(gemini.body, "ask"));
  const sellerTradeInstant = new Date(stringValue(coinbase.body, "time"));
  if (!Number.isFinite(sellerTradeInstant.getTime()) || coinbaseBid <= 0n ||
      coinbaseAsk < coinbaseBid || geminiBid <= 0n || geminiAsk < geminiBid) {
    throw new LightningValuationError("PAYMENT_QUOTE_SOURCE_INVALID");
  }
  if (coinbase.receivedInstant.getTime() - sellerTradeInstant.getTime() < 0 ||
      coinbase.receivedInstant.getTime() - sellerTradeInstant.getTime() > COINBASE_MAX_AGE_MS ||
      Math.abs(coinbase.receivedInstant.getTime() - gemini.receivedInstant.getTime()) > MAX_RECEIPT_SKEW_MS) {
    throw new LightningValuationError("PAYMENT_QUOTE_EXPIRED");
  }
  const retainedRate = exactRate(input.retainedSellerQuote);
  const coinbaseMidpoint = (coinbaseBid + coinbaseAsk) / 2n;
  const geminiMidpoint = (geminiBid + geminiAsk) / 2n;
  if (absoluteBps(coinbaseMidpoint, geminiMidpoint) > MAX_DIVERGENCE_BPS ||
      absoluteBps(coinbaseBid, geminiAsk) > MAX_DIVERGENCE_BPS ||
      absoluteBps(retainedRate, coinbaseBid) > MAX_DIVERGENCE_BPS) {
    throw new LightningValuationError("PAYMENT_QUOTE_DIVERGED");
  }
  const authorizedAt = now();
  if (authorizedAt.getTime() - coinbase.receivedInstant.getTime() > BUYER_RATE_USE_WINDOW_MS ||
      authorizedAt.getTime() - gemini.receivedInstant.getTime() > BUYER_RATE_USE_WINDOW_MS) {
    throw new LightningValuationError("PAYMENT_QUOTE_EXPIRED");
  }
  return {
    sellerRateUsdMicrosPerBtc: retainedRate,
    buyerRateUsdMicrosPerBtc: geminiAsk,
    conservativeRateUsdMicrosPerBtc: retainedRate > geminiAsk ? retainedRate : geminiAsk,
    sellerResponseInstant: coinbase.receivedInstant,
    buyerResponseInstant: gemini.receivedInstant,
    sellerTradeInstant,
    buyerSource: RUN402_LIGHTNING_BUYER_SOURCE,
  };
}

function validateRetainedSellerQuote(quote: LightningSellerQuote, now: Date): void {
  const observedMillis = quote.sourceObservationInstant.getTime();
  const quotedMillis = quote.quoteInstant.getTime();
  const expiryMillis = quote.quoteExpiryInstant.getTime();
  if (quote.source !== RUN402_LIGHTNING_SELLER_SOURCE || !quote.sourceReference ||
      quote.spreadBps !== SELLER_SPREAD_BPS || quote.rateNumerator <= 0n ||
      quote.rateDenominator <= 0n || !Number.isFinite(observedMillis) ||
      !Number.isFinite(quotedMillis) || !Number.isFinite(expiryMillis) ||
      observedMillis > quotedMillis || quotedMillis - observedMillis > COINBASE_MAX_AGE_MS ||
      expiryMillis - quotedMillis !== QUOTE_LIFETIME_MS || quotedMillis > now.getTime() ||
      expiryMillis <= now.getTime()) {
    throw new LightningValuationError("PAYMENT_QUOTE_EXPIRED");
  }
}

export function authorizeLightningDebit(input: {
  invoiceAmountMsat: number;
  authorizedMaxFeeMsat: number;
  maxNativeAmountMsat: number;
  canonicalAmountUsdMicros: number;
  maxUsdMicros: number;
  conservativeRateUsdMicrosPerBtc: bigint;
}): {
  authorizedTotalMsat: number;
  authorizedTotalUsdMicros: number;
} {
  for (const value of [
    input.invoiceAmountMsat,
    input.authorizedMaxFeeMsat,
    input.maxNativeAmountMsat,
    input.canonicalAmountUsdMicros,
    input.maxUsdMicros,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new LightningValuationError("PAYMENT_CAP_ARITHMETIC_INVALID");
    }
  }
  if (input.conservativeRateUsdMicrosPerBtc <= 0n) {
    throw new LightningValuationError("PAYMENT_CAP_ARITHMETIC_INVALID");
  }
  const authorizedTotalMsat = input.invoiceAmountMsat + input.authorizedMaxFeeMsat;
  if (!Number.isSafeInteger(authorizedTotalMsat)) {
    throw new LightningValuationError("PAYMENT_CAP_ARITHMETIC_INVALID");
  }
  if (authorizedTotalMsat > input.maxNativeAmountMsat) {
    throw new LightningValuationError("PAYMENT_NATIVE_AMOUNT_EXCEEDS_MAX");
  }
  const authorizedUsd = ceilDiv(
    BigInt(authorizedTotalMsat) * input.conservativeRateUsdMicrosPerBtc,
    100_000_000_000n,
  );
  const authorizedTotalUsdMicrosBig = authorizedUsd > BigInt(input.canonicalAmountUsdMicros)
    ? authorizedUsd : BigInt(input.canonicalAmountUsdMicros);
  if (authorizedTotalUsdMicrosBig > BigInt(input.maxUsdMicros)) {
    throw new LightningValuationError("PAYMENT_USD_AMOUNT_EXCEEDS_MAX");
  }
  if (authorizedTotalUsdMicrosBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LightningValuationError("PAYMENT_CAP_ARITHMETIC_INVALID");
  }
  return {
    authorizedTotalMsat,
    authorizedTotalUsdMicros: Number(authorizedTotalUsdMicrosBig),
  };
}

function exactRate(quote: LightningSellerQuote): bigint {
  if (quote.source !== RUN402_LIGHTNING_SELLER_SOURCE || quote.rateNumerator <= 0n ||
      quote.rateDenominator <= 0n || quote.rateNumerator % quote.rateDenominator !== 0n) {
    throw new LightningValuationError("PAYMENT_QUOTE_SOURCE_INVALID");
  }
  return quote.rateNumerator / quote.rateDenominator;
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  now: () => Date,
): Promise<{ body: Record<string, unknown>; receivedInstant: Date }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "run402-sdk" },
      redirect: "error",
      signal: controller.signal,
    });
    const receivedInstant = now();
    if (!response.ok) throw new LightningValuationError("PAYMENT_QUOTE_SOURCE_UNAVAILABLE");
    const body = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new LightningValuationError("PAYMENT_QUOTE_SOURCE_INVALID");
    }
    return { body: body as Record<string, unknown>, receivedInstant };
  } catch (error) {
    if (error instanceof LightningValuationError) throw error;
    throw new LightningValuationError("PAYMENT_QUOTE_SOURCE_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
}

function stringValue(value: Record<string, unknown>, field: string): string {
  const item = value[field];
  if (typeof item !== "string") throw new LightningValuationError("PAYMENT_QUOTE_SOURCE_INVALID");
  return item;
}

function decimalUsdToMicros(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(value)) {
    throw new LightningValuationError("PAYMENT_QUOTE_SOURCE_INVALID");
  }
  const [whole, fractional = ""] = value.split(".");
  const micros = BigInt(whole!) * 1_000_000n +
    BigInt(`${fractional.slice(0, 6)}${"0".repeat(Math.max(0, 6 - fractional.length))}` || "0");
  const beyondMicros = fractional.slice(6);
  return micros + (/[1-9]/.test(beyondMicros) ? 1n : 0n);
}

function absoluteBps(left: bigint, right: bigint): number {
  if (left <= 0n || right <= 0n) return Number.POSITIVE_INFINITY;
  const difference = left >= right ? left - right : right - left;
  const denominator = left < right ? left : right;
  return Number(difference * 1_000_000n / denominator) / 100;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new LightningValuationError("PAYMENT_CAP_ARITHMETIC_INVALID");
  }
  return (numerator + denominator - 1n) / denominator;
}
