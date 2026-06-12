## Why

The gateway side of `first-class-orgs` has shipped (run402-private, gateway v1.82): first-class org **creation**, display-name **labeling/rename**, a wallet-owned org **claim** (ownership transfer), and **`provision --org`**. This change is the client half — the SDK / CLI / MCP / docs that wrap those routes — tracked by [#451](https://github.com/kychee-com/run402/issues/451).

Two things force the work beyond "wrap new routes." First, the gateway made `org` the public noun: `/orgs/v1` now speaks `org_id`, and `organization` / `organization_id` MUST NOT appear on the wire. The already-shipped `org` namespace is built entirely on `organization_id`, so it is now misaligned with the platform's own vocabulary. Second, three of the new verbs (create, rename, claim) need a fresh step-up and — for the claim — a dual-credential dance the client must own. We are pre-launch with no users, so we take the break and design the optimal DX rather than carry a compatibility shim.

## What Changes

- **BREAKING — full `org_id` rename.** `organization_id` is removed from the entire client surface: SDK method params, response/membership types, CLI positionals (`<organization>` → `<org>`), and MCP tool inputs. `OrgMembership` becomes `{ org_id, display_name, role, status }`.
- **BREAKING — SDK namespace reshaped to collection + instance**, mirroring the existing `r.projects` / `r.project(id)` idiom:
  - `r.orgs.create({ displayName? })`, `r.orgs.list()`, `r.orgs.whoami()` — collection / identity.
  - `r.org(id)` — a resource-scoped sub-client (id pre-bound) exposing `get()`, `rename(name | null)`, `members.*`, `invites.*`, `audit(opts)`.
- **NEW — org create / get / rename.** `r.orgs.create` (`POST /orgs/v1`, `display_name` only, no tier at create), `r.org(id).get` (`GET /orgs/v1/:org_id`, returns `role`), `r.org(id).rename` (`PATCH /orgs/v1/:org_id`, `null`/`""` clears the label).
- **NEW — provision into an existing org.** `ProvisionOptions.orgId` → `POST /projects/v1 { org_id }`; `run402 provision --org <id>`; MCP provision tool gains `org_id`. Caller needs `developer`+ on the org. Omitting it preserves the cold-start path byte-for-byte.
- **NEW — wallet-org claim flow.** An isomorphic seam on `r.operator` (`claimWalletOrg.challenge({ wallet })` → `{ nonce }`; `claimWalletOrg.claim({ token, siwx, orgId?, displayName? })` → discriminated `ClaimResult`) plus a Node convenience that runs the full dance (pull control-plane session → challenge → sign nonce → POST both proofs) and a `run402 operator claim-wallet-org` CLI flow that handles the `select_org` round-trip and `STEP_UP_REQUIRED` guidance.
- **NEW — typed surfaces for the new states/errors:** the `select_org` discriminated result (`selectable_orgs: { org_id, display_name, tier }[]`), `FREE_ORG_OWNER_LIMIT_EXCEEDED`, and `STEP_UP_REQUIRED` (op-class `org.claim_wallet`, remediation pointer).
- **Docs + sync:** `cli/llms-cli.txt` gains the org verbs, `--org`, and the claim flow; `sync.test.ts` `SURFACE` + `SDK_BY_CAPABILITY` gain every new method; a drift test guards the new `r.org(id)` scoped sub-client.

## Capabilities

### New Capabilities
- `org-management-client-surface`: the client surface for managing organizations — the `org_id` vocabulary, the `r.orgs` / `r.org(id)` collection+instance split, create / get / rename / list / whoami / members / invites / audit, provisioning into an existing org via `--org`, and the typed `FREE_ORG_OWNER_LIMIT_EXCEEDED` / authorize-before-reveal surfaces. Spans SDK, CLI, MCP, and docs.
- `wallet-org-claim-client-surface`: the client surface for claiming a wallet-`agent`-owned org into a human's console identity — the challenge → sign → dual-proof claim choreography, the reusable-nonce `select_org` round-trip, `STEP_UP_REQUIRED` handling, the control-plane-session-only bearer requirement, and the isomorphic-seam / Node-convenience split.

### Modified Capabilities
<!-- None. No org/billing capability spec exists in openspec/specs/ today (the org namespace shipped from the private repo without a public client-surface spec), so all behavior here is ADDED. -->

## Impact

- **SDK (`sdk/src/`):** reshape `namespaces/org.ts` + `org.types.ts` (collection `Orgs` + scoped `org(id)` sub-client; `org_id` everywhere); new claim methods on `namespaces/operator.ts` + types; `node/` convenience for the claim dance (reuses the `core` allowance + `buildSIWxAuthHeaders` SIWX path, like `signCiDelegation`); `ProvisionOptions.orgId` in `projects.ts` / `projects.types.ts`; wire `r.orgs` / `r.org(id)` into the root client and `scoped.ts`.
- **CLI (`cli/lib/`):** `org.mjs` rename `<organization>` → `<org>` + add `create`/`get`/`rename`; `operator.mjs` add `claim-wallet-org` (challenge/sign/claim loop, `--org`, `--name`, step-up guidance); `provision` add `--org`.
- **MCP (`src/tools/`):** `orgs.ts` add create/get/rename + rename internal params; new claim tool; provision tool gains `org_id`.
- **Tests:** `sync.test.ts` `SURFACE` + `SDK_BY_CAPABILITY`; `scoped.test.ts`-style drift guard for `r.org(id)`; unit tests for each new method + the claim discriminated result; CLI e2e + help snapshots (new files added to the `package.json` allow-list).
- **Docs:** `cli/llms-cli.txt` (canonical; the private site pulls it at deploy).
- **Cross-repo:** gateway is already deployed (v1.82); client ships independently. Open gateway-side decision recorded in design.md (relax the claim *challenge* endpoint to auth-only, step-up on the claim) — the client is robust to either choice.
