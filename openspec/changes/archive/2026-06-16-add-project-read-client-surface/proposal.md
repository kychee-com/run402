## Why

The gateway shipped an authoritative single-project read — `GET /projects/v1/:project_id` (run402-private, `3e60da4b`) — returning a server-side project view the client cannot assemble locally: live `effective_status`, `organization_lifecycle_state`, owning `org_id`, `tier`, the active release pointer (`last_deploy`), active mailbox addresses, custom domains, and usage-against-limits. Today the public client has no way to read it. `r.projects.info()` / `project_info` / `projects info` only combine the project id with locally-cached keys and explicitly **never call the API** — so an agent asking "is this project healthy, what's deployed, how much quota is used, which org owns it" has no client surface for the answer. The gateway commit itself flags the SDK/CLI/MCP wire-up as the gateway-last follow-up.

## What Changes

- **NEW — `r.projects.get(id)` authoritative server read.** Wraps `GET /projects/v1/:project_id`, returning a typed `ProjectDetail`: `project_id`, `public_id`, `name`, `org_id`, `tier`, `effective_status`, `organization_lifecycle_state`, `site_url`, `custom_domains[]`, `last_deploy` (`{ release_id, activated_at } | null`), `mailbox[]` (active addresses), `usage` (`{ api_calls, storage_bytes, api_calls_limit, storage_bytes_limit }`), `created_at`. Authed with the default wallet/control-plane credential — the endpoint needs **no project keys** and never returns secrets.
- **NEW — authorize-before-reveal mapping.** The gateway returns `403` (never `404`) for both unauthorized callers and the post-authz deleted/archived race. The SDK maps this to `Unauthorized` so a non-owner cannot distinguish "exists but not yours" from "absent" — no existence oracle.
- **NEW — `(await r.project(id)).projects.get()` scoped wrapper** mirroring the existing scoped `.projects.info()` / `.projects.rename()` shape (project-scoped methods live on the `ScopedProjects` sub-namespace); the `scoped.test.ts` drift guard requires it.
- **NEW — MCP `project_get` tool** and **CLI `run402 projects get <id>`** (JSON-out; OpenClaw inherits via the existing `projects` re-export) that surface the authoritative view.
- **UNCHANGED — local `info` / `keys` stay offline.** `r.projects.info()` / `project_info` (id + cached keys, no API call) and `r.projects.keys()` / `project_keys` are deliberately **not** rewired: they are the offline "how do I connect right after `provision`" primitive, and the new endpoint returns no keys, so it cannot replace them. `design.md` records the considered alternative (rewire `project_info` to the server) and why a distinct `get` verb is the better DX.
- **Docs + sync:** `cli/llms-cli.txt` and `sdk/llms-sdk.txt` gain the `get` verb and the `ProjectDetail` shape; `sync.test.ts` `SURFACE` + `SDK_BY_CAPABILITY` gain `project_get` → `projects.get` mapped to `GET /projects/v1/:project_id`; `sdk-public-type-surface` exports `ProjectDetail`.

## Capabilities

### New Capabilities
- `project-read-client-surface`: the client surface for the authoritative single-project read — the `r.projects.get(id)` / `r.project(id).get()` SDK methods, the `ProjectDetail` shape, the no-keys authorize-before-reveal contract, the local-`info`/`keys`-stay-offline boundary, and the `project_get` MCP tool + `projects get` CLI/OpenClaw verb. Spans SDK, CLI, MCP, and docs.

### Modified Capabilities
<!-- None. No project-management capability spec exists in openspec/specs/ today — the local info/keys surface shipped without one, so all behavior here is ADDED. `sdk-public-type-surface` and `sdk-interface-api-coverage` stay satisfied via tasks (export the new type, add the SURFACE row), not requirement changes. -->

## Impact

- **SDK (`sdk/src/`):** add `get(id)` to `namespaces/projects.ts`; add `ProjectDetail` (+ `ProjectLastDeploy`, `ProjectUsageWithLimits`) to `projects.types.ts`; add the `r.project(id).get()` wrapper in `scoped.ts`; export `ProjectDetail` from the public type-surface entry.
- **MCP (`src/tools/`):** new `project-get.ts` (Zod `{ project_id }` + markdown render via `mapSdkError`); register in `index.ts`.
- **CLI (`cli/lib/`):** add `get` subcommand to `projects.mjs` (JSON-out, agent-first); help-text + snapshot.
- **OpenClaw (`openclaw/scripts/`):** `projects` shim already re-exports the CLI lib — inherits `get` automatically; confirm command-set parity in `sync.test.ts`.
- **Tests:** `sync.test.ts` `SURFACE` + `SDK_BY_CAPABILITY` (+ orphan check); `scoped.test.ts` drift guard picks up `get`; SDK unit test (mock fetch, assert path + 403→`Unauthorized`); CLI e2e + help snapshot (new e2e file added to the `package.json` test allow-list so it doesn't silently skip CI).
- **Docs:** `cli/llms-cli.txt`, `sdk/llms-sdk.txt` (canonical; the private site pulls them at deploy).
- **Cross-repo:** gateway already shipped (`3e60da4b`, run402-private); the client ships independently. No gateway changes required.
