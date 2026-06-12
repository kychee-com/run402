## 1. SDK — types & org namespace reshape (Model B, org_id)

- [x] 1.1 In `sdk/src/namespaces/org.types.ts`, rename `OrgMembership` to `{ org_id, display_name, role, status }`; drop `organization_id`; add `OrgRef`/create/get result types (`{ org_id, display_name, tier }` and `{ …, role }`).
- [x] 1.2 Reshape `sdk/src/namespaces/org.ts`: split into a collection `Orgs` (`create`, `list`, `whoami`) and a scoped instance sub-client `ScopedOrg` (constructed with `(client, orgId)`) exposing `get`, `rename`, `members`, `invites`, `audit`; move `OrgMembers`/`OrgInvites` to bind the id at construction.
- [x] 1.3 Implement `Orgs.create({ displayName? })` → `POST /orgs/v1` (display_name only, no tier).
- [x] 1.4 Implement `ScopedOrg.get()` → `GET /orgs/v1/:org_id`; `ScopedOrg.rename(name | null)` → `PATCH /orgs/v1/:org_id` (null/"" clears).
- [x] 1.5 Repoint `list`/`whoami`/`members`/`invites`/`audit` to the new shapes and `org_id` paths; delete all `organization`/`organizationId` identifiers.

## 2. SDK — provision into org

- [x] 2.1 Add `orgId?` to `ProvisionOptions` in `sdk/src/namespaces/projects.types.ts`.
- [x] 2.2 In `projects.ts` `provision`, send `org_id` only when `orgId` is set; leave the cold-start body byte-for-byte unchanged when omitted.

## 3. SDK — claim seam (isomorphic) & types

- [x] 3.1 Add claim types: `ClaimChallenge = { nonce }`, `ClaimSubmitInput = { token, siwx, orgId?, displayName? }`, and the discriminated `ClaimResult = { status: "claimed", org_id, … } | { status: "select_org", selectable_orgs: { org_id, display_name, tier }[] }`.
- [x] 3.2 In `sdk/src/namespaces/operator.ts`, add `claimWalletOrg.challenge({ wallet })` → `POST …/claim-wallet-org/challenge`.
- [x] 3.3 Add `claimWalletOrg.submit(input)` → `POST …/claim-wallet-org` sending `Authorization: Bearer <token>` AND `SIGN-IN-WITH-X: <siwx>` on one request; return `ClaimResult` (do NOT throw on `select_org`).

## 4. SDK — Node claim convenience & SIWX signing

- [x] 4.1 Add a Node-only signer (e.g. `sdk/src/node/operator-claim.ts`) that builds the `SIGN-IN-WITH-X` proof via `buildSIWxAuthHeaders({ allowance, domain: <apiBase host>, uri: apiBase, nonce, issuedAt: now, expirationTime: now+5m })` — no canonical statement (mirror `signCiDelegation`, simpler).
- [x] 4.2 Add the Node orchestration convenience: pull the bearer from the control-plane session cache (`core/control-plane-session.ts`); if absent, throw a `LocalError` guiding to `run402 operator login --loopback`; then challenge → sign → submit → return `ClaimResult`. Do NOT attempt step-up.
- [x] 4.3 Surface `STEP_UP_REQUIRED` / `WALLET_PROOF_INVALID` as recognizable errors preserving gateway `details`.

## 5. SDK — wiring & drift guard

- [x] 5.1 Wire `r.orgs` (collection) and `r.org(id)` (scoped instance) into the root client (`sdk/src/index.ts`); retire the old flat `r.org` object.
- [x] 5.2 Mirror the `scoped.test.ts` drift pattern: add a guard asserting every org-instance (org-id-bearing) method has an `r.org(id)` wrapper.
- [x] 5.3 Export new public types from the SDK type-surface entry so `sdk-public-type-surface` stays complete.

## 6. CLI — org verbs

- [x] 6.1 In `cli/lib/org.mjs`, use `<org>` positionals and org-shaped examples throughout the help text.
- [x] 6.2 Add `run402 org create [--name <label>]`, `run402 org get <org>`, `run402 org rename <org> <display_name|--clear>`; route through `r.orgs.create` / `r.org(id).get` / `r.org(id).rename`.
- [x] 6.3 Repoint `list`/`whoami`/`member`/`invite`/`audit` to the scoped sub-client; keep JSON-in/JSON-out.

