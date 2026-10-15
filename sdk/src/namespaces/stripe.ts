/**
 * `projects.stripe` namespace — the organization's Stripe account for a
 * project's app, and Checkout / customer-portal sessions on it.
 *
 * The organization that owns the project holds its own Stripe account,
 * connected to Run402's platform; Run402 charges nothing on it (zero platform
 * fee) and never holds the money. Every call here is a thin, typed request to
 * the project-scoped `/projects/v1/:project_id/stripe/*` routes: the gateway
 * owns account state, body validation, the return-URL allowlist, and
 * idempotency, and its `next_actions` and error codes surface unchanged.
 *
 * Two methods hand out a one-time Stripe-hosted onboarding link meant for the
 * account holder, not a payer: `account.connect` (while onboarding is
 * incomplete) and `onboardingLinks.create`. They are secret-returning, so the
 * MCP `run` sandbox refuses them and names the CLI command. Checkout and
 * portal URLs are meant to be handed to a payer and run on every surface.
 * Nothing here caches a URL.
 */

import type { Client } from "../kernel.js";
import type { NextAction } from "../errors.js";
import { gateSecret } from "../secret-gate.js";

export type StripeAccountStatus = "creating" | "onboarding" | "active" | "restricted" | "disconnected";
export type StripeOnboardingLinkKind = "account_onboarding" | "account_update";
export type StripeCheckoutMode = "subscription" | "payment";

export interface StripeAccountRequirements {
  currently_due?: string[];
  past_due?: string[];
  eventually_due?: string[];
  disabled_reason?: string | null;
}

/** The organization's connected account as the gateway reads it from Stripe. */
export interface StripeAccountState {
  org_id: string;
  scope: "organization";
  /** `acct_…`; null only while the create is still being confirmed. */
  account_id: string | null;
  status: StripeAccountStatus;
  livemode?: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements: StripeAccountRequirements;
  /** Capability statuses by name (`card_payments`, `sepa_debit_payments`). */
  capabilities: Record<string, string>;
  country?: string | null;
  default_currency?: string | null;
  dashboard: "full";
  custody: "organization";
  platform_fee_bps: 0;
  created_at: string;
  updated_at: string;
  disconnected_at?: string | null;
  next_actions: NextAction[];
}

/** A one-time Stripe-hosted onboarding link for the account holder. */
export interface StripeOnboardingLink {
  /** One-time; hand it to the account holder inside your authenticated page. Never cache it. */
  url: string;
  expires_at: string;
  kind: StripeOnboardingLinkKind;
  account_id?: string;
  next_actions?: NextAction[];
}

export interface StripeAccountConnectResult extends StripeAccountState {
  /** A fresh one-time onboarding link while onboarding is incomplete; null once the account is active. */
  onboarding: StripeOnboardingLink | null;
}

export interface StripeAccountDisconnectResult {
  disconnected: true;
  account_id: string | null;
  /** The Stripe account itself is untouched: only its connection to the platform is removed. */
  stripe_account_unaffected: true;
  org_id: string;
  next_actions?: NextAction[];
}

/** Optional prefill; Stripe collects whatever is missing during hosted onboarding. */
export interface StripeAccountConnectInput {
  /** ISO 3166-1 alpha-2. Decides whether SEPA Direct Debit is requested. */
  country?: string;
  businessType?: "company" | "individual" | "non_profit";
  /** The display and registered name. */
  businessName?: string;
  /** Shown to payers on receipts and bank statements. */
  supportEmail?: string;
  /** What the payer's bank statement says (5–22 characters). */
  statementDescriptor?: string;
  /** The account's contact email (Stripe's own communications go here). */
  email?: string;
}

export interface StripeOnboardingLinkInput {
  /** HTTPS on one of the project's own hosts or the console; defaults to the console's account page. */
  returnUrl?: string;
  /** Where Stripe sends the holder when the link expired or was used; same rule. */
  refreshUrl?: string;
}

/** One line of a Checkout Session, in the wire's shape. `price` or `price_data`, never both. */
export interface StripeCheckoutLineItem {
  /** An existing price on the organization's account (`price_…`). */
  price?: string;
  quantity?: number;
  price_data?: {
    /** Lowercase ISO 4217 (`eur`, `usd`). SEPA Direct Debit needs `eur`. */
    currency: string;
    /** In the currency's minor unit (12000 = €120.00). */
    unit_amount: number;
    product_name: string;
    /** Required in mode `subscription`, refused in mode `payment`. */
    recurring?: { interval: "day" | "week" | "month" | "year"; interval_count?: number };
  };
}

