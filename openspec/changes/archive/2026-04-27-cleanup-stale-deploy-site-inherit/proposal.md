## Why

The `incremental-deploy` spec was authored when `deploy_site` and `sites deploy` accepted an `inherit: true` flag that the gateway interpreted as "copy unchanged files from the previous deployment". That mechanism is gone:

- The endpoint `POST /deployments/v1` returns **410 Gone** as of the v1.32 backend cutover (2026-04-26). Inline-bytes deploys no longer exist server-side.
- The MCP tool `deploy_site` (`src/tools/deploy-site.ts`) no longer exposes an `inherit` parameter in its Zod schema. Internally it stages the inline files into a temp directory and routes through `sites.deployDir`, which uses the v1.32 plan/commit transport.
- The CLI `sites deploy` and `sites deploy-dir` (`cli/lib/sites.mjs`) actively **reject** `--inherit` with an error message: `"--inherit is removed in v1.32; the SDK now uploads only changed files automatically."`

The "incremental" effect is now achieved transparently by the plan/commit transport's CAS dedup — the gateway only requests bytes it doesn't already have. There is no flag for callers to set or omit.

Two of the five requirements in the existing `incremental-deploy` spec describe the removed mechanism. Leaving them in place misleads future readers and contradicts the shipped surface.

## What Changes

- **REMOVE** the `incremental-deploy` requirement *Deploy a static site* (the `deploy_site`-with-`inherit` requirement). The MCP tool no longer accepts the parameter and the underlying endpoint is 410 Gone.
- **REMOVE** the `incremental-deploy` requirement *CLI sites deploy with --inherit flag*. The CLI now rejects this flag with an explicit error.
- **Keep** the three remaining requirements unchanged (they still describe live behavior):
  - *Bundle deploy with inherit* — `bundle_deploy` MCP tool still accepts `inherit` and forwards it to `POST /deploy/v1` (the bundle deploy endpoint, untouched by v1.32).
  - *Upload file shows public URL* — `upload_file` still surfaces the response `url` field.
  - *CLI deploy manifest supports inherit* — the bundle-deploy-via-CLI manifest schema still passes `inherit` through.
- No code changes. The surfaces being removed from the spec are already removed/rejected in code; this change only realigns the spec with reality.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `incremental-deploy`: drop the two requirements describing the removed `inherit`-on-static-site mechanism; the spec retains its bundle-deploy and upload-file requirements.

## Impact

- **Modified files**: `openspec/specs/incremental-deploy/spec.md` (remove two requirement blocks).
- **No code changes**. The MCP/CLI/SDK surfaces have already been updated; v1.42.0–v1.44.0 shipped them.
- **No breaking changes**. The user-facing behavior was already removed in v1.32 / v1.44.0; this is a pure spec sync.
- **Follow-up**: A separate change (`add-deploy-dir` in `openspec/changes/`) will be archived alongside this one to promote its `deploy-dir` capability into `openspec/specs/`.
