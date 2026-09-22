/**
 * `admin` namespace — operations that don't fit a public
 * resource namespace cleanly: messages/contact plus internal finance reads.
 *
 * (The compound `init` and `status` flows live at the MCP/CLI edge because
 * they stitch together multiple SDK namespaces + local state.)
 */

import { gateSecret } from "../secret-gate.js";
import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import { Transfers } from "./transfers.js";

export interface AgentContact {
  name: string;
  email?: string;
  webhook?: string;
}

export type AgentEmailVerificationStatus = "none" | "pending" | "verified";
export type AgentPasskeyBindingStatus = "none" | "pending" | "verified";
export type AgentAssuranceLevel =
  | "wallet_only"
  | "email_pending"
  | "email_verified"
  | "passkey_pending"
  | "operator_passkey";

export interface AgentContactResult {
  wallet: string;
  name: string;
  email: string | null;
  webhook: string | null;
  email_verification_status: AgentEmailVerificationStatus;
  passkey_binding_status: AgentPasskeyBindingStatus;
  assurance_level: AgentAssuranceLevel;
  email_verified_at: string | null;
  email_verified_message_id: string | null;
  email_challenge_sent_at: string | null;
  passkey_bound_at: string | null;
  active_operator_passkey_id: string | null;
  updated_at: string;
  verification_retry_after_seconds?: number;
  enrollment_sent_to?: string;
}

export interface SendMessageResult {
  status: string;
}

export interface FeedbackSendOptions {
  /**
   * Project this feedback concerns. Required to relay a promotion consent
   * (a `hand_to_member` `next_actions` entry from a deploy response) —
   * the server resolves the project's site URL, org, and the sender's live
   * presence name for the delivered message.
   */
  project_id?: string;
  /** Sender's X/Twitter handle, at most 64 characters. Delivered as-is; stored nowhere else. */
  handle?: string;
}

export type AdminFinanceWindow = "24h" | "7d" | "30d" | "90d";

export interface AdminProjectFinanceOptions {
  /** Time window for the finance rollup. Defaults to "30d". */
  window?: AdminFinanceWindow;
  /**
   * Optional admin session cookie header. Staff can pass the value of
   * RUN402_ADMIN_COOKIE when they want browser-session auth; otherwise the
   * credential provider's normal auth headers are used.
   */
  cookie?: string;
}

export interface AdminProjectFinanceResult {
  project_id: string;
  project_name: string;
  window: AdminFinanceWindow;
  revenue_usd_micros: number;
  direct_cost_usd_micros: number;
  direct_margin_usd_micros: number;
  revenue_breakdown: {
    tier_fees_usd_micros: number;
    email_packs_usd_micros: number;
    kms_rental_usd_micros: number;
    kms_sign_fees_usd_micros: number;
    per_call_sku_usd_micros: number;
  };
  direct_cost_breakdown: Array<{ category: string; cost_usd_micros: number }>;
  notes: string;
}

const FINANCE_WINDOWS = new Set<AdminFinanceWindow>(["24h", "7d", "30d", "90d"]);

// ---------------------------------------------------------------------------
// Owner notifications (v1.55).
// ---------------------------------------------------------------------------

export type NotificationKind = "digest" | "lifecycle_event" | "threshold_alert" | "missing_verified_recipient";
export type NotificationChannel = "email" | "webhook" | "skipped";
export type NotificationDeliveryStatus =
  | "delivered"
  | "failed_transient"
  | "failed_permanent"
  | "skipped_no_recipient"
  | "skipped_disabled";

export interface NotificationRow {
  id: string;
  recipient_email: string | null;
  kind: NotificationKind;
  event_type: string | null;
  channel: NotificationChannel;
  delivery_status: NotificationDeliveryStatus;
  delivery_error: string | null;
  attempt_count: number;
  is_test: boolean;
  related_project_id: string | null;
  related_org_id: string | null;
  related_wallet_address: string | null;
  created_at: string;
  redacted_at: string | null;
  /** Payload JSON, or null when the row has been redacted. */
  payload: Record<string, unknown> | null;
}

export interface ListNotificationsOptions {
  type?: string;
  /** ISO timestamp; only notifications created at or after this time. */
  since?: string;
  /** Default 50, max 200. */
  limit?: number;
  /** Opaque keyset cursor — page forward from a prior page's `next_cursor`. */
  after?: string;
}

