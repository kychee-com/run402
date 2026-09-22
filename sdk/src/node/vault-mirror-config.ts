/**
 * vault-mirror-and-recover — mirror destination config (design D1/D2,
 * task 2.1).
 *
 * Per-vault mirror configuration lives BESIDE the keystore, in its own
 * sibling directory (`<keystore root>/mirrors/<repo_id>.json`) — never in
 * `run402.config.json` (that file is committed to the repository, and a
 * mirror destination is a per-machine operational fact, not something to
 * share with every clone) and never containing a raw secret value. The
 * credential field names an AWS profile OR selects the ambient environment
 * chain (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`) —
 * resolved at USE time by {@link ../node/vault-mirror-backend.js}, never
 * read or cached here. D1 is the reason this file exists at all: run402
 * never holds a credential to the customer's bucket, so the credential must
 * live somewhere run402 code never uploads or transmits — this config file,
 * read only by the client's own machine.
 */
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { LocalError } from "../errors.js";
import { VAULT_SRC_RE } from "../namespaces/vault.crypto.js";
import { VaultKeystore, readFileNoFollow, writeFileAtomic0600 } from "./vault-keystore.js";

function fail(code: string, message: string, context: string, details?: unknown, nextActions?: unknown[]): never {
  throw new LocalError(message, context, { code, details, ...(nextActions ? { next_actions: nextActions } : {}) });
}

/** Where the mirror writes objects. Directory is a plain local (or network-mounted) path; S3 is `s3://<bucket>/<prefix>`. */
export type VaultMirrorDestination =
  | { kind: "directory"; path: string }
  | { kind: "s3"; bucket: string; prefix: string; region: string; endpoint?: string };

/** How the S3 destination authenticates. Never a raw key — see the module doc. */
export type VaultMirrorCredential =
  | { kind: "profile"; profile: string }
  | { kind: "ambient" };

/** `mirrors/<repo_id>.json` — the ONLY thing this file persists: where, which named credential to resolve at use time, and (vault-mirror-default) when a write/sync last fully succeeded. */
export interface VaultMirrorConfig {
  version: 1;
  repo_id: string;
  destination: VaultMirrorDestination;
  /** Present only for an `s3` destination — a directory destination needs no credential. */
  credential?: VaultMirrorCredential;
  /**
   * vault-mirror-default: when a mirror write or sync last completed with
   * zero failures against THIS destination — the local fact that clears the
   * `vault_unmirrored` finding. Stamped by the sync engine, reset when the
   * destination changes (a success against the old bucket says nothing about
   * the new one), and never transmitted anywhere (the gateway stays blind).
   */
  last_success_at?: string;
  created_at: string;
  updated_at: string;
}

export function mirrorsDir(keystore: VaultKeystore): string {
  return join(keystore.rootDir, "mirrors");
}

export function mirrorConfigPath(keystore: VaultKeystore, repoId: string): string {
  if (!VAULT_SRC_RE.test(repoId)) fail("VAULT_BAD_REPO_ID", `not a src_ id: ${repoId}`, "resolving vault mirror config path");
  return join(mirrorsDir(keystore), `${repoId}.json`);
}

/** Read the mirror config for one vault, or `null` when none is configured. */
export function readMirrorConfig(keystore: VaultKeystore, repoId: string): VaultMirrorConfig | null {
  const text = readFileNoFollow(mirrorConfigPath(keystore, repoId));
  if (!text) return null;
  let parsed: VaultMirrorConfig;
  try {
    parsed = JSON.parse(text) as VaultMirrorConfig;
  } catch (e) {
    fail("VAULT_MIRROR_CONFIG_CORRUPT", `mirror config for ${repoId} is not valid JSON: ${(e as Error).message}`, "reading vault mirror config", { repo_id: repoId });
  }
  if (parsed.version !== 1 || parsed.repo_id !== repoId || !parsed.destination) {
    fail("VAULT_MIRROR_CONFIG_CORRUPT", `mirror config for ${repoId} is not a version-1 vault mirror config`, "reading vault mirror config", { repo_id: repoId });
  }
  return parsed;
}

/** Every repo id with a mirror configured on this machine. */
export function listMirroredRepoIds(keystore: VaultKeystore): string[] {
  const dir = mirrorsDir(keystore);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -5))
    .filter((id) => VAULT_SRC_RE.test(id))
    .sort();
}

