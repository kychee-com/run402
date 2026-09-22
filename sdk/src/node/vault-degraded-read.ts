/**
 * vault-byo-primary-bucket — degraded read mode (design D4, task 3.4,
 * MIRROR HALF ONLY). Turns a gateway chain/payload read that fails with a
 * NETWORK-CLASS error into a transparent fallback served from the vault's
 * client-side mirror, so `git fetch`/`clone` keep working while run402 is
 * down.
 *
 * This is deliberately NOT a second implementation of anything: the fallback
 * reuses `r402s-recover` (`vault-recover.ts`'s `recoverVaultMirror`)
 * verbatim — the SAME chain-verification, absence adjudication, and
 * decrypt/materialize machinery `run402 repos recover` already ships. The
 * module doc there says it plainly: "recovery is the keyed offline subset
 * of machinery that already exists." This file's own job is narrow —
 * trigger discipline (network-class only, never 4xx), a bounded retry
 * against the gateway first, and resolving WHICH client-side destination to
 * fall back to — never a second chain-verifier and never a second S3/backend
 * reader.
 *
 * Local trust: this module never touches the LIVE vault's own keystore pins
 * (`head_pin` / `verified_prefix` / `materialized_pin`, written by
 * `Vault.verifyToNewest`/`materialize` against the live transport) —
 * a degraded read runs an entirely separate engine (`recoverVaultMirror`,
 * which only ever calls `keystore.readIdentity`/`readRecoveryReceipt`, never
 * `keystore.updateRepo`) against a `VaultMirrorBackend`. So "local trust
 * pins advance only as far as the copy chain-verifies" holds by
 * construction: there is no code path here that could advance a live pin
 * past what the mirror copy itself proved.
 *
 * WRITES ARE NEVER REROUTED. This module exports only READ machinery; the
 * caller's own push/admission path is untouched — see the client-surface
 * doc's own D194 citation ("admission is irreducibly live-server").
 */
import { isRun402Error } from "../errors.js";
import { VAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT } from "../namespaces/vault.crypto.js";
import type { VaultHeadTarget } from "../namespaces/vault.types.js";
import { readByoConfig } from "./vault-byo-config.js";
import type { VaultKeystore } from "./vault-keystore.js";
import { formatMirrorDestination, readMirrorConfig } from "./vault-mirror-config.js";
import { openVaultMirrorBackend, type VaultMirrorBackend } from "./vault-mirror-backend.js";
import { recoverVaultMirror } from "./vault-recover.js";
import type { VaultRetainedRefsReconcileResult } from "./vault-publication.js";

/**
 * Trigger discipline (design D4): a chain/payload read falls back ONLY on a
 * genuinely network-class failure — the underlying `fetch` threw before a
 * response existed, or the gateway answered with a 5xx. An authorization
 * refusal (401/403/404, or any other 4xx) must NEVER silently reroute to the
 * mirror, so it is excluded even when it happens to arrive with no `.status`
 * (see below).
 *
 * Two wrinkles in how a vault read actually fails, both handled here:
 *
 * 1. Most vault byte reads (`getGenerationBytes`/`getObjectBytes` in
 *    `vault-publication.ts`, and this file's own mirror backend) call the
 *    injected `fetch` DIRECTLY rather than the kernel's typed
 *    `client.request()` — a raw connection/DNS failure therefore propagates
 *    UNBRANDED (a plain `TypeError`, never a `Run402Error`). That is, in
 *    practice, the primary shape a real "run402 is unreachable" outage
 *    takes, so an unbranded throw is treated as network-class.
 * 2. When those SAME call sites DO get a response but it is not `ok`, they
 *    throw via `vault-publication.ts`'s own local `fail()` helper — a
 *    `LocalError` whose real HTTP status rides in `details.status`, never on
 *    `e.status` itself (`LocalError` always passes `status: null` to the
 *    `Run402Error` constructor). This function reads BOTH places so a 5xx
 *    reaching through either path is classified alike, and a 4xx through
 *    either path is excluded alike.
 */
export function isNetworkClassVaultReadError(e: unknown): boolean {
  if (!isRun402Error(e)) return true;
  if (e.kind === "network_error") return true;
  // The payment-capable client (paid-fetch) reports a request that failed
  // BEFORE any response existed as X402_INITIAL_REQUEST_FAILED — the same
  // connection/DNS failure an unbranded TypeError carries, wrapped. No
  // response, no status: network-class.
  if (e.kind === "payment_attempt_error" && (e as { code?: string }).code === "X402_INITIAL_REQUEST_FAILED" && e.toJSON().category === "network") return true;
  const status = vaultReadErrorStatus(e);
  return typeof status === "number" && status >= 500;
}

function vaultReadErrorStatus(e: { status: number | null; details?: unknown }): number | null {
  if (typeof e.status === "number") return e.status;
  const details = e.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const s = (details as Record<string, unknown>).status;
    if (typeof s === "number") return s;
  }
  return null;
}

/** `s3://bucket/prefix` or a directory path — never a credential, same redaction `mirrorStatus` already prints. */
export interface VaultDegradedReadSource {
  /** `"byo"` when this vault's own primary destination served the fallback (vault-byo-primary-bucket task 3.4); `"mirror"` for the opt-in customer mirror — see {@link resolveDegradedReadSource}'s precedence. */
  kind: "mirror" | "byo";
  destination: string;
  credential_kind: "profile" | "ambient" | null;
}

/** One degraded chain/payload read, served from {@link VaultDegradedReadSource} via `r402s-recover`. */
export interface VaultDegradedReadResult {
  degraded: true;
  source: VaultDegradedReadSource;
  refs: Record<string, string>;
  head_target: VaultHeadTarget;
  generation: string;
  retained_refs: VaultRetainedRefsReconcileResult;
  validity_not_freshness: typeof VAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT;
}

