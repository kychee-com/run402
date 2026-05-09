## Context

The public architecture says CLI, MCP, and OpenClaw are thin shims over `@run402/sdk`. A scan of production code shows direct Run402 gateway calls remain in both interface layers:

- MCP tools still use `apiRequest` for SQL, PostgREST, and expose manifest apply/read.
- CLI `projects` uses direct `fetch` for SQL, PostgREST, expose manifests, and project user role changes even though matching SDK methods already exist.
- CLI `auth providers` uses direct `fetch` even though `auth.providers` exists in the SDK.
- CLI `blob put` owns resumable upload sessions directly because `blobs.put` is memory-oriented and does not expose session init/poll/complete primitives.
- CLI `allowance`, `billing`, `init`, and `status` still call faucet, billing, tier, and wallet-project endpoints directly, even where SDK methods already exist or only need small generic-identifier expansion.

Not every network call should move into the SDK. Direct presigned storage PUTs do not call the Run402 gateway and remain part of the blob upload data plane. Tempo/on-chain RPC balance checks and GitHub repository-id lookup are external integrations at the CLI edge.

## Goals / Non-Goals

**Goals:**

- Ensure every CLI and MCP Run402 gateway call goes through a typed SDK method.
- Reuse existing SDK methods before adding new ones.
- Add SDK methods for missing interface behavior rather than duplicating gateway calls in CLI or MCP.
- Preserve CLI/MCP command names, arguments, output shape, and agent-facing behavior wherever possible.
- Add a static drift guard that blocks future direct Run402 gateway calls in production CLI/MCP code.

**Non-Goals:**

- Do not move direct presigned S3 part PUTs behind the SDK request kernel; they are intentionally outside the gateway.
- Do not move Tempo JSON-RPC, viem chain RPC reads, or GitHub API discovery into the Run402 SDK contract unless a later product decision makes those first-class SDK features.
- Do not redesign CLI output formatting or MCP Markdown formatting beyond what is necessary to adapt SDK result types.
- Do not remove existing SDK aliases solely for naming cleanup.

## Decisions

1. **Treat the SDK as the only Run402 gateway transport for interfaces.**

   CLI and MCP may resolve local files, parse argv/tool input, stream bytes, format output, and call external services, but any `https://api.run402.com` / `RUN402_API_BASE` path must be represented by an SDK method. This keeps auth, x402 wrapping, structured errors, and endpoint contracts in one place.

   Alternative considered: keep small direct calls when they are only one endpoint. Rejected because these “small” calls already drifted from SDK auth/error behavior and made it harder to prove interface parity.

2. **Use existing SDK methods first.**

   Current SDK already covers `projects.sql`, `projects.rest`, `projects.applyExpose`, `projects.getExpose`, `projects.promoteUser`, `projects.demoteUser`, `auth.providers`, `allowance.faucet`, `billing.createCheckout`, `billing.history`, `projects.list`, `tier.status`, and related reads. Interface refactors should wire to those before adding new surface.

   Alternative considered: create new wrapper methods matching CLI command names. Rejected where an SDK method already exists because aliases add maintenance without expanding capability.

3. **Add lower-level blob upload session SDK primitives.**

   CLI `blob put` needs streaming, resumability, cached session state, and per-part concurrency. The existing `blobs.put` is useful for programmatic small uploads but reads sources into memory and cannot express resume. Add typed SDK methods for gateway session init, session status, and session completion so CLI can keep its file streaming loop while the Run402 gateway calls move into the SDK.

   Alternative considered: force CLI to use `blobs.put`. Rejected because it would regress large-file and resumable upload behavior.

4. **Generalize billing reads by identifier.**

   The SDK wallet aliases are enough for allowance wallet flows, but `run402 billing balance/history` accepts either an email or a wallet. Add or widen SDK methods so callers can pass either identifier without doing direct URL construction.

   Alternative considered: keep email billing reads as CLI-only direct fetches. Rejected because email billing account lookup is public Run402 API behavior and belongs in the SDK.

5. **Make the no-bypass rule mechanically enforced.**

   Add a test that scans production `cli/` and `src/` code for direct Run402 gateway transports, including `fetch(`${API}`, `fetch(getApiBase())`, `RUN402_API_BASE` URL construction, and MCP `apiRequest` usage. Keep an explicit allowlist only for external URLs, presigned part URLs, local config helpers, tests, generated dist copies, and SDK internals.

   Alternative considered: rely on code review. Rejected because the goal is architectural drift prevention.

## Risks / Trade-offs

- [Risk] The static guard blocks legitimate future CLI/MCP experiments. -> Mitigation: require adding SDK surface first or adding a narrow documented allowlist entry with rationale.
- [Risk] Refactoring through SDK changes error envelopes. -> Mitigation: keep CLI/MCP formatters at the edge and update tests around externally visible output; only normalize inconsistencies that came from bypassing shared SDK error handling.
- [Risk] Blob session APIs expose lower-level primitives that most SDK users should not need. -> Mitigation: document them as advanced/resumable upload primitives while keeping `blobs.put` as the high-level path.
- [Risk] Some current direct calls duplicate existing SDK functionality, so implementation can be easy to under-test. -> Mitigation: pair each refactor with regression tests proving CLI/MCP no longer calls direct Run402 URLs and still emits the expected output.

## Migration Plan

1. Add any missing SDK methods and exported types, especially blob upload session primitives and generic billing identifier reads.
2. Refactor MCP SQL, REST, and expose tools to call `getSdk().projects.*`.
3. Refactor CLI modules to use SDK methods for all Run402 gateway calls, preserving direct external calls for Tempo, viem/RPC, GitHub, and presigned storage PUTs.
4. Add the static no-bypass guard and update sync/unit/e2e tests.
5. Update `AGENTS.md`, `documentation.md`-listed docs, and agent-facing references if the public SDK surface map changes.

## Open Questions

- Should blob session primitives be public long-term API, or marked advanced/low-level while still exported?
- Should a convenience SDK status aggregator be added, or should `run402 status` compose existing SDK namespace calls at the CLI layer?
- Should generic billing methods replace wallet-named aliases in docs, or should aliases remain documented for backward compatibility?
