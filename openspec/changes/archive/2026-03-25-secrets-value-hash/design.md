## Context

The `GET /projects/v1/admin/:id/secrets` endpoint returns `key`, `created_at`, `updated_at` for each secret. Values are never exposed. Secrets are stored in `internal.secrets` with `value_encrypted` column (plaintext, encryption at rest via Aurora). The `listSecrets` function in `packages/gateway/src/services/functions.ts` runs a simple SELECT query.

## Goals / Non-Goals

**Goals:**
- Let agents verify a secret's value matches what they intended, without exposing the value
- Zero friction — no new endpoints, just an additional field on an existing response

**Non-Goals:**
- Full secret value retrieval (write-only by design)
- Encryption changes to the storage layer
- Hashing stored values at rest (compute hash on read)

## Decisions

### Compute hash at query time via PostgreSQL

Use `left(encode(sha256(value_encrypted::bytea), 'hex'), 8)` in the SELECT query. This avoids storing a separate hash column, keeps the schema unchanged, and PostgreSQL's `sha256()` (available since PG 11, we run PG 16) handles it efficiently.

**Alternative considered**: Store a hash column and update it on write. Rejected — adds a migration, requires backfill, and the secrets table is small (max ~100 per project). Computing on read is negligible.

### Truncate to 8 hex characters

8 hex chars = 32 bits of the SHA-256. Enough to distinguish values with high confidence (collision probability ~1 in 4 billion) while being short enough to eyeball in a JSON response. Same convention used by git short hashes.

**Alternative considered**: Full 64-char SHA-256. Rejected — unnecessarily long for debugging, and a longer hash marginally increases brute-force risk for short/low-entropy secrets.

## Risks / Trade-offs

- **Low-entropy secrets**: For very short secrets (e.g., 4-digit PINs), even a truncated hash could narrow the search space. Mitigation: secrets are typically API keys (high entropy), and the endpoint requires `service_key` auth — already full-admin access.
- **No backwards compatibility risk**: Additive field, existing consumers ignore unknown fields.
