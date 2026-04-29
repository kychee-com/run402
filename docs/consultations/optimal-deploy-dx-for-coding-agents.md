# Consultation Result

**Model**: gpt-5.5-pro
**Submitted**: 2026-04-28T14:24:57.310556
**Completed**: 2026-04-28T14:38:54.787989
**Status**: completed

---

Build **one deploy system**:

> **`deploy.apply(ReleaseSpec)` is the canonical primitive.**  
> It accepts structured app intent, normalizes all byte payloads into CAS content refs, performs `plan → upload missing CAS objects → commit`, and gives agents one resumable operation with JSON progress/errors.

Do **not** raise the `/deploy/v1` 50 MB limit. Retire inline base64 as a transport.

---

## 1. Target SDK shape

### Fresh full-stack deploy

```ts
import { run402, files } from "@run402/sdk";

const run = run402();

const result = await run.deploy.apply({
  project: projectId,
  base: "empty", // fail if a release already exists; use "current" for existing apps

  database: {
    migrations: [
      {
        name: "001_init",
        sql: `
          CREATE TABLE items (
            id serial PRIMARY KEY,
            title text NOT NULL,
            done boolean DEFAULT false
          );
        `,
      },
    ],
    expose: {
      // new declarative auth/RLS manifest, not the deprecated rls template
      tables: {
        items: { read: "public", insert: "public", update: "public" },
      },
    },
  },

  secrets: {
    set: {
      OPENAI_API_KEY: { value: openaiKey },
    },
  },

  functions: {
    replace: {
      "api": {
        runtime: "node22",
        source: `
          export default async function handler(req) {
            return Response.json({ ok: true });
          }
        `,
        config: { timeoutSeconds: 30, memoryMb: 256 },
      },
    },
  },

  site: {
    replace: files({
      "index.html": { data: html, contentType: "text/html; charset=utf-8" },
      "logo.png": { data: logoBytes, contentType: "image/png" },
    }),
  },

  subdomains: { set: ["my-app"] },

  checks: [
    { name: "home loads", http: { path: "/", expect: { status: 200 } } },
    { name: "api health", http: { path: "/api", expect: { status: 200 } } },
  ],
}, {
  onEvent: (event) => console.log(JSON.stringify(event)),
});
```

### Patch one site file

Only the new `index.html` bytes leave the machine.

```ts
await run.deploy.apply({
  project: projectId,
  base: "current",
  site: {
    patch: {
      put: {
        "index.html": { data: html, contentType: "text/html; charset=utf-8" },
      },
    },
  },
});
```

### Patch one function

No site rebuild, no migration replay.

```ts
await run.deploy.apply({
  project: projectId,
  base: "current",
  functions: {
    patch: {
      set: {
        "api": {
          runtime: "node22",
          source: newFunctionCode,
          config: { timeoutSeconds: 10, memoryMb: 256 },
        },
      },
    },
  },
});
```

### Deploy a large directory in Node

```ts
import { fileSetFromDir } from "@run402/sdk/node";

await run.deploy.apply({
  project: projectId,
  base: "current",
  site: {
    replace: fileSetFromDir("dist"),
  },
});
```

`fileSetFromDir()` should be lazy/streaming: hash from disk, upload from disk, never load a 2 GB site into memory.

### Deploy from memory / V8 isolate

```ts
import { files } from "@run402/sdk";

await run.deploy.apply({
  project: projectId,
  base: "current",
  site: {
    replace: files({
      "index.html": htmlString,
      "data.json": new Blob([JSON.stringify(data)], {
        type: "application/json",
      }),
    }),
  },
});
```

No filesystem assumption in the root SDK.

---

## 2. Public API layers

Expose three layers, but make agents use layer 1.

```ts
// Layer 1: agent happy path
await run.deploy.apply(spec, opts);

// Layer 2: debuggable/resumable operation
const op = await run.deploy.start(spec);
for await (const event of op.events()) console.log(event);
const result = await op.result();

// Layer 3: low-level protocol for CLI/debugging
const plan = await run.deploy.plan(spec);
await run.deploy.upload(plan, { onEvent });
await run.deploy.commit(plan.id);
```

Also:

```ts
await run.deploy.resume(operationId);
await run.deploy.status(operationId);
await run.deploy.getRelease(releaseId);
await run.deploy.diff({ from: releaseA, to: releaseB });
```

`apps.bundleDeploy()` and `sites.deployDir()` should become wrappers over this. They should not use their current transports.

---

## 3. Manifest and plan: use both

The correct model is:

1. **Manifest / ReleaseSpec**: declarative desired release or patch.
2. **Plan**: gateway diff + CAS upload negotiation + payment preflight.
3. **Commit**: durable server-side operation that stages, migrates, activates.

So: one conceptual deploy primitive, implemented as plan/upload/commit.

