---
title: "Functions, secrets, jobs"
description: "Command reference for serverless functions, secrets, and managed jobs."
order: 6
slice: functions
summary: "functions (deploy, invoke, runs, logs), secrets, jobs"
---

### functions
Node 22 runtime. Must export `default async (req: Request) => Response`.
Built-in helper: `import { auth, db, adminDb, email, ai, assets, getRoutedPaymentContext } from '@run402/functions'`
- `auth.user()` — `Actor | null`; taints cache bypass. `Actor` = `{ id, projectId, sessionId, email, emailVerified, authTime, amr, amrTimes }`; `id`, not `userId`. Hallucinated names (`getUser`, `getSession`, `currentUser`, `getServerSession`, `auth.protect`, `auth.signIn`, `auth.logout`, …) throw `R402_AUTH_UNKNOWN_EXPORT` and fail `run402 doctor` deploy scan.
- `auth.requireUser()` — `Actor`. 303 → `/auth/sign-in?returnTo=` (HTML) or 401 envelope (JSON) on anonymous. Don't catch — the platform handles redirect-vs-envelope automatically.
- `auth.requireRole<const R>(role: R)` / `auth.requireMembership<const M>(m: M)` — gate helpers; imply `requireUser`; return `{ user, role }` / `{ user, membership }`. Always read fresh server-side grant state (no positive cache, so revocation is instant across tasks).
- `auth.requireFresh({ maxAge, amr? })` — per-AMR step-up. Reads `Actor.amrTimes`; a recent password proof does NOT satisfy `{amr: ["passkey"]}`.
- `auth.fetch(input, init?)` — same-origin-only fetch with synchronous URL validation; `redirect: "manual"` default; never forwards cookies or actor headers across origin hops.
- `auth.csrfToken()` / `auth.csrfField()` — double-submit token for hosted forms (renders `<input type="hidden" name="_csrf" value="...">`).
- `auth.sessions.createResponseFromIdentity({ provider, subject, proof, amr, createUser? })` — custom identity proof bridge. Platform verifies the proof end-to-end; raw-userId session minting is NOT in the public API.
- `auth.sessions.endResponse()` — sign-out: revokes the active session row + returns Set-Cookie clear.
- `auth.identities.link({ provider, subject, proof })` — atomic nonce consumption + identity INSERT; 409 R402_AUTH_IDENTITY_LINK_CONFLICT on duplicate.
- `db(req?)` — caller-context DB client. In SSR with verified actor, mints 60s actor JWT (`sub`, `project_id`, `session_id`, `authz_version`) so `run402.current_user_id()` works in RLS. Routes `/rest/v1/*`. Default choice; RLS handles current-user filters. `.eq("user_id", user.id)` deploy-fails with `R402_AUTH_REDUNDANT_USER_FILTER` unless annotated `// run402-allow-user-filter:`.
- `adminDb()` — BYPASSRLS using `service_key`; routes `/projects/v1/:project_id/rest/*`, and `adminDb().sql()` routes `/projects/v1/:project_id/sql` (gateway rejects `role=service_role` on `/rest/v1/*`). In a handler that reads the current user, `run402 doctor` flags it (`SERVICE_KEY_IN_USER_REQUEST`): use `db(req)` there. Use only when function acts as platform: audit logs, webhooks, cron cleanup.
- `getUserId(req)` / `getRole(req)` — function-level gate header readers (`x-run402-user-id` / `x-run402-user-role`), distinct from `auth.*` cookie sessions. Not exported: importing either from `@run402/functions` throws `R402_AUTH_UNKNOWN_EXPORT`. Use `auth.*` or read headers manually.
- `getRoutedPaymentContext(req)` (`@run402/functions` 3.7+) — confirmed x402 payment context for priced routed function requests. Returns `{ scheme, paymentId, amountUsdMicros, payer, network, asset, payTo, transaction, settledAt }` or `null`; key app-side idempotency by `payment.paymentId`.
- `email.send(opts)` — send email from the project's mailbox (see email section below)
- `ai.generateImage({ prompt, aspect? })` — live image generation from deployed functions using project billing authority, not local wallet/x402 signing. Aspects: `square`, `landscape`, `portrait`; result: `{ image, content_type, aspect }`. Add app auth/rate limits before calling it from public routed functions.
- `assets.put(key, source, opts?)` — upload bytes to the project's asset store from inside a deployed function. (`opts.contentType` is a JS option and stays camelCase; every WIRE field — manifests, plan/commit bodies — is snake_case: `content_type`.) Uses the same CAS substrate as deploy-time assets. `source` is a string, `Uint8Array`, or `{ content | bytes }` object. Options: `contentType`, `visibility` (`"public"` | `"private"`, default `"public"`), `immutable` (default `true`). Returns an `AssetRef` with `url`, `immutableUrl`, `cdnUrl`, `sha256`, `size_bytes`, etc. (camelCase aliases included). Use for user-uploaded content, generated images, runtime-produced files.
- `assets.fromRef(raw)` — local rehydrate stored AssetRef JSONB into typed shape with camelCase aliases + variants. Store full `AssetRef` from `r.assets.put` in JSONB; variant SHAs/immutable URLs cannot be re-derived from `(source_sha,key)`. Tolerates partial legacy inputs; throws only on null/undefined/non-object.
- `getRun402Context(req)` — reads `x-run402-*` context headers across `Request`/`Headers`/plain objects. Returns `{ requestId, projectId, releaseId, host, locale, defaultLocale }` (`string|null`), same as `Astro.locals.run402`; never throws.

