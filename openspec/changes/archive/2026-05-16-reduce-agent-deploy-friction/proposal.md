## Why

A real demo-app build exposed a cluster of agent-first friction across unified deploy manifests, deploy CLI behavior, secret input, runtime helpers, and tier validation. These are not isolated polish items: together they turn strict platform contracts into guess-and-retry loops, and they block agents from shipping common full-stack app flows in one atomic release.

## What Changes

- Publish and document the complete unified `ReleaseSpec` authoring shape, including a JSON Schema, canonical `FunctionSpec` nesting, `$schema` manifest tolerance, valid cache classes, subdomain replace/patch semantics, and policy trigger details.
- Add `@run402/functions` image-generation support through `ai.generateImage(...)`, billed against project-owned runtime budget rather than an agent's local allowance wallet.
- Make secret writes pipe-friendly by accepting stdin-safe input for `run402 secrets set` without requiring temporary files or shell-history-bearing inline values.
- Replace blanket deploy-warning confirmation with targeted warning acknowledgement by code and, for read-only wildcard routes, durable manifest-level acknowledgement.
- Add a deploy result-only mode for agent/CI invocations so callers can request the final JSON envelope without event-stream noise.
- Reject obvious tier-cap violations for function timeout, memory, schedules, and scheduled-function count locally before CAS upload, migrations, builds, or activation.
- Ensure static activation/spec violations surface promptly instead of leaving `deploy apply` in a long retry/poll loop when no automatic retry can succeed.
- Update agent-facing docs and drift tests so these contracts stay visible in `llms-cli.txt`, `llms-sdk.txt`, skills, and help output.
- No breaking changes to existing successful deploy manifests, SDK calls, or runtime helper behavior.

## Capabilities

### New Capabilities

- `release-spec-authoring-dx`: Public contract for editor-validatable unified deploy manifests and agent documentation covering `ReleaseSpec`, `FunctionSpec`, policy trigger semantics, tier caps, and schema references.
- `functions-runtime-image-generation`: In-function image-generation helper contract for `@run402/functions`, including billing ownership, limits, result shape, and optional blob-storage convenience.
- `cli-agent-deploy-ergonomics`: CLI contract for stdin-safe secret input, final-result-only deploy output, targeted warning acknowledgement, and local tier-cap deploy preflight.

### Modified Capabilities

- `secrets-isolation-client-contract`: Secret values remain out-of-band and write-only, but the CLI gains an agent-safe stdin input path for setting those values.
- `deploy-web-routes-client-surface`: Route warning recovery gains scoped acknowledgement for intentional read-only wildcard routes instead of requiring blanket confirmation.
- `deploy-safe-retry-client-contract`: Deploy apply retry/poll behavior must not mask terminal static spec violations such as tier-ineligible function configuration.
- `sdk-structured-local-errors`: Local deploy preflight failures for tier caps must use structured, agent-readable errors with field/value/limit details.

## Impact

- **SDK**: deploy types, manifest validation/normalization, schema generation or schema artifact publication, structured local errors, retry/poll classification, public type exports, and unit/type-contract tests.
- **Functions library**: `functions/src/index.ts` AI helper surface, runtime gateway endpoint contract for project-billed image generation, types, docs, and tests.
- **CLI/OpenClaw**: `run402 deploy apply`, `run402 secrets set`, help text, JSON output tests, e2e tests, and OpenClaw command parity where relevant.
- **MCP**: deploy warning acknowledgement schema/output where MCP exposes deploy confirmation, plus docs if MCP accepts release specs with `$schema`.
- **Docs/skills**: `llms-cli.txt`, `llms-sdk.txt`, README/SDK README as needed, root `SKILL.md`, `openclaw/SKILL.md`, and doc surfaces identified by `documentation.md`.
- **Gateway/private coordination**: project-billed image generation from deployed functions, tier-limit source of truth, warning-code acknowledgement semantics, manifest JSON Schema hosting at `https://run402.com/schemas/release-spec.v1.json`, and exact policy trigger SQL documentation.
- **Related user issues**: kychee-com/run402#334, #335, #336, #337, #338, #339, #340, and #341.
