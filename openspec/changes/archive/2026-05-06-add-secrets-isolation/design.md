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
- Surface `warnings: WarningEntry[]` consistently enough that agents can branch on `MISSING_REQUIRED_SECRET` before a commit fails.
- Remove `value_hash` from all public types, formatted output, docs, and examples.
- Update legacy compatibility paths so they never put secret values into a `ReleaseSpec`.
- Keep the implementation small and aligned with existing SDK/CLI/MCP shim patterns.

**Non-Goals:**

- No gateway/database/KMS/migration work in this repo.
- No new "get secret value" API.
- No Lambda environment variable redesign.
- No broad new secrets dashboard/browser-management feature. Closed issue #10 is related context, not scope.
- No local manifest validation tool in this change. Open issue #151 remains a follow-up that can build on the new schema.
- No new deploy-secret helper in this first slice. The two-step primitive is the safe public contract; higher-level "ensure secrets then value-free deploy" helpers can be proposed later.

## Decisions

### D1. `ReleaseSpec.secrets` is declaration-only

Change `SecretsSpec` to:

```ts
export interface SecretsSpec {
  /** Keys that must already exist at commit-time gating. */
  require?: string[];
  /** Keys to remove atomically with activation. */
  delete?: string[];
}
```

`secrets.require[]` is a deploy-time dependency assertion only. It does not carry values, does not scope per-function access, and does not define an injection allowlist. Project secrets are managed by the secrets API and injected into functions as environment variables by the platform. `secrets.delete[]` removes keys at activation. Unknown delete keys hard-error at commit-time gating. The same key in both arrays is invalid. Keys must match `^[A-Z_][A-Z0-9_]{0,127}$`.

SDK `validateSpec` MUST reject unknown secret fields, especially `set` and `replace_all`, before normalization, CAS upload, or plan creation with `Run402DeployError` code `INVALID_SPEC`, `phase: "validate"`, and `resource: "secrets.set"` or `"secrets.replace_all"`.

Alternatives considered:

- Leave old fields in the type as deprecated optional fields and let the gateway reject them. Rejected because TypeScript would still teach agents the unsafe shape.
- Translate `set` to `require` silently. Rejected for plain `deploy.apply` because the values would still appear in manifests and callers would assume deploy is setting them.

### D2. Secret values move through the secrets namespace, not deploy specs

The canonical two-step workflow is:

1. `r.secrets.set(project, key, value)` or `run402 secrets set <project> <key> <value-or---file>`.
2. `r.deploy.apply({ project, secrets: { require: [key] }, ... })`.

Confirm and implement the shipped gateway shape:

- `POST /projects/v1/admin/{id}/secrets/{key}` with body `{ value: string }`.
- `GET /projects/v1/admin/{id}/secrets` returns `Array<{ key, created_at, updated_at }>`; the SDK should also tolerate the older `{ secrets: [...] }` envelope while sanitizing any `value_hash` field away.

Client-side `secrets.set` should validate the public secret key regex and the 4 KiB UTF-8 value cap for faster feedback. Gateway validation remains authoritative.

Do not add a new deploy helper in the first slice. The two-step primitive flow is simple, transparent, and available across SDK, CLI, and MCP. The "ultimate DX" future direction is an explicit helper that keeps values out of manifests, but this change should not mix secret writes into deploy manifests or shell-history-prone flags.

Alternatives considered:

- Add `--set-secret KEY=VALUE` to `deploy apply`. Rejected for v1 because it encourages shell-history leakage and mixes two authorities into one command.
- Require every caller to hand-roll the two-step flow. Accepted for v1 because it keeps authority boundaries clear and uses tools that already exist.

### D3. Legacy compatibility has per-surface rules

Legacy compatibility must not reintroduce value-bearing deploy specs. Apply this matrix:

| Surface | Behavior |
| --- | --- |
| `r.deploy.apply` / v2 `ReleaseSpec` | Reject `secrets.set` / `replace_all` locally before any CAS upload or plan request. |
| `apps.bundleDeploy(opts.secrets)` SDK in-memory option | Pre-validate keys/values, call `secrets.set` for each value, then deploy with `secrets.require` keys. Document non-atomicity. |
| MCP `bundle_deploy.secrets` | Preserve only as explicit legacy compatibility by writing secrets before deploy and warning that writes are not rolled back, or fail with a next action. Do not keep examples that encourage it. |
| CLI file or inline manifests with secret values | Fail with migration guidance. Do not silently pre-set, because that preserves the unsafe "commit secrets to repo" workflow. |
| Legacy `replace_all` | Fail. Exact replacement is not representable safely without a separate admin operation. |
| CI credentials | Never pre-set; CI credentials do not gain secret-write authority. |

`apps.bundleDeploy` and any legacy bundle output that reshapes deploy results must preserve or render `warnings`, otherwise plan warnings disappear from compatibility callers.

Alternatives considered:

- Remove all legacy secret options immediately. Rejected for in-memory SDK/MCP compatibility because those can preserve common workflows while keeping the deploy spec value-free.
- Try to emulate old `replace_all` semantics. Rejected because backend deploy specs no longer carry values and exact replacement semantics are not representable without a separate admin operation.

### D4. `WarningEntry` matches the gateway and controls one-shot apply

Use the gateway-exact type:

```ts
export interface WarningEntry {
  code: string;
  severity: "low" | "medium" | "high";
  requires_confirmation: boolean;
  message: string;
  affected?: string[];
  details?: Record<string, unknown>;
  confidence?: "low" | "medium" | "high";
}
```

