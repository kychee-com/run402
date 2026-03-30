## 1. MCP Tools

- [x] 1.1 Create `src/tools/promote-user.ts` — export `promoteUserSchema` and `handlePromoteUser` following the `set-secret.ts` pattern (service_key auth, `formatApiError`, `projectNotFound`)
- [x] 1.2 Create `src/tools/demote-user.ts` — export `demoteUserSchema` and `handleDemoteUser` following the same pattern
- [x] 1.3 Register both tools in `src/index.ts` — import schemas and handlers, add `server.tool()` calls

## 2. CLI Commands

- [x] 2.1 Add `promote-user` and `demote-user` subcommands to `cli/lib/projects.mjs` — add handler functions and switch cases in `run()`
- [x] 2.2 Update the HELP text in `cli/lib/projects.mjs` to document the new subcommands

## 3. Sync Test

- [x] 3.1 Add `promote_user` and `demote_user` entries to the `SURFACE` array in `sync.test.ts`
- [x] 3.2 Remove `POST /projects/v1/admin/:id/promote-user` and `POST /projects/v1/admin/:id/demote-user` from `IGNORED_ENDPOINTS`

## 4. Tests & Verification

- [x] 4.1 Create unit tests for the MCP tools (`src/tools/promote-user.test.ts`, `src/tools/demote-user.test.ts`) — test success, project not found, and API error cases
- [x] 4.2 Run `npm test` to verify all tests pass (sync test, unit tests)
