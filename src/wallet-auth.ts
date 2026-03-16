/**
 * Wallet auth helper — re-exports core signing + adds MCP-specific error wrapper.
 */

import { getWalletAuthHeaders as _getWalletAuthHeaders, type WalletAuthHeaders } from "../core/dist/wallet-auth.js";

export type { WalletAuthHeaders };

export const getWalletAuthHeaders = _getWalletAuthHeaders;

/**
 * Get wallet auth headers or return an MCP error result.
 */
export function requireWalletAuth(): {
  headers: WalletAuthHeaders;
} | {
  error: { content: Array<{ type: "text"; text: string }>; isError: true };
} {
  const headers = getWalletAuthHeaders();
  if (!headers) {
    return {
      error: {
        content: [
          {
            type: "text",
            text: "Error: No wallet configured. Use `wallet_create` to create a wallet first, then `request_faucet` to fund it.",
          },
        ],
        isError: true,
      },
    };
  }
  return { headers };
}
