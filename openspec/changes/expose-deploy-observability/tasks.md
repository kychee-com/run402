## 1. SDK Types And Endpoint Methods

- [x] 1.1 Copy/confirm exact inventory and diff schemas from the private OpenAPI before coding, including `content_sha256`, `effective`, `site_limit`, and release-diff `limit` semantics.
- [x] 1.2 Add `ActiveReleaseInventory`, `ReleaseSnapshotInventory`, `ReleaseInventory`, `ReleaseToReleaseDiff`, resource diff, site/function/migration entry, and deploy-observability warning types in `sdk/src/namespaces/deploy.types.ts`.
- [x] 1.3 Update plan/diff types so release-to-release diffs use `applied_between_releases` and modern successful plan diff docs/types do not expose migration mismatch as a normal success bucket, while preserving legacy flag-off plan compatibility.
- [x] 1.4 Replace `Deploy.getRelease` and `Deploy.diff` `unknown` stubs with project-aware typed methods that send apikey auth, URL-encode path/query values, and support `siteLimit` / `limit`.
- [x] 1.5 Add `Deploy.getActiveRelease` for `/deploy/v2/releases/active`.
- [x] 1.6 Add deprecated overloads or runtime-local-error handling for existing no-project `getRelease(releaseId)` / `diff({ from, to })` stub call shapes.
- [x] 1.7 Update `ScopedDeploy` wrappers so scoped clients bind project ids and preserve explicit project overrides for `getRelease`, `getActiveRelease`, and `diff`.
- [x] 1.8 Add SDK unit/type tests for endpoint paths, apikey headers, URL encoding, scoped binding/override, `state_kind`, release diff migrations, and no `secrets.changed`.

## 2. CLI Commands

- [x] 2.1 Add `run402 deploy release get <release_id> [--project <id>] [--site-limit <n>]` implementation and help text.
- [x] 2.2 Add `run402 deploy release active [--project <id>] [--site-limit <n>]` implementation and help text that explains current-live semantics.
- [x] 2.3 Add `run402 deploy release diff --from <release_id|empty|active> --to <release_id|active> [--project <id>] [--limit <n>]` implementation and help text.
- [x] 2.4 Wrap CLI success payloads as `{ status: "ok", release: ... }` or `{ status: "ok", diff: ... }` so the gateway inventory `status` field is not overwritten.
- [x] 2.5 Add CLI help/e2e tests and snapshots for the three release commands, active-project defaults, required args, and JSON stdout envelopes.
- [x] 2.6 Update deploy command dispatch/help so `release` subcommands are discoverable without breaking existing `apply`, `resume`, `list`, `events`, or legacy deploy usage.

## 3. MCP Tools

- [x] 3.1 Add Zod schemas and handlers for `deploy_release_get`, `deploy_release_active`, and `deploy_release_diff`.
- [x] 3.2 Register the new MCP tools in `src/index.ts` with descriptions that call out active current-live state, release snapshot state, diff selectors, and feature-flag 501 behavior.
- [x] 3.3 Format MCP success responses with a short summary plus a fenced `json` block containing the full gateway envelope.
- [x] 3.4 Add MCP handler tests for all three tools, including warning preservation on release diff and SDK error mapping.
- [x] 3.5 Confirm the new MCP read tools do not use mutating deploy allowance-auth gating and preserve canonical gateway errors for semantic diff failures.

## 4. Sync, OpenClaw, And Docs

- [x] 4.1 Update `sync.test.ts` `SURFACE` and `SDK_BY_CAPABILITY` entries for release get, active, and diff across SDK, CLI, MCP, and OpenClaw parity.
- [x] 4.2 Update `cli/llms-cli.txt`, `cli/README.md`, and `openclaw/SKILL.md` with the new deploy release commands.
- [x] 4.3 Update `sdk/llms-sdk.txt` and `sdk/README.md` with release inventory/diff methods, `state_kind`, diff target selectors, and plan/diff type notes.
- [x] 4.4 Update `llms-mcp.txt` and root `SKILL.md` with the new MCP tools and read-only warning behavior.
- [x] 4.5 Update root `README.md` and `AGENTS.md` only where deploy namespace/tool tables or architecture text need to mention release observability.
- [x] 4.6 Update `documentation.md` with a deploy release observability checklist row covering public SDK/CLI/MCP/docs and private API docs/changelog coordination.

## 5. Verification

- [x] 5.1 Run focused SDK deploy tests and real type-checking for type-drift tests (`tsc --noEmit`, `npm run build`, or equivalent; not `tsx` only).
- [x] 5.2 Run focused CLI help/e2e tests for deploy release commands.
- [x] 5.3 Run focused MCP tool tests.
- [x] 5.4 Run `npm run test:sync`.
- [x] 5.5 Run `npm run test:skill`.
- [x] 5.6 Run `npm run build` or the narrower build targets needed by touched packages.
- [x] 5.7 Document any skipped staging/runtime checks for `FEATURE_DISABLED`, `NO_ACTIVE_RELEASE`, `DIFF_SAME_RELEASE`, and `INVALID_DIFF_TARGET`.

Skipped staging/runtime checks: no live gateway or staging project was exercised in this public-repo pass. `FEATURE_DISABLED`, `NO_ACTIVE_RELEASE`, `DIFF_SAME_RELEASE`, and `INVALID_DIFF_TARGET` are covered here through typed SDK/MCP/CLI error-preservation paths and mock routing only; they should be smoke-tested against staging after the private API deployment is available.
