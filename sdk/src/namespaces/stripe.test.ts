import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { Run402Error, SecretRequiresCliError } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handler: (call: FetchCall) => Response): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function principalCreds(): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProjectCredentials(id) {
      throw new Error(`unexpected local project credential lookup for ${id}`);
    },
  };
}

function makeSdk(fetch: typeof globalThis.fetch, capabilities?: { returnSecrets: boolean }): Run402 {
  return new Run402({
    apiBase: "https://api.example.test",
    credentials: principalCreds(),
    fetch,
    ...(capabilities ? { capabilities } : {}),
  });
}

const BASE = "https://api.example.test/projects/v1/prj_club/stripe";

function accountState(overrides: Record<string, unknown> = {}) {
  return {
    org_id: "5f0a7c2e-6f0a-4a7e-9d1a-1a2b3c4d5e6f",
    scope: "organization",
    account_id: "acct_123",
    status: "onboarding",
    livemode: false,
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
    requirements: { currently_due: ["business_profile.url"], past_due: [], eventually_due: [], disabled_reason: null },
    capabilities: { card_payments: "pending", sepa_debit_payments: "pending" },
    country: "DE",
    default_currency: null,
    dashboard: "full",
    custody: "organization",
    platform_fee_bps: 0,
    created_at: "2026-10-15T08:00:00.000Z",
    updated_at: "2026-10-15T08:00:00.000Z",
    disconnected_at: null,
    next_actions: [{ type: "complete_onboarding", method: "POST", path: "/projects/v1/prj_club/stripe/onboarding-links" }],
    ...overrides,
  };
}

