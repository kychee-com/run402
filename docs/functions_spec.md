# Functions Spec — run402

## Summary

Project-scoped serverless functions (Node 22) deployed to AWS Lambda. Single-file TypeScript/JavaScript. Invoked via HTTP at `/functions/v1/:name`. Supabase-compatible URL shape. Free within existing lease quotas.

This is the #1 feature blocking agents from shipping complete apps. Without Functions, agents can't do: Stripe webhooks, external API calls, server-side auth checks, custom business logic, email sending, data transforms, or anything that needs secrets kept off the browser.

---

## Design Decisions (from interview)

| Decision | Choice | Rationale |
|---|---|---|
| Runtime | Node 22 | Agents know Node/TS. Revisit for Deno later. |
| Code model | Single file per function | Simplest for agents. No package.json. |
| Infra | AWS Lambda | Proven, scales to zero, pay-per-invocation. Revisit later. |
| DB access | REST API + built-in `@run402/functions` helper | Agent imports helper; no raw pg connection needed. |
| Invocation | HTTP only (v1) | Cron/events come later. |
| URL shape | `/functions/v1/:name` | Supabase-compatible. Agents already know this. |
| Scoping | Project-scoped (apikey) | Function belongs to a project's DB, secrets, quotas. |
| Handler signature | `export default async (req: Request) => Response` | Web-standard Request/Response. Modern, clean. |
| Secrets access | `process.env.SECRET_NAME` | Injected as env vars. Simple, standard. |
| Limits | Configurable per tier | Prototype: 10s/128MB. Hobby: 30s/256MB. Team: 60s/512MB. |
| Cold starts | Accept Lambda defaults (200-500ms) | Optimize later if users complain. |
| Pricing | Free within lease quotas | Invocations count against API call quota. No per-deploy charge. |
| Function count | Fixed per tier (8/25/100) | Prototype: 8. Hobby: 25. Team: 100. |
| Dependencies | Curated pre-bundled list (10 packages) | Grow based on demand. Agent can also specify deps[]. |
| Deploy flow | Pre-built Lambda layer + code-only deploy | Fast deploys (<2s). Layer rebuilt when curated deps update. |
| Errors | Sanitized error to caller + full logs via get_function_logs | Safe by default. Fully debuggable for agents. |
| Testing | invoke_function MCP tool | Agents test inline without writing fetch(). |
| Versioning | Overwrite on redeploy | deploy_function with same name replaces previous. No version history. |
| CORS + Auth | CORS open + auth auto-forwarded | Zero config. Function code decides what to enforce. |
| Payload | 6MB in, 6MB out | Lambda's sync invocation limit. Don't restrict below infra. |
| Lambda mapping | One Lambda per function | prj_xxx_funcname. Clean isolation. |
| Gateway routing | Gateway invokes Lambda synchronously (AWS SDK) | Full control over auth/metering. ~20-50ms overhead. Revisit later. |
| Domain | api.run402.com/functions/v1/:name | Same domain, path-based. Consistent with everything else. |
| Helper API | `import { db, storage } from '@run402/functions'` | Explicit import. Standard Node pattern. |
| Helper scope | DB only (PostgREST client + raw SQL) | `db.from('table').select()` + `db.sql('SELECT ...', params?)`. Keep it focused. |

---

## Handler Signature

```typescript
// my-function.ts
import { db, getUser } from '@run402/functions';

export default async (req: Request): Promise<Response> => {
  const body = await req.json();

  // Identify the authenticated caller (returns { id, role } or null)
  const user = getUser(req);
  if (!user) return new Response('Unauthorized', { status: 401 });

  // Use the built-in DB helper (PostgREST client)
  const users = await db.from('users').select('*');

  // Use secrets via env vars
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  return new Response(JSON.stringify({ users }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
```

### `@run402/functions` Helper

The helper is pre-installed in the Lambda layer. It provides:

