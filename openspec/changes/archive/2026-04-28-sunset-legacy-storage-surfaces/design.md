## Context

The legacy storage shim was a compatibility layer dating to the pre-CAS storage era. It exposed bucket-scoped routes (`/storage/v1/object/{bucket}/{path}` and friends) that wrote bytes to S3 keyed by `<project_id>/<bucket>/<path>` and served them through the gateway's byte path. The v1.32 → v1.33 cutover replaced this with a content-addressed flow served exclusively from the CDN.

On `2026-04-28` the gateway team executed an immediate big-bang sunset (Option B) — the four MCP tools and one CLI subcommand in this repo became broken aliases that day.

This change is the public-repo half of that sunset. The position is **clean slate**: pre-revenue, no paying customers, no carrying cost for back-compat. The owner has explicitly waived migration windows, migration tables, and back-references. New agents will read new docs and discover the `blob_*` surface in its own terms; the legacy surface will not be acknowledged in any user-facing artifact.

## Goals / Non-Goals

**Goals:**

- Remove every reference to the four legacy MCP tools and the CLI `run402 storage` subcommand from the registered surface, source, docs, and tests. Leave nothing behind.
- Keep the `sync.test.ts` SURFACE table as the single source of truth — every removal lands there too, with the orphan check passing.
- Bump `run402-mcp` and `run402` CLI to a minor version that signals the breaking removal (semver minor pre-1.0).
- Leave the `incremental-deploy` spec internally consistent after the dependent requirement is removed.
- Treat the new docs as standalone — they describe what the `blob_*` tools and `run402 blob` subcommand do, not what they replace.

**Non-Goals:**

- Adding new functionality. The replacement `blob_*` tools have shipped (v1.42.x); no SDK or new tool work is needed.
- Migration tables, "Supersedes" callouts, redirector stubs, or any other bridge from the legacy surface to the new one. The clean-slate position is explicit.
- Editing archived OpenSpec changes. Historical record is left untouched.
- Touching the SDK (`sdk/src/`). It is already clean.
- Server-side work. The private-repo sunset has shipped; this change does not depend on additional gateway changes.

## Decisions

### Decision 1: Delete the four legacy MCP tools, no redirector stubs

**Choice**: Drop the imports, drop the `server.tool(...)` registrations, delete the four handler files and `upload-file.test.ts`. Agents calling the old tool names get standard "tool not found" from the MCP server.

**Alternative considered**: Keep registered as stubs returning a "tool retired" error.

**Why delete won**: A stub is a permanent dead entry in `tools/list` that perpetuates the appearance the tool exists. Clean slate means new agents see only the live surface.

### Decision 2: Delete the CLI `run402 storage` dispatcher entirely, no redirector

**Choice**: Delete `cli/lib/storage.mjs`, `openclaw/scripts/storage.mjs`, the `case "storage":` block in `cli/cli.mjs`, and the HELP entry. Agents typing `run402 storage upload ...` fall through to the dispatcher's generic "unknown subcommand" path.

**Alternative considered**: Leave a small JSON redirector that prints a structured "subcommand_retired" envelope with a 1:1 mapping.

**Why full delete won**: A redirector is a migration aid. Clean slate explicitly excludes migration aids. Generic "unknown subcommand" is the honest signal: this command does not exist.

### Decision 3: Strip "Supersedes <old_tool>" mentions from `blob_*` MCP tool descriptions

**Choice**: Edit each `blob_*` tool description in `src/index.ts` to remove the trailing back-reference (`This supersedes \`upload_file\`.` and the three siblings). The new descriptions document what each tool does in its own terms.

**Alternative considered**: Keep the back-references on the theory that agents from older training cuts benefit from a discoverability bridge.

**Why strip won**: The user has explicitly chosen to not optimize for legacy-name agents. New agents reading the new descriptions don't need to know what was there before.

### Decision 4: REMOVE the `incremental-deploy` "Upload file shows public URL" requirement

**Choice**: REMOVE. The replacement `blob_put` already returns CDN-fronted URLs (`url`, `immutable_url`, `cdn_url`, `cdn_immutable_url`) per its own implementation; no spec requirement is needed to compel it.

**Alternative considered**: MODIFY the requirement to substitute `blob_put` for `upload_file`.

**Why REMOVE won**: The new tool's URL-bearing response is a richer contract that doesn't fit the old requirement's shape. If `blob_put` needs a spec, it deserves its own capability spec — out of scope here.

### Decision 5: Bump `run402-mcp` to 0.3.0 (minor), not 1.0.0 (major)

**Choice**: Minor pre-1.0 bump. The package is still pre-1.0 per the README; "0.x — breaking changes allowed" is the agreed contract.

### Decision 6: Audit and mark obsolete `add-run402-sdk/tasks.md` lines 44 and 84 in the same PR

**Choice**: Edit those two task lines in-place to note the legacy-storage carve-out is moot post-sunset; do not edit the proposal or specs of that change. Postponing risks `add-run402-sdk` archiving with stale notes.

## Backend pushback (out of scope; informational)

The gateway team's choice to return Express's default 404 on retired routes is suboptimal generally — a structured `HTTP 410 Gone` with `{error, sunset_date, moved_to}` JSON would be more useful for any client. **However**, given the clean-slate position here, this pushback is downgraded from "must fix" to "nice to have for the next sunset". Documented for the gateway team's benefit; does not affect anything in this PR.

## Risks / Trade-offs

- **Risk**: An external agent has hardcoded `upload_file` and is currently failing silently against the 404. → **Accepted**. No paying customers; clean slate is the policy.
- **Risk**: A pending OpenSpec change (other than `add-run402-sdk`) silently depends on the legacy tools. → **Mitigation**: tasks.md greps `openspec/changes/` for legacy tool names; only `add-run402-sdk` matched at filing time.
- **Risk**: `sync.test.ts` against the upstream `~/Developer/run402-private/site/llms.txt` flips polarity (must-contain → must-not-contain) and a future upstream re-introduction breaks the test. → **Trade-off accepted**: desired behavior — re-introduction would be a regression worth catching.
- **Trade-off**: Deleting `upload-file.test.ts` removes coverage of the dead alias path. → **Accepted**: dead-code coverage is anti-coverage.
- **Risk**: `README.zh-CN.md` edits may diverge from the English version subtly. → **Mitigation**: keep edits structural (drop rows, swap example tool name); no prose rewriting.

## Migration Plan

Order of operations within this PR (mirrored in `tasks.md`):

1. Source deletion (handlers, CLI module, tests).
2. Registration scrub (`src/index.ts`, `cli/cli.mjs`, `openclaw/scripts/`).
3. Strip "Supersedes" mentions from `blob_*` MCP tool descriptions.
4. Doc scrub — `SKILL.md`, `README.md`, `README.zh-CN.md`, `openclaw/SKILL.md`, `cli/llms-cli.txt`. Verified by a final `grep -r upload_file|download_file|list_files|delete_file|run402 storage` returning **zero** matches.
5. Test re-pin (`sync.test.ts`, `SKILL.test.ts`).
6. Spec delta application.
7. Active-change tasks audit.
8. Version bump.

**Rollback strategy**: revert the merge commit. There is no data migration. Server state is unaffected.

## Open Questions

- Should the `run402` CLI version bump match `run402-mcp` (e.g., both go to 0.3.0) or follow its own version line? Defer to maintainer in PR review.
