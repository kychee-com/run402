# Bug Report: bld402 Compatibility Testing (2026-03-20)

**Source:** bld402 consolidation testing — CLI agent, MCP agent, and Gate 2 automated tests
**Tested against:** run402 gateway (live api.run402.com), run402 CLI v1.13.5, run402-mcp v1.13.5
**Filed by:** bld402 blue team

---

## BUG-001: SQL with em-dash characters silently fails (HIGH)

**Component:** run402 gateway — `POST /projects/v1/admin/:id/sql`
**Severity:** HIGH — silent data loss

**What was attempted:**
Agent ran `npx run402 projects sql <project_id> "$(cat schema.sql)"` where `schema.sql` starts with comment lines containing em-dash characters (`—`):
```sql
-- Shared Todo List — collaborative task management
-- Tables: todos
CREATE TABLE IF NOT EXISTS todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ...
);
```

**What happened:**
The API returned `{"status": "ok", "rows": [], "rowCount": null}` — success response. But NO table was created. The DDL was silently swallowed.

**Why this is a bug:**
1. The endpoint returns a success response when the SQL was not executed
2. There is no error, no warning — the agent believes the schema was applied
3. Subsequent steps (RLS, deploy) proceed on a project with no tables
4. The failure is silent and extremely hard to debug

**Reproduction:**
```bash
# This silently fails:
npx run402 projects sql <id> "-- Comment with em-dash — here
CREATE TABLE test (id serial PRIMARY KEY);"

# This works:
npx run402 projects sql <id> "CREATE TABLE test (id serial PRIMARY KEY);"
```

**Root cause hypothesis:** The SQL parser or PostgREST layer treats the em-dash (`—`, U+2014) as a special character, possibly truncating the SQL at that point. Regular ASCII hyphens (`--`) in comments work fine.

**Fix:** Either:
- Strip non-ASCII characters from SQL comments before execution
- Return an error if SQL contains characters that will cause parse failures
- At minimum: return `rowCount: 0` or a warning when no DDL was executed

**Workaround (applied in bld402 tests):** Strip all comment lines from SQL before sending to the endpoint.

---

## BUG-002: `tier set` returns HTML instead of JSON when already subscribed (LOW)

**Component:** run402 CLI — `cli/lib/tier.mjs`
**Severity:** LOW — cosmetic/UX

**What was attempted:**
Agent ran `npx run402 tier set prototype` when the wallet already had an active prototype subscription.

**What happened:**
The CLI printed raw HTML (an error page) to stdout instead of a JSON response. Exit code was 1.

**Why this is a bug:**
Agents parse stdout as JSON. Receiving HTML causes JSON parse errors and confuses the agent. The idempotent case (already subscribed) should return a clean JSON response like:
```json
{"status": "ok", "tier": "prototype", "message": "Already subscribed", "lease_expires_at": "2026-03-27T..."}
```

**Fix:** In the CLI tier handler, catch the "already subscribed" case from the server response and return a structured JSON response instead of raw-forwarding the HTTP response body.

---

## BUG-003: `init` displays "Tier: (none)" when tier is active (LOW)

**Component:** run402 CLI — `cli/lib/init.mjs`
**Severity:** LOW — misleading display

**What was attempted:**
Agent ran `npx run402 init` after wallet was already set up with an active prototype tier.

**What happened:**
Output showed `Tier: (none)` even though `npx run402 tier status` correctly shows the active tier.

**Why this is a bug:**
The `init` command checks tier status but apparently fails to parse the response correctly, falling through to the "no tier" branch. This misleads agents into running `tier set` unnecessarily.

**Root cause hypothesis:** The `init` command uses `getAllowanceAuthHeaders` for the tier status check, but may be sending incorrect auth headers (e.g., wrong path in SIWX URI), causing the server to return a 401 which `init` silently treats as "no tier."

**Fix:** Debug the auth headers in `init`'s tier status check. Ensure the SIWX URI path matches `/tiers/v1/status`. Add error logging if the tier status check fails.

---

## BUG-004: `sites deploy` positional syntax removed without docs update (MEDIUM)

**Component:** run402 CLI — `cli/lib/sites.mjs`
**Severity:** MEDIUM — breaks documented workflow

**What was attempted:**
Agent ran `npx run402 sites deploy <project_id> index.html` as documented in bld402 agent instructions.

**What happened:**
CLI rejected the positional arguments. The command now requires `--manifest <file>` flag pointing to a JSON manifest:
```json
{
  "files": [
    {"file": "index.html", "path": "./templates/utility/shared-todo/index.html"}
  ]
}
```

**Why this is a bug:**
1. The positional syntax `sites deploy <id> <file>` was the documented interface
2. bld402 templates, agent instructions, and step pages all reference this syntax
3. The change was made without updating docs or providing a deprecation warning
4. Agents following the documented workflow hit an immediate error

