## Context

Private gateway commit `86e6dc1b` shipped deploy observability for `/deploy/v2`: release inventory by id, active current-live inventory, release-to-release diff, snapshot-backed materialization, patch-conflict validation, and feature flags. Commit `6989694e` updated the private OpenAPI and public-site API docs for those endpoints.

The public repo already has a unified deploy SDK namespace and CLI/MCP shims, but the observability surface is incomplete:

- `sdk/src/namespaces/deploy.ts` has early `getRelease(releaseId): Promise<unknown>` and `diff({ from, to }): Promise<unknown>` stubs.
- Those stubs do not pass project apikey auth, even though the shipped endpoints use apikey auth and project scoping.
- There is no typed SDK method for `/deploy/v2/releases/active`.
- CLI has operation-oriented deploy commands (`apply`, `resume`, `list`, `events`) but no release inventory/diff commands.
- MCP exposes the mutating `deploy` tool but no read-only release observability tools.
- `documentation.md` correctly tells agents to update SDK/CLI/MCP docs for new surfaces, but it does not yet call out deploy release observability as a specific checklist path.

The private handoff also notes that the major plan-response reshape is feature-flagged by `DEPLOY_PLAN_DIFF_V2_ENABLED`. The public client should type the new observability shapes and be ready for the plan diff update, while keeping current production plan responses compatible until that flag flips.

## Goals / Non-Goals

**Goals:**

- Add gateway-exact SDK types for release inventory, active inventory, release-to-release diff, resource diff buckets, inventory entries, and deploy-observability warning entries.
- Replace `unknown` release stubs with project-aware SDK methods that send apikey auth and support `site_limit` / `limit` query params.
- Add scoped-client wrappers so project-bound code can call release observability methods without repeating the project id.
- Add CLI commands under the existing deploy command group: `run402 deploy release get`, `run402 deploy release active`, and `run402 deploy release diff`.
- Add MCP tools named for the deploy release surface: `deploy_release_get`, `deploy_release_active`, and `deploy_release_diff`.
- Update plan/diff typing so release-to-release diffs use the monotonic `migrations.applied_between_releases` shape and successful modern plan diff shapes do not teach a `mismatch` bucket as a normal success path, without breaking current flag-off plan responses.
- Update sync tests, help snapshots, docs, skill files, and `documentation.md`.

**Non-Goals:**

- No gateway/database/feature-flag implementation; the backend is treated as shipped in the private repo.
- No client-side snapshot reconstruction or release diff computation; SDK, CLI, and MCP call the gateway.
- No new top-level `run402 release` command in this slice; grouping stays under `deploy` to fit current CLI structure and avoid another top-level dispatch surface.
- No mutation or confirmation workflow for diff warnings; release diff is read-only and returns structured warnings for the caller to inspect.
- No unconditional switch to a future flat plan response while `DEPLOY_PLAN_DIFF_V2_ENABLED` remains off by default.
- No runtime staging integration tests in ordinary `npm test`; any staging checks stay opt-in integration tests.

## Decisions

### D1. Keep release observability inside the deploy namespace

The SDK methods live on `r.deploy` and scoped clients expose the same shape through `r.project(id).deploy`. The CLI commands live under `run402 deploy release ...`, and MCP tool names use the `deploy_release_*` prefix.

This keeps the public surface near existing deploy operations and avoids adding a standalone `release` namespace before there is broader non-deploy release lifecycle management.

Alternatives considered:

- Add a new SDK `releases` namespace and `run402 release` top-level command: clearer in isolation, but it increases namespace and command churn for a three-endpoint deploy-only surface.
- Leave SDK methods as bare `getRelease` and `diff` without project auth: rejected because the shipped routes require apikey auth and project scoping.

### D2. Root SDK methods are project-aware; scoped methods bind project

Root methods should accept explicit project context:

```ts
r.deploy.getRelease({ project, releaseId, siteLimit? })
r.deploy.getActiveRelease({ project, siteLimit? })
r.deploy.diff({ project, from, to, limit? })
```

For compatibility with the existing early stub, `getRelease(releaseId, { project, siteLimit? })` can remain as an overload if implementation cost is low, but calls without a project should fail locally with `LocalError` instead of making an unauthenticated request that becomes a confusing gateway 401.

The design considered clearer aliases such as `getReleaseInventory`, `getActiveReleaseInventory`, and `diffReleases`. The first implementation should avoid expanding the method surface unless implementation reveals a real ambiguity; instead, use precise return type names and documentation to carry the "inventory" and "release-to-release" semantics.

Scoped methods bind the project:

```ts
const p = r.project("prj_...");
await p.deploy.getRelease("rel_...");
await p.deploy.getActiveRelease();
await p.deploy.diff({ from: "empty", to: "active" });
```

The scoped wrapper should preserve explicit override-friendly behavior where practical, matching the rest of `ScopedDeploy`.

### D3. Types mirror the shipped endpoint semantics

`ReleaseInventory` is a discriminated envelope with `kind: "release_inventory"` and `state_kind`:

- `current_live` for `/deploy/v2/releases/active`, which reads live tables and can reflect secret changes after activation.
- `effective` for active/superseded release snapshots returned by `/deploy/v2/releases/{id}`.
- `desired_manifest` for failed/staged release inventory where the desired manifest is materialized but was not activated.

The SDK should model this as a union:

