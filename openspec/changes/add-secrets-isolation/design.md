## Context

The private gateway now rejects value-bearing deploy secret specs and exposes a value-free contract:

```ts
secrets?: {
  require?: string[];
  delete?: string[];
}
```

The public repo still has several old-shape entry points: SDK `SecretsSpec.set` / `replace_all`, MCP `deploy` schema, CLI `deploy apply` examples, `apps.bundleDeploy` translation, legacy `bundle_deploy` docs, `SecretSummary.value_hash`, and skills/docs that tell agents a hash can verify secret values. If left unchanged, agents will create manifests that fail with `INVALID_SPEC`, or worse, will keep writing secret values to manifests/repos while believing the deploy layer owns them.

This change is client/agent contract work only. Backend KMS, migrations, Bugsnag redaction, `value_hash` removal at the API, and warning generation are treated as shipped by the private commits. The public repo should consume that contract cleanly.

## Goals / Non-Goals

**Goals:**

- Make the SDK `ReleaseSpec` and all public deploy surfaces value-free for secrets.
- Preserve a smooth coding-agent workflow: set secret values out-of-band, then deploy with `secrets.require`.
- Surface `warnings: WarningEntry[]` consistently enough that agents can branch on `MISSING_REQUIRED_SECRET`.
- Remove `value_hash` from all public types, formatted output, docs, and examples.
- Update legacy compatibility paths so they never put secret values into a `ReleaseSpec`.
- Keep the implementation small and aligned with existing SDK/CLI/MCP shim patterns.

**Non-Goals:**

- No gateway/database/KMS/migration work in this repo.
- No new "get secret value" API.
- No Lambda environment variable redesign.
- No broad new secrets dashboard/browser-management feature. Closed issue #10 is related context, not scope.
- No local manifest validation tool in this change. Open issue #151 remains a follow-up that can build on the new schema.

## Decisions

### D1. `ReleaseSpec.secrets` is declaration-only

Change `SecretsSpec` to:

```ts
export interface SecretsSpec {
  require?: string[];
  delete?: string[];
}
```

Remove `set` and `replace_all` from SDK types and docs. SDK `validateSpec` should reject obvious old-shape objects locally with `Run402DeployError` code `INVALID_SPEC`, `phase: "validate"`, and `resource: "secrets.set"` or `"secrets.replace_all"` before network work. This gives agents a clean local error instead of an opaque gateway rejection.

Alternatives considered:

- Leave old fields in the type as deprecated optional fields and let the gateway reject them. Rejected because TypeScript would still teach agents the unsafe shape.
- Translate `set` to `require` silently. Rejected for plain `deploy.apply` because the values would still appear in manifests and callers would assume deploy is setting them.

### D2. Secret values move through the secrets namespace, not deploy specs

The canonical two-step workflow is:

1. `r.secrets.set(project, key, value)` or `run402 secrets set <project> <key> <value>`.
2. `r.deploy.apply({ project, secrets: { require: [key] }, ... })`.

Do not add a new deploy helper in the first slice. The two-step primitive flow is already simple, transparent, and available across SDK, CLI, and MCP. The "ultimate DX" move is to make the docs and errors so obvious that agents choose the safe two-step path without inventing value-bearing manifests.

Alternatives considered:

- Add `--set-secret KEY=VALUE` to `deploy apply`. Rejected for v1 because it encourages shell-history leakage and mixes two authorities into one command.
- Require every caller to hand-roll the two-step flow. Accepted for v1 because it keeps authority boundaries clear and uses tools that already exist.

### D3. Legacy compatibility surfaces pre-set or fail safely

`apps.bundleDeploy`, legacy CLI deploy shims, and `bundle_deploy` MCP can still accept older options for non-secret resources, but they must not translate secret values into `ReleaseSpec.secrets.set`.

When a compatibility surface receives secret values and has a project-scoped SDK available, it should:

- call `secrets.set` for each `{key, value}`;
- add those keys to `ReleaseSpec.secrets.require`;
- proceed with deploy;
- surface that secret writes happened before deploy and are not part of release rollback semantics.

