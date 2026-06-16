/**
 * `transfers` namespace — two-party SIWX-signed project transfer (v1.59).
 *
 * Exposed as `r.admin.transfers.*`. Phase 1A surface: initiate (owner-only),
 * preview, accept (recipient), cancel (either party), and incoming/outgoing
 * inboxes. The handoff is atomic at accept time: ownership flips, CI
 * bindings are revoked, secret names carry over (values are NOT visible to
 * the recipient before accept), and the project is decorated with a
 * persistent `secrets_rotation_advised` advisory.
 *
 * Gateway endpoints:
 *   POST /projects/v1/:project_id/transfers      — A initiates
 *   GET  /agent/v1/transfers/incoming            — B's inbox
 *   GET  /agent/v1/transfers/outgoing            — A's outbox
 *   GET  /agent/v1/transfers/:transfer_id        — preview (either party)
 *   POST /agent/v1/transfers/:transfer_id/accept — B accepts
 *   POST /agent/v1/transfers/:transfer_id/cancel — either party cancels
 *
 * Owner-side mutations against a project with a pending transfer return
 * 409 `PROJECT_HAS_PENDING_TRANSFER`. The SDK kernel surfaces that as
 * {@link TransferFreezeError} so agents can guide the user to cancel.
 */

import type { Client } from "../kernel.js";

// ─── Shared types ────────────────────────────────────────────────────────────

/** Phase 1A only supports the `migrate` policy — B's wallet must already be on a organization, and the project moves into it. */
export type TransferBillingPolicy = "migrate";

export type TransferStatus = "pending" | "accepted" | "cancelled" | "expired";

export type TransferCancelledBy = "from_wallet" | "to_wallet" | "system";

/** Inputs to `r.admin.transfers.initiate(...)`. */
export interface InitiateTransferInput {
  /** Project id to transfer. Caller must currently own it (gateway re-checks against fresh DB, not cache). */
  projectId: string;
  /** Recipient wallet (any case — gateway lowercases). Must differ from the current owner. */
  toWallet: string;
  /**
   * Billing policy. Defaults to `"migrate"`. Phase 1A only supports
   * `"migrate"`; future phases may add `"inherit"` as a separate spec.
   */
  billingPolicy?: TransferBillingPolicy;
  /** Optional free-text note shown to the recipient in the preview + emails (HTML-escaped server-side). */
  message?: string;
  /** Optional KySigned record id (Phase 1A: informational only, stored verbatim, not verified). */
  kysignedRecordId?: string;
}

export interface InitiateTransferResult {
  transfer_id: string;
  expires_at: string;
  project_summary: {
    project_id: string;
    project_name: string | null;
    billing_policy: TransferBillingPolicy;
    from_wallet: string;
    to_wallet: string;
  };
  your_unused_lease_days: number;
  lease_refundable: false;
  terms_sha256: string;
}

export interface AcceptTransferResult {
  project_id: string;
  from_wallet: string;
  to_wallet: string;
  new_organization_id: string | null;
  completed_at: string;
  secrets_rotation_advised: true;
  /** Names of secrets that carried over with the project. Values are never returned. */
  secret_names_inherited: string[];
  secrets_count_inherited: number;
  /** Verbatim reminder that GitHub repo ownership is NOT part of the transfer. */
  github_repo_note: string;
}

export interface CancelTransferResult {
  transfer_id: string;
  status: "cancelled";
  cancelled_by: TransferCancelledBy;
  cancellation_reason: string | null;
  cancelled_at: string;
}

/** Summary row used in `/agent/v1/transfers/incoming` and `/outgoing`. */
export interface TransferSummary {
  transfer_id: string;
  project_id: string;
  project_name_snapshot: string | null;
  from_wallet: string;
  to_wallet: string;
  billing_policy: TransferBillingPolicy;
  message: string | null;
  initiated_at: string;
  expires_at: string;
  kysigned_record_id: string | null;
  /** API path for the full preview document. */
  preview_path: string;
}

export interface ListTransfersOptions {
  /** Page size; defaults to 50 on the gateway. */
  limit?: number;
  offset?: number;
}

