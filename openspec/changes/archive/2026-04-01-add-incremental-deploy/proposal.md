## Why

The Run402 gateway now supports incremental deploys via `inherit: true` on both `POST /deployments/v1` and `POST /deploy/v1`. When set, only changed files need uploading - unchanged files are copied server-side from the previous deployment via S3 CopyObject (instant). This is already live on the backend but the MCP tools, CLI, and OpenClaw don't expose the parameter yet, so agents always re-upload every file on every deploy.

Additionally, the upload response now includes a `url` field with a public URL (`/storage/v1/public/:project_id/:bucket/*`), but the `upload_file` MCP tool doesn't display it.

## What Changes

- Add optional `inherit` boolean to `deploy_site` MCP tool schema and pass it to the API
- Add optional `inherit` boolean to `bundle_deploy` MCP tool schema and pass it to the API
- Add `--inherit` flag to CLI `sites deploy` command
- CLI `deploy` already passes the full manifest through, so `inherit: true` in the manifest works automatically - just needs documentation
- Show `url` field in `upload_file` MCP tool response when present
- Update CLI `sites deploy` help text to document the `--inherit` flag

## Capabilities

### New Capabilities

_None - this modifies existing capabilities._

### Modified Capabilities

- `incremental-deploy`: Add `inherit` parameter to deploy_site and bundle_deploy tools, and display public URL in upload_file response

## Impact

- **MCP server** (`src/tools/`): Modified `deploy-site.ts`, `bundle-deploy.ts`, `upload-file.ts`
- **CLI** (`cli/lib/`): Modified `sites.mjs` (add `--inherit` flag), `deploy.mjs` (help text only)
- **OpenClaw**: No changes - shims re-export from CLI
- **Sync test**: No changes - no new tools, just new parameters on existing tools
- **Dependencies**: None
