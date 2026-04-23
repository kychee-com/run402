## Context

Today the run402 monorepo has three interfaces (MCP server, CLI, OpenClaw skill) over a shared `core/` that covers keystore I/O, allowance signing, config paths, and an x402-wrapped fetch. What `core/` does **not** cover is the per-endpoint API-call surface itself — every `POST /projects/v1/...`, `GET /blobs/...`, etc. is implemented twice: once in `src/tools/<name>.ts` (MCP handler) and once in `cli/lib/<resource>.mjs` (CLI command), each inlining its own `fetch`, error formatting, response shaping, and credential lookup. A grep for `fetch(` and `paidApiRequest(` across those paths confirms >200 parallel call sites for ~100 endpoints.

This duplication is sustainable at today's size but actively blocks the next phase of work described in exploratory conversations: a remote MCP with code-mode execution. A V8 isolate cannot fork a CLI subprocess, and the MCP handlers bake in MCP-specific return shapes that would need to be unwound at call time from within a sandbox. Neither surface is consumable *as code*.

The stakeholders are: (1) contributors adding new endpoints (currently pay the "write it twice" tax), (2) users deploying run402 functions that need to call run402 from inside their own code, and (3) future agents executing code-mode TypeScript against a sandboxed, typed client.

## Goals / Non-Goals

**Goals:**

- Provide `@run402/sdk`, a single typed TypeScript client for every run402 API endpoint, as the kernel that MCP handlers and CLI commands both delegate to.
- Namespaced API shape (`sdk.projects.provision()`, not `sdk.provisionProject()`), ~12 namespaces grouping ~100 operations.
- Work in Node 22 AND in a V8 isolate with no filesystem access. Credential access is pluggable; the request kernel itself uses only platform `fetch`.
- Preserve today's x402 payment flow byte-for-byte when running in Node with a keystore allowance.
- Zero observable change to MCP tool outputs and CLI command outputs. Users, agents, and downstream scripts see the same strings.
- Pre-bundle the SDK in `deploy_function` so user functions can `import { run402 } from "@run402/sdk"` without adding it to their `--deps` list.

**Non-Goals:**

- Remote MCP front door, SSE transport, or hosted code-mode sandbox. Separate change.
- Session-budget primitive at the gateway. Separate change.
- Deprecation or removal of any existing MCP tool or CLI command. This change preserves surface; follow-on changes may reduce it.
- Rewriting `core/` abstractions (keystore, allowance, SIWE signing). `core/` stays as-is; the Node provider for the SDK re-uses it.
- Changing run402's HTTP API shape (gateway side). Server-side is out of scope.
- Backward compat beyond the final MCP/CLI/OpenClaw surface. The SDK itself is `0.x` — the library API may churn while stabilizing.

## Decisions

### 1. Namespaced API shape over flat

**Chose:** `sdk.projects.provision()`, `sdk.blobs.put()`, `sdk.email.send()`, `sdk.contracts.call()`, etc.

**Rejected:** Flat `sdk.provisionProject()`, `sdk.blobPut()`, `sdk.sendEmail()`.

**Why:** Namespaces scale. 100+ flat names pollutes autocomplete and is hard to memorize; ~12 namespaces with a handful of methods each maps onto how the docs and surface already group things (projects / blobs / functions / email / ai / contracts / domains / subdomains / auth / allowance / billing / admin / service). It also mirrors the existing CLI grouping (`run402 projects provision`, `run402 blob put`) so mental model carries over. Discoverability for agents in code mode is a direct function of namespace shape.

### 2. Request kernel is isomorphic; platform bindings are separate entry points

**Chose:** Package structure:

```
@run402/sdk
  ├─ index.ts          (exports the Run402 class, types, errors)
  ├─ kernel.ts         (platform-agnostic request path; uses globalThis.fetch)
  ├─ namespaces/
  │    ├─ projects.ts
  │    ├─ blobs.ts
  │    └─ ... (one per namespace)
  ├─ errors.ts
  └─ node/
       └─ index.ts     (Node-only: keystore provider, x402-wrapped fetch)
                       (consumers import `@run402/sdk/node` for Node defaults)
```

**Rejected:** Node-only package (blocks sandbox), browser-only package (blocks Node).

**Why:** The sandbox story is load-bearing. If the SDK ever `import("fs")` in its hot path, it's unusable in V8 isolates. Keeping Node-specific bindings behind a subpath import (`@run402/sdk/node`) lets Node consumers get the full battery-included experience while the sandbox consumes only `@run402/sdk` with an injected provider.

### 3. Pluggable credential provider

**Chose:** A single interface:

