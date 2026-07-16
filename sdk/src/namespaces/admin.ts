/**
 * `admin` namespace — operator-adjacent operations that don't fit a public
 * resource namespace cleanly: messages/contact plus internal finance reads.
 *
 * (The compound `init` and `status` flows live at the MCP/CLI edge because
 * they stitch together multiple SDK namespaces + local state.)
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import { Transfers } from "./transfers.js";
import { deprecatePositional } from "../deprecate.js";

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

export type AdminFinanceWindow = "24h" | "7d" | "30d" | "90d";

export interface AdminProjectFinanceOptions {
  /** Time window for the finance rollup. Defaults to "30d". */
  window?: AdminFinanceWindow;
  /**
   * Optional admin session cookie header. Node operators can pass the value of
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
// Operator notifications (v1.55, add-operator-health-notifications).
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
  related_organization_id: string | null;
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
 *  present only when the operator has a routing rule matching the synthetic
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
   *  operator's normal rules — the full binding + rule + render + send
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
  /** Every live (non-revoked) Telegram binding for this operator, newest first. */
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
 * requires a VERIFIED operator email (bindings are addressed to it). See
 * `r.admin.setAgentContact` / `r.admin.verifyAgentContactEmail` and
 * `r.admin.startOperatorPasskeyEnrollment` to reach that assurance level —
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
   * `OPERATOR_EMAIL_NOT_VERIFIED` when the caller has no verified email yet.
   */
  async connectTelegram(opts: ConnectTelegramOptions = {}): Promise<ConnectTelegramResult> {
    const body: Record<string, unknown> = {};
    if (opts.label !== undefined) body.label = opts.label;
    return this.client.request<ConnectTelegramResult>(
      "/agent/v1/notifications/channels/telegram",
      { method: "POST", body, context: "connecting a Telegram notification channel" },
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
   * operator's binding id all return the SAME not-found error
   * (authorize-before-reveal) — no existence oracle.
   */
  async revokeTelegram(bindingId: string): Promise<RevokeTelegramResult> {
    return this.client.request<RevokeTelegramResult>(
      `/agent/v1/notifications/channels/telegram/${encodeURIComponent(bindingId)}`,
      { method: "DELETE", context: "revoking a Telegram notification channel" },
    );
  }
}

/**
 * `r.admin.rules` — Telegram routing rules (design D4): one match (ANDed
 * dimensions; an omitted dimension is a wildcard) → one Telegram binding.
 * Rules govern the Telegram channel ONLY in v1 — email/webhook keep their
 * existing preference-toggle semantics untouched. Mutations require
 * `operator_passkey` assurance.
 */
export class Rules {
  constructor(private readonly client: Client) {}

  /** List the operator's routing rules, newest first. */
  async list(): Promise<ListRoutingRulesResult> {
    return this.client.request<ListRoutingRulesResult>(
      "/agent/v1/notifications/rules",
      { context: "listing notification routing rules" },
    );
  }

  /**
   * Create a routing rule. `telegramBindingId` must reference a binding this
   * operator owns and that is currently usable (`status: "active"`); an
   * unusable or foreign binding id returns the same 404 as a nonexistent one
   * (authorize-before-reveal).
   */
  async create(input: CreateRoutingRuleInput): Promise<CreateRoutingRuleResult> {
    const body: Record<string, unknown> = { telegram_binding_id: input.telegramBindingId };
    if (input.projectId !== undefined) body.project_id = input.projectId;
    if (input.source !== undefined) body.source = input.source;
    if (input.eventTypes !== undefined) body.event_types = input.eventTypes;
    if (input.classes !== undefined) body.classes = input.classes;
    return this.client.request<CreateRoutingRuleResult>(
      "/agent/v1/notifications/rules",
      { method: "POST", body, context: "creating a notification routing rule" },
    );
  }

  /**
   * Patch a routing rule. PATCH semantics: only fields PRESENT on `patch`
   * are sent — `{ projectId: null }` clears that dimension back to
   * wildcard; omitting a field leaves it unchanged (see
   * {@link UpdateRoutingRulePatch}).
   */
  async update(ruleId: string, patch: UpdateRoutingRulePatch): Promise<RoutingRule> {
    const body: Record<string, unknown> = {};
    if ("projectId" in patch) body.project_id = patch.projectId;
    if ("source" in patch) body.source = patch.source;
    if ("eventTypes" in patch) body.event_types = patch.eventTypes;
    if ("classes" in patch) body.classes = patch.classes;
    if ("telegramBindingId" in patch) body.telegram_binding_id = patch.telegramBindingId;
    if ("enabled" in patch) body.enabled = patch.enabled;
    return this.client.request<RoutingRule>(
      `/agent/v1/notifications/rules/${encodeURIComponent(ruleId)}`,
      { method: "PATCH", body, context: "updating a notification routing rule" },
    );
  }

  /** Delete a routing rule. */
  async delete(ruleId: string): Promise<DeleteRoutingRuleResult> {
    return this.client.request<DeleteRoutingRuleResult>(
      `/agent/v1/notifications/rules/${encodeURIComponent(ruleId)}`,
      { method: "DELETE", context: "deleting a notification routing rule" },
    );
  }
}

// ---------------------------------------------------------------------------
// Operator-only project + organization actions (v1.57,
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

export interface OperatorStatusResult {
  operator_contact: {
    email_status: "none" | "pending" | "verified" | "bouncing";
    passkey_status: "none" | "pending" | "verified";
    recovery_gap: boolean;
  };
  critical_items: Array<{ kind: string; detail: string }>;
  skipped_notifications: Array<{
    id: string;
    event_type: string;
    related_project_id: string | null;
    related_organization_id: string | null;
    related_wallet_address: string | null;
    created_at: string;
  }>;
  organizations: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  active_thresholds: Array<{
    resource: string;
    level: "warn" | "critical";
    scope_kind: string;
    scope_id: string;
    crossed_at: string;
    last_observed_value: number | null;
  }>;
  /**
   * Runtime-staleness summary for the wallet's deployed functions
   * (capability `function-runtime-rebuild`, gateway v1.69+). A function is
   * stale when its deployed Lambda zip carries an older gateway entry wrapper
   * / bundled runtime than the gateway's current build. Read-only — observing
   * staleness never mutates a function. Refresh with `run402 functions
   * rebuild --all`. Omitted by gateways older than v1.69.
   */
  runtime?: {
    stale_function_count: number;
    stale_functions: Array<{ project_id: string; name: string }>;
  };
  /**
   * Whether a mandatory-class (recovery/security/billing/verification)
   * notification can reach a verified human for the caller's org(s) —
   * computed from the union of the verified `agent_contacts` chain and
   * org-membership verified emails (recovery-event-reachability). When
   * `reachable` is false the response also carries a top-level
   * `next_actions[]` entry pointing at `POST /agent/v1/contact`. Omitted by
   * older gateways.
   */
  operator_reachability?: {
    reachable: boolean;
    verified_recipient_count: number;
    sources: Array<"agent_contacts" | "org_membership">;
    /** Notifications skipped with no resolvable recipient, trailing 90 days. */
    skipped_last_90d: number;
  };
  /** Present when `operator_reachability.reachable` is false — the remedy. */
  next_actions?: Array<{ type: string; method?: string; path?: string; why?: string }>;
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
   * Operator-scoped sub-client for an org id — the operator analog of
   * `r.org(id)`, kept on `r.admin` because these actions require platform-admin
   * (`X-Admin-Mode`) auth, a different principal from the member-facing
   * `r.org(id)`. Exposes `pinLease()` / `unpinLease()`. Lazy and synchronous.
   */
  org(orgId: string): ScopedAdminOrg {
    return new ScopedAdminOrg(this, orgId);
  }

  /**
   * Operator-scoped sub-client for a project id. Exposes `archive(opts?)`,
   * `reactivate()`, and `finance(opts?)` with the id pre-bound. Lazy and
   * synchronous.
   */
  project(projectId: string): ScopedAdminProject {
    return new ScopedAdminProject(this, projectId);
  }

  /** Send a message to the Run402 developers. Requires an active tier. */
  async sendMessage(message: string): Promise<SendMessageResult> {
    return this.client.request<SendMessageResult>("/message/v1", {
      method: "POST",
      body: { message },
      context: "sending message",
    });
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

  /** Read the current agent contact assurance state for the allowance wallet. */
  async getAgentContactStatus(): Promise<AgentContactResult> {
    return this.client.request<AgentContactResult>("/agent/v1/contact/status", {
      method: "GET",
      context: "fetching agent contact status",
    });
  }

  /** Start or resend the operator email reply challenge. */
  async verifyAgentContactEmail(): Promise<AgentContactResult> {
    return this.client.request<AgentContactResult>("/agent/v1/contact/verify-email", {
      method: "POST",
      context: "starting agent contact email verification",
    });
  }

  /** Email a passkey enrollment link to the verified operator email. */
  async startOperatorPasskeyEnrollment(): Promise<AgentContactResult> {
    return this.client.request<AgentContactResult>("/agent/v1/contact/passkey/enroll", {
      method: "POST",
      context: "starting operator passkey enrollment",
    });
  }

  // ---------------------------------------------------------------------------
  // Operator notifications (v1.55, add-operator-health-notifications).
  // ---------------------------------------------------------------------------

  /** List operator notification audit rows (paginated, filterable). */
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

  /** Read the current operator notification preferences. */
  async getNotificationPreferences(): Promise<NotificationPreferences> {
    return this.client.request<NotificationPreferences>(
      "/agent/v1/notifications/preferences",
      { method: "GET", context: "fetching notification preferences" },
    );
  }

  /** Patch operator notification preferences (assurance ladder applies). */
  async setNotificationPreferences(
    patch: NotificationPreferencesPatch,
  ): Promise<NotificationPreferences> {
    return this.client.request<NotificationPreferences>(
      "/agent/v1/notifications/preferences",
      {
        method: "PATCH",
        body: patch as unknown as Record<string, unknown>,
        context: "updating notification preferences",
      },
    );
  }

  /**
   * Trigger a real test notification. Sends a sample `project_past_due`
   * event through the normal worker pipeline (email/webhook); the audit row
   * is marked `is_test: true`. ALSO delivers a synthetic event through the
   * operator's Telegram routing rules end-to-end (binding + rule + render +
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
   * Rotate the operator's webhook signing secret. The new plaintext secret
   * is returned EXACTLY once. The previous secret remains valid for 24
   * hours (dual-secret grace window). Requires `operator_passkey` assurance.
   */
  async rotateWebhookSecret(): Promise<RotateWebhookSecretResult> {
    return this.client.request<RotateWebhookSecretResult>(
      "/agent/v1/webhook-secret/rotate",
      { method: "POST", context: "rotating webhook signing secret" },
    );
  }

  /** Compact operator-health snapshot for the authenticated wallet. */
  async getOperatorStatus(): Promise<OperatorStatusResult> {
    return this.client.request<OperatorStatusResult>(
      "/agent/v1/operator/status",
      { method: "GET", context: "fetching operator status" },
    );
  }

  /**
   * Fetch per-project finance for platform operators.
   *
   * This is the same admin-only surface used by the Run402 Finance tab. It is
   * gated by platform-admin auth; project service keys are not sufficient.
   * Use the Node SDK with an admin allowance wallet, pass `cookie` for browser
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
  // Operator-only project + organization actions (v1.57).
  // -------------------------------------------------------------------------

  /**
   * Toggle a organization's `lease_perpetual` flag — the operator escape
   * hatch that pins every project in the organization (replaces the v1.56
   * per-project `pin` removed in v1.57). When enabling on an organization in a
   * grace state, the gateway reactivates inline and reports it via
   * `reactivated: true`.
   *
   * Platform-admin only. Calls
   * `POST /orgs/v1/admin/:org_id/lease-perpetual`.
   */
  /**
   * @deprecated Boolean positional argument is a swap trap. Use
   * `r.admin.org(orgId).pinLease()` / `.unpinLease()` instead.
   */
  async setLeasePerpetual(
    organizationId: string,
    perpetual: boolean,
  ): Promise<SetLeasePerpetualResult> {
    deprecatePositional(
      "admin.setLeasePerpetual",
      "use r.admin.org(orgId).pinLease()/unpinLease()",
    );
    return this._setLeasePerpetual(organizationId, perpetual);
  }

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
   * Operator moderation action — archive a single project (ToS / abuse).
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
   * Operator "un-archive" — flips `projects.archived_at` back to NULL. It does
   * not touch organization-level lifecycle. To reactivate a grace-state
   * organization, either subscribe a new tier or set `lease_perpetual: true`
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
 * Operator-scoped sub-client for a single org, returned by `r.admin.org(id)`.
 * Replaces the boolean `admin.setLeasePerpetual(orgId, perpetual)` with two
 * intent-named verbs. Carries platform-admin auth; operator-only errors surface
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
 * Operator-scoped sub-client for a single project, returned by
 * `r.admin.project(id)`. The project id is pre-bound; methods carry
 * platform-admin auth.
 */
export class ScopedAdminProject {
  constructor(private readonly admin: Admin, private readonly projectId: string) {}

  /** Archive the project (operator moderation). */
  archive(opts: ArchiveProjectOptions = {}): Promise<ArchiveProjectResult> {
    return this.admin.archiveProject(this.projectId, opts);
  }

  /** Un-archive the project. */
  reactivate(): Promise<ReactivateProjectResult> {
    return this.admin.reactivateProject(this.projectId);
  }

  /** Read per-project finance (operator Finance tab). */
  finance(opts: AdminProjectFinanceOptions = {}): Promise<AdminProjectFinanceResult> {
    return this.admin.getProjectFinance(this.projectId, opts);
  }
}
