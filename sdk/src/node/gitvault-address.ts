/**
 * gitvault D6 — named addressing resolution + id-pinning (repo-first-onramp
 * task 4.5).
 *
 * Two things live here, both Node-only (local git state):
 *
 *   - PIN read/write: `r402.repoId` (+ `r402.repoAddress`, the human name it
 *     was resolved from) in the repository's LOCAL git config
 *     (`git config --local` — this checkout's own `.git/config`, never
 *     global). "Local git state" per design D6's id-pinning paragraph.
 *   - `resolveGitvaultAddress`: the orchestrator the remote helper and
 *     `gitvault snapshot` drive — pinned id first, then dispatch on the
 *     address's form (id vs slug — {@link gitvaultRemoteAddressForm}), then
 *     (slug-form only, opt-in via `allow_create`) push-to-create on a miss.
 *
 * ID-PINNING RATIONALE (design D6, "resolved"): "on first contact the helper
 * resolves slug/name → repo_id and pins the immutable id in local git state.
 * Names are sugar for humans and first-time clones; every existing checkout
 * follows the id and survives any rename." Concretely: an id-form address
 * (`org_id`/`prj_...`) already survives a rename (project ids never change),
 * so pinning buys it nothing and this module never pins one. A SLUG-form
 * address re-resolves `org-slug/name → repo_id` over the network on every
 * open unless pinned — and a rename of either half would silently break that
 * resolution for an EXISTING checkout the moment it takes effect. Pinning
 * `repo_id` the first time a slug-form address resolves means every later
 * open on this checkout goes straight to `repo_id` (no resolution round-trip,
 * and no exposure to a later rename at all) — structurally better than a
 * redirect, per the design's own framing.
 */

import { hardenedGit } from "./gitvault-snapshot.js";
import { gitvaultRemoteAddressForm, type GitvaultRemoteAddress } from "../namespaces/gitvault.js";
import type { GitvaultVaultRecord, GitvaultTransport } from "./gitvault-publication.js";
import { pushToCreateGitvault } from "./gitvault-push-to-create.js";
import type { GitvaultCreationResult } from "./gitvault-creation-journal.js";
import type { GitvaultKeystore } from "./gitvault-keystore.js";

const CONFIG_KEY_REPO_ID = "r402.repoId";
/** The `org-slug/name` text the pin was resolved from — diagnostic only; resolution never reads it back. */
const CONFIG_KEY_ADDRESS = "r402.repoAddress";

export interface GitvaultPinnedRepo {
  repo_id: string;
  /** `null` if the pin predates this field, or was written by hand. */
  resolved_from: { org_slug: string; repo_name: string } | null;
}

async function readLocalGitConfig(repoDir: string, key: string): Promise<string | null> {
  try {
    const out = (await hardenedGit(repoDir, ["config", "--local", "--get", key])).text().trim();
    return out.length > 0 ? out : null;
  } catch {
    // `git config --get` exits non-zero both when the key is absent and when
    // this is not a repository at all — either way, "nothing pinned" is the
    // correct read for a resolver that must degrade gracefully.
    return null;
  }
}

/** Read this checkout's pinned `repo_id`, or `null` when nothing is pinned. */
export async function readPinnedGitvaultRepo(repoDir: string): Promise<GitvaultPinnedRepo | null> {
  const repoId = await readLocalGitConfig(repoDir, CONFIG_KEY_REPO_ID);
  if (!repoId) return null;
  const address = await readLocalGitConfig(repoDir, CONFIG_KEY_ADDRESS);
  const parts = address ? address.split("/") : [];
  const resolvedFrom = parts.length === 2 && parts[0] && parts[1] ? { org_slug: parts[0], repo_name: parts.slice(1).join("/") } : null;
  return { repo_id: repoId, resolved_from: resolvedFrom };
}

/** Pin `repo_id` (and the address it was resolved from) into this checkout's LOCAL git config. */
export async function pinGitvaultRepo(repoDir: string, repoId: string, resolvedFrom: { org_slug: string; repo_name: string }): Promise<void> {
  await hardenedGit(repoDir, ["config", "--local", CONFIG_KEY_REPO_ID, repoId]);
  await hardenedGit(repoDir, ["config", "--local", CONFIG_KEY_ADDRESS, `${resolvedFrom.org_slug}/${resolvedFrom.repo_name}`]);
}

