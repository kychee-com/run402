## Context

The CLI's stdout envelope grew without a documented contract. An audit of every subcommand in `cli/lib/*.mjs` found:

- 68 subcommands emit `{ status: "ok", ...payload }` on success.
- 68 subcommands emit a raw payload (object, array, or text) with no top-level `status` field.
- 1 subcommand (the `email webhooks` namespace) is mixed across its own sub-verbs.
- The split correlates loosely — but not reliably — with command type. Reads and list-style commands tend to be raw-payload; mutations with nothing else to return tend to be wrapped. The pattern is broken constantly: `apps update` wraps but `apps publish` does not; `contracts set-recovery` wraps but `contracts call` and `contracts deploy` do not; `email send` wraps but `functions deploy` does not.
- Five distinct top-level `status` values exist: `"ok"`, `"error"`, `"no_allowance"`, `"no_wallet"`, plus per-item-only `"missing" | "warning" | "skipped"` inside `doctor`'s `checks[]`. Only `"error"` is on stderr; the rest are on stdout.

The trigger for this change was a real-world friction report: `run402 projects validate-expose` emits `{ "status": "ok", "hasErrors": true, ... }` when validation finds issues. The outer `"ok"` only describes "the HTTP call returned 200" but reads as "validation passed," contradicting the payload and forcing the user to check exit code to disambiguate. The same shape problem latently exists in every wrapped-payload command — `validate-expose` is just the loudest example.

The CLI is agent-first and JSON-only by design (`feedback_agent_first_cli`). A documented uniform stdout shape across all subcommands is more valuable than a half-applied wrapper that agents cannot rely on.

Current state notes:

- The error envelope (`{ status: "error", code, message, ... }`) is centralized in `cli/lib/sdk-errors.mjs` and always written to stderr with non-zero exit.
- The success-path emit sites are scattered across ~25 files with no shared helper.
- The contract is not documented in `cli/llms-cli.txt`, only demonstrated through per-command examples.

## Goals / Non-Goals

**Goals:**

- Specify a single, documented stdout contract that applies to every CLI subcommand without exception.
- Eliminate the contradiction between an "ok" outer envelope and a payload that contains validation/business failures.
- Give agents one reliable parse path: parse stdout as JSON (or treat as text for the small set of plain-text commands), use exit code for success/failure, parse stderr only when exit code is non-zero.
- Keep the error envelope on stderr stable so the breaking change is scoped to the success path only.
- Add a drift-protection test so this never regresses.

**Non-Goals:**

- Change the stderr error envelope shape, error codes, or exit-code conventions. Agents already parsing errors should see no change.
- Change MCP tool output (`{ content: [{ type: "text", text }] }`). MCP is human-display-oriented and uses a separate shape; it is not affected.
- Change SDK return types. SDK methods already return raw payloads; only the CLI shims add the wrapper that this change removes.
- Redesign individual command payloads beyond the minimum needed to absorb the wrapper removal (i.e., mutations that previously returned `{ status: "ok", message: "..." }` need *some* informative payload, but we are not redesigning what each command means).
- Address the gateway-side `validate-expose` severity question (whether "couldn't cross-check" should be a warning instead of an error). Tracked separately in run402-private.
- Provide a transitional `--legacy-envelope` flag. The migration is mechanical and the maintenance cost of two parallel shapes outweighs the smoothing benefit.

## Decisions

1. **Success-path stdout emits the raw payload, never a wrapper.**

   Every CLI success path emits a JSON value directly: an object with the command's natural fields, an array for list-style commands, or plain text for the small set of commands that explicitly return text (e.g. `allowance export`). No top-level `status` field appears on stdout success paths.

   Alternatives considered: (a) normalize the other way — every command emits `{ status: "ok", ...payload }`. Agent-friendly in that there is always a single shape, but adds noise to read commands whose payload already speaks for itself, and breaks the same set of consumers regardless. (b) Keep both styles, document the rule ("status when payload is uninformative, raw otherwise"). The rule has been violated constantly because the line is fuzzy and judgment-based; codifying it is not enforcement.

