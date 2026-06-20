/**
 * `transfers` namespace — the unified project-transfer noun (v1.93+;
 * owned-org recipient shape v1.96+).
 *
 * Exposed as `r.admin.transfers.*`. Project transfer is ONE capability,
 * body-discriminated by recipient kind: a wallet recipient (`toWallet`, SIWX
 * bilateral signing), an email recipient (`toEmail`, the recipient claims into
 * an org), or an owned org recipient (`toOrgId`, same-actor org move). All ride
 * the same `/transfers` surface — there is no separate `/handoffs` noun (the
 * gateway removed it in `unify-project-transfer-surface`).
 *
 * Gateway endpoints:
 *   POST /projects/v1/:project_id/transfers      — initiate; body { to_wallet } XOR { to_email } XOR { to_org_id }
 *   GET  /agent/v1/transfers/incoming            — inbox (pending kinds, unioned)
 *   GET  /agent/v1/transfers/outgoing            — outbox (pending kinds, unioned)
 *   GET  /agent/v1/transfers/:transfer_id        — preview (kind-agnostic)
 *   POST /agent/v1/transfers/:transfer_id/accept — WALLET completion (recipient SIWX-signs)
 *   POST /agent/v1/transfers/:transfer_id/claim  — EMAIL completion (recipient claims into an org)
 *   POST /agent/v1/transfers/:transfer_id/cancel — cancel (kind-agnostic)
 *
 * Owner-side mutations against a project with a pending transfer return
 * 409 `PROJECT_HAS_PENDING_TRANSFER`. The SDK kernel surfaces that as
 * {@link TransferFreezeError} so agents can guide the user to cancel. Calling
 * the wrong completion for a row's kind (e.g. `accept` on an email row) returns
 * 409 `WRONG_COMPLETION_FOR_TRANSFER_KIND`; the thrown error exposes
 * `nextActions` pointing at the sibling completion on the SAME `transfer_id`.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import { deprecatePositional } from "../deprecate.js";

// ─── Shared types ────────────────────────────────────────────────────────────

/** Phase 1A only supports the `migrate` policy — B's wallet must already be on a organization, and the project moves into it. */
export type TransferBillingPolicy = "migrate";

export type TransferStatus = "pending" | "accepted" | "cancelled" | "expired";

export type TransferCancelledBy = "from_wallet" | "to_wallet" | "system";

/** Which kind of recipient a transfer row is addressed to. */
export type RecipientKind = "wallet" | "email" | "org";

/** Options for {@link Transfers.cancel} — the canonical `cancel(transferId, { reason })` shape. */
export interface CancelTransferOptions {
  /** Optional free-text cancellation reason recorded on the transfer row. */
  reason?: string;
}

/** Initiate a transfer addressed to a wallet (two-party SIWX completion via `accept`). */
export interface InitiateWalletTransferInput {
  /** Project id to transfer. Caller must currently own/admin it (gateway re-checks against fresh DB, not cache). */
  projectId: string;
  /** Recipient wallet (any case — gateway lowercases). Must differ from the current owner. */
  toWallet: string;
  /** Mutually exclusive with {@link InitiateWalletTransferInput.toWallet}; not allowed on the wallet path. */
  toEmail?: never;
  /** Mutually exclusive with {@link InitiateWalletTransferInput.toWallet}; not allowed on the wallet path. */
  toOrgId?: never;
  /**
   * Billing policy. Defaults to `"migrate"`. Phase 1A only supports
   * `"migrate"`; future phases may add `"inherit"` as a separate spec.
   */
  billingPolicy?: TransferBillingPolicy;
  /** Optional free-text note shown to the recipient in the preview + emails (HTML-escaped server-side). */
  message?: string;
  /** Optional KySigned record id (Phase 1A: informational only, stored verbatim, not verified). */
  kysignedRecordId?: string;
  /** Retention is an email-only opt-in; not allowed on the wallet path. */
  retainCollaborator?: never;
}

