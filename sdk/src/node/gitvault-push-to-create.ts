/**
 * gitvault D6 — push-to-create (repo-first-onramp task 4.5).
 *
 * `pushToCreateGitvault` is the primitive the remote helper and `gitvault
 * snapshot` drive when a slug-form remote (`run402::<org-slug>/<name>`)
 * resolves to nothing yet: pushing to a name that does not exist allocates it
 * (design D6), atomically, through the gateway's `POST /gitvault/v1/vaults
 * {org_slug, repo_name}` push-to-create form — the SAME route the ordinary
 * `{project_id}` allocate uses, so the six-stage creation journal
 * ({@link createGitvault}) drives it exactly as it drives an ordinary
 * creation, just addressed by `push_to_create` instead of `project_id`.
 *
 * SHAPE, mirroring the gateway's own `pushToCreateRepo` (run402-private
 * `services/repo-names.ts`) one layer up:
 *
 *   1. Fast path: does `org-slug/name` already resolve
 *      ({@link GitvaultTransport.findVaultByRepo})? If so this is an
 *      ordinary push to an existing repo — return its vault record, allocate
 *      nothing. This is ALSO how a race LOSER's next call resolves cleanly
 *      (see step 3): the repo now exists, so a retry never re-enters the
 *      journal at all.
 *   2. Not found: drive the six-stage journal, addressed by
 *      `push_to_create: {org_slug, repo_name}`. Resumable exactly like the
 *      ordinary path — {@link findResumablePushToCreateJournal} finds an
 *      INCOMPLETE local attempt for this exact address and resumes its
 *      `client_creation_id` rather than starting a second competing one.
 *   3. `REPO_CREATION_CONFLICT` (the gateway's atomic name-claim raced a
 *      concurrent pusher): resolve to the WINNER's project_id (named in the
 *      error's `details.project_id`) via `findVaultByProject`, and report
 *      `found: true` — an ordinary push to the repo that now exists. Design
 *      D6: "no transparent retargeting" — this client never silently
 *      continues against the winner's genesis; it re-resolves and the
 *      NEXT call (an ordinary push) proceeds normally. Nothing here loses
 *      the loser's actual working-tree changes; only its bid to be the
 *      creator.
 *   4. `SLUG_RELEASED` (the org slug is in its post-rename cooldown): NEVER
 *      auto-followed — rethrown unchanged so the caller sees the typed
 *      refusal (successor slug named, cooldown_until stated).
 */

import type { GitvaultCreationResult } from "./gitvault-creation-journal.js";
import { createGitvault, findResumablePushToCreateJournal } from "./gitvault-creation-journal.js";
import type { GitvaultKeystore } from "./gitvault-keystore.js";
import type { GitvaultTransport } from "./gitvault-publication.js";

export interface PushToCreateGitvaultOptions {
  keystore: GitvaultKeystore;
  transport: GitvaultTransport;
  org_slug: string;
  repo_name: string;
  /** Resume a specific creation attempt (or pin it in tests); auto-discovered from the local keystore otherwise. */
  client_creation_id?: string;
  service_public_key?: Uint8Array | string;
}

export type PushToCreateGitvaultResult =
  | { found: true; repo_id: string; project_id: string; org_id: string; created: null }
  | {
      found: false;
      repo_id: string;
      project_id: string;
      org_id: string;
      created: {
        /** Mirrors `GitvaultCreationResult.how === "reconciled"`: an existing local journal was resumed to completion, nothing re-minted. */
        deduplicated: boolean;
        recovery_receipt: GitvaultCreationResult["recovery_receipt"];
        genesis_sha256: string;
      };
    };

function isNotFound(e: unknown): boolean {
  const err = e as { status?: number; code?: string } | null;
  return Boolean(err && (err.status === 404 || err.code === "RESOURCE_NOT_FOUND" || err.code === "ROUTE_NOT_FOUND"));
}

function repoCreationConflictWinner(e: unknown): string | null {
  const err = e as { code?: string; details?: Record<string, unknown> } | null;
  if (!err || err.code !== "REPO_CREATION_CONFLICT") return null;
  const winner = err.details?.project_id;
  return typeof winner === "string" && winner.length > 0 ? winner : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A bounded poll for the winner's vault to become resolvable after a lost
 * `REPO_CREATION_CONFLICT` race — the winner's own creation may still be
 * mid-flight. Budget mirrors the gateway's own analogous poll
 * (`services/repo-names.ts` in run402-private: 20 attempts, 50ms apart);
 * still-unresolvable after the budget rethrows the ORIGINAL not-found
 * failure unchanged, never a synthesized one.
 */
async function pollFindVaultByProject(transport: GitvaultTransport, projectId: string, attempts = 20, intervalMs = 50) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await transport.findVaultByProject({ project_id: projectId });
    } catch (e) {
      if (!isNotFound(e)) throw e;
      lastError = e;
      await sleep(intervalMs);
    }
  }
  throw lastError;
}

/**
 * Resolve `(org_slug, repo_name)`, allocating it (project + vault, atomically)
 * when it does not exist yet.
 */
export async function pushToCreateGitvault(options: PushToCreateGitvaultOptions): Promise<PushToCreateGitvaultResult> {
  // ── 1. fast path: already exists? ──
  try {
    const record = await options.transport.findVaultByRepo({ org_slug: options.org_slug, repo_name: options.repo_name });
    return { found: true, repo_id: record.repo_id, project_id: record.project_id, org_id: record.org_id, created: null };
  } catch (e) {
    if (!isNotFound(e)) throw e; // includes SLUG_RELEASED — never auto-followed
  }

  // ── 2. drive the six-stage journal, addressed by push_to_create ──
  const resumable = options.client_creation_id ? null : findResumablePushToCreateJournal(options.keystore, options.org_slug, options.repo_name);
  try {
    const created = await createGitvault({
      keystore: options.keystore,
      transport: options.transport,
      push_to_create: { org_slug: options.org_slug, repo_name: options.repo_name },
      ...(options.client_creation_id !== undefined
        ? { client_creation_id: options.client_creation_id }
        : resumable
          ? { client_creation_id: resumable.client_creation_id }
          : {}),
      ...(options.service_public_key !== undefined ? { service_public_key: options.service_public_key } : {}),
    });
    return {
      found: false,
      repo_id: created.repo_id,
      project_id: created.project_id,
      org_id: created.org_id,
      created: { deduplicated: created.how === "reconciled", recovery_receipt: created.recovery_receipt, genesis_sha256: created.genesis_sha256 },
    };
  } catch (e) {
    // ── 3. lost the race: resolve to the winner, proceed as an ordinary push ──
    const winnerProjectId = repoCreationConflictWinner(e);
    if (winnerProjectId) {
      // The winner's OWN creation (object upload, genesis admission) may
      // still be in flight the instant this client learns it lost — the
      // gateway's `REPO_CREATION_CONFLICT` only proves the PROJECT exists,
      // not that the winner's vault has finished creating. A short bounded
      // poll (mirroring the gateway's own "poll briefly for the winner's
      // finalized project_id" one layer up, `services/repo-names.ts` in
      // run402-private) covers that ordinary window; a still-unresolvable
      // vault after the budget is a genuine failure, surfaced unchanged.
      const record = await pollFindVaultByProject(options.transport, winnerProjectId);
      return { found: true, repo_id: record.repo_id, project_id: record.project_id, org_id: record.org_id, created: null };
    }
    throw e;
  }
}
