/**
 * Request/response types for the `delegates` namespace — scoped, revocable,
 * expiring credentials an OWNER mints for an agent (gateway
 * `cryptographic-delegates`). Maps to `/projects/v1/:project_id/delegates`.
 *
 * A delegate always NARROWS an existing `project_grant`; it is never broader
 * than the grant it hangs off, and it can never be an owner.
 */

/** Delegate kinds the gateway accepts. Only `run402_agent_key` returns a bearer. */
export type DelegateKind =
  | "run402_agent_key"
  | "ci_oidc"
  | "tempo_access_key"
  | "base_disposable_eoa"
  | "erc7710";

/**
 * Delegate scope (`scope` JSONB, compiled server-side to `DelegateScopeV1`).
 * REQUIRED by the gateway — omitting it returns `400 INVALID_DELEGATE_SCOPE`.
 */
export interface DelegateScope {
  /** Schema version. Must be `1`. */
  v: 1;
  /** Non-empty capability list, e.g. `["deploy"]`. */
  capabilities: string[];
  /** Optional project allowlist. Defaults to the issuing project. */
  projects?: string[];
  [key: string]: unknown;
}

/** Spend cap (`spend_cap` JSONB). Enforced at SEND time, not control-plane authz. */
export interface DelegateSpendCap {
  v: 1;
  currency: "usd_micros";
  per_tx?: number;
  per_period?: number;
  [key: string]: unknown;
}

/** Input to {@link Delegates.create}. */
export interface CreateDelegateInput {
  /** The `project_grant` this delegate narrows. Required by the gateway. */
  grantId: string;
  /** Delegate kind. Defaults to `"run402_agent_key"` (the bearer-returning kind). */
  kind?: DelegateKind;
  /**
   * Scope. If omitted the SDK sends `{ v:1, capabilities:["deploy"], projects:[projectId] }`
   * so the common "let this agent deploy this one project" case is one call.
   */
  scope?: DelegateScope;
  /** Optional spend cap (payment rails only). */
  spendCap?: DelegateSpendCap;
  /** Optional ISO-8601 expiry. Omit for a non-expiring delegate. */
  expiresAt?: string | null;
  /** Optional rail-specific public subject. */
  publicSubject?: string;
}

/**
 * Result of {@link Delegates.create} / {@link Delegates.rotate}.
 *
 * `token` is returned **once** and never again — persist it immediately
 * (Secrets Manager, CI secret) or you must rotate to get a new one.
 */
export interface DelegateCreateResult {
  status: string;
  delegate_id: string;
  /** The bearer. Present for `run402_agent_key`. Shown once. */
  token?: string;
  expires_at: string | null;
  [key: string]: unknown;
}

/** A delegate as returned by {@link Delegates.list} — never includes a token. */
export interface DelegateSummary {
  id: string;
  project_id: string;
  principal_id: string;
  kind: DelegateKind;
  scope: Record<string, unknown>;
  spend_cap: Record<string, unknown> | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  [key: string]: unknown;
}

/** Result of {@link Delegates.list}. */
export interface DelegateListResult {
  delegates: DelegateSummary[];
  [key: string]: unknown;
}

/** Result of {@link Delegates.revoke}. */
export interface DelegateRevokeResult {
  status: string;
  delegate_id: string;
  [key: string]: unknown;
}
