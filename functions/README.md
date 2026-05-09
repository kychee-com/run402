# @run402/functions

In-function helper library for [Run402](https://run402.com) serverless functions. Imported _inside_ a deployed function — gives you typed access to the caller's database (RLS-respecting) and the project's admin database, the caller's auth, the project's mailbox, and AI helpers.

```ts
import { db, adminDb, getUser, email, ai } from "@run402/functions";

export default async (req: Request) => {
  const user = await getUser(req);
  if (!user) return new Response("unauthorized", { status: 401 });

  const mine = await db(req).from("items").select("*").eq("user_id", user.id);
  return Response.json(mine);
};
```

This package is **auto-bundled into every deployed function zip at deploy time** — you don't need to declare it in `--deps`. Install it locally only when you want **TypeScript autocomplete** in your editor while authoring function code.

## Install (local autocomplete)

```bash
npm install @run402/functions
```

## The two DB clients

The most important distinction in this library: **`db(req)` runs as the caller, `adminDb()` bypasses RLS.**

### `db(req).from(table)` — caller-context

Forwards the request's `Authorization` header to PostgREST. Row-Level Security policies evaluate against the caller's role — `anon`, `authenticated`, `project_admin`, or whatever the JWT carries. **This is the default choice.** Routes to `/rest/v1/*`.

```ts
// Reads everything the caller is authorized to see — could be 0 rows for unauthenticated callers.
const mine = await db(req).from("items").select("title, done").eq("user_id", user.id);

// Writes go through RLS too. If the policy says the caller can't insert, it errors.
const [created] = await db(req).from("items").insert({ title: "New", done: false });
```

### `adminDb().from(table)` — bypass RLS

Uses the project's `service_key`. Returns *all* rows regardless of RLS. Routes to `/admin/v1/rest/*` (the gateway rejects `role=service_role` on `/rest/v1/*`, so bypass traffic lives on its own surface).

Use only when the function acts on behalf of the **platform**, not the **caller** — audit logs, cron cleanup, webhook handlers, fan-out writes after a Stripe event.

```ts
// Audit log — capture every event regardless of who triggered the function.
await adminDb().from("audit_log").insert({ event: "payment.succeeded", user_id: userId });

// Cron cleanup — there's no caller to evaluate RLS against.
await adminDb()
  .from("sessions")
  .delete()
  .lt("expires_at", new Date().toISOString());
```

### Fluent surface (same on both clients)

```ts
.select(cols?)
.eq(col, val) / .neq() / .gt() / .lt() / .gte() / .lte()
.like(col, pattern) / .ilike(col, pattern)
.in(col, [vals])
.order(col, { ascending? })
.limit(n) / .offset(n)

// Writes return arrays of affected rows.
.insert(obj | obj[])
.update(obj)        // chain with .eq() to scope
.delete()           // chain with .eq() to scope

// Column narrowing on writes:
.insert({ title: "x" }).select("id, title")
```

### `adminDb().sql(query, params?)` — raw SQL, always BYPASSRLS

```ts
const { rows, rowCount } = await adminDb().sql(
  "SELECT count(*)::int AS n FROM items WHERE user_id = $1",
  [userId],
);
// { status: "ok", schema: "p0001", rows: [{ n: 42 }], rowCount: 1 }
```

For SELECT, `rows` is the result set and `rowCount` is the row count. For INSERT/UPDATE/DELETE, `rows` is `[]` and `rowCount` is the affected count.

## `getUser(req)` — caller identity

Verifies the caller's JWT and returns the user, or `null` for unauthenticated requests.

```ts
const user = await getUser(req);
if (!user) return new Response("unauthorized", { status: 401 });
// user: { id: string, email: string, role: "authenticated" | "project_admin" | ... }
```

The function's own `RUN402_PROJECT_ID` is used to scope the verification.

## `email.send(...)` — send mail from the project's mailbox

Auto-discovers the project's mailbox on first call (the project must already have one — create it once with `run402 email create <slug>` or the `create_mailbox` MCP tool). After that the mailbox id is cached for the function's lifetime.

```ts
// Template mode
await email.send({
  to: "user@example.com",
  template: "notification",
  variables: { project_name: "My App", message: "Hello!" },
});

// Raw HTML mode
await email.send({
  to: "user@example.com",
  subject: "Welcome!",
  html: "<h1>Hi</h1>",
  from_name: "My App",
});
```

Templates: `project_invite` (`project_name`, `invite_url`), `magic_link` (`project_name`, `link_url`, `expires_in`), `notification` (`project_name`, `message` ≤ 500 chars). Throws on rate limit, suppression, or no-mailbox.

## `ai.translate` / `ai.moderate`

```ts
const { text, from } = await ai.translate("Hello world", {
  to: "es",
  context: "marketing tagline",
});

const { flagged, categories } = await ai.moderate("Some user-generated text");
```

Translation requires the AI Translation add-on on the project; moderation is free for all projects.

## Static-site generation (build-time use)

The same library works at build time for static-site generation if you set `RUN402_SERVICE_KEY` and `RUN402_PROJECT_ID` in your `.env`:

```ts
// build-time render — feed the page with current data
const items = await adminDb().from("items").select("title, slug").order("created_at", { ascending: false });
```

Use `adminDb()` (not `db(req)`) here — there's no incoming request to forward.

## Routed HTTP functions

Deploy-v2 web routes can map public same-origin browser paths to functions, for example `routes.replace` / `"routes": { "replace": [{ "pattern": "/api/*", "target": { "type": "function", "name": "api" } }] }`. Use exact `/admin` plus final-wildcard `/admin/*` when a dynamic section root and its children should route to the same function. A browser request to a routed path does **not** need a Run402 API key at the public edge. Direct `/functions/v1/:name` invocation is unchanged: it remains API-key protected and API-shaped.

Routed browser traffic invokes the same Node 22 Fetch Request -> Response handler used by direct functions:

```ts
export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "https://app.example.com",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
      },
    });
  }

  if (req.method === "POST" && !req.headers.has("x-csrf-token")) {
    return Response.json({ error: "csrf_required" }, { status: 403 });
  }

  const headers = new Headers({ "cache-control": "private, no-store" });
  headers.append("Set-Cookie", "sid=abc; HttpOnly; Secure; SameSite=Lax; Path=/");
  headers.append("Set-Cookie", "theme=dark; Secure; SameSite=Lax; Path=/");
  return Response.json({ ok: true, path: url.pathname, query: url.search }, { headers });
}
```

Request fields:
- `req.method` is the original browser method. `GET` routes also match `HEAD`; `HEAD` reaches the handler as `HEAD`.
- `req.url` is the full public URL, including scheme, host, path, and query, on managed subdomains, deployment hosts, and verified custom domains. Derive OAuth callback URLs from `new URL(req.url).origin`.
- `req.headers` is a Fetch `Headers` object. Cookie data is available through the `cookie` header.
- `await req.text()`, `await req.json()`, and `await req.arrayBuffer()` read the buffered request body, capped at 6 MiB.

Response behavior:
- Return a Web `Response` with status 200 through 599 except `101 Switching Protocols`.
- Append each cookie with `headers.append("Set-Cookie", value)`; Run402 preserves multiple `Set-Cookie` values as separate browser headers.
- Redirects are ordinary 3xx responses with a `Location` header. `HEAD` responses send headers without body bytes.
- Request and response bodies are capped at 6 MiB. WebSockets, `101 Switching Protocols`, streaming, and SSE are not supported in Phase 1.

Limits and defaults: Run402 does not add wildcard CORS. Run402 does not store routed dynamic responses in a shared cache; if your function sets no `Cache-Control`, the gateway adds `Cache-Control: private, no-store` and `x-run402-cache: dynamic-bypass`.

Security notes: application auth, authorization, sessions, OAuth callbacks, CORS, and CSRF belong in your function code. For cookie-authenticated `POST`, `PUT`, `PATCH`, or `DELETE`, validate a CSRF token or an equivalent same-site defense. Do not trust spoofable forwarding headers for authorization.

The raw `run402.routed_http.v1` envelope is an internal gateway transport. Low-level `routedHttp` helpers and `RoutedHttpRequestV1` / `RoutedHttpResponseV1` types remain exported for tests and gateway-adjacent utilities, but browser route handlers should use Fetch `Request` and `Response`.

Runtime route failure codes to branch on: `ROUTE_MANIFEST_LOAD_FAILED` (manifest/propagation), `ROUTED_INVOKE_WORKER_SECRET_MISSING` (custom-domain Worker secret), `ROUTED_INVOKE_AUTH_FAILED` (internal invoke signature), `ROUTED_ROUTE_STALE` (selected route failed release revalidation), `ROUTE_METHOD_NOT_ALLOWED` (method mismatch), and `ROUTED_RESPONSE_TOO_LARGE` (body over 6 MiB).

## Imports auto-resolved

Inside a deployed function you can `import { ... } from "@run402/functions"` directly — the gateway bundles this library plus any `--deps` you declared at deploy time. **Do not list `@run402/functions` in your `--deps`** — it's rejected. Native binary modules (`sharp`, `canvas`, native `bcrypt`, etc.) are also rejected.

The bundled version lands in the deploy response's `runtime_version` field; resolved `--deps` versions land in `deps_resolved`.

## Errors

All helpers throw on non-2xx responses. The error message includes the HTTP status and the response body so you can branch on `code` / `category` / `retryable` (the v1.34+ agent-operable error envelope).

## Engines

Node 22 in deployed functions. `>=18` for local use (autocomplete and SSG).

## Other interfaces

`@run402/functions` is one of five surfaces in the [run402](https://github.com/kychee-com/run402) monorepo:

- **`@run402/functions`** (this) — in-function helper, auto-bundled
- [`@run402/sdk`](https://www.npmjs.com/package/@run402/sdk) — typed TypeScript client for the platform API
- [`run402`](https://www.npmjs.com/package/run402) — the CLI
- [`run402-mcp`](https://www.npmjs.com/package/run402-mcp) — MCP server for Claude Desktop / Cursor / Cline / Claude Code
- OpenClaw skill — script-based skill for OpenClaw agents

All five release in lockstep at the same version.

## Links

- Run402: <https://run402.com>
- HTTP API reference: <https://run402.com/llms.txt>
- CLI reference: <https://run402.com/llms-cli.txt>

## License

MIT
