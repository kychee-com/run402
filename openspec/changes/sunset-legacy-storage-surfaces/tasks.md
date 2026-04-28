## 1. MCP server — delete legacy storage tools

- [x] 1.1 Delete `src/tools/upload-file.ts`
- [x] 1.2 Delete `src/tools/download-file.ts`
- [x] 1.3 Delete `src/tools/list-files.ts`
- [x] 1.4 Delete `src/tools/delete-file.ts`
- [x] 1.5 Delete `src/tools/upload-file.test.ts`
- [x] 1.6 In `src/index.ts` remove the four imports (`uploadFileSchema`/`handleUploadFile` and the three siblings at lines ~36–38), then remove the four `server.tool(...)` registrations for `upload_file` / `download_file` / `delete_file` / `list_files` (lines ~269–295)
- [x] 1.7 In `src/index.ts` change the section banner at line 40 from `// New tools — direct-to-S3 blob storage (supersedes upload_file/download_file/list_files/delete_file)` to `// Direct-to-S3 blob storage`
- [x] 1.8 Strip "Supersedes" mentions from the `blob_*` tool descriptions in `src/index.ts`:
  - `blob_put` (line 222): remove the trailing ` This supersedes \`upload_file\`.`
  - `blob_get` (line 229): remove the trailing ` This supersedes \`download_file\`.`
  - `blob_ls` (line 236): replace ` This supersedes \`list_files\` (which is bucket-scoped; blob_ls is prefix-based over a flat key namespace).` with nothing — the prefix-based behavior is already documented in the preceding sentence
  - `blob_rm` (line 243): remove the trailing ` This supersedes \`delete_file\`.`
- [x] 1.9 Run `npm run build` and confirm no TypeScript errors caused by the removed imports

## 2. CLI — delete the `storage` subcommand

- [x] 2.1 Delete `cli/lib/storage.mjs`
- [x] 2.2 Delete `openclaw/scripts/storage.mjs` (re-export shim)
- [x] 2.3 In `cli/cli.mjs` remove the `case "storage": { ... }` block at lines 119–127 (the deprecation banner + dynamic import)
- [x] 2.4 In `cli/cli.mjs` remove the HELP entry at line 32 (`storage     Legacy file storage (deprecated — sunset 2026-06-01, use 'blob')`) — delete the line entirely
- [x] 2.5 Grep `cli/` for any remaining `run402 storage` mentions (help text, comments, example invocations) and remove them

## 3. Docs — strip every legacy reference

- [x] 3.1 `SKILL.md`:
  - Delete the dedicated tool sections at lines 819, 833, 862 (the full-sized `### upload_file (deprecated)` / `### download_file (deprecated)` / `### delete_file (deprecated)` / `### list_files (deprecated)` blocks, including their parameters, returns, and examples)
  - Delete the "Supersedes `<tool>` (deprecated)" callouts at lines 139, 150, 162, 166 — remove those entire trailing sentences from the `blob_put`/`blob_get`/`blob_ls`/`blob_rm` sections
  - Replace the example at line 213 (`upload_file(project_id: "prj_...", bucket: "assets", path: "data.csv", content: "...")`) with the equivalent `blob_put` invocation
  - Replace the example at line 228 (`upload_file(project_id: "prj_...", bucket: "assets", path: "report.csv", content: "...")`) with the equivalent `blob_put` invocation; update the surrounding "Step 7: Upload files (optional)" prose to reference `blob_put` only
- [x] 3.2 `README.md`:
  - Drop rows 65–68 from the tool table (`upload_file`, `download_file`, `delete_file`, `list_files`)
  - Update the example at line 217 (`Use \`run_sql\` to create tables, \`rest_query\` to insert/query data, and \`upload_file\` for storage.`) to use `blob_put`
