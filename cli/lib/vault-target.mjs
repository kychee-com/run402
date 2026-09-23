/**
 * Vault verb targeting when standing inside a repository: the CLI edge of
 * `resolveVaultTarget` (`@run402/sdk/node`), which owns the order — an
 * explicit `--repo`/`--project` > this checkout's id-pin > its own
 * `run402`/`origin` remote > `RUN402_PROJECT_ID` > the active project.
 * `run402 repos view|snapshot|policy|mirror|fsck|gc|access` and the doctor's
 * vault check compose it; a disagreeing explicit flag still wins, with one
 * stderr warning naming both.
 */
import { getSdk } from "./sdk.mjs";
import { repoOwnVaultTarget as sdkRepoOwnVaultTarget, resolveVaultTarget as sdkResolveVaultTarget } from "#sdk/node";

/** This repository's OWN vault address (pin, else `run402`/`origin` remote), or null. */
export async function repoOwnVaultTarget(repoDir) {
  return sdkRepoOwnVaultTarget(getSdk().repos, repoDir);
}

/** The vault a verb addresses from `repoDir`: `{ repo_id }` or `{ project_id }`. */
export async function resolveVaultTarget(opts = {}) {
  return sdkResolveVaultTarget(getSdk().repos, opts);
}
