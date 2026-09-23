/**
 * "Which vault does this repository mean": the targeting chain `run402 repos`
 * verbs and `doctor`'s vault check share. A verb run standing inside a
 * repository that already names its own vault acts on THAT repository, not on
 * the profile's active project — git muscle memory.
 *
 * Order, highest first:
 *   1. an explicit repo id / project id (the caller's `--repo` / `--project`)
 *   2. the pinned `r402.repoId` in local git config (no network)
 *   3. the repository's `run402` / `origin` remote address — id-form parsed
 *      from the string, slug-form resolved with one read-only
 *      `repos.resolveAddress` (never a pin, never a push-to-create)
 *   4. `RUN402_PROJECT_ID`
 *   5. the profile's active project
 *
 * Outside a repository only tiers 4 and 5 apply. The protocol reads it
 * composes (`readPinnedVaultRepo`, `resolveAddress`) live in the SDK already;
 * this adds only the precedence.
 */

import { getActiveProjectId } from "../../core-dist/keystore.js";
import { parseVaultRemoteUrl, vaultRemoteAddressForm, type Repos } from "../namespaces/repos.js";
import { hardenedGit } from "./vault-snapshot.js";
import { readPinnedVaultRepo } from "./vault-address.js";

export interface RepoOwnVaultTarget {
  repo_id: string | null;
  project_id: string | null;
  source: "pin" | "remote";
  remote_name?: string;
}

export interface VaultTarget {
  repo_id?: string;
  project_id?: string | null;
}

/** Tiers 4 and 5, never throwing: a caller with nothing to target reports that itself. */
function envOrActiveProjectId(): string | null {
  return (process.env.RUN402_PROJECT_ID || "").trim() || getActiveProjectId() || null;
}

async function isInsideGitRepo(repoDir: string): Promise<boolean> {
  try {
    await hardenedGit(repoDir, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The repository's OWN target, independent of any flag: the pin, then the
 * `run402`/`origin` remote. Null when there is neither, when this is not a
 * repository, or when a slug-form remote fails to resolve — a miss is
 * ordinary, never thrown.
 */
export async function repoOwnVaultTarget(repos: Pick<Repos, "resolveAddress">, repoDir: string): Promise<RepoOwnVaultTarget | null> {
  if (!(await isInsideGitRepo(repoDir))) return null;
  const pinned = await readPinnedVaultRepo(repoDir);
  if (pinned) return { repo_id: pinned.repo_id, project_id: null, source: "pin" };
  for (const name of ["run402", "origin"]) {
    let url: string;
    try {
      url = (await hardenedGit(repoDir, ["remote", "get-url", name])).text().trim();
    } catch {
      continue;
    }
    if (!url) continue;
    let address: ReturnType<typeof parseVaultRemoteUrl>;
    try {
      address = parseVaultRemoteUrl(url);
    } catch {
      continue;
    }
    if (!address) continue;
    if (vaultRemoteAddressForm(address) === "id") {
      return { repo_id: null, project_id: address.project_id, source: "remote", remote_name: name };
    }
    try {
      const resolved = await repos.resolveAddress(address);
      return { repo_id: resolved.repo_id, project_id: resolved.project_id, source: "remote", remote_name: name };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve `{ repo_id?, project_id? }` for a vault verb. An explicit value
 * wins; `warn` receives one line when it disagrees with the repository's own
 * target (the pin for a repo id, the remote for a project id).
 */
export async function resolveVaultTarget(
  repos: Pick<Repos, "resolveAddress">,
  {
    repoDir = process.cwd(),
    explicitProjectId,
    explicitRepoId,
    warn = (line: string) => console.error(line),
  }: { repoDir?: string; explicitProjectId?: string | null; explicitRepoId?: string | null; warn?: (line: string) => void } = {},
): Promise<VaultTarget> {
  const needsOwn = explicitRepoId == null || explicitProjectId == null;
  const own = needsOwn ? await repoOwnVaultTarget(repos, repoDir) : null;

  if (explicitRepoId != null && own?.source === "pin" && own.repo_id !== explicitRepoId) {
    warn(`warning: --repo ${explicitRepoId} does not match this repo's pinned vault ${own.repo_id} — using --repo ${explicitRepoId}.`);
  }
  if (explicitProjectId != null && own?.source === "remote" && own.project_id && own.project_id !== explicitProjectId) {
    warn(`warning: --project ${explicitProjectId} does not match this repo's '${own.remote_name}' remote project ${own.project_id} — using --project ${explicitProjectId}.`);
  }

  if (explicitRepoId != null || explicitProjectId != null) {
    const result: VaultTarget = {};
    if (explicitRepoId != null) result.repo_id = explicitRepoId;
    if (explicitProjectId != null) result.project_id = explicitProjectId;
    return result;
  }

  if (own?.source === "pin") return { repo_id: own.repo_id! };
  if (own?.source === "remote" && own.project_id) return { project_id: own.project_id };
  return { project_id: envOrActiveProjectId() };
}
