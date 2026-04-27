## REMOVED Requirements

### Requirement: Deploy a static site

**Reason**: Removed in v1.32 cutover (2026-04-26). The endpoint `POST /deployments/v1` returns 410 Gone; the `deploy_site` MCP tool no longer exposes an `inherit` parameter in its Zod schema (`src/tools/deploy-site.ts`). The "copy unchanged files from previous deployment" effect is now achieved transparently by the v1.32 plan/commit transport's CAS dedup — the gateway only requests bytes it doesn't already have.

**Migration**: Drop the `inherit` argument from any `deploy_site` call. Re-deploy the same set of files; the SDK's plan/commit transport will skip uploads for files whose SHA-256 is already present in CAS. For deploying from a directory rather than an inline manifest, prefer `deploy_site_dir` (added in v1.42.0).

### Requirement: CLI sites deploy with --inherit flag

**Reason**: Removed in v1.32 cutover. The CLI commands `run402 sites deploy` and `run402 sites deploy-dir` actively reject `--inherit` with an error: `"--inherit is removed in v1.32; the SDK now uploads only changed files automatically."` (`cli/lib/sites.mjs`).

**Migration**: Drop `--inherit` from invocation. Re-deploys of an unchanged tree make no S3 PUTs because the plan/commit transport detects identical bytes via SHA-256.
