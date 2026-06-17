/**
 * MCP-side SDK singleton.
 *
 * All MCP tool handlers obtain their API client via {@link getSdk}. The
 * instance is lazily constructed on first use and cached for the lifetime
 * of the process. Tests that mutate `RUN402_API_BASE` / `RUN402_CONFIG_DIR`
 * between runs must call {@link _resetSdk} in their setup hook to discard
 * the cached apiBase and credentials provider.
 */

import { run402 as createNodeSdk, type NodeRun402 } from "../sdk/dist/node/index.js";

let cached: NodeRun402 | null = null;

export function getSdk(): NodeRun402 {
  // surface: "mcp" keeps credential resolution wallet-only — an agent tool call
  // never spends the human's cached operator approval (no ambient authority).
  if (!cached) cached = createNodeSdk({ surface: "mcp" });
  return cached;
}

/** Reset the cached SDK instance. Test-only. */
export function _resetSdk(): void {
  cached = null;
}
