## 1. SDK — functions.deploy re-point (breaking fix)

- [x] 1.1 In `sdk/src/namespaces/functions.ts`, rewrite `deploy()`: keep the validations + `getProject` fast-fail (drop the service-key bearer); build a `ReleaseSpec` `{ project: projectId, functions: { patch: { set: { [name]: { runtime: "node22", source: { data: code, contentType: "text/javascript; charset=utf-8" }, config?: { timeoutSeconds, memoryMb }, deps?, schedule? } } } } }`; run `await new Deploy(this.client).apply(spec, {})`; map `DeployResult` → `FunctionDeployResult` (name/status:"deployed"/schedule/runtime/timeout/memory from input, url from `urls[name]` or derived `apiBase/functions/v1/<name>`, warnings mapped, `runtime_version`/`deps_resolved` = null). Import `Deploy` + `FunctionSpec`/`ReleaseSpec`/`WarningEntry`.
- [x] 1.1a Wire `deps` through the apply engine end-to-end — the apply wire supports it (capability `apply-v1-function-deps`, verified on `origin/main`) but the SDK dropped it at five layers: (a) `FunctionSpec.deps?: string[]` (public type, `deploy.types.ts`), (b) `NormalizedFunctionSpec.deps`, (c) `FUNCTION_SPEC_FIELDS` validateSpec allowlist (`deploy.ts` — else `deps` is rejected as unknown), (d) `normalizeFunction` (`out.deps = fn.deps`), (e) `functionToWire` (`{ deps: fn.deps }`). Without ALL five, `functions.deploy({ deps })` would silently drop deps at the wire.
- [x] 1.2 Fix the `functions.ts` header doc-comment (line ~5) — deploy is now via `/apply/v1`, not `/projects/v1/admin/:id/functions`.

## 2. SDK — transfer-accept credentials

- [x] 2.1 In `sdk/src/namespaces/transfers.ts`, add `anon_key: string` + `service_key: string` to `AcceptTransferResult`.
- [x] 2.2 In `accept()`, after the request returns, persist via `this.client.credentials.saveProject?.(result.project_id, { anon_key, service_key })` + `setActiveProject?.(result.project_id)` (mirror `projects.provision`).

## 3. CLI + MCP

- [x] 3.1 Confirmed `run402 functions deploy` still emits the `FunctionDeployResult` JSON (thin pass-through: `cli/lib/functions.mjs` does `console.log(JSON.stringify(await sdk.functions.deploy(...)))`); the `deploy_function` MCP handler renders the result and already guards `runtime_version`/`deps_resolved` with non-null checks, so the new nulls render cleanly (no shim change needed). Also corrected the CLI help block (no longer claims the result carries `runtime_version`/`deps_resolved`).
- [x] 3.2 Confirmed `run402 transfer accept` prints the result JSON (which now carries the keys, same as `provision`); the `accept_project_transfer` MCP/CLI surfaces them. The SDK-layer persistence (`saveProject`/`setActiveProject`) runs for any provider that supports them.

## 4. Docs + sync

- [x] 4.1 `sync.test.ts`: updated the `deploy_function` SURFACE endpoint to `POST /apply/v1/plans (functions.patch.set)`.
- [x] 4.2 `cli/llms-cli.txt` + `sdk/llms-sdk.txt`: noted function deploy rides unified apply (`functions.patch.set`, `project.deploy` gate, legacy route removed); corrected the two "unified deploy does not accept `deps`" claims (now accepted via `apply-v1-function-deps`) and the "deploy response includes runtime_version/deps_resolved" claims (now null via apply — read `functions list`); documented that transfer-accept returns + persists the new owner's keys (#428).

## 5. Tests

- [x] 5.1 SDK unit (`functions.test.ts`): rewrote the deploy happy-path tests to mock the apply plan+commit (empty `missing_content` + terminal `ready` skip the upload/poll dance); assert `deploy` posts a `functions.patch.set` plan to `/apply/v1/plans` (NOT the legacy admin route), carries `source`/`deps`/`config.timeout_seconds`/`config.memory_mb`/`schedule:null`, sends no service-key bearer, and maps to a `FunctionDeployResult` with `status:"deployed"`, derived url, mapped warnings, and null `runtime_version`/`deps_resolved`. Validation + `ProjectNotFound` tests unchanged. Also updated the MCP `deploy-function.test.ts` to the apply flow.
- [x] 5.2 SDK unit (`transfers.test.ts`): added tests that accept surfaces `anon_key`/`service_key`, persists them via stub `saveProject`/`setActiveProject`, and does not throw when the provider lacks persistence.
- [x] 5.3 `npm test` green (680 pass, 0 fail) + `npm run build` clean. `deps` also wired end-to-end through the apply engine (`FunctionSpec` type + validateSpec allowlist + `normalizeFunction` + `functionToWire`) so it is not silently dropped at the wire.
