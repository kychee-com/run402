/**
 * `me` — the caller's own account reads (`/agent/v1/me/*`). Accepts a sign-in
 * session (any grade: these are reads) or a SIWX wallet, which reads that
 * wallet's slice. Reached as `r.me.*`. `run402 orgs list` renders
 * {@link Me.overview}; `run402 doctor` and MCP `whoami` read {@link Me.status}.
 * The project inventory (`GET /agent/v1/me/projects`) is
 * `r.projects.list({ all: true })`.
 */

import { gateSecret } from "../secret-gate.js";
import type { Client } from "../kernel.js";
import type { SessionGrade } from "./org.types.js";

/** Options bag carrying an optional sign-in session bearer. */
export interface MeTokenOpts {
  /**
   * The sign-in session bearer. When omitted, the request uses the credential
   * provider's default auth (a SIWX wallet reads its own slice).
   */
  token?: string;
}

/**
 * The account overview (`GET /agent/v1/me/overview`): organizations with tier,
 * lifecycle, quotas and balance; wallets with their projects; advisories.
 * Counts only — no inventory name, no secret value. Forward-compatible: the
 * gateway owns the exact shape and may add fields.
 */
export interface AccountOverview {
  scope?: {
    kind?: "principal" | "wallet" | (string & {});
    principal?: string;
    wallet_count?: number;
    organization_count?: number;
    [key: string]: unknown;
  };
  /** The sign-in session that authenticated the read; `null` for a wallet caller. */
  session?: { grade: SessionGrade | (string & {}); amr: string[]; [key: string]: unknown } | null;
  rollup?: Record<string, unknown>;
  organizations?: Array<{ id: string; [key: string]: unknown }>;
  wallets?: Array<Record<string, unknown>>;
  advisories?: Array<{ type: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * The owner snapshot (`GET /agent/v1/me/status`): contact assurance, critical
 * items, skipped notifications, organizations, projects, active thresholds, and
 * whether lifecycle notifications can reach anyone.
 */
export interface MeStatusResult {
  contact: {
    email_status: "none" | "pending" | "verified" | "bouncing" | (string & {});
    passkey_status: "none" | "pending" | "verified" | (string & {});
    recovery_gap?: boolean;
    [key: string]: unknown;
  };
  critical_items: Array<{ kind: string; detail: string; [key: string]: unknown }>;
  skipped_notifications: Array<Record<string, unknown>>;
  organizations: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  active_thresholds: Array<{
    resource: string;
    level: "warn" | "critical" | (string & {});
    scope_kind: string;
    scope_id: string;
    crossed_at: string;
    last_observed_value: number | null;
    [key: string]: unknown;
  }>;
  /**
   * Runtime-staleness summary for the caller's deployed functions: a function
   * is stale when its deployed zip carries an older gateway entry wrapper or
   * bundled runtime than the gateway's current build. Read-only. Refresh with
   * `run402 functions rebuild --all`.
   */
  runtime?: {
    stale_function_count: number;
    stale_functions: Array<{ project_id: string; name: string }>;
  };
  /**
   * Whether a mandatory-class (recovery/security/billing/verification)
   * notification can reach a verified person for the caller's organizations —
   * the union of verified contact emails and the verified emails of the
   * organizations' members. When `reachable` is false the response also carries
   * a top-level `next_actions[]` entry (`register_contact`).
   */
  reachability?: {
    reachable: boolean;
    verified_recipient_count: number;
    sources: Array<"agent_contacts" | "org_membership" | (string & {})>;
    /** Notifications skipped with no resolvable recipient, trailing 90 days. */
    skipped_last_90d: number;
    [key: string]: unknown;
  };
  /** Present when `reachability.reachable` is false — the remedy. */
  next_actions?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function authFor(opts: MeTokenOpts): { headers?: Record<string, string>; withAuth?: boolean } {
  return opts.token
    ? { headers: { Authorization: `Bearer ${opts.token}` }, withAuth: false }
    : {};
}

export class Me {
  constructor(private readonly client: Client) {}

  /** The account overview across every organization the caller is a member of. */
  async overview(opts: MeTokenOpts = {}): Promise<AccountOverview> {
    gateSecret(this.client, "me.overview", opts);
    return this.client.request<AccountOverview>("/agent/v1/me/overview", {
      ...authFor(opts),
      context: "fetching account overview",
    });
  }

  /** The owner snapshot `run402 doctor` reads. */
  async status(opts: MeTokenOpts = {}): Promise<MeStatusResult> {
    gateSecret(this.client, "me.status", opts);
    return this.client.request<MeStatusResult>("/agent/v1/me/status", {
      ...authFor(opts),
      context: "fetching account status",
    });
  }
}
