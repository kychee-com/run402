## Context

The gateway collapsed project transfer into one body-discriminated noun and deleted `/handoffs/*` outright (private `unify-project-transfer-surface`, shipped + live — `/agent/v1/handoffs/incoming` → 404 in prod). The run402-public client (`sdk/src/namespaces/transfers.ts`, `cli/lib/transfer.mjs`) still carries a parallel handoff surface — five `*Handoff` SDK methods, a `--handoff`/`--handoffs` CLI flag family, and six handoff-only types — all hitting deleted routes. This is the gateway-last public cascade (private task 6.1). It is the same break class as the v3.2.0 function-deploy 404, but the user has chosen the stronger remedy: **collapse** the client surface to mirror the gateway's one-noun shape rather than re-point the old names.

Constraints: SDK is the single typed source of truth; CLI and MCP are thin shims. Pre-launch, zero published consumers in use → breaking, no compat window, no aliases. The transfer engine is unchanged gateway-side, so wallet-path response shapes are stable; only the unioned list rows gain `recipient_kind` + `to_email`.

## Goals / Non-Goals

**Goals:**
- One typed `initiate(toWallet XOR toEmail)`; kind-agnostic `preview`/`cancel`/`listIncoming`/`listOutgoing` carrying `recipient_kind`; a new typed `claim` completion. Delete the five `*Handoff` methods and their types.
- CLI stays a thin shim: keep `init --to <wallet|email>` auto-detect; re-point all signing paths to `/transfers*`; drop the obsolete `--handoff`/`--handoffs` flags.
- MCP reaches the full unified surface (email `initiate` + `claim_project_transfer`) as thin shims — closing the prior MCP gap.
- Green `sync.test.ts` / `SKILL.test.ts` / CLI help snapshots; docs (`cli/llms-cli.txt`, `SKILL.md`) on the one-noun surface.

**Non-Goals:**
- No engine or wallet-path behavior change (wallet `initiate`/`preview`/`accept`/`cancel` keep their exact wire + response shapes).
- No deprecated aliases or compat shims.
- No `r.project(id)` scoped wrapper for `claim` (it is transfer-id-bearing, like `accept`/`cancel`).

## Decisions

### Decision 1 — Collapse, not re-point
Fold the email recipient into the existing transfer methods and add `claim`; delete `initiateHandoff` / `listIncomingHandoffs` / `previewHandoff` / `claimHandoff` / `cancelHandoff` and the handoff-only types. **Rationale:** mirrors the gateway's "one noun, body-discriminated" intent; the typed SDK becomes the single source of truth, and CLI/MCP shrink to shims. **Alternative — re-point in place (keep method names, swap URLs):** rejected; it re-creates the split the gateway just removed and leaves dead "Handoff" naming in the public type surface.

### Decision 2 — `initiate` takes `toWallet` XOR `toEmail` on one input, validated at the boundary
`InitiateTransferInput` carries both `toWallet?` and `toEmail?`; the method asserts exactly one is present and throws a structured local error (no request issued) otherwise, mirroring the gateway `400 VALIDATION_ERROR`. Prefer a compile-time discriminated union (`{ toWallet } | { toEmail }` intersected with the common fields) so TypeScript callers get XOR for free, with the runtime guard as the backstop for JS callers. **Alternative — separate `initiate` / `initiateByEmail`:** rejected; re-introduces two methods against one route.

### Decision 3 — `claim` persists keys, symmetric with `accept` (gateway oversight fixed)
The initial task 1.1 read found the email-`claim` response carried NO `anon_key`/`service_key`, unlike wallet `accept`. We surfaced that to the gateway team; it was confirmed an **oversight**, not intentional — `accept`'s #428 credentials were never mirrored to `claim` (which had only just shipped in `unify-project-transfer-surface` when #428 landed), and the claim recipient hit the identical "owner via the flip but no per-project keys" dead-end #428 set out to remove. The gateway fixed and deployed it (`project-transfer-claim-credentials`, commit `544ad867`, prod): `POST /agent/v1/transfers/:id/claim` now returns `anon_key` + `service_key`, byte-identical in shape and derivation to `accept` and project-create. So `claim` persists them via `saveProject` + `setActiveProject` exactly like `accept`. Two nuances encoded: (a) claim auth is **principal-based** (a control-plane session OR a verified-email SIWX match), so — unlike `accept` — a wallet is not assumed present (immaterial to persistence, which only needs `saveProject`/`setActiveProject`); (b) project keys are `project_id`-derived and do NOT rotate on transfer, so the former owner still knows them — the claim stamps the `secrets_rotation_advised` advisory as the current mitigation (true key-versioning is tracked separately gateway-side; no SDK action beyond surfacing the advisory).

