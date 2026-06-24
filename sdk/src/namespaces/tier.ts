/**
 * `tier` namespace — tier subscription / renewal / upgrade against
 * `/tiers/v1*`. Requires allowance SIWX auth; `set` flows through x402
 * for the actual payment.
 */

import type { Client } from "../kernel.js";

export type TierName = "prototype" | "hobby" | "team";

export interface TierFunctionLimits {
  max_function_timeout_seconds?: number;
  max_function_memory_mb?: number;
  max_scheduled_functions?: number;
  min_cron_interval_minutes?: number;
  current_scheduled_functions?: number;
  [key: string]: unknown;
}

/**
 * Per-project summary returned in `TierStatusResult.projects[]`. Mirrors the
 * gateway's `WalletTierInfo.projects[]` shape. Pre-v1.57 gateways may omit
 * `effective_status` / `organization_lifecycle_state` / `lease_perpetual`; pre-v1.59
 * gateways omit `secrets_rotation_advised`. Unknown future fields are preserved
 * via the index signature so callers can branch on them.
 */
export interface TierStatusProject {
  id: string;
  name: string;
  tier: string;
  status: string;
  pinned: boolean;
  created_at: string;
  effective_status?: string;
  organization_lifecycle_state?: string;
  lease_perpetual?: boolean;
  /**
   * v1.77 (org-owned control plane): owning org (organization) id and the
   * provisioning principal. A wallet authenticates; the org owns the project.
   * Present on the canonical project object (`GET /projects/v1`); the
   * tier-status list does not include them today, so both are optional and
   * forward-compatible (preserved via the index signature regardless).
   */
  org_id?: string;
  created_by?: string;
  /**
   * v1.59 (add-project-transfer): set on a project after an accepted transfer
   * stamped `projects.secrets_rotation_advised_at`. Clears automatically once
   * B has re-written every previously-inherited secret name (or via the
   * explicit acknowledge route). Surfaced so agents can guide rotation.
   */
  secrets_rotation_advised?: {
    advised_at: string;
    reason: string;
  };
  [key: string]: unknown;
}

/**
 * v1.59 (add-project-transfer): summary of a pending transfer OFFERED TO the
 * authenticated wallet. Exposed at the top level of `TierStatusResult` so the
 * inbox is visible without a separate API call. Each entry carries
 * `preview_path` for deep-linking into `GET /agent/v1/transfers/<id>`.
 */
export interface TierStatusIncomingTransfer {
  transfer_id: string;
  project_id: string;
  project_name_snapshot: string | null;
  from_wallet: string;
  billing_policy: "migrate";
  message: string | null;
  initiated_at: string;
  expires_at: string;
  kysigned_record_id: string | null;
  preview_path: string;
}

export interface TierStatusResult {
  wallet: string;
  tier: string | null;
  lease_started_at: string | null;
  lease_expires_at: string | null;
  active: boolean;
  /**
   * Lifecycle state of the owning organization. `null` only when the
   * wallet has no organization row (orphan wallet).
   */
  organization_lifecycle_state:
    | "active"
    | "past_due"
    | "frozen"
    | "dormant"
    | "purged"
    | null;
  /**
   * Operator escape hatch flag on the owning organization. When `true`,
   * the organization never advances past `active` regardless of lease expiry.
   * `null` only for orphan wallets with no organization row.
   */
  lease_perpetual: boolean | null;
  pool_usage: {
    projects: number;
    total_api_calls: number;
    total_storage_bytes: number;
    api_calls_limit: number;
    storage_bytes_limit: number;
  };
  /**
   * Per-project summary across all projects on the wallet's organization.
   * Always present on v1.46+ gateways. Pre-v1.59 entries lack
   * `secrets_rotation_advised`.
   */
  projects?: TierStatusProject[];
  /**
   * v1.59 (add-project-transfer): pending transfers offered TO this wallet.
   * Empty array when none. Absent on pre-v1.59 gateways. Each entry carries
   * `preview_path` so callers can deep-link into the full preview document
   * without a second list call.
   */
  incoming_transfers?: TierStatusIncomingTransfer[];
  /** Function authoring caps returned by newer gateways. Unknown future
   *  limit fields are preserved so callers can display or branch on them. */
  function_limits?: TierFunctionLimits;
  /** Compatibility slot for gateways that nest caps under limits.functions. */
  limits?: {
    functions?: TierFunctionLimits;
    [key: string]: unknown;
  };
}

export interface TierSetResult {
  wallet: string;
  action: string;
  tier: string;
  previous_tier: string | null;
  lease_started_at: string;
  lease_expires_at: string;
  allowance_remaining_usd_micros: number;
}

export interface TierSetOptions {
  /**
   * Idempotency key for safe retries (durable-side-effects doctrine). When set,
   * the SDK sends it as the `Idempotency-Key` header so retrying the same
   * subscribe/renew intent does not double-charge. The key is caller-supplied:
   * it represents one payment intent, a boundary only the caller knows (a
   * deliberate second renewal must use a fresh key). The SDK does not
   * auto-derive one — that cannot distinguish a retry from a new renewal.
   */
  idempotencyKey?: string;
}

export class Tier {
  constructor(private readonly client: Client) {}

  /** Check current tier subscription — tier name, status, and expiry. */
  async status(): Promise<TierStatusResult> {
    return this.client.request<TierStatusResult>("/tiers/v1/status", {
      context: "checking tier status",
    });
  }

  /**
   * Subscribe, renew, or upgrade a tier. Auto-detects the action based on
   * allowance state. Payment flows through the injected fetch (x402 in
   * Node with an allowance). Throws {@link PaymentRequired} when the
   * wrapper cannot fund the call.
   */
  async set(tier: TierName, opts: TierSetOptions = {}): Promise<TierSetResult> {
    return this.client.request<TierSetResult>(`/tiers/v1/${tier}`, {
      method: "POST",
      body: {},
      // Retry-safety: a caller-supplied key collapses a retried subscribe/renew
      // onto one charge. Omitted by default — tier renewal is not auto-keyed.
      ...(opts.idempotencyKey ? { headers: { "Idempotency-Key": opts.idempotencyKey } } : {}),
      context: "setting tier",
    });
  }
}
