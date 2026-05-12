import type {
  ActiveReleaseInventory,
  DeployResolveResponse,
  DeployResolveSummary,
  DeployResolveWarning,
  DeployObservabilityWarningEntry,
  DeploySummary,
  KnownDeployResolveMatch,
  PlanDiffEnvelope,
  ReleaseRoutesSpec,
  ReleaseSnapshotInventory,
  ReleaseSpec,
  ReleaseToReleaseDiff,
  RoutesDiff,
  RouteEntry,
  RouteTarget,
  StaticAssetsDiff,
  StaticManifestMetadata,
  StaticRouteTarget,
} from "./namespaces/deploy.types.js";
import type { SecretSummary } from "./namespaces/secrets.js";

type DeploySecrets = NonNullable<ReleaseSpec["secrets"]>;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type Assert<T extends true> = T;

// These erased type checks keep the public SDK contract from drifting back to
// value-bearing deploy secrets. If the old fields reappear, tsc reports the
// unused @ts-expect-error directives.
// @ts-expect-error deploy secret values must be written through r.secrets.set
type _NoDeploySecretsSet = DeploySecrets["set"];
// @ts-expect-error exact secret replacement is not represented by ReleaseSpec
type _NoDeploySecretsReplaceAll = DeploySecrets["replace_all"];
// @ts-expect-error secret listings must not expose value-derived hashes
type _NoSecretValueHash = SecretSummary["value_hash"];

type _ActiveInventoryIsCurrentLive = Assert<
  Equal<ActiveReleaseInventory["state_kind"], "current_live">
>;
type _ReleaseSnapshotInventoryKind = Assert<
  Equal<ReleaseSnapshotInventory["state_kind"], "effective" | "desired_manifest">
>;
type _DeployObservabilityWarningSeverity = Assert<
  Equal<DeployObservabilityWarningEntry["severity"], "info" | "warn" | "high">
>;
type _ReleaseDiffAppliedMigrations =
  ReleaseToReleaseDiff["migrations"]["applied_between_releases"];
type _RouteSpecResource = Assert<
  Equal<ReleaseSpec["routes"], ReleaseRoutesSpec | undefined>
>;
type _ReleaseDiffRoutes = Assert<Equal<ReleaseToReleaseDiff["routes"], RoutesDiff>>;
type _RouteEntryMethods = RouteEntry["methods"];
type _StaticRouteTarget = Extract<RouteTarget, { type: "static" }>;
type _StaticRouteFile = Assert<Equal<_StaticRouteTarget, StaticRouteTarget>>;
type _ResolveSparseHostMiss = Pick<
  DeployResolveResponse,
  "hostname" | "result" | "match" | "authorized" | "fallback_state"
>;
type _ResolveResultIsNumber = Assert<Equal<DeployResolveResponse["result"], number>>;
type _ResolveWarnings = DeployResolveSummary["warnings"][number] & DeployResolveWarning;
type _InventoryStaticMetadata = Assert<
  Equal<ActiveReleaseInventory["static_manifest_metadata"], StaticManifestMetadata | null>
>;
type _PlanDiffStaticAssets = Assert<Equal<PlanDiffEnvelope["static_assets"], StaticAssetsDiff>>;
type _ReleaseDiffStaticAssets = Assert<Equal<ReleaseToReleaseDiff["static_assets"], StaticAssetsDiff>>;

// @ts-expect-error release-to-release diffs do not expose plan migration buckets
type _NoReleaseDiffMigrationNew = ReleaseToReleaseDiff["migrations"]["new"];
// @ts-expect-error release-to-release diffs do not expose migration mismatch buckets
type _NoReleaseDiffMigrationMismatch = ReleaseToReleaseDiff["migrations"]["mismatch"];
// @ts-expect-error modern successful plan diffs do not expose migration mismatch
type _NoPlanDiffMigrationMismatch = PlanDiffEnvelope["migrations"]["mismatch"];
// @ts-expect-error secrets diffs intentionally have no changed bucket
type _NoSecretChangedBucket = ReleaseToReleaseDiff["secrets"]["changed"];
// @ts-expect-error deploy summaries intentionally omit phase timing estimates
type _NoDeploySummaryTimings = DeploySummary["timings"];
// @ts-expect-error deploy summaries intentionally omit function code hash deltas
type _NoDeploySummaryCodeHashOld = DeploySummary["functions"]["changed"][number]["code_hash_old"];
// @ts-expect-error route resources are replace lists, not path-keyed maps
type _NoPathKeyedRoutes = NonNullable<ReleaseRoutesSpec>["/api/*"];
// @ts-expect-error route-aware known literals are not part of the current private gateway contract
const _NoKnownRouteResolveLiteral: KnownDeployResolveMatch = "route_function";

export {};
