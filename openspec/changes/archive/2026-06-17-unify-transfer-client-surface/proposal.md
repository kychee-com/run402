## Why

The gateway now exposes project transfer as **one noun** — `POST /projects/v1/:id/transfers` discriminated by `to_wallet` XOR `to_email` — having deleted the parallel `/handoffs/*` surface outright (private `unify-project-transfer-surface`, shipped + live: `GET /agent/v1/handoffs/incoming` returns **404** in prod right now). The run402-public client still speaks the deleted two-noun surface: five `*Handoff` SDK methods, two CLI flag-paths, and their docs all hit `/handoffs*` and 404. This change collapses the client onto the one unified noun — a true **collapse**, not a re-point of the old method names — so the typed SDK shape mirrors the gateway's "tell the agent the next step, don't make it know the API" intent. Pre-launch with zero published consumers, we delete the old surface with no compat window.

## What Changes

- **BREAKING — remove the five `*Handoff` SDK methods** (`initiateHandoff`, `listIncomingHandoffs`, `previewHandoff`, `claimHandoff`, `cancelHandoff`) and their handoff-only types. No deprecated aliases.
- **Fold the email recipient into the existing transfer methods** — the SDK is the single typed source of truth:
  - `initiate({ projectId, toWallet | toEmail, ... })` accepts **exactly one** of `toWallet`/`toEmail` (both-or-neither → local `BAD_USAGE`, mirroring the gateway `400 VALIDATION_ERROR`); the email path carries `message?` + `retainCollaborator?`.
  - `listIncoming` / `listOutgoing` / `preview` / `cancel` become **kind-agnostic**; summaries + preview gain `recipient_kind: "wallet" | "email"` and `to_email?`, and `to_wallet` becomes nullable.
  - **New typed `claim(transferId, { organizationId?, acceptRetainedCollaborator? })`** — the email completion (`POST /agent/v1/transfers/:id/claim`), the email analog of `accept`. It persists the new owner's project keys on success the same way `accept` does (#428 parity) **if** the gateway returns them (verified as an early task — this is exactly the CLOSED-interface key-drop bug that bit v3.2.0).
- **One unified type surface**: a single `TransferSummary` / `ProjectTransferPreview` carrying `recipient_kind`, optional `to_email`, nullable `to_wallet`, and the typed `retain_collaborator` offer block on the email path.
- **Error**: surface `WRONG_COMPLETION_FOR_TRANSFER_KIND` (409) through the existing `Run402Error.nextActions` parse (sibling-completion hint on the same `transfer_id`); remove any `WRONG_TRANSFER_KIND` reference.
- **CLI (thin shim)**: keep `transfer init --to <wallet|email>` (already auto-detects by `@`); re-point every `allowanceAuthHeaders` signing path from `/handoffs*` → `/transfers*` (path-scoped EIP-191 must match the endpoint or auth fails); **drop the now-obsolete `--handoff` (preview/cancel) and `--handoffs` (list) flags** since the surface is kind-agnostic; `transfer claim` re-points to `/transfers/:id/claim`; keep `--retain-collaborator` (email init) + `--accept-retained-collaborator` (claim).
- **MCP (thin shim, ultimate-DX parity)**: extend `initiate_project_transfer` to accept `to_email` (+ the retain opt-in) and **add a `claim_project_transfer` tool**, so MCP reaches the full unified surface — closing the prior "handoff not in MCP" gap.
- **Docs**: `cli/llms-cli.txt` + `SKILL.md` rewritten to the one-noun surface; all `/handoffs` / `--handoff` mentions removed. Doc nuance: initiate authority is owner-**OR**-admin (was "owner-only").

## Capabilities

### New Capabilities
- `unified-transfer-client-surface`: the collapsed client surface — one `initiate` (wallet XOR email), kind-agnostic `preview`/`cancel`/`listIncoming`/`listOutgoing` carrying `recipient_kind`, a new typed `claim` completion (with key-persistence parity to `accept`), removal of the five `*Handoff` methods and their types, the CLI thin-shim (auto-detect, dropped `--handoff`/`--handoffs` flags, re-pointed signing paths), the MCP email-initiate + `claim_project_transfer` tools, and `WRONG_COMPLETION_FOR_TRANSFER_KIND` surfacing.

### Modified Capabilities
- `handoff-retain-collaborator-client-surface`: the v1.91 retain-collaborator opt-in **re-homes** from the dedicated handoff rail onto the unified transfer noun — `initiate` with `toEmail` (sender opts in) and the new `claim` method (recipient accepts). The offer block is surfaced by the kind-agnostic `preview` (not `previewHandoff`). The prior "no MCP surface is added" requirement changes: the opt-in is now reachable through the unified transfer MCP tools, at parity with CLI/OpenClaw.

## Impact

- **SDK**: `sdk/src/namespaces/transfers.ts` (methods + types), `sdk/src/errors.ts` (comment/doc only — generic `nextActions` parse already covers the renamed code).
- **CLI**: `cli/lib/transfer.mjs` (signing paths, dropped flags, `claim` re-point) + help/`SUB_HELP` text.
- **MCP**: `src/tools/transfers.ts` + `src/index.ts` (extend `initiate_project_transfer`, add `claim_project_transfer`).
- **OpenClaw**: inherits via the `openclaw/scripts/transfer.mjs` re-export — parity is automatic.
- **Tests**: `sync.test.ts` SURFACE + `SDK_BY_CAPABILITY` (collapse the five handoff capability rows, re-point endpoints, register the new MCP tool), transfers unit tests (re-point + new `claim` + email-`initiate`), CLI help snapshots, `SKILL.test.ts` if tool counts change.
- **Docs**: `cli/llms-cli.txt`, `SKILL.md`.
- **Release**: next lockstep `run402-mcp` + `run402` + `@run402/sdk` (post-v3.2.0).
- **No gateway dependency** — the gateway is already shipped + live; this is the gateway-last public cascade (private task 6.1).