### Decision 4 — MCP gains email-initiate + a `claim_project_transfer` tool (parity)
Extend `initiate_project_transfer` with an optional `to_email` (mutually exclusive with `to_wallet`) and add `claim_project_transfer`, both thin shims over the new SDK methods; carry the retain opt-in (`retain_collaborator` / `accept_retained_collaborator`) through them so MCP is at full parity with the CLI. **Rationale:** the user's "everything typed in the SDK; CLI and MCP just thin shims" + ultimate DX. **Alternative — defer MCP:** rejected; it would leave MCP unable to address the email recipient kind.

### Decision 5 — The renamed error needs no special-casing
`Run402Error` already parses `next_actions[]`. `WRONG_COMPLETION_FOR_TRANSFER_KIND` surfaces through the generic path; the only work is removing stale `WRONG_TRANSFER_KIND` references from comments/docs. **Rationale:** keep the error layer generic; agents branch on `code` + `nextActions`.

### Decision 6 — One unified type surface
A single `TransferSummary` / `ProjectTransferPreview` carries `recipient_kind: "wallet" | "email"`, `to_email?`, and `to_wallet: string | null`; the `retain_collaborator` block folds onto `ProjectTransferPreview` (email kind). Delete `HandoffSummary`, `ProjectHandoffPreview`, `InitiateHandoffInput`, `ClaimHandoffInput`, `HandoffResult`, `ClaimHandoffResult`; fold `RetainCollaboratorPreview` into the preview type.

## Risks / Trade-offs

- **[Gateway email-`claim` response may not carry the new owner's keys]** → Verify against the private gateway source / a live claim before wiring persistence (task 0, BLOCKING). The claim runs the same atomic accept engine, so keys are expected, but the *response serializer* is the unknown — exactly the v3.2.0 class of bug. If absent: `claim` returns the result without persistence and the docs note a follow-up auth step (and we file a gateway issue).
- **[Path-scoped EIP-191 signing mismatch]** → Every `allowanceAuthHeaders(...)` path must match the SDK endpoint exactly; a missed `/handoffs` path yields a `401` (signature over the wrong path), not an obvious `404`. Audit all five call sites in `cli/lib/transfer.mjs` and add a CLI test asserting the signed path is `/transfers*`.
- **[`sync.test.ts` churn]** → Collapsing five handoff capability rows + adding one MCP tool must keep the SURFACE↔SDK orphan check and CLI/OpenClaw parity green. Update `SURFACE`, `SDK_BY_CAPABILITY`, and the MCP tool-set expectation together.
- **[`to_wallet` becomes nullable]** → Wallet-only consumers reading `.to_wallet` now face `string | null`. Pre-launch, acceptable; it is the honest type for a unioned list.
- **[Semver]** → Removing public SDK methods is a breaking change. The repo ships `run402-mcp` + `run402` + `@run402/sdk` in lockstep; the version bump (major vs the established lockstep-minor cadence) is a publish-time decision and requires its own explicit publish authorization.

## Migration Plan

No gateway dependency — it is already shipped + live. Single public PR:
1. SDK: collapse methods + types, add `claim`, update error doc.
2. CLI: re-point signing paths, drop `--handoff`/`--handoffs`, re-point `claim`, fix help text.
3. MCP: extend `initiate_project_transfer`, add `claim_project_transfer`.
4. Tests: `sync.test.ts`, transfers unit tests, CLI help snapshots, `SKILL.test.ts`.
5. Docs: `cli/llms-cli.txt`, `SKILL.md`.
6. `npm test` + `npm run test:e2e` green, then lockstep publish (separate authorization).
7. After publish: mark private task 6.1 done; the private `unify-project-transfer-surface` change can archive once 6.1 + the run402-admin 6.2 close.

**Rollback:** revert the public PR; the gateway is unaffected. (There is no two-noun gateway surface to fall back to — the client simply returns to the broken state, so rollback is only for a bad implementation, not a strategy.)

## Open Questions

- **[RESOLVED] Does the gateway email-`claim` response include `anon_key` / `service_key` like wallet `accept`?** Now yes. The first read found no keys; we surfaced it, the gateway confirmed an oversight and shipped the fix (`project-transfer-claim-credentials`, commit `544ad867`, prod). `claim` now returns + persists the keys, symmetric with `accept` (Decision 3).
- **Discriminated union vs plain optional fields for `initiate`'s XOR** — confirm the union type does not regress the existing wallet-only call sites (CLI, tests) at compile time; fall back to optional-fields + runtime guard if it does.
- **Version bump** — major (true semver for removed methods) vs the established lockstep cadence; decided at publish time with explicit authorization.
