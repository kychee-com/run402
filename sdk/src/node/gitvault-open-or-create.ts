/**
 * gitvault D2 — lazy allocation on first push (repo-first-onramp task 2.2).
 *
 * The orchestration `Gitvault.openOrCreate` (the namespace method the remote
 * helper and the capture lane drive) delegates to: resolve `repo_id` from
 * `project_id` via the SAME transport method `forProject` uses
 * (`findVaultByProject`, already on {@link GitvaultTransport} — no second
 * transport shape, no HTTP wire duplicated), and when that resolution fails
 * AND an owning `org_id` was supplied, run the six-stage creation journal
 * ({@link createGitvault}) to allocate it.
 *
 * Pulled out of the namespace class so it can be exercised directly against
 * `GitvaultMemoryTransport` (the fixture every other creation/deploy test
 * already uses) instead of hand-rolling an HTTP-level mock of the entire
 * six-stage protocol a second time.
 */

import { createGitvault, findResumableGitvaultJournal, type GitvaultCreationResult } from "./gitvault-creation-journal.js";
import type { GitvaultKeystore } from "./gitvault-keystore.js";
import type { GitvaultTransport } from "./gitvault-publication.js";

export interface OpenOrCreateGitvaultOptions {
  keystore: GitvaultKeystore;
  transport: GitvaultTransport;
  project_id: string;
  /** The owning org — required only when the vault turns out to be unallocated. */
  org_id?: string;
  /** Resume a specific creation attempt (or pin it in tests); auto-discovered from the local keystore otherwise. */
  client_creation_id?: string;
  service_public_key?: Uint8Array | string;
}

export type OpenOrCreateGitvaultResult =
  | { found: true; repo_id: string; created: null }
  | {
      found: false;
      repo_id: string;
      created: {
        /** Mirrors `GitvaultCreationResult.how === "reconciled"`: a local journal was resumed to completion, nothing re-minted. */
        deduplicated: boolean;
        recovery_receipt: GitvaultCreationResult["recovery_receipt"];
        genesis_sha256: string;
      };
    };

/**
 * Resolve a project's vault, allocating it when it does not exist yet.
 *
 * Without `org_id` this is byte-identical to a plain resolve: the resolution
 * failure (whatever `findVaultByProject` threw) is rethrown unchanged, so a
 * caller with no reason to create anything sees no behavior change at all.
 *
 * RESUMABILITY: before starting a fresh attempt, looks for an INCOMPLETE
 * local journal already matching this exact `(org_id, project_id)` and
 * resumes ITS `client_creation_id` rather than starting a second competing
 * one. Interrupt a creation mid-flight, call this again: the same journal —
 * never a new one — drives to ACTIVE, and exactly one vault exists either
 * way. An explicit `client_creation_id` always wins over that search.
 */
export async function openOrCreateGitvault(options: OpenOrCreateGitvaultOptions): Promise<OpenOrCreateGitvaultResult> {
  let unresolved: unknown = null;
  try {
    const record = await options.transport.findVaultByProject({ project_id: options.project_id });
    return { found: true, repo_id: record.repo_id, created: null };
  } catch (e) {
    unresolved = e;
  }
  if (!options.org_id) throw unresolved;

  const resumable = options.client_creation_id ? null : findResumableGitvaultJournal(options.keystore, options.org_id, options.project_id);
  const created = await createGitvault({
    keystore: options.keystore,
    transport: options.transport,
    org_id: options.org_id,
    project_id: options.project_id,
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
    created: { deduplicated: created.how === "reconciled", recovery_receipt: created.recovery_receipt, genesis_sha256: created.genesis_sha256 },
  };
}
