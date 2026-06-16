## 1. SDK — initiate retention

- [x] 1.1 In `sdk/src/namespaces/transfers.ts`, added `retainCollaborator?: { role: "developer" } | null` to `InitiateHandoffInput`; `initiateHandoff` sets `body.retain_collaborator` only when `!== undefined`.

## 2. SDK — preview + claim retention

- [x] 2.1 Added `RetainCollaboratorPreview` (`{ principal_id, role, sender_label, scope, note, accept_field }`, open index) and `retain_collaborator?: RetainCollaboratorPreview | null` on `ProjectHandoffPreview` (index signature kept).
- [x] 2.2 Added `acceptRetainedCollaborator?: boolean` to `ClaimHandoffInput`; `claimHandoff` sets `body.accept_retained_collaborator` only when `!== undefined`.
- [x] 2.3 Added `retained_collaborator_principal_id?: string | null` to `ClaimHandoffResult`.
- [x] 2.4 No edit needed: `index.ts:388` already does `export type * from "./namespaces/transfers.js"` (wildcard) — `RetainCollaboratorPreview` + updated inputs/results auto-export; `public-type-exports.test` passes.

## 3. CLI — flags

- [x] 3.1 In `cli/lib/transfer.mjs`, added `RETAIN_ROLES = new Set(["developer"])`; `--retain-collaborator` in `init`'s `valueFlags`/known flags; validates against `RETAIN_ROLES` (`BAD_FLAG` otherwise) and rejects the wallet rail (`!isEmail` → `BAD_FLAG`); passes `retainCollaborator: { role }` on the email path.
- [x] 3.2 Added boolean `--accept-retained-collaborator` to `claim`'s known flags (detected via array presence; `positionalArgs` skips `-`-prefixed tokens); passes `acceptRetainedCollaborator: true || undefined`.
- [x] 3.3 Updated `HELP` + `SUB_HELP` for `init`/`claim` with the flags, the dual-consent model, and the full-severance default.

## 4. Docs

- [x] 4.1 `cli/llms-cli.txt` (init + claim entries) and `sdk/llms-sdk.txt` (`r.admin.transfers` — added the email→org handoff method paragraph it was missing, with the retain opt-in) document the sender flag, recipient accept, default-severs, and `INVALID_RETAIN_ROLE` / `RETAIN_SUBJECT_REQUIRED` codes.

## 5. Tests + sync

- [x] 5.1 Added the `admin.transfers handoff retain-collaborator (v1.91)` suite to `sdk/src/namespaces/transfers.test.ts` (5 cases: initiate set/unset, claim set/unset + result id, preview typed block). 21/21 pass.
- [x] 5.2 Extended the already-wired `cli-argv.test.mjs` with the two local-validation e2e cases (invalid role → `BAD_FLAG`; wallet-rail → `BAD_FLAG`), both before any network. 126/126 pass. No new file → no `package.json` allow-list change. Help snapshots pass unchanged (flag→SDK mapping covered by 5.1's body assertions). 
- [x] 5.3 `sync.test.ts` passes — flags only (no new command), so no `SURFACE` row; CLI/OpenClaw parity holds and no handoff MCP tool was added.
- [x] 5.4 `npm test` green — 677/677 unit+e2e, 0 fail; docs-snippets 43 clean. `npm run build` (full `tsc`) clean.
