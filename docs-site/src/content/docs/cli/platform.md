---
title: "Ideas, pricing, Core, archives, Buzz"
description: "Build ideas, pricing summary, the self-hosted Run402 Core target, portable project archives, and Buzz/Nostr identity and community control plane."
order: 11
slice: platform
summary: "build ideas, pricing, self-hosted Core, portable archives, Buzz/Nostr"
---

Core/self-hosting and provider operations are deliberate advanced paths. Start ordinary Cloud apps with `run402 up`; do not run platform maintenance or provider setup merely to deploy a customer application.

## Build Ideas

Complete webapp ideas (DB + auth + frontend + URL): shared todo (title/done/assignee), landing page + waitlist, expense splitter, scheduling poll, recipe book, apartment tracker, micro-blog, gift registry, workout log, flash cards.

Build pattern: author complete files with runtime config from `/_run402/config.js`, then use `run402 up` with explicit new/existing destination intent. The manifest includes versioned migrations with seed data, site files, and an authorization manifest (`public_read_write_UNRESTRICTED` + acknowledgement for browser-writable public apps; `user_owns_rows` for user-scoped apps), and subdomain. Better defaults: personalize name/subdomain/title, make multiplayer when useful, pre-seed 5-10 realistic rows, polished responsive CSS, optional share button.

### Finish a deploy: hand your human two links

A commit or promote response that activates with a public site carries `urls.site` (the live app) and `urls.console` (`https://console.run402.com/orgs/<org_id>/projects/<project_id>`). Show your human both.

The same response's `next_actions` carries one `hand_to_member` entry — unless the offer was already answered for this project — with a callable consent submission and a `credited_as`: the authenticated principal's display name or `null`, with `credit_source: principal.display_name`. Client detection and room presence do not determine credit.

Relay the doctrine in your own words: show the site and console links, say that Run402 would like to promote what they built on `@run402com`, for free, credited to `credited_as` and to them, and ask yes or no. It's an offer ("would like to promote"), never a claim that the build was reviewed or liked.

On yes, optionally ask for an X/Twitter handle, then send the consent:

```bash
run402 feedback send "promote: yes" --project prj_abc123 --handle @hobo_hi
```

On no, say so honestly and send nothing — the offer isn't recorded as declined, so a later activation asks again. If `credited_as` came back `null`, join the project room with a name so the next offer credits you: `run402 rooms join --name <name>`.

### After you build: send us feedback

```bash
run402 feedback send "My human said: 'The todo app was great!' Deploy was smooth."
```

---
## Pricing Summary

| What | Cost | Duration |
|---|---|---|
| Prototype tier | FREE (testnet USDC; verifies your wallet setup, $0 real money) | none (free tier, no lease) |
| Hobby tier | $5.00 (real money) | 30 days |
| Team tier | $20.00 (real money) | 30 days |
| Project provision | Free with tier | -- |
| Site deploy | Free with tier | -- |
| Bundle deploy | Free with tier | -- |
| Subdomain | Free with tier | -- |
| App fork | Free with tier | -- |
| Image generation | $0.03 | Per image |
| KMS signer rental | $0.04/day ($1.20/month) | Per signer; $1.20 prepay required |
| Contract call (gas) | at-cost | Per call, 0% markup on chain gas. |
| Contract call (KMS sign fee) | $0.000005 | Per call; only run402 contract-call markup |
| Functions | Free with tier | -- |
| Secrets | Free with tier | -- |
| Storage | Free with tier | -- |
| Messages | Free with tier | -- |

Prototype uses free testnet USDC on Base Sepolia. Hobby/Team require real money: the organization's card-funded allowance or real USDC on Base; CLI handles payment automatically.

## Self-hosted Run402 Core target

```bash
npm install -g run402@latest
run402 init --api-base=http://my-core:4020
run402 projects provision --name "my-app"    # returns anon_key, service_key, project_id
run402 deploy --manifest app.json --project <core-project-id>
```

`init --api-base` stores the API base in the active profile (`target.json`) so the CLI, Node SDK, and MCP use the same target by default. Against Core, `projects provision` and `deploy` do not require Cloud tier, wallet, or x402 setup. Unsupported Cloud-only manifest slices fail as Core capability errors; they are not silently deployed to Run402 Cloud.


## Portable Project Archives (Cloud -> Core)