TypeScript types: `npm install @run402/functions@^3.7` to get full autocomplete for the `auth.*` namespace, `db(req?)`, `adminDb()`, `getRun402Context()`, `getRoutedPaymentContext()`, `email.send()`, `ai.translate()`, `ai.generateImage()`, `assets.put()`, and `assets.fromRef()`. Works in any Node.js/TypeScript project (Astro, Next.js, plain TS). For static site generation, use `adminDb().from()` at build time with `RUN402_SERVICE_KEY` + `RUN402_PROJECT_ID` in your `.env`.

#### db(req).from(table) — caller-context, RLS applies

PostgREST-style queries scoped to the caller's JWT role. Returns a plain array of row objects. Unauthenticated callers resolve to `role=anon` and see only what anon policies allow.

Reads:
- `.select(cols?)` — columns to return (default `"*"`)
- `.eq(col, val)`, `.neq()`, `.gt()`, `.lt()`, `.gte()`, `.lte()` — filters
- `.like(col, pattern)`, `.ilike(col, pattern)` — pattern match
- `.in(col, [values])` — IN clause
- `.order(col, { ascending? })` — sort (default ascending)
- `.limit(n)`, `.offset(n)` — pagination

```
export default async (req: Request) => {
  // Runs with the caller's JWT — RLS decides what they see.
  const myItems = await db(req).from('items').select('title, done').limit(10);
  return new Response(JSON.stringify(myItems), { headers: { 'content-type': 'application/json' } });
};
```

Writes (also return an array of affected rows):
- `.insert(obj | obj[])` — insert one or many rows
- `.update(obj)` — update matched rows (combine with `.eq()`)
- `.delete()` — delete matched rows (combine with `.eq()`)

```
// All three run as the caller — RLS policies decide if the write is allowed.
const created = await db(req).from('items').insert({ title: 'New', done: false });
await db(req).from('items').update({ done: true }).eq('id', 1);
await db(req).from('items').delete().eq('id', 1);
```

Column narrowing works with writes: `.insert({...}).select('id, title')` returns only those columns.

#### adminDb().from(table) — BYPASSRLS, opt-in

Identical fluent surface to `db(req).from(...)` but uses the service_key. Returns all rows regardless of RLS. Use for server-side work where the function itself is the principal.

```
// Audit log — must capture every event regardless of who called the function.
await adminDb().from('audit_log').insert({ event: 'payment_succeeded', user_id: userId });

// Cron cleanup — no caller context.
await adminDb().from('sessions').delete().lt('expires_at', new Date().toISOString());
```

#### adminDb().sql(query, params?) — raw SQL, always BYPASSRLS

