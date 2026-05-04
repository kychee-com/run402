import type {
  ActiveReleaseInventory,
  DeployObservabilityWarningEntry,
  PlanDiffEnvelope,
  ReleaseSnapshotInventory,
  ReleaseSpec,
  ReleaseToReleaseDiff,
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

// @ts-expect-error release-to-release diffs do not expose plan migration buckets
type _NoReleaseDiffMigrationNew = ReleaseToReleaseDiff["migrations"]["new"];
// @ts-expect-error release-to-release diffs do not expose migration mismatch buckets
type _NoReleaseDiffMigrationMismatch = ReleaseToReleaseDiff["migrations"]["mismatch"];
// @ts-expect-error modern successful plan diffs do not expose migration mismatch
type _NoPlanDiffMigrationMismatch = PlanDiffEnvelope["migrations"]["mismatch"];
// @ts-expect-error secrets diffs intentionally have no changed bucket
type _NoSecretChangedBucket = ReleaseToReleaseDiff["secrets"]["changed"];

export {};
