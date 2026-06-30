## Why

The CLI still has a Tier-3 tail of locally-authored `next_actions` that are bare strings or use `{ action }` instead of `{ type }`. That means coding agents can receive parseable guidance on the main SDK/gateway paths, then lose structure on less common CLI-only validation and deploy-warning paths.

## What Changes

- Normalize every remaining CLI-authored `next_actions` entry to the typed object shape: `{ type, command?, method?, path?, auth?, why? }`.
- Preserve non-empty `next_actions` received from the SDK/API/gateway as the source of truth; CLI enrichments only fill local fallback guidance or CLI-only validation errors.
- Update public agent-facing examples that still show `{ action }` so they teach the canonical `{ type }` shape.
- Add a regression test that scans CLI sources and fails on bare-string `next_actions` entries or `{ action }` entries.
- No CLI command, SDK API, MCP tool, or HTTP API surface changes.

## Capabilities

### New Capabilities

- `cli-output-contract`: the machine-readable CLI stderr contract for suggested next actions, including CLI-authored fallback guidance and SDK/gateway pass-through behavior.

### Modified Capabilities

None.

## Impact

- **CLI implementation:** `cli/lib/cache.mjs`, `cli/lib/deploy-v2.mjs`, `cli/lib/functions.mjs`, `cli/lib/secrets.mjs`, `cli/lib/subdomains.mjs`, and any other CLI module found with non-canonical local `next_actions`.
- **Docs/examples:** `SKILL.md` and `openclaw/SKILL.md` examples that still use `{ action }`.
- **Tests:** targeted CLI output contract coverage plus affected tests that assert specific next-action content.
- **Compatibility:** successful commands and endpoint contracts are unchanged. Error envelopes keep the `next_actions` field but use the typed shape consistently for CLI-authored entries.
