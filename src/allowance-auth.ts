/**
 * Allowance auth helper — re-exports core signing + adds MCP-specific error wrapper.
 */

import { getAllowanceAuthHeaders as _getAllowanceAuthHeaders, type AllowanceAuthHeaders } from "../core/dist/allowance-auth.js";

export type { AllowanceAuthHeaders };

export const getAllowanceAuthHeaders = _getAllowanceAuthHeaders;

/**
 * Get allowance auth headers or return an MCP error result.
 */
export function requireAllowanceAuth(): {
  headers: AllowanceAuthHeaders;
} | {
  error: { content: Array<{ type: "text"; text: string }>; isError: true };
} {
  const headers = getAllowanceAuthHeaders();
  if (!headers) {
    return {
      error: {
        content: [
          {
            type: "text",
            text: "Error: No agent allowance configured. Use `allowance_create` to create an allowance first, then `request_faucet` to fund it.",
          },
        ],
        isError: true,
      },
    };
  }
  return { headers };
}
