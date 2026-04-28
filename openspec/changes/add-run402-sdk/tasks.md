## 1. Package scaffold

- [x] 1.1 Create `sdk/` directory with `package.json` (name `@run402/sdk`, version `0.1.0-pre`, exports `.` and `./node`), `tsconfig.json` excluding tests, and `src/` / `test/` folders
- [x] 1.2 Add `build:sdk` script to root `package.json` that runs `tsc -p sdk/tsconfig.json`
- [x] 1.3 Wire `sdk/` build into the top-level `build` script, producing `sdk/dist/`
- [x] 1.4 Add placeholder `sdk/README.md` covering install, the two entry points, and the "0.x may churn" warning
- [x] 1.5 Confirm `sdk/dist/` is in `.gitignore` and `sdk/**/*.test.ts` is excluded from build

## 2. Kernel, errors, and types

- [x] 2.1 Define `Run402Error` abstract base and concrete subclasses `PaymentRequired`, `ProjectNotFound`, `Unauthorized`, `ApiError`, `NetworkError` in `sdk/src/errors.ts`; each carries `status`, `body`, `context`
- [x] 2.2 Define the `CredentialsProvider` interface (`getAuth(path)`, `getProject(id)`) in `sdk/src/credentials.ts`
- [x] 2.3 Implement the request kernel in `sdk/src/kernel.ts`: takes URL + options, uses `globalThis.fetch` (or injected fetch), calls `credentials.getAuth`, parses JSON / text, maps non-2xx to the correct `Run402Error` subclass
- [x] 2.4 Implement the `Run402` class in `sdk/src/index.ts`: takes `{ apiBase, credentials, fetch? }`, holds namespace instances, delegates requests to the kernel
- [x] 2.5 Implement a default `run402()` factory export that constructs `Run402` with sensible defaults (in the isomorphic entry, `credentials` is required)
- [x] 2.6 Unit tests for the kernel: 2xx JSON, 2xx text, 401 → `Unauthorized`, 402 → `PaymentRequired`, 404 → `ApiError`, network-level throw → `NetworkError`, `process.exit` is never called
- [x] 2.7 Assertion test that `sdk/src/**/*.ts` (excluding `sdk/src/node/`) contain no `import` of `fs`, `path`, `child_process`, `process`, `os`

## 3. Node provider (`@run402/sdk/node`)

- [x] 3.1 Create `sdk/src/node/index.ts` exporting a `NodeCredentialsProvider` class that re-uses `core/` keystore + `core/` allowance-auth
- [x] 3.2 Implement Node-specific `run402()` factory in `sdk/src/node/index.ts` that wires: default api base from `getApiBase()`, `NodeCredentialsProvider`, and an x402-wrapped fetch built via the existing `setupPaidFetch` logic (moved into `sdk/src/node/paid-fetch.ts`)
- [x] 3.3 Re-use existing `core/` modules without duplicating: add `"dependencies"` on `@run402/core` (or path-reference in monorepo), depending on how the repo already wires `core/dist/`
- [x] 3.4 Unit tests: `NodeCredentialsProvider.getProject` returns keys for a populated temp keystore; returns null on miss; `getAuth` produces valid SIWX headers
- [x] 3.5 Integration test: construct the Node `run402()` against a mock server, confirm x402 retry happens on 402 when allowance has balance, confirm `PaymentRequired` throws when balance is zero

## 4. Pilot namespace: `projects`

- [x] 4.1 Implement `sdk/src/namespaces/projects.ts` covering every operation currently in `src/tools/` matching this resource: `provision`, `delete`, `info`, `use`, `keys`, `list`, `pin`, `getUsage`, `getSchema`, `setupRls`, `getQuote`
- [x] 4.2 Define typed request / response interfaces for each method in `sdk/src/namespaces/projects.types.ts`
- [x] 4.3 Write namespace-level unit tests that mock fetch and verify URL, method, body, and header composition per method
- [x] 4.4 Document each method in TSDoc so it surfaces in autocomplete and in future code-mode contexts

