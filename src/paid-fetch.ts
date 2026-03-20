/**
 * Paid fetch for MCP server — reads the local allowance, branches on rail
 * (x402 vs mpp), returns a wrapped fetch that intercepts 402 responses,
 * signs payment, and retries automatically.
 *
 * Returns null when no allowance is configured or payment libraries are
 * unavailable (graceful degradation).
 */

import { readAllowance } from "./allowance.js";
import { apiRequest } from "./client.js";
import type { ApiResponse, ApiRequestOptions } from "./client.js";

type FetchFn = typeof globalThis.fetch;

/**
 * Create a payment-wrapping fetch function from the local allowance.
 * Returns null if no allowance exists or payment libraries fail to load.
 */
export async function setupPaidFetch(): Promise<FetchFn | null> {
  const allowance = readAllowance();
  if (!allowance) return null;

  try {
    if (allowance.rail === "mpp") {
      // mppx is an optional peer — use variable to skip TS module resolution
      const mppxMod = "mppx/client";
      const { Mppx, tempo }: any = await import(/* webpackIgnore: true */ mppxMod);
      const { privateKeyToAccount } = await import("viem/accounts");
      const account = privateKeyToAccount(allowance.privateKey as `0x${string}`);
      const mppx = Mppx.create({
        polyfill: false,
        methods: [tempo({ account })],
      });
      return mppx.fetch as FetchFn;
    }

    // Default: x402
    const { privateKeyToAccount } = await import("viem/accounts");
    const { createPublicClient, http } = await import("viem");
    const { base, baseSepolia } = await import("viem/chains");
    const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
    const { ExactEvmScheme } = await import("@x402/evm/exact/client");
    const { toClientEvmSigner } = await import("@x402/evm");

    const account = privateKeyToAccount(allowance.privateKey as `0x${string}`);
    const mainnetClient = createPublicClient({ chain: base, transport: http() });
    const sepoliaClient = createPublicClient({ chain: baseSepolia, transport: http() });

    const client = new x402Client();
    client.register("eip155:8453", new ExactEvmScheme(toClientEvmSigner(account, mainnetClient)));
    client.register("eip155:84532", new ExactEvmScheme(toClientEvmSigner(account, sepoliaClient)));

    return wrapFetchWithPayment(fetch, client) as FetchFn;
  } catch {
    // Payment libraries not available — degrade gracefully
    return null;
  }
}

/** Cached paid fetch — initialized lazily on first call */
let cachedPaidFetch: FetchFn | null | undefined;

/**
 * Like apiRequest, but uses the paid fetch wrapper when available.
 * Falls back to bare apiRequest when no allowance is configured.
 */
export async function paidApiRequest(
  path: string,
  opts: ApiRequestOptions = {},
): Promise<ApiResponse> {
  if (cachedPaidFetch === undefined) {
    cachedPaidFetch = await setupPaidFetch();
  }

  if (!cachedPaidFetch) {
    return apiRequest(path, opts);
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = cachedPaidFetch;
  try {
    return await apiRequest(path, opts);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** Reset cached state — exposed for testing only */
export function _resetPaidFetchCache(): void {
  cachedPaidFetch = undefined;
}
