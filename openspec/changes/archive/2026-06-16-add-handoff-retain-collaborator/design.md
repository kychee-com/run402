## Context

Gateway v1.91 (`48c928c3`) extends the email→org handoff rail (recipient is an email, resolved to an org at claim) with an optional sender-retained `developer` membership. Three wire points change:

- **Initiate** `POST /projects/v1/:project_id/handoffs` — optional `retain_collaborator: { role: "developer" } | null`. Only `developer`; subject is always the initiating owner. Bad role → `400 INVALID_RETAIN_ROLE`; no actor → `400 RETAIN_SUBJECT_REQUIRED`.
- **Preview** `GET /agent/v1/handoffs/:transfer_id` — response gains a top-level `retain_collaborator` sibling: `null` or `{ principal_id, role, sender_label, scope: "organization", note, accept_field: "accept_retained_collaborator" }`.
- **Claim** `POST /agent/v1/handoffs/:transfer_id/claim` — optional `accept_retained_collaborator: boolean` (default `false`); response gains `retained_collaborator_principal_id: string | null`. The membership is created in the new org, after the authority wipe, `ON CONFLICT DO NOTHING`.

Public state (`sdk/src/namespaces/transfers.ts`, `cli/lib/transfer.mjs`): `initiateHandoff` sends `{ to_email, message? }`; `claimHandoff` sends `{ organization_id? }`; `ProjectHandoffPreview` / `ClaimHandoffResult` are forward-compatible (`[key: string]: unknown`) so the new response fields already pass through untyped but unsurfaced. The CLI `init` value flags are `--project/--to/--billing-policy/--message/--kysigned`; `claim` accepts only `--into`; both are `assertKnownFlags`-gated, so the new flags must be registered.

## Goals / Non-Goals

**Goals:**
- Let a sender opt into retaining a `developer` membership at initiate, and let a recipient see and explicitly accept it at claim, via SDK + CLI.
- Keep the default path (no retain) byte-for-byte unchanged.

**Non-Goals:**
- Any MCP surface (handoff is not in MCP).
- The wallet transfer rail (retain is handoff-only).
- Re-modeling membership management — revocation uses the existing org member route.

## Decisions

### Decision 1 — `--retain-collaborator <role>` value flag, validated like `--billing-policy`

Model the CLI flag as a value flag accepting a role, validated against a `RETAIN_ROLES = new Set(["developer"])` (mirroring the existing `BILLING_POLICIES` pattern), rather than a boolean `--retain-as-developer`. Rationale: faithful to the gateway's `{ role }` shape, forward-compatible if more roles are added, and consistent with the file's existing validated-value-flag idiom. Maps to `retainCollaborator: { role }`.

### Decision 2 — Retain is rejected on the wallet rail

`--retain-collaborator` is meaningful only when `--to` is an email (handoff). If combined with a wallet `--to`, the CLI fails with `BAD_FLAG` ("--retain-collaborator applies only to email handoffs"), matching how the rail split already routes email vs wallet. This keeps the one-noun-two-rails model coherent.

### Decision 3 — `--accept-retained-collaborator` is a boolean

The claim field is `accept_retained_collaborator: boolean` (default `false`), so the CLI flag is a presence boolean → `acceptRetainedCollaborator: true`. Absent = `false` = today's full-severance claim.

### Decision 4 — Type the preview/result fields; keep the index signature

Add a typed `RetainCollaboratorPreview` block to `ProjectHandoffPreview` and `retained_collaborator_principal_id: string | null` to `ClaimHandoffResult`, while keeping the `[key: string]: unknown` index signature. Rationale: the recipient's decision depends on seeing `sender_label`/`note`/`accept_field`, so it should be typed, not pass-through; the open index keeps forward-compat for other gateway additions.

### Decision 5 — Send new body fields only when set

`initiateHandoff` adds `retain_collaborator` to the body only when `retainCollaborator !== undefined`; `claimHandoff` adds `accept_retained_collaborator` only when `acceptRetainedCollaborator !== undefined`. Omitting them reproduces the current request bytes exactly, so existing callers and tests are unaffected.

## Risks / Trade-offs

- **`role` value drift** if the gateway later accepts more roles → the validated `RETAIN_ROLES` set is a one-line update; the SDK type widens from the literal `"developer"` then.
- **Recipient ignores the offer** (claims without `--accept-retained-collaborator`) → that is the intended default (no membership); the preview surfaces the offer so an agent can decide.
- **CLI e2e silently skipped** if a new test file isn't registered → explicit task to add it to the `package.json` allow-list.

## Open Questions

- **Flag naming:** `--retain-collaborator <role>` vs a boolean `--retain-as-developer`. Leaning value-flag (Decision 1) for wire-fidelity; confirm at apply time.