describe("projects.stripe SDK", () => {
  it("connect maps camelCase prefill to the wire and returns the link once", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.url, `${BASE}/account`);
      assert.equal(call.method, "POST");
      assert.equal(call.headers["SIGN-IN-WITH-X"], "test-siwx");
      assert.deepEqual(JSON.parse(call.body as string), {
        country: "DE",
        business_type: "non_profit",
        business_name: "Ruderverein",
        statement_descriptor: "RUDERVEREIN",
      });
      return jsonResponse(
        accountState({
          onboarding: { url: "https://connect.stripe.com/setup/s/one-time", expires_at: "2026-10-15T08:05:00.000Z", kind: "account_onboarding" },
        }),
        201,
      );
    });
    const r = makeSdk(fetch);
    const result = await r.projects.stripe.account.connect("prj_club", {
      country: "DE",
      businessType: "non_profit",
      businessName: "Ruderverein",
      statementDescriptor: "RUDERVEREIN",
    });
    assert.equal(result.status, "onboarding");
    assert.equal(result.onboarding?.url, "https://connect.stripe.com/setup/s/one-time");
    assert.equal(result.platform_fee_bps, 0);
    assert.equal(calls.length, 1);
  });

  it("connect with no input sends an empty body", async () => {
    const { fetch } = mockFetch((call) => {
      assert.deepEqual(JSON.parse(call.body as string), {});
      return jsonResponse(accountState({ status: "active", onboarding: null }));
    });
    const result = await makeSdk(fetch).projects.stripe.account.connect("prj_club");
    assert.equal(result.onboarding, null);
  });

  it("get and disconnect use the account route with GET and DELETE", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.url, `${BASE}/account`);
      if (call.method === "GET") return jsonResponse(accountState({ status: "active" }));
      assert.equal(call.method, "DELETE");
      return jsonResponse({ disconnected: true, account_id: "acct_123", stripe_account_unaffected: true, org_id: "org" });
    });
    const r = makeSdk(fetch);
    const state = await r.projects.stripe.account.get("prj_club");
    assert.equal(state.status, "active");
    assert.equal("onboarding" in state, false);
    const gone = await r.projects.stripe.account.disconnect("prj_club");
    assert.equal(gone.stripe_account_unaffected, true);
    assert.deepEqual(calls.map((c) => c.method), ["GET", "DELETE"]);
  });

  it("onboardingLinks.create maps the return and refresh URLs", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, `${BASE}/onboarding-links`);
      assert.equal(call.method, "POST");
      assert.deepEqual(JSON.parse(call.body as string), {
        return_url: "https://club.run402.app/admin/stripe",
        refresh_url: "https://club.run402.app/admin/stripe?refresh=1",
      });
      return jsonResponse({ url: "https://connect.stripe.com/setup/s/x", expires_at: "2026-10-15T08:05:00.000Z", kind: "account_update" }, 201);
    });
    const link = await makeSdk(fetch).projects.stripe.onboardingLinks.create("prj_club", {
      returnUrl: "https://club.run402.app/admin/stripe",
      refreshUrl: "https://club.run402.app/admin/stripe?refresh=1",
    });
    assert.equal(link.kind, "account_update");
  });

  it("checkoutSessions.create maps the body, sends Idempotency-Key, and keeps nested wire shapes", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, `${BASE}/checkout-sessions`);
      assert.equal(call.method, "POST");
      assert.equal(call.headers["Idempotency-Key"], "member:42:2026");
      assert.deepEqual(JSON.parse(call.body as string), {
        mode: "subscription",
        line_items: [
          {
            quantity: 1,
            price_data: { currency: "eur", unit_amount: 12000, product_name: "Annual dues", recurring: { interval: "year" } },
          },
        ],
        success_url: "https://club.run402.app/join/done?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: "https://club.run402.app/join",
        customer_email: "ada@example.org",
        client_reference_id: "member:42",
        metadata: { tier: "full" },
        subscription: { trial_period_days: 14 },
        locale: "de",
      });
      return jsonResponse(
        {
          checkout_session_id: "cs_test_1",
          url: "https://checkout.stripe.com/c/pay/cs_test_1",
          expires_at: "2026-10-16T08:00:00.000Z",
          mode: "subscription",
          account_id: "acct_123",
          project_id: "prj_club",
          status: "open",
          deduplicated: false,
          next_actions: [{ type: "poll" }],
        },
        201,
      );
    });
    const session = await makeSdk(fetch).projects.stripe.checkoutSessions.create("prj_club", {
      mode: "subscription",
      lineItems: [
        {
          quantity: 1,
          price_data: { currency: "eur", unit_amount: 12000, product_name: "Annual dues", recurring: { interval: "year" } },
        },
      ],
      successUrl: "https://club.run402.app/join/done?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://club.run402.app/join",
      customerEmail: "ada@example.org",
      clientReferenceId: "member:42",
      metadata: { tier: "full" },
      subscription: { trial_period_days: 14 },
      locale: "de",
      idempotencyKey: "member:42:2026",
    });
    assert.equal(session.url, "https://checkout.stripe.com/c/pay/cs_test_1");
    assert.equal(session.deduplicated, false);
  });

  it("checkoutSessions.create without a key sends no Idempotency-Key header", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.headers["Idempotency-Key"], undefined);
      return jsonResponse({ checkout_session_id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1", mode: "payment", account_id: "acct_123", project_id: "prj_club", status: "open", deduplicated: false, next_actions: [] }, 201);
    });
    await makeSdk(fetch).projects.stripe.checkoutSessions.create("prj_club", {
      mode: "payment",
      lineItems: [{ price: "price_1", quantity: 2 }],
      successUrl: "https://club.run402.app/ok",
      cancelUrl: "https://club.run402.app/no",
    });
  });

  it("checkoutSessions.get reads the outcome and portalSessions.create maps the body", async () => {
    const { fetch } = mockFetch((call) => {
      if (call.method === "GET") {
        assert.equal(call.url, `${BASE}/checkout-sessions/cs_test_1`);
        return jsonResponse({ checkout_session_id: "cs_test_1", status: "complete", payment_status: "paid", subscription_id: "sub_1", client_reference_id: "member:42", metadata: { tier: "full" } });
      }
      assert.equal(call.url, `${BASE}/portal-sessions`);
      assert.deepEqual(JSON.parse(call.body as string), { customer: "cus_1", return_url: "https://club.run402.app/account" });
      return jsonResponse({ url: "https://billing.stripe.com/p/session/x" }, 201);
    });
    const r = makeSdk(fetch);
    const outcome = await r.projects.stripe.checkoutSessions.get("prj_club", "cs_test_1");
    assert.equal(outcome.payment_status, "paid");
    assert.equal(outcome.metadata.tier, "full");
    const portal = await r.projects.stripe.portalSessions.create("prj_club", { customer: "cus_1", returnUrl: "https://club.run402.app/account" });
    assert.equal(portal.url, "https://billing.stripe.com/p/session/x");
  });

  it("a gateway refusal surfaces as a typed error with code, details, and next_actions unchanged", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse(
        {
          error: "STRIPE_ACCOUNT_ONBOARDING_INCOMPLETE",
          code: "STRIPE_ACCOUNT_ONBOARDING_INCOMPLETE",
          message: "Stripe still needs information from the account holder.",
          details: { requirements: { currently_due: ["external_account"] } },
          next_actions: [{ type: "complete_onboarding", method: "POST", path: "/projects/v1/prj_club/stripe/onboarding-links" }],
        },
        403,
      ),
    );
    await assert.rejects(
      makeSdk(fetch).projects.stripe.checkoutSessions.create("prj_club", {
        mode: "payment",
        lineItems: [{ price: "price_1" }],
        successUrl: "https://club.run402.app/ok",
        cancelUrl: "https://club.run402.app/no",
      }),
      (err: unknown) => {
        assert.ok(err instanceof Run402Error);
        assert.equal(err.code, "STRIPE_ACCOUNT_ONBOARDING_INCOMPLETE");
        assert.deepEqual((err.details as { requirements: unknown }).requirements, { currently_due: ["external_account"] });
        assert.equal(err.nextActions?.[0]?.type, "complete_onboarding");
        return true;
      },
    );
  });

  it("the sandbox surface refuses the link-returning methods and names the CLI command, before any request", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const r = makeSdk(fetch, { returnSecrets: false });
    await assert.rejects(r.projects.stripe.account.connect("prj_club", { country: "DE" }), (err: unknown) => {
      assert.ok(err instanceof SecretRequiresCliError);
      assert.equal(err.code, "SECRET_REQUIRES_CLI");
      assert.equal(err.nextActions?.[0]?.command, "run402 stripe account connect --project prj_club");
      return true;
    });
    await assert.rejects(r.projects.stripe.onboardingLinks.create("prj_club"), (err: unknown) => {
      assert.ok(err instanceof SecretRequiresCliError);
      assert.equal(err.nextActions?.[0]?.command, "run402 stripe account onboarding-link --project prj_club");
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("the sandbox surface still creates checkout and portal sessions", async () => {
    const { fetch, calls } = mockFetch((call) =>
      call.url.endsWith("/portal-sessions")
        ? jsonResponse({ url: "https://billing.stripe.com/p/session/x" }, 201)
        : jsonResponse({ checkout_session_id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1", mode: "payment", account_id: "acct_123", project_id: "prj_club", status: "open", deduplicated: false, next_actions: [] }, 201),
    );
    const r = makeSdk(fetch, { returnSecrets: false });
    const session = await r.projects.stripe.checkoutSessions.create("prj_club", {
      mode: "payment",
      lineItems: [{ price: "price_1" }],
      successUrl: "https://club.run402.app/ok",
      cancelUrl: "https://club.run402.app/no",
    });
    assert.equal(session.url, "https://checkout.stripe.com/c/pay/cs_1");
    const portal = await r.projects.stripe.portalSessions.create("prj_club", { customer: "cus_1", returnUrl: "https://club.run402.app/account" });
    assert.equal(portal.url, "https://billing.stripe.com/p/session/x");
    assert.equal(calls.length, 2);
  });

  it("the project-scoped client pre-binds the project id", async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.method === "GET") return jsonResponse(accountState());
      return jsonResponse({ url: "https://billing.stripe.com/p/session/x" }, 201);
    });
    const p = makeSdk(fetch).project("prj_club");
    await p.projects.stripe.account.get();
    await p.projects.stripe.portalSessions.create({ customer: "cus_1", returnUrl: "https://club.run402.app/account" });
    assert.deepEqual(
      calls.map((c) => c.url),
      [`${BASE}/account`, `${BASE}/portal-sessions`],
    );
  });
});
