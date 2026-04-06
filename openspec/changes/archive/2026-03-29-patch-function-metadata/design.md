## Context

The individual function deploy route handles schedule as post-deploy logic (DB + cron timer) and config (timeout/memory) as part of the Lambda deploy. `UpdateFunctionConfigurationCommand` is already used in the deploy flow to update timeout/memory/env/layers — it can be called independently without re-uploading code.

In local dev mode (no Lambda), config updates are just DB column changes — timeout/memory are metadata only, not enforced locally.

## Goals / Non-Goals

**Goals:**
- PATCH endpoint for schedule, timeout, and memory updates without code redeploy
- Same tier limit enforcement as POST deploy
- Works in both Lambda and local dev modes

**Non-Goals:**
- Updating `code` or `deps` via PATCH (these require a full redeploy)
- Updating secrets via PATCH (secrets have their own endpoint)
- Batch updates across multiple functions

## Decisions

### Single PATCH endpoint for all metadata fields

```
PATCH /projects/v1/admin/:id/functions/:name
Authorization: Bearer <service_key>
Content-Type: application/json

{
  "schedule": "0 */4 * * *",     // optional: string | null
  "config": {                     // optional
    "timeout": 30,                // optional: seconds
    "memory": 256                 // optional: MB
  }
}
```

All fields optional — send only what changed. Empty body or `{}` is a no-op (200 with current state).

### Schedule updates: DB + cron only

Same logic as the POST route: validate cron, check tier limits (max count, min interval), persist to DB, register/cancel timer. No Lambda interaction.

### Config updates: DB + Lambda UpdateFunctionConfiguration

If timeout or memory changes, update the DB row AND call `UpdateFunctionConfigurationCommand` on Lambda. This avoids a full code re-upload while still applying the config to the running Lambda function.

In local dev mode (no Lambda client), only the DB row is updated.

### Response: return updated function state

Return the full function metadata after the update, same shape as the list endpoint:

```json
{
  "name": "cleanup",
  "schedule": "0 */4 * * *",
  "timeout": 30,
  "memory": 256,
  "runtime": "node22",
  "updated_at": "..."
}
```

## Risks / Trade-offs

**[Risk] Lambda UpdateFunctionConfiguration can conflict with concurrent deploys** → Use the same retry-on-ResourceConflictException pattern as the deploy flow (3 attempts with waitUntilFunctionUpdated).

**[Trade-off] No code re-upload means env vars aren't refreshed** → If secrets changed between deploy and PATCH, the Lambda's env vars won't update. This is acceptable — secrets have their own dedicated flow, and PATCH is explicitly for non-code metadata.
