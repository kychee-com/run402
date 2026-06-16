## Why

Gateway v1.91 (`48c928c3`) added an opt-in to the email→org project handoff: the sending owner may **retain a `developer` membership** in the recipient's org after the handoff completes, instead of being fully severed. It is dual-consent — the sender requests it at initiate, and the recipient must explicitly accept it at claim. The public client wraps the handoff (SDK `r.admin.transfers.initiateHandoff` / `claimHandoff`, CLI `transfer init` / `claim`) but sends none of the new fields, and the CLI's `assertKnownFlags` would hard-reject the flags — so an agent cannot opt in even by hand. This change wires the opt-in through the SDK + CLI.

## What Changes

- **NEW — sender requests retention at initiate.** `InitiateHandoffInput.retainCollaborator?: { role: "developer" } | null` → body `retain_collaborator`. Only `role: "developer"` is valid; the subject is always the initiating owner (a sender can only retain themselves). Gateway rejects a bad role with `INVALID_RETAIN_ROLE` and a missing actor with `RETAIN_SUBJECT_REQUIRED`.
- **NEW — recipient sees and accepts at claim.** A typed `retain_collaborator` block on `ProjectHandoffPreview` (`{ principal_id, role, sender_label, scope, note, accept_field }`); `ClaimHandoffInput.acceptRetainedCollaborator?: boolean` (default `false`) → body `accept_retained_collaborator`; `ClaimHandoffResult.retained_collaborator_principal_id: string | null`. Only an explicit `true` materializes the `developer` membership in the new org; default/`false` = full severance — **today's behavior, byte-for-byte**.
- **NEW — CLI flags.** `run402 transfer init --retain-collaborator <role>` (email/handoff rail only; validated against `{ developer }`, mirroring the existing `--billing-policy` validation) and `run402 transfer claim --accept-retained-collaborator` (boolean). OpenClaw inherits via the existing `transfer` re-export.
- **No MCP work.** The handoff is not exposed via MCP today (the transfers MCP tools cover only the wallet rail), so there is no tool to extend.
- **Docs + types:** `cli/llms-cli.txt` (+ `sdk/llms-sdk.txt`) document the retain opt-in, the dual-consent model, and the `INVALID_RETAIN_ROLE` / `RETAIN_SUBJECT_REQUIRED` codes; new public types are exported.

## Capabilities

### New Capabilities
- `handoff-retain-collaborator-client-surface`: the client surface for the v1.91 sender-retained `developer` membership on the email→org handoff — the `retainCollaborator` initiate option, the typed preview block, the `acceptRetainedCollaborator` claim option + `retained_collaborator_principal_id` result, and the `transfer init --retain-collaborator` / `transfer claim --accept-retained-collaborator` CLI flags. Spans SDK + CLI + docs (no MCP).

### Modified Capabilities
<!-- None. No transfer/handoff capability spec exists in openspec/specs/ today — the v1.59 handoff cascade shipped without one — so the retain opt-in is ADDED. `sdk-public-type-surface` stays satisfied via tasks (export the new types). -->

## Impact

- **SDK (`sdk/src/namespaces/transfers.ts`):** extend `InitiateHandoffInput` + the `initiateHandoff` body; add a typed `RetainCollaboratorPreview` block to `ProjectHandoffPreview`; extend `ClaimHandoffInput` + the `claimHandoff` body; add `retained_collaborator_principal_id` to `ClaimHandoffResult`; export the new types from the type-surface entry.
- **CLI (`cli/lib/transfer.mjs`):** `init` adds `--retain-collaborator <role>` (email rail only; validate the role against a `RETAIN_ROLES` set like `BILLING_POLICIES`; error if combined with a wallet `--to`) → `retainCollaborator`; `claim` adds `--accept-retained-collaborator` (boolean) → `acceptRetainedCollaborator`; help text + `assertKnownFlags` updated.
- **OpenClaw (`openclaw/scripts/transfer.mjs`):** inherits via the re-export; confirm command/flag parity in `sync.test.ts`.
- **MCP:** none.
- **Tests:** SDK unit (initiate sends `retain_collaborator` only when set; claim sends `accept_retained_collaborator` only when set; preview/result types parse); CLI e2e (flag plumbing, role validation, wallet-rail rejection of `--retain-collaborator`) registered in the `package.json` test allow-list; CLI help snapshot refresh.
- **Docs:** `cli/llms-cli.txt`, `sdk/llms-sdk.txt`.
- **Cross-repo:** gateway shipped (`48c928c3`, run402-private); the client ships independently. No gateway change.
