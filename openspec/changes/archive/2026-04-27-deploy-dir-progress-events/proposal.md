## Why

`NodeSites.deployDir` runs to completion silently. A typical large-site deploy walks files (fast), planning (one round trip), uploads N missing files (each a presigned-URL PUT, possibly with multipart parts), commits (one round trip), then polls for up to 10 minutes if Stage-2 copy is in progress. The agent invoking the deploy — whether via SDK directly, CLI, or MCP — has no visibility into which phase is running. For long deploys this is the difference between "the agent reports the deploy URL in 3 seconds" and "the agent appears hung for 4 minutes".

The phase tags already exist server-side as Bugsnag breadcrumbs (`plan`, `upload`, `commit`). Surfacing them client-side is purely additive instrumentation of work `deployDir` already does — no new endpoints, no request/response shape changes, no server-side state. Cost is one callback parameter and a handful of `onEvent?.(...)` call sites in `sites-node.ts`.

This is the second of the three Phase 1 agent-DX items handed off from the v1.32 backend cutover (item 1, `deployFile`, was descoped for a later cycle).

## What Changes

- Add a `DeployEvent` discriminated-union type to `@run402/sdk/node`'s exports, covering the four phases of `deployDir`:
  - `{ phase: "plan", manifest_size: number }` — fired once, immediately after `POST /deploy/v1/plan` returns.
  - `{ phase: "upload", file: string, sha256: string, done: number, total: number }` — fired once per *successfully uploaded* file (not per file in the manifest; files reported as `present` or `satisfied_by_plan` by the gateway are skipped). `done` is the count uploaded so far including this one; `total` is the count of files that needed upload.
  - `{ phase: "commit" }` — fired once, immediately before `POST /deploy/v1/commit`.
  - `{ phase: "poll", status: string, elapsed_ms: number }` — fired once per poll iteration when commit returned `copying`. `status` is the most recent gateway status; `elapsed_ms` is wall time since the first poll started.
- Add `onEvent?: (event: DeployEvent) => void` to `DeployDirOptions` in `sdk/src/node/sites-node.ts`. Optional. Synchronous. Errors thrown from the callback are swallowed so a buggy consumer can't break a deploy.
- The isomorphic `@run402/sdk` is unchanged — it still has no `deployDir`. `onEvent` lives only on the Node entry's `NodeSites`.
- **CLI**: `run402 sites deploy-dir` passes an `onEvent` that writes each event as a single-line JSON to `stderr` (`{"phase":"upload","file":"index.html",...}`). The final `{ status: "ok", deployment_id, url }` JSON envelope continues to go to `stdout`. A piping agent can `2>events.log` or process events line-by-line without parsing CLI output.
- **MCP**: `deploy_site_dir` passes an `onEvent` that buffers events. On success, the response `content` array contains the URL/id text plus a fenced-code-block JSON array of events the agent can read. On error, the buffered events are still surfaced (so the agent can see how far the deploy got before failing).
- No changes to `deploy_site` MCP tool, `bundle_deploy`, `blobs.put`, or any other deploy primitive — scope is strictly `sites.deployDir`.

## Capabilities

### New Capabilities

_None._ Events are an instrumentation enhancement to the existing `deploy-dir` capability.

### Modified Capabilities

- `deploy-dir`: extend the canonical spec with three new requirements covering SDK event emission, CLI stderr stream, and MCP content-array buffer.

## Impact

- **Modified files**:
  - `sdk/src/node/sites-node.ts` — add `DeployEvent` type, add `onEvent` option, instrument the four call sites.
  - `sdk/src/node/index.ts` — re-export `DeployEvent` type.
  - `sdk/src/node/sites-node.test.ts` — tests for each event variant + callback-throws-doesn't-break-deploy.
  - `cli/lib/sites.mjs` — pass `onEvent` to `sdk.sites.deployDir`, write JSON-line to stderr.
  - `src/tools/deploy-site-dir.ts` — pass `onEvent` to SDK, accumulate, append to content array.
  - `src/tools/deploy-site-dir.test.ts` — assert content array includes an events block.
  - `cli-e2e.test.mjs` — assert stderr contains JSON event lines on a happy-path deploy.
  - `SKILL.md` — describe `onEvent` on the `deploy_site_dir` tool entry; mention CLI stderr stream in the CLI section.
- **No new files**.
- **No server changes**. The endpoints `POST /deploy/v1/plan`, `POST /deploy/v1/commit`, `GET /deployments/v1/:id`, and S3 PUTs are all called identically.
- **No breaking changes**. `onEvent` is optional; existing callers that don't pass it observe identical behavior. `DeployDirOptions` widens, the `deployDir` return type and existing fields are unchanged.
- **No SURFACE / SDK_BY_CAPABILITY change** in `sync.test.ts`. Existing capability still maps to `sdk.sites.deployDir`; the option is additive.
- **No `@run402/sdk` major version bump** — minor version. Targets v1.45.0.
