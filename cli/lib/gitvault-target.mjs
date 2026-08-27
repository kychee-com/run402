/**
 * Shared "which vault does this repo mean" resolution for `run402 gitvault`
 * and `run402 doctor`'s gitvault check. When a verb runs standing inside a
 * repository that already names its own vault via a pinned repo id or a
 * run402/origin remote, targeting prefers that repo over the active-project
 * pointer — git muscle memory says a command run inside a repo acts on THAT
 * repo.
 *
 * Targeting order for a verb run standing inside a git repository, highest
 * first:
 *   1. an explicit --repo/--project flag (owned by each call site — this
 *      module supplies only the fallback chain beneath it, plus the
 *      mismatch warning against tier 3)
 *   2. the pinned `r402.repoId` in local git config — addresses the
 *      vault by repo_id directly, no network read at all
 *   3. the repo's run402/origin remote address — id-form is parsed
 *      directly out of the address string (free, no network); slug-form is
 *      resolved via the SDK (one read-only network call — `resolveAddress`,
 *      never a pin, never a push-to-create; this is a TARGETING read, not a
 *      publish)
 *   4. RUN402_PROJECT_ID env
 *   5. the profile's active project
 *
 * Outside a repository (or when repo detection itself fails), only tiers 4
 * and 5 apply.
 *
 * ARCHITECTURAL NOTE: this is CLI-edge policy (which flag/env/file wins),
 * not gitvault protocol behavior — the same class of concern
 * `wallet-context.mjs` owns for wallet selection. The protocol reads it
 * composes (`readPinnedGitvaultRepo`, `resolveAddress`) already live once in
 * the SDK; this module adds no protocol logic of its own.
 */
import { getActiveProjectId } from "./config.mjs";

/**
 * Tiers 4/5 (RUN402_PROJECT_ID env, then the active project) — deliberately
 * NON-throwing, unlike `config.mjs#resolveProjectId`. `run402 doctor`'s
 * gitvault check needs to report "skipped" gracefully when nothing resolves
 * anywhere (its pre-existing, tested behavior); a `fail()`-triggered
 * `process.exit()` here would abort doctor's ENTIRE report, not just this
 * one check. Callers that DO want the historical PROJECT_REQUIRED failure
 * (gitvault.mjs's own verbs) get it by falling back to `resolveProjectId`
 * themselves when this returns `null` — see `vaultTarget` in gitvault.mjs.
 */
function envOrActiveProjectId() {
  return (process.env.RUN402_PROJECT_ID || "").trim() || getActiveProjectId() || null;
}

async function isInsideGitRepo(repoDir) {
  try {
    const { hardenedGit } = await import("#sdk/node");
    await hardenedGit(repoDir, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The repo's OWN target, independent of any flag — the pin first, then the
 * `run402`/`origin` remote (in that order, mirroring `scaffoldRemote`'s own
 * naming precedence). `null` when the repo has neither, when this is not a
 * repository at all, or (slug-form only) the remote fails to resolve over
 * the network — a miss here is always ordinary, never thrown.
 */
export async function repoOwnGitvaultTarget(repoDir) {
  if (!(await isInsideGitRepo(repoDir))) return null;

  const { hardenedGit, readPinnedGitvaultRepo } = await import("#sdk/node");
  const pinned = await readPinnedGitvaultRepo(repoDir);
  if (pinned) return { repo_id: pinned.repo_id, project_id: null, source: "pin" };

  const { parseGitvaultRemoteUrl, gitvaultRemoteAddressForm } = await import("#sdk");
  for (const name of ["run402", "origin"]) {
    let url;
    try {
      url = (await hardenedGit(repoDir, ["remote", "get-url", name])).text().trim();
    } catch {
      continue; // no such remote — try the other conventional name
    }
    if (!url) continue;
    const address = parseGitvaultRemoteUrl(url);
    if (!address) continue; // exists, but isn't a run402 address — try the other name
    if (gitvaultRemoteAddressForm(address) === "id") {
      // id-form already carries both halves in the address string — no
      // network read needed at all.
      return { repo_id: null, project_id: address.project_id, source: "remote", remote_name: name };
    }
    try {
      const { getSdk } = await import("./sdk.mjs");
      const resolved = await getSdk().gitvault.resolveAddress(address);
      return { repo_id: resolved.repo_id, project_id: resolved.project_id, source: "remote", remote_name: name };
    } catch {
      // Offline, SLUG_RELEASED, not-found, ... — nothing to target from this
      // rung; a caller falls through to env/active project.
      return null;
    }
  }
  return null;
}

/**
 * Resolve `{ repo_id?, project_id? }` for a gitvault verb that addresses a
 * vault the same way `--repo`/`--project` already do — pin beats remote
 * beats env beats active project, an explicit flag beats all of them.
 * `explicitProjectId`/`explicitRepoId` are the already-parsed flag values
 * (`undefined`/`null` when absent — this module owns no flag parsing), and
 * either, neither, or both may be set (mirroring `--repo`/`--project`
 * together being valid on the CLI today). `warn` receives the one-line
 * mismatch note when an explicit flag disagrees with the repo's OWN target;
 * the flag still wins either way. The pin carries no project_id to compare
 * for free, so only `--repo` is checked against it; only the remote tier
 * carries a project_id for free (id-form) or resolves one (slug-form), so
 * only `--project` is checked against it — matching the task's own wording
 * ("a mismatch between an explicit flag and the repo's remote").
 */
export async function resolveGitvaultTarget({
  repoDir = process.cwd(),
  explicitProjectId,
  explicitRepoId,
  warn = (line) => console.error(line),
} = {}) {
  const needsOwn = explicitRepoId == null || explicitProjectId == null;
  const own = needsOwn ? await repoOwnGitvaultTarget(repoDir) : null;

  if (explicitRepoId != null && own?.source === "pin" && own.repo_id !== explicitRepoId) {
    warn(`warning: --repo ${explicitRepoId} does not match this repo's pinned vault ${own.repo_id} — using --repo ${explicitRepoId}.`);
  }
  if (explicitProjectId != null && own?.source === "remote" && own.project_id && own.project_id !== explicitProjectId) {
    warn(`warning: --project ${explicitProjectId} does not match this repo's '${own.remote_name}' remote project ${own.project_id} — using --project ${explicitProjectId}.`);
  }

  if (explicitRepoId != null || explicitProjectId != null) {
    const result = {};
    if (explicitRepoId != null) result.repo_id = explicitRepoId;
    if (explicitProjectId != null) result.project_id = explicitProjectId;
    return result;
  }

  if (own?.source === "pin") return { repo_id: own.repo_id };
  if (own?.source === "remote" && own.project_id) return { project_id: own.project_id };
  return { project_id: envOrActiveProjectId() };
}
