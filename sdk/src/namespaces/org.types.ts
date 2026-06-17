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

/**
 * A resolved control-plane principal. `type` is the principal kind
 * (`"human"` / `"agent"` / `"ci"` — future kinds pass through). Unknown future
 * fields are preserved via the index signature.
 *
 * NOTE: the `principal` sub-object is serialized in **camelCase** by the gateway
 * (`displayName` / `createdAt` / `disabledAt`), unlike the snake_case
 * `memberships[]` and top-level `authenticator_id`. The gateway OMITS
 * `displayName` and `disabledAt` when they are null, so both are optional.
 */
export interface Principal {
  id: string;
  type: string;
  /** Human-readable label (e.g. the wallet address for a SIWX human). Omitted when unset. */
  displayName?: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 timestamp present only when the principal is disabled (and thus fails auth); omitted otherwise. */
  disabledAt?: string;
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
   * validated server-side. Omit for an unlabeled org. No `tier` — paid tiers are
   * a separate flow.
   */
  displayName?: string | null;
}

/**
 * An org summary as returned by {@link Orgs.create} and {@link ScopedOrg.rename}
 * (`{ org_id, display_name, tier }`). `display_name` is `null` when unset.
 */
export interface OrgSummary {
  org_id: string;
  display_name: string | null;
  tier: string;
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
 */
export interface OrgInvite {
  principal_id: string;
  email: string;
  role: OrgRole;
  status: string;
  expires_at?: string;
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
  /** Cursor — return events before this opaque marker. */
  before?: string;
}

/** One control-plane audit event from {@link ScopedOrg.audit}. Shape is gateway-owned (forward-compatible). */
export interface AuditEvent {
  [key: string]: unknown;
}
