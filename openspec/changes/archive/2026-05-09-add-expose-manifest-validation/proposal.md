## Why

Agents authoring auth-as-SDLC `manifest.json` files need a safe feedback loop before applying authorization changes or shipping a deploy that might mutate a real project. Issue #151 identified the need as an MCP-only `validate_manifest` tool, but the public repo now uses the SDK as the typed kernel with CLI, MCP, and OpenClaw as thin shims, so the capability should be designed SDK-first.

## What Changes

- Add a validation surface for the authorization/expose manifest shape used by `database.expose`, `projects.applyExpose`, and bundled `manifest.json` files.
- Return the same structured validation envelope as the gateway CI gate: `{ hasErrors, errors, warnings }`, where each issue includes `type`, `severity`, `detail`, and optional `fix`.
- Support local input as an object or JSON string, with optional migration SQL so the validator can check references introduced by the migration.
- Support optional live-project validation through `project_id` / `project`, using the server as the authority for current schema state.
- Expose the SDK capability through CLI and MCP shims after the SDK contract is defined.
- Keep SQL execution dry-run and PostgreSQL semantic validation out of scope; that remains the broader #236 / private#186 backend-first validation problem.

## Capabilities

### New Capabilities

- `expose-manifest-validation-client-surface`: SDK, CLI, and MCP validation surface for auth/expose manifests, including local/migration-aware validation and live-project validation when a project id is supplied.

### Modified Capabilities

- None.

## Impact

- SDK: new public validation method and result/input types, plus root and node exports as needed.
- CLI: new command for validating an expose manifest file or inline JSON with optional migration SQL.
- MCP: new tool that mirrors the SDK validation envelope for agents.
- Gateway/private dependency: live-project validation requires a backend endpoint or another authoritative schema snapshot contract; implementation should not fake project-aware validation from the current public `get_schema` table-only shape.
- Docs and skills: update agent-facing references so `validate_manifest` is framed as auth/expose manifest validation, not general deploy-manifest validation.
