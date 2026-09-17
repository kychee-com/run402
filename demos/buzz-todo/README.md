# Buzz To-Do

A tiny to-do list deployed on Run402 whose only sign-in is **Sign in with Buzz**.
A Buzz (Nostr) identity becomes a project-local user; tasks are stored in the
project's Postgres and keyed to that identity. No password, no email.

Live at [buzz-todo.run402.com](https://buzz-todo.run402.com).

## What it proves

The released Buzz Desktop `buzz://nostr-bind` consent handoff works as a login
ceremony for an ordinary tenant app, with no change to Buzz and no change to the
Run402 gateway. The whole ceremony lives in this app.

```
browser (buzz-todo.run402.com)          Buzz Desktop                    routed function
POST /api/buzz/start ──────────────────────────────────────────────▶ challenge row
◀── { code, deep_link } ◀──────────────────────────────────────────
show code, open buzz://nostr-bind?… ─▶ user types the code, approves
                                       signs kind 24243 with the current identity
◀── reopens /callback#buzz_bind=v1.… ◀
decode + scrub fragment
POST /api/buzz/complete { event } ────────────────────────────────▶ verify id + BIP-340 sig,
                                                                     nine tags == challenge,
                                                                     fresh, consume once,
◀── Set-Cookie ◀───────────────────────────────────────────────────  upsert user(pubkey)
GET /api/tasks ───────────────────────────────────────────────────▶ tasks WHERE pubkey
```

Buzz Desktop validates the deep link (https origin, callback on that exact
origin, fixed protocol fields) and signs an event with exactly nine tags in a
fixed order: `challenge_id`, `nonce`, `verification_code`, `audience`, `action`,
`protocol`, `version`, `origin`, `expires_at`. The function recomputes the event
id, verifies the Schnorr signature, and requires every tag to echo the stored
challenge byte for byte before consuming it.

## Layout

| Path | What |
| --- | --- |
| `run402.deploy.json` | Release spec: one migration, two pages, one function, five routes, the `buzz-todo` subdomain |
| `db/001_buzz_todo.sql` | `buzz_users`, `buzz_challenges`, `tasks` |
| `functions/api.mjs` | Challenge mint, event verification, session cookie, tasks CRUD |
| `site/index.html` | Sign-in button, six-digit code screen, task list |
| `site/callback.html` | Reads the Buzz fragment once, scrubs it, completes sign-in |

## Deploy

From this directory:

```sh
run402 up --name "Buzz To-Do" --yes --verify
```

## Demo grade, on purpose

- The session is an app-minted HMAC cookie keyed off the project's service key.
  It is not a Run402 tenant session; the Run402 tenant `auth.user()` helper does not know about it.
- Verification runs inside the tenant function. The product version of this
  idea moves it into the gateway's proof-based session route.
- There is no agent entrance: only Buzz Desktop's human consent flow is wired.
- A Buzz identity that is also linked to a Run402 principal is not enriched or
  recognised here. The app sees a pubkey and nothing else.
