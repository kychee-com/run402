## 1. Verify gateway facts (BLOCKING — do first)

- [x] 1.1 Read the private gateway claim handler — the first read found `claim` returned NO `anon_key`/`service_key` (wallet `accept` appends them, claim did not). Surfaced to the gateway team → confirmed an **oversight** (#428's accept credentials were never mirrored to the just-shipped `claim`), now **fixed + deployed** (`project-transfer-claim-credentials`, commit `544ad867`, prod): `claim` returns `anon_key` + `service_key`, byte-identical to `accept`. → `claim` persists the keys like `accept` (Decision 3 updated).
- [x] 1.2 Confirmed against `origin/main`: initiate is `to_wallet` XOR `to_email` on `POST /projects/v1/:id/transfers` (both-or-neither → `400 VALIDATION_ERROR`, `details.fields`); incoming/outgoing rows are stamped `recipient_kind` (+ `to_email`).

## 2. SDK types (`sdk/src/namespaces/transfers.ts`)

- [x] 2.1 Make `InitiateTransferInput` accept `toWallet` XOR `toEmail` (discriminated union `InitiateWalletTransferInput | InitiateEmailTransferInput` with the runtime guard as backstop); the email path carries `message?` + `retainCollaborator?: { role: "developer" } | null`.
- [x] 2.2 Add `recipient_kind: "wallet" | "email"` and `to_email?: string` to `TransferSummary`; type `to_wallet` as `string | null` (optional); added `from_organization_id?` for email rows.
- [x] 2.3 Folded `recipient_kind`, `to_email?`, nullable `from_wallet`/`to_wallet` (+ displays), and the typed `retain_collaborator` block into `ProjectTransferPreview`; kept `RetainCollaboratorPreview` as the block's type.
- [x] 2.4 Defined `ClaimTransferResult` per task 1.1 (post-fix): `{ status: "accepted"; project_id; to_organization_id; created_new_org; retained_collaborator_principal_id: string | null; anon_key: string; service_key: string }`. Added `InitiateEmailTransferResult` `{ status, transfer_id, to_email, expires_at }`.
- [x] 2.5 Deleted the handoff-only types: `InitiateHandoffInput`, `ClaimHandoffInput`, `HandoffResult`, `HandoffSummary`, `ProjectHandoffPreview`, `ClaimHandoffResult`.

## 3. SDK methods (`sdk/src/namespaces/transfers.ts`)

- [x] 3.1 `initiate` now asserts exactly one of `toWallet`/`toEmail` (throws `LocalError` `VALIDATION_ERROR`, no request, on both-or-neither) and POSTs `{ to_wallet, ... }` or `{ to_email, message?, retain_collaborator? }` to `/projects/v1/:project_id/transfers`. Typed via overloads (wallet → `InitiateTransferResult`, email → `InitiateEmailTransferResult`).
- [x] 3.2 Added `claim(transferId, opts?: { organizationId?; acceptRetainedCollaborator? })` → POST `/agent/v1/transfers/:transfer_id/claim`; persists the returned `anon_key`/`service_key` via `saveProject` + `setActiveProject`, symmetric with `accept` (task 1.1 post-fix); guarded for providers without persistence.
- [x] 3.3 Confirmed `preview` / `cancel` / `listIncoming` / `listOutgoing` already target `/agent/v1/transfers/*`; updated types/docs only (unioned, `recipient_kind`-tagged rows), no path change.
- [x] 3.4 Deleted the five `*Handoff` methods: `initiateHandoff`, `listIncomingHandoffs`, `previewHandoff`, `claimHandoff`, `cancelHandoff`.
- [x] 3.5 Rewrote the namespace doc comment to the unified one-noun surface; confirmed no `WRONG_TRANSFER_KIND` reference remains anywhere in `sdk/src` (generic `nextActions` parse covers the renamed code).

## 4. CLI thin shim (`cli/lib/transfer.mjs`)

- [x] 4.1 `init`: keeps `--to <wallet|email>` auto-detect; email branch calls `initiate({ toEmail, … })` and signs `/projects/v1/:id/transfers` (was `/handoffs`); keeps `--retain-collaborator` (email-only) + wallet flags.
- [x] 4.2 `preview`: dropped `--handoff`; signs + calls `/agent/v1/transfers/:id` via the unified `preview`.
- [x] 4.3 `list`: dropped `--handoffs` and its handoff branch; `--incoming`/`--outgoing` return the kind-agnostic union.
- [x] 4.4 `cancel`: dropped `--handoff`; signs + calls `/agent/v1/transfers/:id/cancel` via the unified `cancel`.
- [x] 4.5 `claim`: signs + calls `/agent/v1/transfers/:id/claim` via the unified `claim`; keeps `--into` + `--accept-retained-collaborator`.
- [x] 4.6 Updated `HELP` + `SUB_HELP`; removed every `--handoff` / `--handoffs` mention.

## 5. MCP thin shims (`src/tools/transfers.ts`, `src/index.ts`)

- [x] 5.1 Extended `initiate_project_transfer`'s schema with optional `to_email` (XOR `to_wallet`, guarded) + `retain_collaborator_role`; handler branches to the SDK `initiate`.
- [x] 5.2 Added `claim_project_transfer` tool (`{ transfer_id, organization_id?, accept_retained_collaborator? }`) shimming the SDK `claim`; registered in `src/index.ts`.
- [x] 5.3 Updated all transfer tool descriptions to the unified routes (initiate XOR; claim on `/agent/v1/transfers/:id/claim`; preview/list kind-aware formatting).

## 6. Tests & drift guards

- [x] 6.1 `sync.test.ts`: re-pointed the SURFACE `claim` row to `claim_project_transfer` / `POST /agent/v1/transfers/:transfer_id/claim` / `mcp: "claim_project_transfer"`; added `claim_project_transfer: "admin.transfers.claim"` to `SDK_BY_CAPABILITY`; deleted the five orphan-sat handoff capability entries.
- [x] 6.2 Rewrote the transfers unit tests: email `initiate` posts `to_email` to `/transfers`; both-or-neither rejected without a request; `claim` posts to `/transfers/:id/claim` and persists the returned `anon_key`/`service_key` via `saveProject` + `setActiveProject` (symmetric with `accept`) + a sandbox no-persistence test; `listIncoming`/`preview` carry `recipient_kind`; removed methods are gone.
- [x] 6.3 CLI tests: added obsolete-flag rejections (`preview --handoff`, `list --handoffs`, `cancel --handoff` → `UNKNOWN_FLAG`, no network); updated the retain-on-wallet message assertion. (`cli-help.test.mjs` has no transfer snapshot; endpoint correctness is covered by the SDK endpoint tests.)
- [x] 6.4 `npm run test:skill` green; regenerated `.well-known/agent-skills/index.json` digest after the `SKILL.md` edit; no banned-regression trip.
- [x] 6.5 `scoped.test.ts` green — `claim` is transfer-id-bearing (like `accept`), so no new scoped wrapper is required.

## 7. Docs

- [x] 7.1 `cli/llms-cli.txt`: rewrote the transfer section to the one-noun surface — removed `/handoffs` + `--handoff`/`--handoffs`; documented `claim` on `/agent/v1/transfers/:id/claim` (returns + persists keys like `accept`, + rotation advisory); noted initiate authority owner-OR-admin.
- [x] 7.2 `SKILL.md`: updated to the unified surface (seven tools incl. `claim_project_transfer`, wallet/email completion split). Also updated `sdk/llms-sdk.txt`, `llms-mcp.txt`, `openclaw/SKILL.md`.
- [x] 7.3 Scanned `documentation.md` and updated the project-transfer trigger row (seven MCP tools, unified noun, removed-`*Handoff` note).

## 8. Build, verify, ship

- [x] 8.1 `npm run build` clean (core + sdk + tsc) — the discriminated union + overloads compile against existing wallet call sites.
- [x] 8.2 `npm test` green: 1401 pass / 0 fail / 1 conditional skip (unit+skill+sync) + 683 pass / 0 fail (CLI e2e) + `test:docs` 43 snippets clean.
- [x] 8.3 CLI smoke: `run402 transfer --help` reflects the unified surface (no `--handoff`; `claim` present; "one noun for both recipient kinds").
- [x] 8.4 Lockstep-published `run402-mcp` + `run402` + `@run402/sdk` **3.3.0** (user chose minor; OIDC workflow run 27694403653, SLSA provenance verified on all three, CLI smoke-tested). Commits on `main`: `2d08499` impl + `2514405` bump, tag `v3.3.0`, release notes rewritten.
- [x] 8.5 Post-ship: updated `project_last_integration` memory (synced @ v3.3.0); marked private task 6.1 `[x]` in `unify-project-transfer-surface/tasks.md` (edit staged locally — private `main` is behind+dirty, user syncs). The private change archives once 6.2 (run402-admin) closes.
