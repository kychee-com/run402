import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, statSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getConfigBaseDir } from "./config.js";

/**
 * A cached operator session — the *human* (email) principal, distinct from the
 * agent's per-wallet SIWX identity. Minted in the browser via the device-
 * authorization flow (`run402 operator login`) and cached at the BASE config
 * dir (not per-wallet) because it is email-scoped: one login spans every local
 * named wallet that the email controls.
 *
 * Stored shape vs the gateway token payload: the gateway returns a relative
 * `expires_in` (seconds); we persist the absolute `expires_at` (epoch ms,
 * computed at write time) so a cached session can be checked for expiry without
 * knowing when it was written. `absolute_expires_at` (the gateway's ~12h hard
 * cap) is stored verbatim, for display and a defensive secondary expiry check.
 */
export interface OperatorSession {
  operator_session_token: string;
  token_type: string;
  email: string;
  wallets: string[];
  /** Epoch ms when the access token expires (issued_at + expires_in). */
  expires_at: number;
  /** ISO 8601 absolute cap from the gateway; the session cannot outlive it. */
  absolute_expires_at: string;
}

/**
 * The token payload returned by the device/token poll (and the underlying
 * email/passkey mints). Relative `expires_in`; mapped to an absolute
 * `expires_at` by {@link operatorSessionFromTokenResponse} before caching.
 */
export interface OperatorSessionTokenResponse {
  operator_session_token: string;
  token_type?: string;
  expires_in?: number;
  absolute_expires_at?: string;
  email?: string;
  wallets?: string[];
}

/**
 * Path to the cached operator session: `{base}/operator-session.json`, at the
 * BASE config dir — NOT the per-profile dir, because the session is email-
 * scoped and shared across all local named wallets. `RUN402_OPERATOR_SESSION_PATH`
 * overrides for testing, mirroring `RUN402_ALLOWANCE_PATH`.
 */
export function getOperatorSessionPath(): string {
  return process.env.RUN402_OPERATOR_SESSION_PATH || join(getConfigBaseDir(), "operator-session.json");
}

/**
 * If the session file is readable by group or other (any low 0o077 bit set),
 * tighten it to 0600 and warn once on stderr — the bearer token is as sensitive
 * as the allowance private key. Best-effort: POSIX-only, silent elsewhere.
 * Mirrors the self-heal in `allowance.ts`.
 */
function selfHealPermissions(p: string): void {
  if (process.platform === "win32") return;
  try {
    const mode = statSync(p).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      chmodSync(p, 0o600);
      process.stderr.write(
        `warning: tightened permissions on ${p} from ${mode.toString(8)} to 600 (was readable by other users).\n`,
      );
    }
  } catch {
    // Best-effort; never block a read on a chmod/stat failure.
  }
}

/**
 * Load the cached operator session from disk.
 *
 * Returns `null` for the "no session cached" cases (file absent, unreadable, or
 * unparseable JSON) — callers treat that as "not logged in" and point at
 * `run402 operator login`. Throws a structured `Error` when the file parses as
 * JSON but the shape is wrong, so a corrupted cache surfaces a clear fix-it
 * instead of a downstream `TypeError`.
 */
export function readOperatorSession(path?: string): OperatorSession | null {
  const p = path ?? getOperatorSessionPath();
  if (!existsSync(p)) return null;
  selfHealPermissions(p);
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable input reads as "no session" rather than an error — consumers
    // already handle null with a friendly "run 'run402 operator login'".
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `operator-session.json must contain a JSON object (got ${
        Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed
      }). Delete the file and run 'run402 operator login' to recreate it.`,
    );
  }
  const data = parsed as Partial<OperatorSession>;
  if (typeof data.operator_session_token !== "string" || data.operator_session_token.length === 0) {
    throw new Error(
      "operator-session.json missing valid 'operator_session_token'. Run 'run402 operator login' to refresh it.",
    );
  }
  if (typeof data.email !== "string" || data.email.length === 0) {
    throw new Error(
      "operator-session.json missing valid 'email'. Run 'run402 operator login' to refresh it.",
    );
  }
  if (typeof data.expires_at !== "number" || !Number.isFinite(data.expires_at)) {
    throw new Error(
      "operator-session.json missing valid 'expires_at'. Run 'run402 operator login' to refresh it.",
    );
  }
  if (!Array.isArray(data.wallets) || data.wallets.some((w) => typeof w !== "string")) {
    throw new Error(
      "operator-session.json has an invalid 'wallets' list. Run 'run402 operator login' to refresh it.",
    );
  }
  return {
    operator_session_token: data.operator_session_token,
    token_type: typeof data.token_type === "string" ? data.token_type : "Bearer",
    email: data.email,
    wallets: data.wallets as string[],
    expires_at: data.expires_at,
    absolute_expires_at: typeof data.absolute_expires_at === "string" ? data.absolute_expires_at : "",
  };
}

/** Persist an operator session atomically (temp-file + rename), mode 0600. */
export function saveOperatorSession(data: OperatorSession, path?: string): void {
  const p = path ?? getOperatorSessionPath();
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.operator-session.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}

/**
 * Delete the cached operator session — the local half of `operator logout`.
 * Best-effort and idempotent: a missing file is a no-op.
 */
export function clearOperatorSession(path?: string): void {
  const p = path ?? getOperatorSessionPath();
  try {
    rmSync(p, { force: true });
  } catch {
    // Best-effort: a failed unlink should never crash logout.
  }
}

/**
 * Whether a cached session is past its usable life. The access token
 * (`expires_at`, ~30m) always expires before the absolute cap (~12h), so
 * checking it is sufficient; the absolute cap is honored defensively. A small
 * skew buffer treats a session expiring within `skewMs` as already expired, so
 * we never send a token that dies mid-flight.
 */
export function isOperatorSessionExpired(
  session: OperatorSession,
  nowMs: number = Date.now(),
  skewMs = 10_000,
): boolean {
  if (nowMs + skewMs >= session.expires_at) return true;
  if (session.absolute_expires_at) {
    const cap = Date.parse(session.absolute_expires_at);
    if (Number.isFinite(cap) && nowMs + skewMs >= cap) return true;
  }
  return false;
}

/**
 * Read the cached session and return it only if still usable; `null` if absent
 * or expired. The bearer fetch path and `operator overview` use this so an
 * expired cache surfaces as "not logged in" instead of a server 401.
 */
export function loadLiveOperatorSession(path?: string, nowMs: number = Date.now()): OperatorSession | null {
  const s = readOperatorSession(path);
  if (!s) return null;
  return isOperatorSessionExpired(s, nowMs) ? null : s;
}

/**
 * Map a gateway token payload (relative `expires_in`) into the cached shape
 * (absolute `expires_at`). `nowMs` is injectable for deterministic tests.
 */
export function operatorSessionFromTokenResponse(
  resp: OperatorSessionTokenResponse,
  nowMs: number = Date.now(),
): OperatorSession {
  return {
    operator_session_token: resp.operator_session_token,
    token_type: resp.token_type ?? "Bearer",
    email: resp.email ?? "",
    wallets: Array.isArray(resp.wallets) ? resp.wallets.filter((w): w is string => typeof w === "string") : [],
    expires_at: nowMs + (typeof resp.expires_in === "number" ? resp.expires_in : 0) * 1000,
    absolute_expires_at: resp.absolute_expires_at ?? "",
  };
}
