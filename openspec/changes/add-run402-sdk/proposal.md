## Why

The per-endpoint API-call logic is currently duplicated across ~100 MCP handlers in `src/tools/*.ts` and ~29 CLI modules in `cli/lib/*.mjs` — each site inlines its own `fetch` call, response parsing, error formatting, and credential lookup. This blocks three things at once: (1) adding new endpoints requires writing them twice with subtle drift risk, (2) user-deployed `deploy_function` code cannot call run402 without hand-rolling x402 payment logic, and (3) future code-mode execution (agent writes TypeScript inside a sandbox) is impossible — a V8 isolate cannot fork a CLI subprocess, and the current MCP handlers are wired to MCP-specific return shapes.

## What Changes

- Add a new `@run402/sdk` npm package containing a typed, namespaced TypeScript client for every run402 endpoint. Single kernel that both MCP handlers and CLI commands delegate to.
- SDK surface is **namespaced** — `sdk.projects.provision()`, `sdk.blobs.put()`, `sdk.functions.deploy()`, `sdk.email.send()`, etc. — organized by resource, not flat.
- SDK uses a **pluggable credential provider** model: the default Node provider reads the existing keystore, but consumers may inject a session-token provider (for future sandbox use), an environment-variable provider (for CI), or a static-key provider (for tests). The SDK itself never reads `fs` directly in its core request path.
- SDK throws **typed errors** (`Run402Error` with subclasses `PaymentRequired`, `ProjectNotFound`, `Unauthorized`, `ApiError`) instead of returning MCP shapes or calling `process.exit`. Both consumers translate to their native format at the edge.
- SDK preserves the existing x402 payment flow by accepting a pluggable `fetch` that may be wrapped with `@x402/fetch`; the node-default provider wires this automatically from the keystore allowance.
- **Migrate** all MCP handlers in `src/tools/*.ts` and CLI modules in `cli/lib/*.mjs` to call the SDK. Each handler/command becomes a thin shim: call the SDK, translate the result to MCP markdown or CLI text/JSON. No public behavior change.
- Keep `core/` for genuinely cross-cutting primitives that are NOT part of the SDK API surface (keystore files, allowance signing, config paths). `core/` stays as Node-only; the SDK's request kernel is isomorphic (Node 22 + V8 isolate compatible).
- Publish `@run402/sdk` to npm as a separate package. Add it to the pre-bundled package list in `deploy_function` so user-deployed functions can `import { run402 } from "@run402/sdk"` without bundling it.
- Extend `sync.test.ts` with an `sdk` column alongside MCP/CLI/OpenClaw so all four surfaces stay aligned.

**Not in scope for this change** (follow-on work): the remote MCP front door, the `execute_code` sandbox, session budgets, and the deprecation of individual MCP tools. Those depend on this change landing first.

## Capabilities

### New Capabilities

- `run402-sdk`: The typed TypeScript client package (`@run402/sdk`). Covers the namespaced API surface, credential-provider contract, error-type hierarchy, payment-flow integration, and the isomorphism requirement (works in Node and V8 sandbox).

### Modified Capabilities

_None._ This change is additive. MCP tool behaviors and CLI command behaviors are unchanged from the user's perspective — only their implementations are migrated to delegate to the SDK. No existing spec requirements are rewritten.

## Impact

- **New package**: `sdk/` directory at repo root (sibling to `core/`, `cli/`, `openclaw/`) with its own `package.json`, `tsconfig.json`, and build target `sdk/dist/`. Published as `@run402/sdk`.
- **Modified**: `src/tools/*.ts` (all ~100 files thin-shimmed to call SDK), `cli/lib/*.mjs` (all ~29 modules thin-shimmed). Net code reduction expected (~30-40% of tool-handler LOC).
- **Modified**: `sync.test.ts` grows a fourth column; each `SURFACE` entry lists which SDK namespace/method it maps to.
- **Modified**: Root `package.json` adds `build:sdk` script and `sdk` workspace entry if monorepo tooling is adopted; otherwise `sdk/` builds via its own `tsc`.
- **Modified**: `deploy_function` pre-bundled package list gains `@run402/sdk`.
- **Dependencies**: SDK depends on `@x402/fetch`, `@x402/evm`, `viem`, `@noble/curves` (same as today's paid-fetch). No new runtime deps.
- **Backward compatibility**: MCP tool names, CLI commands, MCP output text, CLI output text — all unchanged. The MCP and CLI are re-implementations over the SDK, not replacements.
- **Versioning**: SDK follows semver. First release is `0.1.0` (pre-1.0, breaking changes allowed) while API shape stabilizes.
