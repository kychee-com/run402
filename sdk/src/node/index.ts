/**
 * `@run402/sdk/node` — zero-config Node entry point.
 *
 * Wires the isomorphic SDK kernel with:
 *   - default API base from `RUN402_API_BASE` (via core/config)
 *   - {@link NodeCredentialsProvider} backed by the local keystore + allowance
 *   - an x402-wrapped fetch built lazily on first request
 *
 * Usage:
 * ```ts
 * import { run402 } from "@run402/sdk/node";
 * const r = run402();
 * const project = await r.projects.provision({ tier: "prototype" });
 * ```
 */

import { getApiBase } from "../../core-dist/config.js";
import { Run402, type Run402Options } from "../index.js";
import { NodeCredentialsProvider } from "./credentials.js";
import { createLazyPaidFetch } from "./paid-fetch.js";

export interface NodeRun402Options {
  /** Override the API base URL. Defaults to `getApiBase()` (env var or production URL). */
  apiBase?: string;
  /** Override the keystore file path. Defaults to the standard location. */
  keystorePath?: string;
  /** Override the allowance file path. Defaults to the standard location. */
  allowancePath?: string;
  /**
   * Skip x402 payment wrapping and use `globalThis.fetch` directly. Useful in
   * tests or when the caller pre-wraps fetch with a custom scheme.
   */
  disablePaidFetch?: boolean;
  /** Fully custom fetch implementation. Takes precedence over `disablePaidFetch`. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Construct a Run402 client wired with Node defaults.
 *
 * Behavior matches today's `run402-mcp` / `run402` CLI: reads keystore and
 * allowance from disk, signs SIWX headers, and retries 402 responses via
 * `@x402/fetch` when the allowance wallet has USDC balance.
 */
export function run402(opts: NodeRun402Options = {}): Run402 {
  const runOpts: Run402Options = {
    apiBase: opts.apiBase ?? getApiBase(),
    credentials: new NodeCredentialsProvider({
      allowancePath: opts.allowancePath,
      keystorePath: opts.keystorePath,
    }),
    fetch:
      opts.fetch ??
      (opts.disablePaidFetch ? globalThis.fetch.bind(globalThis) : createLazyPaidFetch()),
  };
  return new Run402(runOpts);
}

export { NodeCredentialsProvider } from "./credentials.js";
export { setupPaidFetch, createLazyPaidFetch } from "./paid-fetch.js";
// Re-export the isomorphic surface so Node consumers don't need two imports.
export {
  Run402,
  Run402Error,
  PaymentRequired,
  ProjectNotFound,
  Unauthorized,
  ApiError,
  NetworkError,
} from "../index.js";
export type {
  Run402Options,
  CredentialsProvider,
  ProjectKeys,
  RequestOptions,
  Client,
} from "../index.js";