The SDK should hide this by default, but plan should be first-class for agents that need debugging.

---

## 4. Wire model

The wire manifest should contain **no file/function/source bytes**. It should contain content refs.

Conceptually:

```json
{
  "schema": "run402.deploy.v2",
  "project_id": "prj_123",
  "base": { "release": "current" },
  "resources": {
    "site": {
      "mode": "patch",
      "put": {
        "/index.html": {
          "sha256": "abc...",
          "size": 12345,
          "content_type": "text/html; charset=utf-8"
        }
      }
    },
    "functions": {
      "set": {
        "api": {
          "runtime": "node22",
          "entrypoint": "index.mjs",
          "files": {
            "index.mjs": {
              "sha256": "def...",
              "size": 999,
              "content_type": "text/javascript"
            }
          },
          "config": { "timeout_seconds": 30, "memory_mb": 256 }
        }
      }
    },
    "database": {
      "migrations": [
        {
          "id": "001_init",
          "checksum": "sha256:...",
          "sql_ref": {
            "sha256": "ghi...",
            "size": 456
          }
        }
      ]
    }
  }
}
```

The SDK can accept strings, `Uint8Array`, `Blob`, web streams, Node files, etc. But before planning, it normalizes byte payloads into:

```ts
type ContentRef = {
  sha256: string;
  size: number;
  contentType?: string;
  integrity?: string; // sha256-... SRI form
};
```

The deploy endpoint receives refs, not base64.

---

## 5. Canonical byte transport

Build one internal/public CAS content layer and use it everywhere:

- deploy site files
- deploy function bundles/source
- deploy SQL payloads if large
- deploy manifest itself if manifest JSON exceeds the normal body limit
- blob storage uploads

`blobs.put()` remains a storage API, but internally becomes:

```txt
content.ensure(source) → storage.publish(key, contentRef, metadata)
```

Deploy becomes:

```txt
manifest/spec → content refs → plan missing refs → upload missing refs → commit
```

Important details:

### Upload modes

Support three upload strategies behind one API:

1. **Single PUT** for small/medium objects.
2. **Multipart PUT** for large objects.
3. **CAS pack upload** for many tiny files.

The pack upload matters. A site with 20,000 tiny files should not require 20,000 presigned PUTs. The SDK should pack small missing objects into a content-addressed archive, upload one/few packs, and let the gateway unpack/promote each object after verifying checksums.

### Manifest refs

Keep `/deploy/v2/plans` small. If the normalized manifest is too large, the SDK uploads the manifest JSON itself as a CAS object first, then calls:

```json
{
  "project_id": "prj_123",
  "manifest_ref": {
    "sha256": "...",
    "size": 9000000,
    "content_type": "application/vnd.run402.deploy-manifest+json"
  }
}
```

### Server authoritative digest

Do not make correctness depend on SDK/gateway canonicalization matching byte-for-byte. The gateway should compute and return the authoritative `manifest_digest`.

The SDK may compute a local digest for caching/progress, but idempotency should be based on:

- gateway-computed manifest digest
- project id
- base release
- optional client idempotency key

---

## 6. Atomicity model

Make deploy commits server-side, durable, and resumable.

Current ordering is dangerous:

```txt
migrations → RLS → secrets → functions → site → subdomain
```

New ordering should be:

```txt
plan
upload missing content
validate everything
stage all non-DB resources
reserve domains
gate traffic if DB changes
run DB transaction
activate release pointers
clear gate
poll readiness
```

More concretely:

1. **Validate**
   - content exists
   - manifest schema valid
   - function names/routes valid
   - subdomains available/reserved
   - migration IDs/checksums sane
   - payment/lease checked via x402 before large uploads if possible

2. **Stage non-visible resources**
   - build/stage function versions
   - stage site deployment
   - stage secret version set
   - reserve subdomain
   - prepare route table
   - no public pointer changes yet

3. **If database changes exist, enter strict deploy gate**
   - temporarily gate project traffic at the run402 edge
   - return `503 Retry-After` or queue short requests
   - correctness beats zero downtime for agent deploys
   - allow opt-in zero-downtime mode only for declared backward-compatible migrations

4. **Run DB work transactionally**
   - advisory lock per project DB
   - migrations table with `{ id, checksum, applied_at, operation_id }`
   - default: reject non-transactional statements
   - apply migrations + expose/RLS in one transaction where possible

5. **Activate**
   - one control-plane transaction swaps active release pointers:
     - site deployment
     - function versions
     - secret version set
     - routes
     - subdomain mapping
   - clear traffic gate

6. **Readiness**
   - CDN/site copy polling
   - function warmup/build logs
   - optional smoke checks

This eliminates the bad failure class:

> SQL migration succeeded, then function deploy failed.

