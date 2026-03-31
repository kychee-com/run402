## Context

Run402 exposes AI helper endpoints (`/ai/v1/translate`, `/ai/v1/moderate`, `/ai/v1/usage`) on the gateway. These follow the same service-key auth pattern as all other project-scoped endpoints. The tools need MCP, CLI, and OpenClaw surfaces, following the existing three-interface pattern.

The `ai_translate` endpoint requires an active AI Translation add-on and charges per-word against a quota. `ai_moderate` is free for all projects. `ai_usage` returns translation quota stats.

## Goals / Non-Goals

**Goals:**
- Expose all three AI endpoints as MCP tools, CLI commands, and OpenClaw shims
- Follow existing patterns exactly (Zod schemas, `apiRequest`, `formatApiError`, keystore lookup)
- Handle 402 (quota exceeded / no add-on) as informational text, consistent with other paid tools
- Keep sync test passing with new surface entries

**Non-Goals:**
- Streaming translation (not supported by the endpoint)
- Batch translation (single text per call, matching the API)
- Caching or deduplication of translation requests
- Any new dependencies

## Decisions

### 1. Three separate MCP tools (not one combined tool)

Each endpoint gets its own tool: `ai_translate`, `ai_moderate`, `ai_usage`. This matches the pattern where each REST endpoint maps to one tool (e.g., `send_email` / `list_emails` / `get_email`).

**Alternative considered:** A single `ai` tool with a `command` parameter. Rejected because it would break the naming convention and make tool discovery harder for LLMs.

### 2. Single CLI module `cli/lib/ai.mjs`

Group all three subcommands (`translate`, `moderate`, `usage`) in one CLI module, similar to how `cli/lib/email.mjs` groups email subcommands. The `run(sub, args)` pattern routes to the correct handler.

**Alternative considered:** Three separate CLI modules. Rejected because these are closely related and small - a single module avoids file proliferation.

### 3. Use `apiRequest` (not `paidApiRequest`)

These endpoints use service-key Bearer auth, not x402 payment. The 402 from translate is quota-based (not x402-based), so we format it as an informational message without x402 payment details. This matches how `get_usage` handles its requests.

### 4. Tool registration section in index.ts

Add a new `// --- AI tools ---` section after the email tools section, grouping all three tools together.

## Risks / Trade-offs

- **[402 handling for translate]** The translate endpoint returns 402 when the add-on is missing or quota is exceeded. Unlike x402 402s, this one just means "enable the add-on" or "wait for quota reset". We'll format this clearly so the LLM doesn't try to initiate a payment flow. → Mitigation: Include specific guidance text in the 402 response about enabling the add-on via the dashboard.

- **[Moderation category list may change]** The moderation response includes OpenAI's category list which may expand over time. → Mitigation: Display all categories from the response dynamically rather than hardcoding a list.
