/**
 * `billing` namespace — wallet-scoped billing accounts and Stripe checkouts.
 * All operations are public (no service key required); they identify the
 * account by wallet address or email.
 */

import type { Client } from "../kernel.js";
import type { ProjectTier } from "./projects.types.js";

export interface BillingBalance {
  identifier_type: "wallet" | "email";
  available_usd_micros: number;
  email_credits_remaining: number;
  tier: ProjectTier | null;
  lease_expires_at: string | null;
  auto_recharge_enabled: boolean;
  auto_recharge_threshold: number;
}

export interface BillingHistoryEntry {
  id: string;
  direction: "credit" | "debit";
  kind: string;
  amount_usd_micros: number;
  balance_after_available: number;
  balance_after_held: number;
  reference_type: string | null;
  reference_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface BillingHistoryResult {
  identifier: string;
  identifier_type: "wallet" | "email";
  entries: BillingHistoryEntry[];
}

export interface CreateCheckoutResult {
  checkout_url: string;
  topup_id: string;
}

export interface EmailBillingAccount {
  id: string;
  email: string;
  email_credits_remaining: number;
  verification_sent: boolean;
}

export interface AccountIdentifier {
  email?: string;
  wallet?: string;
}

export interface AutoRechargeOptions {
  billingAccountId: string;
  enabled: boolean;
  threshold?: number;
}

export class Billing {
  constructor(private readonly client: Client) {}

  /** Check a wallet's billing balance (available / held / status). Public, no auth. */
  async checkBalance(wallet: string): Promise<BillingBalance> {
    const w = wallet.toLowerCase();
    return this.client.request<BillingBalance>(`/billing/v1/accounts/${w}`, {
      context: "checking balance",
      withAuth: false,
    });
  }

  /** Fetch billing history for a wallet. */
  async history(wallet: string, limit?: number): Promise<BillingHistoryResult> {
    const w = wallet.toLowerCase();
    const path = limit
      ? `/billing/v1/accounts/${w}/history?limit=${limit}`
      : `/billing/v1/accounts/${w}/history`;
    return this.client.request<BillingHistoryResult>(path, {
      context: "fetching billing history",
      withAuth: false,
    });
  }

  /** Create a Stripe checkout URL to fund a wallet's billing balance. */
  async createCheckout(wallet: string, amountUsdMicros: number): Promise<CreateCheckoutResult> {
    return this.client.request<CreateCheckoutResult>("/billing/v1/checkouts", {
      method: "POST",
      body: { wallet: wallet.toLowerCase(), amount_usd_micros: amountUsdMicros },
      context: "creating checkout",
      withAuth: false,
    });
  }

  /** Create an email-only (no-wallet) billing account. Sends a verification email. */
  async createEmailAccount(email: string): Promise<EmailBillingAccount> {
    return this.client.request<EmailBillingAccount>("/billing/v1/accounts", {
      method: "POST",
      body: { email },
      context: "creating email billing account",
      withAuth: false,
    });
  }

  /** Link a wallet to an existing email billing account to enable hybrid Stripe + x402. */
  async linkWallet(billingAccountId: string, wallet: string): Promise<void> {
    await this.client.request<unknown>(
      `/billing/v1/accounts/${billingAccountId}/link-wallet`,
      {
        method: "POST",
        body: { wallet },
        context: "linking wallet",
        withAuth: false,
      },
    );
  }

  /** Create a Stripe checkout for a tier subscription/renewal/upgrade. */
  async tierCheckout(tier: string, identifier: AccountIdentifier): Promise<CreateCheckoutResult> {
    const body: Record<string, string> = {};
    if (identifier.wallet) body.wallet = identifier.wallet;
    else if (identifier.email) body.email = identifier.email;
    else throw new Error("Provide either `email` or `wallet` in identifier.");

    return this.client.request<CreateCheckoutResult>(`/billing/v1/tiers/${tier}/checkout`, {
      method: "POST",
      body,
      context: "creating tier checkout",
      withAuth: false,
    });
  }

  /** Buy a $5 email pack (10,000 emails). */
  async buyEmailPack(identifier: AccountIdentifier): Promise<CreateCheckoutResult> {
    const body: Record<string, string> = {};
    if (identifier.wallet) body.wallet = identifier.wallet;
    else if (identifier.email) body.email = identifier.email;
    else throw new Error("Provide either `email` or `wallet` in identifier.");

    return this.client.request<CreateCheckoutResult>("/billing/v1/email-packs/checkout", {
      method: "POST",
      body,
      context: "creating email pack checkout",
      withAuth: false,
    });
  }

  /** Enable/disable email-pack auto-recharge. */
  async setAutoRecharge(opts: AutoRechargeOptions): Promise<void> {
    const body: Record<string, unknown> = {
      billing_account_id: opts.billingAccountId,
      enabled: opts.enabled,
    };
    if (opts.threshold !== undefined) body.threshold = opts.threshold;

    await this.client.request<unknown>("/billing/v1/email-packs/auto-recharge", {
      method: "POST",
      body,
      context: "setting auto-recharge",
      withAuth: false,
    });
  }
}