Returns `{ status, schema, rows, row_count, fields }` (typed as `AdminSqlResult` in `@run402/functions` 3.10+). Field names are snake_case — the wire contract, NOT camelCase (`rowCount` was a docs error; it never existed at runtime).
- SELECT: `rows` = matching rows, `row_count` = row count
- INSERT/UPDATE/DELETE: `rows` = `[]`, `row_count` = affected rows
- INSERT/UPDATE/DELETE with `RETURNING`: `rows` = the returned rows
- `fields` = column metadata: `[{ name, type }]` (Postgres type names, e.g. `int4`, `timestamptz`)
- Parameterized: `adminDb().sql('SELECT * FROM t WHERE id = $1', [42])`

```
const result = await adminDb().sql('SELECT * FROM users WHERE active = true');
// { status: "ok", schema: "p0001", rows: [{ id: 1, name: "Alice" }], row_count: 1,
//   fields: [{ name: "id", type: "int4" }, { name: "name", type: "text" }] }
const rows = result.rows;
```

`db` is a request-scoped function. Use `db(req).from(...)` for caller-context RLS or `adminDb().from(...)` / `adminDb().sql(...)` for service-key work.

#### Calling functions from the browser

Functions are accessible via HTTP at `https://api.run402.com/functions/v1/<name>`. This direct invoke path remains API-key protected even when apply-v1 web routes expose browser paths to the same function. Use the project's `anon_key` as the `apikey` header. For authenticated calls, also pass the user's `access_token`:

```javascript
const res = await fetch('https://api.run402.com/functions/v1/my-function', {
  method: 'POST',
  headers: {
    apikey: ANON_KEY,
    Authorization: 'Bearer ' + session.access_token,  // optional, for authenticated calls
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ key: 'value' })
});
```

- `run402 functions deploy <project_id> <name> --file <file> [--deps "<spec,...>"] [--timeout <s>] [--memory <mb>]` — for triggered background work, prefer `run402 deploy --manifest` with `functions.replace.<name>.triggers[]` so schedule ticks and email events create durable function runs.
- `run402 functions invoke <name> --project <project_id> [--body '<json>' | --body-file <path>] [--method <GET|POST|...>] [--idempotency-key <key>] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--raw]` — inline and file bodies must contain valid JSON; invalid, empty, or shell-corrupted input fails locally before the function runs. Prefer `--body-file` for agents and Windows `cmd.exe` so the shell cannot rewrite JSON quotes. The legacy positional form `invoke <project_id> <name>` remains supported. Default output is `{ http_status, body, duration_ms }` (HTTP status surfaced as `http_status` to avoid colliding with the reserved top-level `status` sentinel on stderr). Paid functions require a stable `--idempotency-key`; reuse it for the same paid intent. Without `--wait`, an in-progress paid call returns `http_status: 202` with `run_id`/`operation_id` and `next_actions[]`. With `--wait`, the CLI polls that run and replays the same key for the retained result. `--raw` skips the envelope: string body → text + newline, JSON body → pretty-printed JSON.
- `run402 functions logs [<name>] [--project <project_id>] [--tail <n>] [--since <iso-timestamp>] [--request-id <req_...|fnrun_...|fnatt_...>] [--app|--platform|--all] [--follow]` — `<name>` is optional when `--request-id` is given: the search then covers every function in the project (the output gains `request_id`, `scanned`, `errors?`, and each entry carries its `function`). App output only by default (`--app`); `--platform` shows only the Lambda runtime lines (`INIT_START`, `START`/`END`/`REPORT RequestId`), `--all` both. Every entry carries `origin: "app" | "platform"`; `hidden` counts what the filter dropped and `hint` explains an empty result that hid platform lines. `--tail` defaults to 50, is capped at 1000, and bounds the read before the filter. `--follow` still needs `<name>`. Non-follow mode emits a single `{ logs: [...] }` JSON object; `--follow` mode emits **NDJSON** (one log entry per line) so streaming consumers can parse incrementally without a wrapping envelope.
- `run402 functions runs create <project_id> <name> --event-type <type> --idempotency-key <key> [--payload-json <json-object>] [--delay <10m|1h|3d> | --run-at <iso>] [--expires-at <iso> | --expires-after <duration>] [--retry-preset standard] [--max-attempts <n>] [--wait]` — creates a durable function request. The idempotency key is required; reuse it when retrying the same logical work item.
- `run402 functions runs <list|get|logs|cancel|redrive> ...` — list runs by function, fetch one `fnrun_...`, fetch correlated logs, cancel queued/scheduled work, or redrive a terminal run. `redrive` accepts retry options and `--wait`. All outputs are JSON by default.
- `run402 functions update <project_id> <name> [--timeout <s>] [--memory <mb>]` — background triggers are declarative through ReleaseSpec `triggers[]`; the legacy schedule flags remain only for old simple-function surfaces.
- `run402 functions rebuild <project_id> <name>` / `run402 functions rebuild <project_id> --all` — opt-in refresh of a deployed function onto the platform's current runtime/entry-wrapper. Re-bundles from the **stored source** with deps pinned to the recorded exact versions, so the source `code_hash` is unchanged and no new release is created — only the platform wrapper/runtime changes. This is how a gateway-side wrapper fix (e.g. an SSR `auth.*` fix) reaches an already-deployed function: a plain redeploy with unchanged source does **not** pick it up. Single returns `{ name, rebuilt, old_fingerprint, new_fingerprint, runtime_version_before, runtime_version_after, code_hash }`; `--all` returns `{ rebuilt_count, total, results: [...] }` where each result is a rebuild record or `{ name, rebuilt: false, code?, error }`. Functions deployed before dependency locking return `CANNOT_REBUILD_UNLOCKED_DEPS` (HTTP 409 for single, a per-function entry for `--all`) — redeploy them from source instead. Wallet-authed; allowed during billing grace (`past_due` / `frozen` / `dormant`).
- `run402 functions <list|delete> <project_id> [<name>]`

