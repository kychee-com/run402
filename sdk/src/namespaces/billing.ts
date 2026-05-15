/**
 * `billing` namespace — wallet-scoped billing accounts and Stripe checkouts.
 * All operations are public (no service key required); they identify the
 * account by wallet address or email.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import { assertPositiveSafeInteger } from "../validation.js";
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

export type BillingAccountIdentifier = string;

export interface AutoRechargeOptions {
  billingAccountId: string;
  enabled: boolean;
  threshold?: number;
}

function encodeBillingIdentifier(identifier: BillingAccountIdentifier): string {
  const normalized = /^0x/i.test(identifier)
    ? identifier.toLowerCase()
    : identifier;
  return encodeURIComponent(normalized);
}

function assertNonNegativeSafeInteger(
  value: number,
  name: string,
  context: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalError(`${name} must be a non-negative safe integer.`, context);
  }
}

function checkoutIdentifierBody(
  identifier: AccountIdentifier,
  context: string,
): Record<string, string> {
  if (identifier.email && identifier.wallet) {
    throw new LocalError(
      "Provide either `email` or `wallet` in identifier, not both.",
      context,
    );
  }
  if (identifier.wallet) return { wallet: identifier.wallet };
  if (identifier.email) return { email: identifier.email };
  throw new LocalError(
    "Provide either `email` or `wallet` in identifier.",
    context,
  );
}

export class Billing {
  readonly balance: (identifier: BillingAccountIdentifier) => Promise<BillingBalance>;
  readonly createEmail: (email: string) => Promise<EmailBillingAccount>;
  readonly autoRecharge: (opts: AutoRechargeOptions) => Promise<void>;

  constructor(private readonly client: Client) {
    this.balance = this.checkBalance.bind(this);
    this.createEmail = this.createEmailAccount.bind(this);
    this.autoRecharge = this.setAutoRecharge.bind(this);
  }

  /** Check a billing account by wallet or email identifier. Public, no auth. */
  async checkBalance(identifier: BillingAccountIdentifier): Promise<BillingBalance> {
    return this.getAccount(identifier);
  }

  /** Check a billing account by wallet or email identifier. Public, no auth. */
  async getAccount(identifier: BillingAccountIdentifier): Promise<BillingBalance> {
    const encoded = encodeBillingIdentifier(identifier);
    return this.client.request<BillingBalance>(`/billing/v1/accounts/${encoded}`, {
      context: "checking balance",
      withAuth: false,
    });
  }

  /** Fetch billing history by wallet or email identifier. */
  async history(identifier: BillingAccountIdentifier, limit?: number): Promise<BillingHistoryResult> {
    return this.getHistory(identifier, limit);
  }

  /** Fetch billing history by wallet or email identifier. */
  async getHistory(identifier: BillingAccountIdentifier, limit?: number): Promise<BillingHistoryResult> {
    const encoded = encodeBillingIdentifier(identifier);
    if (limit !== undefined) {
      assertPositiveSafeInteger(limit, "limit", "fetching billing history");
    }
    const path = limit !== undefined
      ? `/billing/v1/accounts/${encoded}/history?limit=${encodeURIComponent(String(limit))}`
      : `/billing/v1/accounts/${encoded}/history`;
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
    const body = checkoutIdentifierBody(identifier, "creating tier checkout");

    return this.client.request<CreateCheckoutResult>(`/billing/v1/tiers/${tier}/checkout`, {
      method: "POST",
      body,
      context: "creating tier checkout",
      withAuth: false,
    });
  }

  /** Buy a $5 email pack (10,000 emails). */
  async buyEmailPack(identifier: AccountIdentifier): Promise<CreateCheckoutResult> {
    const body = checkoutIdentifierBody(identifier, "creating email pack checkout");

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
    if (opts.threshold !== undefined) {
      assertNonNegativeSafeInteger(opts.threshold, "threshold", "setting auto-recharge");
      body.threshold = opts.threshold;
    }

    await this.client.request<unknown>("/billing/v1/email-packs/auto-recharge", {
      method: "POST",
      body,
      context: "setting auto-recharge",
      withAuth: false,
    });
  }
}
