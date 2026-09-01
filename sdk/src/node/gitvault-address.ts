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
/**
 * The resolved ids beside the pin (gitvault-force-spelling-and-pin-fold).
 * A pin carrying BOTH resolves fully OFFLINE — zero transport operations —
 * which is what removes the standing per-invocation validation read; a
 * legacy pin without them self-upgrades through one validation read.
 */
const CONFIG_KEY_PROJECT_ID = "r402.projectId";
const CONFIG_KEY_ORG_ID = "r402.orgId";

export interface GitvaultPinnedRepo {
  repo_id: string;
  /** `null` if the pin predates this field, or was written by hand. */
  resolved_from: { org_slug: string; repo_name: string } | null;
  /** `null` on a legacy pin that predates the id-carrying schema (or one written by hand) — resolution then self-upgrades it through one validation read. */
  project_id: string | null;
  /** `null` on a legacy pin — see `project_id`. */
  org_id: string | null;
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
  const projectId = await readLocalGitConfig(repoDir, CONFIG_KEY_PROJECT_ID);
  const orgId = await readLocalGitConfig(repoDir, CONFIG_KEY_ORG_ID);
  return { repo_id: repoId, resolved_from: resolvedFrom, project_id: projectId, org_id: orgId };
}

/**
 * Pin `repo_id` into this checkout's LOCAL git config — and, when resolved
 * from a slug-form address, the address it was resolved from (diagnostic
 * only). `resolvedFrom` is omitted for an id-form pin (gitvault-client-
 * round-trips design D4): an id-form address has no org-slug/name pair to
 * record, and — per {@link resolveGitvaultAddress}'s own doc comment — the
 * design's instruction is that pinning "only resolves names"; id-form is
 * already rename-proof, so this pin exists purely to skip the resolution
 * ROUND TRIP, not to survive a rename.
 */
export async function pinGitvaultRepo(repoDir: string, repoId: string, resolvedFrom?: { org_slug: string; repo_name: string }, ids?: { project_id: string; org_id: string }): Promise<void> {
  await hardenedGit(repoDir, ["config", "--local", CONFIG_KEY_REPO_ID, repoId]);
  if (resolvedFrom) await hardenedGit(repoDir, ["config", "--local", CONFIG_KEY_ADDRESS, `${resolvedFrom.org_slug}/${resolvedFrom.repo_name}`]);
  if (ids) {
    await hardenedGit(repoDir, ["config", "--local", CONFIG_KEY_PROJECT_ID, ids.project_id]);
    await hardenedGit(repoDir, ["config", "--local", CONFIG_KEY_ORG_ID, ids.org_id]);
  }
}

/** Clear a pin this checkout no longer trusts (design D4: a pinned id that 404s). Tolerates an absent key — `git config --unset` on a key that was never set is not a failure here. */
async function clearPinnedGitvaultRepo(repoDir: string): Promise<void> {
  for (const key of [CONFIG_KEY_REPO_ID, CONFIG_KEY_ADDRESS, CONFIG_KEY_PROJECT_ID, CONFIG_KEY_ORG_ID]) {
    try {
      await hardenedGit(repoDir, ["config", "--local", "--unset", key]);
    } catch {
      // already absent — nothing to clear
    }
  }
}

/** `RESOURCE_NOT_FOUND` (or a bare 404) — the "this pin no longer resolves" signal, never any other failure. */
function isPinStale(e: unknown): boolean {
  const err = e as { status?: number; code?: string } | null;
  return Boolean(err && (err.status === 404 || err.code === "RESOURCE_NOT_FOUND" || err.code === "ROUTE_NOT_FOUND"));
}

export interface GitvaultAddressResolution {
  repo_id: string;
  project_id: string;
  org_id: string;
  form: "id" | "slug";
  /**
   * How this resolution happened: a local git-config pin, the local
   * keystore's own project→repo file (gitvault-offline-clone-resolve,
   * id-form only — {@link GitvaultKeystore.findRepoByProject}), a live
   * network resolution, or a fresh push-to-create. `"pin"` and `"keystore"`
   * are BOTH zero-transport-operation answers (see {@link offline}); they
   * are kept distinct only so a caller that cares about provenance can tell
   * them apart — {@link recoverStaleGitvaultPin}'s generic `offline` check
   * treats them identically.
   */
  via: "pin" | "keystore" | "resolved" | "created";
  /** The `org-slug/name` the address named, when slug-form; `null` for id-form. */
  address: { org_slug: string; repo_name: string } | null;
  /** Set only when THIS call push-to-created the vault (`via === "created"`); `null` otherwise. */
  created: { deduplicated: boolean; recovery_receipt: GitvaultCreationResult["recovery_receipt"]; genesis_sha256: string } | null;
  /**
   * `true` iff this resolution performed ZERO transport operations (an
   * id-carrying pin). Stale-pin recovery is then the caller's to arm on the
   * verb's first repo-scoped read — see {@link recoverStaleGitvaultPin}.
   */
  offline: boolean;
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
  /**
   * gitvault-offline-clone-resolve (design D3): recovery-only. Skips BOTH
   * local answers — the git-config pin AND the id-form keystore consult —
   * forcing a genuine network resolution. Set exclusively by {@link
   * recoverStaleGitvaultPin}'s internal re-resolve call: a stale local
   * answer (a pin or a keystore file naming a repo that no longer resolves
   * or is no longer ours) must never be allowed to answer the SAME stale
   * fact back to itself, which is what would happen if recovery re-ran the
   * ordinary local-first path. Never set by an ordinary caller.
   */
  bypass_local_answers?: boolean;
}

