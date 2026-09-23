/**
 * SIWX auth helper — re-exports core signing + adds MCP-specific error wrapper.
 */

import { getWalletAuthHeaders as _getWalletAuthHeaders, type SIWxAuthHeaders } from "../core/dist/wallet-auth.js";

import { errorResult, type ToolResult } from "./structured.js";

export type { SIWxAuthHeaders };

export const getWalletAuthHeaders = _getWalletAuthHeaders;

/**
 * Get SIWX auth headers or return an MCP error result.
 */
export function requireWalletAuth(path: string): {
  headers: SIWxAuthHeaders;
} | {
  error: ToolResult;
} {
  const headers = getWalletAuthHeaders(path);
  if (!headers) {
    // Creating a wallet writes a private key, which only the CLI hands to a
    // person; `up` sets one up as part of its missing setup.
    return {
      error: errorResult(
        "Error: No local wallet configured. `up` sets one up with the rest of any missing setup, or run `run402 init` to create and fund one.",
        {
          code: "WALLET_NOT_FOUND",
          message: "No local wallet configured.",
          next_actions: [
            { type: "run_cli_command", command: "run402 init", why: "Create and fund a local wallet, or call `up`, which sets one up with the rest of any missing setup." },
          ],
        },
      ),
    };
  }
  return { headers };
}