## 7. CLI — provision --org

- [x] 7.1 Add `--org <id>` to the provision command; pass `orgId` to `provision`.
- [x] 7.2 No `--tier`/`--org` guard — the shipped gateway ignores client `tier` (account tier authoritative); `--org` only adds `org_id`. Empty `--org` is rejected locally.

## 8. CLI — operator claim-wallet-org

- [x] 8.1 Add `run402 operator claim-wallet-org [--wallet <addr>] [--org <id>] [--name <label>]` in `cli/lib/operator.mjs`, calling the Node convenience.
- [x] 8.2 On `select_org`, print the `selectable_orgs` (org_id, display_name, tier) and instruct re-running with `--org <id>`; do not error.
- [x] 8.3 On `STEP_UP_REQUIRED`, print guidance to run `run402 operator login --step-up` then re-run; on success, emit JSON.

## 9. MCP — thin org tools

- [x] 9.1 In `src/tools/orgs.ts`, add `org_create` / `org_get` / `org_rename` tools; rename internal params to `org_id`; repoint existing org tools to the new SDK shape.
- [x] 9.2 Add `org_id` to the provision tool input.
- [x] 9.3 DESCOPED — claim is SDK+CLI only (needs browser loopback login + step-up; doesn't fit the MCP tool model). MCP stays thin: create/get/rename. The claim spec has no MCP requirement.

## 10. Tests

- [x] 10.1 Add `SURFACE` + `SDK_BY_CAPABILITY` entries in `sync.test.ts` for every new SDK method (orgs create/get/rename, provision orgId, operator claimWalletOrg.*), and assert CLI/OpenClaw parity + MCP tool presence.
- [x] 10.2 Unit tests for the org namespace (create/get/rename/list/whoami/members/invites/audit) asserting `org_id` paths/bodies and no `organization_id`.
- [x] 10.3 Unit tests for the claim seam: dual headers on submit, `select_org` returned-not-thrown, re-submit reuses nonce+siwx, `STEP_UP_REQUIRED` surfaced; Node convenience signs with the allowance and refuses without a control-plane session.
- [x] 10.4 Unit test for `provision` orgId body inclusion/omission + tier passthrough (no `--org`/`--tier` rejection — the gateway ignores client tier).
- [x] 10.5 CLI e2e + help snapshots for the new `org` verbs, `provision --org`, and `operator claim-wallet-org`; add any new `cli-*.test.mjs` files to the `package.json` `test:e2e` allow-list.
- [x] 10.6 Run `npm test` (SKILL + sync + unit + e2e) green. — 1360 + 671 pass, 0 fail.

## 11. Docs

- [x] 11.1 Update `cli/llms-cli.txt`: org `create`/`get`/`rename` + the `<org>` rename, `provision --org`, and the `operator claim-wallet-org` flow (challenge→sign→claim, `select_org`, step-up), including the `FREE_ORG_OWNER_LIMIT_EXCEEDED` and `STEP_UP_REQUIRED` surfaces.
- [x] 11.2 Scan doc surfaces and update: `sdk/llms-sdk.txt` (org section → `r.orgs`/`r.org(id)` + control-plane-session example), `llms-mcp.txt` (org tool params `org_id` + create/get/rename + provision `org_id`), `SKILL.md` (org section + create/get/rename), regenerated `.well-known/agent-skills/index.json`.

## 12. Cross-repo / open decisions (before publish)

- [x] 12.1 RESOLVED: the shipped `routes/projects.ts` ignores client `tier` (account tier authoritative); no guard needed. See 7.2.
- [ ] 12.2 Resolve the gateway challenge-gating decision with the user (D7 recommendation: relax challenge to auth-only). Client ships either way; record the outcome on [#451](https://github.com/kychee-com/run402/issues/451).
- [x] 12.3 `openspec validate first-class-orgs-client --strict` clean ✓; full `npm test` + `npm run build` green ✓. Publish lockstep packages via `/publish` — PENDING separate explicit authorization (not done here).