/** Initiate a transfer addressed to an email (the recipient claims into an org via `claim`). */
export interface InitiateEmailTransferInput {
  /** Project id to transfer. Caller must currently own/admin it. */
  projectId: string;
  /** Recipient email; claimed at the recipient's first verified login. */
  toEmail: string;
  /** Mutually exclusive with {@link InitiateEmailTransferInput.toEmail}; not allowed on the email path. */
  toWallet?: never;
  /** Mutually exclusive with {@link InitiateEmailTransferInput.toEmail}; not allowed on the email path. */
  toOrgId?: never;
  /** Optional note shown to the recipient (HTML-escaped server-side). */
  message?: string;
  /**
   * Opt in (v1.91) to retaining a `developer` membership in the recipient's org
   * after the transfer completes. Only `role: "developer"` is accepted, and the
   * subject is always the initiating owner (you can only retain yourself). The
   * recipient must explicitly accept it at claim time (see
   * {@link ClaimTransferInput.acceptRetainedCollaborator}); omitting this is a
   * full severance, the default.
   */
  retainCollaborator?: { role: "developer" } | null;
  /** Billing policy is wallet-path only; not allowed on the email path. */
  billingPolicy?: never;
  /** KySigned record id is wallet-path only; not allowed on the email path. */
  kysignedRecordId?: never;
}

/** Initiate an immediate move to an organization the caller already owns. */
export interface InitiateOrgTransferInput {
  /** Project id to transfer. Caller must be an active owner of the source org. */
  projectId: string;
  /**
   * Destination organization id. The first gateway release is same-actor only:
   * caller must be an active owner of both source and destination orgs.
   */
  toOrgId: string;
  /** Mutually exclusive with {@link InitiateOrgTransferInput.toOrgId}; not allowed on the org path. */
  toWallet?: never;
  /** Mutually exclusive with {@link InitiateOrgTransferInput.toOrgId}; not allowed on the org path. */
  toEmail?: never;
  /** Optional free-text note recorded with the transfer audit row. */
  message?: string;
  /** Billing policy is wallet-path only; not allowed on the org path. */
  billingPolicy?: never;
  /** KySigned record id is wallet-path only; not allowed on the org path. */
  kysignedRecordId?: never;
  /** Retention is an email-only opt-in; not allowed on the org path. */
  retainCollaborator?: never;
}

/** Inputs to `r.admin.transfers.initiate(...)` — wallet XOR email XOR org. */
export type InitiateTransferInput =
  | InitiateWalletTransferInput
  | InitiateEmailTransferInput
  | InitiateOrgTransferInput;

/** Result of a wallet-addressed `initiate`. */
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

/** Result of an email-addressed `initiate`. The recipient completes via `claim`. */
export interface InitiateEmailTransferResult {
  status: "ok";
  transfer_id: string;
  to_email: string;
  expires_at: string;
}

/**
 * Result of an owned-org `initiate`. Same-actor org moves complete
 * synchronously in the first gateway release and return project keys so the
 * caller can continue operating the project without a follow-up fetch.
 */
export interface InitiateOrgTransferResult {
  status: "accepted";
  project_id: string;
  to_organization_id: string;
  /** Echo of the requested org id when a gateway chooses the shorter wire key. */
  to_org_id?: string;
  /** Present when the gateway materializes an audit transfer row. */
  transfer_id?: string;
  /** Present when the gateway returns the completion timestamp inline. */
  completed_at?: string;
  anon_key: string;
  service_key: string;
  secrets_rotation_advised?: true;
  secret_names_inherited?: string[];
  secrets_count_inherited?: number;
  github_repo_note?: string;
  [key: string]: unknown;
}

