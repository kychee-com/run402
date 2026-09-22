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
import { randomBytes, createHash } from "node:crypto";
import { getConfigBaseDir } from "./config.js";

/**
 * Cache of **write approvals** — the passkey-signed, target-scoped tokens a
 * wallet-less person mints with `run402 approve` to provision, deploy, or write
 * secrets from the command line. Distinct from the sign-in session
 * ({@link ControlPlaneSessionCache}) it pairs with, and never a step-up. The
 * gateway scopes each token to one `(action, target)`, so this is a
 * **multi-entry** cache keyed by `(api_origin, control_plane_session_hash,
 * action, target)`. An `org.project.create` approval for org Y and a
 * `project.deploy` approval for project X coexist.
 *
 * Stored at the BASE config dir (principal-scoped), mode 0600 — as sensitive as
 * the wallet key. The token dies with its sign-in session; the
 * `control_plane_session_hash` binding lets the client drop a stale approval
 * locally rather than replay it into a `WRITE_APPROVAL_BINDING_MISMATCH`.
 */
export interface WriteApproval {
  write_approval_token: string;
  token_type: string;
  header: string;
  /** Gateway capability: `org.project.create` | `project.deploy` | `project.secret.write`. */
  action: string;
  org_id?: string;
  project_id?: string;
  /** Epoch ms when the approval expires (derived from the gateway-returned session). */
  expires_at: number;
  /** Short hash of the control-plane session this approval is bound to. */
  control_plane_session_hash: string;
  control_plane_principal_id: string;
  /** API origin (e.g. `https://api.run402.com`) the token was minted against. */
  api_origin: string;
  amr?: string[];
  minted_at: number;
}

/** The token payload from `POST /agent/v1/control-plane/write-approval/cli/token`. */
export interface WriteApprovalTokenResponse {
  write_approval_token: string;
  token_type?: string;
  header?: string;
  /** The write-approval session; its idle expiry is the token's expiry. */
  session?: { idle_expires_at?: string | number; expires_at?: string | number; absolute_expires_at?: string | number; amr?: string[]; [k: string]: unknown } | null;
  [k: string]: unknown;
}

/** A capability target — exactly one of these is set per approval. */
export interface WriteApprovalTargetKey {
  org_id?: string;
  project_id?: string;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * Path to the approval cache: `{base}/write-approvals.json`.
 * `RUN402_WRITE_APPROVALS_PATH` overrides for testing.
 */
export function getWriteApprovalsPath(): string {
  return (
    process.env.RUN402_WRITE_APPROVALS_PATH ||
    join(getConfigBaseDir(), "write-approvals.json")
  );
}

/** Stable short hash binding an approval to a control-plane session token. */
export function hashControlPlaneSession(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
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

function isApproval(x: unknown): x is WriteApproval {
  if (!x || typeof x !== "object") return false;
  const a = x as Partial<WriteApproval>;
  return (
    typeof a.write_approval_token === "string" &&
    a.write_approval_token.length > 0 &&
    typeof a.action === "string" &&
    typeof a.api_origin === "string" &&
    typeof a.control_plane_session_hash === "string" &&
    typeof a.expires_at === "number" &&
    Number.isFinite(a.expires_at)
  );
}

/**
 * Read all cached approvals. Returns `[]` for the "no cache" cases (absent,
 * unreadable, unparseable). Throws when the file parses as JSON but the shape
 * is wrong, so a corrupted cache surfaces a clear fix-it.
 */
export function readApprovals(path?: string): WriteApproval[] {
  const p = path ?? getWriteApprovalsPath();
  if (!existsSync(p)) return [];
  selfHealPermissions(p);
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "write-approvals.json must contain a JSON object. Delete it and re-run 'run402 approve' to recreate it.",
    );
  }
  const approvals = (parsed as { approvals?: unknown }).approvals;
  if (!Array.isArray(approvals)) {
    throw new Error(
      "write-approvals.json missing an 'approvals' array. Delete it and re-run 'run402 approve'.",
    );
  }
  return approvals.filter(isApproval);
}