interface ResolvedDegradedReadSource extends VaultDegradedReadSource {
  backend: VaultMirrorBackend;
}

/**
 * The small seam design D4 calls out: which client-side destination a
 * degraded read should serve from, for one vault.
 *
 * Precedence (vault-byo-primary-bucket task 3.4): the opt-in customer
 * MIRROR wins when BOTH a mirror and a BYO write config are configured
 * locally on THIS machine. A BYO vault's own primary destination is
 * ALWAYS a complete `r402s-recover` source on its own (task 3.3's whole
 * point), so this is not a completeness question — it keeps the
 * PRE-EXISTING, already-shipped mirror substrate's behavior byte-identical
 * (a machine that already has a working mirror configured for degraded
 * reads keeps using it) rather than silently switching sources the moment
 * a BYO local config also exists. The BYO branch is the fallback: read
 * ONLY when no mirror is configured — no network call either way, purely
 * local file reads, matching this function's own "never touches the
 * network" contract.
 */
export function resolveDegradedReadSource(keystore: VaultKeystore, repoId: string): ResolvedDegradedReadSource | null {
  const config = readMirrorConfig(keystore, repoId);
  if (config) {
    const backend = openVaultMirrorBackend(config.destination, repoId, config.credential);
    return { kind: "mirror", backend, destination: formatMirrorDestination(config.destination), credential_kind: config.credential?.kind ?? null };
  }
  const byo = readByoConfig(keystore, repoId);
  if (!byo) return null;
  const backend = openVaultMirrorBackend(byo.destination, repoId, byo.credential);
  return { kind: "byo", backend, destination: formatMirrorDestination(byo.destination), credential_kind: byo.credential?.kind ?? null };
}

export interface VaultDegradedReadLive {
  refs: Record<string, string>;
  head_target: VaultHeadTarget;
  generation: string;
}

export interface TryVaultDegradedReadOptions<T extends VaultDegradedReadLive> {
  /** The caller's own live gateway call (e.g. `vault.materialize()` or `vault.restoreObjectsInto(dir)`) — this module has no opinion on which. */
  attemptLive: () => Promise<T>;
  keystore: VaultKeystore;
  repo_id: string;
  /**
   * Where a degraded materialization writes objects (`recoverVaultMirror`'s
   * own `out_dir` — a bare-shaped, git-proven repository, e.g. the resolved
   * `GIT_DIR` from `resolveGitInvocationRepo`; never guessed from `cwd`).
   * `null` disables the fallback entirely — a repo-free read (a bare
   * `git ls-remote` outside any checkout) has nowhere to materialize into,
   * so it surfaces the original gateway error exactly as it always did.
   */
  out_dir: string | null;
  /** Test/advanced hook: an already-opened backend, bypassing {@link resolveDegradedReadSource}'s config resolution — mirrors `VaultMirrorSyncOptions`'s own `backend` override. */
  backend?: VaultMirrorBackend;
}

export type VaultDegradedReadOutcome<T extends VaultDegradedReadLive> =
  | { degraded: false; live: T }
  | { degraded: true; result: VaultDegradedReadResult };

/**
 * Attempt `options.attemptLive`, with ONE bounded retry on a network-class
 * failure (so a transient blip does not flap between sources — design D4).
 * A non-network-class failure (an authorization refusal, or any other 4xx;
 * a protocol/chain error with no status signal at all) is NEVER retried and
 * NEVER falls back — it rethrows the ORIGINAL error UNCHANGED, exactly as a
 * non-degraded caller would see it.
 *
 * After the retry budget is exhausted on a genuinely network-class failure:
 * with no fallback source configured (or `out_dir: null`), the ORIGINAL
 * error is rethrown UNCHANGED — never wrapped, never re-typed, so its
 * `code`/`status`/`kind` survive for the caller exactly as they would
 * without this wrapper. Only the caller's own stderr hint may change.
 * With a fallback source, this degrades via the SHIPPED `r402s-recover`
 * engine (`recoverVaultMirror`) against it, returning
 * `{ degraded: true, result }` — a genuine recovery failure (an incomplete
 * or unreadable mirror) propagates from THAT call as its own honest error,
 * never silently swallowed back into the original gateway failure.
 */
export async function tryVaultDegradedRead<T extends VaultDegradedReadLive>(
  options: TryVaultDegradedReadOptions<T>,
): Promise<VaultDegradedReadOutcome<T>> {
  let lastErr: unknown;
  const RETRY_ATTEMPTS = 2; // the live attempt, plus one bounded retry
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return { degraded: false, live: await options.attemptLive() };
    } catch (e) {
      if (!isNetworkClassVaultReadError(e)) throw e;
      lastErr = e;
    }
  }
  if (!options.out_dir) throw lastErr;
  const source: ResolvedDegradedReadSource | null = options.backend
    ? { kind: "mirror", backend: options.backend, destination: options.backend.describe(), credential_kind: null }
    : resolveDegradedReadSource(options.keystore, options.repo_id);
  if (!source) throw lastErr;

  const recovered = await recoverVaultMirror({ backend: source.backend, out_dir: options.out_dir, keystore: options.keystore });
  return {
    degraded: true,
    result: {
      degraded: true,
      source: { kind: source.kind, destination: source.destination, credential_kind: source.credential_kind },
      refs: recovered.refs,
      head_target: recovered.head_target,
      generation: recovered.recovered_generation,
      retained_refs: recovered.retained_refs,
      validity_not_freshness: recovered.validity_not_freshness,
    },
  };
}

