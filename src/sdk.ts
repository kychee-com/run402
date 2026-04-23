/**
 * MCP-side SDK singleton.
 *
 * All MCP tool handlers obtain their API client via {@link getSdk}. The
 * instance is lazily constructed on first use and cached for the lifetime
 * of the process. Tests that mutate `RUN402_API_BASE` / `RUN402_CONFIG_DIR`
 * between runs must call {@link _resetSdk} in their setup hook to discard
 * the cached apiBase and credentials provider.
 */

import { run402 as createNodeSdk, type Run402 } from "../sdk/dist/node/index.js";

let cached: Run402 | null = null;

export function getSdk(): Run402 {
  if (!cached) cached = createNodeSdk();
  return cached;
}

/** Reset the cached SDK instance. Test-only. */
export function _resetSdk(): void {
  cached = null;
}
