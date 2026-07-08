/**
 * Request/response types for the org namespace — the org-owned control plane
 * (gateway v1.77+ / v1.82 `first-class-orgs`). A wallet *authenticates* (SIWX
 * resolves it to a control-plane principal); *authorization* is an org
 * membership in the role lattice below, or a per-project grant. These shapes map
 * to `/agent/v1/whoami` and `/orgs/v1*`.
 *
 * Public vocabulary is `org` / `org_id` (v1.82): the internal `organization`
 * substrate never appears on the wire.
 */

/** Org role lattice: `owner > admin > developer > billing > viewer`. */
export type OrgRole = "owner" | "admin" | "developer" | "billing" | "viewer";

/** Options for {@link OrgMembers.setRole} — the canonical `setRole(principalId, { role })` shape. */
export interface SetMemberRoleOptions {
  role: OrgRole;
}

/**
 * A resolved control-plane principal. `type` is the principal kind
 * (`"human"` / `"agent"` / `"ci"` — future kinds pass through). Unknown future
 * fields are preserved via the index signature.
 *
 * The `principal` sub-object is serialized in **snake_case** by the gateway
 * (`display_name` / `created_at` / `disabled_at`), matching the snake_case
 * `memberships[]` and top-level `authenticator_id`. All three renamed fields are
 * ALWAYS PRESENT and NULLABLE (value-or-null, never omitted).
 */
export interface Principal {
  id: string;
  type: string;
  /** Human-readable label (e.g. the wallet address for a SIWX human); `null` when unset. */
  display_name: string | null;
  /** ISO-8601 creation time; `null` when unset. */
  created_at: string | null;
  /** ISO-8601 timestamp when the principal is disabled (and thus fails auth); `null` otherwise. */
  disabled_at: string | null;
  [key: string]: unknown;
}

/**
 * A principal's membership in an org. `status` is the membership lifecycle
 * (`"active"` is the only state that authorizes; `"invited"` / `"suspended"` /
 * `"revoked"` do not). Returned by {@link Orgs.whoami} and {@link Orgs.list}.
 *
 * v1.82: carries `org_id` + `display_name` (the public vocabulary), replacing
 * the pre-v1.82 `org_id`.
 */
export interface OrgMembership {
  org_id: string;
  /** The org's free-text label; `null` when the org has no display name. */
  display_name: string | null;
  role: OrgRole;
  status: string;
  [key: string]: unknown;
}

/**
 * Result of {@link Orgs.whoami} (`GET /agent/v1/whoami`) — the remote, gateway-
 * resolved identity. Distinct from the local, network-free `r.whoami()` (wallet
 * address + profile label): this returns the control-plane principal and every
 * org it is a member of.
 */
export interface WhoAmIResult {
  principal: Principal;
  memberships: OrgMembership[];
  authenticator_id: string | null;
  [key: string]: unknown;
}

/** Input to {@link Orgs.create} — create an empty org on the prototype tier. */
export interface CreateOrgInput {
  /**
   * Optional free-text label (e.g. "Kychee"). Non-unique, not an identifier,
   * validated server-side. Omit for an unlabeled org. There is no tier input at
   * create — the gateway returns the created org's prototype tier/lease state.
   */
  displayName?: string | null;
}

/**
 * An org summary as returned by {@link Orgs.create} and {@link ScopedOrg.rename}
 * (`{ org_id, display_name, tier, lease_started_at, lease_expires_at }`).
 * `display_name` is `null` when unset. `tier` and lease timestamps are `null`
 * only for true pre-subscription placeholder orgs; direct-created orgs should
 * report `prototype` plus lease timestamps once the gateway is current.
 */
export interface OrgSummary {
  org_id: string;
  display_name: string | null;
  tier: string | null;
  /** ISO-8601 lease start; `null` only for pre-subscription placeholders. */
  lease_started_at: string | null;
  /** ISO-8601 lease expiry; `null` only for pre-subscription placeholders. */
  lease_expires_at: string | null;
  [key: string]: unknown;
}

/**
 * A single-org read from {@link ScopedOrg.get} (`GET /orgs/v1/:org_id`) — the
 * {@link OrgSummary} plus the caller's `role` (`null` for an admin who is not a
 * member).
 */
export interface OrgDetail extends OrgSummary {
  role: OrgRole | null;
}