```typescript
interface CredentialsProvider {
  getAuth(path: string): Promise<Record<string, string>>; // SIWE headers, bearer tokens
  getProject(id: string): Promise<{ anon_key: string; service_key: string } | null>;
}
```

The `Run402` client takes one at construction. Default provider (from `@run402/sdk/node`) wraps today's keystore + allowance-auth code. Sandbox consumers inject a session-token provider.

**Rejected:** Splitting into `AuthProvider` + `ProjectKeyProvider` + `PaymentProvider` (over-decomposed for today's needs); passing credentials per-call (ergonomically terrible for namespace shape).

**Why:** One interface, small surface, pluggable. The SDK's hot path only calls these two methods and never touches `fs` or `process` directly.

### 4. Typed error hierarchy

**Chose:**

```
Run402Error (abstract)
 ├─ PaymentRequired      (HTTP 402 — includes renew_url, usage, x402 payload)
 ├─ ProjectNotFound      (local keystore miss or 404)
 ├─ Unauthorized         (HTTP 401 / 403)
 ├─ ApiError             (other non-2xx; carries status + body)
 └─ NetworkError         (fetch threw; no HTTP response at all)
```

All carry `status`, `body`, and a short `context` string set by the calling namespace (e.g. `"deploying function"`).

**Rejected:** Go-style `{ error, result }` tuples, `{ isError: true, content: [...] }` MCP shapes, `process.exit`.

**Why:** The two consumers (MCP handler and CLI command) both need to translate errors to their native format. A typed hierarchy lets `instanceof PaymentRequired` drive tool-specific logic (e.g., in MCP the 402 is rendered as informational text, in CLI as JSON with exit code 2). `formatApiError` / `projectNotFound` in `src/errors.ts` become thin shims over `instanceof` checks.

### 5. x402 payment integration via injected fetch

**Chose:** The SDK accepts an optional `fetch` at construction. If omitted, it uses `globalThis.fetch`. Node provider wraps fetch with `@x402/fetch` and registers the Base / Base-Sepolia schemes from the allowance — exactly what today's `setupPaidFetch` does. The SDK itself contains zero payment logic.

**Rejected:** SDK imports `@x402/fetch` directly (breaks sandbox); separate "payment provider" abstraction (redundant with fetch wrapping).

**Why:** `@x402/fetch` already wraps fetch; the SDK doesn't need to re-do that work. Keeping payment as a fetch-wrapping concern means the sandbox can inject a pre-authenticated fetch (supervisor-side) without the SDK caring.

### 6. Return shapes: raw typed response bodies

**Chose:** Each SDK method returns a typed interface matching the API's response body. No markdown, no pretty-print, no prose.

**Rejected:** Returning formatted strings, returning Result objects with metadata wrappers.

**Why:** The SDK is a kernel, not a presentation layer. MCP handlers build markdown tables; CLI commands build text or JSON; sandbox code uses the data directly. Each edge owns its format.

### 7. MCP and CLI become thin shims; OpenClaw inherits

**Chose:** Each `src/tools/<name>.ts` and each subcommand in `cli/lib/<resource>.mjs` becomes:

```typescript
// MCP tool shim (approximate)
export async function handleX(args) {
  try {
    const result = await sdk.namespace.op(args);
    return { content: [{ type: "text", text: formatAsMarkdown(result) }] };
  } catch (e) {
    return mapErrorToMcp(e);  // translates Run402Error → MCP shape
  }
}
```

OpenClaw already re-exports from CLI, so it inherits automatically.

**Rejected:** Keeping MCP / CLI as standalone implementations with SDK "optional"; generating MCP / CLI from SDK via codegen.

**Why:** Make the SDK the one true path. Codegen is tempting but adds build complexity and drift between generated-and-checked-in; the thin-shim pattern lets each edge retain its own formatting oddities (e.g. CLI has `--verbose` flags, MCP has tool-description prose) without leaking them into the SDK.

### 8. Migration via namespace-at-a-time, not tool-at-a-time

**Chose:** Build the whole SDK namespace (say, `projects.*`), then migrate all MCP tools and CLI commands in that namespace in one batch, then move to the next namespace.

**Rejected:** Migrate tool-by-tool (too many tiny PRs, SDK surface churns); big-bang migration (unreviewable).

**Why:** A namespace is a coherent unit (`provision`, `delete`, `list`, `info`, etc. for projects). Reviewing the SDK shape and its two consumers together at the namespace granularity gives reviewers the full picture. About 12 migration PRs total.

### 9. Snapshot testing for output parity

**Chose:** For each migrated tool, capture before-migration stdout/response text as a snapshot, then assert post-migration produces byte-identical output (modulo timestamps). Run against the existing test API mocks.

**Rejected:** Manual visual diff, trust-the-migration.

**Why:** The "zero observable change" requirement is load-bearing for trust — existing users and agents depend on specific text being stable. Snapshot tests catch accidental format drift at PR time.

## Risks / Trade-offs

- **Drift between SDK namespaces and the gateway API** → Mitigated by end-to-end tests that hit a local mock gateway; sync.test.ts grows an `sdk` column that cross-references MCP / CLI / OpenClaw method paths to SDK methods.
- **Bundle size inflating sandbox payloads** → Mitigated by the `sdk/node` subpath split. Sandbox imports `@run402/sdk` (kernel + namespaces only; no viem, no noble/curves, no @x402/fetch); Node consumers import `@run402/sdk/node` for those.
- **@x402/fetch peer-dep complexity** → Mitigated by keeping it as a Node-only optional import inside `@run402/sdk/node`, not a core SDK dep. Same pattern as today's `paid-fetch.ts` (which wraps it in try/catch for graceful degradation).
- **Public API churn while 0.x** → Mitigated by keeping the SDK consumed *only* inside this monorepo until 0.1 stabilizes. External consumers (including user-deployed functions) should pin to a specific minor version.
- **Review fatigue from ~30 migrated handlers per batch** → Mitigated by snapshot parity tests — reviewer focus is on "does the snapshot match?" not "read 30 files line by line." Each namespace PR is primarily mechanical after the first.
- **Credential-provider ergonomics surprise** → Mitigated by shipping a zero-config Node default (`import { run402 } from "@run402/sdk/node"` just works with the existing keystore). Only advanced use (sandbox, CI) touches the provider interface.
- **`process.exit` in CLI error paths relocates** → Today `findProject(id)` in `cli/lib/config.mjs` calls `process.exit(1)` on miss. Post-migration, the SDK throws `ProjectNotFound` and the CLI shim is where `process.exit` lives. Careful auditing required — no core SDK code may ever call `process.exit`.

## Migration Plan

1. **Scaffold `sdk/` package.** Add `sdk/package.json`, `sdk/tsconfig.json`, root `build:sdk` script. Package publishes as `@run402/sdk` with subpath export for `/node`. No code yet beyond the `Run402` class, `CredentialsProvider` interface, and error hierarchy.
2. **Implement the request kernel** (`sdk/src/kernel.ts`). Pure fetch-based, no Node imports. Unit-test against a mock fetch.
3. **Implement the Node provider** (`sdk/src/node/index.ts`). Reuses `core/` keystore, allowance, and `setupPaidFetch` verbatim — wraps them in the `CredentialsProvider` interface.
4. **Implement one namespace end-to-end** (projects). All methods typed, all error paths thrown. Write SDK-level tests.
5. **Migrate `projects` MCP tools and CLI commands.** Preserve their outputs. Snapshot test before/after.
6. **Repeat for each namespace** (blobs, functions, email, ai, contracts, subdomains, domains, billing, allowance, auth, admin, service). ~12 PRs.
7. **Extend `sync.test.ts`** to require each SURFACE entry declare its `sdk` method path; fail if any drift.
8. **Publish `@run402/sdk@0.1.0`** to npm.
9. **Add `@run402/sdk` to the deploy_function pre-bundled list.** Document in SKILL.md and llms-cli.txt.
10. **Rollback plan:** each namespace PR is independently revertible. If post-merge issues appear in one namespace, revert that PR only; other namespaces are unaffected. The SDK itself being `0.x` means we are free to yank or re-publish.

## Open Questions

- **Escape hatch for raw fetch?** Some MCP tools (e.g. `invoke_function`) forward arbitrary HTTP bodies/headers to deployed functions — not run402's own API. Does the SDK expose `sdk.raw.fetch(url, opts)` for these, or do we keep that logic in the MCP handler and leave it outside the SDK?
- **Pagination convention.** Should list methods auto-paginate (`for await of sdk.blobs.list()`) or return the single-page response with an explicit `cursor`? Today the CLI/MCP pattern is single-page. Suggest: keep single-page in 0.1, add async iteration in 0.2 if demand appears.
- **Where does payment intent live during the session-budget follow-on?** Today's SDK design assumes per-call x402. When session budgets land, does the `CredentialsProvider` grow a `getBudget()` method, or does that go through fetch-wrapping? Probably the latter — keep `CredentialsProvider` minimal.
- **Default export name.** `run402()` function, `new Run402()` class, or both? Current MCP/CLI pattern suggests a class; sandbox code-mode examples would read nicer with a function. Suggest both: `new Run402(opts)` for explicit construction, `run402(opts)` as a wrapper.