export interface ListNotificationsResult {
  notifications: NotificationRow[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface NotificationPreferences {
  channels: { email: boolean; webhook: boolean };
  webhook_url: string | null;
  webhook_signing_secret_configured: boolean;
  digest_cadence: "off" | "daily" | "weekly" | "monthly";
  /** 1=Monday..7=Sunday. */
  digest_day_of_week: number;
  /** 0..23 UTC. */
  digest_hour_utc: number;
  threshold_alerts: "off" | "digest_only" | "immediate";
  lifecycle_events: "off" | "critical_only" | "all";
  /** Schema-enforced; always "always". */
  security_events: "always";
  /** BCP-47 (e.g. "en-US"). */
  locale: string;
  /** IANA timezone (e.g. "UTC"). */
  timezone: string;
}

export type NotificationPreferencesPatch = Partial<
  Omit<NotificationPreferences, "webhook_signing_secret_configured" | "security_events">
> & {
  /** Cannot be changed away from "always" — server returns 400. */
  security_events?: "always";
};

export interface TestNotificationOptions {
  /**
   * Route the synthetic test event as if it came from the app lane
   * (`project_events.source = 'app'`) or the platform. Defaults to
   * `"platform"` on the gateway when omitted.
   */
  source?: "app" | "platform";
  /**
   * Synthetic `event_type` override (flat snake_case,
   * `^[a-z][a-z0-9_]{2,63}$`). Use this to exercise a specific routing rule's
   * `event_types` filter precisely. Defaults to the gateway's built-in
   * sample event when omitted.
   */
  eventType?: string;
}

/** One Telegram destination's outcome from a `testNotification()` call —
 *  present only when the caller has a routing rule matching the synthetic
 *  event. Empty `telegram.destinations` is Faithful (no matching rule), not
 *  an error. */
export interface TestNotificationDestination {
  binding_id: string;
  label: string | null;
  delivered: boolean;
  /** Present on failures. `true` = retryable (429/5xx/timeout/rate-limited);
   *  `false` = permanent (bad chat, bot blocked/removed). */
  transient?: boolean;
  description?: string;
}

export interface TestNotificationResult {
  status: "delivered" | "skipped" | "queued";
  source_event_id: string;
  drained: {
    claimed: number;
    delivered: number;
    skipped: number;
    failed_transient: number;
    failed_permanent: number;
  };
  /** Telegram delivery report for the synthetic event, routed through the
   *  caller's normal rules — the full binding + rule + render + send
   *  chain, not just email/webhook. */
  telegram: { destinations: TestNotificationDestination[] };
  note: string;
}

export interface RotateWebhookSecretResult {
  webhook_signing_secret: string;
  rotated_at: string;
  grace_window_hours: number;
  note: string;
}

// ---------------------------------------------------------------------------
// Telegram notification channel + routing rules
// (notification-channel-routing-telegram). Exposed as `r.admin.channels.*`
// and `r.admin.rules.*` — nested sub-namespaces on `r.admin`, the same shape
// as `r.admin.transfers`.
// ---------------------------------------------------------------------------

export type TelegramBindingStatus = "pending" | "active" | "revoked";

/**
 * One Telegram binding as returned by `GET /agent/v1/notifications/channels`
 * (`telegram[]`) and `r.admin.channels.list()`. Never carries the raw
 * connect code — codes are single-use, hashed at rest, and returned only
 * once, inline in {@link ConnectTelegramResult}.
 */
export interface TelegramChannelBinding {
  id: string;
  recipient_email: string;
  status: TelegramBindingStatus;
  chat_id: number | null;
  chat_type: string | null;
  chat_title: string | null;
  label: string | null;
  consecutive_failures: number;
  /** Set once auto-disabled after 10 consecutive hard delivery failures. */
  disabled_at: string | null;
  /** Only set while `status === "pending"` — the connect code's 15-min TTL. */
  code_expires_at: string | null;
  created_at: string;
  activated_at: string | null;
}

export interface ConnectTelegramOptions {
  /** Human-readable label for the chat (e.g. `"kychon alerts"`), 1-64 chars. */
  label?: string;
}

/**
 * one-passkey-per-person: the two proofs a wallet-authenticated notification
 * mutation may carry on ONE request — the `SIGN-IN-WITH-X` wallet signature
 * (which contact) and the person's sign-in session bearer (the passkey
 * assurance). A person signed in with `run402 login` never enrolls a second
 * passkey: the gateway accepts a passkey-fresh session for the wallet
 * contact's verified email as `operator_passkey` assurance (the stored
 * assurance level's wire spelling). When omitted, the request carries the
 * provider's wallet auth alone.
 */
export interface SessionProofs {
  /** The `SIGN-IN-WITH-X` header value for the target path. */
  siwx: string;
  /** The sign-in session token (`Authorization: Bearer`). */
  token: string;
}

/** Request options carrying both proofs, or nothing when no session is at hand. */
export function sessionProofRequest(proofs?: SessionProofs): { headers?: Record<string, string>; withAuth?: boolean } {
  if (!proofs) return {};
  return { headers: { "SIGN-IN-WITH-X": proofs.siwx, Authorization: `Bearer ${proofs.token}` }, withAuth: false };
}

export interface ConnectTelegramNextAction {
  type: string;
  method?: string;
  path?: string;
  why?: string;
}

export interface ConnectTelegramResult {
  binding_id: string;
  status: "pending";
  /** `t.me/<bot>?start=<code>` — tap to bind a PRIVATE chat. Single-use, 15-min TTL. */
  connect_url: string;
  /** `t.me/<bot>?startgroup=<code>` — tap to bind a GROUP chat. Same code/TTL as {@link connect_url} (whichever is tapped first consumes it). */
  connect_group_url: string;
  code_expires_at: string;
  label: string | null;
  next_actions: ConnectTelegramNextAction[];
}

export interface NotificationChannelsResult {
  email: { address: string | null; verified: boolean };
  webhook: { configured: boolean; url: string | null; secret_configured: boolean };
  /** Every live (non-revoked) Telegram binding for this caller, newest first. */
  telegram: TelegramChannelBinding[];
}

export interface RevokeTelegramResult {
  status: "revoked";
  binding_id: string;
}

// ─── Routing rules ──────────────────────────────────────────────────────

/**
 * `"app"` = app-emitted business events (`project_events.source = 'app'`,
 * e.g. `events.emit(...)` from `@run402/functions`); `"platform"` = every
 * non-app platform event (deploys, lifecycle, verification, ...). Absent /
 * `null` on a rule is a wildcard — matches both.
 */
export type RoutingRuleSource = "app" | "platform";

/**
 * Wire-shaped routing rule. Every match dimension (`project_id`, `source`,
 * `event_types`, `classes`) is ANDed; `null` is a wildcard for that
 * dimension. An explicit empty array (`event_types: []` / `classes: []`)
 * matches NOTHING — Postgres `TEXT[]` semantics, deliberately different from
 * the "`[]` means unfiltered" convention used by some read-filter query
 * params elsewhere in this SDK. One rule always targets exactly one Telegram
 * binding; overlapping rules that resolve to the same binding are deduped by
 * the gateway at delivery time (one message, not one per matching rule).
 */
export interface RoutingRule {
  id: string;
  recipient_email: string;
  project_id: string | null;
  source: RoutingRuleSource | null;
  event_types: string[] | null;
  classes: string[] | null;
  channel: "telegram";
  telegram_binding_id: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * `r.admin.rules.create(...)` input. Every match dimension is optional
 * (absent = wildcard); `telegramBindingId` is the only required field. An
 * all-wildcard rule (every event on every project routes to one chat) is
 * legal.
 */
export interface CreateRoutingRuleInput {
  telegramBindingId: string;
  projectId?: string | null;
  source?: RoutingRuleSource | null;
  eventTypes?: string[] | null;
  classes?: string[] | null;
}

/**
 * `r.admin.rules.update(...)` patch. PATCH semantics: a field OMITTED from
 * this object leaves the stored value unchanged; a field explicitly set to
 * `null` CLEARS that dimension back to wildcard. There is no wire difference
 * between "omitted" and "set to `undefined`" — both drop the key from the
 * JSON request body, so the gateway sees no instruction to change it.
 */
export interface UpdateRoutingRulePatch {
  projectId?: string | null;
  source?: RoutingRuleSource | null;
  eventTypes?: string[] | null;
  classes?: string[] | null;
  telegramBindingId?: string;
  enabled?: boolean;
}

export interface ListRoutingRulesResult {
  rules: RoutingRule[];
}

export interface CreateRoutingRuleResult extends RoutingRule {
  next_actions: ConnectTelegramNextAction[];
}

export interface DeleteRoutingRuleResult {
  deleted: true;
  rule_id: string;
}

/**
 * `r.admin.channels` — the Telegram notification-channel binding lifecycle
 * (connect / list / revoke). Mutations (`connectTelegram`, `revokeTelegram`)
 * require `operator_passkey` assurance; `connectTelegram` additionally
 * requires a VERIFIED contact email (bindings are addressed to it). See
 * `r.admin.setAgentContact` / `r.admin.verifyAgentContactEmail` and
 * `r.admin.startContactPasskeyEnrollment` (or `run402 login`) to reach that assurance level —
 * same ladder as {@link Admin.rotateWebhookSecret}.
 */
export class Channels {
  constructor(private readonly client: Client) {}

  /**
   * Start binding a Telegram chat. Returns two single-use, 15-minute deep
   * links — `connect_url` for a private chat, `connect_group_url` for a
   * group — plus a `pending` binding id. A human taps ONE of the links and
   * starts the bot; poll {@link Channels.list} until the binding's `status`
   * flips to `"active"` (or `code_expires_at` passes and it's swept back to
   * `"revoked"`).
   *
   * Throws (via the generic SDK error hierarchy — check `err.code`) HTTP 503
   * `TELEGRAM_CHANNEL_NOT_CONFIGURED` until the platform's dedicated
   * notification bot is provisioned, and HTTP 412
   * `CONTACT_EMAIL_NOT_VERIFIED` when the caller has no verified email yet.
   */
  async connectTelegram(opts: ConnectTelegramOptions = {}, proofs?: SessionProofs): Promise<ConnectTelegramResult> {
    gateSecret(this.client, "admin.channels.connectTelegram", opts, proofs);
    const body: Record<string, unknown> = {};
    if (opts.label !== undefined) body.label = opts.label;
    return this.client.request<ConnectTelegramResult>(
      "/agent/v1/notifications/channels/telegram",
      { method: "POST", body, context: "connecting a Telegram notification channel", ...sessionProofRequest(proofs) },
    );
  }

  /** List every notification channel — email, webhook, and every live
   *  (non-revoked) Telegram binding — for the authenticated wallet. */
  async list(): Promise<NotificationChannelsResult> {
    return this.client.request<NotificationChannelsResult>(
      "/agent/v1/notifications/channels",
      { context: "listing notification channels" },
    );
  }

  /**
   * Revoke a Telegram binding. Missing / already-revoked / another
   * caller's binding id all return the SAME not-found error
   * (authorize-before-reveal) — no existence oracle.
   */
  async revokeTelegram(bindingId: string, proofs?: SessionProofs): Promise<RevokeTelegramResult> {
    gateSecret(this.client, "admin.channels.revokeTelegram", bindingId, proofs);
    return this.client.request<RevokeTelegramResult>(
      `/agent/v1/notifications/channels/telegram/${encodeURIComponent(bindingId)}`,
      { method: "DELETE", context: "revoking a Telegram notification channel", ...sessionProofRequest(proofs) },
    );
  }
}

/**
 * `r.admin.rules` — Telegram routing rules: one match (ANDed
 * dimensions; an omitted dimension is a wildcard) → one Telegram binding.
 * Rules govern the Telegram channel ONLY in v1 — email/webhook keep their
 * existing preference-toggle semantics untouched. Mutations require
 * `operator_passkey` assurance.
 */
export class Rules {
  constructor(private readonly client: Client) {}

  /** List the caller's routing rules, newest first. */
  async list(): Promise<ListRoutingRulesResult> {
    return this.client.request<ListRoutingRulesResult>(
      "/agent/v1/notifications/rules",
      { context: "listing notification routing rules" },
    );
  }

  /**
   * Create a routing rule. `telegramBindingId` must reference a binding this
   * caller owns and that is currently usable (`status: "active"`); an
   * unusable or foreign binding id returns the same 404 as a nonexistent one
   * (authorize-before-reveal).
   */
  async create(input: CreateRoutingRuleInput, proofs?: SessionProofs): Promise<CreateRoutingRuleResult> {
    gateSecret(this.client, "admin.rules.create", input, proofs);
    const body: Record<string, unknown> = { telegram_binding_id: input.telegramBindingId };
    if (input.projectId !== undefined) body.project_id = input.projectId;
    if (input.source !== undefined) body.source = input.source;
    if (input.eventTypes !== undefined) body.event_types = input.eventTypes;
    if (input.classes !== undefined) body.classes = input.classes;
    return this.client.request<CreateRoutingRuleResult>(
      "/agent/v1/notifications/rules",
      { method: "POST", body, context: "creating a notification routing rule", ...sessionProofRequest(proofs) },
    );
  }

  /**
   * Patch a routing rule. PATCH semantics: only fields PRESENT on `patch`
   * are sent — `{ projectId: null }` clears that dimension back to
   * wildcard; omitting a field leaves it unchanged (see
   * {@link UpdateRoutingRulePatch}).
   */
  async update(ruleId: string, patch: UpdateRoutingRulePatch, proofs?: SessionProofs): Promise<RoutingRule> {
    gateSecret(this.client, "admin.rules.update", ruleId, patch, proofs);
    const body: Record<string, unknown> = {};
    if ("projectId" in patch) body.project_id = patch.projectId;
    if ("source" in patch) body.source = patch.source;
    if ("eventTypes" in patch) body.event_types = patch.eventTypes;
    if ("classes" in patch) body.classes = patch.classes;
    if ("telegramBindingId" in patch) body.telegram_binding_id = patch.telegramBindingId;
    if ("enabled" in patch) body.enabled = patch.enabled;
    return this.client.request<RoutingRule>(
      `/agent/v1/notifications/rules/${encodeURIComponent(ruleId)}`,
      { method: "PATCH", body, context: "updating a notification routing rule", ...sessionProofRequest(proofs) },
    );
  }

  /** Delete a routing rule. */
  async delete(ruleId: string, proofs?: SessionProofs): Promise<DeleteRoutingRuleResult> {
    gateSecret(this.client, "admin.rules.delete", ruleId, proofs);
    return this.client.request<DeleteRoutingRuleResult>(
      `/agent/v1/notifications/rules/${encodeURIComponent(ruleId)}`,
      { method: "DELETE", context: "deleting a notification routing rule", ...sessionProofRequest(proofs) },
    );
  }
}

// ---------------------------------------------------------------------------
// Staff-only project + organization actions (v1.57,
// lifecycle-state-on-organization).
// ---------------------------------------------------------------------------

export interface SetLeasePerpetualResult {
  status: "ok";
  org_id: string;
  lease_perpetual: boolean;
  /**
   * `true` when the toggle was `lease_perpetual: true` AND the account was in
   * a grace state (past_due / frozen / dormant) and got pulled back to
   * `active` inline. `false` otherwise (account was already active, or the
   * toggle disabled perpetual).
   */
  reactivated: boolean;
}

export interface ArchiveProjectOptions {
  /** Free-text moderation reason recorded in the audit log. */
  reason?: string;
}

export interface ArchiveProjectResult {
  status: "ok";
  project_id: string;
  /** ISO timestamp of the archive action. Absent when the project was already archived. */
  archived_at?: string;
  /** Echoes the moderator-supplied reason when the project was newly archived. */
  reason?: string;
  /** Set when the project was already archived; archived_at is then omitted. */
  note?: "already archived";
}

export interface ReactivateProjectResult {
  status: "ok";
  project_id: string;
  /** `true` when the call un-archived a previously archived project. */
  reactivated?: true;
  /** Set when the project was not archived to begin with — the call is a no-op. */
  note?: "not archived";
}

export class Admin {
  /**
   * Project transfer sub-namespace — unified wallet, email, and owned-org
   * project transfer surface. Access via `r.admin.transfers.{initiate,
   * preview, accept, claim, cancel, listIncoming, listOutgoing}`.
   */
  readonly transfers: Transfers;

  /**
   * Telegram notification-channel binding lifecycle. Access via
   * `r.admin.channels.{connectTelegram, list, revokeTelegram}`.
   */
  readonly channels: Channels;

  /**
   * Telegram routing rules — one match (ANDed dimensions) to one binding.
   * Access via `r.admin.rules.{list, create, update, delete}`.
   */
  readonly rules: Rules;

  constructor(private readonly client: Client) {
    this.transfers = new Transfers(client);
    this.channels = new Channels(client);
    this.rules = new Rules(client);
  }

  /**
   * Staff-scoped sub-client for an org id — the staff analog of
   * `r.org(id)`, kept on `r.admin` because these actions require platform-admin
   * (`X-Admin-Mode`) auth, a different principal from the member-facing
   * `r.org(id)`. Exposes `pinLease()` / `unpinLease()`. Lazy and synchronous.
   */
  org(orgId: string): ScopedAdminOrg {
    return new ScopedAdminOrg(this, orgId);
  }

  /**
   * Staff-scoped sub-client for a project id. Exposes `archive(opts?)`,
   * `reactivate()`, and `finance(opts?)` with the id pre-bound. Lazy and
   * synchronous.
   */
  project(projectId: string): ScopedAdminProject {
    return new ScopedAdminProject(this, projectId);
  }

  /**
   * Send feedback to the Run402 developers. Requires an active tier.
   *
   * WRITE-ONLY: there is no inbox and no reply path. When an answer from a
   * human is required, raise an escalation instead.
   *
   * Also the way a promotion consent is relayed: after a deploy response
   * carries a `hand_to_member` next action, ask your human yes or no, and
   * on yes call `sendFeedback("promote: yes", { project_id, handle })`.
   */
  async sendFeedback(message: string, opts?: FeedbackSendOptions): Promise<SendMessageResult> {
    const body: Record<string, string> = { message };
    if (opts?.project_id) body.project_id = opts.project_id;
    if (opts?.handle) body.handle = opts.handle;

    return this.client.request<SendMessageResult>("/feedback/v1", {
      method: "POST",
      body,
      context: "sending feedback",
    });
  }

  /**
   * @deprecated Renamed to {@link sendFeedback}. Kept so code written against
   * the old name keeps compiling; it now posts to `/feedback/v1` like its
   * replacement. The `message` vocabulary is being freed for addressed
   * agent/human messaging, which is a different capability with a return path.
   */
  async sendMessage(message: string, opts?: FeedbackSendOptions): Promise<SendMessageResult> {
    return this.sendFeedback(message, opts);
  }

  /** Register agent contact info and start email verification when needed. */
  async setAgentContact(contact: AgentContact): Promise<AgentContactResult> {
    const body: Record<string, string> = { name: contact.name };
    if (contact.email) body.email = contact.email;
    if (contact.webhook) body.webhook = contact.webhook;

    return this.client.request<AgentContactResult>("/agent/v1/contact", {
      method: "POST",
      body,
      context: "setting agent contact",
    });
  }

  /** Read the current agent contact assurance state for the wallet. */
  async getAgentContactStatus(): Promise<AgentContactResult> {
    return this.client.request<AgentContactResult>("/agent/v1/contact/status", {
      method: "GET",
      context: "fetching agent contact status",
    });
  }

  /** Start or resend the contact email reply challenge. */
  async verifyAgentContactEmail(): Promise<AgentContactResult> {
    return this.client.request<AgentContactResult>("/agent/v1/contact/verify-email", {
      method: "POST",
      context: "starting agent contact email verification",
    });
  }

  /** Email a passkey enrollment link to the verified contact email. */
  async startContactPasskeyEnrollment(): Promise<AgentContactResult> {
    return this.client.request<AgentContactResult>("/agent/v1/contact/passkey/enroll", {
      method: "POST",
      context: "starting contact passkey enrollment",
    });
  }

  // ---------------------------------------------------------------------------
  // Owner notifications (v1.55).
  // ---------------------------------------------------------------------------

  /** List notification audit rows (paginated, filterable). */
  async listNotifications(opts: ListNotificationsOptions = {}): Promise<ListNotificationsResult> {
    const q: string[] = [];
    if (opts.type) q.push(`type=${encodeURIComponent(opts.type)}`);
    if (opts.since) q.push(`since=${encodeURIComponent(opts.since)}`);
    if (opts.limit != null) q.push(`limit=${opts.limit}`);
    if (opts.after != null) q.push(`after=${encodeURIComponent(opts.after)}`);
    const url = q.length > 0
      ? `/agent/v1/notifications?${q.join("&")}`
      : "/agent/v1/notifications";
    return this.client.request<ListNotificationsResult>(url, {
      method: "GET",
      context: "listing notifications",
    });
  }

  /** Retrieve a single notification audit row by id. */
  async getNotification(id: string): Promise<NotificationRow> {
    return this.client.request<NotificationRow>(
      `/agent/v1/notifications/${encodeURIComponent(id)}`,
      { method: "GET", context: "fetching notification" },
    );
  }

  /** Read the current notification preferences. */
  async getNotificationPreferences(): Promise<NotificationPreferences> {
    return this.client.request<NotificationPreferences>(
      "/agent/v1/notifications/preferences",
      { method: "GET", context: "fetching notification preferences" },
    );
  }

  /** Patch notification preferences (assurance ladder applies). */
  async setNotificationPreferences(
    patch: NotificationPreferencesPatch,
    proofs?: SessionProofs,
  ): Promise<NotificationPreferences> {
    gateSecret(this.client, "admin.setNotificationPreferences", patch, proofs);
    return this.client.request<NotificationPreferences>(
      "/agent/v1/notifications/preferences",
      {
        method: "PATCH",
        body: patch as unknown as Record<string, unknown>,
        context: "updating notification preferences",
        ...sessionProofRequest(proofs),
      },
    );
  }

  /**
   * Trigger a real test notification. Sends a sample `project_past_due`
   * event through the normal worker pipeline (email/webhook); the audit row
   * is marked `is_test: true`. ALSO delivers a synthetic event through the
   * caller's Telegram routing rules end-to-end (binding + rule + render +
   * send) and reports a per-destination outcome in `telegram.destinations`
   * — pass `opts.source` / `opts.eventType` to target a specific rule's
   * filters instead of the default sample event. Rate-limited per wallet at
   * 1/min.
   */
  async testNotification(opts: TestNotificationOptions = {}): Promise<TestNotificationResult> {
    const body: Record<string, unknown> = {};
    if (opts.source !== undefined) body.source = opts.source;
    if (opts.eventType !== undefined) body.event_type = opts.eventType;
    return this.client.request<TestNotificationResult>(
      "/agent/v1/notifications/test",
      { method: "POST", body, context: "triggering test notification" },
    );
  }

  /**
   * Rotate the caller's webhook signing secret. The new plaintext secret
   * is returned EXACTLY once. The previous secret remains valid for 24
   * hours (dual-secret grace window). Requires `operator_passkey` assurance.
   */
  async rotateWebhookSecret(proofs?: SessionProofs): Promise<RotateWebhookSecretResult> {
    gateSecret(this.client, "admin.rotateWebhookSecret", proofs);
    return this.client.request<RotateWebhookSecretResult>(
      "/agent/v1/webhook-secret/rotate",
      { method: "POST", context: "rotating webhook signing secret", ...sessionProofRequest(proofs) },
    );
  }

  /**
   * Fetch per-project finance for staff.
   *
   * This is the same admin-only surface used by the Run402 Finance tab. It is
   * gated by platform-admin auth; project service keys are not sufficient.
   * Use the Node SDK with an admin wallet, pass `cookie` for browser
   * session auth, or provide a credential provider whose `getAuth()` returns
   * suitable admin headers.
   */
  async getProjectFinance(
    projectId: string,
    opts: AdminProjectFinanceOptions = {},
  ): Promise<AdminProjectFinanceResult> {
    const window = opts.window ?? "30d";
    if (!FINANCE_WINDOWS.has(window)) {
      throw new LocalError(
        `Invalid finance window: ${String(window)}. Expected one of: 24h, 7d, 30d, 90d.`,
        "fetching project finance",
      );
    }

    const headers: Record<string, string> = { "X-Admin-Mode": "1" };
    if (opts.cookie) headers.Cookie = opts.cookie;

    return this.client.request<AdminProjectFinanceResult>(
      `/admin/api/finance/project/${encodeURIComponent(projectId)}?window=${encodeURIComponent(window)}`,
      {
        headers,
        context: "fetching project finance",
      },
    );
  }

  // -------------------------------------------------------------------------
  // Staff-only project + organization actions (v1.57).
  // -------------------------------------------------------------------------

  /**
   * Toggle a organization's `lease_perpetual` flag — the staff escape
   * hatch that pins every project in the organization (replaces the v1.56
   * per-project `pin` removed in v1.57). When enabling on an organization in a
   * grace state, the gateway reactivates inline and reports it via
   * `reactivated: true`.
   *
   * Platform-admin only. Calls
   * `POST /orgs/v1/admin/:org_id/lease-perpetual`.
   */
  /**
   * Shared, non-deprecated implementation behind {@link setLeasePerpetual} and
   * the `r.admin.org(id).pinLease()/unpinLease()` handle.
   * @internal
   */
  _setLeasePerpetual(
    organizationId: string,
    perpetual: boolean,
  ): Promise<SetLeasePerpetualResult> {
    return this.client.request<SetLeasePerpetualResult>(
      `/orgs/v1/admin/${encodeURIComponent(organizationId)}/lease-perpetual`,
      {
        method: "POST",
        headers: { "X-Admin-Mode": "1" },
        body: { lease_perpetual: perpetual },
        context: "setting organization lease_perpetual",
      },
    );
  }

  /**
   * Staff moderation action — archive a single project (ToS / abuse).
   * Sets `projects.archived_at` to NOW(). Independent of organization-level
   * lifecycle; the rest of the organization's projects continue serving.
   *
   * Platform-admin only. Calls `POST /projects/v1/admin/:id/archive`.
   */
  async archiveProject(
    projectId: string,
    opts: ArchiveProjectOptions = {},
  ): Promise<ArchiveProjectResult> {
    const body: Record<string, string> = {};
    if (opts.reason !== undefined) body.reason = opts.reason;
    return this.client.request<ArchiveProjectResult>(
      `/projects/v1/admin/${encodeURIComponent(projectId)}/archive`,
      {
        method: "POST",
        headers: { "X-Admin-Mode": "1" },
        body,
        context: "archiving project",
      },
    );
  }

  /**
   * Staff "un-archive" — flips `projects.archived_at` back to NULL. It does
   * not touch organization-level lifecycle. To reactivate a grace-state
   * organization, either set a tier or set `lease_perpetual: true`
   * via {@link setLeasePerpetual}.
   *
   * Platform-admin only. Calls `POST /projects/v1/admin/:id/reactivate`.
   */
  async reactivateProject(projectId: string): Promise<ReactivateProjectResult> {
    return this.client.request<ReactivateProjectResult>(
      `/projects/v1/admin/${encodeURIComponent(projectId)}/reactivate`,
      {
        method: "POST",
        headers: { "X-Admin-Mode": "1" },
        context: "reactivating project",
      },
    );
  }
}

/**
 * Staff-scoped sub-client for a single org, returned by `r.admin.org(id)`.
 * Replaces the boolean `admin.setLeasePerpetual(orgId, perpetual)` with two
 * intent-named verbs. Carries platform-admin auth; staff-only errors surface
 * at call time.
 */
export class ScopedAdminOrg {
  constructor(private readonly admin: Admin, private readonly orgId: string) {}

  /** Pin the org's lease (`lease_perpetual = true`). */
  pinLease(): Promise<SetLeasePerpetualResult> {
    return this.admin._setLeasePerpetual(this.orgId, true);
  }

  /** Unpin the org's lease (`lease_perpetual = false`). */
  unpinLease(): Promise<SetLeasePerpetualResult> {
    return this.admin._setLeasePerpetual(this.orgId, false);
  }
}

/**
 * Staff-scoped sub-client for a single project, returned by
 * `r.admin.project(id)`. The project id is pre-bound; methods carry
 * platform-admin auth.
 */
export class ScopedAdminProject {
  constructor(private readonly admin: Admin, private readonly projectId: string) {}

  /** Archive the project (staff moderation). */
  archive(opts: ArchiveProjectOptions = {}): Promise<ArchiveProjectResult> {
    return this.admin.archiveProject(this.projectId, opts);
  }

  /** Un-archive the project. */
  reactivate(): Promise<ReactivateProjectResult> {
    return this.admin.reactivateProject(this.projectId);
  }

  /** Read per-project finance (staff Finance tab). */
  finance(opts: AdminProjectFinanceOptions = {}): Promise<AdminProjectFinanceResult> {
    return this.admin.getProjectFinance(this.projectId, opts);
  }
}
