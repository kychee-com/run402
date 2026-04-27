## Why

Agents deploying a static site today must walk the filesystem themselves, detect which files are binary, base64-encode them, and assemble the `SiteFile[]` manifest before calling `sites.deploy()`. Every caller — MCP agents, CLI users, sandboxed code — reimplements the same boilerplate. A single high-level helper that takes a directory path and does the right thing eliminates that duplication and gives agents a "directory in, URL out" primitive. This is the smallest agent-DX improvement we can ship with zero server changes, and it lays the groundwork for later steps (blob-backed large-file uploads, hash-based dedup) without committing to them yet.

## What Changes

- Add `sites.deployDir({ project, dir, inherit? })` to the **Node** SDK entry point (`@run402/sdk/node`). It walks `dir`, reads each file, auto-detects binary vs. UTF-8 (base64-encoding binaries), assembles a `SiteFile[]` manifest, and delegates to the existing isomorphic `Sites.deploy()` method.
- The method lives in Node only because directory traversal requires `node:fs/promises`, which is unavailable in V8 isolates. The isomorphic `sites.deploy(files)` signature is untouched — sandbox callers continue passing an in-memory files array.
- Add a new MCP tool `deploy_site_dir` with schema `{ project, dir, inherit? }`. It is a thin shim over `getSdk().sites.deployDir(...)`.
- Add a new CLI subcommand `run402 sites deploy-dir <path> --project <id> [--inherit]`. It is a thin shim over `sdk.sites.deployDir(...)` and emits the existing JSON envelope.
- Add the new MCP tool and CLI subcommand to `sync.test.ts`'s `SURFACE` array and `SDK_BY_CAPABILITY` map.
- Document the new surface in `SKILL.md` alongside the existing `deploy_site` tool.
- **Not in scope**: server-side changes, the 200 MB payload ceiling (the helper inherits the same limit as the underlying `sites.deploy`), blob-backed uploads, hash-based dedup, any database or bundle-deploy work. Those are later rungs of the agent-DX ladder and will land as separate changes.

## Capabilities

### New Capabilities

- `deploy-dir`: A "directory in, URL out" helper on the Node SDK, the MCP server, and the CLI that assembles the existing inline `SiteFile[]` manifest from a filesystem directory. Covers the Node-only scoping, the binary auto-detection rules, the MCP tool contract, the CLI subcommand contract, and error propagation when the directory is unreadable or empty.

### Modified Capabilities

_None._ The existing `sites.deploy()` SDK method, the existing `deploy_site` MCP tool, and the existing `sites deploy` CLI subcommand retain their current behavior and signatures. The helper is purely additive.

## Impact

- **New files**: `sdk/src/node/sites-node.ts` (the `deployDir` implementation), `sdk/src/node/sites-node.test.ts` (unit tests for dir walk + binary detection), `src/tools/deploy-site-dir.ts` (MCP tool), `src/tools/deploy-site-dir.test.ts`, `cli/lib/sites.mjs` gets a new subcommand block, `openclaw/scripts/` inherits via existing re-export pattern.
- **Modified files**: `sdk/src/node/index.ts` (wire `NodeSites` into the Node `Run402` factory or attach `deployDir` at construction), `src/index.ts` (register the new MCP tool), `sync.test.ts` (extend `SURFACE` + `SDK_BY_CAPABILITY`), `SKILL.md` (document the new tool/command).
- **No server changes**. The helper POSTs to the existing `/deployments/v1` endpoint using the existing payload shape. Payload size limits are inherited unchanged.
- **No breaking changes**. All existing SDK methods, MCP tools, and CLI commands retain identical signatures and behavior.
- **Dependencies**: no new runtime dependencies. Uses `node:fs/promises`, `node:path`, and the standard library's `Buffer` for base64 encoding — all already available in Node 22.
- **Agent-visible surface**: agents gain one MCP tool (`deploy_site_dir`) and one SDK method (`sdk.sites.deployDir`). The existing `deploy_site` tool and `sites.deploy` SDK method continue to exist unchanged.
