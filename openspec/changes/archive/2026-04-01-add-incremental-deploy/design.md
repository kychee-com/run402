## Context

The backend already implements incremental deploys. When `inherit: true` is sent in the deploy request body, the server looks up the most recent deployment for that project and copies all files not present in the new upload via S3 CopyObject. This is server-side and instant - no extra bandwidth or time. The public repo tools just need to pass this flag through.

The upload response also now includes a `url` field (public URL) that the `upload_file` tool should display.

## Goals / Non-Goals

**Goals:**
- Expose `inherit` as an optional boolean on `deploy_site` and `bundle_deploy` MCP tools
- Add `--inherit` CLI flag for `sites deploy`
- Show `url` in `upload_file` response when the API returns it
- Keep the parameter optional - default behavior (no inherit) is unchanged

**Non-Goals:**
- Diffing files client-side to determine what changed (the server handles this)
- Any new API endpoints or tools
- Public storage URL as a separate tool (it's just a field in the upload response)

## Decisions

### 1. Optional boolean parameter, defaults to undefined (not sent)

When `inherit` is omitted, the request body doesn't include it, preserving backward compatibility. When `true`, it's included. No need to send `false` explicitly.

### 2. No changes to deploy CLI module

`cli/lib/deploy.mjs` already passes the entire manifest JSON through to `/deploy/v1`. If the manifest includes `"inherit": true`, it's sent automatically. Only the help text needs updating to document this.

### 3. Show `url` field in upload_file only when present

The `url` field is new in the API response. Display it in the MCP tool output when present, skip it when absent (backward compatible with older server versions).

## Risks / Trade-offs

- **[Older server versions]** If someone runs this MCP version against an older gateway that doesn't support `inherit`, the server ignores unknown fields - no breakage. → No mitigation needed.