/**
 * Resolve a parsed remote address to `{repo_id, project_id, org_id}`,
 * pinning `repo_id` in local git state on the first successful resolution —
 * of EITHER form (gitvault-client-round-trips design D4 widens the
 * pre-existing slug-form pin, task 4.5, to id-form too) — and, when
 * `allow_create` is set and resolution misses, push-to-create it (task
 * 4.4/4.5, design D6). A pinned id that no longer resolves (404) clears the
 * pin and re-resolves ONCE through the ordinary form-dispatch path below,
 * rather than failing on a stale local pointer.
 */
export async function resolveGitvaultAddress(options: ResolveGitvaultAddressOptions): Promise<GitvaultAddressResolution> {
  if (options.repo_dir && !options.bypass_local_answers) {
    const pinned = await readPinnedGitvaultRepo(options.repo_dir);
    if (pinned) {
      // `form` below describes what THIS call was asked to resolve, not how
      // the pin originally came to exist (`resolved_from` alone can't tell —
      // it is `null` for both an id-form pin and a pin that predates the
      // field/was written by hand).
      if (pinned.project_id && pinned.org_id) {
        // Id-carrying pin: fully OFFLINE — zero transport operations. The
        // stale-pin case (the vault deleted out from under this checkout)
        // surfaces on the verb's first repo-scoped read instead; the caller
        // arms {@link recoverStaleGitvaultPin} for that (client-surface
        // spec, "Id-form remotes pin repo_id like slug-form remotes").
        return { repo_id: pinned.repo_id, project_id: pinned.project_id, org_id: pinned.org_id, form: gitvaultRemoteAddressForm(options.address), via: "pin", address: pinned.resolved_from, created: null, offline: true };
      }
      try {
        // Legacy id-less pin: one validation read, then REWRITE the pin with
        // the ids so every later invocation on this checkout is offline —
        // self-upgrading, no migration step.
        const record = await options.transport.getVaultRecord({ repo_id: pinned.repo_id });
        await pinGitvaultRepo(options.repo_dir, record.repo_id, pinned.resolved_from ?? undefined, { project_id: record.project_id, org_id: record.org_id });
        return { repo_id: record.repo_id, project_id: record.project_id, org_id: record.org_id, form: gitvaultRemoteAddressForm(options.address), via: "pin", address: pinned.resolved_from, created: null, offline: false };
      } catch (e) {
        if (!isPinStale(e)) throw e;
        await clearPinnedGitvaultRepo(options.repo_dir);
        // fall through to an ordinary (non-pinned) resolution, below
      }
    }
  }

  const form = gitvaultRemoteAddressForm(options.address);
  if (form === "id") {
    if (!options.bypass_local_answers) {
      // gitvault-offline-clone-resolve (design D1/D2): consult the LOCAL
      // keystore before the network. D2's completeness argument: decrypting
      // anything from this vault requires exactly the keystore's repo file
      // (`k_repo_hex`), so a machine without one fails the clone at
      // `GITVAULT_REPO_STATE_MISSING` no matter how resolution went —
      // "keystore-known" is therefore exactly the set of clones that can
      // actually complete, and the network read was only ever confirming a
      // fact this machine already held (measured 110-530ms of RTT for
      // 13-22ms of server work, 2026-09-01). An id-form address always
      // carries a real `org_id` (see `gitvaultRemoteAddressForm`), so the
      // lookup is always org-scoped — a project-id match under a different
      // org is a miss, never a guess. Deliberately runs even with NO
      // `repo_dir` (a repo-free `git ls-remote`): the keystore is
      // cwd-independent, unlike the git-config pin above.
      const keystoreMatch = options.keystore.findRepoByProject(options.address.project_id, options.address.org_id);
      if (keystoreMatch) {
        // Same offline handle shape the git-config pin branch above builds;
        // `via: "keystore"` is the only distinguishing mark, so {@link
        // recoverStaleGitvaultPin}'s generic `resolution.offline` check
        // covers this source unchanged. The git-config pin is written
        // immediately — "on first successful use" of this answer, exactly
        // where the network-resolved branch below writes it — so every
        // LATER invocation on this checkout short-circuits through the pin
        // check above instead of this keystore scan.
        if (options.repo_dir) await pinGitvaultRepo(options.repo_dir, keystoreMatch.repo_id, undefined, { project_id: keystoreMatch.project_id, org_id: keystoreMatch.org_id });
        return { repo_id: keystoreMatch.repo_id, project_id: keystoreMatch.project_id, org_id: keystoreMatch.org_id, form: "id", via: "keystore", address: null, created: null, offline: true };
      }
    }
    const record: GitvaultVaultRecord = await options.transport.findVaultByProject({ project_id: options.address.project_id });
    // Design D4: an id-form address is already rename-proof (a project id
    // never changes), so this pin exists purely to skip the RESOLUTION
    // round trip on every later invocation — never to survive a rename, per
    // the design's own "pin only resolves names" framing for WHY a pin is
    // needed at all; id-form gets one anyway because the round trip itself
    // is the cost this change removes.
    if (options.repo_dir) await pinGitvaultRepo(options.repo_dir, record.repo_id, undefined, { project_id: record.project_id, org_id: record.org_id });
    return { repo_id: record.repo_id, project_id: record.project_id, org_id: record.org_id, form: "id", via: "resolved", address: null, created: null, offline: false };
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
    if (options.repo_dir) await pinGitvaultRepo(options.repo_dir, result.repo_id, { org_slug: orgSlug, repo_name: repoName }, { project_id: result.project_id, org_id: result.org_id });
    if (!result.found && result.created) await options.onVaultCreated?.(result.created);
    return { repo_id: result.repo_id, project_id: result.project_id, org_id: result.org_id, form: "slug", via: result.found ? "resolved" : "created", address: { org_slug: orgSlug, repo_name: repoName }, created: result.created, offline: false };
  }

  // Read-only path (`list`/`fetch`, plain `status`): a miss is an ordinary
  // not-found refusal — including `SLUG_RELEASED`, which is NEVER
  // auto-followed and rethrows unchanged either way.
  const record = await options.transport.findVaultByRepo({ org_slug: orgSlug, repo_name: repoName });
  if (options.repo_dir) await pinGitvaultRepo(options.repo_dir, record.repo_id, { org_slug: orgSlug, repo_name: repoName }, { project_id: record.project_id, org_id: record.org_id });
  return { repo_id: record.repo_id, project_id: record.project_id, org_id: record.org_id, form: "slug", via: "resolved", address: { org_slug: orgSlug, repo_name: repoName }, created: null, offline: false };
}

