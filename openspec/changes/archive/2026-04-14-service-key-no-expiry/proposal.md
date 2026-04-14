# Proposal: service-key-no-expiry

**Status:** Ready to review
**Severity:** Medium — silent foot-gun for function-based projects. A function deployed early in a lease gets a `RUN402_SERVICE_KEY` env var that stops validating at the original lease boundary, even if the owner renews. Symptoms: function 500s with `401 "Invalid token"` on calls back to the gateway.

## Problem

`service_key` JWTs are signed with `expiresIn = tier.leaseDays * 24h` (`packages/gateway/src/services/projects.ts:147, :197`). The `exp` claim gates nothing that isn't already gated by server-side checks, but it actively breaks deployed functions on renewal.

Concretely:

1. **The `exp` claim is redundant with middleware.** `serviceKeyAuth` (`middleware/apikey.ts:53`) already looks up `projectCache.get(payload.project_id)` and rejects if `!isServingStatus(project.status)`. The lifecycle state machine (`active` → `past_due` → `frozen` → `dormant` → `purged`) is the real authority on whether a key can act. `lifecycleGate` adds a second layer for control-plane writes. The JWT's `exp` duplicates neither and protects nothing.

2. **It is asymmetric with `anon_key`.** Commit `54379423` (2026-03-17) removed `expiresIn` from `anon_key` with the explicit rationale *"Lease enforcement happens in apikeyAuth middleware, not in the JWT"*. The same rationale applies to `service_key` — same middleware, same enforcement, same tier system.

3. **It breaks functions on tier renewal.** The gateway burns `RUN402_SERVICE_KEY` into each Lambda's env vars at deploy time (`services/functions.ts:328`). When the tier renews, the wallet's `lease_expires_at` in `internal.wallet_tier_leases` advances, but the Lambda env var is unchanged — and the secrets-sync path (`services/functions.ts:903-917`) deliberately reads the **existing** env var value back and re-writes it unchanged ("best effort"). So a function deployed on day 1 of a 30-day lease silently stops working on day 30, regardless of whether the owner paid.

4. **There is no rotation endpoint.** `POST /projects/v1/:id/keys` doesn't exist. The only ways to obtain a fresh-exp service_key are `POST /projects/v1` (new project) or `POST /fork/v1` (new project). An owner whose key expired has no in-product path to recover an existing project's key.

5. **The test comment codifies the misunderstanding.** `test/email-e2e.ts:453` says *"After project deletion, the service_key is expired so we need admin"*. In reality the JWT `exp` is still valid milliseconds after the DELETE — it's the project's terminal `status` that causes the 404 inside `serviceKeyAuth`. The test would behave identically if the JWT had no `exp` claim.

## Fix

Drop `expiresIn` from both `jwt.sign` calls in `services/projects.ts`. Align `service_key` with `anon_key`: a stateless JWT bearing `{role, project_id, iss}`, no `exp`. All lease / lifecycle / tier authority stays where it already lives — in `projectCache`, `isServingStatus`, `lifecycleGate`, and `getWalletTier`.

```diff
 const serviceKey = jwt.sign(
   { role: "service_role", project_id: projectId, iss: "agentdb" },
   JWT_SECRET,
-  { expiresIn: `${Math.floor(leaseMs / 1000)}s` },
 );
```

Update docs (`site/llms.txt:784`, `site/llms-cli.txt:514`) to remove the *"Expires with lease"* claim. Update two unit tests (`services/projects.test.ts:388-395, :451-464`) that currently assert `decoded.exp` is present — invert to assert it is absent, symmetric with the existing `anonKey has no expiry` test. Fix the misleading comment in `test/email-e2e.ts:453`.

## Why this is safe

- **No new authority granted.** A service_key could already do everything admin-level to its project while its `exp` was valid. This change doesn't widen that authority; it removes a self-imposed time bomb on the key. Runtime gates are unchanged.
- **Terminal-state projects still reject.** `serviceKeyAuth`'s `projectCache` + `isServingStatus` check is unchanged. A key for a purged/archived project will still 404, same as today.
- **Frozen/dormant projects still reject control-plane writes.** `lifecycleGate` runs after `serviceKeyAuth` and is unaffected.
- **Existing keys in circulation keep their current `exp`.** This change only affects keys minted after deploy. In-flight keys continue to expire on their original schedule — consistent with how the anon_key change landed (no re-signing of issued keys).
- **Shared `JWT_SECRET` rotation is the real revocation mechanism.** A leaked service_key is a compromise that requires explicit action (rotate `JWT_SECRET`, or evolve the project-keys spec to support per-project `kid`-based revocation). A 7-to-30-day silent timer is not a defense against a leak — attackers exfiltrate in minutes.