`run402 doctor` surfaces a `runtime_staleness` check (warning) listing any deployed functions on an older platform runtime, with the `run402 functions rebuild --all` remediation. Staleness is read-only — observing it never mutates a function.

For routed browser 500s, copy `X-Run402-Request-Id` or the JSON `request_id` from the response and run `run402 functions logs <project> <function> --request-id req_...`. `--since` is validated locally and should be supplied for incidents older than the default recent lookup window.
For durable runs, pass the run id or attempt id as the same filter: `--request-id fnrun_...` or `--request-id fnatt_...`.
`--tail` must be a positive safe integer no larger than 1000, and `--request-id` must match `req_...`, `fnrun_...`, or `fnatt_...`.

#### --deps semantics, runtime_version, deps_resolved

`--deps` is a comma-separated list of npm specs that the gateway installs and bundles into the function zip alongside the user code:
- Bare names (`lodash`) resolve to the latest published version at deploy time.
- Pinned (`lodash@4.17.21`) and range (`date-fns@^3.6.0`) specs are honored verbatim.
- Entries are trimmed; empty entries e.g. `--deps "lodash,,date-fns"` are rejected locally.
- `@run402/functions` (auto-bundled) and the legacy `run402-functions` name are rejected.
- Limits: max 30 entries, max 200 chars per spec.
- Native binary modules (sharp, canvas, native bcrypt, etc.) are rejected.

`run402 functions deploy` routes through the unified apply engine, so its **result** sets `runtime_version` and `deps_resolved` to `null` (apply returns release-level data, not per-function build metadata). Read the resolved values from `run402 functions list` (and `update`). Function-list JSON carries the recorded, current, and guaranteed-minimum injected-runtime versions so agents can decide whether a deployed function has the helper surface they need:
- `runtime_version` — the bundled `@run402/functions` version (e.g. `"1.48.0"`). Surface this as "Functions runtime version" — never bare "runtime", which already names the Node runtime (e.g. `node22`). `null` for legacy functions.
- `runtime_current_version` — the version the gateway injects into new releases; nullable only when the gateway cannot resolve its installed package version.
- `runtime_minimum_version` — the minimum injected helper version guaranteed by the platform. The current `3.7.0` floor includes `getRoutedPaymentContext()` for priced routes.
- `runtime_stale` — whether the deployed bundle predates the current gateway wrapper/runtime. Use `run402 functions rebuild <project_id> <name>` (or `--all`) to refresh it; a plain unchanged-source redeploy does not.
- `deps_resolved` — map of each `--deps` name to the -installed concrete version (e.g. `{"date-fns": "3.7.0"}` for a `^3.6.0` spec). Direct deps only; this is not a lockfile. `{}` for an empty `--deps`; `null` for legacy functions.

