/**
 * Request/response types for the `org` namespace — the org-owned control plane
 * (gateway v1.77+ / `org-member-management`). A wallet *authenticates* (SIWX
 * resolves it to a control-plane principal); *authorization* is an org
 * (billing-account) membership in the role lattice below, or a per-project
 * grant. These shapes map to `/agent/v1/whoami` and `/orgs/v1*`.
 */

/** Org (billing-account) role lattice: `owner > admin > developer > billing > viewer`. */
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
 * `"revoked"` do not). Returned by {@link Org.whoami} and {@link Org.list}.
 */
export interface OrgMembership {
  billing_account_id: string;
  role: OrgRole;
  status: string;
  [key: string]: unknown;
}

/**
 * Result of {@link Org.whoami} (`GET /agent/v1/whoami`) — the remote, gateway-
 * resolved identity. Distinct from the local, network-free `r.whoami()` (wallet
 * address + profile label): this returns the control-plane principal and every
 * org it is a member of.
 */
export interface WhoAmIResult {
  principal: Principal;
  memberships: OrgMembership[];
  authenticator_id: string;
  [key: string]: unknown;
}

/** A member row from {@link Org.members} (`GET /orgs/v1/:ba/members`). */
export interface OrgMember {
  principal_id: string;
  role: OrgRole;
  status: string;
  [key: string]: unknown;
}

/**
 * Input to {@link Org.addMember}. Membership-add is *by wallet* today — the
 * gateway resolves/provisions the wallet to a principal. (Email-first invite is
 * the separate Layer-2 `passkey-principals-onboarding` flow, not yet a route.)
 */
export interface AddMemberInput {
  /** EVM address (or named wallet) to add. */
  wallet: string;
  /** Initial role. Defaults to `"developer"` server-side when omitted. */
  role?: OrgRole;
}

/** Result of {@link Org.addMember} / {@link Org.setRole} (`{ status:"ok", principal_id, role }`). */
export interface MemberMutationResult {
  status: string;
  principal_id: string;
  role: OrgRole;
  [key: string]: unknown;
}

/** Result of {@link Org.removeMember} (`{ status:"revoked", principal_id }`). */
export interface MemberRevokeResult {
  status: string;
  principal_id: string;
  [key: string]: unknown;
}
