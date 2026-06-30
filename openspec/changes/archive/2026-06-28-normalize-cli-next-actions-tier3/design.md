## Context

Run402's lower layers already carry typed suggested next actions for the main error paths. A previous cold-start change deliberately left a few uncommon CLI-only paths as a Tier-3 follow-up: cache command validation, function rebuild guidance, deploy CI/warning fallback guidance, and skill examples that still showed `action`.

This change cleans up that tail without moving ownership upward. Gateway and SDK actions remain authoritative; the CLI only authors typed guidance where the error originates in the CLI or where it is adding a local fallback for a gateway warning that did not provide actions.

## Goals / Non-Goals

**Goals:**
- Remove bare-string and `{ action }` `next_actions` authored by CLI modules.
- Keep CLI suggested commands useful for coding agents by placing shellable guidance in `command` and rationale in `why`.
- Add a guard so future CLI code cannot accidentally reintroduce the Tier-3 shape.
- Align public skill examples with the canonical action discriminator.

**Non-Goals:**
- Changing the gateway/API error envelope.
- Changing SDK `Run402Error` construction.
- Adding, removing, or renaming CLI commands.
- Rewriting CLI modules into SDK calls beyond the narrow next-action cleanup.

## Decisions

### D1 -- Preserve lower-layer authority

If an SDK/API/gateway error already has a non-empty `next_actions` array, the CLI keeps it. Local action generation remains a fallback for CLI-only argument validation and deploy-warning enrichment where no structured lower-layer action exists.

### D2 -- Use canonical typed action objects everywhere the CLI authors guidance

Local CLI guidance uses the existing typed shape:

```json
{ "type": "edit_request", "command": "run402 cache inspect <url>", "why": "Provide the URL to inspect." }
```

`type` communicates the category of next step; `command` carries exact CLI invocations when available; `why` keeps prose outside the machine discriminator.

### D3 -- Keep the test simple and source-level

The highest-risk regression is a future `fail({ next_actions: ["..."] })` in `cli/lib`. A lightweight source scanner is enough to catch local literal regressions without coupling every command path to an end-to-end fixture.

## Risks / Trade-offs

- Existing agents that only understand string entries could see richer objects on the remaining Tier-3 paths. This is intentional alignment with the canonical contract and affects error guidance only.
- A source-level scanner may miss dynamically constructed non-canonical arrays. The cleanup keeps dynamic helper outputs typed, and the scanner targets the recurring literal forms.

## Open Questions

None.
