/**
 * `org` namespace — the org-owned control plane (gateway v1.77+ /
 * `org-member-management`). Read the resolved principal + memberships, list
 * orgs, and manage org membership (owner-gated). All routes use the existing
 * SIWX auth; authorization is a membership lookup, never `wallet == signer`.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import type {
  AddMemberInput,
  MemberMutationResult,
  MemberRevokeResult,
  OrgMember,
  OrgMembership,
  OrgRole,
  WhoAmIResult,
} from "./org.types.js";

export class Org {
  constructor(private readonly client: Client) {}

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

  /** List members of an org (`GET /orgs/v1/:billing_account_id/members`). */
  async members(billingAccountId: string): Promise<OrgMember[]> {
    requireBa(billingAccountId, "org.members", "listing org members");
    const res = await this.client.request<{ members: OrgMember[] }>(
      `/orgs/v1/${encodeURIComponent(billingAccountId)}/members`,
      { context: "listing org members" },
    );
    return res.members ?? [];
  }

  /**
   * Add a member to an org by wallet (`POST /orgs/v1/:billing_account_id/members`).
   * Requires an active `owner` membership. A brand-new wallet is provisioned as
   * a `human` principal. `role` defaults to `"developer"` server-side.
   */
  async addMember(
    billingAccountId: string,
    input: AddMemberInput,
  ): Promise<MemberMutationResult> {
    requireBa(billingAccountId, "org.addMember", "adding org member");
    if (!input?.wallet) {
      throw new LocalError("org.addMember requires { wallet }", "adding org member");
    }
    const body: Record<string, unknown> = { wallet: input.wallet };
    if (input.role !== undefined) body.role = input.role;
    return this.client.request<MemberMutationResult>(
      `/orgs/v1/${encodeURIComponent(billingAccountId)}/members`,
      { method: "POST", body, context: "adding org member" },
    );
  }

  /**
   * Change a member's role (`PATCH /orgs/v1/:billing_account_id/members/:principal_id`).
   * Requires an active `owner` membership. Demoting the org's only active owner
   * fails with `409 LAST_OWNER`.
   */
  async setRole(
    billingAccountId: string,
    principalId: string,
    role: OrgRole,
  ): Promise<MemberMutationResult> {
    requireBa(billingAccountId, "org.setRole", "setting member role");
    if (!principalId) {
      throw new LocalError("org.setRole requires a principalId", "setting member role");
    }
    if (!role) {
      throw new LocalError("org.setRole requires a role", "setting member role");
    }
    return this.client.request<MemberMutationResult>(
      `/orgs/v1/${encodeURIComponent(billingAccountId)}/members/${encodeURIComponent(principalId)}`,
      { method: "PATCH", body: { role }, context: "setting member role" },
    );
  }

  /**
   * Remove a member (`DELETE /orgs/v1/:billing_account_id/members/:principal_id`).
   * Requires an active `owner` membership. Removing the org's only active owner
   * fails with `409 LAST_OWNER`.
   */
  async removeMember(
    billingAccountId: string,
    principalId: string,
  ): Promise<MemberRevokeResult> {
    requireBa(billingAccountId, "org.removeMember", "removing org member");
    if (!principalId) {
      throw new LocalError("org.removeMember requires a principalId", "removing org member");
    }
    return this.client.request<MemberRevokeResult>(
      `/orgs/v1/${encodeURIComponent(billingAccountId)}/members/${encodeURIComponent(principalId)}`,
      { method: "DELETE", context: "removing org member" },
    );
  }
}

function requireBa(billingAccountId: string, method: string, context: string): void {
  if (!billingAccountId) {
    throw new LocalError(`${method} requires a billing_account_id`, context);
  }
}
