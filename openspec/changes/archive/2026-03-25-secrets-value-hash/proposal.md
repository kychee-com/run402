## Why

Agents can set and list secrets but have no way to verify a secret's value is correct without invoking a function. When debugging "why is my API call failing?", agents can't tell whether they set the wrong value, set it on the wrong project, or if it's a different issue entirely. A truncated SHA-256 hash on the list response lets agents confirm "this is the key I intended" without exposing the secret.

## What Changes

- Add a `value_hash` field (first 8 hex chars of SHA-256) to the `GET /projects/v1/admin/:id/secrets` response
- Each secret in the list gains `value_hash: "a1b2c3d4"` alongside existing `key`, `created_at`, `updated_at`
- Document the field in llms.txt and llms-cli.txt

## Capabilities

### New Capabilities
- `secrets-value-hash`: Add truncated SHA-256 hash to secrets list response for debugging

### Modified Capabilities

## Impact

- `packages/gateway/src/services/functions.ts` — `listSecrets` query adds hash computation
- `packages/gateway/src/routes/functions.ts` — response shape gains `value_hash`
- `site/llms.txt`, `site/llms-cli.txt` — document the new field
- No breaking changes — additive field on existing endpoint
