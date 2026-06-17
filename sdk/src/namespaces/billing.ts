/**
 * `billing` namespace — organizations and Stripe checkouts.
 *
 * Organizations are addressed by their canonical `org_id` (UUID). A
 * wallet or email is resolved to that id through the
 * `GET /orgs/v1/lookup?wallet=|?email=` lookup; `getOrganization` / `history`
 * accept any of the three identifier forms and resolve internally. Organization
 * reads require SIWX from a wallet linked to the organization (or matching the
 * looked-up `?wallet`), or an admin key; email lookups are admin-only.
 * Mutations such as link-wallet, checkout creation, and auto-recharge require
 * an org credential (or admin).
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

export interface OrganizationDetail {
  /** Canonical organization id (UUID). */
  org_id: string;
  available_usd_micros: number;
  /** Held/reserved portion of the balance; absent on gateways that predate the field. */
  held_usd_micros?: number;
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
  /** Canonical organization id (UUID) the entries belong to. */
  org_id: string;
  entries: BillingHistoryEntry[];
}

export interface CreateCheckoutResult {
  org_id: string;
  product: CheckoutProduct;
  checkout_url: string;
  topup_id: string;
}

export interface EmailOrganization {
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
  organization_api_calls_current: number;
  organization_storage_bytes_current: number;
  tier_limits: {
    api_calls: number;
    storage_bytes: number;
  };
  over_limit: boolean;
}

export interface LinkWalletResult {
  status: string;
  org_id: string;
  wallet: string;
  /** Present on v1.46+ gateways; undefined when the gateway predates the field. */
  pool_implications?: LinkWalletPoolImplications;
}

export type OrganizationIdentifier = string;

export type CheckoutProduct = "balance_topup" | "tier" | "email_pack";

export type CreateCheckoutOptions =
  | {
      product: "balance_topup";
      amountUsdMicros: number;
      successUrl?: string;
      cancelUrl?: string;
    }
  | {
      product: "tier";
      tier: ProjectTier;
      successUrl?: string;
      cancelUrl?: string;
    }
  | {
      product: "email_pack";
      successUrl?: string;
      cancelUrl?: string;
    };

export interface AutoRechargeOptions {
  organizationId: string;
  enabled: boolean;
  threshold?: number;
}

const BILLING_TIERS = ["prototype", "hobby", "team"] as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BillingIdentifierKind = "org_id" | "wallet" | "email";

interface ClassifiedBillingIdentifier {
  kind: BillingIdentifierKind;
  value: string;
}

/**
 * Classify a billing identifier as a canonical organization id (UUID), an EVM
 * wallet address, or an email. Wallets are lowercased; organization ids and emails
 * are returned verbatim. Throws {@link LocalError} for anything else.
 */
function classifyBillingIdentifier(
  identifier: unknown,
  context: string,
): ClassifiedBillingIdentifier {
  assertNonEmptyString(identifier, "identifier", context);
  if (UUID_RE.test(identifier)) {
    return { kind: "org_id", value: identifier };
  }
  if (/^0x/i.test(identifier)) {
    assertEvmAddress(identifier, "identifier", context);
    return { kind: "wallet", value: identifier.toLowerCase() };
  }
  assertEmailAddress(identifier, "identifier", context);
  return { kind: "email", value: identifier };
}

/** Read organization billing detail by canonical id: `GET /orgs/v1/:org_id/billing`. */
function fetchOrganizationById(
  client: Client,
  organizationId: string,
  context: string,
): Promise<OrganizationDetail> {
  return client.request<OrganizationDetail>(
    `/orgs/v1/${encodeURIComponent(organizationId)}/billing`,
    { context },
  );
}

/**
 * Resolve a wallet / email to its organization detail via the lookup endpoint
 * `GET /orgs/v1/lookup?wallet=|?email=`. The lookup returns the same
 * detail shape as the by-id read, including the resolved `org_id`.
 */