**Fix:** Either:
- Restore the simple `sites deploy <id> <file>` positional syntax (preferred — simpler for agents)
- Or update all documentation: README, SKILL.md, llms.txt, and notify downstream consumers (bld402)

**Workaround (applied in bld402 tests):** Create a temporary manifest JSON file before calling `sites deploy`.

---

## BUG-005: `projects query` subcommand doesn't exist (LOW)

**Component:** run402 CLI
**Severity:** LOW — naming mismatch

**What was attempted:**
Agent ran `npx run402 projects query <project_id> todos` to query data via the REST API.

**What happened:**
CLI returned "Unknown subcommand: query". The correct command is `npx run402 projects rest <project_id> <table>`.

**Why this is a bug:**
The bld402 agent instructions and run402 documentation reference `projects query` which doesn't exist. The actual command is `projects rest`. This is either a rename that wasn't propagated to docs, or a naming inconsistency.

**Fix:** Either:
- Add `query` as an alias for `rest` (preferred — both names make sense)
- Or update all documentation to reference `projects rest`

---

## BUG-006: MCP `set_tier` fails x402 payment handshake (HIGH)

**Component:** run402-mcp — `set_tier` tool
**Severity:** HIGH — blocks tier operations from MCP

**What was attempted:**
MCP agent called `set_tier` tool with `tier=prototype` and `network=base-sepolia`.

**What happened:**
The tool returned an HTTP 402 response. The x402 payment-required header was present and correctly formatted, but the MCP server's `setupPaidFetch` function did not complete the signing loop. The raw 402 was returned to the agent instead of being handled internally.

**Why this is a bug:**
1. The entire point of run402-mcp is to handle x402 payments transparently
2. The `set_tier` tool should negotiate the payment, sign it, and retry — returning the final success response
3. Instead, the agent receives a raw 402 which it cannot act on
4. This blocks ALL tier operations from MCP-connected agents

**Root cause hypothesis:** The `setupPaidFetch` function in run402-mcp likely throws or silences a sub-error during ERC-712 signing or network timeout, and falls back to returning the raw 402 response instead of retrying.

**Workaround (applied in bld402 MCP tests):** The MCP test agent manually constructed the x402 payment using `@x402/fetch` + `@x402/evm` libraries, bypassing the MCP tool's built-in payment handling.

**Fix:** Debug `setupPaidFetch` in the MCP server source. Ensure the x402 payment flow completes: receive 402 → extract payment requirements → sign payment → retry with `X-402-Payment` header → return success response.

---

## BUG-007: RLS via raw SQL insufficient — GRANT blocked (MEDIUM)

**Component:** run402 gateway — SQL endpoint + RLS endpoint
**Severity:** MEDIUM — confusing behavior, workaround exists

**What was attempted:**
Agent ran raw SQL to set up RLS:
```sql
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_write" ON todos FOR ALL USING (true) WITH CHECK (true);
```

**What happened:**
The policies were created, but the REST API returned "permission denied for table todos" when querying with the anon key. The `anon` role was not granted access.

The agent then tried:
```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO anon;
```
But the gateway blocked the `GRANT` statement (security measure — raw GRANT is not allowed).

**Why this is a bug (or docs gap):**
1. The RLS template files (`rls.json`) in bld402 only describe policies, not grants
2. An agent following the template would create policies but miss the grants
3. The dedicated RLS endpoint (`POST /projects/v1/admin/:id/rls`) and CLI command (`projects rls`) handle both policies AND grants correctly
4. But this is not documented — agents don't know they must use the dedicated endpoint instead of raw SQL

**Fix:**
1. Document clearly in llms.txt and SKILL.md: "Always use the RLS endpoint/tool — never raw SQL for RLS setup"
2. Consider: if `CREATE POLICY` is detected in raw SQL, return a warning suggesting the RLS endpoint instead
3. Update bld402 template `rls.json` files to note: "Apply via `projects rls` command or `setup_rls` MCP tool — not raw SQL"

**Workaround:** Use `npx run402 projects rls <id> public_read_write '[{"table":"todos"}]'` (CLI) or `setup_rls` MCP tool instead of raw SQL.

---

## Summary

| Bug | Severity | Component | Status |
|-----|----------|-----------|--------|
| BUG-001 | HIGH | Gateway (SQL endpoint) | Open |
| BUG-002 | LOW | CLI (tier.mjs) | Open |
| BUG-003 | LOW | CLI (init.mjs) | Open |
| BUG-004 | MEDIUM | CLI (sites.mjs) | Open |
| BUG-005 | LOW | CLI (naming) | Open |
| BUG-006 | HIGH | run402-mcp (set_tier) | Open |
| BUG-007 | MEDIUM | Gateway + Docs | Open |

**Priority order for fixing:** BUG-001 > BUG-006 > BUG-004 > BUG-007 > BUG-002 > BUG-003 > BUG-005
