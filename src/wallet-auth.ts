/**
 * SIWX auth helper — re-exports core signing + adds MCP-specific error wrapper.
 */

import { getWalletAuthHeaders as _getWalletAuthHeaders, type SIWxAuthHeaders } from "../core/dist/wallet-auth.js";

export type { SIWxAuthHeaders };

export const getWalletAuthHeaders = _getWalletAuthHeaders;

/**
 * Get SIWX auth headers or return an MCP error result.
 */
export function requireWalletAuth(path: string): {
  headers: SIWxAuthHeaders;
} | {
  error: { content: Array<{ type: "text"; text: string }>; isError: true };
} {
  const headers = getWalletAuthHeaders(path);
  if (!headers) {
    return {
      error: {
        content: [
          {
            type: "text",
            // Creating a wallet writes a private key, which only the CLI hands
            // to a person; `up` sets one up as part of its missing setup.
            text: "Error: No local wallet configured. `up` sets one up with the rest of any missing setup, or run `run402 init` to create and fund one.",
          },
        ],
        isError: true,
      },
    };
  }
  return { headers };
}
