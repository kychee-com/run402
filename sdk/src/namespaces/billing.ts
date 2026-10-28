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
  assertHttpUrl,
  assertNonEmptyString,
  assertPositiveSafeInteger,
  assertStringInSet,
} from "../validation.js";
import type { ProjectTier } from "./projects.types.js";

export interface OrganizationDetail {
  /** Canonical organization id (UUID). */
  org_id: string;
  /** The organization's allowance: its Run402-held prepaid balance. */
  allowance_usd_micros: number;
  /** Held/reserved portion of the allowance; absent on gateways that predate the field. */
  held_usd_micros?: number;
  email_credits_remaining: number;
  tier: ProjectTier | null;
  lease_expires_at: string | null;
  auto_recharge_enabled: boolean;
  auto_recharge_threshold: number;
  /**
   * prepaid-metered-usage: the organization's metered usage and card standing
   * order; `null` when it never enabled metering and holds no saved card.
   * Absent on gateways that predate the field.
   */
  metering?: MeteringBlock | null;
}

// ─── prepaid-metered-usage ───────────────────────────────────────────────

/** Why metering is not charging right now. */
export type MeteringSuspendedReason = "allowance" | "cap" | "lease";

/** The saved card, display fields only; never a processor id. */
export interface StandingOrderPaymentMethod {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

/**
 * The card standing order: a card saved once through a setup link, a
 * threshold, and a recharge amount. When the allowance falls below the
 * threshold the card refills it, never past the metering cap in a UTC month.
 * Three declines disable the order (`disabled_reason: "card_failed"`).
 */
export interface StandingOrderBlock {
  enabled: boolean;
  threshold_usd_micros: number;
  recharge_usd_micros: number;
  disabled_reason: "card_failed" | "card_removed" | null;
  failure_count: number;
  payment_method: StandingOrderPaymentMethod | null;
}

/** The published prices for usage above the lease's included pools, in micro-dollars. */
export interface MeteredPrices {
  /** Per GB-month of storage above the included pool, prorated by the UTC day. */
  storage_gb_month_usd_micros: number;
  /** Per GB-month of vault bytes above the included pool, prorated by the UTC day. */
  source_gb_month_usd_micros: number;
  /** Per million API calls above the included amount. */
  api_calls_per_million_usd_micros: number;
}

/** A pool amount under metering: every byte count beside its human string. */
export interface MeteringPools {
  storage_bytes: number;
  storage: string;
  source_bytes: number;
  source: string;
  api_calls: number;
}

/**
 * An organization's metered usage, on `GET /orgs/v1/:org_id/billing` and
 * `GET /tiers/v1/status`. One monthly cap bounds both the daily metered
 * charges and what the card standing order may charge. While suspended
 * (`suspended_reason`: the allowance or the cap cannot cover a day, or the
 * lease lapsed) nothing is deleted and everything keeps serving; the flat
 * pool applies again and new writes past it are refused.
 */
export interface MeteringBlock {
  enabled: boolean;
  cap_usd_micros: number | null;
  suspended_at: string | null;
  suspended_reason: MeteringSuspendedReason | null;
  /** The current UTC month the cap applies to. */
  month: { started_at: string; ends_at: string };
  month_spent_usd_micros: number;
  month_charged_usd_micros: number;
  today_estimate_usd_micros: number;
  /** The lease's included pools. */
  included: MeteringPools;
  /** What the cap and the allowance still pay for above the included pools. */
  headroom: MeteringPools;
  prices: MeteredPrices;
  standing_order: StandingOrderBlock;
}

/** Options for {@link Billing.setMetering}. Amounts are micro-dollars. */
export interface SetMeteringOptions {
  organizationId: string;
  /** Turn metered usage on or off. Off keeps the cap and the card for next time. */
  enabled: boolean;
  /** The monthly cap, at least `1_000_000` ($1). Required the first time metering is enabled. */
  capUsdMicros?: number;
  /** The card standing order. Enabling it needs a saved card ({@link Billing.createCardSetup}). */
  standingOrder?: {
    enabled: boolean;
    /** Refill when the allowance falls below this, at least `5_000_000` ($5); default $10. */
    thresholdUsdMicros?: number;
    /** How much each refill adds, at least `5_000_000` ($5); default $20. */
    rechargeUsdMicros?: number;
  };
}

export interface SetMeteringResult {
  org_id: string;
  metering: MeteringBlock | null;
}

export interface CreateCardSetupOptions {
  /** Where the browser lands after the card is saved: a run402.com or localhost URL. */
  returnUrl?: string;
}

/** A one-time setup link for a person's browser; the card never reaches Run402. */
export interface CreateCardSetupResult {
  org_id: string;
  setup_url: string;
  expires_at: string;
}

/** The gateway's floors, mirrored so a bad amount is refused before the request. */
const METERING_CAP_MIN_USD_MICROS = 1_000_000;
const STANDING_ORDER_MIN_USD_MICROS = 5_000_000;

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
  has_more: boolean;
  next_cursor: string | null;
}

