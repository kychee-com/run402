/**
 * `admin` namespace — operator-adjacent operations that don't fit a public
 * resource namespace cleanly: messages/contact plus internal finance reads.
 *
 * (The compound `init` and `status` flows live at the MCP/CLI edge because
 * they stitch together multiple SDK namespaces + local state.)
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";

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
}

export class Admin {
  constructor(private readonly client: Client) {}

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
}