/** Set (create or replace) the mirror destination for one vault. */
export function saveMirrorConfig(keystore: VaultKeystore, input: { repo_id: string; destination: VaultMirrorDestination; credential?: VaultMirrorCredential }, now: () => Date = () => new Date()): VaultMirrorConfig {
  if (input.destination.kind === "s3" && !input.credential) {
    fail("VAULT_MIRROR_CREDENTIAL_REQUIRED", "an s3 mirror destination needs a credential — pass --profile <name> or --ambient", "configuring vault mirror");
  }
  const existing = readMirrorConfig(keystore, input.repo_id);
  // A recorded success is a fact about ONE destination: carry it across an
  // idempotent re-save of the same place, reset it when the destination moves
  // (the vault_unmirrored finding honestly reopens until the new mirror's
  // first successful write/sync).
  const sameDestination = existing != null && JSON.stringify(existing.destination) === JSON.stringify(input.destination);
  const full: VaultMirrorConfig = {
    version: 1,
    repo_id: input.repo_id,
    destination: input.destination,
    ...(input.credential ? { credential: input.credential } : {}),
    ...(sameDestination && existing.last_success_at ? { last_success_at: existing.last_success_at } : {}),
    created_at: existing?.created_at ?? now().toISOString(),
    updated_at: now().toISOString(),
  };
  writeFileAtomic0600(mirrorConfigPath(keystore, input.repo_id), JSON.stringify(full, null, 2));
  return full;
}

/**
 * Stamp `last_success_at` after a zero-failure mirror write/sync
 * (vault-mirror-default) — the local, never-transmitted fact that clears
 * the `vault_unmirrored` finding. A no-op when no config exists (a
 * test-injected backend can sync without one), or when the config was removed
 * mid-sync.
 */
export function recordMirrorSuccess(keystore: VaultKeystore, repoId: string, now: () => Date = () => new Date()): VaultMirrorConfig | null {
  const existing = readMirrorConfig(keystore, repoId);
  if (!existing) return null;
  const full: VaultMirrorConfig = { ...existing, last_success_at: now().toISOString() };
  writeFileAtomic0600(mirrorConfigPath(keystore, repoId), JSON.stringify(full, null, 2));
  return full;
}

/** Remove the mirror config for one vault. Never touches the mirror's own bytes — this only stops future pushes/syncs from targeting it. */
export function removeMirrorConfig(keystore: VaultKeystore, repoId: string): { removed: boolean } {
  const path = mirrorConfigPath(keystore, repoId);
  if (!existsSync(path)) return { removed: false };
  try {
    unlinkSync(path);
  } catch (e) {
    fail("VAULT_MIRROR_CONFIG_REMOVE_FAILED", `could not remove mirror config for ${repoId}: ${(e as Error).message}`, "removing vault mirror config", { repo_id: repoId });
  }
  return { removed: true };
}

/** Parse `s3://<bucket>/<prefix>` or a plain filesystem path into a {@link VaultMirrorDestination}. */
export function parseMirrorDestinationUrl(url: string, options: { region?: string; endpoint?: string } = {}): VaultMirrorDestination {
  if (url.startsWith("s3://")) {
    const rest = url.slice("s3://".length);
    const slash = rest.indexOf("/");
    const bucket = slash === -1 ? rest : rest.slice(0, slash);
    const prefix = slash === -1 ? "" : rest.slice(slash + 1).replace(/\/+$/, "");
    if (!bucket) fail("VAULT_MIRROR_DESTINATION_INVALID", `${url} names no bucket`, "parsing vault mirror destination", { url });
    const region = options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region) fail("VAULT_MIRROR_REGION_REQUIRED", `an s3 destination needs a region — pass --region or set AWS_REGION`, "parsing vault mirror destination", { url });
    return { kind: "s3", bucket, prefix, region, ...(options.endpoint ? { endpoint: options.endpoint } : {}) };
  }
  return { kind: "directory", path: url };
}

/** Render a destination back to the address form a human typed (for `status`/errors). */
export function formatMirrorDestination(destination: VaultMirrorDestination): string {
  return destination.kind === "s3" ? `s3://${destination.bucket}/${destination.prefix}` : destination.path;
}
