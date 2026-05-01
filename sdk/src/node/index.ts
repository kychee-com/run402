/**
 * `@run402/sdk/node` — zero-config Node entry point.
 *
 * Wires the isomorphic SDK kernel with:
 *   - default API base from `RUN402_API_BASE` (via core/config)
 *   - {@link NodeCredentialsProvider} backed by the local keystore + allowance
 *   - an x402-wrapped fetch built lazily on first request
 *   - {@link NodeSites}: the `sites` namespace enriched with `deployDir(dir)`
 *
 * Usage:
 * ```ts
 * import { run402 } from "@run402/sdk/node";
 * const r = run402();
 * const project = await r.projects.provision({ tier: "prototype" });
 * await r.sites.deployDir({ project: project.project_id, dir: "./my-site" });
 * ```
 *
 * `deployDir` is a thin wrapper over `r.deploy.apply` — bytes ride through
 * the unified CAS substrate, so only files the gateway doesn't already have
 * are uploaded. Re-deploying an unchanged tree issues no S3 PUTs.
 */

import { getApiBase } from "../../core-dist/config.js";
import { Run402, type Run402Options } from "../index.js";
import type { Client } from "../kernel.js";
import { NodeCredentialsProvider } from "./credentials.js";
import { createLazyPaidFetch } from "./paid-fetch.js";
import { NodeSites } from "./sites-node.js";

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

/** Run402 instance with the Node-only `sites.deployDir` helper wired in. */
export type NodeRun402 = Omit<Run402, "sites"> & { sites: NodeSites };

/**
 * Construct a Run402 client wired with Node defaults.
 *
 * Behavior matches today's `run402-mcp` / `run402` CLI: reads keystore and
 * allowance from disk, signs SIWX headers, and retries 402 responses via
 * `@x402/fetch` when the allowance wallet has USDC balance.
 *
 * The returned instance's `sites` namespace is a {@link NodeSites}, which
 * exposes the `deployDir({ dir })` helper.
 */
export function run402(opts: NodeRun402Options = {}): NodeRun402 {
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
  const base = new Run402(runOpts);

  // Upgrade `sites` to the Node-aware variant, sharing the kernel `Client`
  // that the isomorphic Sites was constructed with. Access to `client` goes
  // through a cast because it is `private` on `Sites` — runtime still exposes
  // the field; this keeps a single Client per instance (no divergent state).
  const client = (base.sites as unknown as { client: Client }).client;
  (base as unknown as { sites: NodeSites }).sites = new NodeSites(client);

  return base as unknown as NodeRun402;
}

export { NodeSites } from "./sites-node.js";
export type { DeployDirOptions } from "./sites-node.js";
export { fileSetFromDir, normalizeRelPath } from "./files.js";
export type { FileSetFromDirOptions } from "./files.js";
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
  LocalError,
  Run402DeployError,
  Deploy,
  files,
  isRun402Error,
  isPaymentRequired,
  isProjectNotFound,
  isUnauthorized,
  isApiError,
  isNetworkError,
  isLocalError,
  isDeployError,
  isRetryableRun402Error,
  withRetry,
} from "../index.js";
export type {
  Run402Options,
  CredentialsProvider,
  ProjectKeys,
  RequestOptions,
  Client,
  Run402DeployErrorCode,
  Run402DeployErrorFix,
  Run402ErrorKind,
  RetryOptions,
  ApplyOptions,
  CommitResponse,
  CommitStatus,
  ContentRef,
  ContentSource,
  DatabaseSpec,
  DeployDiff,
  DeployEvent,
  DeployOperation,
  DeployResult,
  ExposeManifest,
  FileSet,
  FsFileSource,
  FunctionSpec,
  FunctionsSpec,
  MigrationSpec,
  MissingContent,
  OperationSnapshot,
  OperationStatus,
  PaymentRequiredHint,
  PlanRequest,
  PlanResponse,
  ReleaseSpec,
  RouteSpec,
  SecretsSpec,
  SiteSpec,
  SmokeCheck,
  StartOptions,
  SubdomainsSpec,
} from "../index.js";
