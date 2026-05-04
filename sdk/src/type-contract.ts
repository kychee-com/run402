import type { ReleaseSpec } from "./namespaces/deploy.types.js";
import type { SecretSummary } from "./namespaces/secrets.js";

type DeploySecrets = NonNullable<ReleaseSpec["secrets"]>;

// These erased type checks keep the public SDK contract from drifting back to
// value-bearing deploy secrets. If the old fields reappear, tsc reports the
// unused @ts-expect-error directives.
// @ts-expect-error deploy secret values must be written through r.secrets.set
type _NoDeploySecretsSet = DeploySecrets["set"];
// @ts-expect-error exact secret replacement is not represented by ReleaseSpec
type _NoDeploySecretsReplaceAll = DeploySecrets["replace_all"];
// @ts-expect-error secret listings must not expose value-derived hashes
type _NoSecretValueHash = SecretSummary["value_hash"];

export {};
