## Why

The gateway now allows up to 5 mailboxes per project (run402-private change `multi-mailbox-per-project`, gateway live), but the SDK / MCP / CLI email surface still assumes exactly one. Two concrete problems result:

1. **No way to target a specific mailbox.** Every email operation funnels through `Email.resolveMailbox(projectId)` in `sdk/src/namespaces/email.ts`, which resolves to the cached `mailbox_id` (whatever `create_mailbox` cached *last*) or `list[0]`. With multiple mailboxes a `send` / `list` / `get` silently hits an arbitrary one. For the driving use case — kysigned running `sign@`, `notifications@`, and `support@` on one project — silently routing a send to the wrong mailbox is exactly the failure we need to prevent.

2. **`create_mailbox` 409 recovery is now wrong.** `Email.createMailbox` treats any 409 as "project already has a mailbox" and recovers by returning `list[0]`. That logic was written for the gateway's old `"Project already has a mailbox"` 409. Post-gateway-change, a 409 means **slug already in use**, **address in cooldown**, or **project mailbox limit reached (5)** — none of which mean "you already own this slug." Returning `list[0]` on a slug-collision now silently hands back a *different* mailbox as if creation succeeded. This recovery must be removed.

## What Changes

- **SDK (`@run402/sdk`):** Add an optional `mailbox` selector (mailbox **id** like `mbx_…` **or** slug) to the email read/send/webhook operations. `Email.resolveMailbox(projectId, selector?)` becomes the single resolution point:
  - **selector is an id** (`mbx_` prefix) → used directly (the gateway validates project ownership and 403s on mismatch); no list call.
  - **selector is a slug** → list the project's mailboxes, match by `slug`; 404 if no active mailbox has that slug.
  - **selector omitted** → list the project's mailboxes: 0 → existing "no mailbox, create one first" error; exactly 1 → use it (back-compat, and refresh the keystore cache); **2+ → throw a 409 Local/ApiError naming the available slugs and requiring `mailbox`**. No silent pick.
  - `mailbox` threads through `send`, `list`, `get`, `getRaw`, `getMailbox`, `deleteMailbox` (extends the existing `mailboxId` arg), and all `webhooks.*` methods.
- **SDK `createMailbox`:** Remove the 409 → `list[0]` recovery. Surface the gateway 409 verbatim (`Slug already in use` / `Address is in cooldown period` / `Project mailbox limit reached (5)`). `create` stops being implicitly idempotent — callers that want "create-or-get" call `getMailbox`/`list` themselves. (Pre-revenue surface; the old idempotency was a single-mailbox convenience that is now unsafe.)
- **MCP tools:** Add an optional `mailbox` parameter (slug or id) to `send_email`, `list_emails`, `get_email`, `get_email_raw`, `get_mailbox`, `delete_mailbox`, and the five webhook tools. Pass through to the SDK. When the project has multiple mailboxes and `mailbox` is omitted, the ambiguity error from the SDK surfaces with the available slugs.
- **CLI (`run402`):** Add `--mailbox <slug|id>` to `email send` / `list` / `get` / `get-raw` / `reply` / `info` / `delete` and the `email webhooks *` subcommands. Update the `email` HELP and per-subcommand help: remove "One mailbox per project"; document `--mailbox` and the "specify which mailbox when you have more than one" behavior.
- **Keystore semantics:** `ProjectKeys.mailbox_id` / `mailbox_address` stay as a best-effort cache, but are **no longer the authoritative resolver** when a selector is omitted — resolution lists and disambiguates. The cache is only used/refreshed for the single-mailbox fast path. (No keystore schema change.)
- **Docs:** `cli/llms-cli.txt` email section, `cli/README.md`, root `SKILL.md` / `llms-mcp.txt` email examples — document multi-mailbox + `mailbox`/`--mailbox`. Remove "one mailbox per project" claims.

## Capabilities

### New Capabilities

- `email-mailbox-selection`: Public contract for selecting among a project's multiple mailboxes across SDK, MCP, and CLI. Defines the `mailbox` selector (id or slug), the omitted-selector resolution rule (0 → error, 1 → use it, 2+ → ambiguity error naming slugs), the id-vs-slug resolution semantics, and the removal of `create`'s implicit 409 idempotency. This capability fully governs the surface — the `mailbox`/`SendEmailOptions.mailbox`/etc. additions are additive to the SDK public types and need no separate `sdk-public-type-surface` requirement (which does not enumerate the email methods).

### Modified Capabilities

- None. The additive `mailbox` selector does not contradict any existing requirement in `sdk-public-type-surface` (it enumerates billing identifiers, not the email methods). Extending `fullstack-integration-coverage` to a live multi-mailbox scenario is deferred to a follow-up that runs in a credentialed environment — this change is verified by SDK/MCP/CLI unit tests and the `sync.test.ts` parity check.

## Impact

- **SDK:** `sdk/src/namespaces/email.ts` (resolveMailbox + 6 methods + Webhooks class + createMailbox 409 path), `sdk/src/namespaces/email.test.ts`. Public type surface additive.
- **MCP:** `src/tools/{send-email,list-emails,get-email,get-email-raw,get-mailbox,delete-mailbox,register-mailbox-webhook,list-mailbox-webhooks,get-mailbox-webhook,update-mailbox-webhook,delete-mailbox-webhook}.ts` + their `*.test.ts`. `src/index.ts` tool schemas.
- **CLI:** `cli/lib/email.mjs` + `cli/lib/webhooks.mjs`, HELP/SUB_HELP, `cli-*.test.mjs` assertions.
- **Parity:** `sync.test.ts` SURFACE — the `mailbox` param must appear in MCP + CLI + (where applicable) OpenClaw for the email tools.
- **Docs:** `cli/llms-cli.txt`, `cli/README.md`, `SKILL.md`, `llms-mcp.txt`.
- **Versioning:** lockstep **minor** bump (2.20.1 → 2.21.0) across `run402-mcp` + `run402` + `@run402/sdk`. The `mailbox` additions are additive; the only behavior change is `create` no longer recovering on 409 — surfaced in release notes.
- **Related (separate repo, out of scope here):** `run402-private/openspec-public/specs/project-email/spec.md` still describes single-mailbox tools and a "409 → mailbox already exists" recovery scenario; that public-product spec should be synced in a follow-up run402-private change. The gateway itself is already shipped + N-ready.
- **Not changed:** the gateway (already done), the keystore file format, the x402/auth path.