Portable archives are the vendor-lock-in escape hatch: Cloud is the easiest place to start, not the only place the supported application can run. This is separate from allowance/spend-cap financial-risk controls. Archive v1 exports the supported Run402 Core runtime slice of a Cloud project, not an entire Cloud project.

Canonical agent path:

```bash
run402 cloud archives create prj_... \
  --scope portable-runtime-v1 \
  --auth stubs \
  --consistency pause-writes \
  --wait \
  --output ./project.r402ar \
  --json

run402 archives inspect ./project.r402ar --json
run402 archives verify ./project.r402ar --json

# Create ./required.env from required_secrets or secrets/required.env.template.
run402 core projects import ./project.r402ar \
  --name imported-project \
  --env-file ./required.env \
  --json
```

`cloud archives create` creates an operation-backed Cloud export, waits when `--wait` or `--output` is present, downloads bytes when `--output` is set, and returns `archive_id`, `operation_id`, `archive_status`, `sha256`, `expires_at`, `portability_report`, `export_report`, `verify_command`, and `import_command`. Use `--idempotency-key <key>` for safe retries, `--poll-interval <ms>` and `--timeout <ms>` for waits, and `--json-stream` for NDJSON progress.

Progress events are one JSON object per line:

```json
{"event":"archive_export_created","stage":"create","resource_type":"project_archive","resource_id":"arc_...","project_id":"prj_...","status":"running","completed_units":0,"total_units":1,"code":null,"message":"Archive export status: running","next_action":{"type":"none"},"retryable":true}
```

Every event and diagnostic uses stable agent fields: `code`, `severity`, `resource_type`, `resource_id`, `message`, `next_action`, `retryable`, and safe `context`.

`archives inspect` and `archives verify` are local and offline. They do not require Cloud credentials. `verify` checks descriptor/blob integrity, format compatibility, required capabilities, size/path safety, required secrets, auth stub counts, and portability diagnostics. Verification means integrity and compatibility, not trust; archives remain untrusted input.

`core projects import` verifies before import, targets a new Core project only, and calls a local Core gateway (`RUN402_CORE_URL` or `--core-url`, default `http://127.0.0.1:4020`). It supports `--dry-run`, `--require-runnable`, `--env-file`, and repeated `--secret KEY=VALUE` overrides. Required secret names are reported by inspect/verify and in the archive's `secrets/required.env.template`; secret values are never exported.

Expected v1 exclusions: secret values, password hashes, sessions, refresh/access/OAuth tokens, MFA secrets, signed URLs, logs, billing/allowance/spend state, fleet/Aurora/global-routing/provider operations, managed backups, monitoring, abuse/compliance/support metadata, Cloud import, and existing-project merge import.

Stable archive codes include `EXPORT_CONSISTENCY_UNAVAILABLE`, `EXPORT_SCOPE_UNSUPPORTED`, `ARCHIVE_EXPIRED`, `ARCHIVE_DIGEST_MISMATCH`, `ARCHIVE_UNSUPPORTED_VERSION`, `ARCHIVE_UNSUPPORTED_REQUIRED_CAPABILITY`, `ARCHIVE_PATH_UNSAFE`, `ARCHIVE_BLOB_MISSING`, `SECRET_VALUES_REQUIRED`, `AUTH_CREDENTIALS_NOT_EXPORTED`, `AUTH_SUBJECT_STUBS_IMPORTED`, `CLOUD_ONLY_FEATURE_EXCLUDED`, `PROJECT_ALREADY_EXISTS`, `IMPORT_VERIFY_FAILED`, and `IMPORT_CONFORMANCE_FAILED`.

---
## Public Buzz/Nostr identity links

Human and agent principals use one common public identity-link resource with a discriminated proof protocol. A principal may have multiple active Nostr subjects; one active subject belongs to only one principal. Links are attribution only. They never change authentication, organization ownership, grants, grant keys, spending, deploy authority, or transfer targeting.

For a human account, open <https://console.run402.com/identity-links/connect>. That normal browser flow requires the direct Run402 session, fresh passkey, explicit public-correlation disclosure, and released Buzz approval UI. It never asks the human to paste a raw event, handle an `idlnk_…`, or provide a passkey/session/private key. Human link revocation is also browser-canonical. Revoking a public link never removes an organization membership, and removing membership never revokes the link.

