/**
 * gitvault-recovery-custody — the member recovery bundle
 * (`r402s-member-recovery-bundle/v1`), the exported sidecar that makes a
 * source recovery code work with NO run402 server.
 *
 * A human member under wrapper custody holds no keystore: their X25519
 * member scalar exists only as sealed `swrap2_` wrappers in the platform
 * directory. A server-side wrapper row alone is NOT offline backup — this
 * bundle (the key identity + every ACTIVE wrapper ciphertext, exported via
 * `GET /agent/v1/source-access/recovery-bundle` or the console's download
 * button) kept in the member's own storage, together with the source
 * recovery code, is. `r402s-recover` opens the bundle's `recovery_code`
 * wrapper locally (see {@link unwrapMemberRecoveryBundle}) and recovers the
 * same repository a keystore-based recovery would.
 *
 * A raw WebAuthn PRF output is NOT a supported recovery input — PRF
 * evaluation is a live credential ceremony, not portable key material; the
 * supported no-server path for a human is the source recovery code
 * (gitvault-offline-recovery spec, as modified by gitvault-recovery-custody).
 *
 * Mirror sidecar convention: a member who wants their bundle to travel WITH
 * a vault mirror puts it under `member-recovery-bundles/<name>.json` in the
 * mirrored prefix — an explicitly member-initiated, out-of-band versioned
 * sidecar, never an r402s object (recovery/keyless-verify list that prefix
 * as unverified availability hints; nothing ever writes it automatically).
 */
import { LocalError } from "../errors.js";
import {
  buildSourceWrapperContext,
  bytesToHex,
  ekFingerprint,
  fromBase64url,
  normalizeSourceRecoveryCode,
  openSourceWrapper,
} from "../namespaces/gitvault.crypto.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { GitvaultMirrorBackend } from "./gitvault-mirror-backend.js";

function fail(code: string, message: string, context: string, details?: unknown, nextActions?: unknown[]): never {
  throw new LocalError(message, context, { code, details, ...(nextActions ? { next_actions: nextActions } : {}) });
}

export const GITVAULT_MEMBER_BUNDLE_FORMAT = "r402s-member-recovery-bundle/v1" as const;

/** The mirrored-prefix sidecar directory recovery/verify scan for bundles. */
export const GITVAULT_MEMBER_BUNDLE_MIRROR_PREFIX = "member-recovery-bundles/" as const;

/**
 * The seal-time ceremony host every wrapper in existence was sealed under
 * (`location.hostname` of the sealing console page). Used only when neither
 * the bundle nor the caller names one — the swrap2 context binds it, so a
 * wrong value fails closed as `WRAPPER_DID_NOT_OPEN`, never a silent
 * wrong-key open.
 */
export const GITVAULT_DEFAULT_SOURCE_WRAPPER_RP_ID = "console.run402.com" as const;

export interface GitvaultMemberBundleWrapper {
  wrapper_id: string;
  kind: "webauthn_prf" | "recovery_code";
  format_version: string;
  credential_subject: string | null;
  /** The `swrap2_...` blob string itself. */
  wrapper_ciphertext: string;
  blob_sha256: string;
  created_at: string;
}

/** `r402s-member-recovery-bundle/v1` — exactly what the gateway export returns (plus the console download's client-stamped `rp_id`, when present). */
export interface GitvaultMemberRecoveryBundle {
  format: typeof GITVAULT_MEMBER_BUNDLE_FORMAT;
  exported_at?: string;
  principal_id: string;
  encryption_key_id: string;
  ek_fingerprint: string;
  /** Canonical base64url raw 32-byte X25519 member public key. */
  public_key: string;
  suite: string;
  custody_scheme: string;
  wrappers: GitvaultMemberBundleWrapper[];
  /** Seal-time ceremony host, when the exporting surface knew it (the console download stamps `location.hostname`). */
  rp_id?: string;
  note?: string;
}

