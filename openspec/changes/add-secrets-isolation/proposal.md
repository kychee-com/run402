## Why

Private gateway commits `01929adf`, `59199795`, `9855a977`, `31b4848b`, and `b393d752` made deploy specs value-free for secrets, encrypted the canonical backend store, removed value-derived secret signals, and added structured deploy warnings. The public SDK, CLI, MCP tools, OpenClaw surface, and docs still teach the old `secrets.set` / `secrets.replace_all` shape and `value_hash` listing, which would lead coding agents to author manifests the gateway now rejects and to over-trust a value-derived hash that no longer exists.

The public repo needs a KISS contract update: secret values are set out-of-band through the secrets API, deploy specs only declare required or deleted keys, and warnings are structured enough for agents to recover without guesswork.

## What Changes

- **BREAKING**: Update SDK `ReleaseSpec.secrets` from value-bearing `set` / `replace_all` to value-free `require?: string[]` and `delete?: string[]`.
- **BREAKING**: Remove `SecretSummary.value_hash` from SDK types, MCP `list_secrets` output, CLI help/docs, skills, and agent docs.
- Add a shared SDK `WarningEntry` type and wire `warnings: WarningEntry[]` through deploy plan/apply result surfaces so agents can detect `MISSING_REQUIRED_SECRET` and similar non-fatal plan notes.
- Update SDK normalization, validation, tests, scoped-client wrappers, and CI deploy preflight rules for the new secret shape.
- Update CLI `deploy apply` manifest examples and parsing guidance so manifests use `secrets.require` and `secrets.delete`; keep secret values in `run402 secrets set`, not JSON manifests.
- Update MCP `deploy` schema and tool descriptions so agents call `set_secret` first, then `deploy` with `secrets.require`.
- Update legacy compatibility shims (`apps.bundleDeploy`, legacy CLI/MCP bundle surfaces) to stop putting values into `ReleaseSpec`; either pre-set secrets via the secrets API and convert keys to `require`, or fail with a structured/actionable error if a safe project-scoped pre-set is not possible.
- Update README, SDK/CLI docs, `llms*.txt`, skills, OpenClaw docs, sync tests, and help snapshots using `documentation.md` as the checklist.
- Add focused tests for the new type contract, warning propagation, docs/help drift, MCP formatting, CLI manifest examples, and old-shape rejection.

## Capabilities

### New Capabilities

- `secrets-isolation-client-contract`: Public SDK/CLI/MCP/OpenClaw/docs contract for value-free deploy secret declarations, structured deploy warnings, and write-only secret listing with no value-derived hash.

### Modified Capabilities

- None.

## Impact

- **SDK**: `sdk/src/namespaces/deploy.types.ts`, `deploy.ts`, `apps.ts`, `secrets.ts`, scoped exports, root and `/node` exports, CI spec restrictions, and related tests.
- **CLI/OpenClaw**: `cli/lib/deploy-v2.mjs`, `cli/lib/deploy.mjs`, `cli/lib/secrets.mjs`, help snapshots, e2e tests, `openclaw/SKILL.md`, and OpenClaw command guidance.
- **MCP**: `src/tools/deploy.ts`, `src/tools/list-secrets.ts`, `src/tools/bundle-deploy.ts`, tool descriptions in `src/index.ts`, and tool tests.
- **Docs**: `README.md`, `sdk/README.md`, `sdk/llms-sdk.txt`, `cli/README.md`, `cli/llms-cli.txt`, `llms.txt`, `SKILL.md`, `openclaw/SKILL.md`, and any doc surfaces flagged by `documentation.md`.
- **Related feature requests identified**: no exact open "secrets isolation" feature request exists. Related issues are [#151](https://github.com/kychee-com/run402/issues/151) (open enhancement: local manifest validation loop for agents), [#225](https://github.com/kychee-com/run402/issues/225) (open enhancement: deploy auto-retry on safe-to-retry errors, adjacent agent deploy DX), and [#10](https://github.com/kychee-com/run402/issues/10) (closed enhancement: browser/admin secret management). Also relevant but not feature-request-labeled: [#198](https://github.com/kychee-com/run402/issues/198) on outdated deploy help showing value-bearing secret examples.
