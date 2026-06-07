# @run402/astro

One-line Astro preset for Run402. SSR with sub-second admin-edit visibility, full image-variant pipeline, and full agent-DX: structured errors, debug headers, and CLI integration. Use it as your entire `astro.config.mjs`:

```js
// astro.config.mjs
import run402 from "@run402/astro";
export default run402();
```

That returns a complete `AstroUserConfig` with:

- `output: 'server'` (per-route prerender via `export const prerender = true;`)
- The Run402 SSR adapter — Lambda-backed with SnapStart, AsyncLocalStorage-wrapped request context, ISR cache layer with sub-second invalidation
- The build-time image integration — `<Image>` upload pipeline + v1.49 WebP variant ladder + HEIC `display_jpeg` + blurhash + CDN-served immutable URLs
- Build-time hard-fail detectors for unsupported Astro features (dynamic `<Image src={expr}>`, server islands, sessions API) with structured `R402_ASTRO_*` errors

## v1.0 vs v0.2.x

| | v0.2.x | v1.0.0-alpha.1 |
|---|---|---|
| Default export | named `run402` (returns `AstroIntegration`) | default `run402` (returns `AstroUserConfig`) |
| What you get | image integration only | image integration + SSR adapter + Run402-aware defaults |
| `astro.config.mjs` shape | `integrations: [run402()]` | `export default run402();` |
| v0.2.x users | — | named `run402` is aliased to `run402Image` — existing `integrations: [run402()]` keeps working |

If you only want the image integration without SSR, the `run402Image()` named export is still available and unchanged.

## The SSR runtime (v1.0+)

When the preset runs in default mode (`output: 'server'`), every `.astro` page is server-rendered by an AWS Lambda function with full Run402 backend access in scope. Inside frontmatter:

```astro
---
import { db, getUser, cache } from "@run402/functions";
import { Run402Picture } from "@run402/astro/components";

const { slug } = Astro.params;
const user = await getUser();   // ALS-aware; taints cache so this response is uncacheable
const page = await db()
  .from("pages")
  .select("*")
  .eq("slug", slug)
  .maybeSingle();

if (!page) return new Response("Not Found", { status: 404 });

// Opt into the ISR cache layer:
Astro.response.headers.set(
  "Cache-Control",
  "public, s-maxage=60, stale-while-revalidate=300",
);
---

<Layout title={page.title}>
  <Run402Picture asset={page.hero_asset} alt={page.title} priority />
  <article set:html={page.html} />
</Layout>
```

When an admin saves a page:

```ts
import { db, cache } from "@run402/functions";

await db().from("pages").upsert({ slug, title, html });
await cache.invalidate(`/${slug}`);   // sub-second freshness
```

Every SSR response includes `x-run402-request-id`, `x-run402-release-id`, `x-run402-function`, `x-run402-cache` (`HIT` / `MISS` / `BYPASS`), `x-run402-cache-reason` (on bypass), `x-run402-cache-age` (on hit), `x-run402-locale`. When the function throws an uncaught exception, the response carries `x-run402-error-code: R402_SSR_RUNTIME_ERROR` and `x-run402-request-id` that you pass to `run402 logs --request-id <req>` for the full stack.

### Build-time env vars do NOT propagate to the SSR runtime

