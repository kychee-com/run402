/**
 * Safe-echo policy for values that failed local (client-side) validation.
 *
 * A value rejected by a format/existence check is a value we know nothing
 * about — the CLI has only established what it is NOT. The likeliest
 * failure is an ordinary typo, but the second likeliest, demonstrated in
 * practice, is a credential pasted into the wrong slot: a Base-mainnet
 * private key holding real funds lands in `RUN402_WALLET` (which takes a
 * wallet NAME, not a key), fails the name check, and is printed verbatim to
 * a terminal, a log, and a session transcript.
 *
 * `describeRejectedValue` is the one place that decides what a rejected
 * value is safe to show, so every call site — wallet names, org ids, room
 * keys, unknown commands/subcommands, "not found" lookups — gets the same
 * answer instead of each reinventing (or forgetting) the judgment call.
 *
 * Short, low-entropy values (ordinary typos) are returned unchanged — that
 * is what makes the resulting error message useful. Long or
 * high-entropy-looking values are replaced with a shape-only description
 * (character count only), never a substring or prefix of the original:
 * even a short prefix of a private key is more than a debugging aid needs
 * and more than a leak should give up.
 *
 * This is a heuristic, not a content-aware secret scanner: treat "returned
 * unchanged" as "short and plain enough to be a typo," not as proof the
 * value holds no secret. Callers with a value that is never supposed to be
 * secret-shaped in the first place (a service key, an admin key) should
 * still never echo it at all, redacted or not — this helper is for slots
 * that normally hold a plain identifier and occasionally, by mistake,
 * don't.
 */

// Real hand-typed identifiers (wallet names, room keys, command names) top
// out well under this, and it comfortably clears a UUID (36 chars — the
// canonical shape of an org id, and *itself* a public, harmless-to-echo
// identifier even when it's the "wrong" one in a conflict, not a secret).
// Secrets that land in the wrong slot (private keys, API tokens, JWTs) are
// almost always well past it — a private key runs 64-66 characters.
const MAX_SAFE_ECHO_LENGTH = 40;

// A contiguous hex run (with or without a `0x` prefix) reads as key
// material or a hash rather than a human-typed identifier, even when short
// enough to pass the length check above.
const HEX_RUN_RE = /^(0x)?[0-9a-fA-F]{16,}$/;

function looksSecretShaped(str: string): boolean {
  return str.length > MAX_SAFE_ECHO_LENGTH || HEX_RUN_RE.test(str);
}

/**
 * Return `value` unchanged when it is short and plain enough to be a
 * harmless typo; otherwise return a shape-only placeholder (character count
 * only — never a substring) that is still safe to embed in a message or a
 * structured `details` field.
 *
 * Never throws. Coerces non-string input the same way template-literal
 * interpolation would, so a caller can pass whatever it already has without
 * a separate type check.
 */
export function describeRejectedValue(value: unknown): string {
  const str = typeof value === "string" ? value : String(value ?? "");
  if (looksSecretShaped(str)) {
    return `${str.length} chars, not shown — too long or hex-shaped to be a typo (may be a credential that landed in the wrong place)`;
  }
  return str;
}
