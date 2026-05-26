## Why

The CLI's stdout envelope is split roughly 50/50: about half of subcommands emit `{ status: "ok", ...payload }` on success, the other half emit the raw payload. The split happened organically and follows no documented rule, which produces three concrete failures:

1. **Wrong-reading output:** `run402 projects validate-expose` emits `{ "status": "ok", "hasErrors": true, ... }`. The outer "ok" only means "the HTTP call succeeded" but reads as "validation passed," contradicting the inner `hasErrors` and forcing readers to check exit codes to disambiguate.
2. **Agent confusion:** Agents parsing CLI output cannot rely on `status === "ok"` as a success gate, because half the commands never emit it. Today the only reliable success signal is `exit code === 0`.
3. **No documented contract:** `cli/llms-cli.txt` shows command-by-command examples but never spells out the envelope rule, so contributors guess — perpetuating the split with every new subcommand.

The current CLI is agent-first and JSON-only. A documented, uniform stdout shape is more valuable than a hand-wave wrapper.

## What Changes

- **BREAKING:** Every CLI subcommand emits its natural payload on stdout, with no top-level `status` field. Success is signaled exclusively by exit code 0 and the absence of a stderr error envelope.
- Mutations with no natural payload (e.g. `secrets set`, `subdomains release`, `functions delete`) return a minimal informative object instead of `{ status: "ok", message: "..." }` — e.g. `{ key: "FOO", project_id: "prj_..." }` or `{ name: "items", deleted: true }`. Never an empty object.
- Local-state inspection commands that previously used special top-level statuses (`status: "no_allowance"`, `status: "no_wallet"`) move to typed payload fields: e.g. `{ allowance: null, hint: "Run: run402 init" }` and `{ wallet: null, hint: "Run: run402 allowance create" }`. Exit code remains 0 — these are informational reads, not errors.
- The stderr error envelope is **unchanged**: `{ status: "error", code, message, retryable?, safe_to_retry?, ... }` written to stderr with non-zero exit. The `status` field is preserved there because stderr's role as an error sentinel makes the field's meaning unambiguous.
- The `doctor` command's per-check item statuses (`status: "ok" | "warning" | "missing" | "skipped"` inside `checks[]`) are **unchanged** — those are per-item findings inside a payload, not the envelope.
- `cli/llms-cli.txt` gets a new top-level "Output Contract" section documenting the stdout / stderr / exit-code contract; the existing per-command examples are updated to the new shapes.
- A drift-protection test enforces the contract: every CLI success-path `console.log(JSON.stringify(...))` site is checked to ensure it does not emit a top-level `status` field.

## Capabilities

### New Capabilities

- `cli-output-shape`: Public contract for the CLI's stdout/stderr/exit-code envelope across every subcommand — what success output looks like, what error output looks like, what exit codes mean, what the agent-parser invariants are, and what per-payload conventions exist for mutations vs reads vs local-state inspections.

### Modified Capabilities

- `cli-agent-deploy-ergonomics`: The existing `run402 deploy apply` final-only output requirement explicitly references `{ "status": "ok", ... }` as the stdout envelope. That requirement must be updated so its scenarios describe the new raw-payload shape; the underlying behavior (stderr suppression, final-only mode) is unchanged.
- `deploy-observability-client-surface`: The existing requirement mandates `{ "status": "ok", "release": ReleaseInventory }` and `{ "status": "ok", "diff": ReleaseToReleaseDiff }` envelopes for `deploy release get`/`active`/`diff`. Updated to emit `{ "release": ReleaseInventory }` and `{ "diff": ReleaseToReleaseDiff }` directly, conforming to the new contract.
- `expose-manifest-validation-client-surface`: The existing requirement mandates `status: "ok"` in the successful validation envelope. Updated to drop the `status` field; agents read `hasErrors` from the payload and the command continues to exit 0 even when `hasErrors` is true.

## Impact

- **CLI**: every `cli/lib/*.mjs` subcommand that currently emits a top-level `status` on success — roughly 68 emit sites across 25+ files (see audit). Each becomes a raw-payload emit; mutations gain explicit identifier/state fields; local-state commands move special statuses into typed payload fields.
- **CLI tests**: `cli-e2e.test.mjs`, `cli-help.test.mjs`, and any other test asserting `parsed.status === "ok"` — broad sweep. Snapshots and assertions update to the new shapes.
- **MCP**: no change. MCP tool handlers format markdown for human display and already use a different output pattern (`{ content: [{ type: "text", text }] }`). They wrap SDK results, not CLI output.
- **SDK**: no change. SDK methods already return raw payloads; only the CLI shims add the wrapper.
- **OpenClaw**: scripts re-export from CLI lib, so changes propagate automatically.
- **Docs**: `cli/llms-cli.txt` (canonical, gets the new Output Contract section + per-example updates), `cli/README.md`, `openclaw/SKILL.md` examples, root `SKILL.md` if it references CLI shapes, `documentation.md` index.
- **Drift protection**: new test in the existing CLI test suite that scans CLI sources for `JSON.stringify({ status:` patterns on success paths.
- **Breaking-change posture**: This is a breaking change to the CLI's machine-readable output shape. Major version bump for `run402` CLI package on next release. Agents already parsing CLI JSON output must migrate — but the migration is mechanical (drop the optional `.status` check; rely on exit code and the absence of stderr error envelope).
- **Out of scope**: The semantic question of whether `validate-expose` should report "couldn't cross-check (no migration supplied)" as severity `error` (raising `hasErrors`) vs severity `warning`. That is a gateway-side issue tracked separately in run402-private.
