/**
 * MCP-side SDK singleton.
 *
 * All MCP tool handlers obtain their API client via {@link getSdk}. The
 * instance is lazily constructed on first use and cached while the relevant
 * local environment is unchanged. If a test harness or long-running agent host
 * changes config/profile/API env vars, the next call rebuilds the client
 * instead of silently reusing stale paths.
 */

import { run402 as createNodeSdk, type NodeRun402 } from "../sdk/dist/node/index.js";
import { getApiBase } from "./config.js";

let cached: NodeRun402 | null = null;
let cachedKey: string | null = null;

export function getSdk(): NodeRun402 {
  // surface: "mcp" keeps credential resolution wallet-only — an agent tool call
  // never spends the human's cached operator approval (no ambient authority).
  const key = sdkCacheKey();
  if (!cached || cachedKey !== key) {
    cached = createNodeSdk({ surface: "mcp" });
    cachedKey = key;
  }
  return cached;
}

/** Reset the cached SDK instance. Test-only. */
export function _resetSdk(): void {
  cached = null;
  cachedKey = null;
}

function sdkCacheKey(): string {
  return JSON.stringify({
    apiBase: getApiBase(),
    configDir: process.env.RUN402_CONFIG_DIR ?? null,
    allowancePath: process.env.RUN402_ALLOWANCE_PATH ?? null,
    wallet: process.env.RUN402_WALLET ?? null,
    profile: process.env.RUN402_PROFILE ?? null,
  });
}