```ts
type ActiveReleaseInventory = ReleaseInventoryBase & {
  state_kind: "current_live";
};

type ReleaseSnapshotInventory = ReleaseInventoryBase & {
  state_kind: "effective" | "desired_manifest";
};

type ReleaseInventory = ActiveReleaseInventory | ReleaseSnapshotInventory;
```

`getActiveRelease` returns `ActiveReleaseInventory`; `getRelease` returns `ReleaseSnapshotInventory`. This makes the current-live versus activation-time distinction enforceable in TypeScript rather than only prose.

`ReleaseToReleaseDiff` is separate from plan diff types. Its migrations block is only `{ applied_between_releases: string[] }`; it must not expose plan-only `new`, `noop`, or `mismatch` fields. Its `secrets` block has `added` and `removed` only. In release diff selectors, the literal `active` resolves to the gateway's current-live materialized state, not necessarily an activation-time snapshot.

Plan diff types should stop presenting migration mismatch as an ordinary success bucket in the modern observability type surface. Until the gateway flips `DEPLOY_PLAN_DIFF_V2_ENABLED`, the SDK should keep a legacy-compatible plan diff union or loose legacy bucket for older responses, but new docs and examples should teach that checksum mismatch is handled as `Run402DeployError` with code `MIGRATION_CHECKSUM_MISMATCH`.

Do not globally narrow the existing exported `WarningEntry` type yet. Add a deploy-observability warning type with the shipped shape (`severity: "info" | "warn" | "high"`, `affected: string[]`, `confidence?: "heuristic"`) and keep legacy plan warning compatibility until the plan-diff-v2 rollout is complete.

### D4. CLI outputs JSON envelopes without lossy formatting

The new commands should default to the active project and print JSON on stdout:

```txt
run402 deploy release get <release_id> [--project <id>] [--site-limit <n>]
run402 deploy release active [--project <id>] [--site-limit <n>]
run402 deploy release diff --from <release_id|empty|active> --to <release_id|active> [--project <id>] [--limit <n>]
```

Each command should print a non-lossy wrapper that avoids colliding with the gateway inventory's own `status` field:

```json
{ "status": "ok", "release": { "...": "ReleaseInventory" } }
{ "status": "ok", "diff": { "...": "ReleaseToReleaseDiff" } }
```

Errors should flow through `reportSdkError`, preserving 501 `FEATURE_DISABLED`, 404 `NO_ACTIVE_RELEASE` / `RESOURCE_NOT_FOUND`, 400 `DIFF_SAME_RELEASE`, and 400 `INVALID_DIFF_TARGET`.

CLI help must call out that `active` is current-live state, not the activation-time snapshot for the active release id.

### D5. MCP tools preserve machine-readable JSON

MCP tools should be thin SDK shims:

- `deploy_release_get(project_id, release_id, site_limit?)`
- `deploy_release_active(project_id, site_limit?)`
- `deploy_release_diff(project_id, from, to, limit?)`

The returned markdown should include a short human summary and a fenced JSON body containing the full typed envelope. Non-mutating diff warnings with `requires_confirmation` should be shown, but the tool should not block or ask for confirmation because no commit is performed.

The tools should validate syntax locally but let the gateway return semantic diff errors such as `DIFF_SAME_RELEASE` and `INVALID_DIFF_TARGET`, so agents see the canonical error codes.

### D6. Documentation and sync are release blockers

`sync.test.ts` is the drift gate for SDK/CLI/OpenClaw/MCP parity, so the new release observability commands/tools must be represented in `SURFACE` and `SDK_BY_CAPABILITY`. `documentation.md` should gain a specific deploy-observability checklist so future changes to `/deploy/v2/releases/*` point maintainers to SDK types, CLI/MCP tools, `llms*.txt`, skills, README surfaces, and private site docs.

Minimum doc updates during implementation:

- `sdk/README.md` and `sdk/llms-sdk.txt`
- `cli/README.md` and `cli/llms-cli.txt`
- `llms-mcp.txt` and root `SKILL.md`
- `openclaw/SKILL.md`
- root `README.md` if the deploy tool table or examples mention observability
- `AGENTS.md` if deploy architecture text changes
- `documentation.md`

## Risks / Trade-offs

[Risk: shipping SDK methods that still omit project auth] -> Mitigation: root methods require project context, scoped methods bind project, and tests assert apikey headers are sent.

[Risk: clients confuse `/releases/active` with `/releases/{active_id}`] -> Mitigation: type and document `state_kind`, include CLI/MCP help text that calls out current-live versus activation-time snapshot semantics.

[Risk: plan diff types break current production responses while the flag is off] -> Mitigation: use a compatibility union or legacy bucket for current plan responses, but teach the modern success shape and hard-error mismatch behavior in docs.

[Risk: CLI output overwrites the gateway's release `status` field] -> Mitigation: wrap success payloads under `release` or `diff` instead of spreading the gateway envelope next to CLI `status: "ok"`.

[Risk: docs drift between private OpenAPI and public clients] -> Mitigation: base types on the shipped route/handoff semantics from `86e6dc1b`, and update `documentation.md` with a deploy-observability row that includes private-doc coordination.

[Risk: feature flag off looks like a missing endpoint] -> Mitigation: preserve JSON 501 `FEATURE_DISABLED` through SDK/CLI/MCP formatting and add tests that assert the error envelope is not treated as HTML 404.