/** Options for {@link Billing.history} / {@link Billing.getHistory}. */
export interface BillingHistoryOptions {
  /** Page size; gateway default applies when omitted. */
  limit?: number;
  /** Opaque keyset cursor — page forward from a prior page's `next_cursor`. */
  after?: string;
}

export interface CreateCheckoutResult {
  org_id: string;
  product: CheckoutProduct;
  checkout_url: string;
  topup_id: string;
}

/**
 * A Lightning allowance top-up. `amount_usd_micros` is a
 * QUOTE fixed at mint (`usd_value_is_quote: true`) and is what settlement
 * credits. Never carries the provider's credential.
 */
export interface LightningTopup {
  org_id: string;
  product: "balance_topup";
  rail: "lightning";
  topup_id: string;
  /** The payable invoice, verbatim. */
  bolt11: string | null;
  payment_hash: string | null;
  amount_sats: number | null;
  amount_usd_micros: number;
  usd_value_is_quote: true;
  quoted_rate: { usd_per_btc: number; source: string; observed_at: string; amount_sats: number } | null;
  invoice_expires_at: string | null;
  status: "pending" | "paid" | "paid_late" | "expired";
  paid_at: string | null;
  credited_ledger_id: string | null;
  created_at: string | null;
  next_actions: Array<{ type: string; method: string; path: string; why: string }>;
}

export interface CreateLightningTopupOptions {
  /** Whole satoshis, 100–1,000,000. */
  amountSats: number;
  /** Replay-safe create: the same key returns the same top-up. */
  idempotencyKey?: string;
}

