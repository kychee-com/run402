## Context

The public repo has two different user-facing "manifest" concepts. Deploy manifests are `ReleaseSpec` inputs normalized by `@run402/sdk/node`; authorization manifests are the `manifest.json` / `database.expose` shape that declares tables, views, and RPC grants. Issue #151 is about the second shape.

The private gateway already validates auth-as-SDLC manifests before bundle deploy writes anything: it parses the expose manifest, optionally parses migration SQL, merges that with current project schema, and returns accumulated `{ errors, warnings, hasErrors }` issues. Public clients do not expose that feedback loop directly. Today an agent can discover many issues only by calling `apply_expose` or by running a deploy path that may mutate project state.

The current public architecture is SDK-first: MCP, CLI, and OpenClaw are thin shims over the SDK. A standalone MCP-only tool would be useful, but it would drift from the rest of the repo.

## Goals / Non-Goals

**Goals:**

- Add an SDK-first validation surface for authorization/expose manifests.
- Preserve the gateway's structured validation result shape without turning validation findings into thrown SDK errors.
- Support migration-aware validation so agents can check references created by pending migration SQL.
- Support project-aware validation through a server-authoritative current-schema snapshot when a project id is supplied.
- Add CLI and MCP shims that mirror the SDK result without mutating projects.

**Non-Goals:**

- Do not validate arbitrary PostgreSQL execution semantics or seed SQL side effects. That is the #236 / private#186 SQL dry-run problem.
- Do not add a fifth public npm package unless offline validation is explicitly prioritized later.
- Do not treat deploy-manifest structural validation as this capability; `normalizeDeployManifest` and `deploy.plan({ dryRun: true })` remain separate.
- Do not fake project-aware validation from the current public `get_schema` response, which only models tables and does not provide the validator's full universe.

## Decisions

1. **SDK-first public shape.**

   Add `projects.validateExpose(...)` to the SDK and expose CLI/MCP wrappers after the SDK method exists. This follows the repo's current pattern: external interfaces parse inputs and format output, while the SDK owns typed behavior.

   Alternative considered: add only an MCP `validate_manifest` tool. Rejected because it would duplicate validation contracts outside the typed kernel and leave CLI/OpenClaw users without the same feedback loop.

2. **Server-authoritative validation for project-aware checks.**

   The SDK should call a gateway validation endpoint rather than trying to reconstruct the private validator locally. When a project is supplied, the gateway can snapshot the live schema and merge it with migration SQL. When no project is supplied, the gateway can validate against an empty existing universe plus migration SQL.

   Alternative considered: publish `@run402/manifest-validator` and run it in-process. Rejected for the first version because the private validator is not cleanly packaged today, project-aware mode still needs server schema data, and a fifth lockstep package is unnecessary unless offline validation becomes a top priority.

3. **Validation findings are data, operational failures are errors.**

   A bad manifest should return `{ hasErrors: true, errors: [...] }`, not throw. Invalid files, unreadable migration paths, auth failures, network failures, missing project credentials, and gateway outages still use the existing CLI/MCP/SDK error paths.

   Alternative considered: throw `Run402Error` for validation failures. Rejected because agents need the same accumulated multi-issue envelope the gateway CI gate already returns.

4. **Name the public concept as expose/auth validation.**

   The CLI command should be `run402 projects validate-expose` and the SDK method should be `projects.validateExpose`. The MCP tool may keep the issue's `validate_manifest` name for agent familiarity, but its description and schema must make clear that it validates the auth/expose manifest, not a deploy manifest.

   Alternative considered: `deploy validate`. Rejected for this change because it suggests full release or SQL dry-run validation and overlaps with #236.

5. **Keep local client checks small and structural.**

   Clients may parse JSON strings and read local files. They should not implement semantic rules such as table existence, RPC overload handling, sensitive-column heuristics, or migration DDL parsing unless those rules come from an explicitly shared validator package in a later change.

## Risks / Trade-offs

- [Risk] The validation command is called "local" but still needs a network round trip. -> Mitigation: document it as non-mutating local-file feedback, not offline validation; leave an offline package as a future option.
- [Risk] Gateway endpoint shape is not finalized when public implementation starts. -> Mitigation: keep this proposal as SDK/client work gated on a backend contract, and implement wrappers only after the endpoint is available.
- [Risk] The overloaded `validate_manifest` name makes agents validate deploy manifests with the wrong tool. -> Mitigation: use expose/auth wording in SDK, CLI, MCP descriptions, docs, and error messages.
- [Risk] Existing MCP `apply_expose` schema is stricter than the gateway's manifest parser. -> Mitigation: align validation and apply schemas so `$schema` and omitted arrays are handled consistently.

## Migration Plan

1. Land the gateway validation endpoint or confirm an existing endpoint contract that returns the gateway validator envelope without mutating project state.
2. Add SDK input/result types and `projects.validateExpose(...)`, including scoped-client coverage if project binding is useful.
3. Add CLI and MCP shims over the SDK method, and ensure OpenClaw inherits the CLI command.
4. Update agent-facing docs and sync tests so the new surface is discoverable and not confused with deploy validation.
5. Keep existing `applyExpose`, `getExpose`, and deploy flows unchanged.

## Open Questions

- What exact gateway path should projectless validation use, and does it require wallet auth or remain public?
- Should the MCP tool be named exactly `validate_manifest` for #151 compatibility, or `validate_expose_manifest` for clarity?
- Should `projects.validateExpose` accept `project` in an options object only, or also expose a convenience overload matching `applyExpose(projectId, manifest)`?
