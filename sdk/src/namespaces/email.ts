/**
 * `email` namespace — project mailboxes (defaults, send / list / get / raw /
 * delete) and mailbox webhooks.
 */

import type { Client } from "../kernel.js";
import { ApiError, LocalError } from "../errors.js";
import { requireProjectCredentials } from "../project-credentials.js";
import {
  assertEmailAddress,
  assertHttpUrl,
  assertNonEmptyString,
  assertPositiveSafeInteger,
  assertStringInSet,
} from "../validation.js";

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const WEBHOOK_EVENTS = ["delivery", "bounced", "complained", "reply_received", "mailbox_suspended"] as const;
const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
const DELIVERY_STATUSES = ["pending", "in_flight", "delivered", "failed_permanent"] as const;
const MAILBOX_FOOTER_POLICIES = ["run402_transparency", "none"] as const;

/** Direction filter for `email.list`. Omit to list both sent + received. */
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];
/** Durable webhook delivery lifecycle status. `failed_permanent` is the DLQ. */
export type WebhookDeliveryStatus = (typeof DELIVERY_STATUSES)[number];
/** Outbound footer policy configured on a mailbox. */
export type MailboxFooterPolicy = (typeof MAILBOX_FOOTER_POLICIES)[number];

export interface MailboxRecord {
  mailbox_id: string;
  /** Primary address for sends. This is custom-domain address only after DKIM is verified and inbound is enabled. */
  address: string;
  /** Immutable Run402-managed address, usually `<slug>@<project-mail-host>.mail.run402.com`. */
  managed_address?: string;
  slug: string;
  project_id: string;
  status: "active" | "suspended" | "deleted";
  sends_today: number;
  unique_recipients: number;
  created_at: string;
  updated_at: string;
  /** True when this mailbox is configured as the project's outbound default. */
  is_default_outbound?: boolean;
  /** True when this mailbox is configured as the auth/session email sender. */
  is_auth_sender?: boolean;
  /** Whether the mailbox can currently send outbound mail. */
  can_send?: boolean;
  /** Present when `can_send` is false, e.g. domain verification or suspension. */
  send_blocked_reason?: string | null;
  /** Run402-managed project mail host vs a project-owned sender domain. Future strings are valid. */
  domain_kind?: string;
  /** Domain portion of `address`. */
  address_domain?: string;
  /** Domain portion of `managed_address`. */
  managed_domain?: string;
  /** True when a custom sender domain is verified and inbound-enabled, so it can be primary. */
  custom_domain_ready?: boolean;
  /** Whether inbound mail can be received at `address`. */
  can_receive?: boolean;
  /** Configured outbound footer policy for this mailbox. */
  footer_policy?: MailboxFooterPolicy;
  /** Effective policy after tier locks/defaults are applied. */
  effective_footer_policy?: MailboxFooterPolicy;
  /** Present when the requested footer policy is locked by tier or platform policy. */
  footer_policy_locked_reason?: string | null;
}

export interface MailboxSettings {
  default_outbound_mailbox_id: string | null;
  auth_sender_mailbox_id: string | null;
}

export interface MailboxNextAction {
  type?: string;
  action?: string;
  method?: string;
  path?: string;
  auth?: string;
  why?: string;
  command?: string;
  [key: string]: unknown;
}

