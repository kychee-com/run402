/**
 * Wire types for the gateway's project-credential routes
 * (`/projects/v1/:project_id/credentials`, `…/credential-status`,
 * `…/tokens`). Kept in their own module so `r.credentials.projectKeys`'s
 * LOCAL-cache types stay visibly separate from the remote ones.
 */

/** `anon` is the tenant-facing key; `service` is the privileged one. */
export type ProjectCredentialKind = "anon" | "service";

/** Metadata view. No read ever returns the secret or its hash. */
export interface ProjectCredentialRecord {
  credential_id: string;
  project_id: string;
  kind: ProjectCredentialKind;
  name: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  /** Set when this credential replaced another via `rotate()`. */
  replacement_of: string | null;
}

export interface NextAction {
  type: string;
  method?: string;
  path?: string;
  auth?: string;
  why?: string;
  [key: string]: unknown;
}

/**
 * The ONLY shape that carries `secret`, returned from `issue()` and
 * `rotate()`. Persist it on receipt — it is not recoverable.
 */
export interface ProjectCredentialIssued extends ProjectCredentialRecord {
  secret: string;
  next_actions?: NextAction[];
}

/** Short-lived token from `mintToken()`; also secret-bearing, plus a TTL. */
export interface ProjectTokenIssued extends ProjectCredentialRecord {
  secret: string;
  expires_in: number;
  next_actions?: NextAction[];
}

export interface ProjectCredentialListResult {
  credentials: ProjectCredentialRecord[];
}

export interface ProjectCredentialRevoked extends ProjectCredentialRecord {
  revoked: true;
}

/**
 * `status()` — the deliberate poll for "am I still on the retiring key".
 *
 * `retirement.deadline` is ALWAYS null, on purpose: retirement is gated on
 * conditions (every tenant migrated, 30 consecutive days of zero legacy use,
 * explicit operator approval), never on a date. Do not plan against a date the
 * platform has not committed to — read `gated_on` instead.
 */
export interface ProjectCredentialStatus {
  project_id: string;
  /** `legacy` while the project still leans on the derived keys. */
  state: "legacy" | "rotatable";
  legacy_key: string;
  rotatable_credentials: number;
  credentials: ProjectCredentialRecord[];
  retirement: {
    gated_on: string[];
    deadline: null;
  };
  next_actions?: NextAction[];
}

export interface IssueProjectCredentialInput {
  kind: ProjectCredentialKind;
  /**
   * Unique among the project's LIVE credentials. Re-using a live name is a
   * `409 CREDENTIAL_NAME_TAKEN` — that collision IS the idempotency story for
   * this route, so a retried create never silently mints a second credential.
   */
  name: string;
  /** ISO timestamp; must be in the future and within one year. */
  expiresAt?: string;
}
