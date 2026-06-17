import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  renameSync,
  statSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getConfigBaseDir } from "./config.js";

/**
 * A cached **control-plane session** — the human principal's bearer, minted by
 * the loopback-PKCE flow (`run402 operator login --loopback`). Distinct from the
 * device-flow {@link OperatorSession} (read-only): this one carries `provenance`
 * (`loopback_pkce`) and `amr`. It authorizes most control-plane operations, but
 * since gateway v1.85/v1.87 it is NOT sufficient on its own for the high-stakes
 * writes `provision` / `deploy` / secrets — those additionally require a
 * passkey-fresh **operator approval** (`X-Run402-Write-Auth`, minted by
 * `run402 operator approve`; see {@link WriteAuthApproval}). Cached at the BASE
 * config dir (email/principal-scoped, shared across local named wallets), mode
 * 0600 — the token is as sensitive as the allowance key.
 *
 * Stored shape vs the gateway payload: the gateway returns a relative
 * `expires_in` (seconds); we persist the absolute `expires_at` (epoch ms) so a
 * cached session can be expiry-checked without knowing when it was written.
 */
export interface ControlPlaneSessionCache {
  control_plane_session_token: string;
  token_type: string;
  provenance: string;
  principal_id: string;
  amr: string[];
  /** Epoch ms when the session expires (issued_at + expires_in). */
  expires_at: number;
}

/** The token payload returned by `POST /agent/v1/control-plane/cli/token`. */
export interface ControlPlaneSessionTokenResponse {
  control_plane_session_token: string;
  token_type?: string;
  provenance?: string;
  principal_id?: string;
  amr?: string[];
  expires_in?: number;
}

/**
 * Path to the cached control-plane session: `{base}/control-plane-session.json`.
 * `RUN402_CONTROL_PLANE_SESSION_PATH` overrides for testing.
 */
export function getControlPlaneSessionPath(): string {
  return (
    process.env.RUN402_CONTROL_PLANE_SESSION_PATH ||
    join(getConfigBaseDir(), "control-plane-session.json")
  );
}

/** Tighten 0600 if group/other-readable, warning once. Best-effort, POSIX-only. */
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
 * Load the cached control-plane session. Returns `null` for the "no session"
 * cases (absent, unreadable, unparseable). Throws when the file parses as JSON
 * but the shape is wrong, so a corrupted cache surfaces a clear fix-it.
 */
export function readControlPlaneSession(path?: string): ControlPlaneSessionCache | null {
  const p = path ?? getControlPlaneSessionPath();
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
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "control-plane-session.json must contain a JSON object. Delete it and run 'run402 operator login --loopback' to recreate it.",
    );
  }
  const data = parsed as Partial<ControlPlaneSessionCache>;
  if (
    typeof data.control_plane_session_token !== "string" ||
    data.control_plane_session_token.length === 0
  ) {
    throw new Error(
      "control-plane-session.json missing valid 'control_plane_session_token'. Run 'run402 operator login --loopback' to refresh it.",
    );
  }
  if (typeof data.expires_at !== "number" || !Number.isFinite(data.expires_at)) {
    throw new Error(
      "control-plane-session.json missing valid 'expires_at'. Run 'run402 operator login --loopback' to refresh it.",
    );
  }
  return {
    control_plane_session_token: data.control_plane_session_token,
    token_type: typeof data.token_type === "string" ? data.token_type : "Bearer",
    provenance: typeof data.provenance === "string" ? data.provenance : "loopback_pkce",
    principal_id: typeof data.principal_id === "string" ? data.principal_id : "",
    amr: Array.isArray(data.amr) ? data.amr.filter((a): a is string => typeof a === "string") : [],
    expires_at: data.expires_at,
  };
}

/** Persist a control-plane session atomically (temp-file + rename), mode 0600. */
export function saveControlPlaneSession(data: ControlPlaneSessionCache, path?: string): void {
  const p = path ?? getControlPlaneSessionPath();
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.control-plane-session.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}

/** Delete the cached control-plane session — local half of `operator logout`. Idempotent. */
export function clearControlPlaneSession(path?: string): void {
  const p = path ?? getControlPlaneSessionPath();
  try {
    rmSync(p, { force: true });
  } catch {
    // Best-effort: a failed unlink should never crash logout.
  }
}

/** Whether a cached session is past its usable life (with a small skew buffer). */
export function isControlPlaneSessionExpired(
  session: ControlPlaneSessionCache,
  nowMs: number = Date.now(),
  skewMs = 10_000,
): boolean {
  return nowMs + skewMs >= session.expires_at;
}

/** Read the cached session and return it only if still usable; `null` if absent or expired. */
export function loadLiveControlPlaneSession(
  path?: string,
  nowMs: number = Date.now(),
): ControlPlaneSessionCache | null {
  const s = readControlPlaneSession(path);
  if (!s) return null;
  return isControlPlaneSessionExpired(s, nowMs) ? null : s;
}

/** Map a gateway token payload (relative `expires_in`) into the cached shape (absolute `expires_at`). */
export function controlPlaneSessionFromTokenResponse(
  resp: ControlPlaneSessionTokenResponse,
  nowMs: number = Date.now(),
): ControlPlaneSessionCache {
  return {
    control_plane_session_token: resp.control_plane_session_token,
    token_type: resp.token_type ?? "Bearer",
    provenance: resp.provenance ?? "loopback_pkce",
    principal_id: resp.principal_id ?? "",
    amr: Array.isArray(resp.amr) ? resp.amr.filter((a): a is string => typeof a === "string") : [],
    expires_at: nowMs + (typeof resp.expires_in === "number" ? resp.expires_in : 0) * 1000,
  };
}