export interface StripeCheckoutSessionCreateInput {
  mode: StripeCheckoutMode;
  lineItems: StripeCheckoutLineItem[];
  /** HTTPS on one of the project's own hosts or the console. */
  successUrl: string;
  cancelUrl: string;
  /** An existing customer on the organization's account (`cus_…`); not with `customerEmail`. */
  customer?: string;
  customerEmail?: string;
  /** Your own id for the payer (`member:42`); echoed on every event about the session and its subscription. */
  clientReferenceId?: string;
  /** Up to 40 string values; keys beginning `run402_` are reserved. */
  metadata?: Record<string, string>;
  /** Stripe Tax under the organization's own registrations. */
  automaticTax?: { enabled: boolean };
  /** Mode `subscription` only. */
  subscription?: { trial_period_days?: number; metadata?: Record<string, string> };
  /** A Checkout locale (`de`, `fr-FR`, `auto`). */
  locale?: string;
  allowPromotionCodes?: boolean;
  /** ISO-8601, between 30 minutes and 24 hours from now. */
  expiresAt?: string;
  /** Sent as `Idempotency-Key`: the same key with the same body returns the original session. */
  idempotencyKey?: string;
}

export interface StripeCheckoutSession {
  checkout_session_id: string;
  /** Send the payer here. One-time; never cached. */
  url: string;
  expires_at?: string | null;
  mode: StripeCheckoutMode;
  account_id: string;
  project_id: string;
  status: "open";
  /** true when an `Idempotency-Key` replay returned the original session. */
  deduplicated: boolean;
  next_actions: NextAction[];
}

/** A Checkout Session's outcome as the gateway reads it from Stripe. */
export interface StripeCheckoutSessionOutcome {
  checkout_session_id: string;
  /** `open`, `complete`, `expired`. */
  status: string | null;
  /** `paid`, `unpaid`, `no_payment_required`. */
  payment_status: string | null;
  mode?: string | null;
  customer_id?: string | null;
  subscription_id?: string | null;
  payment_intent_id?: string | null;
  /** Minor units. */
  amount_total?: number | null;
  currency?: string | null;
  customer_email?: string | null;
  client_reference_id?: string | null;
  /** Your keys only; the `run402_` stamps are stripped. */
  metadata: Record<string, string>;
  created_at?: string | null;
  expires_at?: string | null;
}

export interface StripePortalSessionCreateInput {
  /** An existing customer on the organization's account (`cus_…`). */
  customer: string;
  /** HTTPS on one of the project's own hosts or the console. */
  returnUrl: string;
}

export interface StripePortalSession {
  url: string;
}

function stripePath(projectId: string, suffix: string): string {
  return `/projects/v1/${encodeURIComponent(projectId)}/stripe/${suffix}`;
}

function authMeta(method: string, projectId: string) {
  return { method, target: { project_id: projectId } };
}

function defined(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) out[key] = value;
  return out;
}

/** `r.projects.stripe.account` — connect, read, and detach the organization's account. */
export class ProjectStripeAccount {
  constructor(private readonly client: Client) {}

  /**
   * Connect the organization's Stripe account, or return the one it already
   * has (idempotent per organization). While onboarding is incomplete the
   * result carries a one-time `onboarding` link for the account holder.
   */
  async connect(projectId: string, input: StripeAccountConnectInput = {}): Promise<StripeAccountConnectResult> {
    gateSecret(this.client, "projects.stripe.account.connect", projectId, input);
    return this.client.request<StripeAccountConnectResult>(stripePath(projectId, "account"), {
      method: "POST",
      body: defined({
        country: input.country,
        business_type: input.businessType,
        business_name: input.businessName,
        support_email: input.supportEmail,
        statement_descriptor: input.statementDescriptor,
        email: input.email,
      }),
      authMeta: authMeta("projects.stripe.account.connect", projectId),
      context: "connecting Stripe account",
    });
  }

  /** The organization's account, read fresh from Stripe. Never carries a link. */
  async get(projectId: string): Promise<StripeAccountState> {
    return this.client.request<StripeAccountState>(stripePath(projectId, "account"), {
      method: "GET",
      authMeta: authMeta("projects.stripe.account.get", projectId),
      context: "reading Stripe account",
    });
  }

