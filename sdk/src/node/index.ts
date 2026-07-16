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
 * `deployDir` is a thin wrapper over `r.project(id).apply` — bytes ride through
 * the unified CAS substrate, so only files the gateway doesn't already have
 * are uploaded. Re-deploying an unchanged tree issues no S3 PUTs.
 */

import { readFileSync } from "node:fs";
import {
  DEFAULT_API_BASE,
  getApiBase,
  getApiBaseSource,
  getApiTargetKind,
} from "../../core-dist/config.js";
import { Run402, type Run402Options } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";
import { LocalError } from "../errors.js";
import type { Client, Run402ClientMetadata } from "../kernel.js";
import { NodeCredentialsProvider } from "./credentials.js";
import type { AuthMode, CredentialSurface } from "./credentials.js";
import {
  createLazyPaidFetch,
  type EvmPaymentSignerProvider,
  type LazyPaidFetch,
  type PaymentPayerProvenance,
} from "./paid-fetch.js";
import { NodeSites } from "./sites-node.js";
import { NodeAssets } from "./assets-node.js";
import { NodeArchives } from "./archives-node.js";
import { NodeActions, type NodeActionTargetKind } from "./actions-node.js";

export interface NodeRun402Options {
  /** Override the API base URL. Defaults to `getApiBase()` (env var or production URL). */
  apiBase?: string;
  /** Override the local project-key cache path. Defaults to credentials/project-keys.v1.json. */
  keystorePath?: string;
  /** Override the non-secret profile state path. Defaults to state.json. */
  profileStatePath?: string;
  /** Override the allowance file path. Defaults to the standard location. */
  allowancePath?: string;
  /** Override the credentials provider. Defaults to the local Node keystore + allowance provider. */
  credentials?: CredentialsProvider;
  /**
   * Explicit async x402 signer (for example KMS/HSM backed). The provider
   * exposes only a public address plus signing operations, never a raw key.
   * Mutually exclusive with `allowancePath`. Auth still comes from
   * `credentials`, so the authenticated principal and payer may differ.
   */
  paymentSigner?: EvmPaymentSignerProvider;
  /**
   * Which surface is constructing the client — selects the default credential
   * mode. `"cli"` opts into `auto` (wallet, else operator-approval); `"mcp"` /
   * `"sdk"` stay `wallet`-only so a human's approval never leaks into agent
   * tool calls. Ignored when `credentials` is supplied.
   */
  surface?: CredentialSurface;
  /** Explicit credential mode override (otherwise derived from `surface`). */
  authMode?: AuthMode;
  /**
   * Skip x402 payment wrapping and use `globalThis.fetch` directly. Useful in
   * tests or when the caller pre-wraps fetch with a custom scheme.
   */
  disablePaidFetch?: boolean;
  /** Fully custom fetch implementation. Takes precedence over `disablePaidFetch`. */
  fetch?: typeof globalThis.fetch;
  /** Override or disable the bounded Run402-Client metadata header. */
  clientMetadata?: Run402ClientMetadata | false;
  /** Client package version to report; defaults to the SDK package version. */
  clientVersion?: string;
  /** SDK package version to report; defaults to the SDK package version. */
  sdkVersion?: string;
}

/** Run402 instance with Node-only helpers wired in: `sites.deployDir`
 *  (v1.34 unified-deploy convenience) and `assets.uploadDir` /
 *  `assets.syncDir` / `assets.prepareDir` / `assets.putMany`
 *  (v1.48 unified-apply ergonomics). */
