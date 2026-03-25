## Context

`create_mailbox` currently treats a 409 (project already has a mailbox) as a hard error. Deploy scripts that call `email create` on every run fail on the second invocation with no way to recover the mailbox ID. The existing `resolveMailboxId()` helper (used by send/list/get) already knows how to discover a project's mailbox via `GET /mailboxes/v1`, but `create_mailbox` doesn't use it.

There is also no standalone command to inspect mailbox info — users must infer it from side effects of other commands.

## Goals / Non-Goals

**Goals:**
- Make `create_mailbox` / `email create` idempotent: return existing mailbox info on 409 instead of erroring
- Add a `get_mailbox` MCP tool and `email status` CLI command for direct mailbox info retrieval
- Full test coverage for both changes
- Updated documentation (llms.txt, llms-cli.txt, SKILL.md, HELP string)
- Sync test parity across MCP, CLI, and OpenClaw

**Non-Goals:**
- Changing the API server's 409 response body (client-side fix only)
- Adding mailbox deletion or update capabilities
- Changing slug validation behavior

## Decisions

### 1. Client-side 409 recovery via existing discovery endpoint

On 409 from `POST /mailboxes/v1`, call `GET /mailboxes/v1` to fetch the existing mailbox and return it as success with an "already exists" note.

**Why not just change the API?** The API fix (including `{id, address}` in 409 body) is the ideal long-term solution but requires a backend deploy. The client-side approach ships now and works with the existing API. Both fixes can coexist — if the API later includes mailbox info in the 409 body, the client-side discovery call becomes a no-op optimization opportunity.

**Alternative considered:** Checking for existing mailbox _before_ calling POST. Rejected because it adds latency to the happy path (first-time create) to optimize the less common case.

### 2. Reuse `resolveMailboxId()` pattern for 409 recovery

The MCP `send-email.ts` already exports `resolveMailboxId()` which calls `GET /mailboxes/v1` and caches the result. The 409 handler in `create-mailbox.ts` will use the same approach (inline, not importing — to avoid circular coupling). The CLI `email.mjs` already has its own `resolveMailboxId()` and will reuse it directly.

### 3. New `get_mailbox` tool follows existing tool pattern

New MCP tool at `src/tools/get-mailbox.ts` with Zod schema + async handler, matching the existing tool pattern. Uses `GET /mailboxes/v1` (same endpoint as `resolveMailboxId`) and caches the result. CLI adds `email status` subcommand. OpenClaw re-exports from CLI as usual.

**Why `get_mailbox` / `email status` not `email info`?** "status" aligns with the existing `run402 db status` and `run402 site status` command naming pattern in the CLI.

### 4. MCP tool name: `get_mailbox` (not `mailbox_status`)

Follows the existing naming convention: `create_mailbox`, `send_email`, `list_emails`, `get_email` → `get_mailbox`. The CLI uses `email status` as the subcommand (matching `db status`, `site status`).

## Risks / Trade-offs

**[Extra API call on 409]** → The 409 recovery path makes one additional `GET /mailboxes/v1` request. This is acceptable: 409 only happens when the mailbox already exists, and the discovery call is lightweight. The result is cached in the keystore so subsequent commands don't repeat it.

**[Race condition: 409 then mailbox deleted before GET]** → Extremely unlikely in practice (mailbox deletion doesn't exist yet). If it happens, the GET returns empty and the user gets a clear error ("No mailbox found").

**[CLI output format change on 409]** → Currently outputs `{ status: "error", http: 409 }`. After the change, outputs `{ status: "ok", mailbox_id, address, already_existed: true }`. This is a behavior change but intentionally so — it's the fix the user requested. Scripts checking `status === "ok"` will now work correctly on re-runs.
