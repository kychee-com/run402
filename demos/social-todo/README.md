# social-todo — every way to sign in, one shared list

The run402 **auth showcase**, built as an **Astro SSR** app that runs 100% on
run402. A single shared to-do list sits behind run402's hosted auth: sign in with
a **password, Google, a magic-link, or a passkey** — they all mint the same
cookie session — then add/check/delete items that **Row-Level Security** binds to
you. This demo absorbs the old standalone `passkeys` demo: passkeys are now one of
the four sign-in methods plus a section of the account page.

Live (after onboarding): `https://social-todo.run402.com`

## What it shows off

| Feature | run402 surface |
|---|---|
| Sign in: password / Google / magic-link / passkey | `<SignIn methods={["password","google","magic_link","passkey"]}>` — each wired to its hosted ceremony, no fetch |
| Create an account | `<SignUp>` |
| Signed-in chrome + sign-out | `<UserButton>`, `<SignedIn>` / `<SignedOut>` |
| Manage credentials (password, passkeys, sessions, linked Google) | `<AccountSecurity sections={["password","passkeys","sessions","identities"]}>` |
| Opaque cookie session, no client tokens | `__Host-` session cookie + `auth.user()` server-side |
| Shared-read, owner-write to-dos | Postgres **RLS** keyed to `run402.current_user_id()`, mutated through `db(req)` |

## Design notes

- **Cookie sessions, not client tokens.** The old social-todo was a client SPA
  juggling `anon_key` + access/refresh tokens against `/rest/v1` and the legacy
  `/auth/v1/oauth/google/start` flow. This version never touches a token: the
  components POST to hosted `/auth/*` routes, the gateway sets a host-only session
  cookie, and `auth.user()` / `db(req)` read it server-side.
- **RLS is the access control.** `todos_shared_read` (`USING true`) lets any
  signed-in user read the whole list; the owner-only INSERT/UPDATE/DELETE policies
  (keyed to `run402.current_user_id()`, with `user_id` filled by a column DEFAULT)
  make "I can see your todo but can't touch it" true at the database. The UI just
  reflects what RLS already enforces.
- **No-JS.** Add / toggle / delete are plain `<form method="POST">` posts to API
  routes that mutate via `db(req)` and 303 back — same zero-client-JS posture as
  the hosted auth components.

## Local dev

```bash
npm install
RUN402_PROJECT_ID=<prj_…> npm run dev     # run402() needs the project id at build/dev
npm run check                              # astro check (typecheck)
npm run build                              # → dist/run402/{client,server,adapter.json}
```

## Deploy (onboarding, one-time operator)

Source-only until provisioned. To onboard:

1. `run402 projects provision --name social-todo --wallet <deploy-wallet>` → `project_id`.
2. Mark it a system project + claim the `social-todo` subdomain. Configure the
   Google OAuth provider for the project so the `google` method works.
3. `run402 ci link github --project <id> --repo kychee-com/run402 --environment demos --repository-id <id> --wallet <deploy-wallet>` → `binding_id`.
4. Record `project_id` / `binding_id` / `owner_wallet` / `oidc_subject` into `app.json`.

Then `deploy.ts` builds the app and runs the canonical:

```bash
run402 deploy apply --dir dist --manifest run402.config.json --project <id>
```

`run402.config.json` carries the DB migration (`schema.sql`); `--dir dist` carries
the Astro static client + the `class: "ssr"` function. Routes are implicit.

> **Note:** the shared `demos/_deploy` matrix workflow needs an Astro-aware leg
> (install + `astro build`) before the apply — part of onboarding.
