/**
 * `transfers` namespace — the unified project-transfer noun (v1.93+;
 * owned-org recipient shape v1.96+).
 *
 * Exposed as `r.admin.transfers.*`. Project transfer is ONE capability,
 * body-discriminated by recipient kind: a wallet recipient (`toWallet`, SIWX
 * bilateral signing), an email recipient (`toEmail`, the recipient accepts into
 * an org), or an owned org recipient (`toOrgId`, same-actor org move). All ride
 * the same `/transfers` surface — there is no separate `/handoffs` noun (the
 * gateway removed it in `unify-project-transfer-surface`).
 *
 * Gateway endpoints:
 *   POST /projects/v1/:project_id/transfers      — initiate; body { to_wallet } XOR { to_email } XOR { to_org_id }
 *   GET  /agent/v1/transfers/incoming            — inbox (pending kinds, unioned)
 *   GET  /agent/v1/transfers/outgoing            — outbox (pending kinds, unioned)
 *   GET  /agent/v1/transfers/:transfer_id        — preview (kind-agnostic)
 *   POST /agent/v1/transfers/:transfer_id/accept — the ONE completion; the row's recipient kind
 *                                                  picks the credential (wallet: to_wallet's SIWX;
 *                                                  email: a principal whose verified email matches,
 *                                                  body { org_id?, accept_retained_member? })
 *   POST /agent/v1/transfers/:transfer_id/cancel — cancel (kind-agnostic)
 *
 * Owner-side mutations against a project with a pending transfer return
 * 409 `PROJECT_HAS_PENDING_TRANSFER`. The SDK kernel surfaces that as
 * {@link TransferFreezeError} so agents can guide the user to cancel. Accepting
 * with the wrong credential for a row's kind (e.g. a wallet signature on an
 * email-addressed row) returns 409 `WRONG_COMPLETION_FOR_TRANSFER_KIND`; the
 * thrown error exposes an `accept_transfer` next action naming the credential
 * the row needs, on the SAME `transfer_id`.
 */

import type { OperationActorSnapshot, PrincipalRepresentation } from "./identity-links.types.js";

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";

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
  retainMember?: never;
}

/** Initiate a transfer addressed to an email (the recipient accepts into an org via `accept`). */
export interface InitiateEmailTransferInput {
  /** Project id to transfer. Caller must currently own/admin it. */
  projectId: string;
  /** Recipient email; accepted by a principal whose verified email matches. */
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
   * recipient must explicitly accept it at accept time (see
   * {@link AcceptTransferOptions.acceptRetainedMember}); omitting this is a
   * full severance, the default.
   */
  retainMember?: { role: "developer" } | null;
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
  retainMember?: never;
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

/** Result of an email-addressed `initiate`. The recipient completes via `accept`. */
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
  /** The org the project left. */
  from_org_id: string;
  /** The org that now owns the project. */
  to_org_id: string;
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

/** Result of accepting a WALLET-addressed transfer. */
export interface AcceptWalletTransferResult {
  project_id: string;
  from_wallet: string;
  to_wallet: string;
  new_org_id: string | null;
  completed_at: string;
  /** New owner's project anon key (stateless JWT). The SDK persists it on accept. */
  anon_key: string;
  /** New owner's project service key (stateless JWT). Full project access; persisted on accept. */
  service_key: string;
  secrets_rotation_advised: true;
  /** Names of secrets that carried over with the project. Values are never returned. */
  secret_names_inherited: string[];
  secrets_count_inherited: number;
  /** Verbatim reminder that GitHub repo ownership is NOT part of the transfer. */
  github_repo_note: string;
}

/**
 * Result of accepting an EMAIL-addressed transfer. Symmetric with the wallet
 * result: the completion returns the new owner's project keys
 * (`project-transfer-accept-credentials`), and `accept` persists them to the
 * keystore so the new owner can operate the project immediately.
 */
export interface AcceptEmailTransferResult {
  status: "accepted";
  project_id: string;
  to_org_id: string;
  created_new_org: boolean;
  /**
   * The sender's principal id retained as a `developer` of the new org, or
   * `null` when no membership was retained (declined, not offered, or no-op).
   */
  retained_member_principal_id: string | null;
  /** Present when the gateway reports the credential rotation it performed. */
  credentials_revoked?: boolean;
  credentials_issued?: boolean;
  /** New owner's project anon key (stateless `project_id`-derived JWT). `accept` persists it. */
  anon_key: string;
  /** New owner's project service key (stateless `project_id`-derived JWT). Full project access; persisted on accept. */
  service_key: string;
}

/** Result of {@link Transfers.accept} — the row's recipient kind decides which shape comes back. */
export type AcceptTransferResult = AcceptWalletTransferResult | AcceptEmailTransferResult;

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
 * `to_email` + `from_org_id`; future org rows carry `to_org_id`.
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
  from_org_id?: string | null;
  /** Org rows only (future non-same-actor org transfers). */
  to_org_id?: string;
  initiated_by?: OperationActorSnapshot | null;
  source_organization?: { org_id: string } | null;
  destination_organization?: { org_id: string } | null;
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

/** One priced route the recipient org must be able to receive payouts for. */
export interface PricedTransferRouteSummary {
  pattern: string;
  methods: string[] | null;
  target_function: string | null;
  amount_usd_micros: number;
  networks: string[];
  pay_to: "org_default_payout";
}

/**
 * Whether the receiving org can take the project's priced-route payouts.
 * `required` / `ambiguous` block acceptance with `RECIPIENT_PAYOUT_WALLET_REQUIRED`,
 * whose details repeat `recipient_org_id` and `next_actions`.
 */
export interface RecipientPricedRoutePayoutCheck {
  required: boolean;
  status: "not_required" | "ready" | "recipient_org_unknown" | "required" | "ambiguous";
  code: string | null;
  project_id: string;
  current_release_id: string | null;
  recipient_org_id: string | null;
  priced_routes: PricedTransferRouteSummary[];
  resolved_wallet_address: string | null;
  payout_failure_code: string | null;
  message: string | null;
  next_actions: Array<{ type: string; method: string; path: string; auth: string; why: string }>;
}

export interface BillingImplications {
  from_org_id: string | null;
  target_org_id: string | null;
  tier: string | null;
  secrets_count: number;
  functions_count: number;
  custom_domains_count: number;
}

/**
 * The sender-retained-membership offer block on an email transfer preview,
 * or `null` when the sender requested no retention. `accept_field` names the
 * accept body field the recipient sets to accept
 * (`"accept_retained_member"`).
 */
export interface RetainMemberPreview {
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
 * and org rows; `to_email` and `retain_member` are populated on email
 * rows, while org rows carry `to_org_id` when returned.
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
  /** Whether the receiving org can take priced-route payouts after the transfer. */
  priced_route_payout?: RecipientPricedRoutePayoutCheck;
  /** Sender-retained-membership offer (email rows), or `null` when none was requested. */
  retain_member?: RetainMemberPreview | null;
  initiated_by?: OperationActorSnapshot | null;
  source_organization?: { org_id: string } | null;
  destination_organization?: { org_id: string } | null;
  recipient_principal?: PrincipalRepresentation | null;
}

// ─── Accept options ─────────────────────────────────────────────────────────

/** Options to {@link Transfers.accept}; both fields apply to EMAIL-addressed rows only. */
export interface AcceptTransferOptions {
  /** Org to receive the project. Omit to create a brand-new wallet-less org. */
  orgId?: string;
  /**
   * Accept the sender's retained-`developer`-membership offer (see the
   * preview's `retain_member` block). Only an explicit `true` materializes the
   * membership in the new org; omitting it (the default) is a full severance.
   */
  acceptRetainedMember?: boolean;
}

// ─── Class ───────────────────────────────────────────────────────────────────

export class Transfers {
  constructor(private readonly client: Client) {}

