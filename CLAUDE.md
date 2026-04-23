# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

run402-mcp is an MCP (Model Context Protocol) server that exposes Run402 developer tools — provisioning Postgres databases, deploying static sites and serverless functions, managing storage, secrets, subdomains, and x402 USDC micropayments. It ships four interfaces from this monorepo:

- **SDK** (`sdk/`) — typed TypeScript client, kernel shared by MCP/CLI/OpenClaw; published as `@run402/sdk` on npm. Two entry points: root (isomorphic — works in Node 22, Deno, Bun, V8 isolates) and `/node` (zero-config Node defaults — keystore + allowance + x402).
- **MCP server** (root `src/`) — the main package, published as `run402-mcp` on npm. Each tool is a thin shim over an SDK call.
- **CLI** (`cli/`) — standalone CLI published as `run402` on npm. Each subcommand is a thin shim over an SDK call; argv parsing and JSON output stay at the CLI edge.
- **OpenClaw skill** (`openclaw/`) — skill for OpenClaw agents, re-exports from CLI modules.

All four share the request kernel via `@run402/sdk`. `core/` holds filesystem primitives (keystore, allowance) that the Node SDK provider wraps.

## Build & Test Commands

```bash
npm run build:core     # tsc -p core/tsconfig.json → core/dist/
npm run build:sdk      # tsc -p sdk/tsconfig.json  → sdk/dist/
npm run build          # build:core + build:sdk + tsc → dist/
npm run start          # node dist/index.js (stdio MCP transport)
npm run test:skill     # node --test --import tsx SKILL.test.ts (validates SKILL.md frontmatter/body)
npm run test:sync      # node --test --import tsx sync.test.ts (checks MCP/CLI/OpenClaw/SDK stay in sync)
npm test               # runs all tests (SKILL.test.ts + sync.test.ts + core/src/**/*.test.ts + sdk/src/**/*.test.ts + src/**/*.test.ts)
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
- Every SURFACE capability maps to an SDK method (or explicit `null` in `SDK_BY_CAPABILITY`); every SDK method is referenced by SURFACE (orphan check)
- If `~/Developer/run402-private/site/llms.txt` exists: MCP Tools table lists all tools, all endpoints documented

When adding a new tool/command, add it to the `SURFACE` array **and** `SDK_BY_CAPABILITY` in `sync.test.ts`.

## Architecture

```
@run402/sdk  (typed TypeScript kernel — 17 namespaces, ~90 methods)
   │
   │   /index.ts    (isomorphic: Node + sandbox)
   │   /node        (Node-only: keystore + allowance + x402-wrapped fetch)
   │
   ├─── MCP tools  (src/tools/*.ts)  — thin shim → SDK → markdown format
   ├─── CLI        (cli/lib/*.mjs)   — thin shim → SDK → JSON output + exit code
   └─── OpenClaw   (openclaw/scripts/*.mjs) — re-exports from CLI

core/  ← Node-only primitives (keystore, allowance, SIWE signing, config paths)
        Imported by `sdk/src/node` via `../../../core/dist/`; not an npm package.
```

The SDK is the canonical kernel — a single typed client with a `CredentialsProvider` interface for credential access and a pluggable `fetch` (for x402 wrapping in Node, session tokens in sandboxes). MCP handlers and CLI commands are thin shims: argv/schema parsing + SDK call + output formatting. When code-mode MCP ships, the same SDK runs inside a V8 isolate.

### SDK (`sdk/src/`)

- **`index.ts`** — `Run402` class + `run402()` factory. Isomorphic entry point.
- **`kernel.ts`** — Request function, `Client` interface. Only place that calls `globalThis.fetch`.
- **`errors.ts`** — `Run402Error` hierarchy: `PaymentRequired`, `ProjectNotFound`, `Unauthorized`, `ApiError`, `NetworkError`. Never calls `process.exit`.
- **`credentials.ts`** — `CredentialsProvider` interface. Required: `getAuth`, `getProject`. Optional: `saveProject`, `updateProject`, `removeProject`, `setActiveProject`, `getActiveProject`, `readAllowance`, `saveAllowance`, `createAllowance`, `getAllowancePath`.
- **`namespaces/*.ts`** — One class per resource group (projects, blobs, functions, email, …). Namespaces hold a `Client` and expose typed methods.
- **`node/*.ts`** — Node-only entry point (`@run402/sdk/node`). Wraps `core/` keystore + allowance into `NodeCredentialsProvider`. Sets up x402-wrapped fetch via `createLazyPaidFetch()`.

### Shared Core (`core/src/`)

The `core/` module contains shared logic imported by all three interfaces:

- **`config.ts`** — Path resolution and env vars: `getApiBase()`, `getConfigDir()`, `getKeystorePath()`, `getAllowancePath()`.
- **`allowance.ts`** — `readAllowance()`, `saveAllowance()` with atomic writes (temp-file + rename, mode 0600).
- **`allowance-auth.ts`** — EIP-191 signing with `@noble/curves`. `getAllowanceAuthHeaders()` returns headers or null.
- **`keystore.ts`** — Unified project credential store. Object schema: `{projects: {id: {anon_key, service_key, tier, lease_expires_at}}}`. Auto-migrates legacy array format and `expires_at` → `lease_expires_at`. Functions: `loadKeyStore()`, `saveKeyStore()`, `getProject()`, `saveProject()`, `removeProject()`.
- **`client.ts`** — `apiRequest()` fetch wrapper. Handles JSON/text responses, 402 payment detection.

Core functions return `null` or throw — they never call `process.exit()`. Each interface wraps with its own error behavior.

### MCP Server (`src/`)

- **`sdk.ts`** — Lazy SDK singleton (`getSdk()`). Tests call `_resetSdk()` in beforeEach to pick up env changes.
- **`errors.ts`** — `formatApiError`, `projectNotFound`, and `mapSdkError` which translates `Run402Error` → MCP `{isError, content}` shape.
- **`config.ts`**, **`keystore.ts`**, **`allowance.ts`** — re-export from `core/dist/` (still used by a few compound handlers like `init`/`status` that read local state directly).
- **`allowance-auth.ts`** — re-exports core's `getAllowanceAuthHeaders()` + adds `requireAllowanceAuth()` (early-exit with MCP error when no allowance). Kept for handlers where the UX message is more specific than the SDK's `Unauthorized`.
- **`index.ts`** — Entry point. Registers all tools via `McpServer`.
- **`tools/*.ts`** — Each tool exports a Zod schema + async handler. The handler is a thin shim: `getSdk().ns.op(...)` in a try/catch that translates errors via `mapSdkError`.

### CLI (`cli/`)

- **`cli/lib/sdk.mjs`** — Fresh SDK per call via `getSdk()`. Sidesteps stale-env issues across test-file boundaries.
- **`cli/lib/sdk-errors.mjs`** — `reportSdkError(err)` writes JSON envelope `{status: "error", http?, message?, body_preview?, ...body}` to stderr and calls `process.exit(1)`. Preserves `ProjectNotFound` plain-text format with the "Hint: project IDs start with prj_" guidance.
- **`cli/lib/config.mjs`** — Imports from `../core-dist/`, adds CLI wrappers (`allowanceAuthHeaders()` with process.exit, `findProject()` with process.exit). Re-exports core keystore functions.
- **`cli/lib/*.mjs`** — Each module exports `async run(sub, args)`. Subcommand bodies: argv parse + SDK call + JSON output + `reportSdkError` on failure.
- **`cli/lib/blob.mjs`** retains raw `fetch` for the `put` subcommand only — resumable uploads + per-part concurrency are CLI-specific UX not modeled in the SDK.
- **`cli/lib/deploy.mjs`** retains raw `undici.fetch` for long-timeout bundle deploys and retry-on-5xx. The SDK covers `apps.bundleDeploy` but the CLI wraps it with a custom dispatcher.

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
| `RUN402_ALLOWANCE_PATH` | `{config_dir}/allowance.json` | Custom allowance (wallet) file path |
