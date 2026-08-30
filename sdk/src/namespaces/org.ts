/**
 * `org` namespace — the org-owned control plane (gateway v1.77+, first-class in
 * v1.82). Mirrors the `r.projects` / `r.project(id)` idiom:
 *
 *   - `r.orgs`        — collection + identity: `create`, `list`, `whoami`.
 *   - `r.org(id)`     — a resource-scoped sub-client (id pre-bound): `get`,
 *                       `rename`, `members.*`, `invites.*`, `audit`.
 *
 * All routes use the existing SIWX (or control-plane-session) auth; authorization
 * is a membership lookup, never `wallet == signer`. Mutations (`create`,
 * `rename`, member/invite changes) are step-up gated server-side and may return
 * `STEP_UP_REQUIRED` when driven by a stale control-plane session.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import type {
  AddMemberInput,
  AuditEvent,
  AuditOptions,
  AuditResult,
  ClaimOrgSlugResult,
  CreateInviteInput,
  CreateOrgInput,
  MemberMutationResult,
  MemberRevokeResult,
  MemberRevokeEncryptionKeyResult,
  OrgDetail,
  OrgInvite,
  OrgInviteRevokeResult,
  OrgMember,
  OrgMembership,
  OrgRole,
  OrgSummary,
  SetPayoutWalletInput,
  SetPayoutWalletResult,
  SetMemberRoleOptions,
  WhoAmIResult,
} from "./org.types.js";

/** Isomorphic random idempotency key (Node + browser + V8 isolate) — no Node-only crypto import. */
function randomIdempotencyKey(): string {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return `org-slug-${crypto.randomUUID()}`;
  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `org-slug-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Member management — `r.org(id).members.*`. The org id is bound at construction. */
export class OrgMembers {
  constructor(private readonly client: Client, private readonly orgId: string) {}

  /** List members of the org (`GET /orgs/v1/:org_id/members`). Any active member. */
  async list(): Promise<OrgMember[]> {
    const res = await this.client.request<{ members: OrgMember[] }>(
      `/orgs/v1/${encodeURIComponent(this.orgId)}/members`,
      { context: "listing org members" },
    );
    return res.members ?? [];
  }

  /**
   * Add a member by wallet (`POST /orgs/v1/:org_id/members`). Requires an active
   * `owner` membership. A brand-new wallet is provisioned as a `human` principal;
   * `role` defaults to `"developer"` server-side.
   */
  async add(input: AddMemberInput): Promise<MemberMutationResult> {
    if (!input?.wallet) {
      throw new LocalError("org members.add requires { wallet }", "adding org member");
    }
    const body: Record<string, unknown> = { wallet: input.wallet };
    if (input.role !== undefined) body.role = input.role;
    return this.client.request<MemberMutationResult>(
      `/orgs/v1/${encodeURIComponent(this.orgId)}/members`,
      { method: "POST", body, context: "adding org member" },
    );
  }

  /**
   * Change a member's role (`PATCH …/members/:principal_id`). Requires `owner`;
   * demoting the org's only active owner fails with `409 LAST_OWNER`.
   */
  async setRole(principalId: string, opts: SetMemberRoleOptions): Promise<MemberMutationResult> {
    const role: OrgRole = opts.role;
    if (!principalId) throw new LocalError("org members.setRole requires a principalId", "setting member role");
    if (!role) throw new LocalError("org members.setRole requires a role", "setting member role");
    return this.client.request<MemberMutationResult>(
      `/orgs/v1/${encodeURIComponent(this.orgId)}/members/${encodeURIComponent(principalId)}`,
      { method: "PATCH", body: { role }, context: "setting member role" },
    );
  }

  /**
   * Revoke a member (`DELETE …/members/:principal_id`) — one row, status
   * `revoked`, no key rotation. Requires `owner`; revoking the org's only active
   * owner fails with `409 LAST_OWNER`.
   */
  async revoke(principalId: string): Promise<MemberRevokeResult> {
    if (!principalId) throw new LocalError("org members.revoke requires a principalId", "revoking org member");
    return this.client.request<MemberRevokeResult>(
      `/orgs/v1/${encodeURIComponent(this.orgId)}/members/${encodeURIComponent(principalId)}`,
      { method: "DELETE", context: "revoking org member" },
    );
  }

  /**
   * gitvault-agent-envelopes D3 — an OWNER revokes a member's current gitvault
   * encryption key (`DELETE /orgs/v1/:org_id/members/:principal_id/encryption-key`,
   * owner + step-up). The independent-credential rotation path: a member whose
   * keystore was lost or rebuilt cannot self-rotate (the asking credential is
   * the one a thief would hold); after this, the member's next gitvault
   * operation enrolls its current keystore key afresh and a key-holder's next
   * operation wraps each vault to it. Audited, org-feed row + mandatory
   * security notification (`gitvault_encryption_key_revoked`).
   */
  async revokeEncryptionKey(principalId: string, input: { reason?: string } = {}): Promise<MemberRevokeEncryptionKeyResult> {
    if (!principalId) throw new LocalError("org members.revokeEncryptionKey requires a principalId", "revoking a member's encryption key");
    return this.client.request<MemberRevokeEncryptionKeyResult>(
      `/orgs/v1/${encodeURIComponent(this.orgId)}/members/${encodeURIComponent(principalId)}/encryption-key`,
      { method: "DELETE", body: input.reason ? { reason: input.reason } : undefined, context: "revoking a member's encryption key" },
    );
  }
}

/** Email-invite management — `r.org(id).invites.*`. The org id is bound at construction. */
export class OrgInvites {
  constructor(private readonly client: Client, private readonly orgId: string) {}

  /** List pending email invites (`GET /orgs/v1/:org_id/invites`). Any active member. */
  async list(): Promise<OrgInvite[]> {
    const res = await this.client.request<{ invites: OrgInvite[] }>(
      `/orgs/v1/${encodeURIComponent(this.orgId)}/invites`,
      { context: "listing org invites" },
    );
    return res.invites ?? [];
  }

  /**
   * Invite a person by email (`POST …/invites`); claimed at their first login.
   * Requires `owner` (plus step-up when driven by a control-plane session).
   */
  async create(input: CreateInviteInput): Promise<OrgInvite> {
    if (!input?.email) throw new LocalError("org invites.create requires { email }", "creating org invite");
    if (!input?.role) throw new LocalError("org invites.create requires { role }", "creating org invite");
    const body: Record<string, unknown> = { email: input.email, role: input.role };
    if (input.inviteTtlHours !== undefined) body.invite_ttl_hours = input.inviteTtlHours;
    return this.client.request<OrgInvite>(
      `/orgs/v1/${encodeURIComponent(this.orgId)}/invites`,
      { method: "POST", body, context: "creating org invite" },
    );
  }

  /** Revoke a pending invite by its pending principal id (`DELETE …/invites/:principal_id`). Requires `owner`. */
  async revoke(principalId: string): Promise<OrgInviteRevokeResult> {
    if (!principalId) throw new LocalError("org invites.revoke requires a principalId", "revoking org invite");
    return this.client.request<OrgInviteRevokeResult>(
      `/orgs/v1/${encodeURIComponent(this.orgId)}/invites/${encodeURIComponent(principalId)}`,
      { method: "DELETE", context: "revoking org invite" },
    );
  }
}

/**
 * A resource-scoped org sub-client returned by `r.org(id)`. The org id is bound
 * at construction; instance operations take no repeated id argument. Mirrors the
 * project-scoped `r.project(id)` shape (narrower scope).
 */
export class ScopedOrg {
  /** Member management (`r.org(id).members.*`). */
  readonly members: OrgMembers;
  /** Email-invite management (`r.org(id).invites.*`). */
  readonly invites: OrgInvites;
  /** The org id this sub-client is bound to. Read-only. */
  readonly orgId: string;

  constructor(private readonly client: Client, orgId: string) {
    if (!orgId) throw new LocalError("r.org(id) requires an org id", "scoping client to org");
    this.orgId = orgId;
    this.members = new OrgMembers(client, orgId);
    this.invites = new OrgInvites(client, orgId);
  }

  /**
   * Read this org (`GET /orgs/v1/:org_id`) — `{ org_id, display_name, tier,
   * lease_started_at, lease_expires_at, role }`.
   * Any active member may view; a non-member (including a guessed id) gets the
   * same non-revealing `403`.
   */
  async get(): Promise<OrgDetail> {
    return this.client.request<OrgDetail>(`/orgs/v1/${encodeURIComponent(this.orgId)}`, {
      context: "reading org",
    });
  }

  /**
   * Rename this org (`PATCH /orgs/v1/:org_id`). Owner-only + step-up gated. Pass
   * `null` or `""` to clear the label. Returns the updated `{ org_id,
   * display_name, tier, lease_started_at, lease_expires_at }`.
   */
  async rename(displayName: string | null): Promise<OrgSummary> {
    return this.client.request<OrgSummary>(`/orgs/v1/${encodeURIComponent(this.orgId)}`, {
      method: "PATCH",
      body: { display_name: displayName },
      context: "renaming org",
    });
  }

  /**
   * Claim or rename this org's address-form slug
   * (`POST /orgs/v1/:org_id/slug`, repo-first-onramp design D6). Owner-only.
   * A genesis claim (this org had no prior slug) debits `~$1` (the payable
   * claim fee, ruins bulk-squatting economics) and is a paid, side-effecting
   * mutation — REQUIRES `Idempotency-Key`, which this method generates
   * client-side (a fresh one per call) unless `opts.idempotencyKey` is
   * supplied, so a retried call after a dropped response cannot double-bill.
   * A rename releases the OLD slug into its ~90-day cooldown (typed
   * `SLUG_RELEASED` refusal on the old slug thereafter, naming this org's
   * new one as successor — never a redirect). `created` is `true` for a
   * genesis claim, `false` for a rename or an idempotent no-op replay of the
   * SAME target slug.
   */
  async claimSlug(slug: string, opts: { idempotencyKey?: string } = {}): Promise<ClaimOrgSlugResult> {
    if (!slug) {
      throw new LocalError("org.claimSlug requires a non-empty slug", "claiming org slug");
    }
    return this.client.request<ClaimOrgSlugResult>(`/orgs/v1/${encodeURIComponent(this.orgId)}/slug`, {
      method: "POST",
      body: { slug },
      headers: { "Idempotency-Key": opts.idempotencyKey ?? randomIdempotencyKey() },
      context: "claiming org slug",
    });
  }

  /**
   * Set or clear the default payout wallet for tenant priced routes
   * (`PATCH /orgs/v1/:org_id/payout-wallet`). Requires org admin/owner plus
   * server-side step-up or fresh SIWX. The wallet must already be active and
   * linked to this org; pass `null` to clear the explicit default.
   */
  async setPayoutWallet(input: SetPayoutWalletInput): Promise<SetPayoutWalletResult> {
    if (!input || !("walletAddress" in input)) {
      throw new LocalError(
        "org.setPayoutWallet requires { walletAddress } (use null to clear)",
        "setting org payout wallet",
      );
    }
    return this.client.request<SetPayoutWalletResult>(
      `/orgs/v1/${encodeURIComponent(this.orgId)}/payout-wallet`,
      {
        method: "PATCH",
        body: { wallet_address: input.walletAddress },
        context: "setting org payout wallet",
      },
    );
  }

  /**
   * Control-plane audit trail for this org (`GET /orgs/v1/:org_id/audit`).
   * admin+. Newest-first; page forward with the `after` keyset cursor
   * (`next_cursor` from a prior page) — the legacy `before` cursor is still
   * accepted. Returns `{ events, has_more, next_cursor }`.
   */
  async audit(opts: AuditOptions = {}): Promise<AuditResult> {
    const parts: string[] = [];
    if (opts.limit !== undefined) parts.push(`limit=${encodeURIComponent(String(opts.limit))}`);
    if (opts.after !== undefined) parts.push(`after=${encodeURIComponent(opts.after)}`);
    if (opts.before !== undefined) parts.push(`before=${encodeURIComponent(opts.before)}`);
    const q = parts.join("&");
    const base = `/orgs/v1/${encodeURIComponent(this.orgId)}/audit`;
    const res = await this.client.request<{
      events?: AuditEvent[];
      has_more?: boolean;
      next_cursor?: string | null;
    }>(q ? `${base}?${q}` : base, { context: "reading org audit trail" });
    return {
      events: res.events ?? [],
      has_more: res.has_more ?? false,
      next_cursor: res.next_cursor ?? null,
    };
  }
}

/**
 * Org collection + identity — `r.orgs.*`. Operations that are not bound to a
 * single org: create a new org, list the caller's orgs, resolve the principal.
 */
export class Orgs {
  constructor(private readonly client: Client) {}

  /**
   * Create an empty org on the `prototype` tier (`POST /orgs/v1`); the caller
   * becomes `owner`. Accepts only an optional `displayName` — there is no tier
   * input at create. The response reports the created org's tier/lease state.
   * Step-up gated; the soft per-owner
   * free-org cap may return `FREE_ORG_OWNER_LIMIT_EXCEEDED`.
   */
  async create(input: CreateOrgInput = {}): Promise<OrgSummary> {
    const body: Record<string, unknown> = {};
    if (input.displayName !== undefined) body.display_name = input.displayName;
    return this.client.request<OrgSummary>("/orgs/v1", {
      method: "POST",
      body,
      context: "creating organization",
    });
  }

  /** List the orgs the caller is an active member of (`GET /orgs/v1`), as memberships. */
  async list(): Promise<OrgMembership[]> {
    const res = await this.client.request<{ orgs: OrgMembership[] }>("/orgs/v1", {
      context: "listing organizations",
    });
    return res.orgs ?? [];
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
}
