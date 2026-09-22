/**
 * SIWX auth helper — re-exports core signing + adds MCP-specific error wrapper.
 */

import { getWalletAuthHeaders as _getWalletAuthHeaders, type SIWxAuthHeaders } from "../core/dist/wallet-auth.js";
import { isToolAvailable } from "./tool-profiles.js";

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
            // `wallet_create` is not registered under the buyer profile, so
            // naming it there sends the caller to a tool they cannot invoke.
            // `init` is the buyer's single-call bootstrap and does both steps.
            text: isToolAvailable("wallet_create")
              ? "Error: No local wallet configured. Use `wallet_create` to create one first, then `request_faucet` to fund it."
              : "Error: No local wallet configured. Use `init` to create and fund an agent wallet in one call.",
          },
        ],
        isError: true,
      },
    };
  }
  return { headers };
}