`PlanResponse` SHALL include `warnings: WarningEntry[]`. The SDK should normalize `plan.warnings ?? []` for older tests/fixtures while typing the field as always present going forward. `DeployResult` SHALL include `warnings: WarningEntry[]`. `DeployEvent` SHALL include `{ type: "plan.warnings"; warnings: WarningEntry[] }` when non-empty.

Default `deploy.apply` policy:

- emit `plan.warnings` immediately after plan;
- if any warning has `requires_confirmation: true` or `code === "MISSING_REQUIRED_SECRET"`, abort before content upload or commit with a structured `Run402DeployError` that includes the warnings in `body` or `details`;
- allow explicit opt-in continuation through an apply option for advanced callers;
- keep low-level `plan` / `upload` / `commit` available for callers that intentionally set secrets between plan and commit.

CLI stdout final results and MCP final markdown must render warnings outside raw event streams. Missing-secret warnings should name affected keys and direct the agent to set secrets, then retry.

Alternatives considered:

- Keep warnings only on `plan()`. Rejected because `apply()` is the recommended agent primitive.
- Use `string[]`. Rejected because agents need stable fields.
- Let `deploy.apply()` continue by default and fail at commit. Rejected because it wastes uploads and gives agents a worse recovery point.

### D5. CI deploys still reject every `spec.secrets`

CI deploy credentials currently allow only `project`, `database`, `functions`, `site`, and absent/current `base`. This change does not relax that backend trust boundary. Under CI credentials, any `spec.secrets` property is rejected, including value-free `require` and `delete`.

Docs must say:

- local allowance-backed deploys may use `secrets.require`;
- GitHub Actions OIDC deploy manifests must omit `secrets`;
- secrets for CI-deployed functions must be set locally or admin-side before CI runs;
- future CI support for `secrets.require` needs a separate gateway/public design because it exposes secret-existence metadata.

Validation should detect unsafe old-shape fields before or alongside CI preflight so `secrets.set` gets a helpful "secret values do not belong in deploy manifests" message instead of only a generic "CI forbids secrets" error.

### D6. `value_hash` disappears everywhere

Remove `value_hash` from SDK `SecretSummary`, SDK tests, CLI/MCP formatted output, docs, and skills. `list_secrets` should show only keys and timestamp fields if present; if timestamps are absent in current fixtures, key-only output is enough.

Unknown extra runtime fields can be ignored. The SDK should sanitize list output so `value_hash` is not returned even if an older gateway includes it.

Alternatives considered:

- Keep `value_hash?: string` as optional for older gateways. Rejected because the goal is to stop teaching value-derived verification.

### D7. Docs are part of the contract

Use `documentation.md` as the checklist. Every agent-facing doc surface must teach:

- never put secret values in deploy manifests;
- use `set_secret` / `run402 secrets set` / `r.secrets.set` to write values;
- prefer file/env secret input examples over realistic inline secret values;
- use `secrets.require[]` only as a deploy-time dependency assertion;
- use `secrets.delete[]` to remove keys at activation;
- `list_secrets` is key-only and cannot verify values by hash;
- local deploys may use `secrets.require`, but CI OIDC deploy manifests must omit `secrets`;
- secret values still appear as function environment variables at runtime, so do not over-promise total runtime secrecy.

Related issues should be referenced in implementation notes, especially #151 for future local manifest validation and #198 for help/doc drift. Drift tests must be context-aware: ban deploy-manifest `"secrets": { "set": ... }`, `replace_all`, and `value_hash`, but allow correct APIs such as `r.secrets.set`, `run402 secrets set`, and MCP `set_secret`.

## Risks / Trade-offs

[Risk: compatibility shim writes secrets before a deploy that later fails] -> Mitigation: document non-atomicity, return clear output, and keep raw `deploy.apply` declaration-only.

[Risk: agents miss warnings because they only call `deploy.apply`] -> Mitigation: carry `warnings` onto `DeployResult`, emit `plan.warnings`, render warnings in CLI/MCP, and abort by default on confirmation-required warnings.

[Risk: docs still contain old value-bearing examples] -> Mitigation: add context-aware tests or sync assertions for deploy-manifest secret values, `replace_all`, and `value_hash` in public docs.

[Risk: TypeScript accepts old runtime JSON through `as any`] -> Mitigation: SDK `validateSpec` rejects old keys before uploads or plan calls.

[Risk: old gateway fixtures still include `value_hash`] -> Mitigation: normalize and sanitize list responses.

[Risk: aborting `deploy.apply` on warnings surprises advanced callers] -> Mitigation: document and test an explicit opt-in continuation option plus the low-level plan/upload/commit escape hatch.

## Migration Plan

1. Update SDK types/validation/warning propagation first; tests should fail on old secret shape.
2. Update secrets namespace route/list normalization so the two-step workflow works.
3. Update compatibility shims and CLI/MCP schemas using the per-surface policy.
4. Remove `value_hash` formatting and tests.
5. Update docs, skills, help snapshots, and sync tests.
6. Run build, focused SDK/MCP tests, CLI e2e/help tests, sync tests, skill tests, and a final context-aware scan for old contract strings.

Rollback is a source rollback only. The public client must match the deployed gateway; if the backend contract is live, reintroducing old fields is not a safe rollback.

## Open Questions

- Should a future local manifest-validation tool from #151 also validate that every `secrets.require[]` key exists locally/remotely before deploy? This change only updates the live deploy client contract.