```typescript
import { db, getUser } from '@run402/functions';

// PostgREST-style queries (uses service_key internally)
await db.from('users').select('id, name').eq('active', true);
await db.from('orders').insert({ item: 'widget', qty: 3 });
await db.from('orders').update({ qty: 5 }).eq('id', orderId);
await db.from('orders').delete().eq('id', orderId);

// Raw SQL (via /admin/v1/projects/:id/sql)
await db.sql('SELECT count(*) FROM users WHERE created_at > now() - interval \'7 days\'');

// Parameterized SQL — prevents SQL injection, handles escaping automatically
await db.sql('SELECT * FROM users WHERE id = $1', [userId]);
await db.sql('INSERT INTO orders (user_id, item, qty) VALUES ($1, $2, $3)', [userId, 'widget', 3]);

// Identify the authenticated caller
const user = getUser(req);
// Returns { id: string, role: string } or null
// Verifies the JWT from the Authorization: Bearer header
// Returns null if missing, invalid, expired, or wrong project
```

The helper is pre-configured with the project's `service_key`, `project_id`, `JWT_SECRET`, and `RUN402_API_BASE`. No configuration needed inside the function.

---

## API Surface

### Deploy a function

```
POST /admin/v1/projects/:id/functions
Authorization: Bearer <service_key>
Content-Type: application/json

{
  "name": "stripe-webhook",
  "code": "import { db } from '@run402/functions';\n\nexport default async (req) => { ... }",
  "config": {
    "timeout": 30,
    "memory": 256
  },
  "deps": ["stripe"]
}
```

**Response (201):**
```json
{
  "name": "stripe-webhook",
  "url": "https://api.run402.com/functions/v1/stripe-webhook",
  "status": "deployed",
  "runtime": "node22",
  "timeout": 30,
  "memory": 256,
  "created_at": "2026-03-05T12:00:00Z"
}
```

- `name` (required): Function name. URL-safe slug (lowercase, hyphens, alphanumeric).
- `code` (required): TypeScript or JavaScript source as a string.
- `config` (optional): `{ timeout?: number, memory?: number }`. Defaults to tier maximums.
- `deps` (optional): Array of npm package names to install alongside pre-bundled packages.

### Invoke a function

```
POST /functions/v1/stripe-webhook
apikey: <anon_key or service_key>
Content-Type: application/json

{ "event": "checkout.session.completed", ... }
```

- CORS headers are set automatically (Access-Control-Allow-Origin: *).
- If the caller sends `apikey` or `Authorization: Bearer <token>`, it's forwarded to the function via `req.headers`.
- The gateway meters the invocation against the project's API call quota.
- GET, POST, PUT, PATCH, DELETE are all supported (method forwarded to handler via `req.method`).

### List functions

```
GET /admin/v1/projects/:id/functions
Authorization: Bearer <service_key>
```

**Response:**
```json
{
  "functions": [
    {
      "name": "stripe-webhook",
      "url": "https://api.run402.com/functions/v1/stripe-webhook",
      "runtime": "node22",
      "timeout": 30,
      "memory": 256,
      "created_at": "2026-03-05T12:00:00Z",
      "updated_at": "2026-03-05T12:00:00Z"
    }
  ]
}
```

### Delete a function

```
DELETE /admin/v1/projects/:id/functions/:name
Authorization: Bearer <service_key>
```

### Get function logs

```
GET /admin/v1/projects/:id/functions/:name/logs?tail=100
Authorization: Bearer <service_key>
```

**Response:**
```json
{
  "logs": [
    {
      "timestamp": "2026-03-05T12:01:00Z",
      "level": "info",
      "message": "Processing webhook for customer cus_xxx"
    },
    {
      "timestamp": "2026-03-05T12:01:01Z",
      "level": "error",
      "message": "TypeError: Cannot read property 'id' of undefined",
      "stack": "at handler (index.ts:15:20)\n..."
    }
  ]
}
```

Logs include `console.log`, `console.error`, `console.warn` output from the function, plus unhandled error stack traces. Stored in CloudWatch, queried via CloudWatch Logs Insights.

---

## MCP Tools

### deploy_function

```
deploy_function(
  project_id: string,     // required
  name: string,           // required — URL-safe function name
  code: string,           // required — TS/JS source code
  config?: {
    timeout?: number,      // seconds (default: tier max)
    memory?: number,       // MB (default: tier max)
  },
  deps?: string[],        // optional — npm packages to install
)
```

**Returns on success:**
```json
{
  "name": "stripe-webhook",
  "url": "https://api.run402.com/functions/v1/stripe-webhook",
  "status": "deployed"
}
```

Redeploying with the same name overwrites the previous version.

### invoke_function

```
invoke_function(
  project_id: string,     // required
  name: string,           // required — function name
  method?: string,        // optional — HTTP method (default: POST)
  body?: object | string, // optional — request body
  headers?: object,       // optional — additional headers
)
```