The deploy result still includes an optional top-level `warnings: string[]` (sibling to the function record, not inside it) for non-fatal deploy notes e.g. bundle-size advisories. Omitted or `[]` when there are no warnings.

#### Function authoring limits by tier

| | Prototype | Hobby | Team |
|---|---|---|---|
| Max timeout | 10s | 30s | 60s |
| Max memory | 128 MB | 256 MB | 512 MB |
| Max scheduled triggers | 1 | 3 | 10 |
| Min interval | 15 min | 5 min | 1 min |

`run402 deploy` preflights literal unified-deploy function specs against these caps before plan/upload when the values are known. Gateway validation remains authoritative; `run402 tier status` includes live function caps and current scheduled usage when returned.

Secrets available as `process.env` (see secrets below).

#### Make a function an MCP tool
Every app is an MCP server at `https://<host>/_run402/mcp`. Export a literal `tool` next to the handler and give the function exactly one exact route that accepts POST:
```ts
import type { ToolDeclaration } from "@run402/functions";
export const tool = {
  description: "Cancel one of the caller's bookings.",
  input: { type: "object", properties: { booking_id: { type: "string" } }, required: ["booking_id"] },
} satisfies ToolDeclaration;
export default async (req: Request) => { /* req.json() is the tool arguments */ };
```
A tool call is a POST to that route (header `x-run402-trigger: mcp_tool`), so `requireAuth` / `requireRole`, route prices, and logs apply as for a browser. Tools behind `requireAuth` sign the person in through the app's own hosted sign-in and a consent page; the call then runs as them (`auth.user()`, `db(req)`). The export must be a literal (no variables or calls): the gateway parses it at commit and fails `MCP_TOOL_NOT_STATIC`, `MCP_TOOL_SCHEMA_INVALID`, `MCP_TOOL_ROUTE_MISSING`, `MCP_TOOL_ROUTE_AMBIGUOUS`, or `MCP_TOOL_NAME_INVALID` before any migration runs. After deploy, `urls.mcp` is the connector URL to hand the person.

### secrets
Injected as `process.env` in functions. Values are write-only — `list` returns keys and timestamps only, never values or value-derived hashes. Prefer `--file` or `--stdin` for real values so they do not land in shell history. `--file -` and `--file /dev/stdin` read stdin too.

- `run402 secrets set <project_id> <KEY> [<VALUE>] [--file <path>|--stdin]`
- `run402 secrets <list|delete> <project_id> [<KEY>]`

### jobs
Platform-managed jobs. This is not arbitrary Docker execution: submit a gateway-shaped request for a run402-configured `job_type`, then inspect status/logs, cancel one run, or purge all project runs. The SDK supplies the required idempotency header; the CLI does not expose it.

- `run402 jobs submit --file job.json [--project <project_id>]`
- `run402 jobs submit --stdin [--project <project_id>]`
- `run402 jobs get <job_id> [--project <project_id>]`
- `run402 jobs logs <job_id> [--project <project_id>] [--tail <n>] [--since <iso-timestamp>]`
- `run402 jobs cancel <job_id> [--project <project_id>]`
- `run402 jobs purge [--project <project_id>]`
- `run402 jobs artifacts get <job_id> <file> --output <path> [--project <project_id>]`

Submit request shape:

```json
{
  "job_type": "example.managed_job.v1",
  "input": { "input_json": {} },
  "max_cost_usd_micros": 50000
}
```

Artifacts: when a job completes, `jobs get` returns an `artifacts` map keyed by
filename. Each value is an object — `{ "url", "content_type", "sha256",
"size_bytes" }` — not a bare ref string. `sha256`/`size_bytes` may be absent on older
jobs; the `url` still serves. Download the bytes
with `run402 jobs artifacts get <job_id> <file> --output <path>` (auth is the
project service key, same as the rest of the jobs API). Discover recorded
filenames from the `artifacts` map; a 404 means the job has not completed or
the filename was not recorded for that run.

Due durable runs wait automatically while project concurrency slots are occupied. Waiting does not consume an execution attempt or retry budget. Keep the original run ID and inspect its status; do not cancel and recreate work merely because capacity is busy. Lifecycle and exhausted-quota blocks still require recovery.