export interface MailboxProviderReadiness {
  status?: string;
  provider?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface MailboxSelectionEnvelope {
  mailbox_settings?: MailboxSettings;
  provider_readiness?: MailboxProviderReadiness;
  next_actions?: MailboxNextAction[];
}

export type CreateMailboxResult = MailboxRecord & MailboxSelectionEnvelope;

export type MailboxInfo = MailboxRecord;

export interface MailboxListResult extends MailboxSelectionEnvelope {
  mailboxes: MailboxRecord[];
}

export type MailboxListResponse = MailboxListResult;

export interface SetMailboxDefaultsOptions {
  default_outbound_mailbox_id?: string | null;
  auth_sender_mailbox_id?: string | null;
}

export type SetMailboxDefaultsResult = MailboxListResult;

export interface UpdateMailboxOptions {
  /** Target mailbox by slug or `mbx_...` id; omit only on single-mailbox projects. */
  mailbox?: MailboxSelector;
  /** Outbound footer policy. Prototype projects are locked to `run402_transparency`. */
  footer_policy?: MailboxFooterPolicy;
}

export type UpdateMailboxResult = MailboxInfo;

export interface DeleteMailboxResult {
  mailbox_id: string;
  address: string;
  managed_address?: string;
}

export type EmailTemplate = "project_invite" | "magic_link" | "notification";

/** Selects a target mailbox on a project: a mailbox id (`mbx_…`) or a project-scoped local-part slug. */
export type MailboxSelector = string;

/** A single binary attachment (raw mode only). `content_base64` is the file's bytes, base64-encoded. */
export interface EmailAttachment {
  filename: string;
  content_base64: string;
  content_type: string;
}

/** Attachment metadata recorded on a sent message (names/types/sizes — never the bytes). */
export interface EmailAttachmentMeta {
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface SendEmailOptions {
  to: string;
  template?: EmailTemplate;
  variables?: Record<string, string>;
  subject?: string;
  html?: string;
  text?: string;
  from_name?: string;
  /**
   * Binary attachments — RAW MODE ONLY (with `subject` + `html`, not `template`).
   * At most 5; each ≤ 7 MB and ≤ 7 MB total (decoded). The platform sends a
   * multipart/mixed MIME when present.
   */
  attachments?: EmailAttachment[];
  in_reply_to?: string;
  /**
   * Target mailbox (slug or `mbx_…` id). Omit to use the configured
   * `default_outbound_mailbox_id` when the gateway returns mailbox settings.
   * Missing or invalid defaults surface typed repair errors.
   */
  mailbox?: MailboxSelector;
}

/** Options carrying just a mailbox selector, for `get` / `getRaw` / webhook reads. */
export interface MailboxScopedOptions {
  mailbox?: MailboxSelector;
}

export interface SendEmailResult {
  message_id: string;
  status: string;
  to: string;
  template: string | null;
  subject: string | null;
  sent_at: string;
  /** The actual mailbox used for the send, echoed by the gateway. */
  mailbox_id?: string;
  /** The actual From address used for the send, echoed by the gateway. */
  from_address?: string;
}

export interface EmailSummary {
  id: string;
  /** Core gateways may expose this spelling on the wire; SDK normalizes `id`. */
  message_id?: string;
  /** "inbound" (received) or "outbound" (sent). */
  direction: string;
  template: string | null;
  to: string;
  status: string;
  created_at: string;
  /** Present (non-null) when the send carried attachments; names/types/sizes only. */
  attachments_meta?: EmailAttachmentMeta[] | null;
}

export interface EmailDetail {
  id: string;
  /** Core gateways may expose this spelling on the wire; SDK normalizes `id`. */
  message_id?: string;
  template: string | null;
  to: string;
  status: string;
  variables?: Record<string, string>;
  subject?: string | null;
  mailbox_id?: string;
  from_address?: string;
  delivery_state?: string;
  provider?: string | null;
  provider_message_id?: string | null;
  created_at: string;
  updated_at?: string;
  sent_at?: string | null;
  /** Present (non-null) when the send carried attachments; names/types/sizes only. */
  attachments_meta?: EmailAttachmentMeta[] | null;
  replies?: Array<{
    id: string;
    from: string;
    body: string;
    received_at: string;
  }>;
}

export interface ListEmailsOptions {
  limit?: number;
  after?: string;
  /**
   * Filter to one direction. Omit to list BOTH sent (outbound) and received
   * (inbound) messages — `inbound` is the reconciliation backstop for a lost
   * `reply_received` webhook.
   */
  direction?: MessageDirection;
  /** Target mailbox (slug or `mbx_…` id); omit only on single-mailbox projects. */
  mailbox?: MailboxSelector;
}

export interface RawEmailResult {
  content_type: string;
  bytes: Uint8Array;
}

export interface MailboxWebhookSummary {
  webhook_id: string;
  url: string;
  events: string[];
  created_at: string;
}

export interface MailboxWebhooksResult {
  webhooks: MailboxWebhookSummary[];
}

export interface RegisterWebhookOptions {
  url: string;
  events: string[];
  /** Target mailbox (slug or `mbx_…` id); omit only on single-mailbox projects. */
  mailbox?: MailboxSelector;
}

export interface UpdateWebhookOptions {
  url?: string;
  events?: string[];
  /** Target mailbox (slug or `mbx_…` id); omit only on single-mailbox projects. */
  mailbox?: MailboxSelector;
}

/**
 * A single durable webhook delivery row. Delivery is at-least-once: the same
 * event may arrive more than once, so consumers MUST dedupe on the envelope's
 * `idempotency_key` (also sent as the `Run402-Webhook-Id` header).
 */
export interface WebhookDeliverySummary {
  delivery_id: string;
  webhook_id: string | null;
  event_type: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface WebhookDeliveriesResult {
  deliveries: WebhookDeliverySummary[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface ListDeliveriesOptions {
  /** Filter by lifecycle status. `failed_permanent` is the dead-letter queue. */
  status?: WebhookDeliveryStatus;
  limit?: number;
  after?: string;
  /** Target mailbox (slug or `mbx_…` id); omit only on single-mailbox projects. */
  mailbox?: MailboxSelector;
}

export interface RedriveDeliveryResult {
  status: "requeued";
  delivery: WebhookDeliverySummary;
}

export class Webhooks {
  constructor(
    private readonly client: Client,
    private readonly resolveMailbox: (
      projectId: string,
      selector?: MailboxSelector,
    ) => Promise<{ id: string; serviceKey: string }>,
  ) {}

  /**
   * List durable webhook delivery rows for the mailbox, optionally filtered by
   * status. `failed_permanent` is the dead-letter queue. Delivery is
   * at-least-once — consumers MUST dedupe on the envelope `idempotency_key`.
   */
  async listDeliveries(projectId: string, opts: ListDeliveriesOptions = {}): Promise<WebhookDeliveriesResult> {
    if (opts.status !== undefined) {
      assertStringInSet(opts.status, DELIVERY_STATUSES, "status", "listing webhook deliveries");
    }
    if (opts.limit !== undefined) {
      assertPositiveSafeInteger(opts.limit, "limit", "listing webhook deliveries");
    }
    const { id, serviceKey } = await this.resolveMailbox(projectId, opts.mailbox);
    const qs = new URLSearchParams();
    if (opts.status !== undefined) qs.set("status", opts.status);
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.after) qs.set("after", opts.after);
    const path = `/mailboxes/v1/${id}/webhooks/deliveries${qs.toString() ? "?" + qs.toString() : ""}`;
    return this.client.request<WebhookDeliveriesResult>(path, {
      headers: { Authorization: `Bearer ${serviceKey}` },
      context: "listing webhook deliveries",
    });
  }

  /** Re-queue a dead-lettered (`failed_permanent`) delivery for another attempt. */
  async redriveDelivery(
    projectId: string,
    deliveryId: string,
    opts: MailboxScopedOptions = {},
  ): Promise<RedriveDeliveryResult> {
    const { id, serviceKey } = await this.resolveMailbox(projectId, opts.mailbox);
    const encodedDeliveryId = encodePathSegment(deliveryId, "deliveryId", "redriving webhook delivery");
    return this.client.request<RedriveDeliveryResult>(
      `/mailboxes/v1/${id}/webhooks/deliveries/${encodedDeliveryId}/redrive`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}` },
        context: "redriving webhook delivery",
      },
    );
  }

  async register(projectId: string, opts: RegisterWebhookOptions): Promise<MailboxWebhookSummary> {
    validateRegisterWebhookOptions(opts);
    const { id, serviceKey } = await this.resolveMailbox(projectId, opts.mailbox);
    return this.client.request<MailboxWebhookSummary>(`/mailboxes/v1/${id}/webhooks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}` },
      body: { url: opts.url, events: opts.events },
      context: "registering webhook",
    });
  }

  async list(projectId: string, opts: MailboxScopedOptions = {}): Promise<MailboxWebhooksResult> {
    const { id, serviceKey } = await this.resolveMailbox(projectId, opts.mailbox);
    return this.client.request<MailboxWebhooksResult>(`/mailboxes/v1/${id}/webhooks`, {
      headers: { Authorization: `Bearer ${serviceKey}` },
      context: "listing webhooks",
    });
  }

  async get(
    projectId: string,
    webhookId: string,
    opts: MailboxScopedOptions = {},
  ): Promise<MailboxWebhookSummary> {
    const { id, serviceKey } = await this.resolveMailbox(projectId, opts.mailbox);
    const encodedWebhookId = encodePathSegment(webhookId, "webhookId", "getting webhook");
    return this.client.request<MailboxWebhookSummary>(
      `/mailboxes/v1/${id}/webhooks/${encodedWebhookId}`,
      {
        headers: { Authorization: `Bearer ${serviceKey}` },
        context: "getting webhook",
      },
    );
  }

  async update(
    projectId: string,
    webhookId: string,
    opts: UpdateWebhookOptions,
  ): Promise<MailboxWebhookSummary> {
    const patch = validateUpdateWebhookOptions(opts);
    if (!patch.hasUrl && !patch.hasEvents) {
      throw new LocalError(
        "Provide at least `url` or `events` to update a webhook.",
        "updating webhook",
      );
    }
    const { id, serviceKey } = await this.resolveMailbox(projectId, opts.mailbox);
    const encodedWebhookId = encodePathSegment(webhookId, "webhookId", "updating webhook");
    const body: Record<string, unknown> = {};
    if (patch.hasUrl) body.url = opts.url;
    if (patch.hasEvents) body.events = opts.events;
    return this.client.request<MailboxWebhookSummary>(
      `/mailboxes/v1/${id}/webhooks/${encodedWebhookId}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${serviceKey}` },
        body,
        context: "updating webhook",
      },
    );
  }

  async delete(
    projectId: string,
    webhookId: string,
    opts: MailboxScopedOptions = {},
  ): Promise<void> {
    const { id, serviceKey } = await this.resolveMailbox(projectId, opts.mailbox);
    const encodedWebhookId = encodePathSegment(webhookId, "webhookId", "deleting webhook");
    await this.client.request<unknown>(`/mailboxes/v1/${id}/webhooks/${encodedWebhookId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${serviceKey}` },
      context: "deleting webhook",
    });
  }
}

export class Email {
  readonly webhooks: Webhooks;
  readonly create: (projectId: string, slug: string) => Promise<CreateMailboxResult>;
  readonly status: (projectId: string, mailbox?: MailboxSelector) => Promise<MailboxInfo>;
  readonly info: (projectId: string, mailbox?: MailboxSelector) => Promise<MailboxInfo>;
  readonly delete: (projectId: string, mailbox?: MailboxSelector) => Promise<DeleteMailboxResult>;
  readonly update: (projectId: string, opts: UpdateMailboxOptions) => Promise<UpdateMailboxResult>;

  constructor(private readonly client: Client) {
    this.webhooks = new Webhooks(client, (projectId, selector) => this.resolveMailbox(projectId, selector));
    this.create = this.createMailbox.bind(this);
    this.status = this.getMailbox.bind(this);
    this.info = this.getMailbox.bind(this);
    this.delete = this.deleteMailbox.bind(this);
    this.update = this.updateMailbox.bind(this);
  }

  /**
   * Resolve a project mailbox to `{ id, serviceKey }` for an operation.
   *
   * - `selector` is a mailbox id (`mbx_…`) → used directly; the gateway 403s
   *   if the id belongs to a different project, so no list call is needed.
   * - `selector` is a slug → the project's mailboxes are listed and matched.
   * - `selector` omitted for sends → use the configured
   *   `default_outbound_mailbox_id`. When the gateway returns
   *   `mailbox_settings` and no default is set, throw
   *   `DEFAULT_MAILBOX_REQUIRED`; do not silently pick the first/single row.
   * - `selector` omitted for reads/webhooks → require a unique mailbox, as
   *   before. This keeps non-send flows from guessing that the outbound
   *   default is also the intended read/webhook target.
   *
   * The cached `mailbox_id` is intentionally NOT used to resolve when a
   * selector is omitted — trusting it would silently target an arbitrary
   * mailbox on a multi-mailbox project.
   */
  private async resolveMailbox(
    projectId: string,
    selector?: MailboxSelector,
    mode: "unique" | "default_outbound" = "unique",
    context = "resolving mailbox",
  ): Promise<{ id: string; serviceKey: string }> {
    const project = await requireProjectCredentials(this.client, projectId, context);

    if (selector && /^mbx_/.test(selector)) {
      return { id: selector, serviceKey: project.service_key };
    }

    const list = await this.listMailboxEnvelope(project.service_key);
    const mb =
      mode === "default_outbound" && !selector
        ? this.pickDefaultOutboundMailbox(projectId, list, context)
        : this.pickMailbox(list.mailboxes, selector, context);
    if (!selector && list.mailboxes.length === 1) await this.cacheMailbox(projectId, mb);
    return { id: mb.mailbox_id, serviceKey: project.service_key };
  }

  private pickDefaultOutboundMailbox(
    projectId: string,
    envelope: MailboxListResult,
    context: string,
  ): MailboxRecord {
    const defaultId =
      envelope.mailbox_settings?.default_outbound_mailbox_id ??
      envelope.mailboxes.find((m) => m.is_default_outbound)?.mailbox_id ??
      null;

    if (defaultId) {
      const mb = envelope.mailboxes.find((m) => m.mailbox_id === defaultId);
      if (!mb) {
        throw mailboxConfigError({
          status: 409,
          code: "DEFAULT_MAILBOX_INVALID",
          message: `Configured default outbound mailbox ${defaultId} is not available. Set a valid default before sending email.`,
          context,
          projectId,
          mailboxes: envelope.mailboxes,
          settings: envelope.mailbox_settings,
          nextActions: envelope.next_actions,
          details: { default_outbound_mailbox_id: defaultId, reason: "missing_from_mailbox_list" },
        });
      }
      if (mb.can_send === false) {
        throw mailboxConfigError({
          status: 409,
          code: "DEFAULT_MAILBOX_INVALID",
          message: `Configured default outbound mailbox ${defaultId} cannot send email: ${mb.send_blocked_reason ?? "blocked"}.`,
          context,
          projectId,
          mailboxes: envelope.mailboxes,
          settings: envelope.mailbox_settings,
          nextActions: envelope.next_actions,
          details: {
            default_outbound_mailbox_id: defaultId,
            reason: mb.send_blocked_reason ?? "send_blocked",
          },
        });
      }
      return mb;
    }

    // Old gateways did not return mailbox_settings. Keep the legacy
    // single-mailbox convenience only while that field is absent, so tolerant
    // public clients can ship before the stricter gateway rollout.
    if (envelope.mailbox_settings === undefined) {
      return this.pickMailbox(envelope.mailboxes, undefined, context);
    }

    throw mailboxConfigError({
      status: envelope.mailboxes.length > 1 ? 409 : 400,
      code: "DEFAULT_MAILBOX_REQUIRED",
      message: "Set default_outbound_mailbox_id before sending email without an explicit mailbox.",
      context,
      projectId,
      mailboxes: envelope.mailboxes,
      settings: envelope.mailbox_settings,
      nextActions: envelope.next_actions,
    });
  }

  /**
   * Choose a mailbox from a project's list given an optional selector.
   * `selector` matches by exact mailbox id or slug. With no selector: 0 →
   * "create one first" (404), 1 → that one, 2+ → ambiguity error (409) naming
   * the available slugs.
   */
  private pickMailbox(
    list: MailboxRecord[],
    selector: MailboxSelector | undefined,
    context: string,
  ): MailboxRecord {
    if (selector) {
      const hit = list.find((m) => m.mailbox_id === selector || m.slug === selector);
      if (!hit) {
        throw new ApiError(
          `No mailbox matching "${selector}" (slug or id) in this project.`,
          404,
          null,
          context,
        );
      }
      return hit;
    }
    if (list.length === 0) {
      throw new ApiError(
        "No mailbox found for this project. Use `create_mailbox` to create one first.",
        404,
        null,
        context,
      );
    }
    if (list.length > 1) {
      const slugs = list.map((m) => m.slug).join(", ");
      throw new ApiError(
        `Project has ${list.length} mailboxes (${slugs}). Specify which one via the "mailbox" parameter (slug or id).`,
        409,
        null,
        context,
      );
    }
    return list[0]!;
  }

  /** Best-effort refresh of the single-mailbox convenience cache. */
  private async cacheMailbox(projectId: string, mb: MailboxRecord): Promise<void> {
    const updater = this.client.credentials.updateProject;
    if (!updater) return;
    try {
      await updater.call(this.client.credentials, projectId, {
        mailbox_id: mb.mailbox_id,
        mailbox_address: mb.address,
      });
    } catch {
      // best-effort cache — ignore failures
    }
  }

  private async listMailboxEnvelope(serviceKey: string): Promise<MailboxListResult> {
    const raw = await this.client.request<MailboxListResponse>(`/mailboxes/v1`, {
      headers: { Authorization: `Bearer ${serviceKey}` },
      context: "listing mailboxes",
    });
    return {
      mailboxes: Array.isArray(raw.mailboxes) ? raw.mailboxes : [],
      ...(raw.mailbox_settings !== undefined ? { mailbox_settings: raw.mailbox_settings } : {}),
      ...(raw.provider_readiness !== undefined ? { provider_readiness: raw.provider_readiness } : {}),
      ...(Array.isArray(raw.next_actions) ? { next_actions: raw.next_actions } : {}),
    };
  }

  /** List project mailboxes plus default-role settings and gateway repair hints. */
  async listMailboxes(projectId: string): Promise<MailboxListResult> {
    const project = await requireProjectCredentials(this.client, projectId, "listing mailboxes");
    return this.listMailboxEnvelope(project.service_key);
  }

  /**
   * Configure the project's mailbox defaults. Values are mailbox ids
   * (`mbx_…`) or `null` to clear when the gateway allows clearing.
   */
  async setMailboxDefaults(
    projectId: string,
    opts: SetMailboxDefaultsOptions,
  ): Promise<SetMailboxDefaultsResult> {
    if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
      throw new LocalError(
        "r.email.setMailboxDefaults(projectId, opts) requires an opts object.",
        "setting mailbox defaults",
      );
    }
    const hasOutbound = Object.prototype.hasOwnProperty.call(opts, "default_outbound_mailbox_id");
    const hasAuthSender = Object.prototype.hasOwnProperty.call(opts, "auth_sender_mailbox_id");
    if (!hasOutbound && !hasAuthSender) {
      throw new LocalError(
        "Provide default_outbound_mailbox_id and/or auth_sender_mailbox_id.",
        "setting mailbox defaults",
      );
    }
    validateOptionalMailboxId(opts.default_outbound_mailbox_id, "default_outbound_mailbox_id");
    validateOptionalMailboxId(opts.auth_sender_mailbox_id, "auth_sender_mailbox_id");

    const project = await requireProjectCredentials(this.client, projectId, "setting mailbox defaults");
    return this.client.request<SetMailboxDefaultsResult>("/mailboxes/v1/settings", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body: {
        ...(hasOutbound ? { default_outbound_mailbox_id: opts.default_outbound_mailbox_id } : {}),
        ...(hasAuthSender ? { auth_sender_mailbox_id: opts.auth_sender_mailbox_id } : {}),
      },
      context: "setting mailbox defaults",
    });
  }

  /**
   * Update per-mailbox settings. Currently supports the outbound
   * `footer_policy` field accepted by PATCH /mailboxes/v1/:mailbox_id.
   */
  async updateMailbox(projectId: string, opts: UpdateMailboxOptions): Promise<UpdateMailboxResult> {
    if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
      throw new LocalError(
        "r.email.updateMailbox(projectId, opts) requires an opts object.",
        "updating mailbox",
      );
    }
    const hasFooterPolicy = Object.prototype.hasOwnProperty.call(opts, "footer_policy");
    if (!hasFooterPolicy) {
      throw new LocalError(
        "Provide footer_policy.",
        "updating mailbox",
      );
    }
    assertStringInSet(opts.footer_policy, MAILBOX_FOOTER_POLICIES, "footer_policy", "updating mailbox");

    const { id, serviceKey } = await this.resolveMailbox(projectId, opts.mailbox, "unique", "updating mailbox");
    return this.client.request<UpdateMailboxResult>(`/mailboxes/v1/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${serviceKey}` },
      body: { footer_policy: opts.footer_policy },
      context: "updating mailbox",
    });
  }

  /**
   * Create a mailbox for a project.
   *
   * NOT idempotent. A 409 from the gateway now means `Slug already in use`,
   * `Address is in cooldown period`, or `Project mailbox limit reached (5)` —
   * none of which mean "you already own this slug" — so the 409 is surfaced
   * verbatim rather than silently returning some other existing mailbox.
   * Callers that want create-or-get should `list`/`getMailbox` explicitly.
   */
  async createMailbox(projectId: string, slug: string): Promise<CreateMailboxResult> {
    const project = await requireProjectCredentials(this.client, projectId, "creating mailbox");

    if (slug.length < 3 || slug.length > 63) {
      throw new LocalError("Slug must be 3-63 characters.", "creating mailbox");
    }
    if (!SLUG_RE.test(slug)) {
      throw new LocalError(
        "Slug must be lowercase alphanumeric + hyphens, start/end with alphanumeric.",
        "creating mailbox",
      );
    }
    if (slug.includes("--")) {
      throw new LocalError(
        "Slug must not contain consecutive hyphens.",
        "creating mailbox",
      );
    }

    const raw = await this.client.request<CreateMailboxResult | { mailbox: MailboxRecord } & MailboxSelectionEnvelope>("/mailboxes/v1", {
      method: "POST",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body: { slug, project_id: projectId },
      context: "creating mailbox",
    });

    const result = normalizeCreateMailboxResult(raw);
    await this.cacheMailbox(projectId, result);
    return result;
  }

  /** Send an email via template or raw (subject + html) mode. */
  async send(projectId: string, opts: SendEmailOptions): Promise<SendEmailResult> {
    if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
      throw new LocalError(
        "r.email.send(projectId, opts) requires an opts object as the 2nd argument.",
        "sending email",
      );
    }
    assertEmailAddress(opts.to, "to", "sending email");
    const hasSubject = !!opts.subject;
    const hasHtml = !!opts.html;
    const isRaw = hasSubject || hasHtml;
    const isTemplate = !!opts.template;
    if (!isRaw && !isTemplate) {
      throw new LocalError(
        "Provide either `template` + `variables` or both `subject` + `html`.",
        "sending email",
      );
    }
    if (isRaw && isTemplate) {
      throw new LocalError(
        "Provide `template` OR raw mode (`subject` + `html`), not both.",
        "sending email",
      );
    }
    if (isRaw && !(hasSubject && hasHtml)) {
      const missing = hasSubject ? "html" : "subject";
      throw new LocalError(
        `Raw mode requires both \`subject\` and \`html\` (missing \`${missing}\`).`,
        "sending email",
      );
    }
    const hasAttachments = Array.isArray(opts.attachments) && opts.attachments.length > 0;
    if (hasAttachments && isTemplate) {
      throw new LocalError(
        "Attachments are only supported in raw mode (`subject` + `html`), not with `template`.",
        "sending email",
      );
    }

    const { id, serviceKey } = await this.resolveMailbox(
      projectId,
      opts.mailbox,
      "default_outbound",
      "sending email",
    );
    const body: Record<string, unknown> = { to: opts.to };
    if (isTemplate) {
      body.template = opts.template;
      body.variables = opts.variables;
    } else {
      body.subject = opts.subject;
      body.html = opts.html;
      if (opts.text !== undefined) body.text = opts.text;
      if (hasAttachments) body.attachments = opts.attachments;
    }
    if (opts.from_name !== undefined) body.from_name = opts.from_name;
    if (opts.in_reply_to !== undefined) body.in_reply_to = opts.in_reply_to;

    return this.client.request<SendEmailResult>(`/mailboxes/v1/${id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}` },
      body,
      context: "sending email",
    });
  }

