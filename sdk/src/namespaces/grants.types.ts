/**
 * Request/response types for the `grants` namespace — per-project capability
 * grants and the grant keys minted against them.
 *
 * A **grant** is the permission row: this principal may do this capability on
 * this project until this date. A **grant key** is a credential minted against
 * exactly one grant, narrower than it (scope, spend cap, expiry), revocable on
 * its own, and never an owner. A grant may hold no key (the agent signs with
 * its own wallet via SIWX), one, or several. Revoking a key leaves the grant;
 * revoking the grant kills every key.
 *
 * Maps to `/projects/v1/:project_id/grants[...]` and
 * `/projects/v1/:project_id/grant-keys/:key_id[...]`. Every call requires the
 * caller to be an active owner of the project's org.
 */

/** Grant-key kinds. Only `run402_agent_key` returns a bearer `token`. */
export type GrantKeyKind =
  | "run402_agent_key"
  | "ci_oidc"
  | "tempo_access_key"
  | "base_disposable_eoa"
  | "erc7710";

/**
 * Grant-key scope (`scope` JSONB). Always a subset of the grant: a key never
 * widens it. Omit to take the grant's own capability.
 */
export interface GrantKeyScope {
  /** Schema version. Must be `1`. */
  v: 1;
  /** Non-empty capability list, e.g. `["deploy"]`. */
  capabilities: string[];
  /** Optional project allowlist. Defaults to the issuing project. */
  projects?: string[];
  [key: string]: unknown;
}

/** Spend cap (`spend_cap` JSONB). Required for the payment-rail kinds; enforced at send time. */
export interface GrantKeySpendCap {
  v: 1;
  currency: "usd_micros";
  period?: "day" | "week" | "month";
  per_tx?: number;
  per_period?: number;
  [key: string]: unknown;
}

/** A grant-key request: every field optional; `{}` takes every default. */
export interface GrantKeyInput {
  /** Defaults to `"run402_agent_key"` (the bearer an agent holds). */
  kind?: GrantKeyKind;
  /** Defaults to the grant's own capability. */
  scope?: GrantKeyScope;
  /** Spend cap (payment-rail kinds). */
  spendCap?: GrantKeySpendCap | null;
  /** ISO-8601 expiry; omit or `null` for none beyond the grant's. */
  expiresAt?: string | null;
  /** Rail-specific public subject. */
  publicSubject?: string;
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
  /**
   * Also mint the grant's first grant key in the same transaction. The key's
   * `token` is returned ONCE in `key.token`.
   */
  key?: GrantKeyInput;
}

/**
 * A freshly minted grant key. `token` is the `run402_agent_key` bearer,
 * returned **once** and never again; `null` for kinds that carry no bearer.
 */
export interface MintedGrantKey {
  key_id: string;
  kind: GrantKeyKind | (string & {});
  token: string | null;
  expires_at: string | null;
  [key: string]: unknown;
}

/** Result of {@link Grants.create} (`{ status:"ok", grant_id, principal_id, key? }`). */
export interface GrantCreateResult {
  status: string;
  grant_id: string;
  principal_id: string;
  /** Present when a key was requested. */
  key?: MintedGrantKey;
  [key: string]: unknown;
}

/** A grant key as listed — never a token or secret material. */
export interface GrantKey {
  key_id: string;
  grant_id: string;
  kind: GrantKeyKind;
  principal_id: string;
  public_subject: string | null;
  scope: Record<string, unknown>;
  spend_cap: Record<string, unknown> | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  [key: string]: unknown;
}

/** A per-project capability grant with its grant keys nested. */
export interface ProjectGrant {
  grant_id: string;
  principal_id: string;
  wallet: string | null;
  /** e.g. `"deploy"`, `"functions:write"`. */
  capability: string;
  policy: Record<string, unknown>;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  keys: GrantKey[];
  [key: string]: unknown;
}

/** Result of {@link Grants.list}. */
export interface GrantListResult {
  grants: ProjectGrant[];
  [key: string]: unknown;
}

/** Result of {@link Grants.revoke} (`{ status:"revoked", grant_id }`). */
export interface GrantRevokeResult {
  status: string;
  grant_id: string;
  [key: string]: unknown;
}

/** Result of {@link Grants.createKey} (`{ status:"ok", grant_id, key }`). */
export interface GrantKeyCreateResult {
  status: string;
  grant_id: string;
  key: MintedGrantKey;
  [key: string]: unknown;
}

/** Result of {@link Grants.revokeKey} (`{ status:"revoked", key_id }`). */
export interface GrantKeyRevokeResult {
  status: string;
  key_id: string;
  [key: string]: unknown;
}

/** Result of {@link Grants.rotateKey} (`{ status:"rotated", replaced_key_id, grant_id, key }`). */
export interface GrantKeyRotateResult {
  status: string;
  replaced_key_id: string;
  grant_id: string;
  key: MintedGrantKey;
  [key: string]: unknown;
}
