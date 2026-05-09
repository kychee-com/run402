## 1. Backend Contract

- [x] 1.1 Confirm or add a non-mutating gateway validation endpoint for expose manifests that returns `{ hasErrors, errors, warnings }`.
- [x] 1.2 Confirm projectless validation behavior, auth requirements, and request body shape for `manifest` plus optional `migration_sql`.
- [x] 1.3 Confirm project-aware validation behavior, including current-schema snapshot semantics and service-key/admin auth.
- [x] 1.4 Add or reference backend tests proving validation does not apply manifests, execute migrations, or create deploy plans.

## 2. SDK Surface

- [x] 2.1 Add public validation input/result/issue types for expose manifest validation.
- [x] 2.2 Implement `projects.validateExpose(...)` over the confirmed gateway contract.
- [x] 2.3 Parse JSON string manifests into validation results with `hasErrors: true` on invalid JSON.
- [x] 2.4 Preserve validation findings as data while keeping auth/network/credential failures on structured SDK error paths.
- [x] 2.5 Add scoped-client coverage if project-bound validation is exposed through `r.project(id)`.
- [x] 2.6 Export new public types from SDK entrypoints and update public type export tests.

## 3. CLI And OpenClaw

- [x] 3.1 Add `run402 projects validate-expose` argument parsing for `--file`, inline JSON, stdin, `--migration-file`, `--migration-sql`, and optional project id.
- [x] 3.2 Print `{ status: "ok", hasErrors, errors, warnings }` to stdout for validation results, including `hasErrors: true`.
- [x] 3.3 Return non-zero only for usage, file, auth, network, or other operational failures.
- [x] 3.4 Ensure OpenClaw command parity inherits or exposes the new CLI subcommand.
- [x] 3.5 Add CLI help/e2e coverage for file input, migration-file input, project context, and validation-error output.

## 4. MCP Surface

- [x] 4.1 Add the MCP validation tool, preferably `validate_manifest` unless final naming chooses `validate_expose_manifest`.
- [x] 4.2 Make the tool schema accept manifest object or string, optional `migration_sql`, and optional `project_id`.
- [x] 4.3 Route the handler through the SDK method and preserve the full validation envelope in fenced JSON.
- [x] 4.4 Make the tool description explicitly distinguish auth/expose manifests from deploy manifests.
- [x] 4.5 Add MCP tests for object input, string input, invalid JSON result, project context, and SDK error mapping.

## 5. Apply-Expose Alignment

- [x] 5.1 Align `apply_expose` client schemas with gateway-accepted expose manifest shape, including `$schema`.
- [x] 5.2 Allow omitted `tables`, `views`, and `rpcs` sections where the gateway parser treats them as empty arrays.
- [x] 5.3 Add regression tests showing validation and apply client schemas accept the same benign manifest forms.

## 6. Docs And Sync

- [x] 6.1 Update SDK README/llms docs for `projects.validateExpose` and the validation boundary.
- [x] 6.2 Update CLI, MCP, SKILL.md, and OpenClaw docs to describe validate-expose / validate_manifest as auth/expose manifest validation.
- [x] 6.3 Document that migration SQL is used for reference checks only and is not a PostgreSQL execution dry run.
- [x] 6.4 Update `sync.test.ts` surface mappings for SDK, CLI, MCP, and OpenClaw parity.
- [x] 6.5 Scan agent-facing docs to avoid implying this validates deploy manifests or arbitrary SQL execution semantics.

## 7. Final Validation

- [x] 7.1 Run focused SDK tests for projects namespace validation and public exports.
- [x] 7.2 Run focused CLI and MCP tests for the new validation surfaces.
- [x] 7.3 Run `npm run test:sync`.
- [x] 7.4 Run `npm run test:skill`.
- [x] 7.5 Run the broader relevant test suite or document any skipped tests with reason.
