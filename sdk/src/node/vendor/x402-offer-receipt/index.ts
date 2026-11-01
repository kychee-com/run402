/**
 * The buyer half of the x402 `offer-receipt` extension: reading signed
 * offers from a 402 challenge and a signed receipt from a settlement
 * response, and recovering the EIP-712 signer of each. See VENDORED.md.
 */

export const OFFER_RECEIPT = "offer-receipt";

/** viem's `recoverTypedDataAddress`, passed in so this module loads without viem. */
export type RecoverTypedDataAddress = (args: {
  domain: { name: string; version: string; chainId: number };
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
  signature: `0x${string}`;
}) => Promise<`0x${string}`>;

interface SignedEnvelope {
  format?: unknown;
  payload?: Record<string, unknown>;
  signature?: unknown;
  acceptIndex?: number;
}

const OFFER_TYPES = {
  Offer: [
    { name: "version", type: "uint256" },
    { name: "resourceUrl", type: "string" },
    { name: "scheme", type: "string" },
    { name: "network", type: "string" },
    { name: "asset", type: "string" },
    { name: "payTo", type: "string" },
    { name: "amount", type: "string" },
    { name: "validUntil", type: "uint256" },
  ],
};

const RECEIPT_TYPES = {
  Receipt: [
    { name: "version", type: "uint256" },
    { name: "network", type: "string" },
    { name: "resourceUrl", type: "string" },
    { name: "payer", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "transaction", type: "string" },
  ],
};

const offerDomain = () => ({ name: "x402 offer", version: "1", chainId: 1 });
const receiptDomain = () => ({ name: "x402 receipt", version: "1", chainId: 1 });
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** An EIP-712 `uint256` message field. */
const uint = (value: unknown): bigint => BigInt(value as bigint | number | string);

export function isEIP712SignedOffer(offer: unknown): boolean {
  return (offer as SignedEnvelope | null)?.format === "eip712";
}

export function isEIP712SignedReceipt(receipt: unknown): boolean {
  return (receipt as SignedEnvelope | null)?.format === "eip712";
}

function extractJWSPayload(jws: string): Record<string, unknown> {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWS format");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

function extractOfferPayload(offer: SignedEnvelope): Record<string, unknown> {
  if (offer.format === "jws") return extractJWSPayload(String(offer.signature));
  if (offer.format === "eip712") return offer.payload ?? {};
  throw new Error(`Unknown offer format: ${String(offer.format)}`);
}

export function extractOffersFromPaymentRequired(paymentRequired: unknown): unknown[] {
  const extensions = (paymentRequired as { extensions?: Record<string, { info?: { offers?: unknown[] } }> } | null)?.extensions;
  return extensions?.[OFFER_RECEIPT]?.info?.offers ?? [];
}

export function decodeSignedOffers(offers: unknown[]): unknown[] {
  return offers.map((value) => {
    const offer = value as SignedEnvelope;
    return { ...extractOfferPayload(offer), signedOffer: offer, format: offer.format, acceptIndex: offer.acceptIndex };
  });
}

export function findAcceptsObjectFromSignedOffer(offer: unknown, accepts: unknown[]): unknown | undefined {
  const record = offer as SignedEnvelope & Record<string, unknown>;
  const payload = "signedOffer" in record ? record : extractOfferPayload(record);
  const matches = (candidate: unknown) => {
    const req = candidate as Record<string, unknown>;
    return req.network === payload.network && req.scheme === payload.scheme && req.asset === payload.asset &&
      req.payTo === payload.payTo && req.amount === payload.amount;
  };
  const hint = record.acceptIndex;
  if (hint !== undefined && hint < accepts.length && matches(accepts[hint])) return accepts[hint];
  return accepts.find(matches);
}

export function extractReceiptFromResponse(response: Response): unknown | undefined {
  const header = response.headers.get("PAYMENT-RESPONSE") || response.headers.get("X-PAYMENT-RESPONSE");
  if (!header || !BASE64.test(header)) return undefined;
  try {
    const settlement = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      extensions?: Record<string, { info?: { receipt?: unknown } }>;
    };
    return settlement.extensions?.[OFFER_RECEIPT]?.info?.receipt;
  } catch {
    return undefined;
  }
}

export function offerReceiptVerifiers(recoverTypedDataAddress: RecoverTypedDataAddress) {
  return {
    async verifyOfferSignatureEIP712(value: unknown): Promise<{ signer: `0x${string}`; payload: Record<string, unknown> }> {
      const offer = value as SignedEnvelope;
      if (offer.format !== "eip712") throw new Error(`Expected eip712 format, got ${String(offer.format)}`);
      const payload = offer.payload;
      if (!payload || !("scheme" in payload)) throw new Error("Invalid offer: missing or malformed payload");
      const signer = await recoverTypedDataAddress({
        domain: offerDomain(),
        types: OFFER_TYPES,
        primaryType: "Offer",
        message: {
          version: uint(payload.version),
          resourceUrl: payload.resourceUrl,
          scheme: payload.scheme,
          network: payload.network,
          asset: payload.asset,
          payTo: payload.payTo,
          amount: payload.amount,
          validUntil: uint(payload.validUntil),
        },
        signature: offer.signature as `0x${string}`,
      });
      return { signer, payload };
    },
    async verifyReceiptSignatureEIP712(value: unknown): Promise<{ signer: `0x${string}`; payload: Record<string, unknown> }> {
      const receipt = value as SignedEnvelope;
      if (receipt.format !== "eip712") throw new Error(`Expected eip712 format, got ${String(receipt.format)}`);
      const payload = receipt.payload;
      if (!payload || !("payer" in payload)) throw new Error("Invalid receipt: missing or malformed payload");
      const signer = await recoverTypedDataAddress({
        domain: receiptDomain(),
        types: RECEIPT_TYPES,
        primaryType: "Receipt",
        message: {
          version: uint(payload.version),
          network: payload.network,
          resourceUrl: payload.resourceUrl,
          payer: payload.payer,
          issuedAt: uint(payload.issuedAt),
          transaction: payload.transaction,
        },
        signature: receipt.signature as `0x${string}`,
      });
      return { signer, payload };
    },
  };
}