function fetchOrganizationByLookup(
  client: Client,
  kind: "wallet" | "email",
  value: string,
  context: string,
): Promise<OrganizationDetail> {
  return client.request<OrganizationDetail>(
    `/orgs/v1/lookup?${kind}=${encodeURIComponent(value)}`,
    { context },
  );
}

/**
 * Resolve any identifier form (organization id / wallet / email) to the organization
 * detail. Organization ids hit the canonical by-id read; wallet/email go through
 * the `?wallet=`/`?email=` lookup. All paths send SIWX via the kernel default.
 */
async function resolveOrganizationDetail(
  client: Client,
  identifier: OrganizationIdentifier,
  context: string,
): Promise<OrganizationDetail> {
  const id = classifyBillingIdentifier(identifier, context);
  return id.kind === "org_id"
    ? fetchOrganizationById(client, id.value, context)
    : fetchOrganizationByLookup(client, id.kind, id.value, context);
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

function checkoutRequestBody(
  request: CreateCheckoutOptions,
  context: string,
): Record<string, unknown> {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new LocalError("checkout must be an object with a product.", context);
  }
  if (request.product === "balance_topup") {
    assertUsdMicrosAmount(request.amountUsdMicros, "amountUsdMicros", context);
    return {
      product: "balance_topup",
      amount_usd_micros: request.amountUsdMicros,
      ...(request.successUrl !== undefined ? { success_url: request.successUrl } : {}),
      ...(request.cancelUrl !== undefined ? { cancel_url: request.cancelUrl } : {}),
    };
  }
  if (request.product === "tier") {
    assertStringInSet(request.tier, BILLING_TIERS, "tier", context);
    return {
      product: "tier",
      tier: request.tier,
      ...(request.successUrl !== undefined ? { success_url: request.successUrl } : {}),
      ...(request.cancelUrl !== undefined ? { cancel_url: request.cancelUrl } : {}),
    };
  }
  if (request.product === "email_pack") {
    return {
      product: "email_pack",
      ...(request.successUrl !== undefined ? { success_url: request.successUrl } : {}),
      ...(request.cancelUrl !== undefined ? { cancel_url: request.cancelUrl } : {}),
    };
  }
  throw new LocalError("product must be one of: balance_topup, tier, email_pack.", context);
}

export class Billing {
  readonly balance: (identifier: OrganizationIdentifier) => Promise<OrganizationDetail>;
  readonly createEmail: (email: string) => Promise<EmailOrganization>;
  readonly autoRecharge: (opts: AutoRechargeOptions) => Promise<void>;

  constructor(private readonly client: Client) {
    this.balance = this.checkBalance.bind(this);
    this.createEmail = this.createEmailOrganization.bind(this);
    this.autoRecharge = this.setAutoRecharge.bind(this);
  }

  /** Check a organization by organization id (UUID), wallet, or email. */
  async checkBalance(identifier: OrganizationIdentifier): Promise<OrganizationDetail> {
    return this.getOrganization(identifier);
  }

  /**
   * Read a organization's financial detail by organization id (UUID), wallet,
   * or email. An organization id reads `GET /orgs/v1/:org_id/billing`
   * directly; a wallet/email is resolved through the
   * `GET /orgs/v1/lookup?wallet=|?email=` lookup. Requires SIWX from a
   * wallet linked to the organization (or matching the looked-up `?wallet`), or an
   * admin key; email lookups are admin-only.
   */
  async getOrganization(identifier: OrganizationIdentifier): Promise<OrganizationDetail> {
    return resolveOrganizationDetail(this.client, identifier, "checking balance");
  }

  /**
   * Resolve a wallet or email to its organization detail — including the
   * canonical `org_id` — via `GET /orgs/v1/lookup?wallet=|?email=`.
   * An org-id (UUID) argument is read directly instead. SIWX must match the
   * `?wallet`; email lookups are admin-only.
   */
  async lookupOrganization(identifier: OrganizationIdentifier): Promise<OrganizationDetail> {
    return resolveOrganizationDetail(this.client, identifier, "looking up organization");
  }

