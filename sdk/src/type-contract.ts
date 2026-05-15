import type {
  ActiveReleaseInventory,
  DeployResolveAuthorizationResult,
  DeployResolveCasObject,
  DeployResolveFallbackState,
  DeployResolveMatch,
  DeployResolveResponse,
  DeployResolveResponseVariant,
  DeployResolveSummary,
  DeployResolveWarning,
  DeployObservabilityWarningEntry,
  KnownDeployResolveAuthorizationResult,
  KnownDeployResolveFallbackState,
  DeploySummary,
  KnownDeployResolveMatch,
  PlanDiffEnvelope,
  PublicStaticPathSpec,
  ReleaseRoutesSpec,
  ReleaseSnapshotInventory,
  ReleaseSpec,
  ReleaseToReleaseDiff,
  RoutesDiff,
  RouteEntry,
  RouteTarget,
  StaticAssetsDiff,
  StaticPublicPathInventoryEntry,
  StaticReachabilityAuthority,
  StaticManifestMetadata,
  StaticRouteTarget,
  SitePublicPathsSpec,
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
type _ResolveAuthorizationResult = Assert<
  Equal<
    DeployResolveResponse["authorization_result"],
    DeployResolveAuthorizationResult | null | undefined
  >
>;
type _ResolveCasObject = Assert<
  Equal<NonNullable<DeployResolveResponse["cas_object"]>, DeployResolveCasObject>
>;
type _ResolveCasActualSize = Assert<
  Equal<DeployResolveCasObject["actual_size"], number | null | undefined>
>;
type _ResolveResponseVariant = Assert<
  Equal<
    NonNullable<DeployResolveResponse["response_variant"]>,
    DeployResolveResponseVariant
  >
>;
type _ResolveRoutePattern = Assert<
  Equal<DeployResolveResponse["route_pattern"], string | null | undefined>
>;
type _ResolveTargetType = DeployResolveResponse["target_type"];
type _ResolveTargetName = Assert<
  Equal<DeployResolveResponse["target_name"], string | null | undefined>
>;
type _ResolveTargetFile = Assert<
  Equal<DeployResolveResponse["target_file"], string | null | undefined>
>;
type _ResolveWarnings = DeployResolveSummary["warnings"][number] & DeployResolveWarning;
type _InventoryStaticMetadata = Assert<
  Equal<ActiveReleaseInventory["static_manifest_metadata"], StaticManifestMetadata | null>
>;
type _PlanDiffStaticAssets = Assert<Equal<PlanDiffEnvelope["static_assets"], StaticAssetsDiff>>;
type _ReleaseDiffStaticAssets = Assert<Equal<ReleaseToReleaseDiff["static_assets"], StaticAssetsDiff>>;
type _ExplicitPublicPaths = Extract<SitePublicPathsSpec, { mode: "explicit" }>;
type _ImplicitPublicPaths = Extract<SitePublicPathsSpec, { mode: "implicit" }>;
type _PublicStaticCacheClass = PublicStaticPathSpec["cache_class"];
type _SitePublicPathOnly = Extract<
  NonNullable<ReleaseSpec["site"]>,
  { public_paths: SitePublicPathsSpec }
>;
type _StaticPublicPathInventory = ActiveReleaseInventory["static_public_paths"];
type _StaticReachabilityAuthority = StaticPublicPathInventoryEntry["reachability_authority"] & StaticReachabilityAuthority;

const _ExplicitPublicPathTable: _ExplicitPublicPaths = {
  mode: "explicit",
  replace: { "/events": { asset: "events.html", cache_class: "html" } },
};
const _ImplicitPublicPathMode: _ImplicitPublicPaths = { mode: "implicit" };
const _PublicPathOnlySpec: _SitePublicPathOnly = {
  public_paths: { mode: "explicit", replace: {} },
};
void _ExplicitPublicPathTable;
void _ImplicitPublicPathMode;
void _PublicPathOnlySpec;
void (null as unknown as _PublicStaticCacheClass);
void (null as unknown as _StaticPublicPathInventory);
void (null as unknown as _StaticReachabilityAuthority);

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
const _KnownRouteResolveLiteral: KnownDeployResolveMatch = "route_function";
const _KnownRouteStaticAliasResolveLiteral: KnownDeployResolveMatch = "route_static_alias";
const _KnownRouteMethodMissResolveLiteral: KnownDeployResolveMatch = "route_method_miss";
const _KnownActiveReleaseMissingResolveLiteral: KnownDeployResolveMatch = "active_release_missing";
const _KnownUnsupportedManifestResolveLiteral: KnownDeployResolveMatch = "unsupported_manifest_version";
const _FutureResolveMatch: DeployResolveMatch = "future_gateway_match";
const _KnownResolveAuthorizationResult: KnownDeployResolveAuthorizationResult = "missing_cas_object";
const _KnownUnsupportedManifestAuthorizationResult: KnownDeployResolveAuthorizationResult = "unsupported_manifest_version";
const _FutureResolveAuthorizationResult: DeployResolveAuthorizationResult = "future_authorization_result";
const _KnownActiveReleaseMissingFallbackState: KnownDeployResolveFallbackState = "active_release_missing";
const _KnownUnsupportedManifestFallbackState: KnownDeployResolveFallbackState = "unsupported_manifest_version";
const _KnownNegativeCacheHitFallbackState: KnownDeployResolveFallbackState = "negative_cache_hit";
const _FutureResolveFallbackState: DeployResolveFallbackState = "future_fallback_state";
// @ts-expect-error unknown literals are not part of the known authorization-result union
const _NoUnknownKnownResolveAuthorizationResult: KnownDeployResolveAuthorizationResult = "future_authorization_result";
// @ts-expect-error unknown literals are not part of the known fallback-state union
const _NoUnknownKnownResolveFallbackState: KnownDeployResolveFallbackState = "future_fallback_state";
// @ts-expect-error implicit mode cannot carry a replace map
const _NoImplicitPublicPathReplace: SitePublicPathsSpec = {
  mode: "implicit",
  replace: { "/events": { asset: "events.html" } },
};

void (null as unknown as _ResolveSparseHostMiss);
void (null as unknown as _ResolveTargetType);
void _KnownRouteResolveLiteral;
void _KnownRouteStaticAliasResolveLiteral;
void _KnownRouteMethodMissResolveLiteral;
void _KnownActiveReleaseMissingResolveLiteral;
void _KnownUnsupportedManifestResolveLiteral;
void _FutureResolveMatch;
void _KnownResolveAuthorizationResult;
void _KnownUnsupportedManifestAuthorizationResult;
void _FutureResolveAuthorizationResult;
void _KnownActiveReleaseMissingFallbackState;
void _KnownUnsupportedManifestFallbackState;
void _KnownNegativeCacheHitFallbackState;
void _FutureResolveFallbackState;

export {};