2. **Mutations with no natural payload echo the affected resource identifiers and an explicit state field.**

   Commands like `secrets set`, `subdomains release`, `functions delete`, `assets rm`, `email delete` currently return `{ status: "ok", message: "..." }`. They become `{ key, project_id, set: true }`, `{ name, released: true }`, `{ name, project_id, deleted: true }`, `{ key, deleted: true }`, etc. The shape rule: echo the identifying fields of the affected resource, plus one explicit boolean state field naming what happened. Never emit an empty object.

   Alternatives considered: (a) return a fetched copy of the resource after mutation. Costs an extra round-trip for many commands and contradicts the principle that the SDK already provides typed reads. (b) return only `{ deleted: true }` with no identifiers. Less useful — the agent loses the context of which resource the mutation applied to (relevant when piping through other tools). (c) reuse the existing `message` field with no structured state. Strings are not machine-friendly; explicit boolean fields are.

3. **Local-state inspection commands move special statuses into typed payload fields.**

   The two existing non-`"ok"` non-`"error"` top-level statuses are `status: "no_allowance"` (in `run402 status`) and `status: "no_wallet"` (in `run402 allowance status`). They become typed nullable payload fields with a hint:

   - `run402 status`: `{ allowance: null, hint: "Run: run402 init" }` when absent; `{ allowance: { ...details } }` when present.
   - `run402 allowance status`: `{ wallet: null, hint: "Run: run402 allowance create" }` when absent; `{ wallet: { address, rail, ... } }` when present.

   Exit code remains 0 in both cases — these are informational reads, not errors. The `hint` convention is reused from the existing error envelope (where `hint` already provides actionable guidance) so agents see a consistent field name across success and error paths for "what to try next."

   Alternatives considered: (a) make absent-local-state a stderr error (exit 1). That conflates "you don't have credentials" with "the command failed" — it is normal and expected for a first-run user to see absent state, and exit 1 would force callers to special-case the exit code. (b) keep the `status: "no_allowance"` shape unchanged for these two commands specifically. Carving out two exceptions defeats the uniform-contract goal.

4. **The `doctor` per-check item statuses inside `checks[]` are unchanged.**

   `doctor` emits something like `{ checks: [{ name, status: "ok" | "warning" | "missing" | "skipped", ... }, ...] }`. The `status` field there is a per-finding label inside a payload, not the envelope; it is part of how `doctor` reports each individual check's outcome. This is in scope for the spec to document but out of scope for the wrapper removal.

5. **The stderr error envelope is unchanged.**

   The contract on stderr remains `{ status: "error", code, message, retryable?, safe_to_retry?, hint?, retry_after?, ... }` with non-zero exit. The `status` field is preserved because stderr's role as the error channel makes the field's meaning unambiguous — it is the sentinel that says "this is an error envelope, parse the standard fields." Removing it from stderr would force callers to either trust exit code alone (less informative) or to sniff for the presence of `code` and `message` (fragile).

   Alternatives considered: drop `status` from stderr too, for symmetry. Rejected because it would double the breaking-change surface for no agent-facing benefit — the stderr shape is already a clear error sentinel by virtue of the channel.

6. **A drift-protection test enforces the contract.**

   A new test in the existing CLI test suite (most likely a new file `cli-output-contract.test.mjs` invoked from `npm test`) statically scans `cli/lib/*.mjs` for `JSON.stringify({ status:` patterns and fails on any match that is not on a path leading to `process.stderr.write` or to `reportSdkError`. The test maintains an explicit allowlist of stderr-bound emit sites (essentially the body of `sdk-errors.mjs`) and rejects anything else.

   Alternatives considered: (a) a runtime registry where every command registers its output shape. More invasive and adds surface area at every emit site. (b) a snapshot test of every command's success output. Brittle — snapshot tests routinely produce false positives on intentional payload changes. The static scan is narrower: it only fires on the specific pattern we are eliminating.

