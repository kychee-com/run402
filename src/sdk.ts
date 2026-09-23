/**
 * MCP-side SDK clients.
 *
 * The fixed tools obtain their client via {@link getSdk}; `run` replays its
 * snippet's chains against {@link getSandboxSdk}. Each instance is lazily
 * constructed on first use and cached while the relevant
 * local environment is unchanged. If a test harness or long-running agent host
 * changes config/profile/API env vars, the next call rebuilds the client
 * instead of silently reusing stale paths.
 */

import { run402 as createNodeSdk, type NodeRun402 } from "../sdk/dist/node/index.js";
import { getApiBase } from "./config.js";

let cached: NodeRun402 | null = null;
let cachedKey: string | null = null;
let cachedSandbox: NodeRun402 | null = null;
let cachedSandboxKey: string | null = null;

export function getSdk(): NodeRun402 {
  // surface: "mcp" keeps credential resolution wallet-only — an agent tool call
  // never spends a person's cached sign-in session or write approval (no ambient authority).
  const key = sdkCacheKey();
  if (!cached || cachedKey !== key) {
    cached = createNodeSdk({ surface: "mcp" });
    cachedKey = key;
  }
  return cached;
}

/**
 * The client a `run` snippet's chains replay against. `surface: "sandbox"`
 * resolves credentials wallet-only like `"mcp"`, tags requests with client
 * metadata surface `sandbox`, and sets `capabilities.returnSecrets: false`, so
 * every SDK method that would return or consume a one-time secret refuses with
 * `SECRET_REQUIRES_CLI` before any request.
 */
export function getSandboxSdk(): NodeRun402 {
  const key = sdkCacheKey();
  if (!cachedSandbox || cachedSandboxKey !== key) {
    cachedSandbox = createNodeSdk({ surface: "sandbox" });
    cachedSandboxKey = key;
  }
  return cachedSandbox;
}

/** Reset the cached SDK instances. Test-only. */
export function _resetSdk(): void {
  cached = null;
  cachedKey = null;
  cachedSandbox = null;
  cachedSandboxKey = null;
}

function sdkCacheKey(): string {
  return JSON.stringify({
    apiBase: getApiBase(),
    configDir: process.env.RUN402_CONFIG_DIR ?? null,
    walletPath: process.env.RUN402_WALLET_PATH ?? null,
    wallet: process.env.RUN402_WALLET ?? null,
    profile: process.env.RUN402_PROFILE ?? null,
  });
}
