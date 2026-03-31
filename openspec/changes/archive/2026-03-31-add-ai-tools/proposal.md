## Why

Run402 now exposes AI helper endpoints (translate, moderate, usage) on the gateway. These are ready on the backend but have no MCP/CLI/OpenClaw surface yet, so developers can't use them through any Run402 tooling. Adding tools for these endpoints rounds out the AI capabilities story and matches the pattern of every gateway endpoint having a corresponding tool.

## What Changes

- Add `ai_translate` tool — translate text to a target language via `POST /ai/v1/translate` (requires service key + active AI Translation add-on)
- Add `ai_moderate` tool — run content moderation via `POST /ai/v1/moderate` (requires service key, free for all projects)
- Add `ai_usage` tool — check translation quota and billing-cycle usage via `GET /ai/v1/usage` (requires service key)
- Add corresponding CLI commands (`ai-translate`, `ai-moderate`, `ai-usage`) and OpenClaw shims
- Update sync test `SURFACE` array with all three new tools

## Capabilities

### New Capabilities
- `ai-translate`: Translate text to a target language with optional source language and context hint
- `ai-moderate`: Run content moderation on text, returning flagged status and category scores
- `ai-usage`: Query translation add-on usage for the current billing period

### Modified Capabilities

_None — these are purely additive._

## Impact

- **MCP server** (`src/tools/`): Three new tool files + registration in `src/index.ts`
- **CLI** (`cli/lib/`): New `ai.mjs` module handling all three subcommands, wired into CLI entry point
- **OpenClaw** (`openclaw/scripts/`): Thin shim re-exporting from CLI
- **Sync test** (`sync.test.ts`): Three new entries in `SURFACE` array
- **Dependencies**: No new dependencies — uses existing `apiRequest()` from core and service-key auth pattern