export interface GitvaultAddressResolution {
  repo_id: string;
  project_id: string;
  org_id: string;
  form: "id" | "slug";
  /** How this resolution happened: a local pin, a live network resolution, or a fresh push-to-create. */
  via: "pin" | "resolved" | "created";
  /** The `org-slug/name` the address named, when slug-form; `null` for id-form. */
  address: { org_slug: string; repo_name: string } | null;
  /** Set only when THIS call push-to-created the vault (`via === "created"`); `null` otherwise. */
  created: { deduplicated: boolean; recovery_receipt: GitvaultCreationResult["recovery_receipt"]; genesis_sha256: string } | null;
}

export interface ResolveGitvaultAddressOptions {
  keystore: GitvaultKeystore;
  transport: GitvaultTransport;
  /** The parsed remote address (`parseGitvaultRemoteUrl`'s output) — id-form or slug-form, undiscriminated. */
  address: GitvaultRemoteAddress;
  /** The local working tree, for reading/writing the pin. Omit for a repository-free read (e.g. `git ls-remote`) — pinning is then skipped, never a failure. */
  repo_dir?: string;
  /** Push-to-create on a slug-form miss (D6). `false` (the default) makes a miss an ordinary not-found refusal — the read-only path (`list`/`fetch`, `gitvault status`). */
  allow_create?: boolean;
  client_creation_id?: string;
  service_public_key?: Uint8Array | string;
  /** Fires once, only when THIS call allocated the vault (mirrors `Gitvault.push`'s `onVaultCreated`). */
  onVaultCreated?: (created: NonNullable<GitvaultAddressResolution["created"]>) => void | Promise<void>;
}

/**
 * Resolve a parsed remote address to `{repo_id, project_id, org_id}`,
 * pinning `repo_id` in local git state on the first successful SLUG-form
 * resolution (task 4.5), and — when `allow_create` is set and resolution
 * misses — push-to-create it (task 4.4/4.5, design D6).
 */
export async function resolveGitvaultAddress(options: ResolveGitvaultAddressOptions): Promise<GitvaultAddressResolution> {
  if (options.repo_dir) {
    const pinned = await readPinnedGitvaultRepo(options.repo_dir);
    if (pinned) {
      const record = await options.transport.getVaultRecord({ repo_id: pinned.repo_id });
      return { repo_id: record.repo_id, project_id: record.project_id, org_id: record.org_id, form: "slug", via: "pin", address: pinned.resolved_from, created: null };
    }
  }

  const form = gitvaultRemoteAddressForm(options.address);
  if (form === "id") {
    // Id-form is already rename-proof (a project id never changes) — no pin,
    // per the design's own instruction ("pin only resolves names").
    const record: GitvaultVaultRecord = await options.transport.findVaultByProject({ project_id: options.address.project_id });
    return { repo_id: record.repo_id, project_id: record.project_id, org_id: record.org_id, form: "id", via: "resolved", address: null, created: null };
  }

  const orgSlug = options.address.org_id;
  const repoName = options.address.project_id;

  // `allow_create` delegates straight to `pushToCreateGitvault`, which
  // already opens with its OWN fast-path `findVaultByRepo` read (step 1 of
  // its own doc comment) — probing here first too would just double the
  // network read on every ordinary (non-creating) push.
  if (options.allow_create) {
    const result = await pushToCreateGitvault({
      keystore: options.keystore,
      transport: options.transport,
      org_slug: orgSlug,
      repo_name: repoName,
      ...(options.client_creation_id !== undefined ? { client_creation_id: options.client_creation_id } : {}),
      ...(options.service_public_key !== undefined ? { service_public_key: options.service_public_key } : {}),
    });
    if (options.repo_dir) await pinGitvaultRepo(options.repo_dir, result.repo_id, { org_slug: orgSlug, repo_name: repoName });
    if (!result.found && result.created) await options.onVaultCreated?.(result.created);
    return { repo_id: result.repo_id, project_id: result.project_id, org_id: result.org_id, form: "slug", via: result.found ? "resolved" : "created", address: { org_slug: orgSlug, repo_name: repoName }, created: result.created };
  }

  // Read-only path (`list`/`fetch`, plain `status`): a miss is an ordinary
  // not-found refusal — including `SLUG_RELEASED`, which is NEVER
  // auto-followed and rethrows unchanged either way.
  const record = await options.transport.findVaultByRepo({ org_slug: orgSlug, repo_name: repoName });
  if (options.repo_dir) await pinGitvaultRepo(options.repo_dir, record.repo_id, { org_slug: orgSlug, repo_name: repoName });
  return { repo_id: record.repo_id, project_id: record.project_id, org_id: record.org_id, form: "slug", via: "resolved", address: { org_slug: orgSlug, repo_name: repoName }, created: null };
}