export interface WaitForTopupOptions {
  pollMs?: number;
  timeoutMs?: number;
  onPoll?: (state: LightningTopup) => void;
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
  org_api_calls_current: number;
  org_storage_bytes_current: number;
  tier_limits: {
    api_calls: number;
    storage_bytes: number;
    /** `storage_bytes` as a human string ("250 MB"). */
    storage: string;
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
      /** lightning-cash-topup: a bolt11 invoice instead of a Stripe session. */
      product?: "balance_topup";
      rail: "lightning";
      amountSats: number;
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

function assertUsdMicrosAtLeast(
  value: unknown,
  min: number,
  name: string,
  context: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new LocalError(
      `${name} must be a safe integer USD-micros amount of at least ${min}.`,
      context,
    );
  }
}

function meteringRequestBody(opts: SetMeteringOptions, context: string): Record<string, unknown> {
  if (typeof opts.enabled !== "boolean") {
    throw new LocalError("enabled must be a boolean.", context);
  }
  const body: Record<string, unknown> = { enabled: opts.enabled };
  if (opts.capUsdMicros !== undefined) {
    assertUsdMicrosAtLeast(opts.capUsdMicros, METERING_CAP_MIN_USD_MICROS, "capUsdMicros", context);
    body.cap_usd_micros = opts.capUsdMicros;
  }
  if (opts.standingOrder !== undefined) {
    const so = opts.standingOrder;
    if (!so || typeof so !== "object" || Array.isArray(so) || typeof so.enabled !== "boolean") {
      throw new LocalError("standingOrder must be an object with a boolean enabled.", context);
    }
    const standing: Record<string, unknown> = { enabled: so.enabled };
    if (so.thresholdUsdMicros !== undefined) {
      assertUsdMicrosAtLeast(so.thresholdUsdMicros, STANDING_ORDER_MIN_USD_MICROS, "standingOrder.thresholdUsdMicros", context);
      standing.threshold_usd_micros = so.thresholdUsdMicros;
    }
    if (so.rechargeUsdMicros !== undefined) {
      assertUsdMicrosAtLeast(so.rechargeUsdMicros, STANDING_ORDER_MIN_USD_MICROS, "standingOrder.rechargeUsdMicros", context);
      standing.recharge_usd_micros = so.rechargeUsdMicros;
    }
    body.standing_order = standing;
  }
  return body;
}

function checkoutRequestBody(
  request: CreateCheckoutOptions,
  context: string,
): Record<string, unknown> {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new LocalError("checkout must be an object with a product.", context);
  }
  if ("rail" in request) {
    if (request.rail !== "lightning") {
      throw new LocalError('rail must be "lightning" (omit it for a Stripe checkout).', context);
    }
    if (!Number.isSafeInteger(request.amountSats) || request.amountSats <= 0) {
      throw new LocalError("amountSats must be a positive integer number of satoshis.", context);
    }
    return { product: "balance_topup", rail: "lightning", amount_sats: request.amountSats };
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
  readonly metering: (opts: SetMeteringOptions) => Promise<SetMeteringResult>;

  constructor(private readonly client: Client) {
    this.balance = this.checkBalance.bind(this);
    this.createEmail = this.createEmailOrganization.bind(this);
    this.autoRecharge = this.setAutoRecharge.bind(this);
    this.metering = this.setMetering.bind(this);
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

  /**
   * Fetch billing history by organization id (UUID), wallet, or email. Pass
   * `{ limit, after }` to page; `after` is the opaque keyset cursor
   * (`next_cursor` from a prior page).
   */
  async history(
    identifier: OrganizationIdentifier,
    opts: BillingHistoryOptions = {},
  ): Promise<BillingHistoryResult> {
    return this.getHistory(identifier, opts);
  }

  /**
   * Fetch ledger history for a organization. History is keyed by organization id
   * (UUID): a wallet/email identifier is first resolved to its organization via the
   * lookup, then `GET /orgs/v1/:org_id/billing/history` is read.
   * Requires SIWX from a wallet linked to the organization, or an admin key.
   * Pass `{ limit, after }` to page; `after` is the opaque keyset cursor
   * (`next_cursor` from a prior page). Returns `{ org_id, entries, has_more,
   * next_cursor }`.
   */
  async getHistory(
    identifier: OrganizationIdentifier,
    opts: BillingHistoryOptions = {},
  ): Promise<BillingHistoryResult> {
    if (opts.limit !== undefined) {
      assertPositiveSafeInteger(opts.limit, "limit", "fetching billing history");
    }
    const id = classifyBillingIdentifier(identifier, "fetching billing history");
    const organizationId = id.kind === "org_id"
      ? id.value
      : (await fetchOrganizationByLookup(this.client, id.kind, id.value, "fetching billing history"))
          .org_id;
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.after !== undefined) params.set("after", opts.after);
    const query = params.toString();
    const path = `/orgs/v1/${encodeURIComponent(organizationId)}/billing/history${query ? `?${query}` : ""}`;
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

  /**
   * lightning-cash-topup: mint a bolt11 invoice that tops up the org's cash
   * balance when paid. No funds move at creation; any active org member or a
   * grant key for one of the org's projects may call it.
   */
  async createLightningTopup(
    organizationId: string,
    options: CreateLightningTopupOptions,
  ): Promise<LightningTopup> {
    assertNonEmptyString(organizationId, "organizationId", "creating Lightning top-up");
    const body = checkoutRequestBody({ rail: "lightning", amountSats: options.amountSats }, "creating Lightning top-up");
    return this.client.request<LightningTopup>(`/orgs/v1/${encodeURIComponent(organizationId)}/checkouts`, {
      method: "POST",
      body,
      ...(options.idempotencyKey ? { headers: { "Idempotency-Key": options.idempotencyKey } } : {}),
      context: "creating Lightning top-up",
    });
  }

  /** Read one top-up (the waiting client's poll). */
  async getTopup(organizationId: string, topupId: string): Promise<LightningTopup> {
    assertNonEmptyString(organizationId, "organizationId", "reading top-up");
    assertNonEmptyString(topupId, "topupId", "reading top-up");
    return this.client.request<LightningTopup>(
      `/orgs/v1/${encodeURIComponent(organizationId)}/checkouts/${encodeURIComponent(topupId)}`,
      { context: "reading top-up" },
    );
  }

  /**
   * Poll a top-up until it is paid, paid late, or expired (or the timeout
   * elapses, in which case the last observed state is returned).
   */
  async waitForTopup(organizationId: string, topupId: string, options: WaitForTopupOptions = {}): Promise<LightningTopup> {
    const pollMs = options.pollMs ?? 2_000;
    const deadline = Date.now() + (options.timeoutMs ?? 600_000);
    for (;;) {
      const state = await this.getTopup(organizationId, topupId);
      options.onPoll?.(state);
      if (state.status !== "pending" || Date.now() >= deadline) return state;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
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

  /**
   * prepaid-metered-usage: read the organization's metered usage and card
   * standing order, by organization id (UUID), wallet, or email (resolved like
   * {@link getOrganization}). `null` when the organization never enabled
   * metering and holds no saved card.
   */
  async getMetering(identifier: OrganizationIdentifier): Promise<MeteringBlock | null> {
    const detail = await resolveOrganizationDetail(this.client, identifier, "reading metering");
    return detail.metering ?? null;
  }

  /**
   * prepaid-metered-usage: turn metered usage on or off under one monthly cap,
   * and set the card standing order that refills the allowance under the same
   * cap: `PATCH /orgs/v1/:org_id/billing/metering`. Needs a live hobby or team
   * lease (`METERING_REQUIRES_LEASE` otherwise) and the billing role or
   * higher; a grant key is refused. `capUsdMicros` is required the first time
   * metering is enabled; enabling the standing order needs a saved card
   * (`STANDING_ORDER_REQUIRES_CARD`, see {@link createCardSetup}). Returns the
   * organization's metering block as every read prints it.
   */
  async setMetering(opts: SetMeteringOptions): Promise<SetMeteringResult> {
    assertNonEmptyString(opts.organizationId, "organizationId", "setting metering");
    const body = meteringRequestBody(opts, "setting metering");
    return this.client.request<SetMeteringResult>(`/orgs/v1/${encodeURIComponent(opts.organizationId)}/billing/metering`, {
      method: "PATCH",
      body,
      context: "setting metering",
    });
  }

  /**
   * prepaid-metered-usage: mint a one-time setup link that saves a card on the
   * organization for the standing order:
   * `POST /orgs/v1/:org_id/billing/payment-methods/setup`. A person opens
   * `setup_url` in a browser; the card is stored by the payment processor and
   * never reaches Run402 or this client. Billing role or higher.
   */
  async createCardSetup(
    organizationId: string,
    opts: CreateCardSetupOptions = {},
  ): Promise<CreateCardSetupResult> {
    assertNonEmptyString(organizationId, "organizationId", "creating card setup");
    const body: Record<string, unknown> = {};
    if (opts.returnUrl !== undefined) {
      assertHttpUrl(opts.returnUrl, "returnUrl", "creating card setup");
      body.return_url = opts.returnUrl;
    }
    return this.client.request<CreateCardSetupResult>(
      `/orgs/v1/${encodeURIComponent(organizationId)}/billing/payment-methods/setup`,
      { method: "POST", body, context: "creating card setup" },
    );
  }
}