  /** List messages in the project's mailbox. */
  async list(projectId: string, opts: ListEmailsOptions = {}): Promise<EmailSummary[]> {
    if (opts.limit !== undefined) {
      assertPositiveSafeInteger(opts.limit, "limit", "listing emails");
    }

    if (opts.direction !== undefined) {
      assertStringInSet(opts.direction, MESSAGE_DIRECTIONS, "direction", "listing emails");
    }

    const { id, serviceKey } = await this.resolveMailbox(projectId, opts.mailbox);
    const qs = new URLSearchParams();
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.after) qs.set("after", opts.after);
    if (opts.direction !== undefined) qs.set("direction", opts.direction);
    const path = `/mailboxes/v1/${id}/messages${qs.toString() ? "?" + qs.toString() : ""}`;
    const raw = await this.client.request<EmailSummary[] | { messages?: EmailSummary[] }>(path, {
      headers: { Authorization: `Bearer ${serviceKey}` },
      context: "listing emails",
    });
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw.messages) ? raw.messages : [];
    return rows.map(normalizeEmailSummary);
  }

  /** Get a single message by id, including any replies. */
  async get(
    projectId: string,
    messageId: string,
    opts: MailboxScopedOptions = {},
  ): Promise<EmailDetail> {
    const { id, serviceKey } = await this.resolveMailbox(projectId, opts.mailbox);
    const encodedMessageId = encodePathSegment(messageId, "messageId", "getting email");
    const raw = await this.client.request<EmailDetail>(`/mailboxes/v1/${id}/messages/${encodedMessageId}`, {
      headers: { Authorization: `Bearer ${serviceKey}` },
      context: "getting email",
    });
    return normalizeEmailDetail(raw);
  }

  /**
   * Fetch the raw RFC-822 bytes of an inbound message. Returns `Uint8Array`
   * so the consumer can decode / store / forward without re-encoding.
   */
  async getRaw(
    projectId: string,
    messageId: string,
    opts: MailboxScopedOptions = {},
  ): Promise<RawEmailResult> {
    const { id, serviceKey } = await this.resolveMailbox(projectId, opts.mailbox);
    const encodedMessageId = encodePathSegment(messageId, "messageId", "fetching raw MIME");
    const url = `${this.client.apiBase}/mailboxes/v1/${id}/messages/${encodedMessageId}/raw`;
    const res = await this.client.fetch(url, {
      headers: { Authorization: `Bearer ${serviceKey}` },
    });
    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch { body = await res.text().catch(() => ""); }
      throw new ApiError(
        `Fetching raw MIME failed (HTTP ${res.status})`,
        res.status,
        body,
        "fetching raw MIME",
      );
    }
    const buf = await res.arrayBuffer();
    return {
      content_type: res.headers.get("content-type") ?? "message/rfc822",
      bytes: new Uint8Array(buf),
    };
  }

  /**
   * Get a project mailbox's info. With a `selector` (slug or `mbx_…` id),
   * returns that mailbox; without one, returns the project's only mailbox or
   * throws an ambiguity error when it has more than one.
   */
  async getMailbox(projectId: string, selector?: MailboxSelector): Promise<MailboxInfo> {
    const project = await requireProjectCredentials(this.client, projectId, "getting mailbox");
    const list = await this.listMailboxEnvelope(project.service_key);
    const mb = this.pickMailbox(list.mailboxes, selector, "getting mailbox");
    if (!selector && list.mailboxes.length === 1) await this.cacheMailbox(projectId, mb);
    return mb;
  }

  /**
   * Delete the project's mailbox. Destructive — drops all messages and
   * webhook subscriptions. Pass `mailboxId` explicitly to delete a specific
   * mailbox; otherwise the project's current mailbox is resolved. Returns
   * the deleted record echoed by the gateway.
   */
  async deleteMailbox(projectId: string, selector?: MailboxSelector): Promise<DeleteMailboxResult> {
    const project = await requireProjectCredentials(this.client, projectId, "deleting mailbox");

    let id: string;
    if (selector && /^mbx_/.test(selector)) {
      id = selector;
    } else {
      const list = await this.listMailboxEnvelope(project.service_key);
      if (!selector && list.mailboxes.length === 0) {
        throw new ApiError(
          "No mailbox found for this project — nothing to delete.",
          404,
          null,
          "deleting mailbox",
        );
      }
      id = this.pickMailbox(list.mailboxes, selector, "deleting mailbox").mailbox_id;
    }

    const result = await this.client.request<DeleteMailboxResult>(`/mailboxes/v1/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${project.service_key}` },
      context: "deleting mailbox",
    });

    const updater = this.client.credentials.updateProject;
    if (updater) {
      try {
        await updater.call(this.client.credentials, projectId, {
          mailbox_id: undefined,
          mailbox_address: undefined,
        });
      } catch {
        // best-effort
      }
    }

    return result;
  }
}

