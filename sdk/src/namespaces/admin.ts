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

export interface AgentContactResult {
  wallet: string;
  name: string;
  email?: string;
  webhook?: string;
  updated_at: string;
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

  /** Register agent contact info (name, email, webhook). */
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
