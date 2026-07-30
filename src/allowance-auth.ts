/**
 * Allowance auth helper — re-exports core signing + adds MCP-specific error wrapper.
 */

import { getAllowanceAuthHeaders as _getAllowanceAuthHeaders, type SIWxAuthHeaders } from "../core/dist/allowance-auth.js";
import { isToolAvailable } from "./tool-profiles.js";

export type { SIWxAuthHeaders };

export const getAllowanceAuthHeaders = _getAllowanceAuthHeaders;

/**
 * Get allowance auth headers or return an MCP error result.
 */
export function requireAllowanceAuth(path: string): {
  headers: SIWxAuthHeaders;
} | {
  error: { content: Array<{ type: "text"; text: string }>; isError: true };
} {
  const headers = getAllowanceAuthHeaders(path);
  if (!headers) {
    return {
      error: {
        content: [
          {
            type: "text",
            // `allowance_create` is not registered under the buyer profile, so
            // naming it there sends the caller to a tool they cannot invoke.
            // `init` is the buyer's single-call bootstrap and does both steps.
            text: isToolAvailable("allowance_create")
              ? "Error: No agent allowance configured. Use `allowance_create` to create an allowance first, then `request_faucet` to fund it."
              : "Error: No agent allowance configured. Use `init` to create and fund an agent allowance in one call.",
          },
        ],
        isError: true,
      },
    };
  }
  return { headers };
}