function normalizeCreateMailboxResult(
  raw: CreateMailboxResult | ({ mailbox: MailboxRecord } & MailboxSelectionEnvelope),
): CreateMailboxResult {
  const maybeEnvelope = raw as { mailbox?: MailboxRecord } & MailboxSelectionEnvelope;
  if (maybeEnvelope.mailbox && typeof maybeEnvelope.mailbox === "object") {
    return {
      ...maybeEnvelope.mailbox,
      ...(maybeEnvelope.mailbox_settings !== undefined
        ? { mailbox_settings: maybeEnvelope.mailbox_settings }
        : {}),
      ...(Array.isArray(maybeEnvelope.next_actions)
        ? { next_actions: maybeEnvelope.next_actions }
        : {}),
    };
  }
  const maybeLegacy = raw as CreateMailboxResult & { id?: string };
  if (!maybeLegacy.mailbox_id && typeof maybeLegacy.id === "string") {
    return { ...maybeLegacy, mailbox_id: maybeLegacy.id };
  }
  return raw as CreateMailboxResult;
}

function normalizeEmailSummary(raw: EmailSummary): EmailSummary {
  const id = raw.id ?? raw.message_id ?? "";
  return {
    ...raw,
    id,
    ...(raw.message_id === undefined && id ? { message_id: id } : {}),
    direction: raw.direction ?? "outbound",
    template: raw.template ?? null,
  };
}