/**
 * Stale-pin recovery for OFFLINE resolutions (client-surface spec,
 * "Id-form remotes pin repo_id like slug-form remotes"; widened by
 * gitvault-offline-clone-resolve design D3 to the keystore-sourced offline
 * answer too): a pin or a keystore hit resolves with no network read, so the
 * once-in-a-lifetime stale case (a vault deleted and re-allocated out from
 * under this checkout, or a keystore file left behind by an old allocation)
 * surfaces as the VERB's first repo-scoped read failing instead of a
 * resolution failure.
 *
 * Given that failure, answer the fresh resolution to retry the verb against —
 * or `null` when there is nothing to recover:
 *
 *   - a non-vault-absent error (anything outside the not-found family and the
 *     gateway's authorize-before-reveal `GITVAULT_ACCESS_DENIED` fold, which
 *     deliberately makes "gone" and "not yours" one envelope) → `null`,
 *     rethrow yours;
 *   - re-resolution yielding the SAME `repo_id` → the local answer was fine
 *     and the refusal is real: the pin is restored (re-resolution re-pins
 *     it) and the answer is `null` — recovery never widens what an
 *     unauthorized caller learns (both probes return the same refusal
 *     family it already saw);
 *   - a DIFFERENT `repo_id` → the fresh resolution, pin already rewritten;
 *     the caller retries the verb exactly once.
 *
 * The re-resolve MUST bypass every local answer (`bypass_local_answers:
 * true`) — a stale keystore file (or, before this change, a stale pin) is
 * exactly the fact recovery exists to get past, so re-running the ordinary
 * local-first path would just consult the SAME stale local answer again and
 * never reach the network. This is why the retry always costs one real
 * transport operation, deliberately outside the counted budgets (D3, D5).
 *
 * Re-resolution failures are swallowed in favor of `null` (the caller's
 * original error is the truthful one to surface).
 */
export async function recoverStaleGitvaultPin(options: {
  keystore: GitvaultKeystore;
  transport: GitvaultTransport;
  address: GitvaultRemoteAddress;
  repo_dir: string;
  /** The offline resolution the failing verb ran under. */
  resolution: GitvaultAddressResolution;
  /** The verb's failure. */
  error: unknown;
}): Promise<GitvaultAddressResolution | null> {
  if (!options.resolution.offline) return null;
  const err = options.error as { status?: number; code?: string } | null;
  const vaultAbsentSignal = Boolean(err && (isPinStale(err) || err.code === "GITVAULT_ACCESS_DENIED" || err.status === 403));
  if (!vaultAbsentSignal) return null;
  try {
    await clearPinnedGitvaultRepo(options.repo_dir);
    const fresh = await resolveGitvaultAddress({ keystore: options.keystore, transport: options.transport, address: options.address, repo_dir: options.repo_dir, bypass_local_answers: true });
    return fresh.repo_id === options.resolution.repo_id ? null : fresh;
  } catch {
    return null;
  }
}
