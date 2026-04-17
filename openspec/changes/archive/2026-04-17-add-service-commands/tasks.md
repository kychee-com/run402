## 1. CLI: `service` command

- [x] 1.1 Create `cli/lib/service.mjs` exporting `async function run(sub, args)` with a `HELP` constant listing `status` and `health` subcommands
- [x] 1.2 Implement `status` subcommand: `fetch(`${API}/status`)` with no auth headers, parse JSON, write to stdout, exit 0
- [x] 1.3 Implement `health` subcommand: `fetch(`${API}/health`)` with no auth headers, parse JSON, write to stdout, exit 0
- [x] 1.4 Handle non-2xx responses by writing `{error, status, body}` JSON to stdout and exiting 0
- [x] 1.5 Handle fetch rejections by writing `{error, message}` JSON to stdout and exiting 0
- [x] 1.6 Handle missing/unknown subcommand by printing `HELP` (missing → exit 0; unknown → exit 1 with an error line to stderr)
- [x] 1.7 Register `service` case in `cli/cli.mjs` command dispatch switch
- [x] 1.8 Add `service` entry to the `Commands:` section of the CLI `HELP` string in `cli/cli.mjs`

## 2. MCP: `service_status` and `service_health` tools

- [x] 2.1 Create `src/tools/service-status.ts` exporting `serviceStatusSchema = {}` and `async function handleServiceStatus(_args)`
- [x] 2.2 In `handleServiceStatus`, call `apiRequest("/status", { method: "GET" })` with no auth headers
- [x] 2.3 Build a markdown summary including `current_status`, 30-day `availability.last_30d.uptime_pct`, `operator.legal_name`, and a link to `links.health`/full `/status`; fall back to a minimal view if `schema_version !== "run402-status-v1"`
- [x] 2.4 Return `{ content: [{ type: "text", text: <summary> }] }` on success; `{ content: [...], isError: true }` with status code + message on non-OK or thrown
- [x] 2.5 Create `src/tools/service-health.ts` exporting `serviceHealthSchema = {}` and `async function handleServiceHealth(_args)`
- [x] 2.6 In `handleServiceHealth`, call `apiRequest("/health", { method: "GET" })` with no auth headers
- [x] 2.7 Build a markdown summary listing `status`, each `checks.*` key with its value, and the `version` string
- [x] 2.8 Return the same success/error shape pattern as `service_status`
- [x] 2.9 Register both tools in `src/index.ts` via `McpServer` with descriptions whose first sentence explicitly contrasts them with the account-level `status` tool

## 3. OpenClaw shims

- [x] 3.1 Create `openclaw/scripts/service.mjs` containing `export { run } from "../../cli/lib/service.mjs";`

## 4. Sync test surface

- [x] 4.1 Add two entries to the `SURFACE` array in `sync.test.ts`: one for `service_status` (endpoint `GET /status`, cli `service:status`, openclaw `service:status`), one for `service_health` (endpoint `GET /health`, cli `service:health`, openclaw `service:health`)
- [x] 4.2 Remove the bare `"GET /health"` entry from the endpoint-only list so `/health` is now enforced through `SURFACE` instead
- [x] 4.3 Confirm the CLI command detection block in `sync.test.ts` (the `existsSync(... "cli/lib/<name>.mjs")` ladder) picks up `cli/lib/service.mjs`; add an explicit entry if the ladder requires it
- [x] 4.4 Same for OpenClaw detection block for `openclaw/scripts/service.mjs`

## 5. Unit tests

- [x] 5.1 Create `src/tools/service-status.test.ts` covering: success with full payload, success with unknown `schema_version` fallback, non-2xx response → `isError`, thrown fetch → `isError`, success on fresh install (no allowance file)
- [x] 5.2 Create `src/tools/service-health.test.ts` covering: success, non-2xx → `isError`, thrown fetch → `isError`, success on fresh install
- [x] 5.3 Follow the existing test pattern: mock `globalThis.fetch`, set `RUN402_API_BASE`, restore in `afterEach`; assert tools never call `readAllowance` / `getAllowanceAuthHeaders` / `loadKeyStore` (verify via temp `RUN402_CONFIG_DIR` staying empty)

## 6. E2E coverage

- [x] 6.1 Add two mock handlers to `cli-e2e.test.mjs`: `GET /status` returning a minimal `run402-status-v1` payload, `GET /health` returning a minimal healthy payload
- [x] 6.2 Add e2e test cases invoking `run402 service status` and `run402 service health` and asserting JSON is written to stdout with exit 0
- [x] 6.3 Add an e2e test asserting `run402 service foo` exits non-zero

## 7. Documentation

- [x] 7.1 Add `service_status` and `service_health` rows to the MCP Tools table in `SKILL.md`, with descriptions that contrast them with the account-level `status` tool
- [x] 7.2 Add a short note under a relevant section of `SKILL.md` on when to use each (`/status` for trust/availability, `/health` for liveness)
- [ ] 7.3 Update `cli/cli.mjs` HELP text examples if a natural spot exists (optional)

## 8. Verification

- [x] 8.1 Run `npm run build` and confirm no TypeScript errors
- [x] 8.2 Run `npm test` and confirm all unit + sync + skill tests pass
- [x] 8.3 Run `npm run test:e2e` and confirm new CLI cases pass
- [x] 8.4 Manual smoke: `node cli/cli.mjs service status` and `node cli/cli.mjs service health` against production, confirm real payloads are echoed
- [ ] 8.5 Manual smoke: start MCP server, invoke `service_status` and `service_health` from an MCP client, confirm markdown summaries render
