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
starting tab: POST /api/buzz/claim { challenge_id, claim_token } ─▶ 202 until consumed, then
◀── { session_token } + Set-Cookie, once ◀─────────────────────────  the same session
GET /api/tasks ───────────────────────────────────────────────────▶ tasks WHERE pubkey
```

The claim step is what makes the app work framed inside Buzz Desktop (the
bundled run402 panel, opted in through `site.embedding.frame_ancestors`):
Buzz hands the signed proof to the system browser, whose cookie jar the pane
never sees, so the tab that started the challenge polls with a private claim
token that is neither in the deep link nor in the signed event. The page keeps
the returned token in `localStorage` and sends it as `Authorization: Bearer`
because a framed third-party cookie may be blocked by the webview.

Buzz Desktop validates the deep link (https origin, callback on that exact
origin, fixed protocol fields) and signs an event with exactly nine tags in a
fixed order: `challenge_id`, `nonce`, `verification_code`, `audience`, `action`,
`protocol`, `version`, `origin`, `expires_at`. The function recomputes the event
id, verifies the Schnorr signature, and requires every tag to echo the stored
challenge byte for byte before consuming it.

## Agents: the same list over MCP

`POST /api/mcp` serves the tasks as MCP tools (`list_tasks`, `add_task`,
`complete_task`, `delete_task`) over streamable HTTP with single JSON
responses. There is no sign-in step: every request carries
`Authorization: Nostr <base64 event>`, a NIP-98 kind-27235 event the caller
signs for that one request.

- The `u`, `method` and `payload` tags must be this host's `/api/mcp` URL, `POST`
  and the SHA-256 of the body. `created_at` must be within 60 seconds, and each
  event id is accepted once (`buzz_nostr_auth_seen`).
- With no `auth` tag, the signer works on its own list.
- With a NIP-OA `auth` tag (`["auth", owner, conditions, sig]`, the attestation
  a Buzz-managed agent already carries as `BUZZ_AUTH_TAG`), the owner's
  signature and conditions are checked against this event, and the agent
  works on its owner's list. You and the agents you own share one list.
- An invalid `auth` tag is refused rather than ignored, so an agent never
  lands on an empty list of its own by mistake.

Buzz Foundation's agent app hub signs these requests with the agent's key and
attestation when an agent connects to `https://buzz-todo.run402.com/api/mcp`.

## Layout

| Path | What |
| --- | --- |
| `run402.deploy.json` | Release spec: four migrations, two pages, one function, eight routes, the `buzz-todo` subdomain, the Buzz embedding opt-in |
| `db/001_buzz_todo.sql` | `buzz_users`, `buzz_challenges`, `tasks` |
| `db/003_buzz_pane_claim.sql` | claim-token columns on `buzz_challenges` for the in-pane pickup |
| `db/004_buzz_agent_auth.sql` | `buzz_nostr_auth_seen`, single-use NIP-98 event ids |
| `functions/api.mjs` | Challenge mint, event verification, claim pickup, session cookie/bearer, tasks CRUD, MCP with NIP-98/NIP-OA |
| `functions/api.test.mjs` | `node --test` for the verifiers and MCP dispatch (needs the two deps installed) |
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
- The agent entrance is the app's own `/api/mcp` route, not the platform's
  `/_run402/mcp`: the platform endpoint authenticates with per-host OAuth only
  and does not forward an app's own credentials to a tool.
- A Buzz identity that is also linked to a Run402 principal is not enriched or
  recognised here. The app sees a pubkey and nothing else.
