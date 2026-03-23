## 1. Status Tool

- [x] 1.1 Create `src/tools/status.ts` with `statusSchema` (no params) and `handleStatus` handler
- [x] 1.2 Implement: read allowance, make parallel API calls (tier, billing, projects), read local keystore
- [x] 1.3 Build markdown summary table with all sections (allowance, balance, tier, projects, active project)
- [x] 1.4 Handle missing allowance as error, failed API calls as graceful nulls

## 2. Project Info Tool

- [x] 2.1 Create `src/tools/project-info.ts` with `projectInfoSchema` (project_id param) and `handleProjectInfo`
- [x] 2.2 Read keystore, return REST URL, anon_key, service_key, site_url, deployed_at as markdown table
- [x] 2.3 Use `projectNotFound()` for missing projects

## 3. Project Use Tool

- [x] 3.1 Create `src/tools/project-use.ts` with `projectUseSchema` (project_id param) and `handleProjectUse`
- [x] 3.2 Validate project exists in keystore, call `setActiveProjectId()`, return confirmation

## 4. Project Keys Tool

- [x] 4.1 Create `src/tools/project-keys.ts` with `projectKeysSchema` (project_id param) and `handleProjectKeys`
- [x] 4.2 Read keystore, return project_id, anon_key, service_key

## 5. Registration

- [x] 5.1 Import all 4 tools in `src/index.ts`
- [x] 5.2 Register all 4 tools with `server.tool()`

## 6. Sync Test

- [x] 6.1 Update SURFACE entries: `status` → `mcp: "status"`, `project_info` → `mcp: "project_info"`, `project_use` → `mcp: "project_use"`, `project_keys` → `mcp: "project_keys"`

## 7. Unit Tests

- [x] 7.1 Create `src/tools/status.test.ts` — test full snapshot, no allowance error, API failure graceful handling
- [x] 7.2 Create `src/tools/project-info.test.ts` — test project found, project not found
- [x] 7.3 Create `src/tools/project-use.test.ts` — test set active, project not found
- [x] 7.4 Create `src/tools/project-keys.test.ts` — test keys returned, project not found

## 8. Verification

- [x] 8.1 Run `npm test` — all tests pass
- [x] 8.2 Run `npm run build` — TypeScript compiles without errors