export interface AcceptTransferResult {
  project_id: string;
  from_wallet: string;
  to_wallet: string;
  new_organization_id: string | null;
  completed_at: string;
  /** New owner's project anon key (stateless JWT) — #428. The SDK persists it on accept. */
  anon_key: string;
  /** New owner's project service key (stateless JWT) — #428. Full project access; persisted on accept. */
  service_key: string;
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

/**
 * Summary row used in `/agent/v1/transfers/incoming` and `/outgoing`. The list
 * is kind-agnostic: `recipient_kind` discriminates wallet, email, and future
 * org rows. Wallet rows carry `from_wallet`/`to_wallet`; email rows carry
 * `to_email` + `from_organization_id`; future org rows carry `to_org_id` /
 * `to_organization_id`.
 */
export interface TransferSummary {
  transfer_id: string;
  project_id: string;
  project_name_snapshot: string | null;
  recipient_kind: RecipientKind;
  billing_policy: TransferBillingPolicy;
  message: string | null;
  expires_at: string;
  /** API path for the full preview document. */
  preview_path: string;
  /** Wallet rows only. */
  from_wallet?: string;
  /** Wallet rows only; `null`/absent for email rows. */
  to_wallet?: string | null;
  /** Wallet rows only. */
  initiated_at?: string;
  /** Wallet rows only. */
  kysigned_record_id?: string | null;
  /** Email rows only. */
  to_email?: string;
  /** Email rows only. */
  from_organization_id?: string | null;
  /** Org rows only (future non-same-actor org transfers). */
  to_org_id?: string;
  /** Org rows only (canonical gateway field when present). */
  to_organization_id?: string;
}

export interface ListTransfersOptions {
  /** Page size; defaults to 50 on the gateway. */
  limit?: number;
  /** Opaque keyset cursor — page forward from a prior page's `next_cursor`. */
  after?: string;
}

/** Result of {@link Transfers.listIncoming} / {@link Transfers.listOutgoing} — a keyset page. */
export interface ListTransfersResult {
  transfers: TransferSummary[];
  has_more: boolean;
  next_cursor: string | null;
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

export interface SignerPreview {
  /** Always an empty array in Phase 1A. Reserved for future project-scoped KMS signers. */
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

/**
 * The sender-retained-membership offer block on an email transfer preview
 * (v1.91), or `null` when the sender requested no retention. `accept_field`
 * names the claim body field the recipient sets to accept
 * (`"accept_retained_collaborator"`).
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

/**
 * Kind-agnostic preview document. Wallet-identity fields are `null` on email
 * and org rows; `to_email` and `retain_collaborator` are populated on email
 * rows, while org rows carry `to_org_id` / `to_organization_id` when returned.
 */
export interface ProjectTransferPreview {
  transfer_id: string;
  project_id: string;
  project_name_snapshot: string | null;
  status: TransferStatus;
  recipient_kind: RecipientKind;
  from_wallet: string | null;
  from_wallet_display: string | null;
  to_wallet: string | null;
  to_wallet_display: string | null;
  /** Email rows only. */
  to_email?: string;
  /** Org rows only (future non-same-actor org transfers). */
  to_org_id?: string;
  /** Org rows only (canonical gateway field when present). */
  to_organization_id?: string;
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
  signers: SignerPreview[];
  github_repo_note: string;
  billing_implications: BillingImplications;
  /** v1.91 sender-retained-membership offer (email rows), or `null` when none was requested. */
  retain_collaborator?: RetainCollaboratorPreview | null;
}

// ─── Email completion (claim) ──────────────────────────────────────────────

/** Inputs to {@link Transfers.claim}. */
export interface ClaimTransferInput {
  /** Org (organization) to claim into. Omit to claim into a brand-new org. */
  organizationId?: string;
  /**
   * Accept the sender's v1.91 retained-`developer`-membership offer (see the
   * preview's `retain_collaborator` block). Only an explicit `true`
   * materializes the membership in the new org; omitting it (the default) is a
   * full severance.
   */
  acceptRetainedCollaborator?: boolean;
}

/**
 * Result of {@link Transfers.claim}. Symmetric with wallet {@link Transfers.accept}:
 * the email completion returns the new owner's project keys
 * (`project-transfer-claim-credentials`), and `claim` persists them to the
 * keystore so the claimant can operate the project immediately.
 */
export interface ClaimTransferResult {
  status: "accepted";
  project_id: string;
  to_organization_id: string;
  created_new_org: boolean;
  /**
   * The sender's principal id retained as a `developer` of the new org (v1.91),
   * or `null` when no membership was retained (declined, not offered, or no-op).
   */
  retained_collaborator_principal_id: string | null;
  /** New owner's project anon key (stateless `project_id`-derived JWT). `claim` persists it. */
  anon_key: string;
  /** New owner's project service key (stateless `project_id`-derived JWT). Full project access; persisted on claim. */
  service_key: string;
}

// ─── Class ───────────────────────────────────────────────────────────────────

export class Transfers {
  constructor(private readonly client: Client) {}

