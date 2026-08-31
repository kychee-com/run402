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
import { Run402, type PayExecutor, type Run402Options } from "../index.js";
import { installNodeGitvaultAeadBackend, installNodeGitvaultHashBackend } from "./gitvault-native-crypto.js";
import { sdkFetch } from "./http-dispatcher.js";

// gitvault-native-bulk-crypto (design D1): the bulk frame AEAD is sync and
// isomorphic, so Node's faster OpenSSL implementation of the SAME construction
// can only be INSTALLED at the entry point, never sniffed from the core. A
// build whose OpenSSL lacks the cipher keeps the `@noble/ciphers` default —
// correct, just slower — so this is deliberately not asserted.
installNodeGitvaultAeadBackend();
// gitvault-native-hash: same doctrine, second slot — the protocol SHA-256
// moves to `node:crypto` after a live probe; any failure keeps `@noble`.
installNodeGitvaultHashBackend();
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
   * A delegate bearer minted by a project owner (`run402 delegates create`).
   * When set — here or via `RUN402_DELEGATE_TOKEN` — it becomes the sole
   * credential class, so a process with no wallet and no cached project keys
   * can still deploy. See `../delegate-credentials.ts`.
   */
  delegateToken?: string;
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
  /** Override the arbitrary-URL x402 buyer used by `pay.fetch`. */
  payExecutor?: PayExecutor;
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
    delegateToken: opts.delegateToken,
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
        ? // The owned dispatcher (gitvault-owned-dispatcher): single
          // multiplexed API connection + persisted TLS resumption; defers to
          // an overridden globalThis.fetch so test seams keep working.
          sdkFetch
        : lazyPaidFetch!),
    payExecutor: opts.payExecutor ?? lazyPaidFetch?.pay,
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
  DeployManifestVerifyHttpCheck,
  DeployManifestVerifySpec,
  LoadDeployManifestOptions,
  NormalizedDeployManifest,
  NormalizedDeployManifestVerify,
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
// gitvault (r402s/v0) — Node-only: the principal keystore (§5.1) and the
// six-stage creation journal (§5.2). The isomorphic crypto core is re-exported
// at the bottom of this file so Node consumers need a single import.
export {
  GitvaultKeystore,
  getGitvaultKeystoreRoot,
  readFileNoFollow,
  writeFileAtomic0600,
} from "./gitvault-keystore.js";
export type {
  GitvaultAuditEntry,
  GitvaultAuditEvent,
  GitvaultHeadPin,
  GitvaultIdentityFile,
  GitvaultKeystoreOptions,
  GitvaultKeystoreState,
  GitvaultLockOptions,
  GitvaultPermissionFinding,
  GitvaultRepoFile,
} from "./gitvault-keystore.js";
export {
  GITVAULT_CREATION_STAGES,
  GitvaultCreation,
  createGitvault,
  findResumableGitvaultJournal,
  findResumablePushToCreateJournal,
  gitvaultDoctorRecoveryText,
  gitvaultJournalPath,
  listIncompleteGitvaultJournals,
  readGitvaultJournal,
} from "./gitvault-creation-journal.js";
export type {
  GitvaultAdmitGenesisRequest,
  GitvaultAdmitGenesisResult,
  GitvaultAllocateRequest,
  GitvaultCreationJournal,
  GitvaultCreationOptions,
  GitvaultCreationResult,
  GitvaultCreationStage,
  GitvaultCreationTransport,
  GitvaultDoctorRecoveryText,
  GitvaultJournaledObject,
  GitvaultObjectReceipt,
  GitvaultPushToCreateAddress,
  GitvaultPutObjectRequest,
} from "./gitvault-creation-journal.js";
export {
  GITVAULT_DEPLOY_REF,
  GITVAULT_MAX_GIT_OBJECT_BYTES,
  GITVAULT_MIN_GIT_VERSION,
  HARDENED_GIT_ARGV_PREFIX,
  captureSnapshot,
  capturedSetDigest,
  capturedSetUnchanged,
  deriveCapturedSet,
  detectActiveFilters,
  diffCapturedSets,
  discoverGlobalExcludes,
  findOversizeObjects,
  gitvaultCommitLine,
  hardenedGit,
  hardenedGitEnv,
  hasObject,
  inspectRepository,
  isAncestor,
  materializeSnapshot,
  parseGitConfigAsData,
  probeGitVersion,
  resolveGitInvocationRepo,
  snapshotCommitment,
} from "./gitvault-snapshot.js";
export type {
  GitConfigDiscoveryEnv,
  GitInvocationRepo,
  GitvaultCapturedFile,
  GitvaultCapturedSetDrift,
  GitvaultRepositoryInspection,
  GitvaultRepositoryRefusalCode,
  GitvaultSnapshot,
  GitvaultSnapshotOptions,
  GitvaultSnapshotRefusalPath,
  GlobalExcludesDiscovery,
  GlobalExcludesRefusal,
  HardenedGitOptions,
  HardenedGitResult,
  ParsedGitConfigEntry,
} from "./gitvault-snapshot.js";
export {
  GITVAULT_INLINE_UPLOAD_MAX_OBJECT_BYTES,
  GITVAULT_INLINE_UPLOAD_MAX_REQUEST_BYTES,
  GITVAULT_MAX_CANONICAL_REFS,
  GITVAULT_MAX_CHECKPOINT_PACKS,
  GITVAULT_MAX_CHECKPOINT_TOTAL_STORED_BYTES,
  GITVAULT_MAX_HEADS_PER_LISTING_PAGE,
  GITVAULT_MAX_REF_STATE_OBJECT_BYTES,
  GITVAULT_MAX_REF_UPDATES_PER_TRANSACTION,
  GITVAULT_MAX_REPAIR_ADDED_ROOTS,
  GITVAULT_MAX_RETENTION_ROOT_ENTRIES,
  GITVAULT_MAX_WAL_RECEIPTS_PER_HEAD,
  GITVAULT_MULTI_OBJECT_PACK_TARGET_BYTES,
  GITVAULT_PUSH_CONFLICT_RETRIES,
  GITVAULT_R402_REF_NAMESPACE,
  GITVAULT_RETAIN_REF_PREFIX,
  GITVAULT_RETENTION_MIN_DAYS,
  GITVAULT_VERIFICATION_BUDGET_HEADS,
  GitvaultVault,
  assertNoTransition,
  assertRefMapCardinality,
  bigIntToGeneration,
  captureBinding,
  checkChainLink,
  checkClaimSetEquality,
  checkGenerationRegression,
  checkOpenBinding,
  compareRoots,
  createGitvaultHttpTransport,
  deployRefTransaction,
  effectiveAdmittedAt,
  evaluateRefTransaction,
  evolveRetentionRoots,
  generationToBigInt,
  gitvaultInlineUploadEligible,
  gitvaultPaths,
  gitvaultRetainedRefName,
  isRootEligibleForRemoval,
  nextGeneration,
  nextListingRequest,
  gitvaultLedgerId,
  gitvaultManifestEntry,
  gitvaultWireRefForPath,
  openBindingDigest,
  reconcileRetainedTipRefs,
  validateHeadsListingRequest,
  verifyHeadsListingPage,
  readGitvaultRestoreMarker,
  GITVAULT_AUTO_GC_GENERATIONS_DEFAULT,
  readGitvaultAutoGcThreshold,
  writeGitvaultAutoGcThreshold,
} from "./gitvault-publication.js";
export type {
  GitvaultAdmitHeadRequest,
  GitvaultAdmitHeadResult,
  GitvaultBuiltCheckpoint,
  GitvaultChainLinkInput,
  GitvaultCutoffOptions,
  GitvaultDroppedTip,
  GitvaultEvaluateRefTransactionOptions,
  GitvaultEvolveRootsOptions,
  GitvaultHttpTransportOptions,
  GitvaultListingProgress,
  GitvaultMaintenanceLease,
  GitvaultMaintenanceLeaseRequest,
  GitvaultObjectReadRequest,
  GitvaultResourceBinding,
  GitvaultVaultRecord,
  GitvaultVaultState,
  GitvaultWireRef,
  GitvaultMaterializedState,
  GitvaultOpenBindingRecord,
  GitvaultPublishResult,
  GitvaultPushOptions,
  GitvaultPushPlan,
  GitvaultRefMap,
  GitvaultRefTransactionEvaluation,
  GitvaultRefUpdateFailure,
  GitvaultRestoreMarker,
  GitvaultRetainedRefsReconcileResult,
  GitvaultRetentionCutoffIssued,
  GitvaultTransport,
  GitvaultUploadObject,
  GitvaultUploadReceipt,
  GitvaultVaultOptions,
  GitvaultVerifiedState,
  GitvaultCompactionGrant,
} from "./gitvault-publication.js";
export {
  GITVAULT_DEPLOY_OUTCOMES,
  SNAPSHOT_MOVED_DURING_DEPLOY,
  checkActivationTokenBinding,
  checkAuthorizationEpoch,
  drainOverrideJournals,
  listPendingOverrideJournals,
  matchCaptureReceipt,
  overrideJournalDir,
  overrideJournalPath,
  readOverrideJournal,
  runGitvaultDeploy,
  writeOverrideJournal,
} from "./gitvault-deploy.js";
export type {
  GitvaultCaptureReceiptMatch,
  GitvaultDeployError,
  GitvaultDeployLane,
  GitvaultDeployLaneCommitInput,
  GitvaultDeployLanePlan,
  GitvaultDeployLanePlanInput,
  GitvaultDeployNextAction,
  GitvaultDeployOptions,
  GitvaultDeployOutcome,
  GitvaultDeployResult,
  GitvaultOverrideDrainReport,
  GitvaultOverrideJournal,
  GitvaultSnapshotMovedDetails,
} from "./gitvault-deploy.js";
// gitvault D2 (repo-first-onramp task 2.2) — lazy allocation on first push;
// the orchestration `Gitvault.openOrCreate` delegates to.
export { openOrCreateGitvault } from "./gitvault-open-or-create.js";
export type { OpenOrCreateGitvaultOptions, OpenOrCreateGitvaultResult } from "./gitvault-open-or-create.js";
// gitvault D6 — push-to-create (repo-first-onramp task 4.4/4.5), the
// orchestration `Gitvault.resolveOrCreateAddress` delegates to.
export { pushToCreateGitvault } from "./gitvault-push-to-create.js";
export type { PushToCreateGitvaultOptions, PushToCreateGitvaultResult } from "./gitvault-push-to-create.js";
// gitvault D6 — named-address resolution + id-pinning (repo-first-onramp
// task 4.5): local git-config pin read/write, and the resolve-or-create
// orchestrator `Gitvault.resolveOrCreateAddress` delegates to.
export { readPinnedGitvaultRepo, pinGitvaultRepo, resolveGitvaultAddress } from "./gitvault-address.js";
export type { GitvaultPinnedRepo, GitvaultAddressResolution, ResolveGitvaultAddressOptions } from "./gitvault-address.js";
export { prewarmGitvaultConnection, predialGitvaultObjectStore } from "./gitvault-prewarm.js";
// gitvault cross-profile repo-key scan (kychee-com/run402#564) — shared by
// every keystore-miss enrichment point; see the module doc for why this is
// a directory/filename read, never key material.
export { findLocalProfilesHoldingGitvaultRepo, crossProfileGitvaultHint } from "./gitvault-profile-scan.js";
// The deploy lane the interface above was always missing (change
// `gitvault-deploy-lane`): apply-v1 plan + commit driven through `Deploy`,
// and the entry point that engages it only for a `required` project.
export { applyWithGitvault, createApplyDeployLane } from "./gitvault-apply.js";
export type {
  ApplyDeployLane,
  ApplyDeployLaneOptions,
  ApplyWithGitvaultOptions,
  ApplyWithGitvaultResult,
  GitvaultApplyMode,
} from "./gitvault-apply.js";
export * from "../namespaces/gitvault.crypto.js";
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
  PaymentBuyerError,
  PaymentPolicyError,
  X402_COMMERCE_RESULT_SCHEMA_VERSION,
  X402_EVIDENCE_STATUSES,
  X402_GATEWAY_AVAILABILITY_ERROR_CODE,
  X402_MUTATION_STATES,
  X402_PAYMENT_POLICY_ERROR_CODES,
  X402_RECOVERY_ACTIONS,
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
  isPaymentBuyerError,
  isPaymentPolicyError,
  isLocalError,
  isDeployError,
  isRetryableRun402Error,
  isCiSessionCredentials,
  isDelegateCredentials,
  delegateTokenFromEnv,
  DELEGATE_TOKEN_ENV,
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