/** Parse + shape-check a member recovery bundle (a JSON string or an already-parsed value). Typed refusal, never a silent partial. */
export function parseMemberRecoveryBundle(input: unknown, context = "parsing member recovery bundle"): GitvaultMemberRecoveryBundle {
  let value: unknown = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (e) {
      fail("RECOVERY_BUNDLE_INVALID", `not JSON: ${e instanceof Error ? e.message : String(e)}`, context);
    }
  }
  const b = value as Partial<GitvaultMemberRecoveryBundle> | null;
  if (!b || typeof b !== "object") fail("RECOVERY_BUNDLE_INVALID", "bundle is not an object", context);
  if (b.format !== GITVAULT_MEMBER_BUNDLE_FORMAT) {
    fail("RECOVERY_BUNDLE_INVALID", `unsupported bundle format ${JSON.stringify(b.format ?? null)} — expected ${GITVAULT_MEMBER_BUNDLE_FORMAT}`, context, { format: b.format ?? null });
  }
  for (const field of ["principal_id", "encryption_key_id", "ek_fingerprint", "public_key"] as const) {
    if (typeof b[field] !== "string" || b[field].length === 0) fail("RECOVERY_BUNDLE_INVALID", `bundle is missing ${field}`, context, { field });
  }
  if (!Array.isArray(b.wrappers)) fail("RECOVERY_BUNDLE_INVALID", "bundle is missing wrappers[]", context, { field: "wrappers" });
  for (const w of b.wrappers) {
    if (!w || typeof w !== "object" || typeof (w as GitvaultMemberBundleWrapper).wrapper_id !== "string" || typeof (w as GitvaultMemberBundleWrapper).wrapper_ciphertext !== "string") {
      fail("RECOVERY_BUNDLE_INVALID", "bundle wrappers[] entry is malformed (needs wrapper_id + wrapper_ciphertext)", context);
    }
  }
  return b as GitvaultMemberRecoveryBundle;
}

export interface GitvaultMemberUnwrapResult {
  /** X25519 private scalar, lowercase hex — feed straight into the recovery identity. */
  private_key_hex: string;
  /** Raw 32-byte member public key (derived from the scalar and verified against the bundle). */
  public_key: Uint8Array;
  /** `ek_` fingerprint (verified against the bundle). */
  fingerprint: string;
  /** Which wrapper opened. */
  wrapper_id: string;
  /** The rp_id the successful context was built with (explicit > bundle > default). */
  rp_id_used: string;
}

/**
 * Open a member recovery bundle with the source recovery code, offline.
 *
 * Tries every `recovery_code` wrapper in the bundle (the AEAD authenticates,
 * so a wrong open fails closed — nothing is ever trusted un-verified), then
 * proves validity at use: derives the FULL public key from the recovered
 * scalar and compares it byte-for-byte against the bundle's published
 * `public_key` (and the `ek_` fingerprint). `webauthn_prf` wrappers are
 * deliberately not an input here — a raw PRF output is not portable key
 * material.
 */