  /**
   * Initiate a project transfer — addressed to a wallet (`toWallet`), an email
   * (`toEmail`), OR an owned org (`toOrgId`), exactly one. Caller must
   * currently own/admin `projectId` (gateway re-reads owner from DB, not cache).
   * Wallet/email recipients create a `pending` row with a 72h expiry and freeze
   * owner-side mutations until accepted/cancelled/expired. The first
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
      rejectDefinedField(input, "retainMember", "org");
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
      const retain = (input as InitiateEmailTransferInput).retainMember;
      if (retain !== undefined) body.retain_member = retain;
      return this.client.request<InitiateEmailTransferResult>(path, {
        method: "POST",
        body,
        context: "initiating project transfer",
      });
    }
    const w = input as InitiateWalletTransferInput;
    rejectDefinedField(w, "retainMember", "wallet");
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
   * email rows — the `retain_member` offer.
   */
  async preview(transferId: string): Promise<ProjectTransferPreview> {
    return this.client.request<ProjectTransferPreview>(
      `/agent/v1/transfers/${encodeURIComponent(transferId)}`,
      { context: "previewing project transfer" },
    );
  }

  /**
   * Accept an incoming transfer — the ONE completion, whatever the row's
   * address. A wallet-addressed row is accepted by the `to_wallet`'s SIWX
   * signature; an email-addressed row by a principal (sign-in session or
   * SIWX) whose verified email matches, into an org it owns (`orgId`) or,
   * omitted, a newly created wallet-less org. Both paths run the same atomic
   * transaction: ownership flip, grant/CI revoke, notification enqueue, the
   * persistent `secrets_rotation_advised` advisory, and an audit row. Both
   * return the new owner's project keys, which `accept` persists to the
   * keystore so the new owner can operate the project immediately.
   */
  async accept(transferId: string, opts: AcceptTransferOptions = {}): Promise<AcceptTransferResult> {
    const body: Record<string, unknown> = {};
    if (opts.orgId !== undefined) body.org_id = opts.orgId;
    if (opts.acceptRetainedMember !== undefined) body.accept_retained_member = opts.acceptRetainedMember;
    const result = await this.client.request<AcceptTransferResult>(
      `/agent/v1/transfers/${encodeURIComponent(transferId)}/accept`,
      {
        method: "POST",
        body,
        context: "accepting project transfer",
      },
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
  async cancel(transferId: string, opts?: CancelTransferOptions): Promise<CancelTransferResult> {
    const reason = opts?.reason;
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
  field: "billingPolicy" | "kysignedRecordId" | "retainMember",
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
