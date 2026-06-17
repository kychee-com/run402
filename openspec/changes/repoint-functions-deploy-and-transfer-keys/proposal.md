## Why

A fresh `/upgrade-run402` sweep (private `7ef2f3a9..02971934`, Jun 16-17) surfaced two gateway changes that the public client must catch up to:

- **`d38a2e51` (BREAKING) — the legacy function-deploy route was DELETED.** The gateway removed `POST /projects/v1/admin/:project_id/functions` (deprecate-legacy-function-deploy-route, #301/#302, prod-verified). Public `r.functions.deploy()` ([functions.ts:80](../../../sdk/src/namespaces/functions.ts)), the `deploy_function` MCP tool, `run402 functions deploy`, and OpenClaw all still POST that exact path → **404 in production right now**. The gateway migrated its own callers onto `/apply/v1` (additive `functions.patch.set`); the public client must do the same.
- **`ea6bc171` (#428) — transfer-accept now returns the new owner's project keys.** `POST /agent/v1/transfers/:id/accept` derives + returns `anon_key`+`service_key` (stateless JWTs, exactly like project-create). Public `AcceptTransferResult` drops them and `accept()` doesn't persist, so immediately after accepting the recipient owns the project but **can't authenticate any mutation** (deploy / secrets / sql all fail — the local keystore has no keys for it).

## What Changes

- **FIX (breaking) — `r.functions.deploy()` re-pointed onto unified apply.** It builds `{ project, functions: { patch: { set: { [name]: { source: <code>, config, deps, schedule } } } } }` and runs it through the SDK's own apply engine (the same `_applyEngine` the deploy command uses), then maps the `DeployResult` back to the unchanged `FunctionDeployResult`. `name` / `status` / `url` / `schedule` / `runtime` / `timeout` / `memory` come from the input + apply outcome; `runtime_version` / `deps_resolved` are no longer surfaced via deploy (→ `null`, matching the gateway's own migration shim, which returns only `{name,url,status,schedule}`). Input validation and the public method signature are unchanged. Deploy now authorizes via the standard `project.deploy` gate (wallet SIWX, or the operator-approval path) rather than the project service key.
- **FIX — transfer-accept surfaces + persists the new owner's keys.** `AcceptTransferResult` gains `anon_key` / `service_key`; `accept()` persists them via `saveProject` + `setActiveProject` (mirroring `provision`), so the recipient can operate the project with no extra step. The CLI prints the keys in the accept JSON (the `service_key` is a project JWT, identical to `provision` output); the MCP transfers tool surfaces them.
- **Docs + sync:** the `functions.deploy` doc-comment + the `deploy_function` SURFACE endpoint (now `/apply/v1/plans`); `cli/llms-cli.txt` / `sdk/llms-sdk.txt` for both fixes; the transfer-accept-keys note.

## Capabilities

### New Capabilities
- `functions-deploy-via-apply`: the client surface for deploying a single function through the unified apply path now that the legacy inline-deploy route is gone — the spec-build (`functions.patch.set`), the engine delegation, the `DeployResult → FunctionDeployResult` mapping (incl. the `runtime_version`/`deps_resolved` degradation), and the auth shift to the `project.deploy` gate. Spans SDK, CLI, MCP, docs.
- `transfer-accept-credentials-client`: the client surface for the #428 keys-on-accept — the `AcceptTransferResult` fields, the `saveProject` + `setActiveProject` persistence, and the CLI/MCP surfacing. Spans SDK, CLI, MCP, docs.

### Modified Capabilities
<!-- None as delta specs. The functions / transfers client surfaces shipped without OpenSpec capability specs, so both behaviors are ADDED. -->

## Impact

- **SDK:** `namespaces/functions.ts` `deploy()` rewritten to delegate to `new Deploy(this.client).apply(spec)` + result map (`FunctionDeployResult` shape in `functions.types.ts` unchanged); fix the path doc-comment. `namespaces/transfers.ts` — `AcceptTransferResult` +`anon_key`/`service_key`, `accept()` persists like `provision`.
- **CLI:** `functions deploy` keeps its JSON-out (now sourced from the apply-backed result); `transfer accept` prints the returned keys. No new flags.
- **MCP:** `deploy-function` tool unchanged at the call layer (still `functions.deploy`); `transfers` accept tool surfaces the keys.
- **Tests:** SDK unit (functions.deploy posts a `functions.patch.set` plan to `/apply/v1/plans` + maps the result; transfers.accept returns + persists keys); CLI e2e where wired.
- **Docs + sync:** `sync.test.ts` `deploy_function` endpoint → `/apply/v1/plans`; `cli/llms-cli.txt` + `sdk/llms-sdk.txt`.
- **Cross-repo:** gateway already shipped (`d38a2e51`, `ea6bc171`). Client ships independently; the function-deploy fix is **urgent** (live 404).