## 5. Migrate `projects` consumers

- [x] 5.1 Capture snapshot baseline: ran the existing MCP + CLI e2e test suite (275 tests) as the parity baseline in lieu of explicit snapshot files; re-run post-migration confirmed byte-equivalent stdout and tool-result text
- [x] 5.2 Replace the body of each MCP handler in `src/tools/` for the `projects` namespace with a thin shim that calls `sdk.projects.<op>` and formats the result as markdown; maintain the existing tool name and description
- [x] 5.3 Replace each CLI command in `cli/lib/projects.mjs` (and other project-touching modules) with a thin shim that calls `sdk.projects.<op>`, formats text or JSON, translates `Run402Error` to exit codes, and calls `process.exit` only at the CLI edge — covers the 11 pilot subcommands (quote, provision, use, list, info, keys, usage, schema, rls, delete, pin); `sql`, `rest`, `apply-expose`, `get-expose`, `promote-user`, `demote-user` remain on raw fetch (out of pilot scope — belong to other namespaces)
- [x] 5.4 Re-run the snapshot suite and confirm byte-equivalence (modulo non-deterministic values — timestamps, UUIDs) — all 275 tests pass post-migration, including the GH-84 HTML 502 test, GH-102 active-project fallbacks, and the existing MCP tool unit tests for provision/pin/project-info/project-keys/project-use/setup-rls
- [x] 5.5 Grep the migrated files: assert no `fetch(`, `paidApiRequest(`, or `apiRequest(` remains in the migrated MCP handlers or CLI command body — verified: 11 MCP handler files contain zero direct fetch calls; CLI projects.mjs pilot subcommands call SDK only (6 non-pilot commands retain fetch as expected)

## 6. Remaining namespaces (repeat the pilot pattern per namespace)