Under v2, functions are staged before SQL runs. If function staging fails, SQL never ran. If SQL committed and the final activation failed, the project remains gated and `resume(operationId)` finishes activation without rerunning SQL.

---

## 7. Retry / recovery behavior

Every deploy gets:

```ts
operationId
planId
manifestDigest
baseReleaseId
```

Retry rules:

### Before DB migration

Safe. No visible state changed.

Repeating the same `deploy.apply(spec)` should:

- reuse or recreate the plan
- skip already-present CAS objects
- restage only missing pieces

### During transactional migration

On SQL error:

- transaction rolls back
- gate clears
- active release unchanged
- error points to migration id + statement/offset
- agent fixes SQL and redeploys

### After DB commit but before activation

The operation is `activation_pending`.

- DB is migrated.
- New site/functions/secrets are already staged.
- Traffic remains gated.
- `deploy.resume(operationId)` activates and clears the gate.
- Repeating the same deploy does not replay migrations.

### Non-transactional migration

Default should be: reject.

If users explicitly opt in:

```ts
transaction: "none"
```

then failures enter:

```txt
needs_repair
```

No blind replay. Return structured repair instructions.

---

## 8. Resource semantics

Use explicit replace/patch semantics.

### Top-level absence

If a resource is omitted, leave it untouched.

```ts
await run.deploy.apply({
  project,
  functions: { patch: { set: { api: fn } } },
});
```

This does not touch site, DB, secrets, or domains.

### Replace

Exact desired set for that resource.

```ts
site: { replace: fileSetFromDir("dist") }
```

Files absent from `dist` are removed from the new site release.

### Patch

Modify only specified keys.

```ts
site: {
  patch: {
    put: { "index.html": html },
    delete: ["old.html"],
  },
}
```

### Conflict handling

Every plan captures a `baseReleaseId`.

Default behavior:

- full replace: fail if active release changed before commit
- patch: auto-rebase if touched resources/paths are disjoint; otherwise fail with structured conflict diff

Agents need this. Silent clobbering is poison.

---

## 9. Non-byte resources

Rule:

> Bytes go through CAS. Semantics stay structured.

### Site files

CAS content refs plus path metadata.

### Functions

Function source/bundles are CAS content. Function config remains structured.

Support both:

```ts
functions: {
  patch: {
    set: {
      api: {
        source: "export default async req => new Response('ok')",
      },
    },
  },
}
```

and:

```ts
functions: {
  patch: {
    set: {
      api: {
        entrypoint: "index.mjs",
        files: fileSetFromDir("functions/api"),
      },
    },
  },
}
```

### Migrations

SQL payloads can be CAS refs internally, but migration identity is structured:

```ts
{
  id: "001_init",
  checksum: "sha256:...",
  sqlRef: ContentRef,
  transaction: "required"
}
```

If the SDK user passes a raw SQL string, SDK converts it to content.

Migration replay rules:

- same id + same checksum: noop
- same id + different checksum: hard error
- new id: pending migration

### Expose/RLS

Declarative manifest. Gateway diffs/applies it. Store applied digest.

### Secrets

Do **not** globally CAS secrets.

Secret values should be:

- encrypted/write-only
- staged under the deploy plan
- redacted from logs/events/errors
- versioned, then activated with the release

Small secret values can ride the control-plane request because they are not bulk bytes. If you later support large secret files, use private encrypted staging, not global CAS/dedup.

---

## 10. Progress and errors

Agents need structured event streams, not human CLI text.

```ts
type DeployEvent =
  | { type: "plan.started" }
  | { type: "plan.diff"; diff: DeployDiff }
  | { type: "payment.required"; amount: string; asset: "USDC" }
  | { type: "payment.paid"; tx?: string }
  | { type: "content.hash.progress"; label: string; done: number; total: number }
  | { type: "content.upload.skipped"; label: string; sha256: string; reason: "present" }
  | { type: "content.upload.progress"; label: string; done: number; total: number }
  | { type: "commit.phase"; phase: string; status: "started" | "done" }
  | { type: "log"; resource: string; stream: "stdout" | "stderr"; line: string }
  | { type: "ready"; releaseId: string; urls: Record<string, string> };
```

Errors should look like:

```json
{
  "code": "FUNCTION_BUILD_FAILED",
  "phase": "stage.functions",
  "resource": "functions.api",
  "message": "Build failed: missing export default",
  "retryable": false,
  "operation_id": "op_123",
  "plan_id": "plan_123",
  "logs": [
    { "stream": "stderr", "line": "index.mjs:1: no default export" }
  ],
  "fix": {
    "action": "edit_and_redeploy",
    "path": "functions.api.source"
  }
}
```

For SQL:

```json
{
  "code": "MIGRATION_FAILED",
  "phase": "database.migrate",
  "resource": "database.migrations.001_init",
  "message": "column \"title\" does not exist",
  "statement_offset": 184,
  "retryable": false,
  "rolled_back": true
}
```

