/**
 * `tier` namespace — tier subscription / renewal / upgrade against
 * `/tiers/v1*`. Requires allowance SIWX auth; `set` flows through x402
 * for the actual payment.
 */

import type { Client } from "../kernel.js";

export type TierName = "prototype" | "hobby" | "team";

export interface TierStatusResult {
  wallet: string;
  tier: string | null;
  lease_expires_at: string | null;
  status: string;
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
  async set(tier: TierName): Promise<TierSetResult> {
    return this.client.request<TierSetResult>(`/tiers/v1/${tier}`, {
      method: "POST",
      body: {},
      context: "setting tier",
    });
  }
}
