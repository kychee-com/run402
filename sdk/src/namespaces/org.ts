/**
 * `org` namespace — the org-owned control plane (gateway v1.77+). Read the
 * resolved principal + memberships, list orgs, manage members and email
 * invites (owner-gated), and read the control-plane audit trail. All routes use
 * the existing SIWX auth; authorization is a membership lookup, never
 * `wallet == signer`.
 *
 * Sub-resources are grouped so the surface scales: `r.org.members.*` and
 * `r.org.invites.*`. Org-level reads stay on the namespace itself
 * (`r.org.whoami` / `r.org.list` / `r.org.audit`).
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import type {
  AddMemberInput,
  AuditEvent,
  AuditOptions,
  CreateInviteInput,
  MemberMutationResult,
  MemberRevokeResult,
  OrgInvite,
  OrgInviteRevokeResult,
  OrgMember,
  OrgMembership,
  OrgRole,
  WhoAmIResult,
} from "./org.types.js";

function requireBa(billingAccountId: string, method: string, context: string): void {
  if (!billingAccountId) {
    throw new LocalError(`${method} requires a billing_account_id`, context);
  }
}

/** Member management — `r.org.members.*`. */
export class OrgMembers {
  constructor(private readonly client: Client) {}

  /** List members of an org (`GET /orgs/v1/:billing_account_id/members`). Any active member. */
  async list(billingAccountId: string): Promise<OrgMember[]> {
    requireBa(billingAccountId, "org.members.list", "listing org members");
    const res = await this.client.request<{ members: OrgMember[] }>(
      `/orgs/v1/${encodeURIComponent(billingAccountId)}/members`,
      { context: "listing org members" },
    );
    return res.members ?? [];
  }

  /**
   * Add a member by wallet (`POST /orgs/v1/:billing_account_id/members`).
   * Requires an active `owner` membership. A brand-new wallet is provisioned as
   * a `human` principal; `role` defaults to `"developer"` server-side.
   */
  async add(billingAccountId: string, input: AddMemberInput): Promise<MemberMutationResult> {
    requireBa(billingAccountId, "org.members.add", "adding org member");
    if (!input?.wallet) {
      throw new LocalError("org.members.add requires { wallet }", "adding org member");
    }
    const body: Record<string, unknown> = { wallet: input.wallet };
    if (input.role !== undefined) body.role = input.role;
    return this.client.request<MemberMutationResult>(
      `/orgs/v1/${encodeURIComponent(billingAccountId)}/members`,
      { method: "POST", body, context: "adding org member" },
    );
  }

  /**
   * Change a member's role (`PATCH …/members/:principal_id`). Requires `owner`;
   * demoting the org's only active owner fails with `409 LAST_OWNER`.
   */
  async setRole(billingAccountId: string, principalId: string, role: OrgRole): Promise<MemberMutationResult> {
    requireBa(billingAccountId, "org.members.setRole", "setting member role");
    if (!principalId) throw new LocalError("org.members.setRole requires a principalId", "setting member role");
    if (!role) throw new LocalError("org.members.setRole requires a role", "setting member role");
    return this.client.request<MemberMutationResult>(
      `/orgs/v1/${encodeURIComponent(billingAccountId)}/members/${encodeURIComponent(principalId)}`,
      { method: "PATCH", body: { role }, context: "setting member role" },
    );
  }

  /**
   * Revoke a member (`DELETE …/members/:principal_id`) — one row, status
   * `revoked`, no key rotation. Requires `owner`; revoking the org's only active
   * owner fails with `409 LAST_OWNER`.
   */
  async revoke(billingAccountId: string, principalId: string): Promise<MemberRevokeResult> {
    requireBa(billingAccountId, "org.members.revoke", "revoking org member");
    if (!principalId) throw new LocalError("org.members.revoke requires a principalId", "revoking org member");
    return this.client.request<MemberRevokeResult>(
      `/orgs/v1/${encodeURIComponent(billingAccountId)}/members/${encodeURIComponent(principalId)}`,
      { method: "DELETE", context: "revoking org member" },
    );
  }
}

