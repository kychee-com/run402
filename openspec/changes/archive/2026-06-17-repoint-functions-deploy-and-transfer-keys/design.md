## Context

Two gateway changes (run402-private, Jun 16-17) landed after the public client was last synced:

- **`d38a2e51`** deleted `POST /projects/v1/admin/:project_id/functions` (~160 lines) and removed it from `openapi.json` + `llms-full.txt`. The commit body self-corrects: *"the route WAS in openapi+llms (the proposal wrongly said absent)."* The gateway kept `deployFunction` in services (used by `/apply/v1` + bundling) and the `/functions/:name/*` management sub-routes + the GET-list. It migrated its own test callers onto a `deployFunctionViaApplyV1` helper: compute SHA-256 of the code, CAS-upload, build a `functions.patch.set` `ReleaseSpec`, POST `/apply/v1/plans` → commit → poll, return the legacy `{name,url,status,schedule}` shape.
- **`ea6bc171` (#428)** added `anon_key`+`service_key` to the transfer-accept 200 body (derived post-commit via `deriveProjectKeys(project_id)` — stateless JWTs, never persisted, same as `POST /projects/v1`). `acceptTransfer` (the service) stays pure; keys are a route-layer concern.

Public state: `r.functions.deploy()` POSTs the deleted route with the service-key bearer; `AcceptTransferResult` is a closed interface with no key fields and `accept()` does a bare request with no keystore write.

## Goals / Non-Goals

**Goals:** restore function deploy (it 404s in prod) by routing through the same `/apply/v1` engine the rest of the SDK uses; give the transfer recipient working keys with no extra step; keep both public method signatures + return types stable.
**Non-Goals:** changing the deploy-spec / apply surface; the handoff (email→org) path (#428 touched only the wallet-transfer accept); re-adding any deleted gateway route.

## Decisions

### Decision 1 — `functions.deploy()` delegates to the apply engine, not a hand-rolled dance

`new Deploy(this.client)` is constructible from the kernel `Client` (exactly what `Run402` does for `_applyEngine = new Deploy(client)`). `deploy()` builds a one-function `ReleaseSpec` and calls `engine.apply(spec, {})`:

```
{ project: projectId,
  functions: { patch: { set: { [opts.name]: {
    source: { data: opts.code, contentType: "text/javascript; charset=utf-8" },
    ...(opts.config ? { config: { timeoutSeconds: opts.config.timeout, memoryMb: opts.config.memory } } : {}),
    ...(opts.deps ? { deps: opts.deps } : {}),
    ...(opts.schedule !== undefined ? { schedule: opts.schedule } : {}),
  } } } } }
```

The engine handles the CAS upload of `source` (a polymorphic `ContentSource` — inline bytes are normalized + uploaded automatically), the plan/commit/poll state machine, and safe-retry. We do NOT reimplement the gateway test helper's manual CAS dance — the SDK already owns it. **Alternative — hand-roll plan/upload/commit in `functions.deploy`** (mirror the gateway test helper): rejected, it duplicates `_applyEngine` and drifts.

**`deps` is preserved — verified against `origin/main`.** The riskiest correctness property: would re-pointing through apply silently drop the documented `deps` option? The local private working tree (`0cda4ebf`, stale) shows apply activation passing `undefined` for deps ("not surfaced through the v2 spec yet") — but that predates `d38a2e51`. On `origin/main` (the prod deploy source) the apply path fully supports function deps via capability **`apply-v1-function-deps`**: `functions.patch.set.<name>.deps: string[]`, validated at `apply-v1.ts:1417` and persisted into the staged `config` JSONB. The gateway's own `deployFunctionViaApplyV1` migration helper sets `fnSpec.deps = args.deps`, and the prod-validated `deps-smoke` test (deps:[lodash], "6/0 against prod") rides this exact path. So `functions.deploy` carries `deps` straight into `FunctionSpec.deps` with no loss. This required adding the missing **`deps?: string[]`** field to the public `FunctionSpec` type (the apply surface was deps-capable on the wire but the SDK type never exposed it).

### Decision 2 — Map `DeployResult → FunctionDeployResult`, best-effort, `runtime_version`/`deps_resolved` → `null`

`DeployResult` carries `release_id`, `operation_id`, `urls`, `diff`, `warnings` — not per-function build metadata. So the mapping is:
- `name` ← input; `status` ← `"deployed"` (apply reached terminal success); `schedule` ← input echo; `runtime` ← `opts.config?.runtime ?? "node22"`; `timeout`/`memory` ← input config (or tier defaults); `created_at` ← now.
- `url` ← `result.urls[name]` if present, else derived `…/functions/v1/<name>` from the project's site host (best-effort).
- `warnings` ← `result.warnings` mapped to their messages.
- `runtime_version` / `deps_resolved` ← **`null`**. They were fields of the deleted route's response and are not on the apply result. The gateway's own migration shim returns only `{name,url,status,schedule}`, so this matches; both fields are already typed `?: … | null`. Documented as "not surfaced via deploy; the function record carries them."

### Decision 3 — Auth shifts from the service key to the `project.deploy` gate

The old route took `Authorization: Bearer <service_key>`. `/apply/v1` authorizes via the standard credential (SIWX wallet, or — for a wallet-less human — the operator-approval `project.deploy` gate shipped in v3.1.0). This is correct: deploying a function IS a `project.deploy`. An agent with a wallet is unaffected; a wallet-less human gets the operator-approval flow automatically. `deploy()` still calls `getProject(projectId)` first to fail fast with `ProjectNotFound` on an unknown id (and the spec needs the id), but no longer sends the service key.

### Decision 4 — transfer-accept mirrors `provision`'s persistence

`AcceptTransferResult` gains `anon_key: string` / `service_key: string`. After the accept request returns, `accept()` does the same persistence `provision` does:

```
if (creds.saveProject) await creds.saveProject(result.project_id, { anon_key, service_key });
if (creds.setActiveProject) await creds.setActiveProject(result.project_id);
```

so the new owner's keystore has the project + it's active. Gated on the optional provider methods (sandbox providers without persistence simply skip). The CLI prints the accept result as-is (the `service_key` JWT is identical to what `provision` already prints). The handoff/claim path is untouched (#428 changed only the wallet-transfer accept).

## Risks / Trade-offs

- **`runtime_version`/`deps_resolved` degradation** → documented; both already nullable; matches the gateway shim. A consumer needing them reads the function record (kept GET routes).
- **`url` is best-effort** → derived from `urls[name]` or the site host; a future enrichment could read the materialized route, but is out of scope for restoring deploy.
- **Auth shift could surprise a service-key-only caller** → in practice `functions.deploy` callers are the wallet/agent flow or the CLI (which has a wallet/operator session); the gate is the same one `deploy apply` uses.
- **Persisting `service_key` to the keystore** → identical to `provision`; the new owner legitimately holds it.

## Migration Plan

Additive/behavioral, client-only, non-breaking to the public signatures. Ships in the normal lockstep release (urgent — the function-deploy 404 is live). Rollback = revert; the gateway routes are independent.

## Open Questions

- Whether to enrich `runtime_version`/`deps_resolved` via a post-deploy function-record read — deferred (extra round-trip; both nullable; not needed to restore deploy).