## Non-goals

- **Adding a key-rotation or key-recovery endpoint.** No new route (`GET /projects/v1/:id/keys`, `POST /projects/v1/admin/:id/rotate-keys`, etc.) is added. A public API for a one-time migration problem is the wrong shape — it would outlive the migration and imply a per-key rotation story we don't actually support at the `kid` level. Every in-scope population of exp'd keys (see design.md) has a simpler resolution path: self-heal on the existing Lambda sync, normal operator redeploys, or one-off mint-and-paste for third-party stragglers. If genuine key-rotation needs emerge later (e.g. post-leak incident), that's a separate change scoped to the real threat model.
- **A proactive platform-wide Lambda sweep.** We don't enumerate every project × every function to force-refresh env vars in a single sweep. The backfill story relies on a ~5-line self-heal in the existing secrets-sync path: when that path finds a legacy exp'd key in a Lambda env, it re-mints rather than preserving. Combined with normal redeploy activity, the fleet drains opportunistically. A broad sweep is cheap to add later if telemetry shows a stuck cohort, but it is not needed for v1.
- **Unifying `anon_key` and `service_key` signing into one helper.** They stay as two explicit `jwt.sign` calls for readability; a shared helper can come later if more key types appear.
- **Changing the `project_admin` role JWT.** End-user access tokens (from `POST /auth/v1/*`) correctly keep their `exp` — they represent human sessions, not machine credentials. Out of scope.

## Alternatives considered

1. **Keep expiry, add rotation.** `POST /projects/v1/admin/:id/rotate-keys` that re-signs and (optionally) updates Lambda env vars. Preserves the "time-bombed leaked key" weak benefit but adds infra (route, middleware, admin UI wiring, Lambda env refresh, test surface) to protect against a threat model that doesn't hold up — a leaked service_key will be exfiltrated long before the timer fires, and the owner needs explicit rotation anyway. Rejected on cost-benefit.

2. **Keep expiry, tie it to the wallet's actual `lease_expires_at`.** Sign with `exp = wallet.lease_expires_at` instead of `now + leaseDays`. Fixes the "JWT exp outlives tier lease" and "JWT exp under-represents extended lease" discrepancies. But still has the silent-Lambda-break problem (because Lambda env vars aren't refreshed on renewal), and the runtime gate via `projectCache`+tier lookup already makes the JWT `exp` redundant. Rejected — adds complexity without fixing the real bug.

3. **Status quo + document the foot-gun.** Add a warning to `llms.txt` that functions must be redeployed after tier renewal. Rejected — the right response to a silent-break bug is not to ask users to work around it, especially when the mitigation (remove `exp`) is a one-line change.

4. **Ship a key-recovery endpoint alongside the no-exp change.** Add `GET /projects/v1/:id/keys` (wallet-auth) so owners can fetch their current key without re-forking. Rejected — a permanent public API for a temporary migration problem is the wrong shape. Every in-scope population of exp'd keys has a simpler resolution path (self-heal on Lambda sync, normal operator redeploys, one-off mint-and-paste for third-party stragglers). If genuine key-rotation needs emerge later (e.g. post-leak incident), they will be scoped to that real threat model, not to migration hygiene.

## Verification

- **Unit:** `npm run test:unit` — `services/projects.test.ts` flipped assertions (serviceKey has no `exp`) pass. Two impacted tests are `returns valid JWT serviceKey with expiry` and `generates valid JWT keys`; rename + invert.
- **E2E:** `BASE_URL=https://api.run402.com npm run test:e2e` + `npm run test:functions` — existing tests still pass. No new coverage needed; the removed behavior was never tested for at the E2E level.
- **Manual:** After deploy, create a new project via `POST /projects/v1`, decode the returned `service_key` (`jwt.io` or `jwt -d`), confirm no `exp` claim. Confirm the key still works (`POST /mailboxes/v1` etc.) and still rejects on `DELETE /projects/v1/:id` → retry (404 from project status, not 401 from JWT).
- **Docs alignment:** `npm run test:docs` — may flag the llms.txt change if it tracks `service_key` language; update expectation if so.
- **No migration:** Existing service_keys in circulation keep their original `exp` and continue to expire on the old schedule. This is intentional (matches the anon_key change).