  /**
   * Initiate a project transfer — addressed to a wallet (`toWallet`), an email
   * (`toEmail`), OR an owned org (`toOrgId`), exactly one. Caller must
   * currently own/admin `projectId` (gateway re-reads owner from DB, not cache).
   * Wallet/email recipients create a `pending` row with a 72h expiry and freeze
   * owner-side mutations until accepted/claimed/cancelled/expired. The first
   * org-recipient gateway release is same-actor only and completes immediately.
   */
  async initiate(input: InitiateWalletTransferInput): Promise<InitiateTransferResult>;
  async initiate(input: InitiateEmailTransferInput): Promise<InitiateEmailTransferResult>;
  async initiate(input: InitiateOrgTransferInput): Promise<InitiateOrgTransferResult>;
  async initiate(
    input: InitiateTransferInput,
  ): Promise<InitiateTransferResult | InitiateEmailTransferResult | InitiateOrgTransferResult> {
    const toWallet = "toWallet" in input ? input.toWallet : undefined;
    const toEmail = "toEmail" in input ? input.toEmail : undefined;
    const toOrgId = "toOrgId" in input ? input.toOrgId : undefined;
    const hasWallet = typeof toWallet === "string" && toWallet.length > 0;
    const hasEmail = typeof toEmail === "string" && toEmail.length > 0;
    const hasOrg = typeof toOrgId === "string" && toOrgId.length > 0;
    const recipientCount = Number(hasWallet) + Number(hasEmail) + Number(hasOrg);
    if (recipientCount !== 1) {
      throw new LocalError(
        "Provide exactly one of toWallet, toEmail, or toOrgId.",
        "initiating project transfer",
        { code: "VALIDATION_ERROR", details: { fields: ["toWallet", "toEmail", "toOrgId"] } },
      );
    }
    const path = `/projects/v1/${encodeURIComponent(input.projectId)}/transfers`;
    if (hasOrg) {
      rejectDefinedField(input, "billingPolicy", "org");
      rejectDefinedField(input, "kysignedRecordId", "org");
      rejectDefinedField(input, "retainCollaborator", "org");
      const body: Record<string, unknown> = { to_org_id: toOrgId };
      if (input.message !== undefined) body.message = input.message;
      const result = await this.client.request<InitiateOrgTransferResult>(path, {
        method: "POST",
        body,
        context: "initiating project transfer",
      });
      await persistProjectKeys(this.client, result);
      return result;
    }
    if (hasEmail) {
      rejectDefinedField(input, "billingPolicy", "email");
      rejectDefinedField(input, "kysignedRecordId", "email");
      const body: Record<string, unknown> = { to_email: toEmail };
      if (input.message !== undefined) body.message = input.message;
      const retain = (input as InitiateEmailTransferInput).retainCollaborator;
      if (retain !== undefined) body.retain_collaborator = retain;
      return this.client.request<InitiateEmailTransferResult>(path, {
        method: "POST",
        body,
        context: "initiating project transfer",
      });
    }
    const w = input as InitiateWalletTransferInput;
    rejectDefinedField(w, "retainCollaborator", "wallet");
    const body: Record<string, unknown> = { to_wallet: toWallet };
    if (w.billingPolicy !== undefined) body.billing_policy = w.billingPolicy;
    if (w.message !== undefined) body.message = w.message;
    if (w.kysignedRecordId !== undefined) body.kysigned_record_id = w.kysignedRecordId;
    return this.client.request<InitiateTransferResult>(path, {
      method: "POST",
      body,
      context: "initiating project transfer",
    });
  }

  /**
   * Fetch the preview document for a pending or terminal transfer of either
   * kind. The caller must be a party to it (wallet signer, addressed-email
   * principal, or offering-org member); other callers receive 403. Preview
   * lists secret NAMES (not values), custom domains, functions, CI bindings
   * that will be revoked at completion, the billing implications, and — on
   * email rows — the `retain_collaborator` offer.
   */
  async preview(transferId: string): Promise<ProjectTransferPreview> {
    return this.client.request<ProjectTransferPreview>(
      `/agent/v1/transfers/${encodeURIComponent(transferId)}`,
      { context: "previewing project transfer" },
    );
  }

  /**
   * Accept an incoming WALLET transfer. The caller's wallet must equal the
   * transfer's `to_wallet`. The accept transaction atomically flips ownership,
   * revokes A's CI bindings on the project, enqueues notifications to both
   * parties, and stamps the persistent `secrets_rotation_advised` advisory.
   */
  async accept(transferId: string): Promise<AcceptTransferResult> {
    const result = await this.client.request<AcceptTransferResult>(
      `/agent/v1/transfers/${encodeURIComponent(transferId)}/accept`,
      {
        method: "POST",
        body: {},
        context: "accepting project transfer",
      },
    );
    await persistProjectKeys(this.client, result);
    return result;
  }

