/**
 * Request/response types for the `grants` namespace — per-project capability
 * grants for non-member (agent / CI) principals (gateway `org-member-management`).
 * Maps to `POST` / `DELETE /projects/v1/:project_id/grants`. Mutations require
 * the caller to be an active owner of the project's org.
 */

/** A per-project capability grant (`internal.project_grants`). */
export interface ProjectGrant {
  id: string;
  project_id: string;
  principal_id: string;
  /** e.g. `"deploy"`, `"functions:write"`. */
  capability: string;
  policy: Record<string, unknown>;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  [key: string]: unknown;
}

/** Input to {@link Grants.create}. */
export interface CreateGrantInput {
  /** EVM address (or named wallet) the grant is issued to. */
  wallet: string;
  /** Capability to grant, e.g. `"deploy"` or `"functions:write"`. */
  capability: string;
  /** Optional capability-scoping policy object (gateway-interpreted). */
  policy?: Record<string, unknown>;
  /** Optional ISO-8601 expiry. Omit for a non-expiring grant. */
  expiresAt?: string;
}

/** Result of {@link Grants.create} (`{ status:"ok", grant_id, principal_id }`). */
export interface GrantCreateResult {
  status: string;
  grant_id: string;
  principal_id: string;
  [key: string]: unknown;
}

/** Result of {@link Grants.revoke} (`{ status:"revoked", grant_id }`). */
export interface GrantRevokeResult {
  status: string;
  grant_id: string;
  [key: string]: unknown;
}