/** Email-invite management — `r.org.invites.*`. */
export class OrgInvites {
  constructor(private readonly client: Client) {}

  /** List pending email invites (`GET /orgs/v1/:billing_account_id/invites`). Any active member. */
  async list(billingAccountId: string): Promise<OrgInvite[]> {
    requireBa(billingAccountId, "org.invites.list", "listing org invites");
    const res = await this.client.request<{ invites: OrgInvite[] }>(
      `/orgs/v1/${encodeURIComponent(billingAccountId)}/invites`,
      { context: "listing org invites" },
    );
    return res.invites ?? [];
  }

  /**
   * Invite a person by email (`POST …/invites`); claimed at their first login.
   * Requires `owner` (plus step-up when driven by a control-plane session).
   */
  async create(billingAccountId: string, input: CreateInviteInput): Promise<OrgInvite> {
    requireBa(billingAccountId, "org.invites.create", "creating org invite");
    if (!input?.email) throw new LocalError("org.invites.create requires { email }", "creating org invite");
    if (!input?.role) throw new LocalError("org.invites.create requires { role }", "creating org invite");
    const body: Record<string, unknown> = { email: input.email, role: input.role };
    if (input.inviteTtlHours !== undefined) body.invite_ttl_hours = input.inviteTtlHours;
    return this.client.request<OrgInvite>(
      `/orgs/v1/${encodeURIComponent(billingAccountId)}/invites`,
      { method: "POST", body, context: "creating org invite" },
    );
  }

  /** Revoke a pending invite by its pending principal id (`DELETE …/invites/:principal_id`). Requires `owner`. */
  async revoke(billingAccountId: string, principalId: string): Promise<OrgInviteRevokeResult> {
    requireBa(billingAccountId, "org.invites.revoke", "revoking org invite");
    if (!principalId) throw new LocalError("org.invites.revoke requires a principalId", "revoking org invite");
    return this.client.request<OrgInviteRevokeResult>(
      `/orgs/v1/${encodeURIComponent(billingAccountId)}/invites/${encodeURIComponent(principalId)}`,
      { method: "DELETE", context: "revoking org invite" },
    );
  }
}

export class Org {
  /** Member management (`r.org.members.*`). */
  readonly members: OrgMembers;
  /** Email-invite management (`r.org.invites.*`). */
  readonly invites: OrgInvites;

  constructor(private readonly client: Client) {
    this.members = new OrgMembers(client);
    this.invites = new OrgInvites(client);
  }

  /**
   * Resolve the caller's control-plane principal and its org memberships
   * (`GET /agent/v1/whoami`). This is the REMOTE identity; for the local,
   * network-free wallet/profile identity use `r.whoami()`.
   */
  async whoami(): Promise<WhoAmIResult> {
    return this.client.request<WhoAmIResult>("/agent/v1/whoami", {
      context: "resolving principal identity",
    });
  }

  /** List the orgs the caller is a member of (`GET /orgs/v1`), as memberships. */
  async list(): Promise<OrgMembership[]> {
    const res = await this.client.request<{ orgs: OrgMembership[] }>("/orgs/v1", {
      context: "listing organizations",
    });
    return res.orgs ?? [];
  }

  /**
   * Control-plane audit trail for an org (`GET /orgs/v1/:billing_account_id/audit`).
   * admin+. Newest-first; page with the `before` cursor.
   */
  async audit(billingAccountId: string, opts: AuditOptions = {}): Promise<AuditEvent[]> {
    requireBa(billingAccountId, "org.audit", "reading org audit trail");
    const parts: string[] = [];
    if (opts.limit !== undefined) parts.push(`limit=${encodeURIComponent(String(opts.limit))}`);
    if (opts.before !== undefined) parts.push(`before=${encodeURIComponent(opts.before)}`);
    const q = parts.join("&");
    const base = `/orgs/v1/${encodeURIComponent(billingAccountId)}/audit`;
    const res = await this.client.request<{ events?: AuditEvent[]; audit_events?: AuditEvent[] }>(
      q ? `${base}?${q}` : base,
      { context: "reading org audit trail" },
    );
    return res.events ?? res.audit_events ?? [];
  }
}