  /** Fetch billing history by organization id (UUID), wallet, or email. */
  async history(identifier: OrganizationIdentifier, limit?: number): Promise<BillingHistoryResult> {
    return this.getHistory(identifier, limit);
  }

  /**
   * Fetch ledger history for a organization. History is keyed by organization id
   * (UUID): a wallet/email identifier is first resolved to its organization via the
   * lookup, then `GET /orgs/v1/:org_id/billing/history` is read.
   * Requires SIWX from a wallet linked to the organization, or an admin key.
   */
  async getHistory(identifier: OrganizationIdentifier, limit?: number): Promise<BillingHistoryResult> {
    if (limit !== undefined) {
      assertPositiveSafeInteger(limit, "limit", "fetching billing history");
    }
    const id = classifyBillingIdentifier(identifier, "fetching billing history");
    const organizationId = id.kind === "org_id"
      ? id.value
      : (await fetchOrganizationByLookup(this.client, id.kind, id.value, "fetching billing history"))
          .org_id;
    const base = `/orgs/v1/${encodeURIComponent(organizationId)}/billing/history`;
    const path = limit !== undefined
      ? `${base}?limit=${encodeURIComponent(String(limit))}`
      : base;
    return this.client.request<BillingHistoryResult>(path, {
      context: "fetching billing history",
    });
  }

  /** Create a Stripe checkout URL for an organization. */
  async createCheckout(
    organizationId: string,
    checkout: CreateCheckoutOptions,
  ): Promise<CreateCheckoutResult> {
    assertNonEmptyString(organizationId, "organizationId", "creating checkout");
    const body = checkoutRequestBody(checkout, "creating checkout");
    return this.client.request<CreateCheckoutResult>(`/orgs/v1/${encodeURIComponent(organizationId)}/checkouts`, {
      method: "POST",
      body,
      context: "creating checkout",
    });
  }

  /** Create an email-only (no-wallet) organization. Sends a verification email. */
  async createEmailOrganization(email: string): Promise<EmailOrganization> {
    assertEmailAddress(email, "email", "creating email organization");
    return this.client.request<EmailOrganization>("/orgs/v1/email", {
      method: "POST",
      body: { email },
      context: "creating email organization",
      withAuth: false,
    });
  }

  /**
   * Link a wallet to an existing email organization to enable hybrid
   * Stripe + x402 payments. `organizationId` is the canonical
   * `org_id` (UUID) returned by `createEmailOrganization` /
   * `lookupOrganization`; the gateway addresses the route as
   * `POST /orgs/v1/:org_id/wallets`. Returns the gateway
   * response; v1.46+ gateways include a {@link LinkWalletPoolImplications}
   * block describing the freshly-shared pool's tier, current usage, and limits
   * so callers can warn before the merge pushes usage `over_limit`.
   */
  async linkWallet(
    organizationId: string,
    wallet: string,
  ): Promise<LinkWalletResult> {
    assertNonEmptyString(organizationId, "organizationId", "linking wallet");
    assertEvmAddress(wallet, "wallet", "linking wallet");
    return this.client.request<LinkWalletResult>(
      `/orgs/v1/${encodeURIComponent(organizationId)}/wallets`,
      {
        method: "POST",
        body: { wallet: wallet.toLowerCase() },
        context: "linking wallet",
      },
    );
  }

  /** Enable/disable email-pack auto-recharge. */
  async setAutoRecharge(opts: AutoRechargeOptions): Promise<void> {
    assertNonEmptyString(opts.organizationId, "organizationId", "setting auto-recharge");
    const body: Record<string, unknown> = {
      enabled: opts.enabled,
    };
    if (opts.threshold !== undefined) {
      assertNonNegativeSafeInteger(opts.threshold, "threshold", "setting auto-recharge");
      body.threshold = opts.threshold;
    }

    await this.client.request<unknown>(`/orgs/v1/${encodeURIComponent(opts.organizationId)}/billing/auto-recharge`, {
      method: "PATCH",
      body,
      context: "setting auto-recharge",
    });
  }
}
