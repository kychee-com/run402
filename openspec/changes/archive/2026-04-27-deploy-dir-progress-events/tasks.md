## 1. SDK — DeployEvent type and onEvent instrumentation

- [x] 1.1 Add `DeployEvent` discriminated-union type to `sdk/src/node/sites-node.ts` covering `plan`, `upload`, `commit`, `poll` phases (per spec).
- [x] 1.2 Extend `DeployDirOptions` with `onEvent?: (event: DeployEvent) => void`.
- [x] 1.3 Wrap callback invocations in a local `emit()` helper that try/catches synchronous errors and silently drops them.
- [x] 1.4 Emit `{ phase: "plan", manifest_size }` once, immediately after `requestPlan(...)` returns, before the upload loop.
- [x] 1.5 Emit `{ phase: "upload", file, sha256, done, total }` after each successful `uploadOne(...)` call. Track `total` as the count of `missing` entries in the plan; track `done` as the running counter (1-indexed).
- [x] 1.6 Emit `{ phase: "commit" }` immediately before `planClient.commit(...)`.
- [x] 1.7 Emit `{ phase: "poll", status, elapsed_ms }` inside `pollUntilReady` after each `getDeployment(...)` returns (success path AND non-fatal continuations).
- [x] 1.8 Re-export `DeployEvent` type from `sdk/src/node/index.ts` (alongside the existing exports) so consumers can `import type { DeployEvent } from "@run402/sdk/node"`.

## 2. SDK — Tests

- [x] 2.1 Extend `sdk/src/node/sites-node.test.ts` to mock fetch and capture events. Assert `plan` fires once with correct `manifest_size`.
- [x] 2.2 Test: `upload` events fire only for `missing` entries; `total` and `done` are correct when plan reports a mix of `missing`/`present`/`satisfied_by_plan`.
- [x] 2.3 Test: `commit` event fires exactly once, before commit POST.
- [x] 2.4 Test: `poll` event fires per poll iteration when commit returns `copying`.
- [x] 2.5 Test: callback that throws does not abort the deploy; subsequent events still attempt.
- [x] 2.6 Test: deploy without `onEvent` behaves byte-identically to v1.44.0 (assert via mock-fetch call sequence unchanged).

## 3. CLI — JSON-line stderr stream

- [x] 3.1 In `cli/lib/sites.mjs` `deploy-dir` handler, parse `--quiet` boolean.
- [x] 3.2 Pass `onEvent: (e) => process.stderr.write(JSON.stringify(e) + "\n")` (when not `--quiet`) to `sdk.sites.deployDir(...)`.
- [x] 3.3 Update the `sites deploy-dir` help text to document `--quiet` and the stderr event stream.
- [x] 3.4 Add `--quiet` to the global `sites` HELP block listing.

## 4. CLI — Tests

- [x] 4.1 Add an e2e case in `cli-e2e.test.mjs` for `sites deploy-dir`: assert stderr contains at least one `{"phase":"plan",...}` JSON line; stdout contains exactly the final envelope.
- [x] 4.2 Add e2e case asserting `--quiet` produces empty stderr.

## 5. MCP — Content-array event buffer

- [x] 5.1 In `src/tools/deploy-site-dir.ts`, allocate a `const events: DeployEvent[] = []` per invocation.
- [x] 5.2 Pass `onEvent: (e) => events.push(e)` to `getSdk().sites.deployDir(...)`.
- [x] 5.3 On success, append a second content entry: `{ type: "text", text: "```json\n" + JSON.stringify(events, null, 2) + "\n```" }`.
- [x] 5.4 On `Run402Error` caught path, after `mapSdkError(err)` produces the error response, append the same fenced-events content block to the error response's content array (so the agent sees how far the deploy got).

## 6. MCP — Tests

- [x] 6.1 Update `src/tools/deploy-site-dir.test.ts`: happy-path response has 2 content entries; the second contains a parseable JSON array of events including a `plan` event.
- [x] 6.2 Test: failure path response has `isError: true` AND a content entry with the partial events array.

## 7. Docs

- [x] 7.1 In `SKILL.md`, in the `deploy_site_dir` MCP tool section, document the events block in the response and what the four phases mean.
- [x] 7.2 In `SKILL.md`, in the CLI section for `sites deploy-dir`, mention the JSON-line stderr stream and the `--quiet` flag.
- [x] 7.3 No `llms-cli.txt` update needed (lives in private repo per memory).

## 8. Verification

- [x] 8.1 Run `npm run build` cleanly.
- [x] 8.2 Run `npm test` — all unit tests including the new event tests pass.
- [x] 8.3 Run `npm run test:sync` — surface unchanged.
- [x] 8.4 Run `npm run test:e2e` — CLI e2e suite passes with the new event-stream assertions.
- [x] 8.5 Run `openspec validate deploy-dir-progress-events` and resolve any issues.
- [x] 8.6 Bump `@run402/sdk` and root `package.json` to v1.45.0 (skipped if separate publish flow handles versioning).

## 9. Archive

- [x] 9.1 Run `openspec archive deploy-dir-progress-events -y` to promote the ADDED requirements into `openspec/specs/deploy-dir/spec.md`.
