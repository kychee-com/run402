## Why

Private gateway commits `86e6dc1b` and `6989694e` shipped first-class deploy observability: release inventory, current-live inventory, release-to-release diff, and updated plan/diff shapes. The public SDK, CLI, MCP, and docs still expose only partial stubs, so agents cannot reliably inspect what is live, compare releases, or type plan diffs against the shipped API contract.

This change closes that handoff by making the public client surfaces match the deployed `/deploy/v2/releases/*` API and by documenting the update path in `documentation.md`.

## What Changes

- Type the shipped deploy observability schemas in the SDK: release inventory, current-live inventory, release-to-release diff, plan diff buckets, warning entries, inventory site limits, and the distinct plan-vs-release migration shapes.
- Replace early `unknown` SDK stubs with project-aware methods for release inventory, active release inventory, and release diff.
- Add scoped-client wrappers so `r.project(id).deploy.getRelease(...)`, `active(...)`, and `diff(...)` automatically bind the project unless explicitly overridden.
- Add CLI commands for `run402 deploy release get`, `run402 deploy release active`, and `run402 deploy release diff`, including JSON stdout, active-project defaults, query flags, and help text.
- Add MCP tools for release inventory, active release inventory, and release diff, with Zod schemas and markdown output that preserves the JSON envelope for agent parsing.
- Update `sync.test.ts`, CLI/OpenClaw parity expectations, SDK tests, MCP tests, and help snapshots for the new surface.
- Update public docs flagged by `documentation.md`, and update `documentation.md` itself so future deploy-observability changes point at the correct SDK/CLI/MCP/doc surfaces.
- No breaking changes to `deploy.apply`, `deploy.start`, legacy deploy shims, or operation list/events/resume flows.

## Capabilities

### New Capabilities

- `deploy-observability-client-surface`: Typed public SDK, CLI, MCP, scoped-client, test, and documentation contract for deploy release inventory and release-to-release diff.

### Modified Capabilities

- None.

## Impact

- **SDK**: `sdk/src/namespaces/deploy.types.ts`, `sdk/src/namespaces/deploy.ts`, `sdk/src/scoped.ts`, root exports, type docs, and unit tests for endpoint paths, auth headers, query params, and shape typing.
- **CLI/OpenClaw**: `cli/lib/deploy-v2.mjs`, `cli/lib/deploy.mjs`, CLI help snapshots/e2e tests, `cli/llms-cli.txt`, and `openclaw/SKILL.md`.
- **MCP**: new or extended `src/tools/*` handlers, registration in `src/index.ts`, `llms-mcp.txt`, `SKILL.md`, and tool tests.
- **Sync/docs**: `sync.test.ts` `SURFACE` and `SDK_BY_CAPABILITY`, `sdk/llms-sdk.txt`, `sdk/README.md`, `README.md`, `AGENTS.md` if namespace/method counts or deploy primitive docs change, and `documentation.md` checklist rows.
- **Private coordination**: private `site/openapi.json`, `site/llms-full.txt`, `site/updates.txt`, and changelog were already updated by `6989694e`; public docs should cite the same endpoint names and semantics rather than inventing a divergent client contract.
- **Testing**: focused SDK request tests, scoped drift tests, CLI help/e2e tests, MCP tool tests, `npm run test:sync`, `npm run test:skill`, and at least the deploy-related unit test files touched by the implementation.