function writeApprovals(approvals: WriteApproval[], path?: string): void {
  const p = path ?? getWriteApprovalsPath();
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.write-approvals.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify({ approvals }, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}

function sameTarget(a: { org_id?: string; project_id?: string }, b: WriteApprovalTargetKey): boolean {
  return (a.org_id ?? null) === (b.org_id ?? null) && (a.project_id ?? null) === (b.project_id ?? null);
}

function sameKey(a: WriteApproval, b: WriteApproval): boolean {
  return (
    a.api_origin === b.api_origin &&
    a.control_plane_session_hash === b.control_plane_session_hash &&
    a.action === b.action &&
    sameTarget(a, b)
  );
}

/**
 * Persist an approval. Replaces any existing entry with the same
 * `(api_origin, control_plane_session_hash, action, target)` key and leaves
 * every other entry intact (multi-entry, non-thrashing). Atomic, mode 0600.
 */
export function saveApproval(approval: WriteApproval, path?: string): void {
  const existing = readApprovals(path).filter((a) => !sameKey(a, approval));
  existing.push(approval);
  writeApprovals(existing, path);
}

/** Delete the whole approval cache — local half of `run402 logout`. Idempotent. */
export function clearApprovals(path?: string): void {
  const p = path ?? getWriteApprovalsPath();
  try {
    rmSync(p, { force: true });
  } catch {
    // Best-effort: a failed unlink should never crash logout.
  }
}

/** Whether an approval is past its usable life (with a small skew buffer). */
export function isApprovalExpired(
  approval: WriteApproval,
  nowMs: number = Date.now(),
  skewMs = 10_000,
): boolean {
  return nowMs + skewMs >= approval.expires_at;
}

/**
 * Return the cached approval matching ALL of `(apiOrigin, cpSessionHash,
 * capability, target)` and still live, or `null` if none matches or it is
 * expired. This is the exact-match the gateway's target gate requires — a
 * non-match (wrong action/target/origin/session) fails closed.
 */
export function loadLiveApproval(
  q: {
    apiOrigin: string;
    cpSessionHash: string;
    capability: string;
    target: WriteApprovalTargetKey;
  },
  path?: string,
  nowMs: number = Date.now(),
): WriteApproval | null {
  for (const a of readApprovals(path)) {
    if (
      a.api_origin === q.apiOrigin &&
      a.control_plane_session_hash === q.cpSessionHash &&
      a.action === q.capability &&
      sameTarget(a, q.target) &&
      !isApprovalExpired(a, nowMs)
    ) {
      return a;
    }
  }
  return null;
}

/** Parse a gateway-returned session expiry (ISO string or epoch) to epoch ms. */
function sessionExpiryMs(
  session: WriteApprovalTokenResponse["session"],
  nowMs: number,
): number {
  const raw = session?.idle_expires_at ?? session?.expires_at ?? session?.absolute_expires_at;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return nowMs + DEFAULT_TTL_MS;
}

/**
 * Build a cache entry from the gateway token response + the binding context
 * (the cp-session it was minted under, the API origin, and the `(action,
 * target)` it covers). Expiry is taken from the returned `session`.
 */
export function approvalFromTokenResponse(
  resp: WriteApprovalTokenResponse,
  binding: {
    action: string;
    target: WriteApprovalTargetKey;
    apiOrigin: string;
    controlPlaneSessionHash: string;
    controlPlanePrincipalId: string;
  },
  nowMs: number = Date.now(),
): WriteApproval {
  const amr = Array.isArray(resp.session?.amr)
    ? (resp.session!.amr as unknown[]).filter((a): a is string => typeof a === "string")
    : undefined;
  return {
    write_approval_token: resp.write_approval_token,
    token_type: typeof resp.token_type === "string" ? resp.token_type : "write_approval",
    header: typeof resp.header === "string" ? resp.header : "X-Run402-Write-Approval",
    action: binding.action,
    ...(binding.target.org_id ? { org_id: binding.target.org_id } : {}),
    ...(binding.target.project_id ? { project_id: binding.target.project_id } : {}),
    expires_at: sessionExpiryMs(resp.session, nowMs),
    control_plane_session_hash: binding.controlPlaneSessionHash,
    control_plane_principal_id: binding.controlPlanePrincipalId,
    api_origin: binding.apiOrigin,
    ...(amr ? { amr } : {}),
    minted_at: nowMs,
  };
}