/** Input to {@link ScopedOrg.setPayoutWallet}. */
export interface SetPayoutWalletInput {
  /**
   * Active wallet linked to the same org, or `null` to clear the explicit
   * default. The gateway may still resolve a single active org wallet.
   */
  walletAddress: string | null;
}

export interface PayoutWalletNextAction {
  type: "edit_request" | "resume_deploy";
  method: "POST" | "PATCH";
  path: string;
  auth: string;
  why: string;
  [key: string]: unknown;
}

export interface PayoutWalletRecovery {
  status: "ready" | "required" | "ambiguous" | string;
  active_wallet_count: number;
  next_actions: PayoutWalletNextAction[];
  /** Present when status is ready. */
  mode?: "default" | "single_active_wallet";
  /** Present when status is ready. */
  wallet_address?: string;
  /** Present when setup needs recovery, e.g. PAYOUT_WALLET_REQUIRED. */
  code?: string;
  [key: string]: unknown;
}

/** Result of setting or clearing the org default payout wallet for tenant priced routes. */
export interface SetPayoutWalletResult {
  status: "set" | "cleared";
  org_id: string;
  default_payout_wallet: string | null;
  previous_default_payout_wallet: string | null;
  recovery: PayoutWalletRecovery;
  [key: string]: unknown;
}

/** A member row from {@link OrgMembers.list} (`GET /orgs/v1/:org_id/members`). */
export interface OrgMember {
  principal_id: string;
  role: OrgRole;
  status: string;
  [key: string]: unknown;
}

/**
 * Input to {@link OrgMembers.add}. Membership-add is *by wallet* — the gateway
 * resolves/provisions the wallet to a principal.
 */
export interface AddMemberInput {
  /** EVM address (or named wallet) to add. */
  wallet: string;
  /** Initial role. Defaults to `"developer"` server-side when omitted. */
  role?: OrgRole;
}

/** Result of {@link OrgMembers.add} / {@link OrgMembers.setRole} (`{ status:"ok", principal_id, role }`). */
export interface MemberMutationResult {
  status: string;
  principal_id: string;
  role: OrgRole;
  [key: string]: unknown;
}

/** Result of {@link OrgMembers.revoke} (`{ status:"revoked", principal_id }`). */
export interface MemberRevokeResult {
  status: string;
  principal_id: string;
  [key: string]: unknown;
}

/** Input to {@link OrgInvites.create} — invite a person by email at a role. */
export interface CreateInviteInput {
  email: string;
  role: OrgRole;
  /** Optional invite lifetime in hours; gateway default applies when omitted. */
  inviteTtlHours?: number;
}

/**
 * A pending email invite from {@link OrgInvites.list} (`GET /orgs/v1/:org_id/invites`).
 * Represented by a pending `principal_id` — pass it to {@link OrgInvites.revoke}.
 * The wire shape carries the owning `org_id`, the `invited_email`, who invited
 * (`invited_by`, `null` when unattributed), and ISO-8601 `invite_expires_at` /
 * `created_at` (both nullable).
 */
export interface OrgInvite {
  principal_id: string;
  org_id: string;
  invited_email: string;
  role: OrgRole;
  invited_by: string | null;
  invite_expires_at: string | null;
  created_at: string | null;
  [key: string]: unknown;
}

/** Result of {@link OrgInvites.revoke} (`{ status:"revoked", principal_id }`). */
export interface OrgInviteRevokeResult {
  status: string;
  principal_id: string;
  [key: string]: unknown;
}

/** Options for {@link ScopedOrg.audit}. */
export interface AuditOptions {
  /** Page size; gateway default applies when omitted. */
  limit?: number;
  /** Keyset cursor — page forward from this opaque marker (`next_cursor` from a prior page). */
  after?: string;
  /** Legacy cursor — return events before this opaque marker. Still accepted by the gateway. */
  before?: string;
}

/** One control-plane audit event from {@link ScopedOrg.audit}. Shape is gateway-owned (forward-compatible). */
export interface AuditEvent {
  [key: string]: unknown;
}

/** Result of {@link ScopedOrg.audit} — a keyset page of audit events. */
export interface AuditResult {
  events: AuditEvent[];
  has_more: boolean;
  next_cursor: string | null;
}