**Returns:**
```json
{
  "status": 200,
  "body": { "result": "ok" },
  "duration_ms": 45
}
```

Invokes the function via its URL using the project's service_key. For agent testing without building a frontend.

### get_function_logs

```
get_function_logs(
  project_id: string,     // required
  name: string,           // required — function name
  tail?: number,          // optional — last N log lines (default: 50)
)
```

**Returns:** Formatted log output with timestamps, levels, and messages.

---

## Lambda Architecture

### One Lambda per function

Each `deploy_function` call creates (or updates) a Lambda function named:
```
run402_{project_id}_{function_name}
```

Example: `run402_prj_1772125073085_0001_stripe-webhook`

### Pre-built Lambda Layer

A shared Lambda layer contains:
- Node 22 runtime shim (wraps user code, injects env vars, captures logs)
- `@run402/functions` helper package
- Pre-bundled npm packages (see Curated Packages below)

The layer is versioned and rebuilt when the curated package list changes.

### Deploy flow

1. Gateway receives `POST /admin/v1/projects/:id/functions`
2. Validates: name is URL-safe, code is non-empty, function count within tier quota
3. If `deps[]` is specified, install them into a temporary directory and zip with user code
4. If no `deps[]`, zip only user code (tiny, <2s)
5. Create/update Lambda function:
   - Runtime: `nodejs22.x`
   - Handler: `index.handler` (shim wraps user's default export)
   - Layer: shared Run402 layer ARN
   - Environment variables: `RUN402_PROJECT_ID`, `RUN402_API_BASE`, `RUN402_SERVICE_KEY`, plus all project secrets
   - Timeout + memory from config (capped by tier)
   - VPC: same VPC as Aurora (for future direct DB access)
6. Store function metadata in `internal.functions` table
7. Return URL + status

### Invocation flow

1. HTTP request hits gateway at `/functions/v1/:name`
2. Gateway extracts `apikey` header → looks up project
3. Gateway checks: function exists, project is active, quota not exceeded
4. Gateway invokes Lambda synchronously via AWS SDK (`lambda.invoke()`)
5. Lambda executes user code, returns response
6. Gateway forwards response to caller, meters the invocation

### Runtime shim (inside Lambda)

```typescript
// shim.ts — bundled in Lambda layer
import userHandler from './user-code.js';

export async function handler(event) {
  const req = lambdaEventToRequest(event);

  try {
    const response = await userHandler(req);
    return responseToLambdaResult(response);
  } catch (err) {
    // Log full error to CloudWatch (available via get_function_logs)
    console.error('Function error:', err.stack || err.message);
    // Return sanitized error to caller
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal function error' }),
    };
  }
}
```

---

## Curated Pre-Bundled Packages (v1)

| Package | Version | Why |
|---|---|---|
| `stripe` | latest | Payment processing — most common agent use case |
| `openai` | latest | OpenAI API calls |
| `@anthropic-ai/sdk` | latest | Claude API calls |
| `resend` | latest | Transactional email |
| `zod` | latest | Schema validation (agents love it) |
| `uuid` | latest | UUID generation |
| `jsonwebtoken` | latest | JWT verification/signing |
| `bcryptjs` | latest | Password hashing (pure JS, no native deps) |
| `cheerio` | latest | HTML parsing / web scraping |
| `csv-parse` | latest | CSV parsing |

**Growth strategy:** Track what agents request via `deps[]`. When a package is requested >N times per month, add it to the curated list. Review monthly.

**What's NOT included (and why):**
- `sharp` — native deps, 100MB+, complicates Lambda build
- `puppeteer` — needs headless Chrome, too heavy for Lambda layer
- `pg` — agents use the `@run402/functions` helper, not raw pg connections
- `axios` — `fetch` is built into Node 22

---

## Quotas & Limits

### Per-tier limits

| Limit | Prototype | Hobby | Team |
|---|---|---|---|
| Max functions per project | 5 | 25 | 100 |
| Timeout per invocation | 10s | 30s | 60s |
| Memory per invocation | 128 MB | 256 MB | 512 MB |
| Payload size (req + res) | 6 MB | 6 MB | 6 MB |
| Invocations | Counted against API call quota | Same | Same |
| Code size (single file) | 1 MB | 1 MB | 1 MB |
| Secrets count | 10 | 50 | 200 |

### Anti-abuse

- Function names must be URL-safe: `^[a-z0-9][a-z0-9-]{0,62}$`
- Max 10 deploys per function per hour (prevents tight deploy loops from burning Lambda control plane)
- Rate limit on `/functions/v1/:name` is shared with the project's overall rate limit (100 req/s)

---

## Pricing

**Functions are free within existing lease quotas.** No per-deploy charge.

- Each function invocation counts as **1 API call** against the project's quota.
- Compute time (CPU) is absorbed by Lambda costs (our expense, covered by lease margin).
- If the project hits its API call cap, function invocations return 402 like any other endpoint.

**Why this works economically:**
- Lambda costs at our scale: ~$0.20 per 1M invocations + ~$0.0000166667 per GB-second.
- A Prototype project (500K calls, 10s/128MB max) worst case: 500K × 10s × 0.125GB = 625,000 GB-seconds = ~$10.42.
- But real usage is far lower (most invocations <1s). Realistic cost per Prototype: <$0.50.
- Hobby ($5, 5M calls) at realistic avg 500ms/256MB: ~$2.08. Still profitable.
- Team ($20, 50M calls) at realistic avg 500ms/512MB: ~$20.83. Tight — monitor this tier.

**If costs exceed expectations:** Introduce a separate "compute-seconds" quota per tier (e.g., Prototype: 100s, Hobby: 3000s, Team: 30000s). Keep it as a hidden guardrail initially.

---

## Secrets Integration

Functions access secrets via `process.env`. Secrets are set per-project via the existing secrets API (to be built alongside Functions):

```
POST /admin/v1/projects/:id/secrets
Authorization: Bearer <service_key>

{ "key": "STRIPE_SECRET_KEY", "value": "sk_live_..." }
```

On function deploy/update, the gateway:
1. Reads all project secrets from `internal.secrets`
2. Injects them as Lambda environment variables
3. Function reads via `process.env.STRIPE_SECRET_KEY`

When secrets are updated, all functions in the project are redeployed with new env vars (Lambda config update, not code redeploy — fast).

---

## Error Handling

### For HTTP callers (browsers, external services)

Unhandled errors return a sanitized response:
```json
HTTP 500
{ "error": "Internal function error" }
```

No stack traces, no internal details, no secret leakage.

### For agents (via get_function_logs)

Full error details available via the logs endpoint:
```
[2026-03-05T12:01:01Z] ERROR Function error: TypeError: Cannot read property 'id' of undefined
    at handler (index.ts:15:20)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
```

Plus all `console.log` / `console.error` output from the function.

---

## Gateway Changes

### New routes

```typescript
// routes/functions.ts
app.post("/admin/v1/projects/:id/functions", ...);       // deploy
app.get("/admin/v1/projects/:id/functions", ...);         // list
app.delete("/admin/v1/projects/:id/functions/:name", ...); // delete
app.get("/admin/v1/projects/:id/functions/:name/logs", ...); // logs
app.all("/functions/v1/:name", ...);                       // invoke (all methods)
```

### Invocation routing

The `/functions/v1/:name` route:
1. Extracts `apikey` header → resolves project
2. Looks up function in `internal.functions` by name + project_id
3. Gets Lambda ARN
4. Invokes Lambda synchronously via `@aws-sdk/client-lambda`
5. Returns Lambda response to caller
6. Meters as 1 API call

### Database changes

```sql
CREATE TABLE internal.functions (
  id SERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES internal.projects(project_id),
  name TEXT NOT NULL,
  lambda_arn TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'node22',
  timeout_seconds INTEGER NOT NULL DEFAULT 10,
  memory_mb INTEGER NOT NULL DEFAULT 128,
  code_hash TEXT NOT NULL,
  deps TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)
);

CREATE TABLE internal.secrets (
  id SERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES internal.projects(project_id),
  key TEXT NOT NULL,
  value_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, key)
);
```

### Project cleanup

When a project is deleted/archived, all its Lambda functions are deleted and secrets purged.

---

## Testing Strategy

### Unit tests

- `packages/gateway/src/routes/functions.test.ts` — route handlers, validation, error cases
- `packages/gateway/src/services/lambda.test.ts` — Lambda deploy/invoke/delete logic (mock AWS SDK)
- `packages/mcp/src/tools/deploy-function.test.ts` — MCP tool input/output
- `packages/mcp/src/tools/invoke-function.test.ts` — MCP tool invocation

### E2E tests

**Add to existing `test/e2e.ts`** (extend the 11-step flow):
- Step 12: Set a secret (`STRIPE_SECRET_KEY`)
- Step 13: Deploy a function that reads the secret and queries the DB
- Step 14: Invoke the function via HTTP, verify response
- Step 15: Get function logs, verify console.log output appears
- Step 16: Delete the function

**New `test/functions-e2e.ts`** (dedicated function tests):
- Deploy with deps[] (e.g., `zod`)
- Deploy with config overrides (timeout, memory)
- Invoke with different HTTP methods (GET, POST)
- Invoke with auth header forwarding
- Error handling (function throws, verify sanitized response)
- Quota enforcement (deploy beyond limit, verify 403)
- Redeploy (overwrite, verify new code runs)
- Large payload (near 6MB limit)

---

## Documentation Changes

### llms.txt

Add a "Functions" section after the existing Storage section:

```
## Functions

Deploy server-side code that runs next to your database. Use for webhooks, API integrations, custom logic.

POST /admin/v1/projects/:id/functions — deploy a function
DELETE /admin/v1/projects/:id/functions/:name — delete a function
GET /admin/v1/projects/:id/functions — list functions
GET /admin/v1/projects/:id/functions/:name/logs — get logs
POST|GET|... /functions/v1/:name — invoke a function

Handler signature: export default async (req: Request) => Response
Built-in helper: import { db } from '@run402/functions'
Secrets: process.env.SECRET_NAME
Pre-bundled: stripe, openai, @anthropic-ai/sdk, resend, zod, uuid, jsonwebtoken, bcryptjs, cheerio, csv-parse
```

### SKILL.md

Add `deploy_function`, `invoke_function`, `get_function_logs` to the tools reference with examples.

### Homepage

Add Functions to the feature list (alongside Database, Auth, Storage, Sites).

### Pricing page

Add compute quotas per tier (functions count, timeout, memory).

---

## Agent E2E Flow (the happy path)

```
1. Agent: set_secret(project_id, "STRIPE_SECRET_KEY", "sk_live_...")
2. Agent: deploy_function(project_id, "checkout", code, deps: ["stripe"])
   → { url: "https://api.run402.com/functions/v1/checkout", status: "deployed" }
3. Agent: invoke_function(project_id, "checkout", { price_id: "price_xxx" })
   → { status: 200, body: { session_url: "https://checkout.stripe.com/..." } }
4. Agent builds frontend that calls the function URL
5. Done. No human touched a console.
```

---

## Bootstrap Function Convention

If a project has a function named `bootstrap`, the platform auto-invokes it after fork or bundle deploy with caller-provided variables. This enables first-admin setup, demo data seeding, and app configuration.

```typescript
// bootstrap function example (SkMeld)
import { db } from '@run402/functions';

export default async (req) => {
  const { admin_email, app_name, seed_demo_data } = await req.json();

  // Create admin user, configure app, optionally seed demo data
  // ... app-specific setup logic ...

  return new Response(JSON.stringify({
    login_url: `https://myapp.run402.com/claim?token=${token}`,
    admin_email,
  }), { headers: { "Content-Type": "application/json" } });
};
```

The bootstrap function runs with `service_key` access and receives variables via `req.json()`. Its return value appears as `bootstrap_result` in the fork/deploy response. If it fails, the fork still succeeds with a `bootstrap_error` field. The function can also be invoked manually via `POST /functions/v1/bootstrap`.

---

## Open Questions (revisit later)

- **Deno runtime**: Add as a second runtime option when demand justifies.
- **Cron/event triggers**: HTTP-only for v1. Add cron triggers in Sprint 3-4 (per consultation roadmap).
- **Direct Postgres connection**: Currently REST API only. Add `DATABASE_URL` injection when connection pooling story is solid.
- **Lambda alternatives**: Current choice is Lambda. Revisit for ECS worker pool or V8 isolates if cold starts or cost become issues.
- **Gateway routing optimization**: Currently sync SDK invoke (~20-50ms overhead). Consider Lambda Function URLs for lower latency.
- **Provisioned concurrency**: Skip for v1. Add for Hobby+ if cold start complaints emerge.
- **Function-to-function calls**: Not supported in v1. Agent chains via HTTP if needed.