// ─── Preview shape (GET /agent/v1/transfers/:id) ────────────────────────────

export interface CustomDomainPreview {
  hostname: string;
  status: string | null;
}

export interface SubdomainPreview {
  name: string;
  status: string | null;
}

export interface FunctionPreview {
  name: string;
  runtime: string | null;
  timeout_ms: number | null;
  memory_mb: number | null;
  scheduled: boolean;
}

export interface MailboxSummary {
  count: number;
  slugs_truncated: string[];
}

export interface CiBindingPreview {
  id: string;
  github_repository: string | null;
  github_subject_pattern: string;
  created_at: string;
}

export interface ContractWalletPreview {
  /** Always an empty array in Phase 1A. Reserved for future project-scoped KMS wallets. */
  address: string;
  chain: string;
}

export interface BillingImplications {
  from_organization_id: string | null;
  target_organization_id: string | null;
  tier: string | null;
  secrets_count: number;
  functions_count: number;
  custom_domains_count: number;
}

export interface ProjectTransferPreview {
  transfer_id: string;
  project_id: string;
  project_name_snapshot: string | null;
  status: TransferStatus;
  from_wallet: string;
  from_wallet_display: string;
  to_wallet: string;
  to_wallet_display: string;
  billing_policy: TransferBillingPolicy;
  message: string | null;
  initiated_at: string;
  expires_at: string;
  kysigned_record_id: string | null;
  terms_sha256: string;
  custom_domains: CustomDomainPreview[];
  subdomains: SubdomainPreview[];
  functions: FunctionPreview[];
  /** Secret NAMES only — values are never returned. */
  secret_names: string[];
  mailbox_summary: MailboxSummary;
  ci_bindings_to_be_revoked: CiBindingPreview[];
  contract_wallets: ContractWalletPreview[];
  github_repo_note: string;
  billing_implications: BillingImplications;
}

// ─── Email→org handoff (v1.78) — same rail, email recipient ────────────────────

/** Inputs to {@link Transfers.initiateHandoff}. */
export interface InitiateHandoffInput {
  /** Project id to hand off. Caller must currently own it. */
  projectId: string;
  /** Recipient email; claimed at the recipient's first login. */
  toEmail: string;
  /** Optional note shown to the recipient (HTML-escaped server-side). */
  message?: string;
  /**
   * Opt in (v1.91) to retaining a `developer` membership in the recipient's org
   * after the handoff completes. Only `role: "developer"` is accepted, and the
   * subject is always the initiating owner (you can only retain yourself). The
   * recipient must explicitly accept it at claim time (see
   * {@link ClaimHandoffInput.acceptRetainedCollaborator}); omitting this is a
   * full severance, the default. Gateway rejects a bad role with
   * `INVALID_RETAIN_ROLE` and a missing actor with `RETAIN_SUBJECT_REQUIRED`.
   */
  retainCollaborator?: { role: "developer" } | null;
}

/** Result of {@link Transfers.initiateHandoff}. Forward-compatible (gateway owns the exact shape). */
export interface HandoffResult {
  transfer_id: string;
  expires_at?: string;
  [key: string]: unknown;
}

/** Summary row from `GET /agent/v1/handoffs/incoming`. Forward-compatible. */
export interface HandoffSummary {
  transfer_id: string;
  project_id: string;
  to_email?: string;
  [key: string]: unknown;
}

/**
 * The sender-retained-membership offer block on a handoff preview (v1.91), or
 * `null` when the sender requested no retention. `accept_field` names the claim
 * body field the recipient sets to accept (`"accept_retained_collaborator"`).
 */
export interface RetainCollaboratorPreview {
  principal_id: string;
  role: "developer";
  sender_label: string;
  scope: string;
  note?: string;
  accept_field: string;
  [key: string]: unknown;
}

/** Preview from `GET /agent/v1/handoffs/:transfer_id`. Forward-compatible. */
export interface ProjectHandoffPreview {
  transfer_id: string;
  project_id: string;
  status?: TransferStatus | string;
  /** v1.91 sender-retained-membership offer, or `null` when none was requested. */
  retain_collaborator?: RetainCollaboratorPreview | null;
  [key: string]: unknown;
}