  /** Detach the account from the platform. The Stripe account itself is unaffected. */
  async disconnect(projectId: string): Promise<StripeAccountDisconnectResult> {
    return this.client.request<StripeAccountDisconnectResult>(stripePath(projectId, "account"), {
      method: "DELETE",
      authMeta: authMeta("projects.stripe.account.disconnect", projectId),
      context: "disconnecting Stripe account",
    });
  }
}

/** `r.projects.stripe.onboardingLinks` — one-time Stripe-hosted onboarding links. */
export class ProjectStripeOnboardingLinks {
  constructor(private readonly client: Client) {}

  /** Mint a one-time onboarding (or update) link for the account holder. */
  async create(projectId: string, input: StripeOnboardingLinkInput = {}): Promise<StripeOnboardingLink> {
    gateSecret(this.client, "projects.stripe.onboardingLinks.create", projectId, input);
    return this.client.request<StripeOnboardingLink>(stripePath(projectId, "onboarding-links"), {
      method: "POST",
      body: defined({ return_url: input.returnUrl, refresh_url: input.refreshUrl }),
      authMeta: authMeta("projects.stripe.onboardingLinks.create", projectId),
      context: "minting Stripe onboarding link",
    });
  }
}

/** `r.projects.stripe.checkoutSessions` — Checkout Sessions on the organization's account. */
export class ProjectStripeCheckoutSessions {
  constructor(private readonly client: Client) {}

  /**
   * Create a Checkout Session and get the URL to send the payer to. Pass
   * `idempotencyKey` so a retry returns the original session (`deduplicated`).
   */
  async create(projectId: string, input: StripeCheckoutSessionCreateInput): Promise<StripeCheckoutSession> {
    const { idempotencyKey, ...rest } = input;
    return this.client.request<StripeCheckoutSession>(stripePath(projectId, "checkout-sessions"), {
      method: "POST",
      body: defined({
        mode: rest.mode,
        line_items: rest.lineItems,
        success_url: rest.successUrl,
        cancel_url: rest.cancelUrl,
        customer: rest.customer,
        customer_email: rest.customerEmail,
        client_reference_id: rest.clientReferenceId,
        metadata: rest.metadata,
        automatic_tax: rest.automaticTax,
        subscription: rest.subscription,
        locale: rest.locale,
        allow_promotion_codes: rest.allowPromotionCodes,
        expires_at: rest.expiresAt,
      }),
      ...(idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
      authMeta: authMeta("projects.stripe.checkoutSessions.create", projectId),
      context: "creating Stripe checkout session",
    });
  }

  /** A session's outcome (`status`, `payment_status`, ids), read from Stripe. */
  async get(projectId: string, checkoutSessionId: string): Promise<StripeCheckoutSessionOutcome> {
    return this.client.request<StripeCheckoutSessionOutcome>(
      stripePath(projectId, `checkout-sessions/${encodeURIComponent(checkoutSessionId)}`),
      {
        method: "GET",
        authMeta: authMeta("projects.stripe.checkoutSessions.get", projectId),
        context: "reading Stripe checkout session",
      },
    );
  }
}

/** `r.projects.stripe.portalSessions` — the organization's Stripe customer portal. */
export class ProjectStripePortalSessions {
  constructor(private readonly client: Client) {}

  /** Open the customer portal for an existing customer; send them to `url`. */
  async create(projectId: string, input: StripePortalSessionCreateInput): Promise<StripePortalSession> {
    return this.client.request<StripePortalSession>(stripePath(projectId, "portal-sessions"), {
      method: "POST",
      body: { customer: input.customer, return_url: input.returnUrl },
      authMeta: authMeta("projects.stripe.portalSessions.create", projectId),
      context: "creating Stripe portal session",
    });
  }
}

/** `r.projects.stripe` — the organization's Stripe account and sessions for a project. */
export class ProjectStripe {
  readonly account: ProjectStripeAccount;
  readonly onboardingLinks: ProjectStripeOnboardingLinks;
  readonly checkoutSessions: ProjectStripeCheckoutSessions;
  readonly portalSessions: ProjectStripePortalSessions;

  constructor(client: Client) {
    this.account = new ProjectStripeAccount(client);
    this.onboardingLinks = new ProjectStripeOnboardingLinks(client);
    this.checkoutSessions = new ProjectStripeCheckoutSessions(client);
    this.portalSessions = new ProjectStripePortalSessions(client);
  }
}