function normalizeEmailDetail(raw: EmailDetail): EmailDetail {
  const id = raw.id ?? raw.message_id ?? "";
  return {
    ...raw,
    id,
    ...(raw.message_id === undefined && id ? { message_id: id } : {}),
    template: raw.template ?? null,
    variables: raw.variables ?? {},
  };
}

function validateOptionalMailboxId(value: unknown, field: string): void {
  if (value === undefined || value === null) return;
  assertNonEmptyString(value, field, "setting mailbox defaults");
  if (!/^mbx_/.test(value)) {
    throw new LocalError(
      `${field} must be a mailbox id starting with "mbx_". Use listMailboxes() to resolve a slug first.`,
      "setting mailbox defaults",
    );
  }
}

function mailboxConfigError(opts: {
  status: number;
  code: "DEFAULT_MAILBOX_REQUIRED" | "DEFAULT_MAILBOX_INVALID";
  message: string;
  context: string;
  projectId: string;
  mailboxes: MailboxRecord[];
  settings?: MailboxSettings;
  nextActions?: MailboxNextAction[];
  details?: Record<string, unknown>;
}): ApiError {
  const next_actions =
    opts.nextActions && opts.nextActions.length > 0
      ? opts.nextActions
      : [{
          type: "set_mailbox_defaults",
          method: "PATCH",
          path: "/mailboxes/v1/settings",
          auth: "service_key",
          why: "Choose the mailbox that should send outbound project email, then set default_outbound_mailbox_id.",
          command: `run402 email defaults --outbound <slug|mbx_id> --project ${opts.projectId}`,
        }];

  return new ApiError(
    opts.message,
    opts.status,
    {
      error: opts.message,
      message: opts.message,
      code: opts.code,
      category: "email",
      retryable: false,
      safe_to_retry: true,
      mutation_state: "none",
      details: {
        project_id: opts.projectId,
        mailbox_settings: opts.settings ?? null,
        candidates: summarizeMailboxCandidates(opts.mailboxes),
        ...(opts.details ?? {}),
      },
      next_actions,
    },
    opts.context,
  );
}

