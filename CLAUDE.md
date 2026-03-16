# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

run402-mcp is an MCP (Model Context Protocol) server that exposes Run402 developer tools — provisioning Postgres databases, deploying static sites and serverless functions, managing storage, secrets, subdomains, and x402 USDC micropayments. It ships three interfaces from this monorepo:

- **MCP server** (root `src/`) — the main package, published as `run402-mcp` on npm
- **CLI** (`cli/`) — standalone CLI published as `run402` on npm, uses `@x402/fetch` for payments
- **OpenClaw skill** (`openclaw/`) — skill for OpenClaw agents, thin shims over CLI modules

All three share core logic via the `core/` module.

## Build & Test Commands

```bash
npm run build:core     # tsc -p core/tsconfig.json → core/dist/
npm run build          # build:core + tsc → dist/
npm run start          # node dist/index.js (stdio MCP transport)
npm run test:skill     # node --test --import tsx SKILL.test.ts (validates SKILL.md frontmatter/body)
npm run test:sync      # node --test --import tsx sync.test.ts (checks MCP/CLI/OpenClaw stay in sync)
npm test               # runs all tests (SKILL.test.ts + sync.test.ts + core/src/**/*.test.ts + src/**/*.test.ts)
npm run test:e2e       # node --test cli-e2e.test.mjs (47 CLI end-to-end tests)
```

Unit tests use Node's built-in `node:test` runner with `tsx` for TypeScript:

```bash
# Run all unit tests
node --test --import tsx core/src/**/*.test.ts src/**/*.test.ts

# Run a single test file
node --test --import tsx src/tools/run-sql.test.ts
node --test --import tsx core/src/keystore.test.ts
```

Tests are excluded from the build (`tsconfig.json` and `core/tsconfig.json` both exclude `**/*.test.ts`).

### Sync Test (`sync.test.ts`)

`sync.test.ts` defines the canonical API surface in a `SURFACE` array and checks:
- MCP tools in `src/index.ts` match the expected set (no missing, no extra)
- CLI commands in `cli/lib/*.mjs` match the expected set
- OpenClaw commands in `openclaw/scripts/*.mjs` match the expected set (follows re-exports to CLI)
- CLI and OpenClaw have identical command sets (parity)
- If `~/dev/run402/site/llms.txt` exists: MCP Tools table lists all tools, all endpoints documented

When adding a new tool/command, add it to the `SURFACE` array in `sync.test.ts`.

## Architecture

### Shared Core (`core/src/`)

The `core/` module contains shared logic imported by all three interfaces:

- **`config.ts`** — Path resolution and env vars: `getApiBase()`, `getConfigDir()`, `getKeystorePath()`, `getWalletPath()`.
- **`wallet.ts`** — `readWallet()`, `saveWallet()` with atomic writes (temp-file + rename, mode 0600).
- **`wallet-auth.ts`** — EIP-191 signing with `@noble/curves`. `getWalletAuthHeaders()` returns headers or null.
- **`keystore.ts`** — Unified project credential store. Object schema: `{projects: {id: {anon_key, service_key, tier, lease_expires_at}}}`. Auto-migrates legacy array format and `expires_at` → `lease_expires_at`. Functions: `loadKeyStore()`, `saveKeyStore()`, `getProject()`, `saveProject()`, `removeProject()`.
- **`client.ts`** — `apiRequest()` fetch wrapper. Handles JSON/text responses, 402 payment detection.

Core functions return `null` or throw — they never call `process.exit()`. Each interface wraps with its own error behavior.

### MCP Server (`src/`)

Thin re-export layer over `core/dist/` plus MCP-specific wrappers:

- **`config.ts`**, **`client.ts`**, **`keystore.ts`**, **`wallet.ts`** — re-export from core
- **`wallet-auth.ts`** — re-exports core's `getWalletAuthHeaders()` + adds `requireWalletAuth()` which returns MCP error shape
- **`errors.ts`** — MCP-specific error formatting (`formatApiError`, `projectNotFound`)
- **`index.ts`** — Entry point. Registers all tools via `McpServer`.
- **`tools/*.ts`** — Each tool exports a Zod schema + async handler

### CLI (`cli/`)

- **`cli/lib/config.mjs`** — Imports from `core/dist/`, adds CLI wrappers (`walletAuthHeaders()` with process.exit, `findProject()` with process.exit). Re-exports core keystore functions.
- **`cli/lib/paid-fetch.mjs`** — Shared `setupPaidFetch()` using viem + @x402/fetch for paid endpoints.
- **`cli/lib/*.mjs`** — Each module exports `async run(sub, args)` with CLI output format.

### OpenClaw (`openclaw/`)

- **`openclaw/scripts/config.mjs`** — Re-exports from `cli/lib/config.mjs`
- **`openclaw/scripts/*.mjs`** — Thin shims: `export { run } from "../../cli/lib/<name>.mjs"`
- **`openclaw/scripts/init.mjs`** — Calls CLI's `run()` at top level (executable script)

### Tool Pattern

Every tool in `src/tools/` exports two things:
1. A Zod schema object (e.g., `provisionSchema`) defining input parameters
2. An async handler function (e.g., `handleProvision`) returning `{ content: [{type: "text", text: string}], isError?: boolean }`

Tools that require payment (provision, renew, deploy_site, bundle_deploy) return 402 payment details as **informational text** (not errors) so the LLM can reason about payment flow.

### Error Handling Pattern

All tools use shared error helpers from `src/errors.ts`:

- **`formatApiError(res, context)`** — Formats a non-OK API response into the standard `{ content: [...], isError: true }` shape. Includes HTTP status, extracts `hint`/`retry_after`/`renew_url`/`usage`/`expires_at` from the response body, and adds actionable guidance based on status code. The `context` parameter is a short verb phrase describing what failed (e.g. "running SQL").

- **`projectNotFound(projectId)`** — Returns a consistent "project not found in key store" error with guidance to provision first.

When adding a new tool, use these helpers instead of inline error formatting:
```ts
if (!project) return projectNotFound(args.project_id);
// ...
if (!res.ok) return formatApiError(res, "doing the thing");
```

### Test Pattern

Tests mock `globalThis.fetch` and use temp directories for keystore isolation. Each test file follows:
- `beforeEach`: set `RUN402_API_BASE` env, create temp keystore, mock fetch
- `afterEach`: restore original fetch and env, clean up temp dir

### SKILL.md

`SKILL.md` is the OpenClaw skill definition with YAML frontmatter + markdown body. `SKILL.test.ts` validates its structure (frontmatter fields, required sections, tool references, markdown integrity). Run with `npm run test:skill`.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `RUN402_API_BASE` | `https://api.run402.com` | API base URL (override for testing/staging) |
| `RUN402_CONFIG_DIR` | `~/.config/run402` | Local credential storage directory |