export function unwrapMemberRecoveryBundle(input: {
  bundle: GitvaultMemberRecoveryBundle;
  source_recovery_code: string;
  /** Seal-time ceremony host override; default = bundle.rp_id, then {@link GITVAULT_DEFAULT_SOURCE_WRAPPER_RP_ID}. */
  rp_id?: string;
}): GitvaultMemberUnwrapResult {
  const context = "opening member recovery bundle";
  const bundle = input.bundle;
  const rpId = input.rp_id ?? bundle.rp_id ?? GITVAULT_DEFAULT_SOURCE_WRAPPER_RP_ID;
  const core = normalizeSourceRecoveryCode(input.source_recovery_code); // throws RECOVERY_CODE_CHECKSUM_INVALID on a local typo
  const ikm = utf8ToBytes(core);
  const publishedPublicKey = fromBase64url(bundle.public_key, "bundle public_key");
  if (publishedPublicKey.length !== 32) fail("RECOVERY_BUNDLE_INVALID", "bundle public_key is not a raw 32-byte X25519 key", context);

  const codeWrappers = bundle.wrappers.filter((w) => w.kind === "recovery_code");
  if (codeWrappers.length === 0) {
    fail(
      "RECOVERY_BUNDLE_MISSING",
      "this bundle carries no recovery_code wrapper — the source recovery code has nothing to open. A raw WebAuthn PRF output is not a supported recovery input; enroll a recovery code at console.run402.com/account and re-export the bundle.",
      context,
      { wrapper_kinds: bundle.wrappers.map((w) => w.kind) },
    );
  }

  let lastError: unknown = null;
  for (const w of codeWrappers) {
    const wrapperContext = buildSourceWrapperContext({
      rp_id: rpId,
      principal_id: bundle.principal_id,
      encryption_key_id: bundle.encryption_key_id,
      wrapper_id: w.wrapper_id,
      kind: "recovery_code",
      credential_subject: null,
      member_public_key: publishedPublicKey,
    });
    let scalar: Uint8Array;
    try {
      scalar = openSourceWrapper({ kind: "recovery_code", ikm, blob: w.wrapper_ciphertext, context: wrapperContext });
    } catch (e) {
      lastError = e;
      continue;
    }
    // Validity is proven at use: FULL public key comparison, never the
    // truncated fingerprint alone (round-1 finding 2).
    const derived = x25519.getPublicKey(scalar);
    if (bytesToHex(derived) !== bytesToHex(publishedPublicKey)) {
      fail("RECOVERY_BUNDLE_INVALID", `wrapper ${w.wrapper_id} opened but its scalar does not derive the bundle's published member public key — the bundle is internally inconsistent`, context, { wrapper_id: w.wrapper_id });
    }
    const fingerprint = ekFingerprint(derived);
    if (fingerprint !== bundle.ek_fingerprint) {
      fail("RECOVERY_BUNDLE_INVALID", `derived fingerprint ${fingerprint} does not match the bundle's ${bundle.ek_fingerprint}`, context, { wrapper_id: w.wrapper_id });
    }
    return { private_key_hex: bytesToHex(scalar), public_key: derived, fingerprint, wrapper_id: w.wrapper_id, rp_id_used: rpId };
  }
  fail(
    "WRAPPER_DID_NOT_OPEN",
    `none of the bundle's ${codeWrappers.length} recovery_code wrapper(s) opened with that code — a wrong/typo'd code (compare against your saved copy), a corrupt bundle, or a different seal-time host (tried rp_id ${JSON.stringify(rpId)}; pass --rp-id if the wrapper was sealed elsewhere).`,
    context,
    { tried_wrapper_ids: codeWrappers.map((w) => w.wrapper_id), rp_id_tried: rpId, cause: lastError instanceof Error ? lastError.message : String(lastError) },
  );
}

/** One mirrored bundle sidecar, reported keylessly — an UNVERIFIED availability hint (nothing about it is authenticated). */
export interface GitvaultMemberBundleHint {
  key: string;
  /** Parsed identity when the sidecar is readable; null when it exists but does not parse as a v1 bundle. */
  ek_fingerprint: string | null;
  principal_id: string | null;
  wrapper_kinds: string[];
  parse_error: string | null;
}

/**
 * List `member-recovery-bundles/*.json` sidecars in a mirrored prefix,
 * best-effort — the keyless-verify "availability hints" and recovery's
 * bundle auto-discovery both read this. Never throws: an unreadable or
 * malformed sidecar is reported with its parse error, not skipped silently.
 */
export async function discoverMemberBundles(backend: GitvaultMirrorBackend): Promise<Array<GitvaultMemberBundleHint & { bundle: GitvaultMemberRecoveryBundle | null }>> {
  let keys: string[];
  try {
    keys = (await backend.list(GITVAULT_MEMBER_BUNDLE_MIRROR_PREFIX)).filter((k) => k.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Array<GitvaultMemberBundleHint & { bundle: GitvaultMemberRecoveryBundle | null }> = [];
  for (const key of keys.sort()) {
    const bytes = await backend.get(key);
    if (!bytes) continue;
    try {
      const bundle = parseMemberRecoveryBundle(new TextDecoder().decode(bytes), `parsing mirrored bundle ${key}`);
      out.push({
        key,
        ek_fingerprint: bundle.ek_fingerprint,
        principal_id: bundle.principal_id,
        wrapper_kinds: [...new Set(bundle.wrappers.map((w) => w.kind))].sort(),
        parse_error: null,
        bundle,
      });
    } catch (e) {
      out.push({ key, ek_fingerprint: null, principal_id: null, wrapper_kinds: [], parse_error: e instanceof Error ? e.message : String(e), bundle: null });
    }
  }
  return out;
}