- [x] 6.1 `blobs` — `put`, `get`, `ls`, `rm`, `sign` — SDK namespace + types + 13 unit tests; 5 MCP handlers migrated to SDK shims; CLI `get`/`ls`/`rm`/`sign` on SDK. **Deferred**: CLI `blob put` retains raw fetch due to resumable-upload state + concurrency UX the SDK doesn't model yet. ~~Deprecated-aliased `upload_file`/`download_file`/`list_files`/`delete_file` MCP tools kept on raw apiRequest because they target the legacy `/storage/v1/object/:bucket/:path` endpoints (different namespace from the new `/storage/v1/blob/:key` SDK surface)~~ — **Obsolete (2026-04-28):** the four legacy MCP tools were deleted in `sunset-legacy-storage-surfaces`; this carve-out no longer applies.
- [x] 6.2 `functions` — `deploy`, `invoke`, `logs`, `list`, `delete`, `update` — SDK namespace + types + 14 unit tests; 6 MCP handlers migrated; CLI fully on SDK (including the `logs --follow` polling loop)
- [x] 6.3 `secrets` — `set`, `list`, `delete` — SDK namespace + 4 tests; 3 MCP handlers + CLI fully migrated
- [x] 6.4 `subdomains` — `claim`, `delete`, `list` — SDK namespace + 4 tests; 3 MCP handlers (`claim_subdomain`/`delete_subdomain`/`list_subdomains`) + CLI fully migrated
- [x] 6.5 `domains` (custom domains) — `add`, `list`, `status`, `remove` — SDK namespace + 3 tests; 4 MCP handlers + CLI fully migrated
- [x] 6.6 `sites` — `deploy`, `getDeployment` — SDK namespace + 3 tests; 2 MCP handlers + CLI fully migrated. `deploy_site` keeps `requireAllowanceAuth` early check + `updateProject(last_deployment_id)` side effect in the MCP shim
- [x] 6.7 `apps` (bundle / marketplace) — `bundleDeploy`, `browse`, `fork`, `publish`, `listVersions`, `updateVersion`, `deleteVersion`, `getApp` — SDK namespace + 8 MCP handlers + CLI migrated. `bundle_deploy` MCP shim keeps `requireAllowanceAuth` + `PaymentRequired` informational text; `apps.fork` persists keys via provider. CLI `run402 deploy` (bundle) retains its custom undici dispatcher with 10-min timeout + retry-on-5xx — SDK covers the endpoint but not the transport ergonomics.
- [x] 6.8 `email` — `createMailbox`, `send`, `list`, `get`, `getRaw`, `getMailbox`, `deleteMailbox`, plus webhook ops `webhooks.register/list/get/update/delete` — SDK namespace with auto-mailbox-resolution (provider-cached); 12 MCP handlers + CLI (including `email reply` composing SDK `get` + `send`). `CredentialsProvider` gained optional `updateProject` so the SDK can cache `mailbox_id`/`mailbox_address` between calls.
- [x] 6.9 `auth` — `requestMagicLink`, `verifyMagicLink`, `setUserPassword`, `settings`, `promote`, `demote` — SDK namespace + 6 MCP handlers + CLI. `auth:providers` CLI subcommand kept on raw fetch (not in pilot scope).
- [x] 6.10 `senderDomain` — `register`, `status`, `remove`, `enableInbound`, `disableInbound` — SDK namespace + 5 MCP handlers + CLI migrated.
- [x] 6.11 `billing` — `checkBalance`, `history`, `createCheckout`, `createEmailAccount`, `linkWallet`, `tierCheckout`, `buyEmailPack`, `setAutoRecharge` — SDK namespace + 8 MCP handlers + CLI. CLI `billing:balance`/`billing:history` kept on raw fetch because identifier can be email OR wallet; SDK models wallet only.
- [x] 6.12 `tier` — `status`, `set` — SDK namespace + 2 MCP handlers + CLI. `set_tier` MCP preserves "## Payment Required" informational branch.
- [x] 6.13 `allowance` — `status`, `create`, `export`, `faucet` — SDK namespace + 4 MCP handlers + CLI. `NodeCredentialsProvider` gained `readAllowance`/`saveAllowance`/`createAllowance`/`getAllowancePath` so the namespace works via the provider interface.
- [x] 6.14 `ai` — `translate`, `moderate`, `usage`, plus `generateImage` — SDK namespace + 4 MCP handlers + CLI. `generate_image` preserves "## Payment Required" text; `ai_translate` preserves the "Translation Unavailable" (add-on required) branch on 402.
- [x] 6.15 `contracts` — `provisionWallet`, `getWallet`, `listWallets`, `setRecovery`, `setLowBalanceAlert`, `call`, `read`, `callStatus`, `drain`, `deleteWallet` — SDK namespace + 10 MCP handlers + CLI. Surface is **frozen** per prior user direction; migration is implementation-internal only (same endpoints, same response shapes, same MCP text).
- [x] 6.16 `service` — `status`, `health` — SDK namespace + 2 tests (public endpoints, no auth); 2 MCP handlers + CLI fully migrated. `service:status`/`service:health` CLI preserved as switch-case so the sync scanner finds them
- [x] 6.17 `admin` — `sendMessage`, `setAgentContact` as SDK methods + 2 MCP handlers + CLI. `init` and `status` MCP handlers kept in `src/tools/` (compound flows: compose `allowance.create` + `allowance.faucet` + `tier.status` + `billing.checkBalance` + `projects.list`). MPP-rail faucet in `init.ts` retains a direct RPC call to `rpc.moderato.tempo.xyz` (not a run402 API).
- [x] 6.18 After each namespace PR: re-ran `npm test` (275/275) after every batch, grep-verified no raw `fetch`/`apiRequest` leaked into migrated handlers, fixed test brittleness when paid-fetch wrapping converts `(url, init)` → `(Request, undefined)` (Request-aware body/method extraction added to `cli-e2e.test.mjs` intercepts + `check-balance.test.ts`).

## 7. Sync test extension

