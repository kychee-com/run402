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
  related_billing_account_id: string | null;
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
  offset?: number;
}

export interface ListNotificationsResult {
  notifications: NotificationRow[];
  pagination: { limit: number; offset: number; returned: number };
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

export interface TestNotificationResult {
  status: "queued";
  source_event_id: string;
  note: string;
}

export interface RotateWebhookSecretResult {
  webhook_signing_secret: string;
  rotated_at: string;
  grace_window_hours: number;
  note: string;
}

// ---------------------------------------------------------------------------
// Operator-only project + billing-account actions (v1.57,
// lifecycle-state-on-billing-account).
// ---------------------------------------------------------------------------

export interface SetLeasePerpetualResult {
  status: "ok";
  billing_account_id: string;
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
    related_billing_account_id: string | null;
    related_wallet_address: string | null;
    created_at: string;
  }>;
  billing_accounts: Array<Record<string, unknown>>;
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
}

export class Admin {
  /**
   * Project transfer sub-namespace (v1.59+) — two-party SIWX-signed
   * project handoff. Access via `r.admin.transfers.{initiate, preview,
   * accept, cancel, listIncoming, listOutgoing}`.
   */
  readonly transfers: Transfers;

  constructor(private readonly client: Client) {
    this.transfers = new Transfers(client);
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
    if (opts.offset != null) q.push(`offset=${opts.offset}`);
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
   * event through the normal worker pipeline; the audit row is marked
   * `is_test: true`. Rate-limited per wallet at 1/min.
   */
  async testNotification(): Promise<TestNotificationResult> {
    return this.client.request<TestNotificationResult>(
      "/agent/v1/notifications/test",
      { method: "POST", context: "triggering test notification" },
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
  // Operator-only project + billing-account actions (v1.57).
  // -------------------------------------------------------------------------

  /**
   * Toggle a billing account's `lease_perpetual` flag — the operator escape
   * hatch that pins every project on the account (replaces the v1.56
   * per-project `pin` removed in v1.57). When enabling on an account in a
   * grace state, the gateway reactivates inline and reports it via
   * `reactivated: true`.
   *
   * Platform-admin only. Calls
   * `POST /billing/v1/admin/accounts/:account_id/lease-perpetual`.
   */
  async setLeasePerpetual(
    billingAccountId: string,
    perpetual: boolean,
  ): Promise<SetLeasePerpetualResult> {
    return this.client.request<SetLeasePerpetualResult>(
      `/billing/v1/admin/accounts/${encodeURIComponent(billingAccountId)}/lease-perpetual`,
      {
        method: "POST",
        headers: { "X-Admin-Mode": "1" },
        body: { lease_perpetual: perpetual },
        context: "setting billing account lease_perpetual",
      },
    );
  }

  /**
   * Operator moderation action — archive a single project (ToS / abuse).
   * Sets `projects.archived_at` to NOW(). Independent of account-level
   * lifecycle; the rest of the account's projects continue serving.
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
   * Operator "un-archive" — flips `projects.archived_at` back to NULL. In
   * v1.57 this route was narrowed: it no longer touches account-level
   * lifecycle. To reactivate a grace-state account, either subscribe a new
   * tier (the tier flow runs `advanceLifecycleForAccount` inline) or set
   * `lease_perpetual: true` via {@link setLeasePerpetual}.
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
