/**
 * Extract the sender wallet address from an x402 payment header.
 * The header is base64 JSON: { payload: { authorization: { from: "0x..." } } }
 */
export function extractWalletFromPaymentHeader(header: string): string | null {
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString());
    const from = decoded.payload?.authorization?.from;
    return from?.startsWith("0x") ? from.toLowerCase() : null;
  } catch {
    return null;
  }
}
