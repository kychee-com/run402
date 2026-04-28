## Why

The private gateway repo (`kychee-com/run402-private`) executed a big-bang sunset of the legacy storage shim on **2026-04-28**, four weeks ahead of the original `2026-06-01` deadline ([kychee-com/run402#120](https://github.com/kychee-com/run402/issues/120)). The legacy `/storage/v1/object/*` routes now 404 because the shim's write path silently broke v1.33 CDN serving. The four MCP tools (`upload_file`, `download_file`, `list_files`, `delete_file`) and the CLI `run402 storage` subcommand in this repo are still registered and pointed at those URLs.

There are no paying customers and no carrying cost for back-compat. The position is **clean slate**: delete every reference to the legacy surface from the public repo. New agents will read new docs; they will never know the old surface existed. No migration tables, no "supersedes" mentions, no redirector stubs. The five `blob_*` MCP tools and `run402 blob` CLI subcommand stand on their own.

## What Changes

- **BREAKING** Delete the four legacy MCP tools (`upload_file`, `download_file`, `list_files`, `delete_file`) — handlers, registrations, tests, imports.
- **BREAKING** Delete the CLI `run402 storage` subcommand — module, dispatcher case, HELP entry. Falls through to the generic "unknown subcommand" path.
- **Strip** every "Supersedes `<old_tool>` (deprecated)" mention from `src/index.ts` `blob_*` tool descriptions. The new tools are documented in their own terms — what they do, not what they replace.
- **Strip** every legacy reference from docs: `SKILL.md`, `README.md`, `README.zh-CN.md`, `openclaw/SKILL.md`, `cli/llms-cli.txt`. Drop tool-table rows, drop deprecated sections, drop "(deprecated)" callouts. No migration tables added.
- Update `sync.test.ts` `SURFACE` to drop the four legacy entries and remove the `SDK_BY_CAPABILITY` `null` placeholders. Re-pin assertions against the simplified private-repo `site/llms.txt`. Audit `SKILL.test.ts` for any pinned legacy tool names and remove them.
- Audit the active `add-run402-sdk` change's `tasks.md` and mark obsolete the lines describing legacy storage carve-outs (tasks 6.1 and 9.5).
- Bump `run402-mcp` to **v0.3.0** (semver minor in 0.x — tools are removed). Bump `run402` CLI accordingly.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `incremental-deploy`: REMOVE the *Upload file shows public URL* requirement. The `upload_file` tool it describes is being deleted; the requirement no longer corresponds to a live tool. The replacement `blob_put` is covered by its own implementation, not by this spec.

## Impact

- **Deleted files**: `src/tools/upload-file.ts`, `src/tools/download-file.ts`, `src/tools/list-files.ts`, `src/tools/delete-file.ts`, `src/tools/upload-file.test.ts`, `cli/lib/storage.mjs`, `openclaw/scripts/storage.mjs`.
- **Modified files**: `src/index.ts` (drop 4 imports + 4 registrations + section banner; strip "supersedes" mentions from `blob_*` descriptions); `cli/cli.mjs` (drop dispatcher case + HELP entry); `SKILL.md`, `README.md`, `README.zh-CN.md`, `openclaw/SKILL.md`, `cli/llms-cli.txt` (strip every legacy mention); `sync.test.ts`, `SKILL.test.ts`; `package.json` version bumps; `openspec/changes/add-run402-sdk/tasks.md` (mark obsolete lines).
- **Spec change**: `openspec/specs/incremental-deploy/spec.md` loses the *Upload file shows public URL* requirement (3 scenarios).
- **Runtime impact**: agents calling the four legacy MCP tool names get "tool not found" from the MCP server. Agents typing `run402 storage upload ...` get the CLI's generic "unknown subcommand" message. Both are honest signals; neither tries to bridge to the new surface.
- **No SDK changes**. `sdk/src/namespaces/blobs.ts` already uses the new `POST /storage/v1/uploads` flow; no legacy refs in `sdk/src/`.
- **Backward compatibility**: explicitly broken. No paying customers; no migration support promised.