- [x] 3.3 `README.zh-CN.md`: mirror the `README.md` edits — drop the same four rows from the tool table; update the equivalent example block to use `blob_put`. Keep edits structural; no prose rewriting
- [x] 3.4 `openclaw/SKILL.md`: same audit as `SKILL.md` step 3.1 — delete every `(deprecated)` section, delete every "Supersedes" callout, replace any `upload_file` example with the `blob_put` equivalent
- [x] 3.5 `cli/llms-cli.txt`: delete the `### storage (deprecated — sunset 2026-06-01)` section at line 474 entirely (header + body paragraph). No replacement section
- [x] 3.6 Final grep over `README.md SKILL.md README.zh-CN.md openclaw/SKILL.md cli/llms-cli.txt` for `upload_file|download_file|list_files|delete_file|run402 storage|/storage/v1/object` — must return **zero** matches

## 4. Sync tests — re-pin against the simplified upstream

- [x] 4.1 In `sync.test.ts` remove the four `SURFACE` rows at lines 161–164 (`upload_file`, `download_file`, `delete_file`, `list_files`)
- [x] 4.2 In `sync.test.ts` remove the four `SDK_BY_CAPABILITY` `null` placeholders at lines 343–346
- [x] 4.3 In `sync.test.ts` remove the upstream-llms.txt assertion at line 816 (`POST /storage/v1/object/sign/:bucket/*`); flip any other assertion that grep'd for `/storage/v1/object` to "must NOT contain"
- [x] 4.4 In `SKILL.test.ts` remove the `"upload_file"` reference at line 83; audit nearby array entries for any other legacy tool names and remove them
- [x] 4.5 Run `npm test` and confirm all suites pass (especially `sync.test.ts` and `SKILL.test.ts`)
- [x] 4.6 Run `npm run test:e2e`; expect zero failures since none of the 47 e2e tests target `run402 storage`

## 5. Active OpenSpec changes — mark obsolete

- [x] 5.1 In `openspec/changes/add-run402-sdk/tasks.md` line 44 (task 6.1), append a parenthetical note that the deprecated-aliased `upload_file`/`download_file`/`list_files`/`delete_file` carve-out is moot post-2026-04-28 sunset (handlers deleted by `sunset-legacy-storage-surfaces`)
- [x] 5.2 In `openspec/changes/add-run402-sdk/tasks.md` line 84 (task 9.5), append a similar note that the "(a) legacy storage aliases" carve-out no longer applies
- [x] 5.3 Grep `openspec/changes/` (excluding `archive/`) for any other mention of `upload_file`, `download_file`, `list_files`, `delete_file`, `run402 storage`, `/storage/v1/object`; mark each obsolete in the same style or update with current state

## 6. Version bump

- [x] 6.1 Bump `package.json` `version` for `run402-mcp` from `1.46.0` → `1.47.0` (the README's pre-1.0 disclaimer was stale; actual version line is 1.x. Minor bump matches the recent `1.46.0` precedent and signals removal-of-functionality without forcing 2.0.0)
- [x] 6.2 Bump `cli/package.json` (`run402`) and `sdk/package.json` (`@run402/sdk`) to `1.47.0` — all three packages stay in lockstep
- [x] 6.3 No in-repo references to the prior version found (no badge, no version constants in source); no further updates needed

## 7. OpenSpec validation + archive prep

- [x] 7.1 Run `openspec validate sunset-legacy-storage-surfaces` and resolve any errors
- [x] 7.2 Apply the spec delta to `openspec/specs/incremental-deploy/spec.md`: remove the `### Requirement: Upload file shows public URL` block (header + all three scenarios)
- [x] 7.3 Re-run `openspec validate sunset-legacy-storage-surfaces` after the spec edit; confirm clean
- [ ] 7.4 After the PR merges, run `openspec archive sunset-legacy-storage-surfaces -y` to move the change into `openspec/changes/archive/<date>-sunset-legacy-storage-surfaces/`. Use `--skip-specs` if the parser quirk reported in the v1.32 handoff (REMOVED-against-legacy-delta-spec) trips on this archive
