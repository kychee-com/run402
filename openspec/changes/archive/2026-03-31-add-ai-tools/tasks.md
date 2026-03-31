## 1. MCP Tools

- [x] 1.1 Create `src/tools/ai-translate.ts` — Zod schema (`project_id`, `text`, `to`, optional `from`, `context`) + handler with service-key auth, 402 as informational text, `formatApiError` for other errors
- [x] 1.2 Create `src/tools/ai-moderate.ts` — Zod schema (`project_id`, `text`) + handler with service-key auth, dynamic category table output
- [x] 1.3 Create `src/tools/ai-usage.ts` — Zod schema (`project_id`) + handler with service-key auth, formatted usage summary
- [x] 1.4 Register all three tools in `src/index.ts` under a new `// --- AI tools ---` section

## 2. Unit Tests

- [x] 2.1 Create `src/tools/ai-translate.test.ts` — mock fetch, test success, 402 informational, 400/429 errors, missing project
- [x] 2.2 Create `src/tools/ai-moderate.test.ts` — mock fetch, test flagged/not-flagged, errors, missing project
- [x] 2.3 Create `src/tools/ai-usage.test.ts` — mock fetch, test success, errors, missing project

## 3. CLI

- [x] 3.1 Create `cli/lib/ai.mjs` — `run(sub, args)` handling `translate`, `moderate`, `usage` subcommands using `apiRequest` and service-key auth
- [x] 3.2 Wire `ai` command into the CLI entry point

## 4. OpenClaw

- [x] 4.1 Create `openclaw/scripts/ai.mjs` — thin shim re-exporting `run` from `cli/lib/ai.mjs`

## 5. Sync & Validation

- [x] 5.1 Add `ai_translate`, `ai_moderate`, `ai_usage` to the `SURFACE` array in `sync.test.ts`
- [x] 5.2 Run `npm test` and verify all tests pass
