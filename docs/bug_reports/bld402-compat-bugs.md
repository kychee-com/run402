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

**Fix (recommended):** Add `--file` flag to `projects sql` so the CLI reads SQL from a file instead of a command-line argument. This avoids all shell escaping issues on every platform:
```bash
npx run402 projects sql <id> --file schema.sql
```
Also consider stdin support:
```bash
cat schema.sql | npx run402 projects sql <id> --stdin
```

**Windows compatibility note:** This bug affects ALL multiline SQL with `--` comment lines on Windows. The `--` may be interpreted as an end-of-options marker by the shell or Node.js argument parser. The `--file` flag would eliminate this entire class of issues.

**Workaround (applied in bld402 tests):** Strip all comment lines from SQL and flatten to single line before passing as CLI argument.

**Investigation (2026-03-20):** Unable to reproduce on Linux/Mac. Traced the full request lifecycle: CLI sends correct UTF-8 via fetch (Content-Length matches byte length), express.text() decodes correctly, node-pg serializes correctly. End-to-end test confirms em-dash survives the entire chain intact. Likely a PostgREST schema cache timing issue misattributed to the em-dash.

**Re-test (2026-03-20, Windows 11 / Git Bash):** REPRODUCED. The issue is NOT the em-dash — it's multiline SQL passed as a CLI argument on Windows. ANY SQL with `--` comment lines (even ASCII-only) silently fails when passed as `npx run402 projects sql <id> "multiline\nSQL"`. Single-line SQL without comments works. Multiline SQL without comments also works. SQL starting with `--` comment line silently returns `status: ok` but executes nothing. This appears to be a Windows-specific argument parsing issue in the CLI — the server endpoint works fine (Gate 2 tests pass via raw HTTP with the same SQL).

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
| BUG-001 | HIGH | CLI (Windows arg parsing) | Reproduced on Windows — SQL with comment lines silently no-ops |
| BUG-002 | LOW | CLI (tier.mjs) | Fixed |
| BUG-003 | LOW | CLI (init.mjs) | Fixed |
| BUG-004 | MEDIUM | CLI (sites.mjs) | Not a bug |
| BUG-005 | LOW | CLI (naming) | Not a bug |
| BUG-006 | HIGH | run402-mcp (set_tier) | Not a bug |
| BUG-007 | MEDIUM | Gateway + Docs | Not a bug |

### Investigation Notes (2026-03-20)

**BUG-001 — Reproduced on Windows.** Originally could not reproduce on Linux/Mac. Re-tested on Windows 11 (Git Bash): SQL with `--` comment lines passed as CLI argument silently fails — returns `status: ok` but no DDL is executed. Single-line SQL works. The server endpoint itself is fine (Gate 2 raw HTTP tests pass). Root cause is Windows-specific CLI argument parsing — likely newlines or `--` comment prefix being interpreted by the shell or Node.js argument parser on Windows.

**BUG-002 — Fixed.** Reproduced: `res.json()` throws `SyntaxError` when the response body is HTML (e.g. from ALB 502 or x402 facilitator error). CLI crashes with unhandled error. Fix: read body as text first, then safely parse JSON.

**BUG-003 — Fixed.** Reproduced: `init.mjs` checks `tierInfo.status === "active"` but the API returns `{ active: true }` (boolean field, not a `status` string). The condition is always false, so init always shows "Tier: (none)". Fix: changed to `tierInfo.active`.

**BUG-004 — Not a bug.** The `--manifest` flag is the intended interface. The positional syntax `sites deploy <id> <file>` never existed in the current CLI — bld402 agent instructions referenced a syntax that was never implemented. This is a docs mismatch on the bld402 side, not a regression.

**BUG-005 — Not a bug.** The command is `projects rest`, not `projects query`. The CLI documents `rest` in its help text. bld402 expected `query` to exist as an alias — that's a naming preference, not a missing feature.

**BUG-006 — Not a bug.** The MCP server is designed to return 402 payment details as informational text so the LLM can reason about payment flow. It deliberately does not handle x402 signing internally — the MCP server has no x402 payment dependencies (`@x402/fetch`, `viem` are devDependencies only). bld402 expected automatic payment handling, which is an architecture disagreement, not a bug.

**BUG-007 — Not a bug.** `GRANT` is intentionally blocked in the SQL endpoint as a security measure. The dedicated RLS endpoint (`POST /admin/:id/rls`) exists specifically to handle both policies and grants. This is working as designed. A docs improvement (pointing agents to the RLS endpoint) would help, but the behavior itself is correct.

---

## Red Team Findings (2026-03-21)

Found during red team testing where a fresh agent follows only bld402.com/llms.txt instructions.

### GAP-001: Serverless function invocation broken — HTTP 500, no logs (HIGH)

**Component:** run402 gateway — function invocation
**Severity:** HIGH — blocks all function-based templates (paste-locker, secret-santa)

**What was attempted:** Agent deployed a function via `deploy_function`. Function appeared in `list_functions` with status "deployed". Agent called `invoke_function`.

**What happened:** Every invocation returns `HTTP 500 "Internal function error"` with zero CloudWatch logs. Reproduced with a trivial hello-world function: `export default async function(req) { return new Response("hello"); }`

**Impact:** Blocks 2 of 13 bld402 templates. Function deploys successfully — failure is silent and only discovered at invocation time.

**Fix:** Debug the gateway's function invocation path. Functions deploy and list correctly but never execute.

### GAP-002: Subdomain 403 error message misleading (LOW)

**Component:** run402 gateway — subdomains endpoint

**What happened:** When a subdomain is claimed by another wallet, the error says "expired lease" instead of "claimed by another wallet."

**Fix:** Return accurate error: "Subdomain X is already claimed by another wallet."

### GAP-003: `get_function_logs` always returns empty (LOW)

**Component:** run402-mcp — get_function_logs tool

**What happened:** Even after function invocations (including 500 errors), logs are empty. Agents cannot debug failures.

**Fix:** Ensure CloudWatch logs are correctly routed and queryable.

### GAP-004: `set_secret` requires redeploy — undocumented (INFO)

**Component:** Documentation

**What happened:** Secrets set via `set_secret` are not available until function is redeployed. Not documented.

**Fix:** Add to llms.txt/SKILL.md: "After setting secrets, redeploy the function."

### Updated Summary

| ID | Severity | Component | Status |
|-----|----------|-----------|--------|
| BUG-001 | HIGH | CLI (Windows) | Fixed in v1.18.0 (--file flag) |
| BUG-002 | LOW | CLI (tier.mjs) | Fixed |
| BUG-003 | LOW | CLI (init.mjs) | Fixed |
| BUG-004 | — | CLI (sites.mjs) | Not a bug |
| BUG-005 | — | CLI (naming) | Not a bug |
| BUG-006 | — | run402-mcp | Not a bug (MCP parity in v1.18.0) |
| BUG-007 | — | Gateway + Docs | Not a bug |
| GAP-001 | **HIGH** | Gateway (functions) | **Open — blocks paste-locker, secret-santa** |
| GAP-002 | LOW | Gateway (subdomains) | Open |
| GAP-003 | LOW | run402-mcp (logs) | Open |
| GAP-004 | INFO | Documentation | Open |
