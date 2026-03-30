## 1. MCP tool

- [x] 1.1 Create `src/tools/update-function.ts` with Zod schema (project_id, name, schedule, timeout, memory) and handler that sends PATCH
- [x] 1.2 Register tool in `src/index.ts`
- [x] 1.3 Add unit test `src/tools/update-function.test.ts` — update schedule, remove schedule, update config, 403 error, project not found

## 2. CLI

- [x] 2.1 Add `update` subcommand to `cli/lib/functions.mjs` with --schedule, --schedule-remove, --timeout, --memory flags
- [x] 2.2 Wire `update` case in the `run()` switch statement
- [x] 2.3 Update HELP text with update subcommand and examples

## 3. Sync & docs

- [x] 3.1 Add `update_function` entry to SURFACE array in `sync.test.ts`
- [x] 3.2 Add `update_function` tool section to SKILL.md
- [x] 3.3 Verify `npm test` passes (PATCH endpoint sync error resolved; remaining failure is unrelated promote/demote-user endpoints)