/** Inputs to {@link Transfers.claimHandoff}. */
export interface ClaimHandoffInput {
  /** Org (organization) to claim into. Omit to claim into a brand-new org. */
  organizationId?: string;
  /**
   * Accept the sender's v1.91 retained-`developer`-membership offer (see the
   * handoff preview's `retain_collaborator` block). Only an explicit `true`
   * materializes the membership in the new org; omitting it (the default) is a
   * full severance.
   */
  acceptRetainedCollaborator?: boolean;
}

/** Result of {@link Transfers.claimHandoff}. Forward-compatible. */
export interface ClaimHandoffResult {
  project_id: string;
  new_organization_id?: string | null;
  /**
   * The sender's principal id retained as a `developer` of the new org (v1.91),
   * or `null` when no membership was retained (declined, not offered, or no-op).
   */
  retained_collaborator_principal_id?: string | null;
  [key: string]: unknown;
}

// ─── Class ───────────────────────────────────────────────────────────────────

export class Transfers {
  constructor(private readonly client: Client) {}

  /**
   * Initiate a two-party project transfer. Caller must currently own
   * `projectId` (gateway re-reads owner from DB, not cache). Creates a
   * `pending` row with a 72h expiry and freezes owner-side mutations on
   * the project until the transfer is accepted, cancelled, or expires.
   */
  async initiate(input: InitiateTransferInput): Promise<InitiateTransferResult> {
    const body: Record<string, unknown> = { to_wallet: input.toWallet };
    if (input.billingPolicy !== undefined) body.billing_policy = input.billingPolicy;
    if (input.message !== undefined) body.message = input.message;
    if (input.kysignedRecordId !== undefined) body.kysigned_record_id = input.kysignedRecordId;
    return this.client.request<InitiateTransferResult>(
      `/projects/v1/${encodeURIComponent(input.projectId)}/transfers`,
      {
        method: "POST",
        body,
        context: "initiating project transfer",
      },
    );
  }

  /**
   * Fetch the preview document for a pending or terminal transfer. The
   * caller must be either the `from_wallet` or the `to_wallet`; other
   * wallets receive 403. Preview lists secret NAMES (not values), custom
   * domains, functions, CI bindings that will be revoked at accept, and
   * the billing implications.
   */
  async preview(transferId: string): Promise<ProjectTransferPreview> {
    return this.client.request<ProjectTransferPreview>(
      `/agent/v1/transfers/${encodeURIComponent(transferId)}`,
      { context: "previewing project transfer" },
    );
  }

  /**
   * Accept an incoming transfer. The caller's wallet must equal the
   * transfer's `to_wallet`. The accept transaction atomically flips
   * ownership, revokes A's CI bindings on the project, enqueues
   * notifications to both parties, and stamps the persistent
   * `secrets_rotation_advised` advisory on the project.
   */
  async accept(transferId: string): Promise<AcceptTransferResult> {
    return this.client.request<AcceptTransferResult>(
      `/agent/v1/transfers/${encodeURIComponent(transferId)}/accept`,
      {
        method: "POST",
        body: {},
        context: "accepting project transfer",
      },
    );
  }

  /**
   * Cancel a pending transfer. The caller must be either the `from_wallet`
   * or the `to_wallet`. Already-accepted/cancelled/expired transfers
   * return 409 `TRANSFER_ALREADY_PROCESSED`.
   */
  async cancel(transferId: string, reason?: string): Promise<CancelTransferResult> {
    const body: Record<string, unknown> = {};
    if (reason !== undefined) body.reason = reason;
    return this.client.request<CancelTransferResult>(
      `/agent/v1/transfers/${encodeURIComponent(transferId)}/cancel`,
      {
        method: "POST",
        body,
        context: "cancelling project transfer",
      },
    );
  }