7. **All changes ship in one release; no transitional flag.**

   A `--legacy-envelope` opt-in would extend the lifetime of the inconsistency it is trying to remove and double the test matrix. Instead: ship as a major-version bump (`run402` v3.0.0), call the break out clearly in the CHANGELOG and `llms-cli.txt`, and rely on the mechanical nature of the migration (downstream agents drop the optional `.status` check and rely on exit code).

   Alternatives considered: phased rollout (e.g. one command group per minor release). Rejected because it perpetuates the current inconsistency for the duration of the rollout and gives agents a moving target.

## Risks / Trade-offs

- **[Breaks downstream agents parsing `result.status === "ok"`]** → Documented in CHANGELOG, called out in `llms-cli.txt` Output Contract section, and surfaced on the npm package readme. The fix is mechanical: drop the `.status` check, gate on exit code. Risk is bounded because the CLI is agent-first and the documented migration path is one line per consumer.
- **[Mutations losing the human-readable `message` field]** → For commands that previously returned `{ status: "ok", message: "Secret 'FOO' set for project prj_..." }`, the new shape is `{ key: "FOO", project_id: "prj_...", set: true }`. Human users who run these interactively lose the friendly sentence. Mitigation: the new payload is more informative for agents (structured); for human users the exit code + the absence of a stderr error envelope is the success signal, and the echoed identifiers tell them what was affected. Adding an explicit `--human` mode that prints a sentence is out of scope (would re-fragment the surface).
- **[Drift-protection test produces false positives if a future command legitimately needs `status` on stdout for non-error reasons]** → The test allowlist is checked into the same repo as the test. If a real new need arises, the contributor updates the allowlist with a justification in the PR. The friction is the point: it forces a deliberate exception rather than letting the pattern reappear silently.
- **[The `doctor` per-item `status` field could confuse readers who expect the new contract to apply uniformly]** → The new `llms-cli.txt` Output Contract section explicitly calls out that per-item statuses inside payloads are not the same as envelope statuses. The drift-protection test is scoped to top-level emit sites and will not fire on `checks[].status`.
- **[OpenClaw consumers parse the same JSON]** → OpenClaw scripts re-export from CLI lib, so the new shapes propagate without any OpenClaw-side code change, and any OpenClaw consumers parsing the output face the same mechanical migration as CLI consumers. Documented in `openclaw/SKILL.md` examples.

## Migration Plan

1. Land the spec and tests first in a feature branch. The drift-protection test fails initially against current code — that failing test is the punch list for which subcommands still need fixing.
2. Walk through CLI files in roughly the audit order, converting wrapped emits to raw payloads. Co-update the corresponding `cli-e2e.test.mjs` and `cli-help.test.mjs` assertions in the same commit so tests stay green per-file.
3. Update `cli/llms-cli.txt`: add the top-level Output Contract section, then sweep per-command examples for `"status": "ok"` and replace with the new shapes.
4. Update `cli/README.md`, `openclaw/SKILL.md`, root `SKILL.md` (if it cites CLI shapes), and any other surfaces listed in `documentation.md`.
5. Bump `run402` CLI package to a major version. Write the CHANGELOG entry calling out the breaking change with one example before/after pair.
6. Publish through the existing `/publish` flow.
7. Rollback strategy: revert is mechanical (the change is additive-then-subtractive; reverting the commit set restores the prior shapes). Pinning to the prior `run402` major version on npm is the consumer-side rollback.

## Open Questions

- Should `run402 status` and `run402 allowance status` use the same `hint` field name they share with the stderr error envelope, or should they use a distinct field like `next_step` to avoid implying these are errors? Current decision: reuse `hint` for cross-channel consistency, but flag for review during the spec sweep.
- The audit found `email webhooks` as the lone MIXED case. The new contract makes the answer obvious (drop all wrappers there), but it is worth a quick sanity check during implementation to confirm no consumer is keying off the inconsistent shapes.
