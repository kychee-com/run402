/**
 * `billing` namespace — wallet-scoped billing accounts and Stripe checkouts.
 * All operations are public (no service key required); they identify the
 * account by wallet address or email.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import {
  assertEmailAddress,
  assertEvmAddress,
  assertNonEmptyString,
  assertPositiveSafeInteger,
  assertStringInSet,
} from "../validation.js";
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

/**
 * Pool impact of a wallet-link operation (v1.46+). Returned in the
 * `link-wallet` response so the caller knows the freshly-shared pool's
 * tier, current usage, and configured limits at the moment of linking.
 */
export interface LinkWalletPoolImplications {
  tier: ProjectTier | null;
  projects_in_pool_count: number;
  account_api_calls_current: number;
  account_storage_bytes_current: number;
  tier_limits: {
    api_calls: number;
    storage_bytes: number;
  };
  over_limit: boolean;
}

export interface LinkWalletResult {
  status: string;
  billing_account_id: string;
  wallet: string;
  /** Present on v1.46+ gateways; undefined when the gateway predates the field. */
  pool_implications?: LinkWalletPoolImplications;
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

const BILLING_TIERS = ["prototype", "hobby", "team"] as const;

function encodeBillingIdentifier(
  identifier: BillingAccountIdentifier,
  context: string,
): string {
  const normalized = normalizeBillingIdentifier(identifier, context);
  return encodeURIComponent(normalized);
}

function normalizeBillingIdentifier(
  identifier: unknown,
  context: string,
): string {
  assertNonEmptyString(identifier, "identifier", context);
  if (/^0x/i.test(identifier)) {
    assertEvmAddress(identifier, "identifier", context);
    return identifier.toLowerCase();
  }
  assertEmailAddress(identifier, "identifier", context);
  return identifier;
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

function assertUsdMicrosAmount(
  value: number,
  name: string,
  context: string,
): void {
  if (!Number.isSafeInteger(value) || value < 500_000 || value % 10_000 !== 0) {
    throw new LocalError(
      `${name} must be a safe integer USD-micros amount of at least 500000 and whole-cent aligned.`,
      context,
    );
  }
}

function checkoutIdentifierBody(
  identifier: AccountIdentifier,
  context: string,
): Record<string, string> {
  if (!identifier || typeof identifier !== "object" || Array.isArray(identifier)) {
    throw new LocalError(
      "identifier must be an object with either `email` or `wallet`.",
      context,
    );
  }
  const hasEmail = identifier.email !== undefined;
  const hasWallet = identifier.wallet !== undefined;
  if (hasEmail && hasWallet) {
    throw new LocalError(
      "Provide either `email` or `wallet` in identifier, not both.",
      context,
    );
  }
  if (hasWallet) {
    assertEvmAddress(identifier.wallet, "identifier.wallet", context);
    return { wallet: identifier.wallet.toLowerCase() };
  }
  if (hasEmail) {
    assertEmailAddress(identifier.email, "identifier.email", context);
    return { email: identifier.email };
  }
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
    const encoded = encodeBillingIdentifier(identifier, "checking balance");
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
    const encoded = encodeBillingIdentifier(identifier, "fetching billing history");
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
    assertEvmAddress(wallet, "wallet", "creating checkout");
    assertUsdMicrosAmount(amountUsdMicros, "amountUsdMicros", "creating checkout");
    return this.client.request<CreateCheckoutResult>("/billing/v1/checkouts", {
      method: "POST",
      body: { wallet: wallet.toLowerCase(), amount_usd_micros: amountUsdMicros },
      context: "creating checkout",
      withAuth: false,
    });
  }

  /** Create an email-only (no-wallet) billing account. Sends a verification email. */
  async createEmailAccount(email: string): Promise<EmailBillingAccount> {
    assertEmailAddress(email, "email", "creating email billing account");
    return this.client.request<EmailBillingAccount>("/billing/v1/accounts", {
      method: "POST",
      body: { email },
      context: "creating email billing account",
      withAuth: false,
    });
  }

  /**
   * Link a wallet to an existing email billing account to enable hybrid
   * Stripe + x402 payments. Returns the gateway response; v1.46+ gateways
   * include a {@link LinkWalletPoolImplications} block describing the
   * freshly-shared pool's tier, current usage, and limits so callers can
   * warn before the merge pushes usage `over_limit`.
   */
  async linkWallet(
    billingAccountId: string,
    wallet: string,
  ): Promise<LinkWalletResult> {
    assertNonEmptyString(billingAccountId, "billingAccountId", "linking wallet");
    assertEvmAddress(wallet, "wallet", "linking wallet");
    return this.client.request<LinkWalletResult>(
      `/billing/v1/accounts/${encodeURIComponent(billingAccountId)}/link-wallet`,
      {
        method: "POST",
        body: { wallet: wallet.toLowerCase() },
        context: "linking wallet",
        withAuth: false,
      },
    );
  }

  /** Create a Stripe checkout for a tier subscription/renewal/upgrade. */
  async tierCheckout(tier: string, identifier: AccountIdentifier): Promise<CreateCheckoutResult> {
    assertStringInSet(tier, BILLING_TIERS, "tier", "creating tier checkout");
    const body = checkoutIdentifierBody(identifier, "creating tier checkout");

    return this.client.request<CreateCheckoutResult>(`/billing/v1/tiers/${encodeURIComponent(tier)}/checkout`, {
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