---

## 11. x402 placement

Do payment preflight during `plan`, before uploading huge bytes.

If a lease renewal/payment is needed, agents should learn that before uploading 2 GB.

Then make `commit` idempotent. If commit hits 402 anyway, the SDK’s x402 fetch wrapper handles it, and errors include:

```ts
PaymentRequired {
  amount,
  asset,
  payTo,
  allowancePath?,
  operationId?,
  planId?
}
```

---

## 12. What to do with existing APIs

### `apps.bundleDeploy`

Keep as compatibility sugar only.

```ts
apps.bundleDeploy(projectId, oldOpts)
```

should internally convert to:

```ts
deploy.apply({
  project: projectId,
  database: ...,
  functions: ...,
  site: ...,
  secrets: ...,
  subdomains: ...,
});
```

It must not POST base64 files to `/deploy/v1`.

### `sites.deployDir`

Keep as sugar:

```ts
sites.deployDir({ project, dir })
```

becomes:

```ts
deploy.apply({
  project,
  site: { replace: fileSetFromDir(dir) },
});
```

### `blobs.put`

Keep the API, but make it use the same CAS uploader underneath.

---

## 13. Things other platforms get wrong

Do not copy these patterns:

1. **Client-side orchestration**
   - `wrangler`, Supabase CLI, etc. do too much locally.
   - If the process dies, state is ambiguous.
   - run402 should make the gateway own deploy state.

2. **Separate mutable APIs for env/domains/functions/sites**
   - Vercel/Cloudflare split these.
   - That creates release skew.
   - run402 should version secrets/routes/functions/site together.

3. **Filesystem-first DX**
   - Human platforms assume a repo and a CLI.
   - Agents often have strings, blobs, generated artifacts, or V8 memory.
   - Filesystem support should be a Node convenience, not the primitive.

4. **Text logs and dashboard-only debugging**
   - Agents need JSON errors with resource paths, retryability, and fixes.

5. **Opaque server builds**
   - Agents need deterministic deploy artifacts and inspectable build errors.
   - If you support builds, make them a staged resource with structured logs.

6. **Blind migration replay**
   - Migration identity/checksum must be first-class.
   - Repeat deploys should be noops, not re-execution.

---

## 14. Extra high-leverage agent DX

Two improvements would make run402 meaningfully better than the incumbents.

### A. Release-scoped public config

Remove the “provision first, copy anon key into HTML” pitfall.

Serve a virtual file from every site:

```txt
/.run402/config.json
```

containing:

```json
{
  "project_id": "prj_123",
  "anon_key": "...",
  "api_base": "https://api.run402.com",
  "release_id": "rel_123",
  "functions": {
    "api": "/api"
  }
}
```

Then agents write portable HTML:

```js
const cfg = await fetch("/.run402/config.json").then(r => r.json());
```

This also improves CAS dedup because HTML no longer changes per project just to embed keys.

### B. Same-origin function routes

Let releases declare routes:

```ts
routes: {
  "/api": { function: "api" },
}
```

Then static sites call `/api`, not a separate function URL. This avoids CORS, avoids hardcoded URLs, and makes site+function activation truly release-scoped.

---

## 15. Concrete build order

Build this in order:

1. **Extract canonical CAS content service**
   - single/multipart/pack uploads
   - project-scoped presence
   - manifest-ref support
   - used by deploy and blobs

2. **Add `/deploy/v2`**
   - `POST /deploy/v2/plans`
   - `POST /deploy/v2/plans/:id/commit`
   - `GET /deploy/v2/operations/:id`
   - `GET /deploy/v2/operations/:id/events`
   - `POST /deploy/v2/operations/:id/resume`

3. **Add release model**
   - immutable releases
   - active release pointer
   - staged function/site/secret versions
   - base release conflict detection

4. **Add transactional commit state machine**
   - stage non-DB first
   - traffic gate for DB changes
   - transactional migrations with ids/checksums
   - pointer swap activation
   - resumable failure states

5. **Ship SDK `deploy.apply`**
   - root isomorphic memory/blob/web-stream sources
   - `/node` directory file sets
   - progress events
   - structured errors
   - old APIs as wrappers

6. **Update docs/MCP/CLI**
   - one deploy command/tool
   - no base64 manifest examples
   - patch examples
   - recovery/resume examples

The end state: agents think in terms of “apply this release/patch,” not “which upload transport should I use?” Bytes always go through CAS. Structured resources stay typed. Deploys are resumable, debuggable, and atomically activated.

---
**Wall time**: 13m 57s
**Tokens**: 5,852 input, 29,458 output (24,706 reasoning), 35,310 total
**Estimated cost**: $5.4780