function summarizeMailboxCandidates(mailboxes: MailboxRecord[]): Array<Record<string, unknown>> {
  return mailboxes.map((m) => ({
    mailbox_id: m.mailbox_id,
    slug: m.slug,
    address: m.address,
    status: m.status,
    is_default_outbound: m.is_default_outbound ?? false,
    is_auth_sender: m.is_auth_sender ?? false,
    can_send: m.can_send,
    send_blocked_reason: m.send_blocked_reason ?? null,
    domain_kind: m.domain_kind,
    managed_address: m.managed_address,
    address_domain: m.address_domain,
    custom_domain_ready: m.custom_domain_ready,
    can_receive: m.can_receive,
  }));
}

function encodePathSegment(value: unknown, name: string, context: string): string {
  assertNonEmptyString(value, name, context);
  return encodeURIComponent(value);
}

function validateRegisterWebhookOptions(opts: RegisterWebhookOptions): void {
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
    throw new LocalError(
      "r.email.webhooks.register(projectId, opts) requires an opts object with url and events.",
      "registering webhook",
    );
  }
  assertHttpUrl(opts.url, "url", "registering webhook");
  validateWebhookEvents(opts.events, "events", "registering webhook");
}

function validateUpdateWebhookOptions(
  opts: UpdateWebhookOptions,
): { hasUrl: boolean; hasEvents: boolean } {
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
    throw new LocalError(
      "r.email.webhooks.update(projectId, webhookId, opts) requires an opts object.",
      "updating webhook",
    );
  }
  const hasUrl = opts.url !== undefined;
  const hasEvents = opts.events !== undefined;
  if (hasUrl) assertHttpUrl(opts.url, "url", "updating webhook");
  if (hasEvents) validateWebhookEvents(opts.events, "events", "updating webhook");
  return { hasUrl, hasEvents };
}

function validateWebhookEvents(
  value: unknown,
  name: string,
  context: string,
): asserts value is Array<(typeof WEBHOOK_EVENTS)[number]> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new LocalError(`${name} must be a non-empty array of email webhook events.`, context);
  }
  for (const event of value) {
    assertStringInSet(event, WEBHOOK_EVENTS, name, context);
  }
}
