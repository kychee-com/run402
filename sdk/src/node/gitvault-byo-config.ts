/**
 * gitvault-byo-primary-bucket — local per-vault BYO credential config
 * (design D2, task 3.1/3.2). Parallels `gitvault-mirror-config.ts` exactly,
 * on purpose: same file shape, same "beside the keystore, never in
 * `run402.config.json`, never a raw secret value" reasoning.
 *
 * A BYO vault's `storage_profile`/`byo_destination` are recorded on the
 * GATEWAY's vault record (the destination ADDRESS only — see
 * `gitvault-creation-journal.ts`'s allocation request). This file carries
 * the ONE thing that must stay purely local, per D2: the credential NAME
 * (an AWS profile, or the ambient environment chain) that resolves to the
 * customer bucket's actual secret at USE time — resolved by
 * `gitvault-mirror-backend.ts`, never read or cached here, never
 * transmitted to run402 in any request. The destination's `region`/
 * `endpoint` are ALSO local-only (the server-side address string carries
 * neither), so this config persists the full `GitvaultMirrorDestination`,
 * not just the credential.
 *
 * Written once by `repos create --byo` (or, for a fresh machine re-linking
 * to an already-BYO vault, `Gitvault.byoConfigSet`), keyed by `repo_id` —
 * `repo_id` only exists AFTER allocation, so this file's existence for a
 * given repo is itself the local "this machine can write this vault's
 * payload objects directly" fact `gitvault-mirror.ts`'s dual-push hook and
 * `gitvault-degraded-read.ts`'s fallback resolution both gate on.
 */
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { LocalError } from "../errors.js";
import { GITVAULT_SRC_RE } from "../namespaces/gitvault.crypto.js";
import { GitvaultKeystore, readFileNoFollow, writeFileAtomic0600 } from "./gitvault-keystore.js";
import type { GitvaultMirrorCredential, GitvaultMirrorDestination } from "./gitvault-mirror-config.js";

function fail(code: string, message: string, context: string, details?: unknown, nextActions?: unknown[]): never {
  throw new LocalError(message, context, { code, details, ...(nextActions ? { next_actions: nextActions } : {}) });
}

/** `byo/<repo_id>.json` — where THIS machine writes a BYO vault's payload objects, and which credential NAME resolves it at use time. */
export interface GitvaultByoConfig {
  version: 1;
  repo_id: string;
  destination: GitvaultMirrorDestination;
  /** Present only for an `s3` destination — a directory destination needs no credential. */
  credential?: GitvaultMirrorCredential;
  created_at: string;
  updated_at: string;
}

export function byoConfigDir(keystore: GitvaultKeystore): string {
  return join(keystore.rootDir, "byo");
}

export function byoConfigPath(keystore: GitvaultKeystore, repoId: string): string {
  if (!GITVAULT_SRC_RE.test(repoId)) fail("GITVAULT_BAD_REPO_ID", `not a src_ id: ${repoId}`, "resolving gitvault byo config path");
  return join(byoConfigDir(keystore), `${repoId}.json`);
}

/** Read the local BYO write-credential config for one vault, or `null` when none is configured on this machine. */
export function readByoConfig(keystore: GitvaultKeystore, repoId: string): GitvaultByoConfig | null {
  const text = readFileNoFollow(byoConfigPath(keystore, repoId));
  if (!text) return null;
  let parsed: GitvaultByoConfig;
  try {
    parsed = JSON.parse(text) as GitvaultByoConfig;
  } catch (e) {
    fail("GITVAULT_BYO_CONFIG_CORRUPT", `byo config for ${repoId} is not valid JSON: ${(e as Error).message}`, "reading gitvault byo config", { repo_id: repoId });
  }
  if (parsed.version !== 1 || parsed.repo_id !== repoId || !parsed.destination) {
    fail("GITVAULT_BYO_CONFIG_CORRUPT", `byo config for ${repoId} is not a version-1 gitvault byo config`, "reading gitvault byo config", { repo_id: repoId });
  }
  return parsed;
}

/** Every repo id with a local BYO write config on this machine. */
export function listByoConfiguredRepoIds(keystore: GitvaultKeystore): string[] {
  const dir = byoConfigDir(keystore);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -5))
    .filter((id) => GITVAULT_SRC_RE.test(id))
    .sort();
}

/** Set (create or replace) the local BYO write-credential config for one vault. */
export function saveByoConfig(
  keystore: GitvaultKeystore,
  input: { repo_id: string; destination: GitvaultMirrorDestination; credential?: GitvaultMirrorCredential },
  now: () => Date = () => new Date(),
): GitvaultByoConfig {
  if (input.destination.kind === "s3" && !input.credential) {
    fail("GITVAULT_MIRROR_CREDENTIAL_REQUIRED", "an s3 byo destination needs a credential — pass --profile <name> or --ambient", "configuring gitvault byo credential");
  }
  const existing = readByoConfig(keystore, input.repo_id);
  const full: GitvaultByoConfig = {
    version: 1,
    repo_id: input.repo_id,
    destination: input.destination,
    ...(input.credential ? { credential: input.credential } : {}),
    created_at: existing?.created_at ?? now().toISOString(),
    updated_at: now().toISOString(),
  };
  writeFileAtomic0600(byoConfigPath(keystore, input.repo_id), JSON.stringify(full, null, 2));
  return full;
}

/** Remove the local BYO write-credential config for one vault. Never touches the customer bucket's own bytes — this only stops THIS machine from writing/reading it as the vault's primary destination. */
export function removeByoConfig(keystore: GitvaultKeystore, repoId: string): { removed: boolean } {
  const path = byoConfigPath(keystore, repoId);
  if (!existsSync(path)) return { removed: false };
  try {
    unlinkSync(path);
  } catch (e) {
    fail("GITVAULT_BYO_CONFIG_REMOVE_FAILED", `could not remove byo config for ${repoId}: ${(e as Error).message}`, "removing gitvault byo config", { repo_id: repoId });
  }
  return { removed: true };
}