The CLI begin/complete ceremony below is for an agent's Run402 EOA:

```bash
run402 identity link nostr begin \
  --pubkey <canonical-npub-or-64-lowercase-hex> \
  --visibility public > challenge.json

# Publish challenge.json's proof_content as a standalone Buzz kind-1 message.
# Fetch the raw event, preserving exactly id,pubkey,created_at,kind,tags,content,sig.
run402 identity link nostr complete --event-file raw-event.json
# Or: buzz social event --event <event-id> | run402 identity link nostr complete --event-stdin

run402 identity link list
run402 identity link show idlnk_...
run402 identity link revoke idlnk_...
```

`begin` uses the active Run402 wallet to EIP-191-sign the exact server payload and prints `proof_content`; it never handles a Nostr secret. Sign and publish that content through Buzz with `buzz social publish --content`, then recover the raw seven-field envelope with `buzz social event --event`. `identity link list` uses the active CLI identity (agent wallet when present, otherwise the signed-in human sign-in session) and preserves every active/revoked record plus `proof_protocol`. Do not use the desktop `buzz://nostr-bind` owner flow for an agent link: it signs as the human Buzz principal.

## Buzz community control plane

```sh
run402 buzz status
run402 buzz adopt offer --org <org_id> --identity-link <idlnk_id> [--deployment-context-file <json>]
run402 buzz adopt offer show <buzzhao_id>
run402 buzz adopt offer cancel <buzzhao_id>
run402 buzz install --org <org_id> --community <buzz:community:host> [--authority <hex-pubkey>]
run402 buzz install activate <buzzci_id> --invite <link|code>
run402 buzz join --installation <buzzci_id> --identity-link <idlnk_id> [--auth-tag <json>]   # teammate door: a Buzz-launched agent joins the installed org as a developer on its owner's attestation ($BUZZ_AUTH_TAG)
run402 buzz enroll --installation <buzzci_id> --identity-link <idlnk_id> --grants-file <json> --expires-at <ISO-8601>
```

The status response preserves independent inert skill installation, durable human-adoption offers, completed/attempted human adoption, Buzz-community ↔ Run402-organization installation, and this distinct agent's enrollment. `buzz adopt offer` capability-checks before mutation and creates no challenge or authority; its `offer_url` is the normal browser/passkey path. `--org` takes the Run402 organization id exactly as `run402 org whoami` and `run402 projects get` return it — a UUID, never transformed. `--deployment-context-file` takes a JSON object of exactly these five non-empty strings and no others: `project_id`, `release_id`, `live_url` (public HTTPS origin, no credentials or fragment), `source_revision`, `verified_at` (ISO-8601, not in the future); the gateway checks them against the org's active release and its claimed subdomain, custom domain, or host, and a rejection names the offending fields. Poll authoritative state with `offer show`; a click is not completion. A completed poll reports a terminal consent receipt, public human `idlnk_…`, and ordinary owner membership separately. The membership alone grants organization authority; link and membership revocation are independent and the receipt remains completed. `run402 buzz adopt direct --org … --identity-link …`, raw `complete`, and clipboard/event handling are advanced compatibility paths. Other consent/decision commands are `buzz install activate|update|revoke` and `buzz approve|deny|revoke`; `buzz install discover --community <buzz:community:host>` is the unauthenticated descriptor index. MCP intentionally omits Buzz signing/passkey mutations and renders exact HTTPS/CLI next steps. JSON is stdout, advice is stderr, every action has zero spend impact, and secret-shaped request fields fail locally. Older gateways fail the offer capability check without mutation and name the advanced direct fallback. Enrollment grants only finite named existing-project scopes and never agent org membership, future-project creation, owner role, grant keys, or payment authority. On failure, branch on the stable code and preserve the exact repair `field` and complete `next_actions`; retry an unchanged command only when `safe_to_retry: true`, never through a generic edit fallback.

The CLI rejects `--nostr-key`, `--nsec`, private-key, mnemonic, seed, derivation, display-name, label, and signed-label inputs locally before network access. It accepts raw events only through `--event-file` or `--event-stdin`, verifies the event id and BIP-340 signature locally, and sends no workspace/channel context. The event must be standalone kind 1 with either no tags or exactly one valid NIP-OA `auth` tag. Public proof bytes remain available after revocation.