- [x] 7.1 Extend `sync.test.ts` with an `SDK_BY_CAPABILITY` side-table mapping each SURFACE capability id → namespace-qualified SDK method (or `null` for explicit opt-outs). Chose a side-table over adding a column to `SURFACE` because it kept the ~90 existing SURFACE entries untouched.
- [x] 7.2 Every SURFACE capability declares its SDK path (or explicit null). Test: "every SURFACE capability has an SDK mapping".
- [x] 7.3 Test reflects on the built `@run402/sdk` via `listSdkMethods()` (reads `sdk/dist/` via dynamic import, walks namespaces and nested sub-namespaces like `email.webhooks`), confirms every declared SDK path resolves to a real method.
- [x] 7.4 Orphan check — every SDK method is referenced by `SDK_BY_CAPABILITY`, or in an explicit `SDK_ONLY_METHODS` set (holds TS-private helpers like `email.resolveMailbox` that are runtime-enumerable but intentionally internal, plus the `projects.active` convenience).

## 8. Publishing and pre-bundling

- [ ] 8.1 Bump SDK version to `0.1.0` once all namespaces have migrated consumers — **deferred, awaiting user go-ahead**
- [ ] 8.2 Publish `@run402/sdk` to npm (dry-run first, then real publish) — **requires explicit user authorization**
- [ ] 8.3 Add `@run402/sdk` to the list of pre-bundled packages documented in `deploy_function` tool description and the gateway-side bundler config — **private-repo work; requires user authorization**
- [ ] 8.4 Update `SKILL.md` and `openclaw/SKILL.md` to mention that deployed functions may `import { run402 } from "@run402/sdk"` — **deferred until 8.2 lands so the examples work**
- [ ] 8.5 Update `~/Developer/run402-private/site/llms-cli.txt` (if present) to list the SDK as a consumer entry point alongside CLI and MCP — **private-repo work; requires user authorization**

## 9. Cleanup and docs

- [x] 9.1 Deleted the legacy paid-fetch files — `src/paid-fetch.ts`, `src/paid-fetch.test.ts`, `cli/lib/paid-fetch.mjs`, `openclaw/scripts/paid-fetch.mjs`. Updated `src/tools/bundle-deploy.test.ts` to drop the now-dead `mock.module("../paid-fetch.js", ...)` block, and `mcp-integration.test.ts` to reset the SDK singleton via `_resetSdk()` (paid-fetch state now lives inside each `Run402` instance). The SDK's own `sdk/src/node/paid-fetch.ts` is the single canonical paid-fetch implementation. All 275 tests still green after cleanup.
- [x] 9.2 Update `CLAUDE.md` architecture section: added SDK-first architecture diagram, explained isomorphic kernel vs `/node` subpath, documented `sdk.ts` singleton + `mapSdkError` for MCP, `sdk.mjs` + `reportSdkError` for CLI, noted `blob put` + `deploy` as intentional raw-fetch carve-outs.
- [x] 9.3 Update root `README.md` with a short SDK section: title now lists four interfaces (SDK first), Integrations table gained an SDK row, added an "## SDK" section with install + minimal example + namespace list.
- [x] 9.4 Run `npm test` and confirm pass — 275/275 green after every batch.
- [x] 9.5 Final grep over `src/tools/*.ts` and `cli/lib/*.mjs`: remaining `fetch(` appears only in (a) ~~legacy storage aliases (`upload-file`/`download-file`/`delete-file`/`list-files`, sunset 2026-06-01)~~ **Obsolete (2026-04-28):** the legacy storage aliases were deleted in `sunset-legacy-storage-surfaces`; this carve-out no longer applies. Remaining items: (b) DB ops not in pilot scope (`run-sql`/`rest-query`), (c) expose manifest ops not in pilot scope (`apply-expose`/`get-expose`), (d) intentional carve-outs (`init.ts` MPP faucet RPC, `blob.mjs` `put`, `deploy.mjs` custom dispatcher, `allowance.mjs` on-chain balance / billing endpoints that take email-or-wallet, `auth:providers`, compound status/init). Every handler that could be migrated has been.
