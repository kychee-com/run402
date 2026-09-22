---
title: "Resource limits"
description: "Native SDK reference — limits."
order: 100
---

## Resource limits

| | Prototype | Hobby | Team |
|---|---|---|---|
| Lease | none (free tier) | 30 days | 30 days |
| Storage | 250 MB | 1 GB | 10 GB |
| API calls | 500K | 5M | 50M |
| Functions | 5 | 25 | 100 |
| Function timeout | 10s | 30s | 60s |
| Function memory | 128 MB | 256 MB | 512 MB |
| Secrets | 10 | 50 | 200 |
| Scheduled fns | 1 / 15min | 3 / 5min | 10 / 1min |

Project rate limit: **100 req/sec** — exceeding throws `ApiError` with status 429 and `retry_after` in the body.

## Idempotent migrations

`CREATE TABLE IF NOT EXISTS` only handles "already exists" — it won't add new columns. For evolving schemas, wrap `ALTER TABLE` in a `DO` block:

```sql
CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, title text NOT NULL);
DO $$ BEGIN
  ALTER TABLE items ADD COLUMN priority int DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
```

Safe to re-run on every deploy.

## SQL guardrails

The SQL endpoint blocks: `CREATE EXTENSION`, `COPY ... PROGRAM`, `ALTER SYSTEM`, `SET search_path`, `CREATE/DROP SCHEMA`, `GRANT/REVOKE`, `CREATE/DROP ROLE`. Use the expose manifest for access control.

## Stability

This package is on the `3.x` line. The in-repo packages (`@run402/sdk`, `run402`, and `run402-mcp`) release in lockstep at the same version. Pin an exact version in production dependencies:

```json
{ "dependencies": { "@run402/sdk": "3.7.5" } }
```

OpenClaw skill packaging follows the CLI release train. `@run402/functions` and `@run402/astro` publish on their own cadences.

## Patterns & gotchas

- Never paste a key into HTML. Every Run402 host serves `/_run402/config.js` (`window.RUN402 = { project_id, api_base, anon_key }`) for the project it resolves to at request time; load that instead. The `anon_key` is public by design.
- Use the manifest for access control, never raw `GRANT/REVOKE`.
- `user_owns_rows` is the default for user-scoped data. Reach for `public_read_write_UNRESTRICTED` only on intentionally-public tables.
- Use immutable `cdnUrl` from `r.assets.put`. It's correct from the moment of upload — no `waitFresh` needed.
- Don't bake unconditional `r.wallets.faucet()` into deploy scripts — the faucet rate-limits and breaks already-funded flows.
- Per-project rate limit is 100 req/sec. On 429, back off using `retry_after`.
- `r.service.status()` works without auth. Use it before evaluating Run402, or to distinguish platform issues from your own bugs.

## See also

- Wayfinder: <https://run402.com/llms.txt>
- CLI reference: <https://docs.run402.com/llms-cli.txt>
- MCP reference: <https://docs.run402.com/llms-mcp.txt>
- HTTP API reference: <https://run402.com/llms-full.txt>
- npm: <https://www.npmjs.com/package/@run402/sdk>
- Source: <https://github.com/kychee-com/run402>

Native PostgREST permission denial is a separate boundary: an exposed table can still reject an operation with HTTP 401/403 and SQLSTATE `42501`. SDK/CLI/MCP label that `REST_PERMISSION_DENIED`, retaining `source: postgrest`, upstream status/code, requested method/relation, and the original body. It does not establish whether grants or RLS caused the denial, and it is not `TABLE_NOT_EXPOSED`.

`apply.edgeCoherence` and `apply.waitEdgeCoherent` require strong release-identity or content-hash evidence. Weak-only legacy reports become inconclusive. Reports retain their sampling/vantage disclosure and optional server check timestamp. `mergeEdgeVerification` folds the latest report into the current edge summary and preserves the earlier activation snapshot.
