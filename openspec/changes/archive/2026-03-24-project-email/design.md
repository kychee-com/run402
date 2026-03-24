## Context

Run402's `/mailboxes/v1` API is live in production, providing project-scoped email (one mailbox per project, template-based sending). The MCP server, CLI, and OpenClaw skill need tool/command support so developers can manage mailboxes and send emails from all three interfaces.

The existing codebase follows a strict pattern: MCP tools in `src/tools/`, CLI commands in `cli/lib/`, OpenClaw shims in `openclaw/scripts/`, all kept in sync via the `SURFACE` array in `sync.test.ts`. Email tools follow the same patterns as existing tools (secrets, functions, storage).

All email endpoints use `service_key` auth (same as secrets, SQL, etc.) — no paid/allowance auth needed. One admin-only endpoint (`POST /mailboxes/v1/:id/status`) is excluded from the initial tool surface since it's not developer-facing.

## Goals / Non-Goals

**Goals:**
- Expose 4 MCP tools: `create_mailbox`, `send_email`, `list_emails`, `get_email`
- Expose CLI command group: `run402 email {create, send, list, get}` with full `--help` documentation
- Expose OpenClaw shim re-exporting CLI email module
- Enforce slug validation client-side (3-63 chars, lowercase alphanumeric + hyphens, no consecutive hyphens)
- Enforce single-recipient constraint client-side
- Follow existing tool/test patterns exactly
- Update `llms-cli.txt` in `~/dev/run402/site/` with email command reference

**Non-Goals:**
- Admin endpoint (reactivate suspended mailbox) — not developer-facing
- Webhook registration — defer to a future change
- Mailbox deletion — available via API but not exposed in initial tool surface
- Listing mailboxes separately — the API supports it but with 1-per-project constraint, `get_email` on a known mailbox suffices; mailbox ID is returned at creation time
- Client-side rate limit tracking — the API returns 429 with clear messages

## Decisions

### 1. Four tools, not nine

The API has 9 endpoints but only 4 are needed for the developer workflow: create a mailbox, send an email, list sent messages, get a message. Webhooks, deletion, listing mailboxes, and admin reactivation are deferred.

**Why:** Keeps the tool surface small and focused. The sync test enforces parity — fewer tools means less maintenance. Webhook and delete can be added later as separate SURFACE entries.

### 2. Mailbox ID stored in keystore project record

After `create_mailbox` succeeds, store `mailbox_id` and `mailbox_address` in the project's keystore entry (via `updateProject()`). Subsequent email tools (`send_email`, `list_emails`, `get_email`) accept `project_id` and look up the mailbox ID automatically.

**Why:** Users shouldn't need to remember or pass mailbox IDs — there's only one per project. This mirrors how `site_url` is stored after `deploy_site`. The `StoredProject` interface in `core/src/keystore.ts` already supports arbitrary fields.

### 3. CLI uses `--var key=value` for template variables

Template variables are passed as repeatable `--var` flags: `--var project_name="My App" --var invite_url="https://..."`. The CLI parses these into a `variables` object.

**Why:** Follows CLI conventions for key-value pairs. The alternative (JSON string) is harder to type. The `--var` pattern is familiar from tools like `docker run -e`.

### 4. Slug validation on client side

Both MCP and CLI validate the slug format before sending the API request: 3-63 chars, `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, no consecutive hyphens. This gives faster, clearer error messages than waiting for a server 400.

**Why:** Better UX. The server validates too, so this is defense-in-depth, not a replacement.

### 5. No `mailbox_id` parameter on send/list/get

Since there's exactly one mailbox per project, tools look up the mailbox ID from the keystore. If no mailbox is found, the error message suggests running `create_mailbox` first.

**Why:** Simpler API surface. Eliminates a parameter the user would always have to look up. If multi-mailbox support is added later, we can add an optional `mailbox_id` parameter.

## Risks / Trade-offs

- **Keystore dependency for send/list/get** — If a user creates a mailbox outside the CLI/MCP (e.g., via curl), the keystore won't have the mailbox ID. Mitigation: tools can fall back to `GET /mailboxes/v1` to discover the mailbox if not in keystore.
- **Template enum may grow** — Currently 3 templates. If more are added, the Zod enum needs updating. Mitigation: the server validates templates too, so a stale enum just means a less helpful error message temporarily.
- **Slug validation drift** — Client and server slug rules could diverge. Mitigation: keep client validation conservative (subset of server rules). Server is authoritative.