The SSR Lambda runs in a separate process from your build step. Anything exported in your `astro build` shell (e.g. `KYCHON_ANON_KEY`, `STRIPE_PUBLISHABLE_KEY`, a CI-injected secret) is visible during the build only — `process.env.YOUR_VAR` from inside an SSR-rendered page returns an empty string at request time. This is the correct security posture (build secrets shouldn't ship to a multi-tenant runtime), but it's surprising in retrospect.

Three options if your SSR route needs request-time config:

1. **Run402 secrets** — values you store via `run402 secrets set <key>` are injected into the Lambda env as `process.env.<KEY>` at deploy activation. This is the canonical request-time secret path.
2. **Request headers** — for per-tenant / per-request values that the gateway already knows (project_id, release_id, locale, user_id, role), read them directly from the Web `Request` headers: `request.headers.get("x-run402-project-id")`, `getUserId(request)` / `getRole(request)` from `@run402/functions`.
3. **Bake into the bundle at build** — for values that are public and stable across the lifetime of a release (e.g. an analytics site ID), import them in the page module so they get inlined into the bundled SSR source.

The Run402 anon key + service key + project ID + JWT secret + API base ARE auto-injected at deploy time (you'll see `RUN402_ANON_KEY`, `RUN402_SERVICE_KEY`, `RUN402_PROJECT_ID`, `RUN402_JWT_SECRET`, `RUN402_API_BASE` in `process.env` from inside the SSR runtime — those are the platform-managed channel).

### Rendering-mode pattern matrix

Astro supports four rendering modes; `auth.*` calls have different semantics in each. Pick the right mode per page and the rest follows.

| Mode             | How to opt in                                  | When to use                                                       | Auth + cache                                                                                              |
| ---------------- | ---------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| SSR (default)    | The default in v1.0; no flag needed.           | Personalized pages that read the actor.                          | `auth.user()` returns the actor; `auth.*` helpers taint the response so cache bypasses on Set-Cookie / auth. |
| Prerendered      | `export const prerender = true;` in the page.  | Pure marketing / docs pages that never see the actor.            | `auth.*` throws `R402_AUTH_PRERENDERED`. The page is built once and served as a static asset.              |
| Server island    | `<Component server:defer />` inside a page.    | Mostly-static page with a personalized slot (e.g. user dropdown). | `auth.*` is available **inside** the island. The shell is still cacheable.                                  |
| Client hydrate   | `<SignedIn client:load>…</SignedIn>`.          | Cookie-aware visibility without an SSR pass at all.              | Component fetches `/auth/v1/session` from the browser. No server `auth.*` call.                            |

Pattern picker:

```astro
---
// Personalized SSR (default in this scaffold)
import { auth } from "@run402/functions";
const user = await auth.requireUser();           // 303 to /auth/sign-in if anonymous
---
<h1>Hello, {user.email}</h1>
```

```astro
---
// Prerendered marketing page
export const prerender = true;
// Do NOT call auth.user() here — it throws R402_AUTH_PRERENDERED at build time
---
<h1>Welcome to the product</h1>
```

```astro
---
// Server-island mix: shell is cacheable, island streams in
import UserDropdown from "../components/UserDropdown.astro";
---
<header>
  <nav>...</nav>
  <UserDropdown server:defer>
    <span slot="fallback">Loading…</span>
  </UserDropdown>
</header>
```

```astro
---
// Client-hydrated visibility-only (no SSR auth read)
import { SignedIn, SignedOut, SignIn, UserButton } from "@run402/astro";
---
<SignedIn client:load>
  <UserButton />
</SignedIn>
<SignedOut client:load>
  <SignIn returnTo="/" />
</SignedOut>
```

## Authentication

Run402 ships a complete multi-tenant auth surface — password, OAuth (Google), passkeys, magic-link, hosted sign-up, and full account management — every ceremony minting a host-only session cookie on the tenant origin. **In an Astro project you almost never touch a route or a fetch: you render a component.** The four headless components (`<SignIn>`, `<SignUp>`, `<UserButton>`, `<AccountSecurity>`) own CSRF, freshness step-up, re-auth redirects, session rotation, and the passkey/OAuth ceremonies for you.

Requires `@run402/astro@2.1.0+` (the components) and `@run402/functions@3.2.0+` (the server-side `auth.*` namespace, bundled into your SSR runtime automatically).

### Which auth tier do I use? (decision tree)

Pick the FIRST row that matches. The everyday Astro answer is always a component — stop at row 1.

1. **Browser auth in an Astro site → use the components.** `<SignIn>` / `<SignUp>` / `<UserButton>` / `<AccountSecurity>`. Zero route code, zero fetch, no client JS by default. This covers sign-in, sign-up, sign-out, password change, passkeys, sessions, and identity link/unlink. **This is the lede — reach for anything below only when a component genuinely can't express your case.**
2. **Browser auth, but NOT Astro (React-only, vanilla, another framework) → drive the hosted `/auth/*` routes directly** (the documented-advanced contract). The same hosted ceremonies the components POST to: `/auth/sign-in`, `/auth/sign-up`, `/auth/sign-out`, `/auth/magic-link/send` → `/auth/magic-link` → `/auth/magic-link/confirm`, `/auth/passkeys/{login,register}/options` + `/verify`, `/auth/account/*`. _(A framework-neutral `@run402/browser-auth` helper that wraps these is a planned future follow-up — not shipped yet; the hosted routes are the contract until then.)_
3. **Machine / server-to-server / mobile (no browser, no cookie) → use the HTTP `/auth/v1/*` API** with a Bearer JWT. This is the classic non-browser path and is unchanged.
4. **You verify credentials against your OWN store (bcrypt, a custom users table, an external IdP) and want a Run402 browser session → `auth.sessions.createResponseFromTenantAssertion(...)`** from inside a routed function, gated by the `auth.sessionMint` capability. Your app *vouches* for the user after its own check. See [Tenant assertion vs cryptographic proof](#two-mint-primitives-tenant-assertion-vs-cryptographic-proof) below.
5. **You hold a verifiable cryptographic proof (a wallet SIWX signature, an OIDC JWT, an admin-registered provider proof) → `auth.sessions.createResponseFromIdentity(...)`.** Run402 itself verifies the proof. This is a *distinct* trust class from row 4 — not sugar over it.

> The components are the answer to the common case. Never hand-roll a `fetch("/auth/...")` as your happy path — if you find yourself writing one in an Astro page, you've skipped row 1.

### The four components

```astro
---
import { SignIn, SignUp, UserButton, AccountSecurity, SignedIn, SignedOut } from "@run402/astro/components";
---
<!-- Sign-in. `methods` renders the email/password form plus any of OAuth,
     magic-link, and passkey — each wired to its hosted ceremony for you.
     The default <slot/> stays available for white-label extras (e.g. a
     "forgot password" link). -->
<SignedOut>
  <SignIn returnTo="/portal" methods={["password", "google", "magic_link", "passkey"]} />
</SignedOut>

<!-- Signed-in chrome with a sign-out form (CSRF token embedded for you). -->
<SignedIn>
  <UserButton returnTo="/" />
</SignedIn>

<!-- Account-management panel — render only the sections you want, in order. -->
<SignedIn>
  <AccountSecurity sections={["password", "passkeys", "sessions", "identities"]} />
</SignedIn>
```

> **Shipped component surface (v2.2.0).** `<SignIn>` accepts `returnTo`, `class`, a default `<slot/>`, and **`methods?: Array<"password" | "magic_link" | "google" | "passkey">`** (default `["password"]`); `<SignUp>` accepts `returnTo` + `class` + `<slot/>`; `<UserButton>` accepts `returnTo`, `label`, `class`; `<AccountSecurity>` accepts `sections` and `class`. `methods` renders each requested ceremony wired to its hosted route — `password`/`magic_link`/`google` are no-JS forms/links (`/auth/sign-in`, `/auth/magic-link/send`, `/auth/sign-in/oauth/google/start`); `passkey` ships a small encapsulated WebAuthn `<script>` that drives `/auth/passkeys/login/{options,verify}`. **Omitting `methods` (or passing exactly `["password"]`) renders the prior email/password form byte-identically — a non-breaking minor upgrade** (§6.1/§6.3). The default `<slot/>` remains for white-label extras (e.g. a "forgot password" link). Never a hand-rolled fetch.

- **`<SignIn>`** — anonymous-only sign-in. Pass `methods={[…]}` to render the email/password form plus any of OAuth / magic-link / passkey, each wired to its hosted ceremony (no hand-rolled fetch); the default `<slot/>` remains for white-label extras (e.g. a "forgot password" link). `returnTo` is server-validated (relative path or same-origin absolute; everything else → `R402_AUTH_RETURN_TO_INVALID`).
- **`<SignUp>`** — mirror of `<SignIn>`, posts to `/auth/sign-up`. Duplicate-email is non-enumerating (same response shape as a fresh sign-up).
- **`<UserButton>`** — signed-in chrome: the user's email/label + a POST sign-out form carrying the double-submit CSRF token. Renders nothing when anonymous (gate it inside `<SignedIn>`).
- **`<AccountSecurity sections={[…]} />`** — the component-first account panel. Each requested section is a plain-HTML form POSTing to the hosted `/auth/account/*` routes; the gateway enforces freshness step-up, session rotation, and host-gating server-side. Sections:
  - `"password"` — set or change the Run402 password (renders "Set" vs "Change" from `has_run402_password`). Freshness-gated; rotates other sessions on success.
  - `"passkeys"` — show the registered-passkey count + remove one; **Add** links to the hosted register ceremony (WebAuthn `navigator.credentials` runs on the hosted page, not in the server-rendered form).
  - `"sessions"` — revoke a single session or **Sign out everywhere**.
  - `"identities"` — list linked OAuth identities + unlink; **Connect** runs the link-to-existing-account OAuth ceremony (the `startLink` redirect+proof flow) against the already-signed-in account — this is link-to-existing, NOT sign-in-with.

`<SignedIn>` / `<SignedOut>` are conditional-render gates that read `await auth.user()` server-side; use them to choose the pre- vs post-sign-in surface.

**Cold-prompt answers** (the canonical one-liners):
- "Add passkey sign-in" → `<SignIn returnTo="/portal" methods={["password", "passkey"]} />` — the component renders the passkey button and drives the WebAuthn `/options` → `/verify` round-trip for you.
- "Let users change their password" → `<AccountSecurity sections={["password"]} />`
- "Sign out everywhere" → `<AccountSecurity sections={["sessions"]} />`
- "Sign in against our own users table after bcrypt" → declare `"capabilities": ["auth.sessionMint"]` on the function + `throw auth.invalidCredentials()` on a bad password + `return auth.sessions.createResponseFromTenantAssertion({ tenant, user, method: "password" })`.

### Reading the actor in a page

```astro
---
import { auth } from "@run402/functions";
const user = await auth.user();          // Actor | null — the cheap per-request read
// const user = await auth.requireUser(); // 303 to sign-in (HTML) / 401 (JSON) if anonymous
---
{user ? <p>Hello, {user.email}</p> : <a href="/auth/sign-in">Sign in</a>}
```

`auth.user()` is the minimal per-request actor (`id`, `email`, `sessionId`, `authTime`, `amr`, …). For the rich *settings* read — the ownership-qualified account state your account UI branches on — use `auth.account.getSecurity()` (below). Don't call `getSecurity()` on every request; `auth.user()` is the hot-path read.

> **Authority-aware reality.** Credential ownership is not just "is there a session." There are three distinct concerns: a **browser session** (the cookie that says who's signed in), **account-security** state (Run402-OWNED credentials — the user's Run402 password, Run402 passkeys, Run402-verified OAuth identities), and **tenant-vouched assertions** (a subject your *app* vouched for via `createResponseFromTenantAssertion`, which Run402 did NOT itself verify). `getSecurity()` keeps these separate by construction.

### `auth.account.getSecurity()` — ownership-qualified account state

The everyday server-side read for a custom account UI (the `<AccountSecurity>` component reads it for you). Returns `AccountSecurity | null` (null when anonymous). Every credential field is **qualified to Run402 ownership** so there's no ambiguous "has_password":

| Field | Meaning |
|---|---|
| `has_run402_password` | The user has a Run402-owned password set. Drives "Set password" vs "Change password". A tenant-vouched user with no Run402 password reads `false`. |
| `run402_passkey_count` | Number of Run402-registered passkeys across all this user's rpIds. Drives "Add a passkey" / "you have N passkeys". |
| `has_run402_passkey_for_current_rp` | `true` / `false` / `null` — whether the user has a passkey registered for THIS exact host's rpId (passkeys are per-host; see below). `null` when not determinable. |
| `run402_identities` | `Run402Identity[]` — OAuth/cryptographic identities Run402 itself verified and linked (`provider`, `provider_sub`, `provider_email`, `created_at`). These are "connected accounts". |
| `current_rp_id` | The rpId (host) of the current request. |
| `passkey_rp_scope` | Always `"host"` today (the forward-compatible `"realm"` value is reserved but not shipped — see rpId policy below). |
| `tenant_assertions` | `TenantAssertionRef[]` — the tenant-vouched links (`issuer`, `last_amr` e.g. `["tenant_password"]`). **Deliberately separate from `run402_identities`**: a tenant-vouched identity is NOT a Run402-verified credential. The `tenant_*` amr prefix makes the provenance visible. |

**Why "ownership-qualified."** A flat `has_password` / `identities` shape can't distinguish "Run402 verified this credential" from "the app told us about this user." That ambiguity is a real footgun: an account-security UI that offers "remove password" against a tenant-vouched user (who never had a Run402 password) is broken. The qualified fields make every UI branch unambiguous and keep tenant provenance from masquerading as a Run402-verified identity.

```astro
---
import { auth } from "@run402/functions";
const sec = await auth.account.getSecurity();
---
{sec && (
  <ul>
    <li>{sec.has_run402_password ? "Password set" : "No password yet"}</li>
    <li>{sec.run402_passkey_count} passkey(s){sec.has_run402_passkey_for_current_rp ? " (one for this site)" : ""}</li>
    <li>{sec.run402_identities.length} connected account(s)</li>
  </ul>
)}
```

> The mutation primitives that back the panel (`auth.account.setPassword`, `auth.account.passkeys.{list,remove}`, `auth.account.identities.{list,unlink,startLink}`, `auth.account.sessions.{list,revoke}`, `auth.account.signOutEverywhere()`) exist as an **advanced tier** for non-Astro / power-user flows, with callee-enforced freshness. They are not the everyday path — render `<AccountSecurity>` instead. They're documented in the comprehensive SDK reference, not here.

### Passkey rpId policy — per-tenant isolation

Run402 passkeys are bound to the **exact request host** as their WebAuthn rpId. A passkey registered on `tenant-a.run402.app` is **unusable** on `tenant-b.run402.app` — distinct portals are distinct credential realms. This is the shipped behavior and it is intentional: distinct tenants are distinct communities.

- The rpId is the literal host: `tenant-a.run402.app`, `myportal.run402.com`, or a verified custom domain like `kychon.com`.
- Managed subdomains under `*.run402.com` and `*.run402.app` are supported, as are verified custom domains attached to the project.
- **Public / platform suffixes are rejected** as an rpId: bare `run402.com`, `api.run402.com`, `www`, and `pr-*` preview hosts all fail origin validation (you can't register a passkey that would span every tenant).
- A **shared "realm"** rpId (one passkey usable across a verified parent domain's children) is **out of scope** — not shipped. `passkey_rp_scope` always reports `"host"`. It's reserved as a possible future opt-in project config if a real consumer ever needs it; today there's no realm.

If a passkey ceremony 400s with `R402_AUTH_PASSKEY_CHALLENGE_INVALID`, you almost certainly tried to verify on a different host than you minted the challenge on, or skipped the `/options` call — drive it through the hosted passkey ceremony (linked from the `<SignIn>` slot, or `/auth/passkeys/login`) so `/options` always precedes `/verify` on the same host.

### Two mint primitives: tenant assertion vs cryptographic proof

Both produce a host-bound session cookie, but they encode fundamentally different trust and must not be confused:

| | `auth.sessions.createResponseFromTenantAssertion(...)` | `auth.sessions.createResponseFromIdentity(...)` |
|---|---|---|
| Trust model | **The app vouches.** You verified the credential against your OWN store (bcrypt, custom DB, external IdP); Run402 trusts your assertion. | **Run402 verifies.** You hand Run402 a verifiable cryptographic proof; the platform checks it against the project's registered verifier. |
| Use it for | bcrypt / custom-DB credential bridges, external IdP you've already validated | wallet SIWX signatures, OIDC JWTs, admin-registered custom-provider proofs |
| Gate | **Capability-gated**: the function must declare `"capabilities": ["auth.sessionMint"]` in its apply-spec entry. A service key alone is **not** sufficient (→ `R402_AUTH_UNTRUSTED_CONTEXT`). Audited (function id, route, host, issuer, subject, amr, IP, UA, request id). | Proof verification is the gate; no `auth.sessionMint` capability needed. |
| Resulting `amr` | Platform-derived from `method`: `"password"` → `tenant_password`, `"sso"` → `tenant_sso`. The `tenant_` prefix marks the provenance. | The `amr` you pass (the methods the proof attests). |
| Shape | `{ tenant, user: { id, email, emailVerified, displayName?, avatarUrl? }, method: "password" | "sso" }`. `user.id` must be a **stable primary key, not a bare email** (→ `R402_AUTH_TENANT_SUBJECT_INVALID`). | `{ provider: "wallet" | "oidc" | "custom", subject, proof, amr, createUser? }`. |

**Rule of thumb:** if you ran `bcrypt.compare(...)` (or any check Run402 can't re-verify), reach for the **tenant assertion**. If you hold bytes Run402 can cryptographically verify itself (a signature, a JWT), reach for **`createResponseFromIdentity`**. `createResponseFromIdentity` is *not* sugar over the tenant assertion — it's the verifiable-proof class and stays distinct.

Tenant-assertion bcrypt sign-in, end to end:

```ts
// run402.config.json — declare the capability on this function's entry:
// { "functions": [{ "name": "sign-in", "capabilities": ["auth.sessionMint"] }] }

import { auth } from "@run402/functions";

export default async (req) => {
  const { email, password } = await req.json();
  const row = await lookupUser(email);                 // your own users table
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    throw auth.invalidCredentials();                    // → R402_AUTH_INVALID_CREDENTIALS
  }
  // The app vouches; Run402 mints the host-bound cookie + writes an audit row.
  return auth.sessions.createResponseFromTenantAssertion({
    tenant: "acme",                                     // → issuer "tenant:acme"
    user: { id: row.id, email: row.email, emailVerified: true },
    method: "password",                                 // → amr ["tenant_password"]
  });
};
```

`throw auth.invalidCredentials()` is a **function call, not a constructor** — never `new auth.InvalidCredentialsError()`. It renders the canonical `R402_AUTH_INVALID_CREDENTIALS` envelope without minting a session.

### Auth error codes & fixes

Every auth error carries a structured envelope with a `next_actions[].fix` payload — a component snippet, an apply-spec snippet, or a one-line runtime fix — so the failure teaches the exact edit. Full reference for the whole `R402_AUTH_*` family lives at **<https://run402.com/errors/>**. The codes introduced with hosted-surface-parity:

| Code | HTTP | Fires when | Fix |
|---|---|---|---|
| `R402_AUTH_INVALID_CREDENTIALS` | 401 | A tenant-owned credential check failed (your bcrypt/custom verify returned false). | `if (!ok) throw auth.invalidCredentials();` |
| `R402_AUTH_MAGIC_LINK_INVALID` | 400/410 | The magic-link token is unknown, expired, or already consumed (uniform body — single-use replay looks identical to unknown). | Re-send a fresh link: `<SignIn methods={["magic_link"]} />`. |
| `R402_AUTH_UNTRUSTED_CONTEXT` | 403 | `createResponseFromTenantAssertion` ran in a function that didn't declare the `auth.sessionMint` capability (a service key is NOT sufficient). | Add `"capabilities": ["auth.sessionMint"]` to the function's apply-spec entry. |
| `R402_AUTH_PASSKEY_CHALLENGE_INVALID` | 400 | A passkey `/verify` ran without a valid, same-origin, actor-or-pending-signup-bound challenge (skipped `/options`, or wrong host). | Drive the ceremony through the component: `<SignIn methods={["passkey"]} />`. |
| `R402_AUTH_TENANT_SUBJECT_INVALID` | 400 | A tenant assertion was missing `tenant`/`user`, or `user.id` was a bare email instead of a stable primary key. | Pass a structured user: `createResponseFromTenantAssertion({ tenant, user: { id: user.id, email: user.email, emailVerified: true }, method: "password" })`. |
| `R402_AUTH_RENAMED_EXPORT` | 400 | Called the removed `auth.identities.link`. Identity link/unlink moved under `auth.account.identities.*`; linking is the `startLink` ceremony. | `auth.account.identities.startLink({ provider: "google", redirectUrl: "/settings/security" })` or `<AccountSecurity sections={["identities"]} />`. |

Two pre-existing codes were enriched with `fix` payloads in this release (names unchanged): `R402_AUTH_CSRF_ORIGIN_MISMATCH` (submit from a Run402 component / same-origin form) and `R402_AUTH_PRERENDERED` (`export const prerender = false;`). At deploy time, `run402 doctor` statically detects a `createResponseFromTenantAssertion` call whose function lacks the `auth.sessionMint` capability and emits `R402_DOCTOR_AUTH_SESSION_MINT_CAPABILITY_MISSING` with the exact spec edit — catching the footgun before it becomes a runtime 403.

### Hosted sign-in errors render themselves (`<SignIn>`)

A failed hosted OAuth sign-in — e.g. a Google account whose domain is not in the project's `allowed_email_domains` (set via `run402 auth settings --allowed-email-domains …`) — is returned to your sign-in page with a **server-readable** `?r402_auth_error=<code>` query param, and `<SignIn>` renders the message for you. Server-side, **no client JS, zero extra code**:

```astro
---
import { SignIn } from "@run402/astro/components";
---
<SignIn returnTo="/admin" methods={["google"]} />
```

A `@gmail.com` user rejected from a Workspace-restricted admin tool lands back on this page with "This site is restricted to approved email domains. Sign in with your work account." rendered above the form. `<SignIn>` emits its own URL as the error-return target on the OAuth start link, so the round-trip is automatic — you never touch a query param or the URL hash. Known codes (`domain_not_allowed`, `account_exists_requires_link`, `identity_already_linked`) get specific copy; anything else (transient/infra) falls back to a generic "Sign-in could not be completed. Please try again." The block carries `role="alert"` and the `.r402-auth-error` class — restyle via your own CSS or the `--r402-error-fg` / `--r402-error-bg` / `--r402-error-border` custom properties. With no error param the render is byte-identical to before — nothing extra ships.

## `<Run402Picture>` — runtime CMS images

For images coming from a DB row at SSR time (the common CMS pattern), use `<Run402Picture asset={page.hero_asset}>`. The `asset` prop is the `AssetRef` JSONB that `r.assets.put()` returned at upload time — store the whole object, not just the URL, then render directly.

```astro
---
import { Run402Picture } from "@run402/astro/components";
---
<Run402Picture
  asset={page.hero_asset}
  alt={page.title}
  sizes="(min-width: 768px) 50vw, 100vw"
  priority
/>
```

Behavior:
- Emits `<picture>` with WebP srcset (`thumb` 320w / `medium` 800w / `large` 1920w) when the AssetRef has the full variant ladder
- HEIC sources fall back to `variants.display_jpeg.cdn_url` for the `<img>`
- Missing variants → safe single `<img>` from `display_url` / `cdn_url`, plus a runtime `console.warn`
- URLs validated against unsafe schemes (`javascript:` etc.) at render time
- `priority` → `fetchpriority="high"` + `loading="eager"` + `decoding="sync"`
- `blurhash` data-attribute emitted when present (decoder ships at `@run402/astro/blurhash` for client hydration)
- `width` / `height` attributes from `asset.width_px` / `asset.height_px` for CLS prevention

For static template-literal images (e.g., `<Image src="./hero.jpg">`), use the build-time `<Image>` — same upload pipeline, build-time srcset emission, no runtime data needed.

## `<Run402Image>` — pre-decoded placeholders + strict-mode degradation detection (v1.51+)

`<Run402Image>` is the v1.51 sibling of `<Run402Picture>` — same shape (`asset={AssetRef}` + `alt` + `sizes`), but with three additions that matter at scale:

1. **Pre-decoded blurhash placeholder.** The v1.54 gateway pipeline pre-computes the blurhash → PNG data URL at upload time and stamps it on `AssetRef.blurhash_data_url`. `<Run402Image>` emits it as the `<img>` element's `background-image` so the placeholder is visible during fetch with zero client-side decode + zero SSR-render CPU cost.
2. **Strict mode.** `imageDefaults: { strict: { onSchema: ">=v1.49" } }` makes the component hard-fail when an AssetRef would render below the full v1.49+ target — catches the "28 of 30 assets render correctly and 2 silently degrade" failure mode at build time rather than at user-visible time. The schema-filter form skips legacy pre-v1.49 AssetRefs, so mixed-vintage CMS projects can adopt safely.
3. **React entry point.** Same component shape, importable from `@run402/astro/react` for React islands or React-only consumers. Byte-identical HTML output to the Astro path.

### Quick start

```astro
---
// Astro entry
import { Run402Image } from "@run402/astro/components";
---
<Run402Image asset={page.hero_asset} alt={page.title} sizes="100vw" priority />
```

```tsx
// React entry
import { Run402Image } from "@run402/astro/react";
import type { AssetRef } from "@run402/functions";

export function Hero({ asset }: { asset: AssetRef }) {
  return <Run402Image asset={asset} alt="..." sizes="100vw" priority />;
}
```

### When to use `<Run402Image>` vs `<Run402Picture>`

| | `<Run402Picture>` (v1.0) | `<Run402Image>` (v1.51+) |
|---|---|---|
| Pre-decoded blurhash placeholder | ✗ | ✅ |
| Strict-mode degradation detection | ✗ | ✅ |
| React entry point | ✗ (Astro only) | ✅ Astro + React |
| Default-mode degradation manifest | ✗ | ✅ |
| Behavior on legacy AssetRefs | renders best-effort silently | renders best-effort + records to manifest (or hard-fails under strict) |

If your tenant has heavy mixed-vintage data + you want a CI regression gate against silent degradation, use `<Run402Image>` with `imageDefaults: { strict: { onSchema: ">=v1.49" } }`. For simple existing pages where best-effort silent rendering is fine, `<Run402Picture>` stays the lighter choice.

### Configuration

```js
// astro.config.mjs
import run402 from "@run402/astro";

export default run402({
  imageDefaults: {
    strict: { onSchema: ">=v1.49" },  // mixed-vintage projects (Kychon shape)
    // OR: strict: true,              // greenfield, every render strict-checked
    // OR: strict: false,             // explicit lenient (default)
    placeholder: "auto",              // render placeholder if blurhash_data_url present
  },
});
```

### HEIC precondition

If your tenant has legacy HEIC AssetRefs (uploaded before the v1.49 `display_jpeg` transcode landed) and you want to enable schema-filtered strict mode, run the `asset-image-variants-v1-51` backfill with `--regenerate-heic-transcodes` **first**. Without it, `<Run402Image>` hard-fails with `R402_ASTRO_IMAGE_HEIC_NO_TRANSCODE` on every legacy HEIC render. See the run402-private repo's `docs/migrations/asset-image-variants-v1-51-backfill.md` for the operator workflow.

### Error codes

All `R402_ASTRO_IMAGE_*` codes are documented at https://run402.com/errors/ — see the index for the full list including:

- `_ASSET_MISSING` / `_ASSET_STRING_URL` / `_ASSET_WRONG_SHAPE` — input validation failures
- `_NON_IMAGE_ASSET` — `content_type` is not `image/*`
- `_ALT_REQUIRED` — `alt` prop missing
- `_CONFLICTING_CLASS_PROPS` — both `class` and `className` passed
- `_CONFLICTING_LOADING_PROPS` — `priority={true}` + `loading="lazy"`
- `_HEIC_NO_TRANSCODE` — HEIC source missing `display_jpeg` (hard-fail floor)
- `_SIZES_REQUIRED` — multi-variant AssetRef without `sizes` prop
- `_STRICT_DEGRADED` — strict-mode hit a missing field (carries `subcode`)
- `_RESERVED_DATA_ATTR` — caller passed reserved `data-run402-image`
- `_WRONG_ENTRY_POINT` — JS consumer imported the wrong entry point

## CLI

The Run402 CLI ships everything an agent needs to scaffold, develop, deploy, and debug an Astro project:

```sh
run402 doctor --json                                # verify environment
run402 init astro my-portal                         # scaffold a deployable project
run402 dev                                          # local dev with Run402 env injected
run402 deploy --json --verify /,/the-guys           # build + deploy + smoke-test
run402 cache inspect https://eagles.kychon.com/the-guys --json
run402 cache invalidate https://eagles.kychon.com/the-guys
run402 logs --request-id req_xyz123 --json          # debug a failed render
```

`run402 init astro` creates a working project with `package.json` (dev/deploy scripts), `astro.config.mjs` (one-line preset), sample `[slug].astro` with the full DB-fetch + cache pattern, an admin save endpoint demonstrating cache invalidation, and `.env.example`. See `run402 init astro --help`.

### Deploying with the SDK directly (and from CI)

Most projects deploy with `run402 deploy` (above) or `run402 deploy apply --dir dist`. If you write your own deploy script with `@run402/sdk` — e.g. a CI job that assembles a custom `ReleaseSpec` — turn the build into a deploy slice with the one canonical helper. **Do not hand-roll `site` / `public_paths`.**

```ts
import { run402 } from "@run402/sdk";
import { buildAstroReleaseSlice } from "@run402/astro/release-slice";

const slice = await buildAstroReleaseSlice("dist");   // point at the BUILD ROOT, not dist/run402/client
await run402().project(projectId).apply({
  database: { migrations },     // your own cross-cutting slices
  ...slice,                     // site + functions (routes intentionally omitted)
});
```

`buildAstroReleaseSlice` is the only supported way to map an Astro build to a `ReleaseSpec`. It:

- roots the site at `dist/run402/client/` (the served output) — **not** `dist/`;
- sets `site.public_paths: { mode: "implicit" }` so prerendered pages are reachable by filename;
- bundles the SSR entry into a single `class: "ssr"` function;
- **omits `routes`** (it is not in the returned object) so base-release routes — e.g. a separately-declared `/api/*` function — carry forward instead of being cleared, and the slice stays safe to submit from a CI OIDC session that has no route scopes.

**Anti-pattern (the cause of [kychee-com/run402#411](https://github.com/kychee-com/run402/issues/411)):** do not point `fileSetFromDir`/`dir()` at `dist/` and build `public_paths` by hand. That ships the adapter build tree (`run402/adapter.json`, `run402/server/**`) as static assets and lands every page under a `run402/client/` path prefix — so the static manifest has no reachable pages, every URL falls through to the SSR catchall and 404s, and the SSR bundle becomes publicly downloadable. The SDK now rejects this locally with `ASTRO_ADAPTER_TREE_IN_SITE` before any upload, and the gateway warns (`SITE_NO_REACHABLE_HTML`) when a release ships HTML that isn't reachable at any public path.

**Full vs CI/patch deploys use the same slice.** CI sessions are content-only (no subdomains/routes/i18n) — the slice already omits `routes`, so just don't add `routes`/`subdomains`/`i18n` to the spec in CI. The CAS substrate dedupes unchanged bytes, so a `site.replace` from the slice uploads only what actually changed; you don't need a hand-rolled `site.patch` diff to get incremental uploads.

## R402_* error codes

Build / deploy / runtime / cache failures all return a structured envelope:

```json
{
  "ok": false,
  "code": "R402_ASTRO_DYNAMIC_IMAGE_UNSUPPORTED",
  "message": "...",
  "suggestedFix": "Store the AssetRef returned by assets.put() and render with <Run402Picture asset={...}>",
  "docs": "https://docs.run402.com/llms-cli.txt#r402_astro_dynamic_image_unsupported",
  "file": "src/pages/[slug].astro",
  "line": 14
}
```

The 17 reserved codes for the SSR runtime:

- **Build-time** — `R402_ASTRO_BUILD_FAILED`, `R402_ASTRO_UNSUPPORTED_OUTPUT`, `R402_ASTRO_MIDDLEWARE_UNSUPPORTED`, `R402_ASTRO_SERVER_ISLAND_UNSUPPORTED`, `R402_ASTRO_SESSIONS_UNSUPPORTED`, `R402_ASTRO_DYNAMIC_IMAGE_UNSUPPORTED`, `R402_ASTRO_VERSION_UNSUPPORTED`, `R402_BUNDLE_UNRESOLVED_IMPORT`, `R402_BUNDLE_NATIVE_DEP_UNSUPPORTED`
- **Runtime** — `R402_SDK_OUTSIDE_REQUEST_CONTEXT`, `R402_SSR_RUNTIME_ERROR`, `R402_SNAPSTART_INIT_IO`
- **Cache** — `R402_CACHE_UNSUPPORTED_VARY`, `R402_CACHE_AUTH_TAINTED` (informational), `R402_CACHE_INVALIDATION_HOST_REQUIRED`, `R402_CACHE_INVALIDATION_HOST_FORBIDDEN`
- **Deploy** — `R402_DEPLOY_STAGE_FAILED`

Every code has a `suggestedFix` field that an AI coding agent can act on directly.

---

## v0.2.x: Image integration only

The rest of this README covers the v0.2.x build-time image integration. It still works under the v1.0 preset (which composes it automatically) AND remains available as the standalone `run402Image()` named export for users who want it without the SSR adapter.

## Before you start

Four prerequisites must be true before `astro build` produces working `<picture>` markup. If any of these is missing, the build fails with an actionable error pointing at the exact CLI command to run — but skimming this checklist first saves a round-trip.

### 1. Project ID is set

```sh
# Either env var:
export RUN402_PROJECT_ID="prj_..."

# Or pass via the integration:
# astro.config.mjs → run402({ projectId: 'prj_...' })
```

### 2. Auth path matches your environment

The integration auto-detects which path you're on:

```sh
# Locally — provisions ~/.config/run402/projects.json
run402 login <project-id>

# In CI (GitHub Actions) — workflow needs id-token: write AND a Run402 binding for the repo
run402 ci link github --project <project-id> --repo <owner/repo>
```

GitHub Actions detection is automatic when `GITHUB_ACTIONS=true` is set (which GitHub sets for you). For non-GitHub CI, pass an explicit `credentials` provider via `run402({ credentials: ... })`.

### 3. CI binding has asset_key_scopes for your prefix

CI bindings are closed-by-default for the `spec.assets` slice. Grant the integration's default `astro/` prefix once per binding:

```sh
run402 ci list --project <project-id>                # find the binding id
run402 ci set-asset-scopes <binding-id> 'astro/*'    # grant the prefix
```

If you customized `assetPrefix` in `run402({ assetPrefix: 'my-app/' })`, grant `'my-app/*'` instead. **Local-laptop wallet deploys skip this check; only CI sessions hit it.**

### 4. Image CSS uses `height: auto` (or `aspect-ratio`)

The `<Image>` component emits explicit `width`/`height` HTML attributes from the source's intrinsic dimensions to prevent cumulative layout shift (CLS). Pair this with `height: auto` (or `aspect-ratio: <w>/<h>`) in your CSS, otherwise responsive `width: 100%` rules will stretch images vertically:

```css
/* In your global stylesheet — required for any responsive <Image> usage */
img {
  max-width: 100%;
  height: auto;
}
```

This is the same CLS-prevention contract as Next.js's `<Image>`. v0.1.x doesn't check this at build time; it's docs-only because consumer CSS can be arbitrarily complex.

## Two consumer shapes

`@run402/astro` covers both shapes of Astro site:

**Static-template sites** (hero on the home page, logos in nav, hand-authored landing pages). Image references are string literals in `.astro` templates. Use `<Image src="./images/hero.jpg" alt="...">`. The integration scans your templates at build time, uploads each unique source, and rewrites the markup to consume v1.49 variants. See the **Use** section below.

**Data-driven sites** (CMS-backed content, DB-backed seeds, MDX collections with frontmatter images, admin-editable pages). Image references live in runtime values — JSONB rows, content collection entries, fetch responses. There are no `<Image>` candidates for a build-time scan. Two patterns cover this shape: **persist the full `AssetRef` returned by `r.assets.put`** in your data row (recommended whenever you control the schema — no manifest, no lookup, no cache), or use the **`assetsDir` + manifest** pattern when the data shape isn't yours to change. See the **Data-driven consumers** section below.

A real Astro site usually has both. Set both options; they share the same upload pipeline, the same cache, the same CDN.

## Why

Run402 v1.49 pre-encodes 3 WebP variants (320w / 800w / 1920w) + a display-friendly JPEG for HEIC sources + a blurhash placeholder for every image uploaded via the assets slice. Variants serve from CloudFront like any other static URL. This package wires that pipeline into Astro's build: walk your `<Image>` references, upload each unique source, render `<picture>` markup that consumes the variants.

Compared to Next.js's `<Image>` model: Vercel transforms images lazily via Lambda on cache miss. Run402's variants are encoded once at upload time and served as static immutable assets - **no per-request transform cost**.

## Install

```sh
npm install @run402/astro @run402/sdk
```

Astro 6 (peer dependency, optional declaration so install never blocks). The SSR adapter requires Astro 6 at runtime (its server entry imports `astro/app/entrypoint`, an Astro-6-only export); the build-time image integration alone also runs on Astro 5, though Astro 5 is outside the supported peer range.

## Configure

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import { run402 } from '@run402/astro';

export default defineConfig({
  integrations: [run402()],
});
```

Set `RUN402_PROJECT_ID` in your environment (or pass `run402({ projectId: 'prj_...' })`). See the "Before you start" section above for the full credential + binding setup.

For non-GitHub CI (GitLab, CircleCI, etc.), or to wire a custom credential provider, pass `credentials` explicitly:

```js
import { githubActionsCredentials } from '@run402/sdk/node';
// or your own credential factory

export default defineConfig({
  integrations: [run402({
    projectId: 'prj_...',
    credentials: yourCustomCredentialProvider,
  })],
});
```

Locally (no `GITHUB_ACTIONS`), the SDK's `NodeCredentialsProvider` reads `~/.config/run402/projects.json` — same as the rest of the Run402 SDK / CLI tooling.

## Use

```astro
---
import Image from '@run402/astro/Image.astro';
---
<Image src="./images/hero.jpg" alt="Sunset over the Pacific" sizes="100vw" priority />

<Image src="./images/team-photo.heic" alt="Team retreat 2026" sizes="(min-width: 768px) 50vw, 100vw" />
```

`src` is resolved relative to the importing `.astro` file. TypeScript path aliases (`@/*`) also work if you have them in `tsconfig.json`.

**Note on the import shape.** `.astro` components have a single default export, so `import Image from '@run402/astro/Image.astro'` (default-import, subpath) is the only correct form. There is no `import { Image } from '@run402/astro'` named export — anything imported from `@run402/astro` must evaluate cleanly under vanilla Node so it can be loaded from `astro.config.mjs` before Vite is alive, and a top-level re-export of an `.astro` module breaks that boundary.

## Data-driven consumers (v0.2+)

For sites where image references live in runtime values (CMS-backed content, DB-backed seeds, JSON content, MDX frontmatter, admin-uploaded media), there are two patterns. **Pick AssetRef persistence whenever you control the data shape**; reach for the build-time manifest when you don't, or when you have data-driven keys to surface inside `.astro` templates.

### Persistence pattern: store the AssetRef, not the URL (recommended)

`r.assets.put` already returns the full v1.49 `AssetRef` — `cdn_url`, intrinsic `width_px` / `height_px`, `blurhash`, the WebP variant ladder, the HEIC `display_jpeg` when present. **Persist the whole ref in the same row as everything else about the asset**, instead of keeping only the URL string. At render time the row IS the variant data: no manifest, no lookup, no cache, no synchronization layer between the row and the manifest. The row is internally consistent with what gets rendered.

This pattern covers both runtime-uploaded media (admin MediaPicker calling `r.assets.put` directly) and static seed data (a build step that walks `assetsDir` and writes the resolved ref into the seed JSON instead of, or alongside, the URL string).

**Schema shift.**

Before — URL string + manifest lookup at render time:

```ts
// row in DB / seed JSON
type Section = { bg_image: string };  // "/assets/hero.jpg"

// render
const section = await db.sections.findOne(...);
const key = section.bg_image.replace(/^\/assets\//, '');
const ref = resolveVariants(manifest, key);
const html = ref
  ? renderPicture(ref, { alt, sizes: '100vw' })
  : `<img src="${section.bg_image}" alt="${alt}">`;
```

After — full `AssetRef` stored on write:

```ts
// row in DB / seed JSON — what r.assets.put returned
type Section = { bg_image: AssetRef };
//   { cdn_url, width_px, height_px, blurhash, variants: { thumb, medium, large, display_jpeg? }, ... }

// render — no manifest, no lookup, no cache
const section = await db.sections.findOne(...);
const html = renderPicture(section.bg_image, { alt, sizes: '100vw' });
```

The MediaPicker / admin upload flow already has the AssetRef in hand — it's the return value of `r.assets.put`. Today's code typically drops everything except `cdn_url`; the persistence pattern is "save what `put()` returned, render directly from it."

**Trade-offs.**

- **Row size grows by ~600–1000 bytes per image.** Most of that is the variants ladder (3–4 entries × ~150 bytes each). For JSONB columns and content-collection JSON this is rarely an issue; for narrow indexed text columns it matters more.
- **Immutable URLs are content-addressed.** Re-uploading to the same key while old refs remain embedded in rows will not refresh those rows — they continue serving old bytes. Either upload to a fresh key on each edit (the typical pattern), or rewrite the row at upload time so its embedded ref points at the new content.
- **Migrating existing string-URL rows is one-shot and mechanical.** If you already use `assetsDir`, the build-time manifest already contains the canonical ref for every seeded image: a small script walks your rows, looks each URL up with `resolveVariants(manifest, key)`, and writes the ref back. After that runs once, the runtime manifest lookup is dead code. For URLs that aren't in the manifest (admin uploads from before this pattern landed), re-call `r.assets.put(key, source)` with the source bytes — CAS dedup makes this idempotent (same bytes → same ref) and you get the full AssetRef back without a duplicate upload.

### Build-time manifest pattern

Useful when:

- The data shape is not yours to change (a CMS that only stores strings; a schema owned by another team).
- You're writing the one-shot migration described above (read URL → look up ref → write ref back).
- You have data-driven keys that need to be resolved from `<Image>` markup in static `.astro` templates.

For new data-driven consumers, prefer the persistence pattern above — it has fewer moving parts and no stale-after-edit problem.

Set `assetsDir` in `astro.config.mjs`:

```js
export default defineConfig({
  integrations: [
    run402({
      assetsDir: 'src/cms-images',           // or ['demo/eagles/assets', 'demo/silver-pines/assets']
      manifestPath: 'dist/_assets-manifest.json',  // optional; this is the default
    }),
  ],
});
```

`buildStart` walks the directory recursively, uploads every image file (extensions: `.jpg/.jpeg/.png/.webp/.avif/.heic/.heif`), and `closeBundle` writes a manifest JSON.

**Manifest shape:**

```json
{
  "version": 1,
  "project_id": "prj_...",
  "asset_prefix": "astro/",
  "generated_at": "2026-05-20T13:30:00.000Z",
  "assets": {
    "hero.jpg": {
      "key": "astro/hero.jpg",
      "sha256": "abc123...",
      "width_px": 1920,
      "height_px": 1080,
      "blurhash": "L6PZfSi_...",
      "cdn_url": "https://cdn.run402.com/.../hero.jpg",
      "display_url": "https://cdn.run402.com/.../hero.jpg",
      "variants": {
        "thumb":  { "cdn_url": "...", "width_px": 320, "height_px": 180, "format": "webp", ... },
        "medium": { ... },
        "large":  { ... }
      }
    }
  }
}
```

Keys are paths relative to the `assetsDir` (preserving nesting: `avatars/01.jpg` → `"avatars/01.jpg"`).

**Render-time consumption:**

```ts
import { resolveVariants, renderPicture } from '@run402/astro/manifest';
import manifest from '../../dist/_assets-manifest.json';

function renderHeroImage(imageUrl: string, alt: string): string {
  // imageUrl came from a database row: '/assets/hero.jpg'
  const key = imageUrl.replace(/^\/assets\//, '');
  const ref = resolveVariants(manifest, key);
  if (!ref) {
    // Fallback: not in manifest (admin-uploaded post-deploy, etc.)
    return `<img src="${imageUrl}" alt="${alt}">`;
  }
  return renderPicture(ref, { alt, sizes: '100vw', priority: true });
}
```

`renderPicture` produces the same `<picture>` HTML the static `<Image>` component does, with the same CLS-prevention contract (#4 in **Before you start**). No Vite or Astro runtime dependency — safe to import from any SSR / SSG / API-route module. It accepts any `AssetRef`, whether resolved from the manifest or read straight off a row, so the persistence pattern and the manifest pattern share the same renderer.

**Attaching app-specific attrs to the `<picture>` element (v0.2.5+).** Pass `pictureAttrs` to splice `data-*`, `id`, `role`, or any other HTML attribute onto the outer wrapper without forking the renderer:

```ts
renderPicture(ref, {
  alt,
  sizes: '100vw',
  priority: true,
  pictureAttrs: { 'data-hero-picture': '', 'data-hero-aspect': '21/9' },
});
// → <picture data-hero-picture="" data-hero-aspect="21/9">…</picture>
```

Keys are validated against `[a-zA-Z][a-zA-Z0-9-]*` and silently dropped if invalid; values are HTML-attribute-escaped. When the source falls back to a single `<img>` (sub-320 / no variants), the attrs land on the `<img>` instead — the wrapper-most element either way.

**Decoding a blurhash on your own (v0.2.5+).** If you're emitting custom `<picture>` markup that bypasses `renderPicture` entirely, the LQIP helpers ship as a subpath export:

```ts
import { decodeBlurhashToDataUri, averageColorFromBlurhash } from '@run402/astro/blurhash';

const lqip = ref.blurhash ? decodeBlurhashToDataUri(ref.blurhash) : null;
// → 'data:image/png;base64,…'  (32×32 PNG, ≈600 bytes)
```

Both functions are pure over the blurhash string — no I/O, no Vite virtual modules, byte-equivalent to Wolt's `blurhash@2.0.5` reference (see `blurhash-decoder.test.ts`). Closes [run402-private#414](https://github.com/kychee-com/run402-private/issues/414).

**Combining both paths.** Set BOTH `assetsDir` and use `<Image>` for static-template images. The integration deduplicates by absolute path + CAS dedup at the gateway, so an image referenced via both paths uploads once.

### Reading the manifest during `astro build` (v0.2.4+)

The manifest JSON is written at `closeBundle` time — *after* Astro renders pages. If your bake step needs the manifest during page render (e.g. you're emitting `<picture>` HTML directly into `dist/index.html` from a typed seed), you can't read the file from disk in `.astro` frontmatter because it doesn't exist yet. Use `getBuildTimeManifest()` from `@run402/astro/build-manifest` instead — it returns the same shape, sourced from the integration's virtual module:

```astro
---
// src/pages/index.astro
import Portal from '../layouts/Portal.astro';
import { getBuildTimeManifest } from '@run402/astro/build-manifest';
import { resolveVariants, renderPicture } from '@run402/astro/manifest';
import { mySectionsFromSeed } from '../lib/my-bake';

const manifest = getBuildTimeManifest();
const sectionsHtml = mySectionsFromSeed(manifest)
  .map(s => renderSection(s, manifest))
  .join('');

function renderSection(s, manifest) {
  const ref = manifest ? resolveVariants(manifest, s.image_key) : null;
  const img = ref
    ? renderPicture(ref, { alt: s.alt, sizes: '100vw', priority: s.priority })
    : `<img src="${s.image_url}" alt="${s.alt}">`;
  return `<section class="${s.cls}">${img}</section>`;
}
---
<Portal title="Home">
  <div id="sections" set:html={sectionsHtml}></div>
</Portal>
```

**Returns**:

- `AssetManifest` — `assetsDir` is configured and the walk found at least one image. Pass to `resolveVariants(manifest, key)` exactly like the runtime path.
- `null` — `assetsDir` is unset (the integration's data-driven path isn't in use). Your bake should fall back to plain `<img>`.

**Options** (all optional, override the baked values):

```ts
getBuildTimeManifest({
  projectId: 'prj_preview',                // override the baked project_id
  assetPrefix: 'my-app/',                  // override the baked asset_prefix
  generatedAt: '2026-01-01T00:00:00.000Z', // for deterministic builds (snapshot tests)
})
```

> ⚠️ **Don't import `@run402/astro/build-manifest` from `astro.config.mjs`.** It transitively imports the `virtual:run402-assetmap` Vite module, which doesn't exist before Vite starts. Astro CLI loads the config file via vanilla Node — same boundary that closed [run402-private#400](https://github.com/kychee-com/run402-private/issues/400). Page templates and any modules pages import are fine.

### Bulk admin UIs

If you need to list every asset uploaded to a project (admin gallery, "show me everything in this prefix" media browser), the build-time manifest is the wrong tool — it only covers what `assetsDir` walked at build time, doesn't include runtime uploads, and can't paginate or filter. Use `r.assets.ls(projectId, { prefix, limit?, cursor?, sort?, filter? })` from the SDK instead; it's the storage list endpoint with v1.50 pagination, sort, and media-picker filters.

## Generated HTML

For an image source with v1.49 variants (≥ 320 pixels on both axes), the component emits:

```html
<picture>
  <source type="image/webp"
          srcset="https://cdn.run402.com/.../hero-thumb.webp 320w,
                  https://cdn.run402.com/.../hero-medium.webp 800w,
                  https://cdn.run402.com/.../hero-large.webp 1920w"
          sizes="100vw" />
  <img src="https://cdn.run402.com/.../hero.jpg"
       alt="Sunset over the Pacific"
       width="1600"
       height="1200"
       loading="eager"
       fetchpriority="high"
       style="background-image:url(data:image/png;base64,...);" />
</picture>
```

Width/height attributes prevent cumulative layout shift. The inlined blurhash data URI provides a low-quality image placeholder while the real bytes load.

For HEIC sources, the `<img>` fallback uses the generated `display_jpeg` variant (so non-HEIC-capable browsers - everything before Safari 14 - still render). The original HEIC bytes are preserved in CAS but never served via `<img>`.

For sources smaller than 320 pixels on either axis (logos, icons), the component falls back to a single `<img>` with a build warning.

## Props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `src` | `string` | required | Path relative to the importing file. Leading slashes are rejected. |
| `alt` | `string` | required | Alt text. Escaped for HTML. |
| `sizes` | `string` | `"100vw"` | Passed through to the `<source>` element. |
| `priority` | `boolean` | `false` | Above-the-fold opt-in: emits `loading="eager"` + `fetchpriority="high"`. |
| `loading` | `"lazy" \| "eager"` | `"lazy"` | Ignored when `priority` is set. |
| `width` | `number` | source width | Override width; height auto-recomputed preserving aspect ratio. |
| `height` | `number` | source height | Override height; width auto-recomputed preserving aspect ratio. |
| `class` | `string` | — | Passthrough to `<img>`. |
| `placeholder` | `"blurhash" \| "color" \| "none"` | `"blurhash"` | LQIP strategy. |
| `pictureAttrs` | `Record<string, string>` | — | v0.2.5+. Extra attributes on the outer `<picture>` (or fallback `<img>`). Keys must match `[a-zA-Z][a-zA-Z0-9-]*`; values escaped. |

## Integration options

```js
run402({
  projectId: 'prj_...',        // overrides RUN402_PROJECT_ID env var
  assetPrefix: 'astro/',       // key prefix for uploaded blobs
  dryRun: false,               // when true, log references but don't upload
  verbose: false,              // print per-image upload events to stderr
})
```

## Build cache

On first build, every unique source is uploaded. Subsequent builds against unchanged sources are essentially free - the cache at `node_modules/.run402/assetMap.json` is keyed by source SHA-256. The cache directory is gitignored on first write (entry appended to project-root `.gitignore`).

Re-deploys with unchanged bytes:
- CAS dedup at the gateway means S3 stores one copy of each unique sha
- The encoder is a no-op for `(project, sha, v1)` tuples already present
- `bytes_reused` reflects the cached set; `bytes_uploaded` reflects new work only

## Dry run

```sh
ASTRO_INTEGRATIONS_LOG=true astro build
```

Or programmatically:

```js
run402({ dryRun: true })
```

Walks the project, lists every `<Image>` reference with its sha256 prefix and file size, estimates upload duration based on the v1.49 encoder semaphore (2 concurrent, ~10s per encode), and exits without uploading.

## Error handling

The integration fails the build (rather than silently falling back) when:

- `<Image src="/absolute">` - leading-slash paths refer to `public/` and bypass the variant pipeline
- Source file does not exist
- Extension is not one of `.jpg / .jpeg / .png / .webp / .avif / .heic / .heif`
- Gateway returns `IMAGE_DECODE_FAILED`, `IMAGE_INPUT_TOO_LARGE`, `IMAGE_ENCODE_TIMEOUT`, `QUOTA_EXCEEDED`
- Encoder queue stays full across 3 retries (`TOO_MANY_ENCODES_QUEUED`)

Each error names the offending file path so the build log points you at the right line.

## What this package does NOT do (v0.1)

- **Dynamic `src` expressions.** Only string literals are extracted. `<Image src={myImage}>` emits a build warning and skips that reference. v0.1 is for build-time-known image references; runtime-dynamic images (CMS-driven) keep using `r.assets.put` server-side.
- **Arbitrary widths.** The variant ladder is the v1.49 fixed set (320 / 800 / 1920). No `?w=437` lazy transforms.
- **Edge content negotiation.** No CloudFront-side variant routing. The `<picture>` element does the negotiation client-side via standard HTML semantics.

## Known limitations

- Astro auto-copies `public/` into `dist/`. The integration filters out any `public/`-located image that's referenced via `<Image>`, but a `public/`-located image NOT referenced via `<Image>` still ships in `dist/` (and via `deployment_files`). If you want all images to go through variants, keep them under `src/images/` not `public/images/`.
- New images added during `astro dev` require a dev server restart. Subsequent builds pick them up automatically.

## License

MIT