  /**
   * Claim an incoming EMAIL transfer into an org. Omit `organizationId` to claim
   * into a brand-new org. The claim atomically flips ownership (the email analog
   * of {@link Transfers.accept}) and returns the new owner's project keys, which
   * `claim` persists to the keystore — symmetric with `accept` (#428 /
   * `project-transfer-claim-credentials`) — so the claimant can operate the
   * project immediately. Note the claim auth model is principal-based (a
   * control-plane session or a verified-email SIWX match), so — unlike `accept`
   * — a wallet is not assumed to be present.
   */
  async claim(transferId: string, opts: ClaimTransferInput = {}): Promise<ClaimTransferResult> {
    const body: Record<string, unknown> = {};
    if (opts.organizationId !== undefined) body.org_id = opts.organizationId;
    if (opts.acceptRetainedCollaborator !== undefined) {
      body.accept_retained_collaborator = opts.acceptRetainedCollaborator;
    }
    const result = await this.client.request<ClaimTransferResult>(
      `/agent/v1/transfers/${encodeURIComponent(transferId)}/claim`,
      { method: "POST", body, context: "claiming project transfer" },
    );
    await persistProjectKeys(this.client, result);
    return result;
  }

  /**
   * Cancel a pending transfer of any kind. The caller must be authorized for
   * the row's kind (a wallet signer, or an owner/admin of the offering org /
   * the addressed-email principal). Already-processed transfers return 409
   * `TRANSFER_ALREADY_PROCESSED`.
   */
  async cancel(transferId: string, opts?: CancelTransferOptions): Promise<CancelTransferResult>;
  /** @deprecated A bare string reason is swap-prone next to `transferId`. Use `cancel(transferId, { reason })`. */
  async cancel(transferId: string, reason: string): Promise<CancelTransferResult>;
  async cancel(transferId: string, reasonOrOpts?: string | CancelTransferOptions): Promise<CancelTransferResult> {
    let reason: string | undefined;
    if (typeof reasonOrOpts === "string") {
      deprecatePositional("transfers.cancel", "use cancel(transferId, { reason })");
      reason = reasonOrOpts;
    } else if (reasonOrOpts && typeof reasonOrOpts === "object") {
      reason = reasonOrOpts.reason;
    }
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

  /** Pending transfers OFFERED TO the caller — wallet/email/future org rows, unioned. */
  async listIncoming(opts: ListTransfersOptions = {}): Promise<ListTransfersResult> {
    const q = buildPagination(opts);
    const path = q ? `/agent/v1/transfers/incoming?${q}` : "/agent/v1/transfers/incoming";
    return this.client.request<ListTransfersResult>(path, {
      context: "listing incoming transfers",
    });
  }

  /** Pending transfers INITIATED BY the caller — wallet/email/future org rows, unioned. */
  async listOutgoing(opts: ListTransfersOptions = {}): Promise<ListTransfersResult> {
    const q = buildPagination(opts);
    const path = q ? `/agent/v1/transfers/outgoing?${q}` : "/agent/v1/transfers/outgoing";
    return this.client.request<ListTransfersResult>(path, {
      context: "listing outgoing transfers",
    });
  }
}

async function persistProjectKeys(
  client: Client,
  result: {
    project_id?: string;
    anon_key?: string;
    service_key?: string;
  },
): Promise<void> {
  if (result.project_id && result.anon_key && result.service_key) {
    const creds = client.credentials;
    if (creds.saveProject) {
      await creds.saveProject(result.project_id, {
        anon_key: result.anon_key,
        service_key: result.service_key,
      });
    }
    if (creds.setActiveProject) {
      await creds.setActiveProject(result.project_id);
    }
  }
}

function rejectDefinedField(
  input: InitiateTransferInput,
  field: "billingPolicy" | "kysignedRecordId" | "retainCollaborator",
  recipient: "wallet" | "email" | "org",
): void {
  if ((input as unknown as Record<string, unknown>)[field] !== undefined) {
    throw new LocalError(
      `${field} is not supported for ${recipient}-addressed project transfers.`,
      "initiating project transfer",
      { code: "VALIDATION_ERROR", details: { field, recipient } },
    );
  }
}

function buildPagination(opts: ListTransfersOptions): string {
  const parts: string[] = [];
  if (opts.limit !== undefined) parts.push(`limit=${encodeURIComponent(String(opts.limit))}`);
  if (opts.after !== undefined) parts.push(`after=${encodeURIComponent(opts.after)}`);
  return parts.join("&");
}
