---
title: Stripe payments for your app
description: Connect the organization's own Stripe account and take card or SEPA dues through Checkout.
---

An app that collects dues, fees, or one-off payments uses the organization's OWN Stripe account. The organization connects it to Run402's platform once; your app then creates Checkout Sessions on it and reacts to the money events. Run402 charges nothing on the account, never holds the money, and your app never holds a Stripe key.

```bash
run402 stripe account connect --country DE --business-type non_profit --project prj_example
run402 stripe account status --project prj_example
run402 stripe checkout create --mode subscription --price-data '{"currency":"eur","unit_amount":12000,"product_name":"Annual dues","recurring":{"interval":"year"}}' --success-url https://club.run402.app/join/done --cancel-url https://club.run402.app/join --client-reference-id member:42 --project prj_example
run402 stripe checkout get cs_test_123 --project prj_example
run402 stripe portal create --customer cus_123 --return-url https://club.run402.app/account --project prj_example
```

Use the [stripe command reference](/cli/ops/) for every flag and the [SDK namespace](/sdk/resources/) for the typed calls (`r.projects.stripe.*`).

## The golden path

1. **Connect once.** `stripe account connect` creates the organization's connected account (or returns the one it has) and, while onboarding is incomplete, a one-time `onboarding.url`. Hand that link to the person who owns the organization; they complete Stripe's hosted onboarding (identity, bank account, SEPA mandate text). The link is printed once and expires in minutes; mint another with `stripe account onboarding-link` when it was used or expired.
2. **Wait for `active`.** `stripe account status` reads the account fresh from Stripe. Until `status` is `active` and `charges_enabled` is true, a Checkout request answers `403 STRIPE_ACCOUNT_ONBOARDING_INCOMPLETE` with `details.requirements` and a `complete_onboarding` next action.
3. **Create a Checkout Session per payer.** From a function, call `r.projects.stripe.checkoutSessions.create(projectId, …)` (or the HTTP route with the project's service key) with `mode: "subscription"` for recurring dues or `"payment"` for a one-off, your own `clientReferenceId` (for example `member:42`), and an `idempotencyKey` so a retry returns the same session. Send the payer to the returned `url`. Both URLs must be HTTPS on one of the project's own hosts or the console.
4. **React to events, not to the redirect.** The success page may read the outcome with `checkoutSessions.get`, but the source of truth is the project's events feed: `stripe_checkout_completed`, `stripe_invoice_paid` (every renewal), `stripe_invoice_payment_failed` (a bounced SEPA debit arrives days later), `stripe_subscription_updated`, and `stripe_subscription_deleted`, each carrying your `client_reference_id` and metadata. Route them to a function with a notification rule (`channel: webhook`, the `stripe_*` types) or poll `run402 events list`, and update your own membership row from them.
5. **Let members manage themselves.** `stripe portal create` opens Stripe's customer portal for a customer; link to it from the member's account page.

## Read the result and recover

- `STRIPE_ACCOUNT_REQUIRED` (403): the organization has no account yet; the `connect_stripe_account` next action names the connect route.
- `STRIPE_ACCOUNT_RESTRICTED` (403): Stripe paused the account; `details.disabled_reason` says why and the fix is in the organization's own Stripe dashboard.
- `STRIPE_RETURN_URL_NOT_ALLOWED` (422): a URL is not on one of the project's hosts; `details.allowed_hosts[]` lists what is.
- `STRIPE_UPSTREAM_ERROR` (502): Stripe refused the request; `details.code` and `details.param` are Stripe's own. A 503 with `Retry-After` means Stripe was unreachable; retry.
- `STRIPE_CONNECT_UNAVAILABLE` (503): the platform is not configured for Stripe; nothing on your side fixes it.

Disconnecting (`stripe account disconnect --confirm`) only ends the connection to Run402. The Stripe account, its customers, and its subscriptions are untouched, but Run402 stops receiving their events. Transferring the project to another organization does not move the account: the recipient organization connects its own.