export type NodeRun402 = Omit<Run402, "sites" | "assets" | "archives"> & {
  sites: NodeSites;
  assets: NodeAssets;
  archives: NodeArchives;
  actions: NodeActions;
  up: NodeActions["up"];
  /** Public address/source selected for automatic payment; never includes keys or signed proofs. */
  paymentPayer(): Promise<PaymentPayerProvenance | null>;
};

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
  if (opts.paymentSigner && opts.allowancePath) {
    throw new LocalError(
      "Configure exactly one explicit payment source: paymentSigner or allowancePath",
      "constructing client",
      {
        code: "PAYMENT_SOURCE_CONFLICT",
        details: { fields: ["paymentSigner", "allowancePath"] },
      },
    );
  }
  const apiBase = opts.apiBase ?? getApiBase();
  const credentials = opts.credentials ?? new NodeCredentialsProvider({
    allowancePath: opts.allowancePath,
    keystorePath: opts.keystorePath,
    profileStatePath: opts.profileStatePath,
    surface: opts.surface,
    authMode: opts.authMode,
  });
  let lazyPaidFetch: LazyPaidFetch | undefined;
  if (!opts.fetch && !opts.disablePaidFetch) {
    lazyPaidFetch = createLazyPaidFetch({
      allowancePath: opts.allowancePath,
      credentials: opts.credentials ? credentials : undefined,
      paymentSigner: opts.paymentSigner,
    });
  }
  const runOpts: Run402Options = {
    apiBase,
    credentials,
    fetch:
      opts.fetch ??
      (opts.disablePaidFetch
        ? globalThis.fetch.bind(globalThis)
        : lazyPaidFetch!),
    clientMetadata: nodeClientMetadata(opts),
  };
  const base = new Run402(runOpts);

  // Upgrade `sites` to the Node-aware variant, sharing the kernel `Client`
  // that the isomorphic Sites was constructed with. Access to `client` goes
  // through a cast because it is `private` on `Sites` — runtime still exposes
  // the field; this keeps a single Client per instance (no divergent state).
  const client = (base.sites as unknown as { client: Client }).client;
  (base as unknown as { sites: NodeSites }).sites = new NodeSites(client);
  // v1.48 unified-apply: upgrade `assets` to the Node-aware variant.
  // Same single-Client pattern as the sites upgrade above.
  (base as unknown as { assets: NodeAssets }).assets = new NodeAssets(client);
  (base as unknown as { archives: NodeArchives }).archives = new NodeArchives(client);
  const explicitApiBase = opts.apiBase !== undefined || getApiBaseSource() === "env";
  const actions = new NodeActions(base, {
    targetKind: inferTargetKind(apiBase, explicitApiBase),
  });
  (base as unknown as { actions: NodeActions }).actions = actions;
  (base as unknown as { up: NodeActions["up"] }).up = actions.up.bind(actions);
  (base as unknown as { paymentPayer: NodeRun402["paymentPayer"] }).paymentPayer = async () =>
    lazyPaidFetch?.getPayer() ?? null;

  return base as unknown as NodeRun402;
}