  /** Pending transfers OFFERED TO the authenticated wallet. */
  async listIncoming(opts: ListTransfersOptions = {}): Promise<TransferSummary[]> {
    const q = buildPagination(opts);
    const path = q ? `/agent/v1/transfers/incoming?${q}` : "/agent/v1/transfers/incoming";
    const res = await this.client.request<{ transfers: TransferSummary[] }>(path, {
      context: "listing incoming transfers",
    });
    return res.transfers;
  }

  /** Pending transfers INITIATED BY the authenticated wallet. */
  async listOutgoing(opts: ListTransfersOptions = {}): Promise<TransferSummary[]> {
    const q = buildPagination(opts);
    const path = q ? `/agent/v1/transfers/outgoing?${q}` : "/agent/v1/transfers/outgoing";
    const res = await this.client.request<{ transfers: TransferSummary[] }>(path, {
      context: "listing outgoing transfers",
    });
    return res.transfers;
  }

  // ── Email→org handoff (v1.78) ─────────────────────────────────────────────
  // Same transfer rail, but the recipient is an EMAIL (resolved to an org at
  // claim time) rather than a wallet. The caller must own the project; the
  // recipient claims into an org they own (or a brand-new one). Exposed under
  // the same `transfer` noun on the CLI (`transfer init --to <email>`).

  /**
   * Initiate an email→org handoff of `projectId` to `toEmail`. Like a wallet
   * transfer, freezes owner-side mutations until the recipient claims, the
   * sender cancels, or it expires.
   */
  async initiateHandoff(input: InitiateHandoffInput): Promise<HandoffResult> {
    const body: Record<string, unknown> = { to_email: input.toEmail };
    if (input.message !== undefined) body.message = input.message;
    if (input.retainCollaborator !== undefined) body.retain_collaborator = input.retainCollaborator;
    return this.client.request<HandoffResult>(
      `/projects/v1/${encodeURIComponent(input.projectId)}/handoffs`,
      { method: "POST", body, context: "initiating project handoff" },
    );
  }

  /** Pending handoffs addressed to the authenticated principal's email. */
  async listIncomingHandoffs(): Promise<HandoffSummary[]> {
    const res = await this.client.request<{ handoffs?: HandoffSummary[]; transfers?: HandoffSummary[] }>(
      "/agent/v1/handoffs/incoming",
      { context: "listing incoming handoffs" },
    );
    return res.handoffs ?? res.transfers ?? [];
  }

  /** Preview a handoff (sender, or the addressed recipient). */
  async previewHandoff(transferId: string): Promise<ProjectHandoffPreview> {
    return this.client.request<ProjectHandoffPreview>(
      `/agent/v1/handoffs/${encodeURIComponent(transferId)}`,
      { context: "previewing project handoff" },
    );
  }

  /**
   * Claim an incoming handoff into an org. Omit `organizationId` to claim
   * into a brand-new org. The claim atomically flips ownership (the handoff
   * analog of {@link Transfers.accept}).
   */
  async claimHandoff(transferId: string, input: ClaimHandoffInput = {}): Promise<ClaimHandoffResult> {
    const body: Record<string, unknown> = {};
    if (input.organizationId !== undefined) body.organization_id = input.organizationId;
    if (input.acceptRetainedCollaborator !== undefined) {
      body.accept_retained_collaborator = input.acceptRetainedCollaborator;
    }
    return this.client.request<ClaimHandoffResult>(
      `/agent/v1/handoffs/${encodeURIComponent(transferId)}/claim`,
      { method: "POST", body, context: "claiming project handoff" },
    );
  }

  /** Cancel a pending handoff (sender or recipient). */
  async cancelHandoff(transferId: string): Promise<CancelTransferResult> {
    return this.client.request<CancelTransferResult>(
      `/agent/v1/handoffs/${encodeURIComponent(transferId)}/cancel`,
      { method: "POST", body: {}, context: "cancelling project handoff" },
    );
  }
}

function buildPagination(opts: ListTransfersOptions): string {
  const parts: string[] = [];
  if (opts.limit !== undefined) parts.push(`limit=${encodeURIComponent(String(opts.limit))}`);
  if (opts.offset !== undefined) parts.push(`offset=${encodeURIComponent(String(opts.offset))}`);
  return parts.join("&");
}