If the surface cannot safely pre-set secrets, it should return a structured/actionable error telling the agent to call `set_secret` or `run402 secrets set` first, then deploy with `secrets.require`.

Alternatives considered:

- Remove all legacy secret options immediately. Rejected because a compatibility shim can preserve most agent workflows while still keeping the deploy spec value-free.
- Try to emulate old `replace_all` semantics. Rejected because backend deploy specs no longer carry values and exact replacement semantics are not representable without a separate admin operation.

### D4. `WarningEntry` is typed and propagated through apply

Add:

```ts
export interface WarningEntry {
  code: string;
  severity: "info" | "warn" | "high";
  message: string;
  affected: string[];
  requires_confirmation: boolean;
  confidence?: "heuristic";
  details?: Record<string, unknown>;
}
```

`PlanResponse` SHALL include `warnings: WarningEntry[]`. `DeployResult` SHOULD include the plan warnings as `warnings: WarningEntry[]` so one-shot `deploy.apply` callers do not have to drop to `plan` to inspect non-fatal problems. `DeployEvent` should add a `plan.warnings` event when the array is non-empty; CLI event stderr and MCP markdown should display the codes and affected keys.

For `MISSING_REQUIRED_SECRET`, agents can branch on either `warning.code === "MISSING_REQUIRED_SECRET"` or `warning.details?.missing_keys`.

Alternatives considered:

- Keep warnings only on `plan()`. Rejected because `apply()` is the recommended agent primitive.
- Use `string[]`. Rejected because agents need stable fields.

### D5. `value_hash` disappears everywhere

Remove `value_hash` from SDK `SecretSummary`, SDK tests, CLI/MCP formatted output, docs, and skills. `list_secrets` should show only keys and timestamp fields if the gateway returns them; if timestamps are absent in current test fixtures, key-only output is enough.

Alternatives considered:

- Keep `value_hash?: string` as optional for older gateways. Rejected because the goal is to stop teaching value-derived verification. Unknown extra runtime fields can be ignored without typing them.

### D6. Docs are part of the contract

Use `documentation.md` as the checklist. Every agent-facing doc surface must teach:

- never put secret values in deploy manifests;
- use `set_secret` / `run402 secrets set` / `r.secrets.set` to write values;
- use `secrets.require[]` to assert deploy-time dependencies;
- use `secrets.delete[]` to remove keys at activation;
- `list_secrets` is keys-only and cannot verify values by hash;
- secret values still appear as function environment variables at runtime, so do not over-promise total runtime secrecy.

Related issues should be referenced in the implementation notes, especially #151 for future local manifest validation and #198 for help/doc drift.

## Risks / Trade-offs

[Risk: compatibility shim writes secrets before a deploy that later fails] -> Mitigation: document non-atomicity, return clear output, and keep raw `deploy.apply` declaration-only.

[Risk: agents miss warnings because they only call `deploy.apply`] -> Mitigation: carry `warnings` onto `DeployResult` and emit a `plan.warnings` event.

[Risk: docs still contain old value-bearing examples] -> Mitigation: add targeted `rg`-based tests or sync assertions for `secrets.set`, `replace_all`, and `value_hash` in public docs.

[Risk: TypeScript accepts old runtime JSON through `as any`] -> Mitigation: SDK `validateSpec` rejects old keys before uploads or plan calls.

[Risk: old gateway fixtures still include `value_hash`] -> Mitigation: update tests to prove the client ignores absent hashes and docs never rely on them.

## Migration Plan

1. Update SDK types/validation/warning propagation first; tests should fail on old secret shape.
2. Update compatibility shims and CLI/MCP schemas to use `require` / `delete`.
3. Remove `value_hash` formatting and tests.
4. Update docs, skills, help snapshots, and sync tests.
5. Run build, focused SDK/MCP tests, CLI e2e/help tests, sync tests, skill tests, and a final `rg` scan for old contract strings.

Rollback is a source rollback only. The public client must match the deployed gateway; if the backend contract is live, reintroducing old fields is not a safe rollback.

## Open Questions

- Should a future local manifest-validation tool from #151 also validate that every `secrets.require[]` key exists locally/remotely before deploy? This change only updates the live deploy client contract.