function inferTargetKind(apiBase: string, explicitApiBase: boolean): NodeActionTargetKind {
  const configured = getApiTargetKind();
  if (!explicitApiBase && configured !== "unknown") return configured;
  if (stripSlash(apiBase) === stripSlash(DEFAULT_API_BASE)) return "cloud";
  try {
    return new URL(apiBase).protocol === "http:" ? "core" : "cloud";
  } catch {
    return "unknown";
  }
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

const SDK_PACKAGE_VERSION = readSdkPackageVersion();

function nodeClientMetadata(opts: NodeRun402Options): Run402ClientMetadata | false {
  if (opts.clientMetadata === false) return false;
  const base = opts.clientMetadata && typeof opts.clientMetadata === "object" ? opts.clientMetadata : {};
  const version = opts.clientVersion ?? base.version ?? SDK_PACKAGE_VERSION;
  const sdkVersion = opts.sdkVersion ?? base.sdkVersion ?? SDK_PACKAGE_VERSION;
  return {
    surface: base.surface ?? opts.surface ?? "sdk",
    ...(version ? { version } : {}),
    ...(sdkVersion ? { sdkVersion } : {}),
  };
}

function readSdkPackageVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export { NodeSites } from "./sites-node.js";
export type {
  DeployDirOptions,
  DeployEvent as DeployDirEvent,
} from "./sites-node.js";
export { fileSetFromDir, normalizeRelPath } from "./files.js";
export type { FileSetFromDirOptions } from "./files.js";
// v1.48 unified-apply: Node-only `assets.{uploadDir,syncDir,prepareDir,
// putMany}` ergonomics + `dir(path)` LocalDirRef helper. The
// `dir(path)` call is synchronous (per design D12); the filesystem
// walk happens at apply() submission time.
export { NodeAssets, dir, PruneConfirmationRequired } from "./assets-node.js";
export type {
  AssetManifest,
  AssetManifestEntry,
  AssetManifestTotals,
  DirOptions,
  LocalDirRef,
  PutManyItem,
  UploadDirOptions,
  SyncDirOptions,
  PrepareDirOptions,
} from "./assets-node.js";
export {
  loadDeployManifest,
  loadExecutableDeployConfig,
  normalizeDeployManifest,
} from "./deploy-manifest.js";
export {
  defineConfig,
  emailTrigger,
  file,
  nodeFunction,
  scheduleTrigger,
  sqlFile,
} from "../config.js";
export type {
  Run402ConfigContext,
  Run402DirConfigOptions,
  Run402EmailTriggerOptions,
  Run402ExecutableConfigExport,
  Run402ExecutionMode,
  Run402FileConfigOptions,
  Run402FileConfigSource,
  Run402NodeFunctionConfigOptions,
  Run402ReleaseConfig,
  Run402ReviewedPlanRequirement,
  Run402ScheduleTriggerOptions,
  Run402SqlFileConfigMigration,
  Run402SqlFileConfigOptions,
} from "../config.js";
export type {
  DeployManifestDatabaseSpec,
  DeployManifestFileEntry,
  DeployManifestFileSet,
  DeployManifestFunctionsSpec,
  DeployManifestFunctionSpec,
  DeployManifestInput,
  DeployManifestMigrationSpec,
  DeployManifestSiteSpec,
  LoadDeployManifestOptions,
  NormalizedDeployManifest,
  NormalizeDeployManifestOptions,
} from "./deploy-manifest.js";
export { resolveRun402TargetProfile } from "./target-profile.js";
export type {
  ResolveRun402TargetProfileOptions,
  Run402TargetKind,
  Run402TargetProfile,
  Run402TargetProfileEnvAliases,
  Run402TargetProfileSources,
  Run402TargetRequirement,
} from "./target-profile.js";
export { signCiDelegation } from "./ci.js";
export type { SignCiDelegationOptions } from "./ci.js";
export { signWalletOrgClaim, claimWalletOrg } from "./operator-claim.js";
export type { SignWalletOrgClaimOptions, ClaimWalletOrgOptions } from "./operator-claim.js";
export {
  importArchiveToCore,
  inspectArchive,
  NodeArchives,
  readEnvFile,
  verifyArchive,
} from "./archives-node.js";
export { NodeCredentialsProvider } from "./credentials.js";
export { NodeActions } from "./actions-node.js";
export type { NodeActionTargetKind, NodeActionsOptions } from "./actions-node.js";
export { setupPaidFetch, createLazyPaidFetch, X402BalanceError } from "./paid-fetch.js";
export type {
  EvmPaymentSigner,
  EvmPaymentSignerProvider,
  ConfiguredPaidFetch,
  LazyPaidFetch,
  PaidFetchOptions,
  PaymentPayerProvenance,
  PaymentPayerSource,
  PaymentPublicClient,
  X402BalanceErrorCode,
  X402PaymentNetwork,
} from "./paid-fetch.js";
export {
  listPaymentAttempts,
  readPaymentAttempt,
  PAYMENT_ATTEMPT_HEADER,
} from "./payment-attempts.js";
export type {
  PaymentAttemptJournalState,
  PaymentAttemptRecord,
} from "./payment-attempts.js";
export { Run402Action } from "../actions.js";
export * from "../app-up.js";
export type * from "../index.js";
// Re-export the isomorphic surface so Node consumers don't need two imports.
export {
  Run402,
  Run402Error,
  PaymentRequired,
  ProjectCredentialNotFound,
  ProjectNotFound,
  Unauthorized,
  NotAuthorizedError,
  StepUpRequiredError,
  ApiError,
  NetworkError,
  PaymentAttemptError,
  LocalError,
  Run402DeployError,
  EMPTY_STATIC_MANIFEST_METADATA,
  ROUTE_HTTP_METHODS,
  Ci,
  Deploy,
  CI_SESSION_CREDENTIALS,
  Orgs,
  ScopedOrg,
  Grants,
  PROJECT_CREDENTIAL_ERROR_CODES,
  PROJECT_OPERATION_AUTH_CLASSIFICATIONS,
  files,
  CI_AUDIENCE,
  CI_GITHUB_ACTIONS_ISSUER,
  CI_GITHUB_ACTIONS_PROVIDER,
  DEFAULT_CI_DELEGATION_CHAIN_ID,
  V1_CI_ALLOWED_ACTIONS,
  V1_CI_ALLOWED_EVENTS_DEFAULT,
  assertCiDeployableSpec,
  buildCiDelegationResourceUri,
  buildCiDelegationStatement,
  buildDeployResolveSummary,
  createCiSessionCredentials,
  githubActionsCredentials,
  isRun402Error,
  isPaymentRequired,
  isProjectCredentialError,
  isProjectCredentialExpired,
  isProjectCredentialInvalid,
  isProjectCredentialNotFound,
  isProjectCredentialProjectMismatch,
  isProjectNotFound,
  isUnauthorized,
  isNotAuthorized,
  isStepUpRequired,
  isOperatorApprovalRequired,
  isApiError,
  isNetworkError,
  isPaymentAttemptError,
  isLocalError,
  isDeployError,
  isRetryableRun402Error,
  isCiSessionCredentials,
  projectOperationAuthClassification,
  isDeployResolveRouteHit,
  isDeployResolveStaticHit,
  normalizeCiRouteScopes,
  normalizeCiDelegationValues,
  normalizeDeployResolveRequest,
  normalizeStaticManifestMetadata,
  summarizeDeployResult,
  validateCiNonce,
  validateCiRouteScope,
  validateCiSubjectMatch,
  withRetry,
} from "../index.js";
